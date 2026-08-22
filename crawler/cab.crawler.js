// CARS & BIDS HARVESTER — read the site's own API responses rather than forging calls.
//
// ── WHY THIS SHAPE ─────────────────────────────────────────────────────────────────────
// Their API reports 40,344 closed auctions; we held 42. Two routes were tested and rejected:
//
//   1. plain fetch  -> Cloudflare "Just a moment..." interstitial on every parameter shape.
//   2. fetch from INSIDE a warmed Playwright page (Cloudflare satisfied)
//      -> HTTP 400 {"error_code":3,"message":"Invalid parameters|No Access token cookie"}
//
// So the endpoint needs both a request signature and an access-token cookie that the site's own
// JavaScript mints. Rather than reverse-engineer the signing, we drive the page the way a
// visitor does and READ the responses it issues. Slower per record than BaT's open endpoint,
// but it is the site serving its normal payload to a normal session.
//
// ── CRON BEHAVIOUR ─────────────────────────────────────────────────────────────────────
// Same contract as the other harvesters:
//   * idempotent  — records keyed on (source, source_lot_id), merged into a Map
//   * incremental — stops early once it has seen STOP_AFTER_KNOWN consecutive already-known
//                   auctions, so a nightly run costs a few page-downs rather than a full walk
//   * resumable   — checkpoints after every batch; a kill mid-run loses nothing
//
// Usage:
//   node crawler/cab.crawler.js            # incremental (for cron)
//   node crawler/cab.crawler.js --full     # keep paging even through known records
//   node crawler/cab.crawler.js --full 400 # ...with a page-down budget

"use strict";

const fs = require("fs");
const path = require("path");
const { PlaywrightCrawler } = require("crawlee");
const { adaptAuction } = require("./cab-adapt");

const OUT = path.join(__dirname, "..", "samples", "scraped", "cars-and-bids.json");
const FULL = process.argv.includes("--full") || process.env.SCRAPE_MODE === "full" || process.env.SCRAPE_MODE === "backfill";
const RECENT_DAYS = Number(process.env.SCRAPE_RECENT_DAYS) || 45;
const MAX_SCROLLS = Number(process.argv.find((a) => /^\d+$/.test(a))) || (FULL ? 1200 : 60);
const STOP_AFTER_KNOWN = 8; // consecutive all-known batches before an incremental run stops

let existing = [];
try { existing = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch {}
const byKey = new Map(existing.map((r) => [`${r.source}|${r.source_lot_id}`, r]));
const startCount = byKey.size;

const seenAuctionIds = new Set();
let batches = 0, knownStreak = 0, skipped = 0, adaptFailures = 0;

function absorb(payload) {
  const list = (payload && payload.auctions) || [];
  if (!list.length) return 0;
  batches++;
  let added = 0;
  for (const a of list) {
    if (!a || !a.id) continue;
    if (seenAuctionIds.has(a.id)) continue;
    seenAuctionIds.add(a.id);

    const out = adaptAuction(a);
    if (out.kind !== "sale") { skipped++; if (out.kind === "error") adaptFailures++; continue; }
    if (!FULL && (Date.now() - Date.parse(out.record.sold_at)) / 86400000 > RECENT_DAYS) continue;
    const k = `${out.record.source}|${out.record.source_lot_id}`;
    if (!byKey.has(k)) added++;
    byKey.set(k, out.record);
  }
  knownStreak = added === 0 ? knownStreak + 1 : 0;
  return added;
}

const save = () => fs.writeFileSync(OUT, JSON.stringify([...byKey.values()], null, 1));

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: 1,
  requestHandlerTimeoutSecs: 3600,
  navigationTimeoutSecs: 180,
  preNavigationHooks: [
    async ({ page }) => {
      page.on("response", async (res) => {
        if (!/\/v2\/autos\/auctions/.test(res.url())) return;
        if (res.status() !== 200) return;
        try { absorb(await res.json()); } catch { /* a partial body is not fatal */ }
      });
    },
  ],
  async requestHandler({ page, log }) {
    await page.waitForTimeout(9000); // Cloudflare challenge settles
    log.info(`resuming with ${startCount} records on file (${FULL ? "FULL" : "incremental"} mode)`);

    // STALL DETECTION MEASURES THE PAGE, NOT THE CORPUS.
    //
    // The first version watched byKey.size — records NEW TO THE CORPUS — and it silently
    // capped every resumed run. The page reloads from the top each time, so the opening scrolls
    // legitimately re-serve auctions already on file; byKey.size stays flat, the counter trips,
    // and the crawler quits before reaching anything unseen. Measured: a --full run after a
    // 7,470-record run added exactly 0.
    //
    // `seenAuctionIds` is per-session, so it grows whenever the FEED yields another auction,
    // whether or not we already had it. That is the real question — is this page still paging?
    let lastSeen = seenAuctionIds.size;
    let stagnant = 0;

    for (let i = 0; i < MAX_SCROLLS; i++) {
      // Their archive is an infinite-scroll list; a "Load More" control appears in some
      // states, so try both rather than assuming one.
      const clicked = await page.evaluate(() => {
        const el = Array.from(document.querySelectorAll("a,button")).find((e) =>
          /^(load more|show more|next)/i.test((e.textContent || "").trim()));
        if (el) { el.scrollIntoView(); el.click(); return true; }
        return false;
      });
      if (!clicked) await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1600);

      if (i % 10 === 0) {
        log.info(`scroll ${String(i).padStart(4)}  records=${byKey.size}  batches=${batches}  skipped=${skipped}`);
        save();
      }

      // Incremental stop: the archive is newest-first, so once several consecutive batches
      // contain nothing new we have reached what we already hold.
      if (!FULL && knownStreak >= STOP_AFTER_KNOWN) {
        log.info(`incremental stop: ${knownStreak} consecutive batches with no new auctions`);
        break;
      }

      if (seenAuctionIds.size === lastSeen) {
        if (++stagnant >= 25) {
          log.info(`feed served no further auctions for 25 scrolls (${seenAuctionIds.size} seen this session) — end of what it paginates`);
          break;
        }
      } else { stagnant = 0; lastSeen = seenAuctionIds.size; }
    }

    save();
  },
});

crawler.run(["https://carsandbids.com/past-auctions/"]).then(() => {
  save();
  const recs = [...byKey.values()];
  const dates = recs.map((r) => String(r.sold_at).slice(0, 10)).sort();
  console.log(`\n${recs.length} records (+${recs.length - startCount} this run)`);
  console.log(`batches absorbed: ${batches}   non-sale rows skipped: ${skipped}   adapter failures: ${adaptFailures}`);
  if (dates.length) console.log(`date range ${dates[0]} -> ${dates[dates.length - 1]}`);
  console.log(`Wrote ${OUT}`);
});
