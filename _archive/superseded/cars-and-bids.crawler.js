// Real, working Cars & Bids crawler. Confirmed against live selectors (crawler/probe-selectors.js):
//   - spec table:  dl.cnb-details-quick-facts > dt/dd pairs
//   - result line: h1/.details-subheading area ("Sold for $X" / reserve badge)
//   - close stats: .stats-meta (Sold to / price / Seller / Ended / Bids / Views / Watching)
//
// MUST run through PlaywrightCrawler, not a plain HTTP fetch — the site sits behind a
// Cloudflare managed challenge that blocks bare fetch() (see samples/raw/cars-and-bids-1.html,
// captured by a plain Node fetch, vs. crawler/probe-cloudflare.js which got through headless).
//
// Usage: node crawler/cars-and-bids.crawler.js [maxListings]

const fs = require("fs");
const path = require("path");
const { PlaywrightCrawler, Dataset } = require("crawlee");
const { adaptCarsAndBids } = require("../adapters/cars-and-bids");
const { runHealthCheck } = require("../validation/health-check");

const maxListings = Number(process.argv[2]) || 5;
const OUT_DIR = path.join(__dirname, "..", "samples", "scraped");
fs.mkdirSync(OUT_DIR, { recursive: true });

function parseStatsMeta(text) {
  // "Sold to cirrad $170,000 Seller P1Automotive Ended Aug 14, 2026 1:03 AM Bids 23 Views 17,774 Watching 1,417"
  const soldTo = text.match(/Sold\s*to\s*([A-Za-z0-9_\-.]+)/i);
  const bidTo = text.match(/Bid\s*to\s*\$?([\d,]+)/i);
  const price = text.match(/\$([\d,]+)/);
  const seller = text.match(/Seller\s*([A-Za-z0-9_\-. ]+?)(?=Ended|$)/i);
  const ended = text.match(/Ended\s*([A-Za-z]+ \d{1,2}, \d{4} \d{1,2}:\d{2} [AP]M)/i);
  const bids = text.match(/Bids\s*(\d+)/i);
  const views = text.match(/Views\s*([\d,]+)/i);
  const watching = text.match(/Watching\s*([\d,]+)/i);
  const reserveNotMet = /reserve not met/i.test(text) || (!soldTo && !!bidTo);

  return {
    result_line: soldTo ? `Sold for $${(price || [])[1] || ""}` : bidTo ? `Bid to $${bidTo[1]}, Reserve Not Met` : "UNKNOWN",
    closed_auction_stats: {
      sold_to: soldTo ? soldTo[1] : null,
      price: price ? `$${price[1]}` : null,
      seller: seller ? seller[1].trim() : null,
      ended: ended ? ended[1] : null,
      bids: bids ? Number(bids[1]) : null,
      views: views ? Number(views[1].replace(/,/g, "")) : null,
      watching: watching ? Number(watching[1].replace(/,/g, "")) : null,
    },
    reserve_not_met: reserveNotMet,
  };
}

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: maxListings + 1, // +1 for the results list page itself
  requestHandlerTimeoutSecs: 45,
  async requestHandler({ page, request, log, enqueueLinks }) {
    if (request.label === "DETAIL") {
      // Plain wait, not waitForSelector — matches what actually worked in probe-selectors.js.
      // The dl.cnb-details-quick-facts selector wait was timing out silently (swallowed by
      // .catch) and leaving specTable empty on every page; root cause not fully isolated,
      // but the fixed wait reproduces the probe's success reliably.
      await page.waitForTimeout(4000);

      const title = await page.locator("h1").first().textContent().catch(() => null);

      const specTable = await page.evaluate(() => {
        // cnb-details-quick-facts is the WRAPPING element's class, not the <dl>'s own class.
        const dl = document.querySelector(".cnb-details-quick-facts dl, .cnb-details-quick-facts");
        if (!dl) return {};
        const out = {};
        const dts = Array.from(dl.querySelectorAll("dt"));
        for (const dt of dts) {
          const dd = dt.nextElementSibling;
          if (dd && dd.tagName === "DD") out[dt.textContent.trim()] = dd.textContent.trim();
        }
        return out;
      });
      if (Object.keys(specTable).length === 0) {
        log.warning(`Empty spec table for ${request.url} — selector may not have matched on this page.`);
      }

      const statsMetaText = await page.evaluate(() => {
        const el = document.querySelector(".stats-meta");
        return el ? el.textContent.replace(/\s+/g, " ").trim() : "";
      });
      const parsed = parseStatsMeta(statsMetaText);

      const raw = {
        title: title ? title.trim() : null,
        result_line: parsed.result_line,
        spec_table: specTable,
        closed_auction_stats: parsed.closed_auction_stats,
        equipment_list: [],
        known_flaws: [],
        modifications_list: [],
      };

      const normalized = adaptCarsAndBids(raw, request.url);
      normalized.reserve_not_met = parsed.reserve_not_met;

      log.info(`Scraped: ${normalized.title} — $${normalized.price} (VIN ${normalized.vin_raw})`);
      await Dataset.pushData(normalized);
      return;
    }

    // Results-list page: enqueue individual auction detail links.
    // This is a client-side-rendered SPA — links aren't in the DOM until after hydration,
    // so wait for at least one to appear before asking enqueueLinks to look for them.
    await page.waitForSelector("a[href^='/auctions/']", { timeout: 15000 });

    // Paginate before enqueueing. The past-auctions page lazy-loads more results as you
    // scroll / click through; without this the crawler only ever sees the first screenful.
    for (let i = 0; i < 25; i++) {
      const before = await page.evaluate(() => document.querySelectorAll("a[href^='/auctions/']").length);
      if (before >= maxListings * 1.4) break;
      const advanced = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll("a,button")).find((e) =>
          /^(show more|load more|next)/i.test((e.textContent || "").trim()));
        if (btn) { btn.scrollIntoView(); btn.click(); return true; }
        window.scrollTo(0, document.body.scrollHeight);
        return false;
      });
      await page.waitForTimeout(advanced ? 2200 : 1400);
      const after = await page.evaluate(() => document.querySelectorAll("a[href^='/auctions/']").length);
      if (after === before && !advanced) break;
    }
    log.info(`links visible after pagination: ${await page.evaluate(() => document.querySelectorAll("a[href^='/auctions/']").length)}`);

    const result = await enqueueLinks({
      selector: "a[href^='/auctions/']",
      label: "DETAIL",
      limit: maxListings,
    });
    log.info(`Enqueued ${result?.enqueuedRequests?.length ?? 0} auction detail links from results list.`);
  },
});

(async () => {
  await crawler.run([{ url: "https://carsandbids.com/past-auctions", label: "LIST" }]);
  const dataset = await Dataset.open();
  const { items } = await dataset.getData();
  const outFile = path.join(OUT_DIR, "cars-and-bids.json");
  fs.writeFileSync(outFile, JSON.stringify(items, null, 2));
  console.log(`\nWrote ${items.length} normalized sale records to ${outFile}`);

  if (items.length > 0) {
    const report = runHealthCheck("cab", items);
    if (report.overallStatus === "NEEDS_REVIEW") {
      console.error(`cars-and-bids scrape flagged NEEDS_REVIEW — do not feed this batch into the nightly compute job untouched.`);
      process.exitCode = 1;
    }
  }
})();
