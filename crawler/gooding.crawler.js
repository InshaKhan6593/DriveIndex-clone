// GOODING & COMPANY HARVESTER — auction-partitioned, incremental, cron-safe.
//
// ── THE API ────────────────────────────────────────────────────────────────────────────
// No API in the RM/BaT sense — the site is a Gatsby build, and every "realized prices" page
// ships its own fully-hydrated JSON at build time:
//   GET /page-data/auction/realized/{slug}/page-data.json
// Unauthenticated, single request per auction, no pagination and NO offset cap: an auction
// page carries its whole lot list (measured up to 525 lots on one page) in one response.
//
// ── WHY THIS SOURCE NEEDS NO PARTITIONING ─────────────────────────────────────────────
// BaT and RM both cap at ~10,000 records per query and have to be split into windows narrow
// enough to stay under it. Gooding never hits that problem: the unit IS the auction, each
// auction is its own complete document, and there are only ~41 of them (2020-present, from
// the sitemap). One request per auction is the whole harvest.
//
// ── AUCTION DISCOVERY ──────────────────────────────────────────────────────────────────
// sitemap.xml lists every `/auction/realized/{slug}` page directly — no need to walk the
// homepage's "current auctions" links, which only shows a handful of upcoming/recent sales.
//
// ── BUILT FOR CRON ─────────────────────────────────────────────────────────────────────
//   * IDEMPOTENT — keyed on (source, source_lot_id) = ("good", lot.slug), Gooding's own
//     already-deduped slug (it appends its own suffix, e.g. "-1", "-pb26", the same way BaT
//     appends "-3" — confirmed by inspecting real duplicate-looking slugs).
//   * INCREMENTAL — an auction already fully fetched is skipped on the next run.
//   * RECHECK WINDOW — an auction whose resolved sale date is within RECHECK_DAYS of "now" is
//     re-fetched even when previously complete, because a "Sold" flag can be filled in a few
//     days after the hammer falls (RM had the identical defect from skipping this).
//
// Usage:
//   node crawler/gooding.crawler.js discover      # list auction slugs only
//   node crawler/gooding.crawler.js run [maxAuctions]
//   node crawler/gooding.crawler.js run --full    # ignore incremental state, re-fetch everything

"use strict";

const fs = require("fs");
const path = require("path");
const { adaptLot } = require("./gooding-adapt");

const SITEMAP = "https://www.goodingco.com/sitemap.xml";
const PAGE_DATA = (slug) => `https://www.goodingco.com/page-data/auction/realized/${slug}/page-data.json`;
const UA = "Mozilla/5.0 (compatible; price-index-research/1.0)";
const HEADERS = { "User-Agent": UA, Accept: "application/json" };

const DELAY_MS = Number(process.env.DELAY_MS) || 1200;
const RECHECK_DAYS = Number(process.env.SCRAPE_RECENT_DAYS) || 45; // late results can post after a sale

const OUT = path.join(__dirname, "..", "samples", "scraped", "gooding.json");
const STATE = path.join(__dirname, "..", "samples", "gooding.state.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

async function fetchText(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
      if (res.status === 429 || res.status >= 500) { await sleep(8000 * (attempt + 1)); continue; }
      if (res.status !== 200) return { http: res.status, text: null };
      return { http: 200, text: await res.text() };
    } catch {
      await sleep(5000 * (attempt + 1));
    }
  }
  return { http: 0, text: null };
}

async function discover() {
  const r = await fetchText(SITEMAP);
  if (!r.text) return [];
  const slugs = new Set();
  const re = /<loc>https:\/\/www\.goodingco\.com\/auction\/realized\/([^<]+)<\/loc>/g;
  let m;
  while ((m = re.exec(r.text))) slugs.add(m[1]);
  return [...slugs];
}

// A sale can run over several days (Pebble Beach: Fri + Sat sessions). No per-lot session
// field is exposed, so — same policy already established for RM's human-readable-date
// fallback — the whole auction is dated by when it CLOSED, i.e. the last auction session's
// endDate, not the first session's startDate.
function resolveAuctionDate(subEvents) {
  const sessions = (subEvents || []).filter((e) => e.__typename === "ContentfulSubEventAuction" && (e.endDate || e.startDate));
  if (!sessions.length) return null;
  const dates = sessions.map((e) => new Date(e.endDate || e.startDate)).filter((d) => !Number.isNaN(d.getTime()));
  if (!dates.length) return null;
  dates.sort((a, b) => a - b);
  return dates[dates.length - 1].toISOString();
}

async function fetchAuction(slug) {
  const r = await fetchText(PAGE_DATA(slug));
  if (r.http !== 200 || !r.text) return { http: r.http, ok: false };
  let json;
  try { json = JSON.parse(r.text); } catch { return { http: r.http, ok: false, reason: "bad json" }; }
  const d = json?.result?.data?.contentfulWebPageAuction;
  if (!d) return { http: r.http, ok: false, reason: "unexpected shape" };
  return { http: 200, ok: true, title: d.title, auction: d.auction };
}

async function run() {
  const full = process.argv.includes("--full") || process.env.SCRAPE_MODE === "full";
  const maxAuctions = Number(process.argv.find((a) => /^\d+$/.test(a))) || Infinity;

  const state = loadJson(STATE, { auctions: {}, updated: null });
  const sales = new Map(loadJson(OUT, []).map((r) => [`${r.source}|${r.source_lot_id}`, r]));
  const startCount = sales.size;

  console.log(`resuming: ${startCount} sales on file, ${Object.keys(state.auctions).length} auctions known\n`);
  console.log("discovering auctions from sitemap...");
  const slugs = await discover();
  console.log(`  ${slugs.length} realized-auction slugs found\n`);
  for (const slug of slugs) if (!state.auctions[slug]) state.auctions[slug] = { complete: false, date: null, lots: 0 };

  const now = Date.now();
  let processed = 0, skipped = 0;

  for (const slug of slugs) {
    if (processed >= maxAuctions) break;
    const meta = state.auctions[slug];

    if (!full && meta.date) {
      const age = (now - new Date(meta.date).getTime()) / 86400000;
      if (age > RECHECK_DAYS) { skipped++; continue; }
    }

    if (!full && meta.complete) {
      const age = meta.date ? (now - new Date(meta.date).getTime()) / 86400000 : Infinity;
      if (age > RECHECK_DAYS) { skipped++; continue; }
    }

    const r = await fetchAuction(slug);
    if (!r.ok) {
      console.log(`FAIL  ${slug.padEnd(40)} http=${r.http} ${r.reason || ""}`);
      await sleep(DELAY_MS);
      continue;
    }

    const soldAt = resolveAuctionDate(r.auction.subEvents);
    const lots = r.auction.lot || [];
    const auctionMeta = { auctionSlug: slug, auctionName: r.title, currency: r.auction.currency };

    let added = 0, notVehicle = 0, noResult = 0, undisclosed = 0, undated = 0;
    for (const lot of lots) {
      const out = adaptLot(lot, soldAt, auctionMeta);
      if (out.kind === "sale") {
        const k = `${out.record.source}|${out.record.source_lot_id}`;
        if (!sales.has(k)) added++;
        sales.set(k, out.record);
      } else if (/not a vehicle/.test(out.reason)) notVehicle++;
      else if (/no result recorded/.test(out.reason)) noResult++;
      else if (/undisclosed/.test(out.reason)) undisclosed++;
      else if (/no auction date/.test(out.reason)) undated++;
    }

    meta.date = soldAt;
    meta.lots = lots.length;
    meta.complete = true; // a 200 response IS the whole auction — no offset cap, nothing partial
    meta.harvestedAt = new Date().toISOString();
    processed++;

    console.log(
      `DONE  ${slug.padEnd(40)} ${String(r.title || "").slice(0, 28).padEnd(28)} ` +
      `lots=${String(lots.length).padStart(4)} +${String(added).padStart(4)} sales  ` +
      `notVehicle=${notVehicle} noResult=${noResult} undisclosed=${undisclosed}${undated ? `  UNDATED=${undated}` : ""}  ` +
      `date=${soldAt ? soldAt.slice(0, 10) : "UNRESOLVED"}`
    );

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify([...sales.values()], null, 1));
    state.updated = new Date().toISOString();
    fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
    await sleep(DELAY_MS);
  }

  const dates = [...sales.values()].map((r) => String(r.sold_at).slice(0, 10)).sort();
  console.log(`\n${sales.size} sales (+${sales.size - startCount} this run)`);
  console.log(`skipped ${skipped} auctions already complete and settled`);
  if (dates.length) console.log(`date range ${dates[0]} -> ${dates[dates.length - 1]}`);
  console.log(`Wrote ${OUT}`);
}

const mode = process.argv[2] || "run";
if (mode === "discover") {
  discover().then((slugs) => {
    console.log(`${slugs.length} auctions:`);
    for (const s of slugs) console.log(`   ${s}`);
  });
} else run();
