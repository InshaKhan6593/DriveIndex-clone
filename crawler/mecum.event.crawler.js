// MECUM HARVESTER — production, per auction event, page-paginated.
//
// ── PERMISSION ─────────────────────────────────────────────────────────────────────────
// robots.txt prose prohibits automated collection "without prior written permission from
// Mecum Auctions". The operator holds that permission (2026-08-18), which is why this
// crawler exists and is scheduled. If that permission lapses, remove the stage from
// jobs/stages.js — the standing data stays, collection stops.
//
// ── ROUTE, established by probing rather than assumed ───────────────────────────────────
// The SEARCH route (/search/?saleResult[0]=sold) is a dead end: it renders no prices, no pager,
// and its links point at auction pages rather than lots. The real archive is per event:
//
//   /auctions/{event}/lots/?page=N        e.g. /auctions/kissimmee-2022/lots/?page=1
//   card   <article> containing an <a href="/lots/{lotId}/{slug}/"> plus a price badge
//
// Lot cards are CLIENT-RENDERED — plain HTTP of the lots page returns zero lot links — so
// the card walk uses Playwright. Everything that IS server-rendered (sitemaps, the event
// landing page) uses plain fetch, which is both faster and politer.
//
// ── DISCOVERY — sitemap plus the rendered recent archive ─────────────────────────────────
// The auction sitemap is the broad historical index, but Mecum's completed 2026 events can
// appear in /past-auctions/ and /results/ before the sitemap catches up. We read those two
// rendered archive pages as well so current-year sales are not silently skipped.
//
// ── SELECTOR POLICY ────────────────────────────────────────────────────────────────────
// Their class names are CSS-module hashed — `CardLot-module__NbNTua__card`, where `NbNTua`
// changes on every deploy. Selecting on those would work today and break silently at their next
// release. So selection is STRUCTURAL: an <article> (or nearest container) holding a link whose
// href matches /lots/{id}/{slug}/. That survives a restyle.
//
// ── DATE — three layers, cheapest first ─────────────────────────────────────────────────
// Lot cards carry no date; only the event does. Mecum previously yielded 0% sold_at and every
// Mecum sale was silently absent from trend maths. One date per event, resolved from:
//   1. the state file (resolved on a previous run)
//   2. the event LANDING page's og:description, server-rendered, one plain fetch — measured
//      form: "…in Dallas, TX on September 4-7, 2024." The LAST day of the range is the sale's
//      close, same policy as RM/Gooding/Broad Arrow.
//   3. the rendered lots page's day filters ("Thursday, January 6") — the original method,
//      kept as fallback because the landing page has no date for some older events.
// The adapter refuses any lot without a date — no hollow rows, ever.
//
// ── HONEST COMPLETENESS ─────────────────────────────────────────────────────────────────
// The old version capped an event at 60 pages and marked it COMPLETE merely for having a
// date. Measured consequence: kissimmee-2024 kept exactly 1400 sales — right at the
// 60 x ~24-card ceiling — so the flagship events were silently truncated. Now an event is
// COMPLETE only when pagination terminated NATURALLY (a page with zero cards); hitting the
// page cap leaves it PARTIAL so the next run resumes it.
//
// Cron-safe on the same contract as the others: idempotent on (source, source_lot_id),
// event-level resume state, completed events skipped, events that yield nothing after
// several attempts are marked dead instead of retried forever.
//
// Usage:
//   node crawler/mecum.event.crawler.js discover     # sitemap + recent archive -> state (no harvesting)
//   node crawler/mecum.event.crawler.js run [maxEvents]
//   node crawler/mecum.event.crawler.js auto         # discover + run 3 (the cron shape)

"use strict";

const fs = require("fs");
const path = require("path");
const { PlaywrightCrawler } = require("crawlee");
const { adaptLot } = require("./mecum-adapt");

const OUT = path.join(__dirname, "..", "samples", "scraped", "mecum.json");
const STATE = path.join(__dirname, "..", "samples", "mecum.state.json");
// A second instance of this crawler is not merely wasteful — both hold their own in-memory
// copy of the records map, so their saves ERASE each other's work (measured: a detached run
// and a foreground run interleaved and one clobbered the other's state). Same guard shape as
// jobs/cron.js: pid in a lock file, stale if the pid is gone.
const LOCK = path.join(__dirname, "..", "data", "mecum-crawler.lock");

// A page holds ~24 cards; the biggest events (Kissimmee, ~4000 run lots incl. unsold) need
// ~200 pages. 400 leaves margin, and hitting it marks PARTIAL rather than COMPLETE.
const MAX_PAGES_PER_EVENT = 400;
// Give up on an event after this many attempts that produced neither cards nor a date —
// protects against a permanently-dead slug being retried every run forever.
const MAX_ATTEMPTS = 3;

// CONCURRENCY CANNOT HELP HERE, and the setting is kept at 1 to say so.
//
// Raising it to 3 was tried and measured: Crawlee reported {"currentConcurrency":1,
// "desiredConcurrency":3} for the entire run. Pagination is a CHAIN — page N+1 is only enqueued
// after page N has been read, because that is how the end of an event is detected — so the queue
// never holds more than one request and there is nothing to run in parallel. Parallelism here
// would mean walking several EVENTS at once, which is a different structure (one crawler
// instance each) and a different politeness question.
const CONCURRENCY = Number(process.env.MECUM_CONCURRENCY) || 1;

// Assets we never read. Aborting them cuts page weight to the HTML + the XHR that fills the cards.
const BLOCKED_RESOURCES = new Set(["image", "media", "font", "stylesheet"]);

// Time given to client-side rendering before the cards are read. 4.5s was chosen when every
// image was also loading; with those blocked the cards settle sooner. This IS where the saving
// came from — measured 5.7s -> 5.04s per page, i.e. the asset blocking and the shorter settle,
// not the concurrency above.
const SETTLE_MS = Number(process.env.MECUM_SETTLE_MS) || 2500;

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml",
  "Accept-Language": "en-US,en;q=0.9",
};
// robots.txt: Crawl-delay: 1. We hold ourselves above the floor for the plain fetches; the
// browser walk is far slower than this per page already.
const DELAY_MS = Number(process.env.DELAY_MS) || 1500;
const RECENT_MODE = process.env.SCRAPE_MODE !== "full";
const RECENT_DAYS = Number(process.env.SCRAPE_RECENT_DAYS) || 45;
const CURRENT_YEAR = Number(process.env.MECUM_CURRENT_YEAR) || new Date().getUTCFullYear();
const RECENT_YEAR_RE = new RegExp(`\\b(?:${CURRENT_YEAR}|${CURRENT_YEAR - 1})\\b`);
const CURRENT_YEAR_RE = new RegExp(`\\b${CURRENT_YEAR}\\b`);

const SITEMAPS = [1, 2, 3].map((i) => `https://www.mecum.com/sitemaps/auction-sitemap${i}.xml`);
const RECENT_ARCHIVE_PAGES = [
  "https://www.mecum.com/past-auctions/",
  "https://www.mecum.com/results/",
];

// Non-car SALES, excluded at the event level for the same reason BaT's ten non-car categories
// are: this is a collector-CAR index, and admitting them floods review one lot at a time.
// Taxonomy-level exclusion only — anything merely ambiguous (named collections, one-off
// venue slugs) is left to the resolver's gates, which is where that judgement belongs.
// Note "motorocycle" is not a typo here: indy-motorocycle-2015 is Mecum's own misspelling.
const NON_CAR_EVENT = /motorcycle|motorocycle|-moto\b|moto-|tractor|gone-farmin|road-?art|toy-auction|sign-collection/i;

const MONTHS = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6,
  august: 7, september: 8, october: 9, november: 10, december: 11 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const load = (p, d) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };

const state = load(STATE, { events: {}, updated: null });
const records = new Map(load(OUT, []).map((r) => [`${r.source}|${r.source_lot_id}`, r]));
const startCount = records.size;

// Atomic write: temp file + rename. A plain writeFileSync can be observed half-written (or,
// if the process is killed mid-save, left that way) — measured: a 25-min-timeout kill saved
// the records file but not the state file, orphaning 548 already-harvested sales from the
// resume map. rename() on the same volume is atomic, so a save either lands or doesn't.
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
  const res = await fetch(url, { headers: HEADERS, redirect: "follow", signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

// Mecum's recent archive is client-rendered. Keep this discovery walk deliberately small:
// it only collects event links from two index pages, and the normal event crawler does the
// expensive lot pagination afterwards.
async function discoverRecentArchiveSlugs() {
  const found = new Set();
  const crawler = new PlaywrightCrawler({
    maxRequestsPerCrawl: RECENT_ARCHIVE_PAGES.length,
    maxConcurrency: 1,
    maxRequestRetries: 1,
    requestHandlerTimeoutSecs: 120,
    navigationTimeoutSecs: 90,
    async requestHandler({ page }) {
      await page.waitForTimeout(SETTLE_MS);
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(1000);
      }
      const slugs = await page.evaluate(() => Array.from(document.querySelectorAll('a[href*="/auctions/"]'))
        .map((a) => (a.getAttribute("href") || "")
          .match(/\/auctions\/([a-z0-9-]+)\/?(?:[?#].*)?$/i)?.[1]?.toLowerCase())
        .filter(Boolean));
      for (const slug of slugs) {
        if (RECENT_YEAR_RE.test(slug) && !NON_CAR_EVENT.test(slug)) found.add(slug);
      }
    },
  });

  try {
    await crawler.run(RECENT_ARCHIVE_PAGES);
  } catch (error) {
    console.warn(`recent Mecum archive discovery unavailable (${error.message}); continuing with sitemap`);
  }
  return found;
}

async function discover() {
  const slugs = new Set();
  for (const sm of SITEMAPS) {
    const xml = await fetchText(sm);
    for (const m of xml.matchAll(/<loc>[^<]*\/auctions\/([a-z0-9-]+)\/?<\/loc>/gi)) slugs.add(m[1].toLowerCase());
    await sleep(DELAY_MS);
  }
  const recentArchiveSlugs = await discoverRecentArchiveSlugs();
  const discovered = new Set([...slugs, ...recentArchiveSlugs]);

  let added = 0;
  const known = new Set(Object.keys(state.events));
  for (const s of discovered) {
    if (NON_CAR_EVENT.test(s)) continue;
    if (known.has(s)) continue;
    state.events[s] = { complete: false, date: null, lots: 0, attempts: 0 };
    added++;
  }

  // Slugs in state that neither discovery index lists were guesses from the pre-sitemap era
  // (measured: indy-2022 and indy-2023 never existed — those years are "indianapolis-YYYY").
  // Mark them dead rather than deleting, so the history of the attempt is kept.
  //
  // ABSENCE FROM THE SITEMAP IS NOT PROOF THE EVENT DOES NOT EXIST. A slug that has already
  // returned lots demonstrably resolves, whatever the discovery indexes say — monterey-2025 was retired
  // this way while holding 436 real lots, and because `dead` is filtered out of `todo`
  // permanently those lots would never have refreshed and the event would never have resumed.
  // A guess that never produced anything is still safe to retire.
  let dead = 0, keptAlive = 0;
  for (const s of Object.keys(state.events)) {
    const m = state.events[s];
    if (discovered.has(s)) {
      if (m.dead) delete m.dead;
      continue;
    }
    if (m.dead) continue;
    if ((m.lots || 0) > 0) { keptAlive++; continue; } // it works; the sitemap is just incomplete
    m.dead = true;
    dead++;
  }
  // Revive anything previously retired despite having produced lots.
  for (const s of Object.keys(state.events)) {
    const m = state.events[s];
    if (m.dead && (m.lots || 0) > 0 && !discovered.has(s)) { delete m.dead; keptAlive++; }
  }

  save();
  console.log(`discovery: ${slugs.size} sitemap events + ${recentArchiveSlugs.size} recent archive events, ${added} newly queued, ${dead} unproductive guesses marked dead` +
              (keptAlive ? `, ${keptAlive} kept alive despite being absent from the discovery indexes (they produced lots)` : "") +
              ` (${Object.keys(state.events).filter((s) => !state.events[s].dead).length} live)`);
  return discovered;
}

// ── DATE resolution ────────────────────────────────────────────────────────────────────

// Landing-page og:description date ranges, measured forms:
//   "on September 4-7, 2024."     -> Sept 7
//   "on January 3-16, 2022."      -> Jan 16
//   "on May 28-June 1, 2024."     -> June 1  (range crossing a month boundary)
//   "on March 26, 2021."          -> Mar 26
// Returns the LAST date in the LAST range found (an event is dated by when it closed).
function dateFromLanding(html) {
  const text = String(html || "");
  const RE = new RegExp(
    `\\b(january|february|march|april|may|june|july|august|september|october|november|december)` +
    `\\s+(\\d{1,2})` +
    `(?:\\s*[-\u2013]\\s*((?:january|february|march|april|may|june|july|august|september|october|november|december)\\s+)?(\\d{1,2}))?` +
    `,?\\s*((?:19|20)\\d{2})`,
    "gi"
  );
  let last = null;
  for (const m of text.matchAll(RE)) {
    const y = Number(m[5]);
    const mo = MONTHS[m[1].toLowerCase()];
    // m[3] carries its trailing space by construction ("June ") — trim before lookup.
    const mo2 = m[3] ? MONTHS[m[3].trim().toLowerCase()] : mo;
    const d = m[4] ? Number(m[4]) : Number(m[2]);
    if (mo == null || mo2 == null) continue;
    const dt = new Date(Date.UTC(y, mo2, d, 12));
    if (!Number.isNaN(dt.getTime()) && (!last || dt > last)) last = dt;
  }
  return last ? last.toISOString() : null;
}

const MONTH_INDEX = MONTHS;

// Fallback: the rendered lots page prints day filters in full ("Thursday, January 6"); the
// year comes from the event slug. Multi-day sale dated by its last day.
function dateFromLotsPage(text, eventSlug) {
  const yearM = String(eventSlug).match(/(20\d{2}|19\d{2})/);
  if (!yearM) return null;
  const year = Number(yearM[1]);
  const days = [...String(text).matchAll(/\b(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day,\s+([A-Z][a-z]+)\s+(\d{1,2})\b/g)];
  const parsed = days
    .map((d) => ({ m: MONTH_INDEX[d[1].toLowerCase()], d: Number(d[2]) }))
    .filter((x) => x.m != null);
  if (!parsed.length) return null;
  const last = parsed[parsed.length - 1];
  return new Date(Date.UTC(year, last.m, last.d, 12)).toISOString();
}

// One plain fetch of /auctions/{event}/ — resolves the event date server-side before any
// browser page is spent on it.
async function resolveEventDate(event) {
  try {
    const html = await fetchText(`https://www.mecum.com/auctions/${event}/`);
    await sleep(DELAY_MS);
    return dateFromLanding(html);
  } catch { return null; }
}

// ── HARVEST ────────────────────────────────────────────────────────────────────────────

// Pull cards structurally — never by hashed class name.
const EXTRACT = () => {
  const seen = new Set();
  const out = [];
  for (const a of Array.from(document.querySelectorAll('a[href*="/lots/"]'))) {
    const href = a.getAttribute("href") || "";
    if (!/\/lots\/[^/]+\/[^/?#]+/.test(href)) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    const card = a.closest("article") || a.closest("li") || a.closest("div");
    out.push({ href, cardText: (card ? card.innerText : a.innerText || "").replace(/\s+/g, " ").trim().slice(0, 300) });
  }
  return { cards: out, bodyText: document.body.innerText.slice(0, 4000) };
};

async function run(maxEvents) {
  console.log(`resuming: ${records.size} records, ${Object.keys(state.events).length} events known\n`);

  const now = Date.now();
  const isRecentEvent = (slug, meta) => {
    if (RECENT_YEAR_RE.test(String(slug))) return true;
    const date = Date.parse(meta.date || "");
    if (!Number.isFinite(date)) return false;
    const age = (now - date) / 86400000;
    return age >= 0 && age <= RECENT_DAYS;
  };
  const eligible = Object.entries(state.events)
    .filter(([, m]) => !m.dead)
    .filter(([slug, m]) => !RECENT_MODE || isRecentEvent(slug, m))
    .filter(([, m]) => !m.complete || (RECENT_MODE && m.complete))
    .filter(([, m]) => m.complete || (m.attempts || 0) < MAX_ATTEMPTS)
    // Skip events we already know are in the future — no results to collect.
    .filter(([, m]) => !m.date || new Date(m.date).getTime() < now);

  // UNVISITED EVENTS FIRST. Selection used to give every current/previous-year event the same
  // rank, so insertion order won: old 2025 events were refreshed before the newly discovered
  // 2026 events appended by archive discovery. A run could therefore spend its entire budget
  // re-walking already harvested sales while the current-year backlog stayed at zero attempts.
  // Within the unvisited work, current-year events come first, then other recent events. A
  // genuinely PARTIAL event follows them, ahead of already-complete refreshes.
  const rank = (slug, m) => {
    const unvisited = !m.harvestedAt;
    const currentYear = CURRENT_YEAR_RE.test(String(slug));
    if (unvisited && currentYear) return 0;      // newly discovered current-year gap
    if (unvisited && RECENT_MODE && isRecentEvent(slug, m)) return 1; // other recent gap
    if (unvisited) return 2;                     // historical gap
    if (m.hitCap || m.lastPage) return 3;        // partial, resumable from a checkpoint
    if (RECENT_MODE && currentYear) return 4;   // refresh current-year results
    if (RECENT_MODE && isRecentEvent(slug, m)) return 5; // refresh late-posted results
    return 6;                                    // already walked to the end
  };
  const todo = eligible.sort((a, b) => rank(a[0], a[1]) - rank(b[0], b[1])).slice(0, maxEvents);

  const fresh = todo.filter(([, m]) => !m.harvestedAt).length;
  console.log(`selected ${todo.length} of ${eligible.length} eligible events (${fresh} never visited)`);
  if (!todo.length) return console.log("nothing outstanding");

  for (const [event, meta] of todo) {
    let added = 0, skipped = 0, pages = 0;
    let eventDate = meta.date;
    let hitCap = false;

    // Layer 2: landing page, before any browser cost is spent on the event.
    if (!eventDate) eventDate = await resolveEventDate(event);
    if (!eventDate) console.log(`  (no date from landing page for ${event}; will try the lots page day filters)`);

    // INTRA-EVENT CHECKPOINT. A big event is 200+ browser pages (~20 min); saving only
    // between events meant a timeout or crash restarted it from page 1 every time — measured:
    // a 25-minute kill left zero records. Pages of a settled historical archive are stable, so
    // resuming from the last checkpointed page is safe. `lastPage` starts at the checkpoint;
    // page 1 is re-walked only when there is no checkpoint, and it is walked anyway for date
    // resolution in that case (the day filters live on page 1).
    const firstPage = meta.lastPage && meta.date ? meta.lastPage : 1;
    // The page cap counts pages walked IN THIS CRAWL, not the absolute page number — a resume
    // from page 401 must be able to walk 400 more, not insta-cap against `pageNo >= 400`
    // (which made a capped event permanently unresumable).
    let walked = 0;

    await new PlaywrightCrawler({
      maxRequestsPerCrawl: MAX_PAGES_PER_EVENT,
      maxConcurrency: CONCURRENCY, maxRequestRetries: 1,
      requestHandlerTimeoutSecs: 120, navigationTimeoutSecs: 90,
      // Only the lot cards are read, so every image, font, stylesheet and tracker on the page is
      // downloaded and thrown away. Measured before this: ~5.7s per page, which put the 137-event
      // backlog at ~32 hours. Blocking them is the single biggest saving available without
      // touching politeness — the request count to Mecum is unchanged, each one is just smaller.
      preNavigationHooks: [async ({ page }) => {
        await page.route("**/*", (route) => {
          const t = route.request().resourceType();
          return BLOCKED_RESOURCES.has(t) ? route.abort() : route.continue();
        });
      }],
      async requestHandler({ page, request, crawler: c }) {
        await page.waitForTimeout(SETTLE_MS);
        const { cards, bodyText } = await page.evaluate(EXTRACT);
        if (!eventDate) eventDate = dateFromLotsPage(bodyText, event);
        pages++;
        walked++;

        for (const card of cards) {
          const out = adaptLot(card, eventDate, { event, eventName: event });
          if (out.kind === "sale") {
            const k = `${out.record.source}|${out.record.source_lot_id}`;
            if (!records.has(k)) added++;
            records.set(k, out.record);
          } else skipped++;
        }

        // Follow pagination only while cards keep arriving. Stop conditions are a page with
        // no cards (natural end -> COMPLETE) or the page cap (-> PARTIAL, resumed next run).
        const pageNo = Number((request.url.match(/[?&]page=(\d+)/) || [])[1] || 1);
        if (cards.length > 0 && walked < MAX_PAGES_PER_EVENT) {
          await c.addRequests([`https://www.mecum.com/auctions/${event}/lots/?page=${pageNo + 1}`]);
        } else if (cards.length > 0 && walked >= MAX_PAGES_PER_EVENT) {
          hitCap = true;
        }

        // Checkpoint every 10 pages: records so far + the next page to walk. Cheap (two file
        // writes) against the cost of re-walking 100 pages after a kill.
        if (pageNo % 10 === 0) {
          meta.date = eventDate;
          meta.lastPage = pageNo + 1;
          meta.checkpointedAt = new Date().toISOString();
          save();
          console.log(`    ...${event} page ${pageNo} (${records.size} records total)`);
        }
      },
      failedRequestHandler() { /* one bad page must not abort the event */ },
    }).run([`https://www.mecum.com/auctions/${event}/lots/?page=${firstPage}`]);

    meta.attempts = (meta.attempts || 0) + 1;
    meta.date = eventDate;
    meta.lots = [...records.values()].filter((r) => r._extra && r._extra.event === event).length;

    const naturallyEnded = pages > 0 && !hitCap;
    const produced = added > 0 || meta.lots > 0;
    // COMPLETE requires: a resolved date AND natural pagination end AND something kept.
    // A resolved date with zero lots on a live event is "no results yet" (upcoming sale) —
    // left incomplete, and MAX_ATTEMPTS eventually retires it.
    meta.complete = Boolean(eventDate && naturallyEnded && produced);
    meta.hitCap = hitCap || undefined;
    if (meta.complete) { meta.lastPage = undefined; meta.checkpointedAt = undefined; }
    meta.harvestedAt = new Date().toISOString();

    console.log(
      `${meta.complete ? "DONE " : hitCap ? "CAP  " : "PART "} ${event.padEnd(28)} pages=${String(pages).padStart(4)}` +
      ` +${String(added).padStart(4)} sales  skipped=${String(skipped).padStart(4)}  date=${eventDate ? eventDate.slice(0, 10) : "UNRESOLVED"}`
    );
    save();
  }

  const dates = [...records.values()].map((r) => String(r.sold_at).slice(0, 10)).sort();
  console.log(`\n${records.size} records (+${records.size - startCount} this run)`);
  if (dates.length) console.log(`date range ${dates[0]} -> ${dates[dates.length - 1]}`);
}

const mode = process.argv[2] || "run";

// ── single-instance lock, acquired before any harvesting mode ──────────────────────────
function acquireLock() {
  try {
    const l = JSON.parse(fs.readFileSync(LOCK, "utf8"));
    try { process.kill(l.pid, 0); 
      console.error(`REFUSING TO START: another mecum crawler is running (pid ${l.pid}, since ${l.startedAt}).`);
      console.error(`Two instances erase each other's saves. If this is wrong, delete ${LOCK}.`);
      process.exit(3);
    } catch (e) { if (e.code === "EPERM") { console.error(`REFUSING TO START: pid ${l.pid} holds the lock.`); process.exit(3); } }
  } catch { /* no lock, or unreadable — proceed */ }
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 1));
}
const releaseLock = () => { try { fs.unlinkSync(LOCK); } catch {} };
process.on("exit", releaseLock);
process.on("SIGINT", () => { releaseLock(); process.exit(130); });
if (mode === "run" || mode === "auto") acquireLock();

if (mode === "discover") {
  discover().catch((e) => { console.error(e.message); process.exit(1); });
} else if (mode === "auto") {
  discover().then(() => run(3)).catch((e) => { console.error(e.message); process.exit(1); });
} else if (mode === "run") {
  run(Number(process.argv[3]) || 3).catch((e) => { console.error(e.message); process.exit(1); });
} else {
  console.error("usage: node crawler/mecum.event.crawler.js [discover|run|maxEvents|auto]");
  process.exit(2);
}
