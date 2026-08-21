// BONHAMS HARVESTER — sitemap-enumerated, one request per auction.
//
// ── HOW AUCTIONS ARE ENUMERATED, AND WHAT WAS REJECTED ────────────────────────────────────
// `cars.bonhams.com/auctions/` shows only 5 LIVE auctions; there is no past-results index, and
// /past-auctions/, /results/, /search/ and the Next data routes all 404. Three options were
// considered:
//
//   1. Blind ID scan. Rejected: IDs are sparse (31500/31800/31900 are all 404) and, worse, the
//      ID space is ALL of Bonhams — 30000 is Himalayan art, 31000 is jewellery, 32000 is
//      Australian art. Cars are a small fraction, so most requests would be waste.
//   2. Their search backend. `runtimeConfig` embeds Algolia and Typesense credentials and an
//      api01.bonhams.com base. NOT USED. Lifting keys out of a client bundle to bulk-export a
//      catalogue is not crawling — it is using private infrastructure they never published,
//      and it is the same line already held on DuPont's disallowed /api/ route.
//   3. Their own sitemap. USED. www.bonhams.com/robots.txt explicitly declares
//      `Sitemap: http://www.bonhams.com/sitemap.xml`, whose sitemap-sale.xml lists 11,353
//      auctions (ids 189..32778). Publishing a sitemap is an invitation to crawl what is in it.
//
// The sitemap is not department-filtered, so cars still have to be identified per auction. That
// is one cheap request each, and each hit returns an entire auction's lots — so a car auction
// costs the same single request whether it holds 5 lots or 200.
//
// ── ORDER: NEWEST FIRST ───────────────────────────────────────────────────────────────────
// Walked in descending ID order so recent sales — the ones that actually move a price curve —
// land first, and an interrupted run has still collected the most valuable part.
//
// ── PAGINATION: THE FIRST 48 LOTS ARE NOT THE AUCTION ─────────────────────────────────────
// The auction page server-renders only 48 lots regardless of size, and the original version of
// this crawler read just that. Measured cost: of 113 auctions classified as cars, 67 had
// produced ZERO records — their cars sat entirely past lot 48. Goodwood 2023 (id 27997) holds
// 241 lots of which 79 are cars, and not one of them is in the first 48; it was logged as
// "0 car lots kept" and written off. Remaining pages now come from the Next.js data route
// (see lotPageUrl in bonhams-adapt.js), and lotData.facets tells us the auction-wide car count
// up front, so paging stops the moment every car is in hand.
//
// ── STATE ─────────────────────────────────────────────────────────────────────────────────
// Per auction id, recording WHY an id was finished:
//   "other"    a different department
//   "gone"     404
//   "offsite"  redirects to a Bonhams partner house on its own domain (see onBonhams below)
//   {k:"cars", lots, hits, cars, carsExpected, kept, endsAt, pages}   harvested
//   {k:"err", tries}                                                  network failure, retried
// Re-running never re-fetches a known non-car auction, which is what keeps the 11k enumeration
// a one-time cost rather than a repeated one.
//
// The object form exists so INCOMPLETENESS IS VISIBLE IN THE STATE FILE. A bare "cars" string
// records that an auction was visited but not how much of it was read, which is precisely how
// the truncation above stayed invisible across several runs. An entry that did not reach its own
// car count is re-queued automatically on the next run.
//
// Repairs are visited BEFORE unexplored ids: a re-queued entry is a known car auction with known
// missing lots, whereas an unvisited id turns out to be non-car about 93% of the time.
//
// ── STAYING CURRENT (this is a nightly job, not a one-off import) ──────────────────────────
// Two things have to keep moving or the source silently freezes:
//   1. The sitemap id list EXPIRES (IDS_TTL_MS). Cached forever, it was read once and every
//      auction Bonhams published afterwards was invisible — a nightly run would never have
//      found another new sale.
//   2. An auction whose lots are all status NEW has not happened yet. It is fully paginated and
//      yields nothing, which looked "complete"; 4 such auctions were sitting on 58 car lots
//      dated weeks out. `kept < cars` re-queues them until RECHECK_DAYS past `endsAt`.
// Steady-state cost is therefore small: one sitemap request, plus the handful of auctions that
// are upcoming or recently concluded. The 11k enumeration is not repeated.
//
// Usage:
//   node crawler/bonhams.crawler.js            # resume, default budget
//   node crawler/bonhams.crawler.js 500        # visit at most 500 auctions this run
"use strict";

const fs = require("fs");
const path = require("path");
const {
  adaptLot, parseNextData, parseLotPage, auctionHasCars, carLotCount, lotPageUrl, PAGE_SIZE,
} = require("./bonhams-adapt");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const HEADERS = { "User-Agent": UA, Accept: "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9" };

// robots.txt sets no Crawl-delay. 1.2s is self-imposed: each response is ~500KB, so this is
// deliberately gentler than the request count alone suggests.
const DELAY_MS = 1200;

// How long a cached sitemap id list stays usable. Bonhams adds auctions continuously, so this is
// what keeps a scheduled run finding NEW sales rather than re-sweeping a frozen list.
const IDS_TTL_MS = 12 * 60 * 60 * 1000;

// How long after a sale date to keep re-checking an auction whose lots had not concluded.
// Same window rms and gooding use — results post late, especially on multi-day sales.
const RECHECK_DAYS = 45;
const RECENT_MODE = process.env.SCRAPE_MODE !== "full";
const RECENT_DAYS = Number(process.env.SCRAPE_RECENT_DAYS) || RECHECK_DAYS;
const RECENT_AUCTIONS = Math.max(1, Number(process.env.BONHAMS_RECENT_AUCTIONS) || 50);

const SITEMAP = "https://www.bonhams.com/sitemap-sale.xml";
const AUCTION = (id) => `https://cars.bonhams.com/auction/${id}/`;

const OUT = path.join(__dirname, "..", "samples", "scraped", "bonhams.json");
const STATE = path.join(__dirname, "..", "samples", "bonhams.state.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const loadJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };

// Bonhams operates partner houses on their own domains: sitemap-sale.xml ids resolve, via two
// 308s, to bruun-rasmussen.dk and bukowskis.com — art, design and watch sales, never cars.
// bruun-rasmussen.dk is unreachable from here and bukowskis.com answers 403, so following those
// redirects produced 55 "http0" and 17 "http403" entries that read like transient faults and
// were retried forever. Redirects are therefore followed BY HAND: the moment a hop leaves
// bonhams.com the id is a partner sale and gets a terminal answer, before the dead request is
// ever made.
const onBonhams = (u) => { try { return new URL(u).hostname.endsWith("bonhams.com"); } catch { return false; } };

async function fetchText(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let hop = url;
      for (let redirects = 0; redirects < 6; redirects++) {
        const res = await fetch(hop, { headers: HEADERS, redirect: "manual", signal: AbortSignal.timeout(30000) });
        const loc = res.headers.get("location");
        if (loc) {
          hop = new URL(loc, hop).href;
          if (!onBonhams(hop)) return { http: 200, text: null, offsite: hop };
          continue;
        }
        if (res.status === 429 || res.status >= 500) break; // retry the whole chain
        if (res.status !== 200) return { http: res.status, text: null };
        return { http: 200, text: await res.text() };
      }
      await sleep(10000 * (attempt + 1));
    } catch { await sleep(5000 * (attempt + 1)); }
  }
  return { http: 0, text: null };
}

async function fetchAuctionIds() {
  const r = await fetchText(SITEMAP);
  if (!r.text) return [];
  const ids = [...r.text.matchAll(/\/auctions\/(\d+)\//g)].map((m) => Number(m[1]));
  return [...new Set(ids)].sort((a, b) => b - a); // newest first
}

async function run() {
  const budget = Number(process.argv[2]) || 400;

  const sales = new Map(loadJson(OUT, []).map((r) => [`${r.source}|${r.source_lot_id}`, r]));
  const state = loadJson(STATE, { auctions: {}, ids: null });
  const startCount = sales.size;

  console.log(`resuming: ${sales.size} sales on file, ${Object.keys(state.auctions).length} auctions already classified\n`);

  // The id list is cached so a resumed run doesn't re-download 1.6MB of XML — but it MUST expire.
  // Caching it forever (the original behaviour) meant the sitemap was read exactly once and every
  // auction Bonhams published afterwards was invisible: a nightly run would have kept sweeping the
  // same finite id list and never picked up a new sale again. One request a day is the entire cost
  // of staying current.
  const idsAge = Date.now() - Date.parse(state.idsAt || 0);
  if (!state.ids || !state.ids.length || !(idsAge < IDS_TTL_MS)) {
    console.log(`fetching ${SITEMAP} ...`);
    const fresh = await fetchAuctionIds();
    if (fresh.length) {
      const before = new Set(state.ids || []);
      const added = fresh.filter((id) => !before.has(id));
      state.ids = fresh;
      state.idsAt = new Date().toISOString();
      console.log(`  ${fresh.length} auctions listed (ids ${fresh[fresh.length - 1]}..${fresh[0]})` +
                  (added.length ? `, ${added.length} new since last fetch` : ""));
    } else if (state.ids && state.ids.length) {
      console.log("  sitemap unreachable — continuing with the cached id list");
    }
    console.log("");
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, JSON.stringify(state));
  }

  // Terminal outcomes ("other"/"gone"/"offsite"/http4xx/noparse) are never revisited.
  //
  // A network error IS retried, but a bounded number of times — the pre-existing "http0"/"http403"
  // entries were all partner-house redirects that could never succeed, so an unlimited retry rule
  // would have re-attempted 72 permanently dead ids on every run forever. Bounded retries mean a
  // genuine blip still heals itself while a permanent fault stops costing budget.
  const MAX_TRIES = 3;
  const needsVisit = (e) => {
    if (e == null) return true;
    if (typeof e === "string") {
      // Legacy string states: written before the object form existed, so completeness is unknown.
      // "http0"/"http403" here are the known-dead partner redirects, now caught earlier as
      // "offsite"; one more visit reclassifies them properly and they stop coming back.
      return e === "cars" || e === "http0" || e === "http403" || /^http5/.test(e);
    }
    if (e.k === "err") return (e.tries ?? 0) < MAX_TRIES;
    if (e.k !== "cars") return false;

    // Truncated: the auction holds cars we never reached.
    if ((e.lots ?? 0) < (e.hits ?? 0) && (e.cars ?? 0) < (e.carsExpected ?? 0)) return true;

    // In recent mode, refresh even a previously complete auction. Bonhams can correct a result
    // or publish a late status after the first full page walk; the normalized row is upserted.
    const ends = Date.parse(e.endsAt || "");
    if (RECENT_MODE && Number.isFinite(ends)) {
      const age = (Date.now() - ends) / 86400000;
      if (age >= 0 && age <= RECENT_DAYS) return true;
    }

    // NOT YET CONCLUDED. An auction can be fully paginated and still yield no records because
    // every lot is status NEW — it has not happened yet. Marking that terminal loses the sale
    // permanently once it does: 4 such auctions were already holding 58 car lots, dated
    // 2026-09-19 through 2026-10-30, that no later run would ever have gone back for.
    // Re-checked until RECHECK_DAYS past the sale date, the same window rms and gooding use,
    // because results post late. An unknown/sentinel date (Bonhams uses 2100-12-31 for "not
    // scheduled") keeps it in the queue, which is the safe direction.
    if ((e.kept ?? 0) < (e.cars ?? 0)) {
      if (!Number.isFinite(ends)) return true;
      return Date.now() < ends + RECHECK_DAYS * 86400000;
    }
    return false;
  };

  // ORDER: repairs before exploration. A re-queued entry is a KNOWN car auction with known
  // missing lots; an unvisited id is a lottery ticket that comes up non-car ~93% of the time.
  // Left in plain id order the repairs sit below 8k unvisited ids and effectively never run.
  let candidateIds = state.ids;
  if (RECENT_MODE) {
    // The sitemap is newest-first. Keep a bounded fresh frontier, plus known car auctions whose
    // closing date is still inside the late-result window; do not continue the old archive scan.
    const frontier = state.ids.slice(0, RECENT_AUCTIONS);
    const knownRecent = state.ids.filter((id) => {
      const e = state.auctions[id];
      if (!e || e.k !== "cars") return false;
      const ends = Date.parse(e.endsAt || "");
      return Number.isFinite(ends) && (Date.now() - ends) / 86400000 >= 0 &&
        (Date.now() - ends) / 86400000 <= RECENT_DAYS;
    });
    candidateIds = [...new Set([...frontier, ...knownRecent])];
  }
  const all = candidateIds.filter((id) => needsVisit(state.auctions[id]));
  const repair = all.filter((id) => state.auctions[id] != null);
  const fresh = all.filter((id) => state.auctions[id] == null); // already newest-first
  const todo = [...repair, ...fresh];
  console.log(`${todo.length} auctions to visit (${repair.length} incomplete/retryable FIRST, then ${fresh.length} never seen); budget ${budget}\n`);

  // State was previously flushed only when a CAR auction was found. Since ~93% of ids are some
  // other department, an interrupted run threw away every classification made since the last car
  // — up to hundreds of requests that would simply be repeated next time. Checkpoint on a count
  // instead, so progress survives a kill regardless of what the ids turned out to be.
  const CHECKPOINT_EVERY = 25;
  const saveState = () => fs.writeFileSync(STATE, JSON.stringify(state));

  let visited = 0, carAuctions = 0, added = 0, skipped = 0, offsite = 0;
  for (const id of todo) {
    if (visited >= budget) break;
    visited++;
    if (visited % CHECKPOINT_EVERY === 0) saveState();

    const r = await fetchText(AUCTION(id));
    if (r.offsite) {
      // Redirected to a partner house (bruun-rasmussen.dk / bukowskis.com). Terminal, and cheap:
      // we never issue the doomed request to the other domain.
      state.auctions[id] = "offsite";
      offsite++;
      await sleep(DELAY_MS);
      continue;
    }
    if (r.http !== 200) {
      // 404 is a normal, expected answer here: sitemap-sale.xml spans every Bonhams division,
      // and not every id resolves on the cars host. A 0 means the network failed — countable and
      // retryable, unlike an answer the server actually gave.
      if (r.http === 0) {
        const prev = state.auctions[id];
        const tries = (prev && typeof prev === "object" && prev.k === "err" ? prev.tries : 0) + 1;
        state.auctions[id] = { k: "err", tries };
      } else {
        state.auctions[id] = r.http === 404 ? "gone" : `http${r.http}`;
      }
      await sleep(DELAY_MS);
      continue;
    }

    const nd = parseNextData(r.text);
    const pp = nd?.pageProps;
    if (!pp) { state.auctions[id] = "noparse"; await sleep(DELAY_MS); continue; }

    if (!auctionHasCars(pp)) {
      const dept = pp?.auction?.departments?.[0]?.sDepartmentName || "?";
      state.auctions[id] = "other";
      if (visited % 25 === 0) console.log(`  ...${visited} visited (last: ${id} = ${dept})`);
      await sleep(DELAY_MS);
      continue;
    }

    // Collect page 1, then walk the data route until every car is accounted for. Keyed by lot
    // id so a re-run (or an overlapping page) cannot double-count.
    const byId = new Map();
    for (const l of pp?.lotData?.auctionLots ?? []) byId.set(l.id, l);

    const nbHits = pp?.lotData?.nbHits ?? byId.size;
    const carsExpected = carLotCount(pp);
    const slug = nd?.query?.auctionName;
    const countCars = () => [...byId.values()].filter((l) => l?.department?.code === "MOT-CAR").length;

    let pages = 1;
    const lastPage = Math.ceil(nbHits / PAGE_SIZE);
    if (nd?.buildId && slug) {
      for (let p = 2; p <= lastPage; p++) {
        // Every car already in hand — the rest of this auction is someone else's department.
        if (carsExpected != null && countCars() >= carsExpected) break;
        await sleep(DELAY_MS);
        const pr = await fetchText(lotPageUrl(nd.buildId, id, slug, p));
        if (pr.http !== 200 || !pr.text) break;
        const more = parseLotPage(pr.text);
        if (!more || !more.length) break;
        for (const l of more) byId.set(l.id, l);
        pages++;
      }
    }

    let got = 0;
    for (const lot of byId.values()) {
      const out = adaptLot(lot, id);
      if (out.kind === "sale") {
        const k = `${out.record.source}|${out.record.source_lot_id}`;
        if (!sales.has(k)) added++;
        sales.set(k, out.record);
        got++;
      } else skipped++;
    }

    carAuctions++;
    const carsFound = countCars();
    const auctionDate = pp?.auction?.dates?.start?.[0]?.date?.datetime?.slice(0, 10) ?? null;
    const name = auctionDate ?? "?";
    const short = carsExpected != null && carsFound < carsExpected ? `  SHORT ${carsFound}/${carsExpected} cars` : "";
    console.log(
      `CARS  ${String(id).padEnd(6)} ${name}  ${String(got).padStart(4)} kept  ` +
      `(${byId.size}/${nbHits} lots, ${pages}p, ${carsFound} car lots)${short}`
    );

    state.auctions[id] = { k: "cars", lots: byId.size, hits: nbHits, cars: carsFound, carsExpected, kept: got, endsAt: auctionDate, pages };
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify([...sales.values()], null, 1));
    saveState();
    await sleep(DELAY_MS);
  }

  saveState();
  const remaining = state.ids.filter((id) => needsVisit(state.auctions[id])).length;
  console.log(`\nvisited ${visited} auctions: ${carAuctions} had cars`);
  console.log(`${sales.size} sales (+${sales.size - startCount} this run), ${skipped} non-car/unconcluded lots skipped`);
  console.log(`${remaining} auctions still unvisited`);
  console.log(`Wrote ${OUT}`);
}

run();
