// HAGERTY MARKETPLACE HARVESTER — listings (asking prices), not sales.
//
// ── PERMISSION ─────────────────────────────────────────────────────────────────────────
// robots.txt is not fetchable anonymously (403). The operator states they hold permission
// from Hagerty. If that permission lapses, stop running this crawler — standing data stays,
// collection stops.
//
// ── WHY A LISTINGS SOURCE ──────────────────────────────────────────────────────────────
// Hagerty Marketplace is dealer/private asking-price inventory — the same class of data as
// DuPont Registry, NOT completed auction results. Per the pipeline's own ground-truth
// defect notes, asks must never mix into sold-price maths: this writes to
// samples/listings/hagerty-listings.json and is ingested by ingest-listings.js, never
// ingest.js.
//
// ── ROUTE ──────────────────────────────────────────────────────────────────────────────
// Marketplace is client-rendered (a reader proxy gets only a tracker pixel on /marketplace —
// the content is JS-only). Two consequences:
//   1. discovery cannot use a plain sitemap fetch until access works from this network;
//      sitemap.xml is tried first anyway (server-rendered on most sites), with a
//      seeded fallback
//   2. detail pages are walked with Playwright, structural selectors, same policy as Mecum
//
// ⚠️ FIRST-RUN VERIFICATION NEEDED — written from the marketplace URL shape, not from a
// live render (blocked here). Detail page selector and JSON-LD presence must be confirmed
// on the first authorized run and adjusted in the two marked places.
//
// Usage:
//   node crawler/hagerty.crawler.js discover
//   node crawler/hagerty.crawler.js run [maxUrls]
//   node crawler/hagerty.crawler.js auto
"use strict";

const fs = require("fs");
const path = require("path");
const { PlaywrightCrawler, ProxyConfiguration } = require("crawlee");

const OUT = path.join(__dirname, "..", "samples", "listings", "hagerty-listings.json");
const STATE = path.join(__dirname, "..", "samples", "hagerty.state.json");
const SITEMAP = "https://www.hagerty.com/sitemap.xml";

const CONCURRENCY = 1;
const BLOCKED_RESOURCES = new Set(["image", "media", "font", "stylesheet"]);
const SETTLE_MS = Number(process.env.HAGERTY_SETTLE_MS) || 2500;
const DELAY_MS = Number(process.env.DELAY_MS) || 1500;

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml",
  "Accept-Language": "en-US,en;q=0.9",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const load = (p, d) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };

const state = load(STATE, { done: {}, discovered: false, updated: null });
const records = new Map(load(OUT, []).map((r) => [`${r.source}|${r.source_lot_id}`, r]));
const startCount = records.size;

const saveAtomic = (p, data) => {
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, p);
};

const save = () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  saveAtomic(OUT, JSON.stringify([...records.values()], null, 1));
  state.updated = new Date().toISOString();
  saveAtomic(STATE, JSON.stringify(state, null, 1));
};

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

// ── DISCOVERY ──────────────────────────────────────────────────────────────────────────
// Try the sitemap first (server-rendered on most sites even when pages are SPA). If the
// sitemap itself is blocked or carries no marketplace URLs, seed the marketplace search
// route into the browser queue instead — the crawler's enqueueLinks will walk listing
// cards from there.
async function discover() {
  console.log(`trying ${SITEMAP} ...`);
  const r = await fetchText(SITEMAP);
  let urls = [];
  if (r.text) {
    const childSitemaps = [...r.text.matchAll(/<loc>([^<]+\.xml)<\/loc>/g)].map((m) => m[1]).filter((u) => u !== SITEMAP);
    let all = [...r.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    if (childSitemaps.length) {
      console.log(`  sitemap index — following ${childSitemaps.length} children`);
      for (const cs of childSitemaps) {
        await sleep(DELAY_MS);
        const cr = await fetchText(cs);
        if (cr.text) all.push(...[...cr.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]));
      }
    }
    // Marketplace vehicle detail URLs. ⚠️ FIRST-RUN VERIFICATION: exact path shape unknown
    // from this network; match generously, filter to detail-like URLs (id-bearing).
    urls = all.filter((u) => /hagerty\.com\/.*(?:marketplace|cars-for-sale|classifieds).*\/[\w-]{6,}/i.test(u) && !state.done[u]);
    console.log(`  ${all.length} total URLs, ${urls.length} marketplace-detail candidates`);
  } else {
    console.log(`  sitemap unavailable (http=${r.http}) — will seed the search route instead`);
  }
  state.sitemapUrls = urls.slice(0, 5000);
  state.discovered = true;
  save();
  console.log(`discovery done: ${urls.length} candidate URLs stored in state`);
}

// ── ADAPT (inline — a listings shape, too small to deserve its own module yet) ─────────

function parsePrice(text) {
  const m = String(text || "").match(/\$\s?([\d][\d,]*)/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// JSON-LD is the primary parse — marketplace detail pages usually carry schema.org
// Vehicle/Offer markup, which is data the page already ships, not an API to guess at
// (same policy as Gooding's Gatsby page-data).
function adaptFromJsonLd(jsonLd, url) {
  const t = jsonLd["@type"] || "";
  if (!/car|vehicle|offer|product/i.test(t)) return { kind: "skip", reason: "json-ld type not a vehicle" };
  const name = jsonLd.name || (jsonLd.itemOffered && jsonLd.itemOffered.name) || null;
  const price = Number(jsonLd.price ?? (jsonLd.offers && (jsonLd.offers.price ?? jsonLd.offers.lowPrice)));
  const id = String(jsonLd.sku || jsonLd.vehicleIdentificationNumber || url).slice(0, 120);
  if (!name) return { kind: "skip", reason: "no title" };
  if (!Number.isFinite(price) || price <= 0) return { kind: "skip", reason: "no price posted" };
  return {
    kind: "listing",
    record: {
      source: "hagerty",
      source_lot_id: id,
      url,
      title: String(name).trim(),
      price,
      currency: String(jsonLd.priceCurrency || "USD").toUpperCase(),
      mileage: null,
      vin_raw: jsonLd.vehicleIdentificationNumber || null,
      color: jsonLd.color || null,
      transmission: jsonLd.vehicleTransmission || null,
      tc: null,
      image_url: jsonLd.image || null,
      is_active: true,
      fetched_at: new Date().toISOString(),
      _extra: {
        seller: (jsonLd.seller && (jsonLd.seller.name || jsonLd.seller["@id"])) || null,
        condition: jsonLd.itemCondition || null,
      },
    },
  };
}

// ── HARVEST ────────────────────────────────────────────────────────────────────────────

async function run(maxUrls) {
  // One fixed proxy endpoint (VPS/VPN) via CRAWLER_PROXY_URL — single URL by design, per
  // the permission arrangement (stable identifiable IP, not rotation).
  const proxyConfiguration = process.env.CRAWLER_PROXY_URL
    ? new ProxyConfiguration({ proxyUrls: [process.env.CRAWLER_PROXY_URL] })
    : undefined;

  const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency: CONCURRENCY,
    maxRequestRetries: 2,
    requestHandlerTimeoutSecs: 90,
    async requestHandler({ page, request, enqueueLinks }) {
      // Same resource-type interception as the Mecum/BJ crawlers.
      await page.route("**/*", (route) => {
        const t = route.request().resourceType();
        return BLOCKED_RESOURCES.has(t) ? route.abort() : route.continue();
      });

      await page.waitForTimeout(SETTLE_MS);

      // ⚠️ FIRST-RUN VERIFICATION: JSON-LD presence on marketplace detail pages. If the
      // pages ship it, this is the whole adapter. If not, fall back to structural card
      // selection and title/price from the rendered DOM.
      let adapted = null;
      try {
        const ld = await page.$eval('script[type="application/ld+json"]', (el) => el.textContent);
        if (ld) {
          const parsed = JSON.parse(ld);
          const arr = Array.isArray(parsed) ? parsed : [parsed, ...((parsed["@graph"]) || [])];
          for (const entry of arr) {
            const out = adaptFromJsonLd(entry, request.url);
            if (out.kind === "listing") { adapted = out; break; }
          }
        }
      } catch { /* no json-ld or unparsable — fall through */ }

      if (!adapted) {
        // Fallback: title from <title>/h1, price from a $-bearing element.
        const title = await page.title().catch(() => null);
        const bodyText = await page.evaluate(() => document.body.innerText).catch(() => "");
        const price = parsePrice(bodyText);
        const h1 = await page.$eval("h1", (el) => el.innerText).catch(() => null);
        if (h1 && price) {
          const idMatch = request.url.match(/([\w-]{8,})\/?$/);
          adapted = {
            kind: "listing",
            record: {
              source: "hagerty",
              source_lot_id: idMatch ? idMatch[1] : request.url.slice(-120),
              url: request.url,
              title: h1.trim(),
              price,
              currency: "USD",
              mileage: null,
              vin_raw: null,
              color: null,
              transmission: null,
              tc: null,
              image_url: null,
              is_active: true,
              fetched_at: new Date().toISOString(),
              _extra: { pageTitle: title },
            },
          };
        }
      }

      if (adapted && adapted.kind === "listing") {
        const key = `${adapted.record.source}|${adapted.record.source_lot_id}`;
        if (!records.has(key)) records.set(key, adapted.record);
      }

      state.done[request.url] = true;

      // Walk listing cards for more detail pages.
      await enqueueLinks({
        globs: ["https://www.hagerty.com/**"],
        transformRequestFunction: (req) => {
          if (!/marketplace|cars-for-sale|classifieds/i.test(req.url)) return false;
          return req;
        },
      });

      save();
      await page.waitForTimeout(DELAY_MS);
    },
    failedRequestHandler({ request }) {
      console.error(`  FAILED ${request.url}`);
      state.done[request.url] = true;
    },
  });

  const seeds = (state.sitemapUrls || []).slice(0, maxUrls).map((u) => ({ url: u }));
  if (!seeds.length) {
    // No sitemap URLs — seed the marketplace entry and let enqueueLinks walk it.
    seeds.push({ url: "https://www.hagerty.com/marketplace/" });
  }

  await crawler.run(seeds.slice(0, Math.max(1, maxUrls)));
  save();
  console.log(`\nharvest: ${startCount} -> ${records.size} listings`);
}

// ── ENTRY ──────────────────────────────────────────────────────────────────────────────

const [cmd, arg] = process.argv.slice(2);
if (cmd === "discover") discover().catch((e) => { console.error(e); process.exit(1); });
else if (cmd === "run") run(Number(arg) || 50).catch((e) => { console.error(e); process.exit(1); });
else if (cmd === "auto" || !cmd) {
  (async () => { await discover(); await run(50); })().catch((e) => { console.error(e); process.exit(1); });
}
else { console.error("usage: node crawler/hagerty.crawler.js [discover|run|auto] [maxUrls]"); process.exit(1); }
