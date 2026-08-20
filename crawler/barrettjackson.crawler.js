// BARRETT-JACKSON HARVESTER — per auction event, docket-driven.
//
// ── PERMISSION ─────────────────────────────────────────────────────────────────────────
// robots.txt is not fetchable anonymously (403). The operator states they hold permission
// from Barrett-Jackson (same path as the Mecum grant). If that permission lapses, stop
// running this crawler — the standing data stays, collection stops. Keep the grant on file
// with the same care as the Mecum one.
//
// ── ROUTE ──────────────────────────────────────────────────────────────────────────────
// The site is a Next.js SPA. Measured via a reader proxy on 2026-08-19:
//
//   results index   /results?type=Vehicles            client-rendered, EMPTY without JS
//   docket          /{event}/docket                   lot cards, client-rendered
//   lot detail      /{event}/docket/vehicle/{slug}-{lotId}
//   automobilia     /{event}/docket/automobilia/{slug}-{lotId}
//   events          /2026-las-vegas/, /2027-scottsdale/  (year-name slugs)
//
// ⚠️ FIRST-RUN VERIFICATION NEEDED: the results/docket pages render their lot cards via JS,
// so the card walk uses Playwright (same as Mecum). The structural selector below — an
// <article> (or nearest container) holding an <a href*="/docket/vehicle/"] link plus a price
// badge — follows the Mecum policy of never selecting on CSS-module hashes. Confirm it on
// the first live run and adjust; the shape is written to be adjusted in one place.
//
// ── SITEMAP DISCOVERY ──────────────────────────────────────────────────────────────────
// https://www.barrett-jackson.com/sitemap.xml — expected to list event docket pages, same
// pattern as Mecum's auction-sitemap. Event slugs observed so far: 2026-las-vegas,
// 2027-scottsdale, plus past events reachable from /results filters. Discovery fetches the
// sitemap with plain HTTP (sitemaps are usually server-rendered even on SPA sites — verify).
//
// ── DATE ───────────────────────────────────────────────────────────────────────────────
// Lot cards carry no date; the event does. Event dates resolve from the event landing page
// (e.g. "September 10-12, 2026"). Same policy as Mecum/RM/Gooding: last day of the range.
//
// ── AUTOMOBILIA ────────────────────────────────────────────────────────────────────────
// Dockets mix collector cars and automobilia inline (signs, gas pumps, kiddie rides —
// visible in the current Las Vegas docket). Vehicle lots carry /docket/vehicle/ paths and
// automobilia /docket/automobilia/, so the split is usually free from the URL. The Mecum
// title gate is reused as a second line of defense for anything miscategorized.
//
// Usage:
//   node crawler/barrettjackson.crawler.js discover     # sitemap -> state (no harvesting)
//   node crawler/barrettjackson.crawler.js run [maxEvents]
//   node crawler/barrettjackson.crawler.js auto         # discover + run 3

"use strict";

const fs = require("fs");
const path = require("path");
const { PlaywrightCrawler, ProxyConfiguration } = require("crawlee");
const { adaptLot } = require("./barrettjackson-adapt");

const OUT = path.join(__dirname, "..", "samples", "scraped", "barrettjackson.json");
const STATE = path.join(__dirname, "..", "samples", "barrettjackson.state.json");
const LOCK = path.join(__dirname, "..", "data", "barrettjackson-crawler.lock");

const MAX_PAGES_PER_EVENT = 400;
const MAX_ATTEMPTS = 3;
const CONCURRENCY = 1;
const BLOCKED_RESOURCES = new Set(["image", "media", "font", "stylesheet"]);
const SETTLE_MS = Number(process.env.BJ_SETTLE_MS) || 2500;

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml",
  "Accept-Language": "en-US,en;q=0.9",
};
const DELAY_MS = Number(process.env.DELAY_MS) || 1500;

const SITEMAP = "https://www.barrett-jackson.com/sitemap.xml";

// Event slugs are {year}-{name}: 2026-las-vegas, 2027-scottsdale, etc. Automobilia docket
// paths are excluded at the event level; individual automobilia lots inside vehicle dockets
// are filtered by the adapter's title gate.
const EVENT_RE = /barrett-jackson\.com\/(\d{4}-[a-z-]+)\/?/;

const MONTHS = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6,
  august: 7, september: 8, october: 9, november: 10, december: 11 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const load = (p, d) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };

const state = load(STATE, { events: {}, updated: null });
const records = new Map(load(OUT, []).map((r) => [`${r.source}|${r.source_lot_id}`, r]));
const startCount = records.size;

// Atomic write — temp file + rename, same rationale as the Mecum harvester.
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

// ── DISCOVERY: sitemap -> event slugs ──────────────────────────────────────────────────

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

async function discover() {
  console.log(`fetching ${SITEMAP} ...`);
  const r = await fetchText(SITEMAP);
  if (!r.text) {
    console.error(`could not fetch sitemap (http=${r.http}) — see header note about verification`);
    process.exit(1);
  }

  // A sitemap index lists child sitemaps; a plain sitemap lists URLs. Handle both.
  const childSitemaps = [...r.text.matchAll(/<loc>([^<]+\.xml)<\/loc>/g)].map((m) => m[1]);
  let urls = [...r.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  if (childSitemaps.length && childSitemaps[0] !== SITEMAP) {
    console.log(`  sitemap index — following ${childSitemaps.length} children`);
    urls = [];
    for (const cs of childSitemaps) {
      await sleep(DELAY_MS);
      const cr = await fetchText(cs);
      if (cr.text) urls.push(...[...cr.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]));
    }
  }
  console.log(`  ${urls.length} URLs seen`);

  const events = new Set();
  for (const u of urls) {
    const m = u.match(EVENT_RE);
    if (m) events.add(m[1]);
  }
  // Also seed from known docket landing pages the sitemap may not carry.
  for (const slug of ["2026-las-vegas"]) events.add(slug);

  const known = Object.keys(state.events).length;
  let added = 0;
  for (const slug of events) {
    if (!state.events[slug]) {
      state.events[slug] = { status: "todo", attempts: 0, soldAt: null, lots: 0, pages: 0 };
      added++;
    }
  }
  save();
  console.log(`\ndiscovered ${events.size} event slugs (${added} new, ${known} known already)`);
}

// ── DATE RESOLUTION — one date per event ───────────────────────────────────────────────

function resolveEventDate(landingHtml) {
  // Measured form on the landing page: "September 10-12, 2026" (og:description / heading).
  // Last day of the range is the sale's close, same policy as Mecum/RM/Gooding.
  const text = String(landingHtml || "");
  const m = text.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:\s*[-–]\s*(?:\d{1,2},\s*)?)?\s*,?\s*(\d{4})/i)
    || text.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})\s*[-–]\s*(\d{1,2}),?\s*(\d{4})/i);
  if (!m) return null;
  // Normalize the two possible match shapes.
  const month = MONTHS[String(m[1]).toLowerCase()];
  const year = Number(m[m.length - 1]);
  const lastDay = Number(m.length === 5 ? m[3] : m[2]);
  if (month === undefined || !Number.isFinite(year) || !Number.isFinite(lastDay)) return null;
  return new Date(Date.UTC(year, month, lastDay, 23, 0, 0)).toISOString();
}

// ── HARVEST ────────────────────────────────────────────────────────────────────────────

async function run(maxEvents) {
  if (fs.existsSync(LOCK)) {
    const pid = Number(fs.readFileSync(LOCK, "utf8"));
    try { process.kill(pid, 0); console.error(`another instance is running (pid ${pid}) — refusing to start`); process.exit(1); }
    catch { fs.unlinkSync(LOCK); }
  }
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  fs.writeFileSync(LOCK, String(process.pid));

  const todo = Object.entries(state.events)
    .filter(([slug, e]) => e.status !== "complete" && e.status !== "dead" && (e.attempts || 0) < MAX_ATTEMPTS)
    .map(([slug]) => slug);
  console.log(`${records.size} sales on file; ${todo.length} events outstanding\n`);

  let harvested = 0;
  // One fixed proxy endpoint (VPS/VPN), set via CRAWLER_PROXY_URL — deliberately a single
  // URL, NOT a rotation list: the permission arrangement is a stable identifiable IP.
  const proxyConfiguration = process.env.CRAWLER_PROXY_URL
    ? new ProxyConfiguration({ proxyUrls: [process.env.CRAWLER_PROXY_URL] })
    : undefined;

  const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency: CONCURRENCY,
    maxRequestRetries: 2,
    requestHandlerTimeoutSecs: 90,
    async requestHandler({ page, request, enqueueLinks }) {
      // Block heavy assets by resource TYPE via route interception — the Mecum crawler's
      // measured pattern (blockRequests() with urlPatterns is for URL globs, not types).
      await page.route("**/*", (route) => {
        const t = route.request().resourceType();
        return BLOCKED_RESOURCES.has(t) ? route.abort() : route.continue();
      });

      const slug = request.userData.eventSlug;
      const ev = state.events[slug];
      const pageNo = request.userData.page || 1;

      await page.waitForTimeout(SETTLE_MS);

      // Resolve the event date once, from the rendered page itself (covers both the landing
      // page route and paginated docket routes).
      if (!ev.soldAt) {
        const body = await page.content();
        const d = resolveEventDate(body);
        if (d) { ev.soldAt = d; console.log(`  event date resolved: ${d}`); }
      }

      // Structural card selection: links into /docket/vehicle/ within article-ish containers.
      const cards = await page.$$eval("article a[href*='/docket/vehicle/'], li a[href*='/docket/vehicle/'], div[class*='card'] a[href*='/docket/vehicle/']", (els) =>
        els.map((a) => ({
          href: a.getAttribute("href"),
          cardText: (a.closest("article, li, div") || a.parentElement)?.innerText || "",
        }))
      );

      let addedThisPage = 0;
      for (const card of cards) {
        const out = adaptLot(card, ev.soldAt, { event: slug });
        if (out.kind !== "sale") continue;
        const key = `${out.record.source}|${out.record.source_lot_id}`;
        if (!records.has(key)) { records.set(key, out.record); addedThisPage++; }
      }
      ev.lots += addedThisPage;
      harvested += addedThisPage;

      const uniqueHrefs = [...new Set(cards.map((c) => c.href))];
      console.log(`  ${slug} p${pageNo}: ${uniqueHrefs.length} cards, ${addedThisPage} new sales`);

      // Pagination: BJ docket pages use ?page=N or an infinite "Load More" button. Try the
      // Load More button first; if absent, try the next ?page=.
      // ⚠️ FIRST-RUN VERIFICATION: which mechanism this site uses. The button-text selector
      // is deliberately loose ("load more", case-insensitive) and must be confirmed.
      let more = false;
      try {
        const btn = await page.$("button:has-text('Load More'), button:has-text('load more'), [role='button']:has-text('Load More')");
        if (btn) { await btn.click(); await page.waitForTimeout(SETTLE_MS); more = true; }
      } catch { /* fall through to ?page= */ }

      if (!more && uniqueHrefs.length > 0 && pageNo < MAX_PAGES_PER_EVENT) {
        await enqueueLinks({
          globs: ["https://www.barrett-jackson.com/**"],
          request: { userData: { eventSlug: slug, page: pageNo + 1 } },
          transformRequestFunction: (req) => {
            req.url = `https://www.barrett-jackson.com/${slug}/docket?page=${pageNo + 1}`;
            return req;
          },
        });
        ev.pages = pageNo + 1;
      } else if (uniqueHrefs.length === 0 || pageNo >= MAX_PAGES_PER_EVENT || !more) {
        // Terminal condition: no more content, or cap hit.
        ev.status = uniqueHrefs.length === 0 && pageNo > 1 ? "complete" : (pageNo >= MAX_PAGES_PER_EVENT ? "partial" : ev.status);
      }
      save();
    },
    failedRequestHandler({ request }) {
      const slug = request.userData.eventSlug;
      console.error(`  FAILED ${request.url} (event ${slug})`);
    },
  });

  // Seed: for each todo event, start at the docket landing page.
  const seeds = todo.slice(0, maxEvents).map((slug) => ({
    url: `https://www.barrett-jackson.com/${slug}/docket?type=Vehicles`,
    userData: { eventSlug: slug, page: 1 },
  }));

  if (seeds.length) {
    await crawler.run(seeds);
  }

  // Mark events: those that yielded nothing this round get an attempt bump; dead after MAX.
  for (const slug of todo.slice(0, maxEvents)) {
    const ev = state.events[slug];
    if (ev.lots === 0) {
      ev.attempts = (ev.attempts || 0) + 1;
      if (ev.attempts >= MAX_ATTEMPTS) { ev.status = "dead"; console.log(`  ${slug}: no yield after ${MAX_ATTEMPTS} attempts — marked dead`); }
    } else if (ev.status !== "complete" && ev.status !== "partial") {
      ev.status = "complete";
    }
  }
  save();

  if (fs.existsSync(LOCK)) fs.unlinkSync(LOCK);

  console.log(`\nharvest: +${harvested} sales (${startCount} -> ${records.size})`);
  console.log(`state: ${OUT}`);
  save();
}

// ── ENTRY ──────────────────────────────────────────────────────────────────────────────

const [cmd, arg] = process.argv.slice(2);
if (cmd === "discover") discover().catch((e) => { console.error(e); process.exit(1); });
else if (cmd === "run") run(Number(arg) || 3).catch((e) => { console.error(e); process.exit(1); });
else if (cmd === "auto" || !cmd) {
  (async () => { await discover(); await run(3); })().catch((e) => { console.error(e); process.exit(1); });
}
else { console.error("usage: node crawler/barrettjackson.crawler.js [discover|run|auto] [maxEvents]"); process.exit(1); }
