// BARRETT-JACKSON HARVESTER — API-first, one event page at a time.
//
// The live docket is a client-rendered page, but its own browser flow calls:
//
//   GET /api/docket?page=N&type=Vehicles&size=48&slug={event}&...&eventStatus=select_preview
//
// The response is structured JSON (`data[].attributes`) and includes sold state, price, lot
// id, event/run date, VIN and vehicle specifications. Reading that response is both smaller and
// more stable than scraping the rendered card DOM. A DOM adapter remains in barrettjackson-adapt.js
// for fixtures and as a fallback while the API contract is monitored.
//
// Permission/access: run this only from an authorized environment. If the site requires a
// browser VPN/proxy, set CRAWLER_PROXY_URL to one stable endpoint; do not rotate identities.
//
// Usage:
//   node crawler/barrettjackson.crawler.js discover
//   node crawler/barrettjackson.crawler.js run [maxEvents] [maxPagesPerEvent] [maxSalesThisRun]
//   node crawler/barrettjackson.crawler.js sample   # isolated 1-page / 5-sale smoke harvest
//   node crawler/barrettjackson.crawler.js auto

"use strict";

const fs = require("fs");
const path = require("path");
const { PlaywrightCrawler, ProxyConfiguration } = require("crawlee");
const { adaptApiRecord } = require("./barrettjackson-adapt");
const { BACKFILL_MODE, inWindow, yearInWindow } = require("../jobs/backfill-window");

const COMMAND = process.argv[2] || "auto";
const SAMPLE_MODE = COMMAND === "sample";
const ROOT = path.join(__dirname, "..");
const DEFAULT_OUT = path.join(ROOT, "samples", "scraped", "barrettjackson.json");
const DEFAULT_STATE = path.join(ROOT, "samples", "barrettjackson.state.json");
const SAMPLE_OUT = path.join(ROOT, "samples", "raw", "barrettjackson-api-sample-run.json");
const SAMPLE_STATE = path.join(ROOT, "samples", "raw", "barrettjackson-api-sample-run.state.json");
const OUT = path.resolve(process.env.BJ_OUTPUT || (SAMPLE_MODE ? SAMPLE_OUT : DEFAULT_OUT));
const STATE = path.resolve(process.env.BJ_STATE || (SAMPLE_MODE ? SAMPLE_STATE : DEFAULT_STATE));
const LOCK = path.join(ROOT, "data", "barrettjackson-crawler.lock");

const API_ROOT = "https://www.barrett-jackson.com/api/docket";
const EVENTS_API = "https://www.barrett-jackson.com/api/facets/all-past-events";
const PAGE_SIZE = Number(process.env.BJ_PAGE_SIZE) || 48;
const DEFAULT_MAX_PAGES = Number(process.env.BJ_MAX_PAGES) || 400;
const MAX_ATTEMPTS = 3;
const CONCURRENCY = 1;
const SETTLE_MS = Number(process.env.BJ_SETTLE_MS) || 1200;
const RECENT_MODE = process.env.SCRAPE_MODE !== "full";
const RECENT_DAYS = Number(process.env.SCRAPE_RECENT_DAYS || process.env.BJ_RECHECK_DAYS) || 45;
const CURRENT_YEAR = Number(process.env.BJ_CURRENT_YEAR) || new Date().getUTCFullYear();
const YEAR_SPAN = Number(process.env.BJ_RECENT_YEARS) || 2;
const TARGET_YEARS = Array.from({ length: Math.max(1, YEAR_SPAN) }, (_, i) => CURRENT_YEAR - i);
const TARGET_YEAR_RE = BACKFILL_MODE
  ? /\b20\d{2}\b/
  : RECENT_MODE
  ? new RegExp(`\\b(?:${TARGET_YEARS.join("|")})\\b`)
  : /\b20\d{2}\b/;
const REFRESH_COMPLETE = RECENT_MODE && !BACKFILL_MODE;
const KNOWN_EVENTS = [
  "2026-columbus",
  "2026-palm-beach",
  "2026-scottsdale",
  "scottsdale-fall-2025",
  "palm-beach-2025",
  "scottsdale-2025",
];

const load = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
};

const saveAtomic = (p, value) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, p);
};

const state = load(STATE, { events: {}, updated: null });
const records = new Map(load(OUT, []).map((r) => [`${r.source}|${r.source_lot_id}`, r]));
const startCount = records.size;

function save() {
  saveAtomic(OUT, [...records.values()]);
  state.updated = new Date().toISOString();
  saveAtomic(STATE, state);
}

function ensureEvents(slugs) {
  for (const slug of slugs) {
    if (!slug) continue;
    if (state.events[slug]) {
      if (state.events[slug].status === "deferred") state.events[slug].status = "todo";
      continue;
    }
    state.events[slug] = {
      status: "todo",
      attempts: 0,
      nextPage: 1,
      pages: 0,
      recordsSeen: 0,
      sales: 0,
      apiTotal: null,
      apiPageCount: null,
      saleAt: null,
      skipReasons: {},
      updated: null,
    };
  }
}

function apiUrl(slug, page) {
  const params = new URLSearchParams({
    page: String(page),
    type: "Vehicles",
    size: String(PAGE_SIZE),
    slug,
    q: "",
    make: "",
    model: "",
    year: "",
    is_reserve: "",
    collection: "",
    dayOfWeek: "",
    charity: "",
    lot: "",
    can_preview: "true",
    engine_size: "",
    interior_color: "",
    exterior_color: "",
    transmission_type_name: "",
    number_of_cylinders: "",
    validateLot: "0",
    eventStatus: "select_preview",
    orderBy: "",
  });
  return `${API_ROOT}?${params.toString()}`;
}

async function discover() {
  const configured = String(process.env.BJ_EVENT_SLUGS || "")
    .split(",").map((x) => x.trim()).filter(Boolean);
  if (configured.length) {
    ensureEvents(configured);
    save();
    console.log(`using ${configured.length} configured event slug(s)`);
    return true;
  }

  const discovered = [];
  const proxyConfiguration = process.env.CRAWLER_PROXY_URL
    ? new ProxyConfiguration({ proxyUrls: [process.env.CRAWLER_PROXY_URL] })
    : undefined;
  const discoveryCrawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency: 1,
    maxRequestRetries: 1,
    requestHandlerTimeoutSecs: 60,
    async requestHandler({ page }) {
      await page.waitForTimeout(SETTLE_MS);
      const payload = await readJsonBody(page);
      for (const event of Array.isArray(payload) ? payload : []) {
        const attributes = event?.attributes || event;
        const name = String(attributes?.name || "");
        const slug = String(attributes?.slug || "");
        if (TARGET_YEAR_RE.test(name) && slug && !/will-not-be-held/i.test(slug)) {
          discovered.push(slug);
        }
      }
    },
  });

  try {
    await discoveryCrawler.run([{ url: EVENTS_API, userData: { kind: "event-discovery" } }]);
  } catch (error) {
    console.warn(`past-event discovery unavailable (${String(error.message || error)}); using built-in recent events`);
  }

  // The event facet is the source of truth, with a built-in fallback for a first run without the
  // authorized proxy. Keep only the recent completed window requested for this source.
  const selected = [...new Set(discovered.length ? discovered : KNOWN_EVENTS)];
  ensureEvents(selected);
  for (const [slug, event] of Object.entries(state.events)) {
    if (!selected.includes(slug) && event.status === "todo") {
      event.status = "deferred";
      event.deferReason = "outside the configured 2025-2026 completed-event window";
    }
  }
  save();
  console.log(`discovered ${discovered.length || KNOWN_EVENTS.length} completed event(s) for ${TARGET_YEARS.join("/")}, ${Object.keys(state.events).length} event slug(s) tracked`);
  return discovered.length > 0;
}

function isRecentEvent(slug, event) {
  if (BACKFILL_MODE) {
    return inWindow(event?.saleAt) || yearInWindow(slug) || yearInWindow(event?.name);
  }
  if (TARGET_YEAR_RE.test(String(slug)) || TARGET_YEAR_RE.test(String(event?.name || ""))) return true;
  const date = Date.parse(event?.saleAt || "");
  if (!Number.isFinite(date)) return false;
  const age = (Date.now() - date) / 86400000;
  return age >= 0 && age <= RECENT_DAYS;
}

function readJsonBody(page) {
  return page.evaluate(() => document.body?.innerText || document.body?.textContent || "")
    .then((text) => {
      try { return JSON.parse(text); }
      catch (error) { throw new Error(`BJ API returned non-JSON body: ${String(text).slice(0, 180)} (${error.message})`); }
    });
}

function acquireLock() {
  if (fs.existsSync(LOCK)) {
    const pid = Number(fs.readFileSync(LOCK, "utf8"));
    try {
      process.kill(pid, 0);
      throw new Error(`another Barrett-Jackson crawler is running (pid ${pid})`);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      fs.unlinkSync(LOCK);
    }
  }
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  fs.writeFileSync(LOCK, String(process.pid));
}

function releaseLock() {
  if (fs.existsSync(LOCK)) fs.unlinkSync(LOCK);
}

async function run(maxEvents = Infinity, maxPages = DEFAULT_MAX_PAGES, maxSales = Infinity) {
  const configured = String(process.env.BJ_EVENT_SLUGS || "").split(",").map((x) => x.trim()).filter(Boolean);
  const allowed = configured.length ? new Set(configured) : null;
  ensureEvents(configured);
  if (!Object.keys(state.events).length) ensureEvents(KNOWN_EVENTS);

  acquireLock();
  let addedThisRun = 0;
  const todo = Object.entries(state.events)
    .filter(([slug, event]) => (!allowed || allowed.has(slug)) && !["dead", "deferred"].includes(event.status))
    .filter(([slug, event]) => event.status !== "complete" || (REFRESH_COMPLETE && isRecentEvent(slug, event)))
    .filter(([, event]) => event.status === "complete" || (event.attempts || 0) < MAX_ATTEMPTS)
    .slice(0, maxEvents);

  // A completed event is re-read from page 1 in recent mode so late-posted sold results and
  // corrected prices replace the previous normalized row instead of being skipped forever.
  for (const [slug, event] of todo) {
    if (event.status === "complete") {
      event.status = "todo";
      event.nextPage = 1;
      event.pages = 0;
      event.recordsSeen = 0;
      event.apiTotal = null;
      event.apiPageCount = null;
    }
  }

  console.log(`${records.size} sales on file; ${todo.length} event(s) selected; max ${maxPages} API page(s)/event`);
  const proxyConfiguration = process.env.CRAWLER_PROXY_URL
    ? new ProxyConfiguration({ proxyUrls: [process.env.CRAWLER_PROXY_URL] })
    : undefined;

  const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency: CONCURRENCY,
    maxRequestRetries: 2,
    requestHandlerTimeoutSecs: 120,
    async requestHandler({ page, request, enqueueLinks }) {
      const slug = request.userData.eventSlug;
      const pageNo = Number(request.userData.page || 1);
      const event = state.events[slug] || (state.events[slug] = { status: "todo", attempts: 0 });
      await page.waitForTimeout(SETTLE_MS);

      const payload = await readJsonBody(page);
      const rows = Array.isArray(payload?.data) ? payload.data : [];
      const pagination = payload?.meta?.pagination || {};
      const pageCount = Number(pagination.pageCount) || pageNo;
      const total = Number(pagination.total);
      const fetchedAt = new Date().toISOString();
      let pageAdded = 0;
      let latestSaleAt = event.saleAt || null;

      for (const row of rows) {
        const adapted = adaptApiRecord(row, fetchedAt);
        if (adapted.kind !== "sale") {
          const reason = adapted.reason || "unknown";
          event.skipReasons = event.skipReasons || {};
          event.skipReasons[reason] = (event.skipReasons[reason] || 0) + 1;
          continue;
        }
        const key = `${adapted.record.source}|${adapted.record.source_lot_id}`;
        if (!records.has(key)) {
          pageAdded++;
          addedThisRun++;
        }
        records.set(key, adapted.record);
        if (!latestSaleAt || adapted.record.sold_at > latestSaleAt) latestSaleAt = adapted.record.sold_at;
        if (addedThisRun >= maxSales) break;
      }

      event.status = "running";
      event.pages = Math.max(event.pages || 0, pageNo);
      event.nextPage = pageNo + 1;
      event.recordsSeen = (event.recordsSeen || 0) + rows.length;
      event.sales = [...records.values()].filter((record) => record.source === "bj" && record._extra?.event === slug).length;
      event.apiTotal = Number.isFinite(total) ? total : event.apiTotal;
      event.apiPageCount = pageCount;
      event.saleAt = latestSaleAt;
      event.updated = fetchedAt;

      console.log(`  ${slug} p${pageNo}: ${rows.length} API rows, ${pageAdded} new sales (${event.recordsSeen}/${event.apiTotal || "?"})`);

      if (addedThisRun >= maxSales) {
        event.status = "partial";
      } else if (pageNo < pageCount && pageNo < maxPages) {
        await enqueueLinks({
          urls: [apiUrl(slug, pageNo + 1)],
          userData: { eventSlug: slug, page: pageNo + 1 },
        });
      } else {
        event.status = pageNo >= pageCount ? "complete" : "partial";
      }
      save();
    },
    failedRequestHandler({ request, error }) {
      const slug = request.userData.eventSlug;
      const event = state.events[slug] || (state.events[slug] = { status: "todo", attempts: 0 });
      event.attempts = (event.attempts || 0) + 1;
      event.status = event.attempts >= MAX_ATTEMPTS ? "dead" : "error";
      event.lastError = String(error?.message || error || "request failed").slice(0, 300);
      save();
      console.error(`  FAILED ${request.url} (${event.lastError})`);
    },
  });

  try {
    const seeds = todo.map(([slug, event]) => ({
      url: apiUrl(slug, Number(event.nextPage || 1)),
      userData: { eventSlug: slug, page: Number(event.nextPage || 1) },
    }));
    if (seeds.length) await crawler.run(seeds);
  } finally {
    releaseLock();
    save();
  }

  console.log(`\nharvest: +${addedThisRun} sales (${startCount} -> ${records.size})`);
  console.log(`output: ${OUT}`);
  console.log(`state: ${STATE}`);
}

(async () => {
  if (COMMAND === "discover") {
    await discover();
  } else if (COMMAND === "run") {
    await run(Number(process.argv[3]) || Infinity, Number(process.argv[4]) || DEFAULT_MAX_PAGES, Number(process.argv[5]) || Infinity);
  } else if (COMMAND === "sample") {
    ensureEvents([process.env.BJ_EVENT_SLUGS || "las-vegas-2022"]);
    save();
    await run(1, 1, 5);
  } else if (COMMAND === "auto") {
    await discover();
    await run(Infinity, DEFAULT_MAX_PAGES, Infinity);
  } else {
    throw new Error("usage: node crawler/barrettjackson.crawler.js [discover|run|sample|auto]");
  }
})().catch((error) => {
  releaseLock();
  console.error(error);
  process.exitCode = 1;
});
