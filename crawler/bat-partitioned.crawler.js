// PARTITIONED BaT HARVESTER -- the fix for the 10k ceiling.
//
// -- THE PROBLEM ------------------------------------------------------------------------
// listings-filter reports items_total = 257,919 but serves at most 10,000 records to ANY
// single query. Measured precisely: per_page=48, page 208 -> 48 items (offset 9,984);
// page 210 -> 0 items (offset 10,080). Sort direction alone bought two windows (newest 10k
// via sort=td, oldest 10k via sort=ta), which is why the corpus held 2014-2018 and 2026 and
// nothing in between.
//
// -- THE FIX ----------------------------------------------------------------------------
// The cap is PER QUERY, not global. Proven with a partition smaller than the cap:
// category=383 (Boats, 505 records) paged cleanly 1..11, then page 12 returned empty --
// natural termination, not truncation. That partition is 100% harvested.
//
// So partition the archive until every slice fits under 10,000:
//     category  x  sort  x  state
//        39           4        2       = 312 independent 10k windows
//
// Each axis was verified honoured (it changes items_total):
//   category=<numeric term id>   American=3 -> 87,881 ; British=4 -> 29,196 ; Boats=383 -> 505
//   state=sold|unsold            American: 66,380 sold + 21,501 unsold
//   sort=td|ta|vd|bd             td=newest, ta=oldest, vd=popularity, bd=highest bid
//
// Sorts matter because they enter the SAME partition from different ends. For American/sold
// (66,380 -- well over the cap) the four sorts land on 8/14/2026, 7/30/2014, 8/11/2021 and
// 8/4/2026 respectively, so their union covers far more of the range than any one of them.
//
// -- WHY CATEGORIES OVERLAPPING IS FINE -------------------------------------------------
// A car can be both "American" and "Convertibles", so partitions double-count. That costs
// requests, never correctness: every record is keyed on (source, source_lot_id) and merged
// into a Map, which is the same idempotent-ingest key the database uses. Re-seeing a lot is
// a no-op, not a duplicate sale.
//
// -- HONEST LIMIT -----------------------------------------------------------------------
// Categories above 10k can NOT be exhausted by this method -- only ~4 x 10k of them is
// reachable, and the sorts overlap. Those partitions are reported as PARTIAL so coverage is
// never overstated. Only partitions whose total is under the cap are marked COMPLETE.
//
// Respects the Crawl-delay: 1 in robots.txt. Checkpoints after every partition and records
// completed partitions, so an interrupted run resumes instead of restarting.
//
// Usage:
//   node crawler/bat-partitioned.crawler.js plan            # enumerate + print the plan only
//   node crawler/bat-partitioned.crawler.js run [maxParts]  # execute (resumable)

"use strict";

const fs = require("fs");
const path = require("path");
const { adaptListingItem, stripTags } = require("./bat-adapt");

const BASE = "https://bringatrailer.com/wp-json/bringatrailer/1.0/data/listings-filter";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; price-index-research/1.0)",
  Accept: "application/json",
  Referer: "https://bringatrailer.com/auctions/results/",
};

const PER_PAGE = 48;          // measured maximum; 96 and above are rejected outright
const CAP_RECORDS = 10000;    // measured server-side offset ceiling
const MAX_PAGE = Math.floor(CAP_RECORDS / PER_PAGE); // 208

// PACING.
//
// robots.txt asks for Crawl-delay: 1, and the first long run honoured it exactly -- yet after
// roughly 7,000 requests the host stopped answering at the TCP layer (UND_ERR_CONNECT_TIMEOUT
// on bringatrailer.com while other hosts resolved fine). So the limit that bit was cumulative
// volume, not instantaneous rate. Completing the archive needs several times that many
// requests, which means pacing has to be gentler than the published minimum, not equal to it.
//
// Three changes follow from that:
//   * a higher floor than the robots.txt minimum (override with DELAY_MS)
//   * jitter, so the request train is not a perfectly periodic signature
//   * an ADAPTIVE floor that ratchets up after any retry and never comes back down, so a run
//     that starts to attract throttling slows itself instead of hammering through it
let baseDelayMs = Number(process.env.DELAY_MS) || 1800;
const JITTER = 0.25;
const nextDelay = () => Math.round(baseDelayMs * (1 + (Math.random() * 2 - 1) * JITTER));

// CEILING ON THE RATCHET, and the reason it needs one.
//
// The ratchet assumes a failed request means the SERVER is pushing back. That assumption was
// tested and found wrong. Mid-run the harvester hit TimeoutError, then ECONNRESET, then two
// UND_ERR_CONNECT_TIMEOUTs, ratcheting 1800 -> 2700 -> 4050 -> 6075 -> 9113ms. At that exact
// moment a FRESH node process made 6 consecutive requests at 1.2s intervals — against the same
// category=7&state=sold partition — and got 6x HTTP 200.
//
// So the failures were LOCAL: sockets in a long-lived process going stale after thousands of
// keep-alive requests, not rate limiting. The ratchet was tripling the runtime to solve a
// problem the server did not have. Node's fetch does not expose its undici dispatcher, and
// undici is not installed here, so the pool cannot be recycled in-process — the effective fix
// is to RESTART, which is free because the run is resumable from the state file.
//
// Hence: cap the ratchet so a local fault cannot make the run absurd, and stop after enough
// backoffs to hand control back rather than crawling at 9s/request for hours.
const MAX_DELAY_MS = 6000;
const MAX_BACKOFFS_BEFORE_EXIT = 4;
let backoffEvents = 0;
const backoffCodes = new Set();

// DNS failures say nothing about the host's willingness to serve us — they are a local
// resolver problem. Slowing down cannot fix them, so they do not ratchet the delay; they still
// count toward the stop so a broken network does not spin forever.
const LOCAL_FAULT = /^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED)$/;

function noteBackoff(label) {
  backoffEvents++;
  backoffCodes.add(label);
  if (!LOCAL_FAULT.test(label)) baseDelayMs = Math.min(Math.round(baseDelayMs * 1.5), MAX_DELAY_MS);
  console.log(`   ${label} -- backoff ${backoffEvents}/${MAX_BACKOFFS_BEFORE_EXIT}, base delay now ${baseDelayMs}ms`);
}

const OUT = path.join(__dirname, "..", "samples", "scraped", "bat-partitioned.json");
const STATE = path.join(__dirname, "..", "samples", "scraped", "bat-partitioned.state.json");
const CRITERIA = path.join(__dirname, "..", "samples", "bat-filter-criteria.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SORTS = ["td", "ta", "vd", "bd"];
const STATES = ["sold", "unsold"];
// Historical backfill deliberately uses the exhaustive partition walk. It is opt-in; the
// default recent mode still stops at its normal recent window.
const RECENT_MODE = process.env.SCRAPE_MODE !== "full" && process.env.SCRAPE_MODE !== "backfill";
const RECENT_PAGES = Math.max(1, Number(process.env.BAT_RECENT_PAGES || process.env.SCRAPE_RECENT_PAGES) || 5);
const RECENT_DAYS = Number(process.env.SCRAPE_RECENT_DAYS) || 45;

// A partition is only genuinely exhaustible if it fits in the pages we can actually walk.
// 48 x 208 = 9,984, slightly under the 10,000 record cap -- so a partition of, say, 9,990
// would silently lose 6 records while looking "complete". Judge completeness against what
// is REACHABLE, not against the cap.
const REACHABLE = PER_PAGE * MAX_PAGE; // 9,984

// -- CATEGORY POLICY --------------------------------------------------------------------
// This is a collector-CAR price index. BaT also auctions parts, wheels, boats, tractors,
// motorcycles and go-karts -- ~30,000 records that are not automobiles at all.
//
// The evidence classifier (resolve/evidence.js) would reject most of them anyway, but it
// would do so ONE AT A TIME, dumping thousands of items into the human review queue. The
// user's standing rule is that bad data is worse than less data and that review volume must
// stay small; excluding a whole non-car taxonomy up front is the cheapest way to honour both.
//
// This is a taxonomy-level policy, not edge-case memorisation: it keys off BaT's own
// category ids, so it stays correct as new listings arrive.
const NON_CAR_CATEGORIES = new Map([
  [379, "Parts"],
  [380, "Wheels"],
  [383, "Boats"],
  [544, "Trains"],
  [432, "Tractors"],
  [428, "Go-Karts"],
  [430, "Minibikes & Scooters"],
  [70, "Motorcycles"],
  [553, "Side-by-Sides"],
  [431, "All-Terrain Vehicles"],
]);

function loadCategories({ includeNonCar = false } = {}) {
  const crit = JSON.parse(fs.readFileSync(CRITERIA, "utf8")).criteria;
  return crit.categories
    .filter((c) => c.value !== "" && c.value != null)
    .filter((c) => includeNonCar || !NON_CAR_CATEGORIES.has(Number(c.value)))
    .map((c) => ({ id: c.value, name: stripTags(String(c.text).replace(/&amp;/g, "&")) }));
}

async function fetchPage({ category, sort, state, page }) {
  const qs =
    `page=${page}&per_page=${PER_PAGE}&get_items=1&get_stats=0&sort=${sort}` +
    (category ? `&category=${category}` : "") +
    (state ? `&state=${state}` : "");
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`${BASE}?${qs}`, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
      if (res.status === 429 || res.status >= 500) {
        // An HTTP status IS the server speaking, so this one is genuine throttling.
        noteBackoff(`HTTP ${res.status}`);
        await sleep(15000 * (attempt + 1));
        continue;
      }
      if (res.status !== 200) return { items: [], total: null, http: res.status };
      const j = await res.json();
      return { items: j.items || [], total: j.items_total ?? null, http: 200 };
    } catch (e) {
      // A transport-level error (connect timeout, ECONNRESET) is AMBIGUOUS: it looks identical
      // whether the host is refusing us or our own socket pool has gone stale. Measured here,
      // it was the latter. So still slow down — but against a ceiling, and counting toward a
      // clean exit that lets a restart give the process fresh sockets.
      noteBackoff(e.cause?.code || e.name || "transport error");
      await sleep(20000 * (attempt + 1));
    }
  }
  return { items: [], total: null, http: 0 };
}

// Size of a partition, used to decide whether it can be COMPLETE and to order the work.
async function measure(category, state) {
  const r = await fetchPage({ category, state, sort: "td", page: 1 });
  await sleep(nextDelay());
  return r.total ?? 0;
}

async function plan() {
  const cats = loadCategories();
  console.log(`Measuring ${cats.length} categories x ${STATES.length} states ...\n`);
  const rows = [];
  for (const c of cats) {
    for (const st of STATES) {
      const total = await measure(c.id, st);
      rows.push({ ...c, state: st, total });
    }
    const t = rows.filter((r) => r.id === c.id).reduce((a, b) => a + b.total, 0);
    console.log(`  ${String(c.id).padStart(4)}  ${c.name.padEnd(26)} ${String(t).padStart(7)}`);
  }

  rows.sort((a, b) => b.total - a.total);
  const complete = rows.filter((r) => r.total > 0 && r.total <= CAP_RECORDS);
  const partial = rows.filter((r) => r.total > CAP_RECORDS);

  console.log(`\n=== PLAN ===`);
  console.log(`partitions fully harvestable (<= ${CAP_RECORDS}): ${complete.length}`);
  console.log(`  records in them: ${complete.reduce((a, b) => a + b.total, 0).toLocaleString()}`);
  console.log(`partitions over the cap (PARTIAL, need multi-sort): ${partial.length}`);
  for (const p of partial) console.log(`  ${p.name} / ${p.state}: ${p.total.toLocaleString()}`);
  console.log(`\ntheoretical reach: ${(
    complete.reduce((a, b) => a + b.total, 0) + partial.length * SORTS.length * CAP_RECORDS
  ).toLocaleString()} (before de-overlap)`);

  fs.writeFileSync(path.join(__dirname, "..", "samples", "bat-partition-plan.json"), JSON.stringify(rows, null, 1));
  return rows;
}

async function run(maxPartitions = Infinity) {
  const cats = loadCategories();

  let records = new Map();
  try {
    for (const r of JSON.parse(fs.readFileSync(OUT, "utf8"))) records.set(`${r.source}|${r.source_lot_id}`, r);
  } catch {}
  let done = new Set();
  try {
    done = new Set(JSON.parse(fs.readFileSync(STATE, "utf8")).completed);
  } catch {}

  const startCount = records.size;
  console.log(`resuming: ${startCount} records on file, ${done.size} partitions already done\n`);

  // Build the work list, SMALLEST PARTITION FIRST.
  //
  // Order matters because this run takes hours and can be interrupted. A partition under the
  // reachable window finishes COMPLETE -- a permanent, provable result. A partition over it
  // returns at best the top ~10k of a much larger set and stays PARTIAL no matter how long it
  // runs. Banking every COMPLETE partition before spending time on the truncated ones means an
  // interrupted run still leaves the corpus in a defensible state.
  //
  // Sizes come from the measured plan (samples/bat-partition-plan.json, written by `plan`).
  // If it is missing the order simply falls back to taxonomy order -- the run is still correct,
  // just less resilient to interruption.
  let sizeOf = new Map();
  try {
    for (const r of JSON.parse(fs.readFileSync(path.join(__dirname, "..", "samples", "bat-partition-plan.json"), "utf8"))) {
      sizeOf.set(`${r.id}|${r.state}`, r.total);
    }
  } catch {
    console.log("no partition plan on file -- run `plan` first for smallest-first ordering");
  }

  const work = [];
  for (const c of cats) for (const st of STATES) for (const sort of SORTS) work.push({ cat: c, state: st, sort });
  work.sort((a, b) => {
    const sa = sizeOf.get(`${a.cat.id}|${a.state}`) ?? Infinity;
    const sb = sizeOf.get(`${b.cat.id}|${b.state}`) ?? Infinity;
    if (sa !== sb) return sa - sb;
    // Within one partition keep td first: the "already complete" short-circuit below keys off
    // td having run, so it must not be reordered behind the other sorts.
    return SORTS.indexOf(a.sort) - SORTS.indexOf(b.sort);
  });

  // Empty partitions cost one request each and clutter the log; drop the ones the plan
  // already measured as zero.
  const skipped = work.filter((w) => sizeOf.get(`${w.cat.id}|${w.state}`) === 0).length;
  if (skipped) console.log(`skipping ${skipped} partitions the plan measured as empty\n`);

  // Once the host stops answering, every further partition just fails. Continuing burns
  // through the work list producing nothing and makes the log lie about coverage -- so stop
  // and let the operator resume after a back-off.
  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 3;

  let processed = 0;
  for (const w of work) {
    if (processed >= maxPartitions) break;
    if (backoffEvents >= MAX_BACKOFFS_BEFORE_EXIT) {
      // Do NOT assert a single cause here. Three different ones have actually occurred, and
      // they need different responses:
      //   HTTP 429            -> the server IS throttling. Back off for hours, not minutes.
      //   ECONNRESET/timeouts -> ambiguous; a fresh process has answered fine while a
      //                          long-lived one was failing, so restarting often just works.
      //   ENOTFOUND/EAI_AGAIN -> LOCAL DNS, nothing to do with the host. Resume immediately.
      // Naming the observed codes lets the operator pick, instead of trusting a guess.
      const codes = [...backoffCodes].join(", ") || "unknown";
      console.log(`\nSTOPPING after ${backoffEvents} transport backoffs. Observed: ${codes}`);
      console.log(`  HTTP 429            -> the host is genuinely throttling; wait hours before resuming.`);
      console.log(`  ENOTFOUND/EAI_AGAIN -> local DNS, not the host; resume straight away.`);
      console.log(`  ECONNRESET/timeout  -> ambiguous; a fresh process usually succeeds.`);
      console.log(`Nothing was marked done for the failed partition, so resuming loses nothing:`);
      console.log(`   node crawler/bat-partitioned.crawler.js run`);
      break;
    }
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.log(`\nABORTING: ${consecutiveFailures} partitions failed in a row -- the host is refusing us.`);
      console.log(`Nothing was marked done for those, so re-running resumes exactly here.`);
      break;
    }
    const key = `${w.cat.id}|${w.state}|${w.sort}`;
    if (done.has(key)) continue;
    if (sizeOf.get(`${w.cat.id}|${w.state}`) === 0) { done.add(key); continue; }

    let total = null;
    let added = 0;
    let pagesWalked = 0;
    let emptyStreak = 0;
    let failed = false;

    for (let page = 1; page <= MAX_PAGE; page++) {
      const r = await fetchPage({ category: w.cat.id, state: w.state, sort: w.sort, page });
      if (total == null) total = r.total;

      // A FAILED REQUEST IS NOT AN EMPTY PARTITION.
      //
      // These two used to collapse into the same `!r.total` check, and the consequence was
      // severe: when BaT rate-limited us, every remaining partition "finished" instantly with
      // total=0, got written to the completed set, and a later resume skipped them forever.
      // Three real partitions (Race Cars, Right-Hand Drive, Prewar -- ~11,000 records between
      // them) were silently marked done having fetched nothing.
      //
      // http 200 with items_total 0 is a genuine empty partition. Anything else is a failure
      // and must leave the partition UNMARKED so a later run retries it.
      if (r.http !== 200) { failed = true; break; }
      if (page === 1 && r.total === 0) break;
      // Once the whole partition fits in what we have already walked, extra sorts are pure
      // duplication -- skip them entirely rather than re-walking the same 505 records 4x.
      if (page === 1 && w.sort !== "td" && total != null && total <= REACHABLE && done.has(`${w.cat.id}|${w.state}|td`)) {
        break;
      }

      // MEASURED: td and ta together already exhaust any partition up to 2 x REACHABLE.
      //
      // td takes the newest 9,984 and ta the oldest 9,984, so their union covers everything up
      // to 19,968 records. Re-sorting that same set by popularity (vd) or highest bid (bd)
      // cannot surface anything new. Observed on Convertibles/unsold (10,807 records):
      //     td +6,518 new    ta +584 new    vd +0 new    bd +0 new
      // vd and bd walked 208 pages each and returned nothing.
      //
      // Only skip where that argument holds. ABOVE 19,968 the four sorts enter a genuinely
      // larger set from four different angles — vd (popularity) and bd (high bid) then land
      // mid-archive, outside the newest and oldest windows, and DO contribute. So the big
      // partitions still run all four.
      if (
        page === 1 && (w.sort === "vd" || w.sort === "bd") &&
        total != null && total <= REACHABLE * 2 &&
        done.has(`${w.cat.id}|${w.state}|td`) && done.has(`${w.cat.id}|${w.state}|ta`)
      ) {
        console.log(`SKIP     ${w.cat.name.padEnd(24)} ${w.state.padEnd(6)} ${w.sort}  total=${total} <= 2x${REACHABLE} — td+ta already exhaust it`);
        break;
      }

      pagesWalked++;
      if (r.items.length === 0) {
        if (++emptyStreak >= 2) break; // natural end of partition
      } else emptyStreak = 0;

      for (const it of r.items) {
        const rec = adaptListingItem(it, { partition: key });
        if (!rec) continue;
        const k = `${rec.source}|${rec.source_lot_id}`;
        if (!records.has(k)) added++;
        records.set(k, rec);
      }
      await sleep(nextDelay());
    }

    // COMPLETE only when the partition genuinely fits inside the reachable window. Anything
    // larger is truncated by the server and must never be recorded as fully harvested --
    // an overstated coverage number is a lie the rest of the pipeline would build on.
    const status = failed ? "FAILED" : total != null && total <= REACHABLE ? "COMPLETE" : "PARTIAL";

    // Only a partition we actually reached gets remembered as done. A failed one stays on the
    // work list so the next run picks it up.
    if (!failed) { done.add(key); consecutiveFailures = 0; }
    else consecutiveFailures++;
    processed++;

    console.log(
      `${status.padEnd(8)} ${w.cat.name.padEnd(24)} ${w.state.padEnd(6)} ${w.sort}  ` +
        `total=${String(total ?? 0).padStart(6)} pages=${String(pagesWalked).padStart(3)} +${String(added).padStart(4)} new  ` +
        `corpus=${records.size}`
    );

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify([...records.values()], null, 1));
    fs.writeFileSync(STATE, JSON.stringify({ completed: [...done], updated: new Date().toISOString() }, null, 1));
  }

  const dates = [...records.values()].map((r) => r.sold_at.slice(0, 10)).sort();
  console.log(`\n${records.size} records (+${records.size - startCount} this run)`);
  console.log(`date range ${dates[0]} -> ${dates[dates.length - 1]}`);

  const byYear = {};
  for (const d of dates) byYear[d.slice(0, 4)] = (byYear[d.slice(0, 4)] || 0) + 1;
  console.log("\nper year:");
  for (const y of Object.keys(byYear).sort()) console.log(`  ${y}  ${String(byYear[y]).padStart(6)}`);
  console.log(`\nWrote ${OUT}`);
}

async function runRecent(maxCategories = Infinity) {
  const cats = loadCategories().slice(0, maxCategories);
  const records = new Map();
  try {
    for (const r of JSON.parse(fs.readFileSync(OUT, "utf8"))) records.set(`${r.source}|${r.source_lot_id}`, r);
  } catch {}
  const startCount = records.size;
  let pages = 0;

  console.log(`recent mode: refreshing the newest ${RECENT_PAGES} sold page(s) across ${cats.length} car categories`);
  for (const category of cats) {
    let categoryPages = 0;
    for (let page = 1; page <= RECENT_PAGES; page++) {
      const r = await fetchPage({ category: category.id, state: "sold", sort: "td", page });
      if (r.http !== 200) {
        console.log(`FAIL recent ${category.name} page=${page} http=${r.http}`);
        break;
      }
      for (const item of r.items) {
        const rec = adaptListingItem(item, { recent_refresh: true });
        if (!rec) continue;
        const age = (Date.now() - Date.parse(rec.sold_at)) / 86400000;
        if (age >= 0 && age <= RECENT_DAYS) records.set(`${rec.source}|${rec.source_lot_id}`, rec);
      }
      pages++;
      categoryPages++;
      if (r.items.length < PER_PAGE) break;
      await sleep(nextDelay());
    }
    console.log(`recent ${category.name}: ${categoryPages} page(s)`);
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify([...records.values()], null, 1));
    let state = {};
    try { state = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch {}
    fs.writeFileSync(STATE, JSON.stringify({ ...state, recentUpdatedAt: new Date().toISOString() }, null, 1));
  }

  const dates = [...records.values()].map((r) => r.sold_at).sort();
  console.log(`\nrecent refresh: ${records.size} records (+${records.size - startCount}), ${pages} API pages`);
  if (dates.length) console.log(`date range ${dates[0].slice(0, 10)} -> ${dates[dates.length - 1].slice(0, 10)}`);
  console.log(`Wrote ${OUT}`);
}

const mode = process.argv[2] || "plan";
if (mode === "plan") plan();
else if (mode === "run" && RECENT_MODE) runRecent(Number(process.argv[3]) || Infinity);
else run(Number(process.argv[3]) || Infinity);
