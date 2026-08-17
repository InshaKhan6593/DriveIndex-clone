// MECUM HARVESTER — per auction event, page-paginated.
//
// ── ROUTE, established by probing rather than assumed ───────────────────────────────────
// The SEARCH route (/search/?saleResult[0]=sold) is a dead end: it renders no prices, no pager,
// and its links point at auction pages rather than lots. The real archive is per event:
//
//   /auctions/{event}/lots/?page=N        e.g. /auctions/kissimmee-2022/lots/?page=1
//   card   <article> containing an <a href="/lots/{lotId}/{slug}/"> plus a price badge
//
// So Mecum partitions by event, the same shape as RM Sotheby's.
//
// ── SELECTOR POLICY ────────────────────────────────────────────────────────────────────
// Their class names are CSS-module hashed — `CardLot-module__NbNTua__card`, where `NbNTua`
// changes on every deploy. Selecting on those would work today and break silently at their next
// release. So selection is STRUCTURAL: an <article> (or nearest container) holding a link whose
// href matches /lots/{id}/{slug}/. That survives a restyle.
//
// ── DATE ───────────────────────────────────────────────────────────────────────────────
// Lot cards carry no date; only the event does. Mecum previously yielded 0% sold_at and every
// Mecum sale was silently absent from trend maths. One date is resolved per EVENT and stamped
// on its lots, and the adapter refuses any lot without one.
//
// Cron-safe on the same contract as the others: idempotent on (source, source_lot_id),
// event-level resume state, completed events skipped.
//
// Usage:
//   node crawler/mecum.event.crawler.js discover
//   node crawler/mecum.event.crawler.js run [maxEvents]

"use strict";

const fs = require("fs");
const path = require("path");
const { PlaywrightCrawler } = require("crawlee");
const { adaptLot } = require("./mecum-adapt");

const OUT = path.join(__dirname, "..", "samples", "scraped", "mecum.json");
const STATE = path.join(__dirname, "..", "samples", "mecum.state.json");
const MAX_PAGES_PER_EVENT = 60; // events run to a few thousand lots; 60 x ~24 covers them

const load = (p, d) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };

const MONTHS = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6,
  august: 7, september: 8, october: 9, november: 10, december: 11 };

// Extract the event's LAST auction day. Their lots page prints the day filters in full
// ("Thursday, January 6"), and the year is in the event slug (kissimmee-2022). A multi-day sale
// is dated by when it closed.
function dateFromPage(text, eventSlug) {
  const yearM = String(eventSlug).match(/(20\d{2}|19\d{2})/);
  if (!yearM) return null;
  const year = Number(yearM[1]);
  const days = [...String(text).matchAll(/\b(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day,\s+([A-Z][a-z]+)\s+(\d{1,2})\b/g)];
  if (!days.length) return null;
  const parsed = days
    .map((d) => ({ m: MONTHS[d[1].toLowerCase()], d: Number(d[2]) }))
    .filter((x) => x.m != null);
  if (!parsed.length) return null;
  const last = parsed[parsed.length - 1];
  return new Date(Date.UTC(year, last.m, last.d, 12)).toISOString();
}

const state = load(STATE, { events: {}, updated: null });
const records = new Map(load(OUT, []).map((r) => [`${r.source}|${r.source_lot_id}`, r]));
const startCount = records.size;

const save = () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify([...records.values()], null, 1));
  state.updated = new Date().toISOString();
  fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
};

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

// DISCOVERY ROUTES, found by probing (crawler/probe-mecum-index.js) rather than guessed.
//
//   /results/        the ARCHIVE — its year filter offers 21 distinct years, so history runs
//                    back roughly two decades. This is the route that matters.
//   /past-auctions/  completed sales, recent
//   /auctions/       UPCOMING only — kept last, and its events are filtered out below because
//                    a sale that has not happened has no results (measured: nashville-2026
//                    yielded 0 sales from 706 cards, correctly).
//
// Guessing slugs was the previous approach and it failed on 5 of 14: the pattern is not
// {city}-{year}. Real events include dallas-2025, glendale-2026, indy-fall-special-2025 and
// las-vegas-motorcycles-2026 — city and year do not line up the way they appear to.
const DISCOVERY_ROUTES = [
  "https://www.mecum.com/results/",
  "https://www.mecum.com/past-auctions/",
  "https://www.mecum.com/auctions/",
];

// Motorcycle-only sales, excluded for the same reason BaT's Motorcycles category is: this is a
// collector-CAR index, and admitting them would flood human review one lot at a time.
const NON_CAR_EVENT = /motorcycle|moto-|-moto\b|lv-motorcycles/i;

async function discover() {
  const events = new Map();
  const crawler = new PlaywrightCrawler({
    maxRequestsPerCrawl: DISCOVERY_ROUTES.length,
    maxConcurrency: 1,
    maxRequestRetries: 1,
    requestHandlerTimeoutSecs: 150,
    navigationTimeoutSecs: 120,
    async requestHandler({ page, request }) {
      await page.waitForTimeout(7000);
      for (let i = 0; i < 4; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(2000);
      }
      const found = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href*="/auctions/"]'))
          .map((a) => (a.getAttribute("href") || "").match(/\/auctions\/([a-z0-9-]+-(?:19|20)\d{2})\/?/i))
          .filter(Boolean).map((m) => m[1]));
      for (const e of found) {
        if (NON_CAR_EVENT.test(e)) continue;
        // First route wins, so an event found on /results/ is recorded as archival rather than
        // upcoming even if /auctions/ also lists it.
        if (!events.has(e)) events.set(e, request.url);
      }
    },
    failedRequestHandler() { /* one dead route must not abort discovery */ },
  });
  await crawler.run(DISCOVERY_ROUTES);
  return events;
}

async function run(maxEvents) {
  console.log(`resuming: ${startCount} records, ${Object.keys(state.events).length} events known\n`);

  // Only discover when asked. /auctions/ lists UPCOMING sales, whose lots have no results yet —
  // harvesting those burns pages for zero records (measured: nashville-2026 gave 0 sales from
  // 706 cards, correctly, because the sale is a month away). Past events are the ones with
  // prices, and they have to be supplied or discovered from a results index.
  if (process.argv.includes("--discover")) {
    const discovered = await discover();
    for (const e of discovered.keys()) if (!state.events[e]) state.events[e] = { complete: false, date: null, lots: 0 };
  }
  console.log(`${Object.keys(state.events).length} events known\n`);

  const now = Date.now();
  const todo = Object.entries(state.events)
    .filter(([, m]) => !m.complete)
    // Skip events we already know are in the future — no results to collect.
    .filter(([, m]) => !m.date || new Date(m.date).getTime() < now)
    .slice(0, maxEvents);
  if (!todo.length) return console.log("nothing outstanding");

  for (const [event, meta] of todo) {
    let added = 0, skipped = 0, pages = 0, eventDate = meta.date;

    const crawler = new PlaywrightCrawler({
      maxRequestsPerCrawl: MAX_PAGES_PER_EVENT,
      maxConcurrency: 1, maxRequestRetries: 1,
      requestHandlerTimeoutSecs: 120, navigationTimeoutSecs: 90,
      async requestHandler({ page, request, crawler: c }) {
        await page.waitForTimeout(4500);
        const { cards, bodyText } = await page.evaluate(EXTRACT);
        if (!eventDate) eventDate = dateFromPage(bodyText, event);
        pages++;

        for (const card of cards) {
          const out = adaptLot(card, eventDate, { event, eventName: event });
          if (out.kind === "sale") {
            const k = `${out.record.source}|${out.record.source_lot_id}`;
            if (!records.has(k)) added++;
            records.set(k, out.record);
          } else skipped++;
        }

        // Follow pagination only while cards keep arriving.
        const pageNo = Number((request.url.match(/[?&]page=(\d+)/) || [])[1] || 1);
        if (cards.length > 0 && pageNo < MAX_PAGES_PER_EVENT) {
          await c.addRequests([`https://www.mecum.com/auctions/${event}/lots/?page=${pageNo + 1}`]);
        }
      },
      failedRequestHandler() { /* one bad page must not abort the event */ },
    });

    await crawler.run([`https://www.mecum.com/auctions/${event}/lots/?page=1`]);

    meta.date = eventDate;
    meta.lots = [...records.values()].filter((r) => r._extra && r._extra.event === event).length;
    // Only COMPLETE when a date was resolved — otherwise every lot was refused and re-running
    // after fixing the date is the whole point.
    meta.complete = Boolean(eventDate);
    meta.harvestedAt = new Date().toISOString();

    console.log(
      `${meta.complete ? "DONE " : "PART "} ${event.padEnd(24)} pages=${String(pages).padStart(3)} ` +
      `+${String(added).padStart(4)} sales  skipped=${String(skipped).padStart(4)}  date=${eventDate ? eventDate.slice(0, 10) : "UNRESOLVED"}`
    );
    save();
  }

  const dates = [...records.values()].map((r) => String(r.sold_at).slice(0, 10)).sort();
  console.log(`\n${records.size} records (+${records.size - startCount} this run)`);
  if (dates.length) console.log(`date range ${dates[0]} -> ${dates[dates.length - 1]}`);
}

const mode = process.argv[2] || "run";
if (mode === "discover") discover().then((e) => { console.log(`${e.size} events:`); for (const k of [...e.keys()].slice(0, 40)) console.log("  " + k); });
else run(Number(process.argv[3]) || 3);
