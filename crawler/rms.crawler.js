// RM SOTHEBY'S HARVESTER — auction-partitioned, incremental, cron-safe.
//
// ── THE API ────────────────────────────────────────────────────────────────────────────
//   POST /api/search/SearchLots?page=N&pageSize=200
//   body {"LocationCountry":[],"OfferStatus":null,"SortBy":"Recent","CategoryTag":[],
//         "Auctions":["mo26"]}
// Unauthenticated. Reports 98,595 lots. Prices are ON THE LIST RESPONSE (195/200 carried a
// value), so no per-lot detail fetch is needed.
//
// ── WHY PARTITION BY AUCTION ───────────────────────────────────────────────────────────
// The endpoint has the same offset ceiling as BaT: page 50 (offset 10,000) returns 200 items,
// page 60 (offset 12,000) returns 0. Unpartitioned, 88,000 of the 98,595 lots are unreachable.
// `Auctions:["mo26"]` narrows to 199 — an auction is a few hundred lots, far under the cap — so
// the whole archive is reachable as the union of its events, with NO truncation anywhere. The
// auction code is the one in every lot URL: /auctions/{code}/lots/...
//
// ── BUILT FOR CRON ─────────────────────────────────────────────────────────────────────
// Designed to be re-run on a schedule against a growing archive:
//   * IDEMPOTENT — every record is keyed on (source, source_lot_id), the same natural key the
//     database uses, so re-running never creates a second copy of a sale.
//   * INCREMENTAL — auctions already harvested are skipped, so a nightly run costs a handful of
//     requests instead of thousands.
//   * SELF-HEALING — an auction is only marked done when its lot count matches what the API
//     claims. A partial harvest is retried next run rather than being silently accepted.
//   * RECHECK WINDOW — recent auctions are re-fetched for RECHECK_DAYS even when "complete",
//     because results post late and a lot can settle days after the hammer falls.
//
// Usage:
//   node crawler/rms.crawler.js discover      # find auction codes only
//   node crawler/rms.crawler.js run [maxAuctions]
//   node crawler/rms.crawler.js run --full    # ignore incremental state, re-walk everything

"use strict";

const fs = require("fs");
const path = require("path");
const { adaptLot } = require("./rms-adapt");
const { closeListingFromSale, closeListingAsEnded } = require("./listing-lifecycle");

const API = "https://rmsothebys.com/api/search/SearchLots";
const UA = "Mozilla/5.0 (compatible; price-index-research/1.0)";
const HEADERS = { "User-Agent": UA, Accept: "application/json", "Content-Type": "application/json", Referer: "https://rmsothebys.com/search" };

const PAGE_SIZE = 200;
const MAX_PAGE = 49;            // measured: offset 10,000 is the last page that answers
const DELAY_MS = Number(process.env.DELAY_MS) || 1500;
const RECHECK_DAYS = Number(process.env.SCRAPE_RECENT_DAYS) || 45; // late results are common
const DISCOVERY_PAGES = process.env.SCRAPE_MODE === "full"
  ? MAX_PAGE
  : Math.max(1, Number(process.env.RMS_RECENT_DISCOVERY_PAGES) || 5);

const OUT = path.join(__dirname, "..", "samples", "scraped", "rms.json");

// ASKING PRICES MUST NOT LAND IN THE SCRAPED-SALES DIRECTORY.
//
// Caught before first ingest: this file was originally written to samples/scraped/, which is
// precisely the directory ingest reads as SALES. Every private-sale ask the adapter had
// carefully diverted would have been loaded straight back in as a sold price — defeating the
// gate completely and reproducing the DuPont defect by accident, through a file path.
//
// Asks belong to the `listing` table, so they are kept in a separate directory that the sales
// loader never scans.
const LISTINGS_OUT = path.join(__dirname, "..", "samples", "listings", "rms-listings.json");
const STATE = path.join(__dirname, "..", "samples", "rms.state.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BODY = { LocationCountry: [], OfferStatus: null, SortBy: "Recent", CategoryTag: [] };

async function search(page, extra = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${API}?page=${page}&pageSize=${PAGE_SIZE}`, {
        method: "POST", headers: HEADERS,
        body: JSON.stringify({ ...BODY, ...extra }),
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 429 || res.status >= 500) { await sleep(10000 * (attempt + 1)); continue; }
      if (res.status !== 200) return { http: res.status, items: [], total: null };
      const j = await res.json();
      return { http: 200, items: j.items || [], total: j.pager ? j.pager.totalItems : null };
    } catch (e) {
      await sleep(6000 * (attempt + 1));
    }
  }
  return { http: 0, items: [], total: null };
}

const auctionCodeOf = (item) => (String(item.link || "").match(/\/auctions\/([^/]+)\/lots\//) || [])[1] || null;

// ── AUCTION DATE ───────────────────────────────────────────────────────────────────────
// The list endpoint has NO date field and GetSearchSelectionOptions returns only weekday names,
// so the date comes from the auction page's schema.org Event block. This is ONE fetch per
// AUCTION, not per lot — hundreds of requests across the whole archive, not tens of thousands.
// Without it every RM sale would be undated and therefore invisible to all trend maths, which
// is precisely what went wrong with Mecum.
const MONTHS = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 };

async function resolveAuctionDate(code) {
  try {
    const res = await fetch(`https://rmsothebys.com/auctions/${code}/`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30000) });
    if (res.status !== 200) return null;
    const html = await res.text();

    // Preferred: schema.org Event, which states the dates explicitly.
    for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        const ld = JSON.parse(m[1]);
        const nodes = Array.isArray(ld) ? ld : [ld];
        for (const n of nodes) {
          const d = n.endDate || n.startDate;
          if (d && /\d{4}-\d{2}-\d{2}/.test(d)) return new Date(d).toISOString();
        }
      } catch { /* one malformed block must not stop the others */ }
    }

    // Fallback: the human-readable date the page prints ("15 August 2026"). Take the LAST such
    // date — a multi-day sale should be dated by when it closed, not when it opened.
    const text = [...html.matchAll(/\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})/gi)];
    if (text.length) {
      const t = text[text.length - 1];
      const d = new Date(Date.UTC(Number(t[3]), MONTHS[t[2].toLowerCase()], Number(t[1]), 12));
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
    return null;
  } catch {
    return null;
  }
}

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

// Walk the unfiltered Recent feed to learn which auctions exist. Capped by the same offset
// ceiling, but auction codes repeat heavily so a few pages surface most of them.
async function discover(maxPages = MAX_PAGE) {
  const codes = new Map(); // code -> auction display name
  for (let page = 0; page <= maxPages; page++) {
    const r = await search(page);
    if (r.http !== 200 || !r.items.length) break;
    for (const it of r.items) {
      const c = auctionCodeOf(it);
      if (c && !codes.has(c)) codes.set(c, it.header || c);
    }
    if (page % 10 === 0) console.log(`  discover page ${page}: ${codes.size} auctions so far`);
    await sleep(DELAY_MS);
  }
  return codes;
}

async function run() {
  const full = process.argv.includes("--full") || process.env.SCRAPE_MODE === "full";
  const maxAuctions = Number(process.argv.find((a) => /^\d+$/.test(a))) || Infinity;

  const state = loadJson(STATE, { auctions: {}, updated: null });
  const sales = new Map(loadJson(OUT, []).map((r) => [`${r.source}|${r.source_lot_id}`, r]));
  const listings = new Map(loadJson(LISTINGS_OUT, []).map((r) => [`${r.source}|${r.source_lot_id}`, r]));
  const startCount = sales.size;

  console.log(`resuming: ${startCount} sales on file, ${Object.keys(state.auctions).length} auctions known\n`);

  console.log("discovering auctions...");
  const codes = await discover(DISCOVERY_PAGES);
  for (const [code, name] of codes) {
    if (!state.auctions[code]) state.auctions[code] = { name, complete: false, date: null, lots: 0 };
    else state.auctions[code].name = name;
  }
  console.log(`  ${codes.size} auction codes known\n`);

  const now = Date.now();
  let processed = 0, skipped = 0;

  for (const [code, meta] of Object.entries(state.auctions)) {
    if (processed >= maxAuctions) break;

    if (!full && meta.date) {
      const age = (now - new Date(meta.date).getTime()) / 86400000;
      if (age > RECHECK_DAYS) { skipped++; continue; }
    }

    // Incremental: a finished, settled auction is immutable — do not re-fetch it every night.
    // Recent ones stay in the recheck window because late results are common.
    if (!full && meta.complete) {
      const age = meta.date ? (now - new Date(meta.date).getTime()) / 86400000 : Infinity;
      if (age > RECHECK_DAYS) { skipped++; continue; }
    }

    if (!meta.date) meta.date = await resolveAuctionDate(code), await sleep(DELAY_MS);

    let claimed = null, added = 0, closedListings = 0, undated = 0, asks = 0, notSold = 0;
    for (let page = 0; page <= MAX_PAGE; page++) {
      const r = await search(page, { Auctions: [code] });
      if (r.http !== 200) { claimed = null; break; }
      if (claimed == null) claimed = r.total;
      if (!r.items.length) break;

      for (const it of r.items) {
        const out = adaptLot(it, meta.date, { auctionCode: code });
        if (out.kind === "sale" && out.record.source_lot_id) {
          const k = `${out.record.source}|${out.record.source_lot_id}`;
          if (!sales.has(k)) added++;
          sales.set(k, out.record);
          const closed = closeListingFromSale(listings.get(k), out.record);
          if (closed) { listings.set(k, closed); closedListings++; }
        } else if (out.kind === "listing" && out.record.source_lot_id) {
          listings.set(`${out.record.source}|${out.record.source_lot_id}`, out.record);
          asks++;
        } else if (/no auction date/.test(out.reason || "")) undated++;
        else {
          // An older RM asking row can change to a non-asking outcome after the auction closes.
          // That is a closure signal for the listing table, but never a sale without the adapter's
          // explicit Sold + valueType=Sold gate.
          const link = String(it.link || "");
          const lotId = it.id || (link.match(/\/lots\/([^/?#]+)/) || [])[1] || null;
          const k = lotId ? `rms|${lotId}` : null;
          if (k && listings.has(k) && meta.date && /offered without reserve|not sold|withdrawn|bid/i.test(String(it.valueType || ""))) {
            listings.set(k, closeListingAsEnded(listings.get(k), meta.date, `RM valueType changed to "${it.valueType || "unknown"}"`));
            closedListings++;
          }
          notSold++;
        }
      }
      if (r.items.length < PAGE_SIZE) break;
      await sleep(DELAY_MS);
    }

    // Only call it complete when the walk actually covered what the API claims. A short walk is
    // retried next run rather than being frozen as done.
    const harvested = [...sales.values()].filter((r) => r._extra && r._extra.auction === code).length;
    meta.lots = harvested;
    meta.complete = claimed != null && harvested + asks + notSold >= Math.min(claimed, PAGE_SIZE * (MAX_PAGE + 1));
    meta.harvestedAt = new Date().toISOString();
    processed++;

    console.log(
      `${meta.complete ? "DONE " : "PART "} ${code.padEnd(10)} ${String(meta.name).slice(0, 30).padEnd(31)} ` +
      `claimed=${String(claimed ?? "?").padStart(5)} +${String(added).padStart(4)} sales  ` +
      `asks=${String(asks).padStart(3)} closed=${String(closedListings).padStart(3)} notSold=${String(notSold).padStart(4)}${undated ? `  UNDATED=${undated}` : ""}  ` +
      `date=${meta.date ? meta.date.slice(0, 10) : "UNRESOLVED"}`
    );

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify([...sales.values()], null, 1));
    fs.writeFileSync(LISTINGS_OUT, JSON.stringify([...listings.values()], null, 1));
    state.updated = new Date().toISOString();
    fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
    await sleep(DELAY_MS);
  }

  const dates = [...sales.values()].map((r) => String(r.sold_at).slice(0, 10)).sort();
  console.log(`\n${sales.size} sales (+${sales.size - startCount} this run), ${listings.size} asking-price listings held separately`);
  console.log(`skipped ${skipped} auctions already complete and settled`);
  if (dates.length) console.log(`date range ${dates[0]} -> ${dates[dates.length - 1]}`);
  console.log(`Wrote ${OUT}`);
}

const mode = process.argv[2] || "run";
if (mode === "discover") {
  discover().then((c) => {
    console.log(`\n${c.size} auctions:`);
    for (const [code, name] of [...c].slice(0, 40)) console.log(`   ${code.padEnd(12)} ${name}`);
  });
} else run();
