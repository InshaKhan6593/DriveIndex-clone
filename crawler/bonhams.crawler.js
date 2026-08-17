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
// ── STATE ─────────────────────────────────────────────────────────────────────────────────
// Per auction id, recording WHY an id was finished: "cars" (harvested) or "other" (a different
// department). Re-running never re-fetches a known non-car auction, which is what keeps the
// 11k enumeration a one-time cost rather than a repeated one.
//
// Usage:
//   node crawler/bonhams.crawler.js            # resume, default budget
//   node crawler/bonhams.crawler.js 500        # visit at most 500 auctions this run
"use strict";

const fs = require("fs");
const path = require("path");
const { adaptLot, parseAuctionPage, auctionHasCars, DEPT_CARS } = require("./bonhams-adapt");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const HEADERS = { "User-Agent": UA, Accept: "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9" };

// robots.txt sets no Crawl-delay. 1.2s is self-imposed: each response is ~500KB, so this is
// deliberately gentler than the request count alone suggests.
const DELAY_MS = 1200;

const SITEMAP = "https://www.bonhams.com/sitemap-sale.xml";
const AUCTION = (id) => `https://cars.bonhams.com/auction/${id}/`;

const OUT = path.join(__dirname, "..", "samples", "scraped", "bonhams.json");
const STATE = path.join(__dirname, "..", "samples", "bonhams.state.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const loadJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };

async function fetchText(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS, redirect: "follow", signal: AbortSignal.timeout(30000) });
      if (res.status === 429 || res.status >= 500) { await sleep(10000 * (attempt + 1)); continue; }
      if (res.status !== 200) return { http: res.status, text: null };
      return { http: 200, text: await res.text() };
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

  // The id list changes rarely; cache it so a resumed run doesn't re-download 1.6MB of XML.
  if (!state.ids || !state.ids.length) {
    console.log(`fetching ${SITEMAP} ...`);
    state.ids = await fetchAuctionIds();
    console.log(`  ${state.ids.length} auctions listed (ids ${state.ids[state.ids.length - 1]}..${state.ids[0]})\n`);
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, JSON.stringify(state));
  }

  const todo = state.ids.filter((id) => !state.auctions[id]);
  console.log(`${todo.length} auctions unvisited; visiting up to ${budget} this run\n`);

  let visited = 0, carAuctions = 0, added = 0, skipped = 0;
  for (const id of todo) {
    if (visited >= budget) break;
    visited++;

    const r = await fetchText(AUCTION(id));
    if (r.http !== 200) {
      // 404 is a normal, expected answer here: sitemap-sale.xml spans every Bonhams division,
      // and not every id resolves on the cars host.
      state.auctions[id] = r.http === 404 ? "gone" : `http${r.http}`;
      await sleep(DELAY_MS);
      continue;
    }

    const pp = parseAuctionPage(r.text);
    if (!pp) { state.auctions[id] = "noparse"; await sleep(DELAY_MS); continue; }

    if (!auctionHasCars(pp)) {
      const dept = pp?.auction?.departments?.[0]?.sDepartmentName || "?";
      state.auctions[id] = "other";
      if (visited % 25 === 0) console.log(`  ...${visited} visited (last: ${id} = ${dept})`);
      await sleep(DELAY_MS);
      continue;
    }

    const lots = pp?.lotData?.auctionLots ?? [];
    const nbHits = pp?.lotData?.nbHits ?? lots.length;
    let got = 0;
    for (const lot of lots) {
      const out = adaptLot(lot, id);
      if (out.kind === "sale") {
        const k = `${out.record.source}|${out.record.source_lot_id}`;
        if (!sales.has(k)) added++;
        sales.set(k, out.record);
        got++;
      } else skipped++;
    }

    carAuctions++;
    const name = pp?.auction?.dates?.start?.[0]?.date?.datetime?.slice(0, 10) ?? "?";
    console.log(`CARS  ${String(id).padEnd(6)} ${name}  ${String(got).padStart(4)} car lots kept  (${lots.length}/${nbHits} lots on page 1)`);

    state.auctions[id] = "cars";
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify([...sales.values()], null, 1));
    fs.writeFileSync(STATE, JSON.stringify(state));
    await sleep(DELAY_MS);
  }

  fs.writeFileSync(STATE, JSON.stringify(state));
  const remaining = state.ids.filter((id) => !state.auctions[id]).length;
  console.log(`\nvisited ${visited} auctions: ${carAuctions} had cars`);
  console.log(`${sales.size} sales (+${sales.size - startCount} this run), ${skipped} non-car/unconcluded lots skipped`);
  console.log(`${remaining} auctions still unvisited`);
  console.log(`Wrote ${OUT}`);
}

run();
