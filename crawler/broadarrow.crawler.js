// BROAD ARROW AUCTIONS HARVESTER.
//
// ── WHY THIS IS ONE-PAGE-PER-LOT, NOT ONE-PAGE-PER-AUCTION ────────────────────────────────
// Unlike Gooding or Sotheby's Motorsport, there is no bulk JSON endpoint here: robots.txt
// explicitly disallows the search/results/API routes that would give it
// (`/vehicles/results`, `/vehicles/auction_search`, `/api/v1/vehicles`, `/*/sold?`). Individual
// `/vehicles/{eventCode}_{lotNumber}/{slug}` pages are NOT disallowed and are listed directly in
// the sitemap, so that's the only compliant way in — one request per lot.
//
// ── WHY THIS DEFAULTS TO ONE EVENT, NOT THE WHOLE SITE ────────────────────────────────────
// robots.txt states `Crawl-delay: 10`. Honoring that across all ~2,700 sitemap-listed vehicles
// is ~7.5 hours — deliberately out of scope for a first pass. This harvests one bounded,
// confirmed-closed event (~93 lots) as a real, honestly small sample, the same shape as the
// existing Bonhams sample. Pass an event-code prefix to target a different one.
//
// ── DATE RESOLUTION ────────────────────────────────────────────────────────────────────────
// No per-lot date on the vehicle page itself. Resolved once from /past-auctions, which lists
// every event's closing date next to its name — matched against the event/branch name printed
// on each lot page. Multi-day events use the LAST day (same policy as Gooding/RM: dated by when
// the sale closed, not when it opened).
//
// Usage: node crawler/broadarrow.crawler.js [eventCodePrefix]   (default: jc22)
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { adaptVehiclePage, LOT_ID_RE } = require("./broadarrow-adapt");
const { closeListingFromSale, closeListingAsEnded } = require("./listing-lifecycle");

const UA = "Mozilla/5.0 (compatible; price-index-research/1.0)";
const HEADERS = { "User-Agent": UA };
const CRAWL_DELAY_MS = 10000; // robots.txt: Crawl-delay: 10 — honored, not worked around
const RECENT_MODE = process.env.SCRAPE_MODE !== "full" && process.env.SCRAPE_MODE !== "backfill";
const RECENT_LOTS = Math.max(1, Number(process.env.BROADARROW_RECENT_LOTS) || 200);

const SITEMAP = "https://www.broadarrowauctions.com/sitemaps/bagauction/sitemap.xml.gz";
const PAST_AUCTIONS = "https://www.broadarrowauctions.com/past-auctions";

const OUT = path.join(__dirname, "..", "samples", "scraped", "broadarrow.json");
const LISTINGS_OUT = path.join(__dirname, "..", "samples", "listings", "broadarrow-listings.json");
const STATE = path.join(__dirname, "..", "samples", "broadarrow.state.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

async function fetchText(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
      if (res.status === 429 || res.status >= 500) { await sleep(15000 * (attempt + 1)); continue; }
      if (res.status !== 200) return { http: res.status, text: null };
      return { http: 200, text: await res.text() };
    } catch {
      await sleep(8000 * (attempt + 1));
    }
  }
  return { http: 0, text: null };
}

// One fetch returns every vehicle URL on the site; callers filter it. Kept separate from
// fetchSitemapUrls() so `auto` mode can group by event without re-downloading.
async function fetchAllSitemapEntries() {
  const res = await fetch(SITEMAP, { headers: HEADERS, redirect: "follow", signal: AbortSignal.timeout(30000) });
  const buf = Buffer.from(await res.arrayBuffer());
  const xml = zlib.gunzipSync(buf).toString("utf8");
  const seen = new Set();
  const out = [];
  for (const m of xml.matchAll(/<loc>(https:\/\/www\.broadarrowauctions\.com\/vehicles\/([a-z0-9]+)_[a-z0-9]+\/[^<]*)<\/loc>/gi)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ url: m[1], event: m[2].toLowerCase() });
  }
  return out;
}

async function fetchSitemapUrls(eventPrefix) {
  const all = await fetchAllSitemapEntries();
  return all.filter((e) => e.event === eventPrefix.toLowerCase()).map((e) => e.url);
}

// Pick the event with the most unharvested lots. Without this the crawler always re-checks the
// hardcoded default event, which under cron means never advancing past it. Largest-first so a
// scheduled run does the most useful work available in its time budget; per-lot state means a
// finished event is skipped for free.
async function largestUnfinishedEvent(state) {
  const all = await fetchAllSitemapEntries();
  const byEvent = new Map();
  for (const e of all) {
    const lotId = (e.url.match(LOT_ID_RE) || [])[1];
    if (!lotId || state.done[lotId]) continue;
    if (!byEvent.has(e.event)) byEvent.set(e.event, []);
    byEvent.get(e.event).push(e.url);
  }
  if (!byEvent.size) return null;
  const [event, urls] = [...byEvent.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  return { event, urls, remaining: byEvent.size };
}

// The sitemap is newest-first in practice, and event codes carry a year suffix (jc22,
// monterey26, etc.). Recent mode refreshes the newest event even when its lot ids are already
// marked done, so a corrected result or a newly posted sale is not frozen out by state.
async function latestEvent() {
  const all = await fetchAllSitemapEntries();
  const byEvent = new Map();
  all.forEach((entry, index) => {
    if (!byEvent.has(entry.event)) byEvent.set(entry.event, { urls: [], index });
    byEvent.get(entry.event).urls.push(entry.url);
  });
  const yearOf = (event) => {
    const m = String(event).match(/(\d{2,4})$/);
    if (!m) return 0;
    const year = Number(m[1]);
    return year < 100 ? 2000 + year : year;
  };
  const [event, meta] = [...byEvent.entries()].sort((a, b) =>
    yearOf(b[0]) - yearOf(a[0]) || a[1].index - b[1].index
  )[0] || [];
  return event ? { event, urls: meta.urls.slice(0, RECENT_LOTS), remaining: byEvent.size } : null;
}

// event/branch name (exact text) -> closing ISO date
async function resolveEventDates() {
  const r = await fetchText(PAST_AUCTIONS);
  if (!r.text) return new Map();
  const map = new Map();
  const MONTHS = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 };
  const blockRe = /<h2 class='top'>([\s\S]*?)<\/h2>\s*<h2 class='mid'>([\s\S]*?)<\/h2>/g;
  let m;
  while ((m = blockRe.exec(r.text))) {
    const dateText = m[1].trim();
    const name = m[2].replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').trim();
    // "18 August 2022" or "16 - 17 May 2026" — take the LAST day/month/year triple in the string.
    const days = [...dateText.matchAll(/(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/gi)];
    if (!days.length) continue;
    const last = days[days.length - 1];
    const d = new Date(Date.UTC(Number(last[3]), MONTHS[last[2].toLowerCase()], Number(last[1]), 12));
    if (!Number.isNaN(d.getTime())) map.set(name, d.toISOString());
  }
  return map;
}

function branchNameOf(html) {
  const m = html.match(/class='lot-and-branch'>\s*<span>[\s\S]*?<\/span>\s*<span>\s*([\s\S]*?)\s*<\/span>/);
  return m ? m[1].trim() : null;
}

async function run() {
  const eventPrefix = process.argv[2] || "jc22";

  const sales = new Map(loadJson(OUT, []).map((r) => [`${r.source}|${r.source_lot_id}`, r]));
  const listings = new Map(loadJson(LISTINGS_OUT, []).map((r) => [`${r.source}|${r.source_lot_id}`, r]));
  const state = loadJson(STATE, { done: {} });
  const startCount = sales.size;

  console.log(`resuming: ${sales.size} sales, ${listings.size} listings on file\n`);
  console.log(`resolving event dates from ${PAST_AUCTIONS} ...`);
  const eventDates = await resolveEventDates();
  console.log(`  ${eventDates.size} events with a resolved date\n`);

  let urls;
  if (eventPrefix === "auto") {
    console.log(RECENT_MODE
      ? `recent mode: refreshing the newest event (up to ${RECENT_LOTS} lots) ...`
      : "auto mode: finding the event with the most unharvested lots ...");
    const pick = RECENT_MODE ? await latestEvent() : await largestUnfinishedEvent(state);
    if (!pick) { console.log("every event in the sitemap is fully harvested — nothing to do"); return; }
    urls = pick.urls;
    console.log(`  -> "${pick.event}" (${urls.length} lots outstanding; ${pick.remaining} events still have work)\n`);
  } else {
    console.log(`fetching sitemap, filtering to event prefix "${eventPrefix}" ...`);
    urls = await fetchSitemapUrls(eventPrefix);
    console.log(`  ${urls.length} vehicle pages for this event\n`);
    if (!urls.length) { console.log("nothing to do — check the event prefix"); return; }
  }

  let added = 0, addedListings = 0, closedListings = 0, skipped = 0, undated = 0;
  for (const url of urls) {
    const lotId = (url.match(LOT_ID_RE) || [])[1];
    if (state.done[lotId] && !RECENT_MODE) { continue; }

    const r = await fetchText(url);
    if (r.http !== 200) {
      console.log(`FAIL  ${lotId}  http=${r.http}`);
      await sleep(CRAWL_DELAY_MS);
      continue;
    }

    const branch = branchNameOf(r.text);
    const soldAt = branch ? eventDates.get(branch) : null;
    const out = adaptVehiclePage(r.text, url, soldAt);

    if (out.kind === "sale") {
      const k = `${out.record.source}|${out.record.source_lot_id}`;
      if (!sales.has(k)) added++;
      sales.set(k, out.record);
      const closed = closeListingFromSale(listings.get(k), out.record);
      if (closed) { listings.set(k, closed); closedListings++; }
      console.log(`SALE  ${lotId.padEnd(10)} $${out.record.price.toLocaleString().padStart(11)}  ${out.record.title}`);
    } else if (out.kind === "listing") {
      const k = `${out.record.source}|${out.record.source_lot_id}`;
      if (!listings.has(k)) addedListings++;
      listings.set(k, out.record);
      console.log(`LIST  ${lotId.padEnd(10)} $${out.record.price.toLocaleString().padStart(11)}  ${out.record.title}`);
    } else {
      // A known closed event can leave a previous estimate page with no price-row once the lot
      // has ended without a published hammer price. Close that old listing, but never invent a
      // sale from the absence of a price.
      const existing = listings.get(`broadarrow|${lotId}`);
      if (existing && soldAt && /no price-row|no price found/i.test(out.reason || "")) {
        listings.set(`broadarrow|${lotId}`, closeListingAsEnded(existing, soldAt, out.reason));
        closedListings++;
      }
      if (/no auction date/.test(out.reason)) undated++;
      skipped++;
      console.log(`SKIP  ${lotId.padEnd(10)} ${out.reason}`);
    }
    state.done[lotId] = true;

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.mkdirSync(path.dirname(LISTINGS_OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify([...sales.values()], null, 1));
    fs.writeFileSync(LISTINGS_OUT, JSON.stringify([...listings.values()], null, 1));
    fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
    await sleep(CRAWL_DELAY_MS);
  }

  console.log(`\n${sales.size} sales (+${added} this run), ${listings.size} listings (+${addedListings} this run), ${closedListings} listings closed, ${skipped} skipped (${undated} undated)`);
  console.log(`Wrote ${OUT} and ${LISTINGS_OUT}`);
}

run();
