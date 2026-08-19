// BaT DETAIL-PAGE ENRICHER — closes the single biggest quality hole in the corpus.
//
// -- THE PROBLEM ------------------------------------------------------------------------
// BaT is ~74% of the corpus and supplies mileage on 0.04% of it (71 of 162,012 sales). The
// list API (crawler/bat-partitioned.crawler.js) carries no odometer, so engine/signal.js
// mileage-adjusts three quarters of the corpus against a fallback "average" — a 5,000-mile
// car and a 150,000-mile car of the same model are compared like for like. README: "the
// single biggest quality constraint".
//
// The number IS published — on the lot page, in a server-rendered "Listing Details" sidebar:
//     <strong>Listing Details</strong><ul>
//       <li>Chassis: <a href="…google.com/search?q=WBABW33456PX84700">WBABW33456PX84700</a></li>
//       <li>30k Miles</li>
//       <li>Five-Speed Automatic Transmission</li>
//       <li>Sonora Metallic Paint</li>
//       …
//     </ul>
// One GET per lot buys VIN, mileage, transmission AND color — the same fields the README
// lists as detail-page-only blockers (sale.vin 0.1%, transmission 6.6%, color ~0%).
//
// ⚠️ THE CHEAP FIX IS A TRAP (measured, do not redo): 23.9% of BaT TITLES state mileage, but
// only when it is notably low ("7k-Mile 2005 Evo VIII"). Title-regex harvesting selects a
// low-mileage-biased subsample, drags avgMileage down and makes every mileage adjustment
// systematically wrong. The odometer must come from the lot page, where every car reports it.
//
// -- WRONG-DATA GUARDS (every fetched page is validated before anything is written) --------
//   1. og:title must equal the record's title exactly. We fetch by the record's own URL, but
//      the DOM-harvester incident (58.6% fabricated title↔URL pairs) is the failure mode this
//      exists to prevent: a page whose title disagrees with the record is not this lot's page.
//   2. The page <title> repeats the hammer result ("sold for $16,250 on …"); for USD records
//      it must equal the record's price. A page at the right URL with the wrong price is a
//      relisted/reused URL — enriching it would hang another car's odometer on this sale.
//   3. VIN passes dedup/dedup.js isValidVin (17-char ISO 3779, or >=11 for pre-1981 chassis;
//      junk words and all-zeros placeholders rejected).
//   4. Mileage only from an explicit odometer li ("30k Miles" / "12,345 Miles" /
//      "48,000 Kilometers" -> converted). TMU -> null. Bounds 1..1,500,000.
//   5. Transmission only when unambiguous — "Automated Manual Transmission" contains both
//      families and is refused. "Automatic Climate Control" is not a transmission at all,
//      so the li must say "Transmission" or be a bare "N-Speed Manual/Automatic".
// Any check that fails leaves the record UNTOUCHED and the lot marked with the reason in the
// state file, so it is never re-fetched and never silently retried into bad data.
//
// -- PACING ------------------------------------------------------------------------------
// robots.txt says Crawl-delay: 1. The partitioned harvester's experience at volume (see its
// header) is that the limit that bites is cumulative, so this runs gentler than the minimum:
// 1.5s base + 25% jitter, an adaptive ratchet (x1.5, ceiling 6s) on HTTP 429/5xx and transport
// errors, and a clean stop after 4 backoffs so a restart gets fresh sockets. Local DNS faults
// do not ratchet (slowing down cannot fix a resolver).
//
// -- SPEED -------------------------------------------------------------------------------
// The work is one request per lot and cannot be parallelised past the crawl-delay, so "fast"
// here means: never re-fetch a lot already attempted (state file), never fetch a lot that
// already has mileage, newest-sold-first (recent sales feed the trends that matter most and
// avgMileage is computed over CLEAN sales, so reserve-not-met lots sort last), checkpoint
// every 25 lots, and a bounded budget per run so cron drains the backlog incrementally.
//
// Usage:
//   node crawler/bat-detail.crawler.js [budget]   # enrich up to N lots (default 300)
//   node crawler/bat-detail.crawler.js --status
"use strict";

const fs = require("fs");
const path = require("path");
const { isValidVin } = require("../dedup/dedup");

const OUT = path.join(__dirname, "..", "samples", "scraped", "bat-partitioned.json");
const STATE = path.join(__dirname, "..", "samples", "scraped", "bat-detail.state.json");
// Single-instance lock, same guard shape as crawler/mecum.event.crawler.js: a second instance
// holds its own in-memory copy of the 196k-record map, and the two saves ERASE each other's
// enrichment (each save writes the whole array from its own stale copy). The lock is acquired
// before any harvesting; cron's scrape:bat-detail stage therefore exits cleanly if a manual
// run is still going, rather than racing it.
const LOCK = path.join(__dirname, "..", "data", "bat-detail.lock");

const HEADERS = {
  // A bare curl-style UA is not enough for BaT's edge in testing; a realistic full browser
  // header set is standard scraping hygiene, same call the DuPont crawler made.
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://bringatrailer.com/auctions/results/",
};

// ── PACING ──────────────────────────────────────────────────────────────────────────────
let baseDelayMs = Number(process.env.DELAY_MS) || 1500;
const JITTER = 0.25;
const MAX_DELAY_MS = 6000;
const MAX_BACKOFFS_BEFORE_EXIT = 4;
let backoffEvents = 0;
const backoffCodes = new Set();
const LOCAL_FAULT = /^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED)$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextDelay = () => Math.round(baseDelayMs * (1 + (Math.random() * 2 - 1) * JITTER));

function noteBackoff(label) {
  backoffEvents++;
  backoffCodes.add(label);
  if (!LOCAL_FAULT.test(label)) baseDelayMs = Math.min(Math.round(baseDelayMs * 1.5), MAX_DELAY_MS);
  console.log(`   ${label} -- backoff ${backoffEvents}/${MAX_BACKOFFS_BEFORE_EXIT}, base delay now ${baseDelayMs}ms`);
}

// ── PARSING (pure, unit-tested in bat-detail.test.js) ──────────────────────────────────

const stripTags = (s) => String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

// The list API's titles are entity-encoded ("4&#215;4") where the page's og:title is decoded
// ("4x4"), and the page prepends "No Reserve: " for no-reserve lots, which the list title
// omits. Measured on the first live run: 19 of 40 lots were "mismatched" on exactly these two
// cosmetic differences. Normalise both away so the guard still catches a GENUINELY different
// page (wrong car at this URL) without rejecting half the corpus on formatting.
function decodeEntities(s) {
  return String(s || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&times;/gi, "x")
    .replace(/&nbsp;/gi, " ")
    // Typography fold, same spirit as the resolver's: the entity decodes to the REAL
    // character (&#215; -> ×), while og:title prints ASCII — "4×4" and "4x4" are one title.
    .replace(/\u00D7/gi, "x")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function titlesMatch(recordTitle, ogTitle) {
  if (!ogTitle) return false;
  const a = decodeEntities(recordTitle);
  const b = decodeEntities(ogTitle);
  return b === a || b === `No Reserve: ${a}`;
}

// "30k Miles" | "12,345 Miles" | "~30k Miles" | "Approximately 48,000 Kilometers" | "Miles TMU"
// Returns { miles, note } — miles null unless the li is an explicit odometer reading.
function parseMiles(text) {
  const s = String(text || "").trim();
  if (/^tmu$/i.test(s) || /true miles unknown/i.test(s) || /^miles tmu$/i.test(s)) {
    return { miles: null, note: "tmu" };
  }
  const m = s.match(/^(?:approximately|approx\.?|~)?\s*([\d][\d,]*(?:\.\d+)?)\s*([kK])?\s*(miles|kilometers|kms?)\.?$/i);
  if (!m) return { miles: null, note: null };
  let n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return { miles: null, note: null };
  if (m[2]) n *= 1000;
  const isKm = /kilo|^km/i.test(m[3]);
  if (isKm) n *= 0.621371; // same conversion and note convention as crawler/cab-adapt.js
  n = Math.round(n);
  if (n < 1 || n > 1500000) return { miles: null, note: `implausible odometer "${s}"` };
  return { miles: n, note: isKm ? "converted from km" : null };
}

// Only an unambiguous li counts. "Automatic Climate Control" must NOT become a transmission,
// so the li must contain the word "Transmission" or be a bare "N-Speed Manual/Automatic".
// "Automated Manual Transmission" mentions both families and is refused.
function parseTransmission(text) {
  const s = String(text || "").trim();
  if (!/transmission/i.test(s) && !/^\d+(?:\.\d+)?-speed\s+(manual|automatic)$/i.test(s)) return null;
  const auto = /automat|cvt|\bdct\b|\bpdk\b|tiptronic|dual[- ]clutch/i.test(s);
  const manual = /manual|stick/i.test(s);
  if (auto && !manual) return "Automatic";
  if (manual && !auto) return "Manual";
  return null;
}

function parseLotPage(html) {
  const out = { ogTitle: null, titlePrice: null, lis: [] };

  const og = html.match(/property="og:title" content="([^"]+)"/);
  if (og) out.ogTitle = og[1].trim();

  // "… for sale on BaT Auctions - sold for $16,250 on August 16, 2026 (Lot #258,086) …"
  // Reserve-not-met lots say "bid to $X" instead. Only a bare "$" is compared (non-USD pages
  // can carry currency prefixes that would make the number a different currency's value).
  const tp = html.match(/<title>[^<]*?(?:sold for|bid to) \$([\d,]+)/i);
  if (tp) out.titlePrice = Number(tp[1].replace(/,/g, ""));

  const block = html.match(/<strong>Listing Details<\/strong>\s*<ul>([\s\S]*?)<\/ul>/);
  if (block) {
    out.lis = (block[1].match(/<li>[\s\S]*?<\/li>/g) || []).map((li) => stripTags(li));
  }
  return out;
}

// Apply every guard, then extract fields. Returns { ok, reason, fields } — ok=false means the
// page FAILED VALIDATION and nothing may be written for this lot.
function enrichFromHtml(rec, html) {
  const page = parseLotPage(html);

  // Guard 1: this page must be this lot's page (after normalising BaT's own formatting
  // variance — entity encoding and the "No Reserve: " prefix — see titlesMatch).
  if (!titlesMatch(rec.title, page.ogTitle)) {
    return { ok: false, reason: "title-mismatch", fields: {} };
  }
  // Guard 2: the hammer result on the page must agree with the record we are enriching.
  if (rec.currency === "USD" && rec.price != null && page.titlePrice != null && page.titlePrice !== rec.price) {
    return { ok: false, reason: "price-mismatch", fields: {} };
  }

  const fields = { mileage: null, vin_raw: null, transmission: null, color: null, note: null };

  for (const li of page.lis) {
    const chassis = li.match(/^chassis:\s*(.+)$/i);
    if (chassis && !fields.vin_raw) {
      const candidate = chassis[1].trim();
      if (isValidVin(candidate)) fields.vin_raw = candidate;
      // An invalid chassis value is NOT an error — pre-1981 lots legitimately carry short
      // numbers — it just is not usable, so leave null and move on.
      continue;
    }
    if (!fields.mileage) {
      const m = parseMiles(li);
      if (m.miles != null) {
        fields.mileage = m.miles;
        if (m.note) fields.note = m.note;
      }
    }
    if (!fields.transmission) {
      const t = parseTransmission(li);
      if (t) fields.transmission = t;
    }
    if (!fields.color) {
      const c = li.match(/^(.+?)\s+Paint$/);
      if (c) fields.color = c[1].trim();
    }
  }

  if (fields.mileage == null && fields.vin_raw == null && !fields.transmission && !fields.color) {
    return { ok: true, reason: "no-details", fields };
  }
  return { ok: true, reason: "ok", fields };
}

// ── STATE / IO ──────────────────────────────────────────────────────────────────────────

function loadRecords() {
  return JSON.parse(fs.readFileSync(OUT, "utf8"));
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE, "utf8"));
  } catch {
    return { fetched: {}, updated: null };
  }
}

function save(records, state) {
  fs.writeFileSync(OUT, JSON.stringify(records, null, 1));
  state.updated = new Date().toISOString();
  fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
}

function status() {
  const state = loadState();
  const records = loadRecords();
  const eligible = records.filter((r) => r.url && r.mileage == null);
  const fetched = Object.keys(state.fetched || {});
  const counts = {};
  for (const v of Object.values(state.fetched || {})) counts[v] = (counts[v] || 0) + 1;
  console.log(`records on file:        ${records.length}`);
  console.log(`lots already attempted: ${fetched.length}`);
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(14)} ${v}`);
  console.log(`lots still eligible:    ${eligible.length} (of these, ${eligible.filter((r) => !r.reserve_not_met).length} sold)`);
}

// ── HARVEST LOOP ────────────────────────────────────────────────────────────────────────

async function fetchLot(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
      if (res.status === 429 || res.status >= 500) {
        noteBackoff(`HTTP ${res.status}`);
        await sleep(15000 * (attempt + 1));
        continue;
      }
      return { http: res.status, html: res.status === 200 ? await res.text() : null };
    } catch (e) {
      noteBackoff(e.cause?.code || e.name || "transport error");
      await sleep(20000 * (attempt + 1));
    }
  }
  return { http: 0, html: null };
}

async function run(budget = 300) {
  const records = loadRecords();
  const state = loadState();

  // Sold-with-price first (their mileage feeds avgMileage, which clean-sales-only maths uses),
  // then newest-first within each class — recent sales feed the trends that matter most.
  const work = records
    .filter((r) => r.url && r.mileage == null && !(r.source_lot_id in state.fetched))
    .sort((a, b) => {
      const sa = a.reserve_not_met ? 1 : 0;
      const sb = b.reserve_not_met ? 1 : 0;
      if (sa !== sb) return sa - sb;
      return String(b.sold_at).localeCompare(String(a.sold_at));
    })
    .slice(0, budget);

  const tally = { ok: 0, "no-details": 0, "title-mismatch": 0, "price-mismatch": 0, gone: 0, transport: 0 };
  const enriched = { mileage: 0, vin: 0, transmission: 0, color: 0 };
  const mileages = [];
  let processed = 0;

  console.log(`enriching up to ${work.length} BaT lots (of ${records.filter((r) => r.url && r.mileage == null).length} eligible), base delay ${baseDelayMs}ms\n`);

  for (const rec of work) {
    if (backoffEvents >= MAX_BACKOFFS_BEFORE_EXIT) {
      const codes = [...backoffCodes].join(", ") || "unknown";
      console.log(`\nSTOPPING after ${backoffEvents} transport backoffs. Observed: ${codes}`);
      console.log(`Nothing already fetched was lost — resume with: node crawler/bat-detail.crawler.js`);
      break;
    }

    const r = await fetchLot(rec.url);

    if (r.http === 0) {
      // Transport failure: leave the lot OUT of state so a later run retries it.
      tally.transport++;
      continue;
    }
    if (r.http === 404 || r.http === 410) {
      state.fetched[rec.source_lot_id] = "gone";
      tally.gone++;
    } else if (r.http !== 200) {
      // Any other non-200 is a surprise (bot wall, 5xx handled in fetchLot). Record it as a
      // reason, do not enrich, do not hammer: it will not be retried this run.
      state.fetched[rec.source_lot_id] = `http-${r.http}`;
      tally[`http-${r.http}`] = (tally[`http-${r.http}`] || 0) + 1;
    } else {
      const { ok, reason, fields } = enrichFromHtml(rec, r.html);
      if (!ok) {
        state.fetched[rec.source_lot_id] = reason;
        tally[reason]++;
      } else {
        // Enrich — never overwrite a field the record already has.
        if (fields.mileage != null && rec.mileage == null) { rec.mileage = fields.mileage; enriched.mileage++; mileages.push(fields.mileage); }
        if (fields.vin_raw && !rec.vin_raw) { rec.vin_raw = fields.vin_raw; enriched.vin++; }
        if (fields.transmission && !rec.transmission) { rec.transmission = fields.transmission; enriched.transmission++; }
        if (fields.color && !rec.color) { rec.color = fields.color; enriched.color++; }
        rec._extra = { ...rec._extra, detail: { source: "bat-lot-page-v1", fetched_at: new Date().toISOString(), note: fields.note } };
        state.fetched[rec.source_lot_id] = reason === "no-details" ? "no-details" : "ok";
        tally[reason]++;
      }
    }

    processed++;
    if (processed % 25 === 0) {
      save(records, state);
      console.log(`  … ${processed}/${work.length}  mileage +${enriched.mileage}  (checkpointed)`);
    }
    await sleep(nextDelay());
  }

  save(records, state);

  console.log(`\n=== ENRICHMENT REPORT ===`);
  console.log(`lots processed: ${processed}`);
  for (const [k, v] of Object.entries(tally)) if (v) console.log(`  ${k.padEnd(16)} ${v}`);
  console.log(`fields added: mileage ${enriched.mileage} · vin ${enriched.vin} · transmission ${enriched.transmission} · color ${enriched.color}`);
  if (mileages.length) {
    mileages.sort((a, b) => a - b);
    const at = (p) => mileages[Math.min(mileages.length - 1, Math.floor(p * mileages.length))];
    console.log(`odometer sanity: n=${mileages.length}  min=${mileages[0]}  median=${at(0.5)}  p95=${at(0.95)}  max=${mileages[mileages.length - 1]}`);
  }
}

if (require.main === module) {
  const arg = process.argv[2] || "300";
  if (arg === "--status") {
    status();
  } else {
    // Acquire the single-instance lock (see LOCK above). A live holder refuses to start.
    try {
      const l = JSON.parse(fs.readFileSync(LOCK, "utf8"));
      try {
        process.kill(l.pid, 0);
        console.error(`REFUSING TO START: another bat-detail enricher is running (pid ${l.pid}, since ${l.startedAt}).`);
        console.error(`Two instances erase each other's enrichment. If this is wrong, delete ${LOCK}.`);
        process.exit(3);
      } catch (e) { if (e.code === "EPERM") { console.error(`REFUSING TO START: pid ${l.pid} holds the lock.`); process.exit(3); } }
    } catch { /* no lock, or unreadable — proceed */ }
    fs.mkdirSync(path.dirname(LOCK), { recursive: true });
    fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 1));
    process.on("exit", () => { try { fs.unlinkSync(LOCK); } catch {} });
    process.on("SIGINT", () => { try { fs.unlinkSync(LOCK); } catch {} process.exit(130); });
    run(Number(arg) || 300);
  }
}

module.exports = { parseMiles, parseTransmission, parseLotPage, enrichFromHtml, titlesMatch, decodeEntities };
