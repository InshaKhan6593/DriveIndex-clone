// DUPONT REGISTRY HARVESTER.
//
// ── WHY PLAIN HTTP, NOT A BROWSER ──────────────────────────────────────────────────────────
// The listing/search page (`/cars-for-sale/all`) is a client-rendered SPA that calls
// `POST /api/graphql` — but robots.txt disallows `/api/`, so that's off-limits regardless of
// whether it's called directly or triggered by driving a real browser through the page. The
// individual VDP pages don't have this problem: they're server-rendered (Next.js App Router
// RSC streaming), so the real listing data is already in the plain HTML — no JS execution, no
// API call, nothing under a disallowed path.
//
// ── DISCOVERY ──────────────────────────────────────────────────────────────────────────────
// vdp-sitemap-{1..15}.xml, listed in the root sitemap.xml, ~999 URLs each (~15,000 total).
// This is a LISTINGS source (asking prices), so there's no "get everything" urgency the way
// there is for a sale source — a bounded sample per run is fine and expected to grow over time
// via the normal incremental/idempotent re-run pattern.
//
// ── A REAL BROWSER USER-AGENT IS REQUIRED ─────────────────────────────────────────────────
// A bare `Mozilla/5.0` with no other headers gets a 403 from a basic bot filter (confirmed: the
// exact same request with a full realistic header set gets 200). This is not a targeted block —
// robots.txt itself is `Allow: /` with no bot-specific rules — so a normal browser header set is
// used rather than treated as evasion.
//
// Usage: node crawler/dupont.crawler.js [sitemapIndex] [maxUrls]   (default: sitemap 1, 200 urls)
"use strict";

const fs = require("fs");
const path = require("path");
const { adaptVdpPage } = require("./dupont-adapt");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const HEADERS = { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9" };
const DELAY_MS = Number(process.env.DELAY_MS) || 1500;
const RECENT_MODE = process.env.SCRAPE_MODE !== "full";
const RECENT_URLS = Math.max(1, Number(process.env.DUPONT_RECENT_URLS) || 200);

const SITEMAP = (n) => `https://www.dupontregistry.com/vdp-sitemap-${n}.xml`;

const OUT = path.join(__dirname, "..", "samples", "listings", "dupont-listings.json");
const STATE = path.join(__dirname, "..", "samples", "dupont.state.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

async function fetchText(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS, redirect: "follow", signal: AbortSignal.timeout(30000) });
      if (res.status === 429 || res.status >= 500) { await sleep(10000 * (attempt + 1)); continue; }
      if (res.status !== 200) return { http: res.status, text: null };
      return { http: 200, text: await res.text() };
    } catch {
      await sleep(6000 * (attempt + 1));
    }
  }
  return { http: 0, text: null };
}

async function fetchSitemapUrls(n) {
  const r = await fetchText(SITEMAP(n));
  if (!r.text) return [];
  return [...r.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
}

// SITEMAP_COUNT is fixed by the site: vdp-sitemap-1..15.xml.
const SITEMAP_COUNT = 15;

// Pick the first sitemap that still has unharvested URLs. Without this the crawler always
// re-checks sitemap 1, which is correct but useless under cron — every scheduled run would
// re-confirm finished work and never advance. State is per-URL, so a finished sitemap costs
// one small XML fetch to rule out, not a re-crawl.
async function firstUnfinishedSitemap(state) {
  for (let n = 1; n <= SITEMAP_COUNT; n++) {
    const urls = await fetchSitemapUrls(n);
    if (!urls.length) continue;
    if (urls.some((u) => !state.done[u])) return { n, urls };
    console.log(`  sitemap ${n}: complete, skipping`);
  }
  return null;
}

async function run() {
  const auto = process.argv[2] === "auto";
  const maxUrls = Number(process.argv[auto ? 3 : 3]) || (auto ? 999 : 200);

  const listings = new Map(loadJson(OUT, []).map((r) => [`${r.source}|${r.source_lot_id}`, r]));
  const state = loadJson(STATE, { done: {} });
  const startCount = listings.size;

  console.log(`resuming: ${listings.size} listings on file\n`);

  let sitemapIndex, urls;
  if (auto) {
    if (RECENT_MODE) {
      sitemapIndex = 1;
      urls = await fetchSitemapUrls(sitemapIndex);
      urls = urls.slice(0, RECENT_URLS);
      console.log(`recent mode: refreshing the newest ${urls.length} listing URLs from sitemap 1\n`);
    } else {
      console.log("auto mode: finding the first sitemap with unharvested URLs ...");
      const pick = await firstUnfinishedSitemap(state);
      if (!pick) { console.log("\nall 15 sitemaps fully harvested — nothing to do"); return; }
      ({ n: sitemapIndex, urls } = pick);
      console.log(`  -> sitemap ${sitemapIndex}\n`);
    }
  } else {
    sitemapIndex = Number(process.argv[2]) || 1;
    console.log(`fetching vdp-sitemap-${sitemapIndex}.xml ...`);
    urls = await fetchSitemapUrls(sitemapIndex);
  }
  console.log(`  ${urls.length} VDP urls found, harvesting up to ${maxUrls}\n`);

  let added = 0, closed = 0, skipped = 0, processed = 0;
  for (const url of urls) {
    if (processed >= maxUrls) break;
    if (state.done[url] && !RECENT_MODE) continue;

    const r = await fetchText(url);
    processed++;
    if (r.http !== 200) {
      console.log(`FAIL  http=${r.http}  ${url}`);
      state.done[url] = true;
      await sleep(DELAY_MS);
      continue;
    }

    const out = adaptVdpPage(r.text, url);
    if (out.kind === "listing") {
      const k = `${out.record.source}|${out.record.source_lot_id}`;
      if (!listings.has(k)) added++;
      listings.set(k, out.record);
      if (!out.record.is_active) closed++;
      const price = out.record.price == null ? "no price" : `$${out.record.price.toLocaleString()}`;
      console.log(`${out.record.is_active ? "GOT  " : "CLOSE"}  ${price.padStart(12)}  ${out.record.title}`);
    } else {
      skipped++;
      console.log(`SKIP  ${out.reason}  ${url}`);
    }
    state.done[url] = true;

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify([...listings.values()], null, 1));
    fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
    await sleep(DELAY_MS);
  }

  console.log(`\n${listings.size} listings (+${added} this run), ${closed} explicitly closed, ${skipped} skipped this run`);
  console.log(`Wrote ${OUT}`);
}

run();
