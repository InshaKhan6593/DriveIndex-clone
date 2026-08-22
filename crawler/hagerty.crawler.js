// HAGERTY MARKETPLACE HARVESTER — live listings plus completed auction outcomes.
//
// Permission: this source is intentionally proxy-gated. The operator must provide an
// authorized Hagerty access path in CRAWLER_PROXY_URL (GitHub Actions uses HAGERTY_PROXY_URL).
// A 401/403/challenge is logged as BLOCKED and exits non-zero; it must never look like a clean
// zero-record scrape.
//
// Datasets are deliberately separate:
//   samples/scraped/hagerty.json             -> Sold for / Sold after sale records
//   samples/listings/hagerty-listings.json   -> live inventory and closed lifecycle states
//
// Modes:
//   recent (default) — refresh active inventory and closed outcomes from the last 90 days;
//                    active listings are always refreshed.
//   full              — crawl the available Marketplace pagination and retain outcomes dated
//                    HAGERTY_FROM_DATE..HAGERTY_TO_DATE (defaults 2024-01-01..2026-12-31).
//
// Usage:
//   node crawler/hagerty.crawler.js discover
//   node crawler/hagerty.crawler.js run [maxRequests]
//   node crawler/hagerty.crawler.js auto [maxRequests]
"use strict";

const fs = require("fs");
const path = require("path");
const { PlaywrightCrawler, ProxyConfiguration } = require("crawlee");
const {
  adaptHagertyPage,
  adaptHagertyResultCard,
  listingFromSale,
} = require("./hagerty-adapt");

const ROOT = "https://www.hagerty.com";
const MARKETPLACE = `${ROOT}/marketplace/`;
const AUCTION_RESULTS = `${ROOT}/marketplace/search?forSale=false&type=auctions`;
const SALES_OUT = path.join(__dirname, "..", "samples", "scraped", "hagerty.json");
const LISTINGS_OUT = path.join(__dirname, "..", "samples", "listings", "hagerty-listings.json");
const STATE_FILE = path.join(__dirname, "..", "samples", "hagerty.state.json");

const REQUESTED_MODE = String(process.env.SCRAPE_MODE || "recent").toLowerCase();
const MODE = REQUESTED_MODE === "full" || REQUESTED_MODE === "backfill" ? REQUESTED_MODE : "recent";
const NOW = new Date();
const RECENT_DAYS = Number(process.env.SCRAPE_RECENT_DAYS || 90);
const DEFAULT_FROM = String(process.env.SCRAPE_FROM_DATE || process.env.HAGERTY_FROM_DATE || "2024-01-01");
const DEFAULT_TO = String(process.env.SCRAPE_TO_DATE || process.env.HAGERTY_TO_DATE || "2026-12-31");
const MAX_REQUESTS = Number(process.env.HAGERTY_MAX_REQUESTS) || (MODE !== "recent" ? 3000 : 700);
const MAX_ACTIVE_DETAILS = Number(process.env.HAGERTY_MAX_ACTIVE_DETAILS) || 350;
const SETTLE_MS = Number(process.env.HAGERTY_SETTLE_MS) || 2500;
const DELAY_MS = Number(process.env.DELAY_MS) || 1500;
const CONCURRENCY = 1;
const BLOCKED_RESOURCES = new Set(["image", "media", "font", "stylesheet"]);

const load = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
};
const saveAtomic = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
};

const previousSales = load(SALES_OUT, []);
const previousListings = load(LISTINGS_OUT, []);
const sales = new Map(previousSales.map((r) => [`${r.source}|${r.source_lot_id}`, r]));
const listings = new Map(previousListings.map((r) => [`${r.source}|${r.source_lot_id}`, r]));
const state = load(STATE_FILE, { done: {}, active: {}, updated: null });
state.done = state.done || {};
state.active = state.active || {};
const startSales = sales.size;
const startListings = listings.size;

function dateOnly(value) {
  const d = new Date(`${String(value).slice(0, 10)}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function runWindow() {
  const configuredFrom = dateOnly(DEFAULT_FROM) || new Date("2024-01-01T00:00:00.000Z");
  const configuredTo = dateOnly(DEFAULT_TO) || new Date("2026-12-31T23:59:59.999Z");
  const recentFrom = new Date(NOW.getTime() - Math.max(1, RECENT_DAYS) * 86400000);
  const from = MODE !== "recent" ? configuredFrom : new Date(Math.max(configuredFrom.getTime(), recentFrom.getTime()));
  const to = new Date(Math.min(configuredTo.getTime(), NOW.getTime()));
  return { from, to };
}

const WINDOW = runWindow();

function inClosedWindow(value) {
  const d = new Date(value);
  return !Number.isNaN(d.getTime()) && d >= WINDOW.from && d <= WINDOW.to;
}

function keyOf(record) { return `${record.source}|${record.source_lot_id}`; }

function save() {
  state.updated = new Date().toISOString();
  saveAtomic(SALES_OUT, JSON.stringify([...sales.values()], null, 1));
  saveAtomic(LISTINGS_OUT, JSON.stringify([...listings.values()], null, 1));
  saveAtomic(STATE_FILE, JSON.stringify(state, null, 1));
}

function isDetailUrl(url) {
  return /\/marketplace\/(?:auction|classified)\//i.test(String(url || ""));
}

function isIndexUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname === "www.hagerty.com"
      && (u.pathname === "/marketplace/" || u.pathname === "/marketplace/search");
  } catch { return false; }
}

function extractExtra(text) {
  const body = String(text || "");
  const mileage = body.match(/\bMileage\s*[:\-]?\s*([\d,]+)\s*(?:miles?|mi)?\b/i);
  const vin = body.match(/\bVIN\s*[:\-]?\s*([A-HJ-NPR-Z0-9]{8,17})\b/i);
  return {
    mileage: mileage ? Number(mileage[1].replace(/,/g, "")) : null,
    vin_raw: vin ? vin[1] : null,
    image_url: null,
  };
}

function recordFrom(out, stats) {
  if (!out || out.kind === "skip" || !out.record) {
    stats.skipped++;
    if (out?.reason) stats.skipReasons[out.reason] = (stats.skipReasons[out.reason] || 0) + 1;
    return;
  }
  const record = out.record;
  if (out.kind === "sale") {
    if (!inClosedWindow(record.sold_at)) {
      stats.outOfWindow++;
      return;
    }
    sales.set(keyOf(record), record);
    // Keep the listing row as an auditable lifecycle record and close an earlier live row. The
    // separate sale row is what valuation uses; this row is never active and never enters maths.
    listings.set(keyOf(record), listingFromSale(record, NOW));
    stats.sales++;
    return;
  }
  if (record.is_active || !record.closed_at || inClosedWindow(record.closed_at)) {
    listings.set(keyOf(record), record);
    stats.listings++;
  } else {
    stats.outOfWindow++;
  }
}

function detailAlreadyDone(url) {
  // Full backfills resume historical detail pages. Recent runs deliberately refresh active URLs
  // even when a previous run saw them, because current bids and ending times change daily.
  return MODE !== "recent" && state.done[url] && !state.active[url];
}

async function discover() {
  console.log(`Hagerty mode=${MODE} closed window=${WINDOW.from.toISOString().slice(0, 10)}..${WINDOW.to.toISOString().slice(0, 10)}`);
  console.log(`seeds:\n  ${MARKETPLACE}\n  ${AUCTION_RESULTS}`);
  console.log(`max requests=${MAX_REQUESTS}, active detail budget=${MAX_ACTIVE_DETAILS}`);
  if (!process.env.CRAWLER_PROXY_URL) {
    console.log("proxy: not configured locally (set CRAWLER_PROXY_URL before an authorized run)");
  } else {
    console.log("proxy: configured");
  }
}

async function run(maxRequests) {
  const stats = { pages: 0, details: 0, sales: 0, listings: 0, skipped: 0, outOfWindow: 0, blocked: 0, failed: 0, skipReasons: {} };
  const queuedDetails = new Set();
  let activeDetailsQueued = 0;
  state.run = {
    started_at: NOW.toISOString(), mode: MODE,
    from_date: WINDOW.from.toISOString(), to_date: WINDOW.to.toISOString(),
    pages: 0, details: 0, sales: 0, listings: 0, blocked: 0, failed: 0,
  };

  const proxyConfiguration = process.env.CRAWLER_PROXY_URL
    ? new ProxyConfiguration({ proxyUrls: [process.env.CRAWLER_PROXY_URL] })
    : undefined;

  const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency: CONCURRENCY,
    maxRequestsPerCrawl: maxRequests,
    maxRequestRetries: 2,
    requestHandlerTimeoutSecs: 90,
    async requestHandler({ page, request, response, enqueueLinks }) {
      await page.route("**/*", (route) => {
        const type = route.request().resourceType();
        return BLOCKED_RESOURCES.has(type) ? route.abort() : route.continue();
      });
      await page.waitForTimeout(SETTLE_MS);

      const statusCode = typeof response?.status === "function" ? response.status() : (response?.status || 200);
      const bodyText = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
      const blockedText = /access denied|request forbidden|captcha|cloudflare|unusual traffic/i.test(bodyText);
      if (statusCode === 401 || statusCode === 403 || blockedText) {
        stats.blocked++;
        state.run.blocked = stats.blocked;
        console.error(`BLOCKED hagerty http=${statusCode} ${request.url}`);
        throw new Error(`Hagerty access blocked (${statusCode}) at ${request.url}`);
      }

      if (isDetailUrl(request.url)) {
        if (detailAlreadyDone(request.url)) return;
        stats.details++;
        const title = await page.$eval("h1", (el) => el.innerText).catch(() => null);
        const out = adaptHagertyPage({
          url: request.url, title, text: bodyText, now: NOW, extra: extractExtra(bodyText),
        });
        recordFrom(out, stats);
        state.done[request.url] = true;
        if (out?.record) state.active[request.url] = out.record.is_active === true;
        state.run.details = stats.details;
      } else if (isIndexUrl(request.url)) {
        stats.pages++;
        const extracted = await page.evaluate(() => {
          const clean = (value) => String(value || "").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim();
          const detail = [];
          const index = [];
          const seen = new Set();
          for (const a of document.querySelectorAll("a[href]")) {
            const href = a.href;
            let u;
            try { u = new URL(href, location.href); } catch { continue; }
            if (u.hostname !== "www.hagerty.com") continue;
            const text = clean(a.innerText || a.getAttribute("aria-label") || "");
            if (/\/marketplace\/(?:auction|classified)\//i.test(u.pathname)) {
              if (seen.has(u.href)) continue;
              seen.add(u.href);
              let card = text;
              let node = a;
              for (let i = 0; i < 4 && node?.parentElement; i++) {
                node = node.parentElement;
                const candidate = clean(node.innerText);
                if (candidate && candidate.length <= 1400) card = candidate;
              }
              detail.push({ url: u.href, title: text, text: card });
            } else if (u.pathname === "/marketplace/" || u.pathname === "/marketplace/search") {
              if (u.href !== location.href && !index.includes(u.href)) index.push(u.href);
            }
          }
          return { detail, index };
        }).catch(() => ({ detail: [], index: [] }));

        const cardResults = new Map();
        for (const item of extracted.detail) {
          const out = adaptHagertyResultCard({ ...item, now: NOW });
          cardResults.set(item.url, out);
          recordFrom(out, stats);
        }

        // Historical sale cards already contain a dated outcome. Only live/unknown cards get a
        // bounded detail request for VIN, mileage, current bid and exact ending time.
        const detailUrls = [];
        for (const item of extracted.detail) {
          if (activeDetailsQueued >= MAX_ACTIVE_DETAILS) break;
          if (queuedDetails.has(item.url)) continue;
          const out = cardResults.get(item.url);
          const needsDetail = out.kind === "listing" && (out.record?.is_active || out.record?.listing_status === "unknown");
          if (needsDetail) {
            detailUrls.push(item.url);
            queuedDetails.add(item.url);
            activeDetailsQueued++;
          }
        }
        if (detailUrls.length) await enqueueLinks({ urls: detailUrls });
        if (extracted.index.length) await enqueueLinks({ urls: extracted.index.filter(isIndexUrl) });
        state.pages = state.pages || {};
        state.pages[request.url] = new Date().toISOString();
        state.run.pages = stats.pages;
      }

      save();
      await page.waitForTimeout(DELAY_MS);
    },
    failedRequestHandler({ request, error }) {
      stats.failed++;
      state.run.failed = stats.failed;
      state.failures = state.failures || {};
      state.failures[request.url] = String(error?.message || error || "request failed").slice(0, 300);
      console.error(`FAILED hagerty ${request.url}: ${state.failures[request.url]}`);
      save();
    },
  });

  await crawler.run([MARKETPLACE, AUCTION_RESULTS]);
  state.run.finished_at = new Date().toISOString();
  state.run.sales = stats.sales;
  state.run.listings = stats.listings;
  state.run.blocked = stats.blocked;
  state.run.failed = stats.failed;
  save();

  const soldDates = [...sales.values()].map((r) => r.sold_at).filter(Boolean).sort();
  console.log(`\nHagerty harvest: ${startSales} -> ${sales.size} sales (+${stats.sales} seen), ${startListings} -> ${listings.size} lifecycle listings (+${stats.listings} seen)`);
  console.log(`pages=${stats.pages} details=${stats.details} skipped=${stats.skipped} out_of_window=${stats.outOfWindow} failed=${stats.failed} blocked=${stats.blocked}`);
  if (soldDates.length) console.log(`sale date range in retained corpus: ${soldDates[0].slice(0, 10)} -> ${soldDates[soldDates.length - 1].slice(0, 10)}`);
  for (const [reason, count] of Object.entries(stats.skipReasons).sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    console.log(`skip ${count}x: ${reason}`);
  }
  console.log(`Wrote ${SALES_OUT} and ${LISTINGS_OUT}`);
  if (stats.blocked || stats.failed) process.exitCode = 1;
}

const [command, argument] = process.argv.slice(2);
if (command === "discover") {
  discover().catch((error) => { console.error(error); process.exit(1); });
} else if (command === "run" || command === "auto" || !command) {
  run(Number(argument) || MAX_REQUESTS).catch((error) => { console.error(error); process.exit(1); });
} else {
  console.error("usage: node crawler/hagerty.crawler.js [discover|run|auto] [maxRequests]");
  process.exit(1);
}
