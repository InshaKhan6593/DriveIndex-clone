// Real, working Mecum crawler. Confirmed against live selectors (crawler/probe-mecum*.js).
// Reachable via plain headless Playwright, no bot-challenge observed.
//
// Sold-lots entry point: /auctions/{slug}/lots/?saleResult[0]=sold — confirmed by clicking
// the "Sold" filter in-browser and reading the resulting URL, not guessed.
//
// Usage: node crawler/mecum.crawler.js [auctionSlug] [maxLots]

const fs = require("fs");
const path = require("path");
const { PlaywrightCrawler, Dataset } = require("crawlee");
const { adaptMecum } = require("../adapters/mecum");
const { runHealthCheck } = require("../validation/health-check");

const auctionSlug = process.argv[2] || "monterey-2026";
const maxLots = Number(process.argv[3]) || 5;
const OUT_DIR = path.join(__dirname, "..", "samples", "scraped");
fs.mkdirSync(OUT_DIR, { recursive: true });

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: maxLots + 1,
  requestHandlerTimeoutSecs: 45,
  async requestHandler({ page, request, log, enqueueLinks }) {
    if (request.label === "DETAIL") {
      await page.waitForTimeout(5000);
      const title = await page.locator("h1").first().textContent().catch(() => null);
      const bodyText = await page.evaluate(() => document.body.innerText);
      const lotIdMatch = request.url.match(/\/lots\/(\d+)\//);

      const normalized = adaptMecum({ title: title ? title.trim() : null, bodyText, lotId: lotIdMatch ? lotIdMatch[1] : null }, request.url);
      log.info(`Scraped: ${normalized.title} — $${normalized.price} (VIN ${normalized.vin_raw}, ${normalized.mileage ?? "?"} mi) reserve_not_met=${normalized.reserve_not_met}`);
      await Dataset.pushData(normalized);
      return;
    }

    // Results-list page: click the "Sold" filter, then enqueue individual lot links.
    await page.waitForTimeout(3000);
    await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll("*")).find((e) => e.children.length === 0 && e.textContent.trim() === "Sold");
      if (el) el.click();
    });
    await page.waitForTimeout(4000);

    // Paginate the sold-lot list before enqueueing — Mecum shows 24 per page by default,
    // so without this the crawler can never see more than the first page of an auction that
    // runs to hundreds of lots.
    for (let i = 0; i < 25; i++) {
      const before = await page.evaluate(() => document.querySelectorAll("a[href*='/lots/']").length);
      if (before >= maxLots * 1.4) break;
      const advanced = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll("a,button")).find((e) =>
          /^(show more|load more|next|view more)/i.test((e.textContent || "").trim()));
        if (btn) { btn.scrollIntoView(); btn.click(); return true; }
        window.scrollTo(0, document.body.scrollHeight);
        return false;
      });
      await page.waitForTimeout(advanced ? 2400 : 1500);
      const after = await page.evaluate(() => document.querySelectorAll("a[href*='/lots/']").length);
      if (after === before && !advanced) break;
    }
    log.info(`lot links visible after pagination: ${await page.evaluate(() => document.querySelectorAll("a[href*='/lots/']").length)}`);

    const result = await enqueueLinks({
      selector: "a[href*='/lots/']",
      label: "DETAIL",
      limit: maxLots,
      // exclude nav/footer links to other auctions' /lots/ index pages — only real lot
      // detail links match /lots/{numericId}/
      transformRequestFunction: (req) => (/\/lots\/\d+\//.test(req.url) ? req : false),
    });
    log.info(`Enqueued ${result?.enqueuedRequests?.length ?? 0} sold-lot links.`);
  },
});

(async () => {
  await crawler.run([{ url: `https://www.mecum.com/auctions/${auctionSlug}/lots/`, label: "LIST" }]);
  const dataset = await Dataset.open();
  const { items } = await dataset.getData();
  const outFile = path.join(OUT_DIR, "mecum.json");
  fs.writeFileSync(outFile, JSON.stringify(items, null, 2));
  console.log(`\nWrote ${items.length} normalized sale records to ${outFile}`);

  if (items.length > 0) {
    const report = runHealthCheck("mecum", items);
    if (report.overallStatus === "NEEDS_REVIEW") {
      console.error(`mecum scrape flagged NEEDS_REVIEW — do not feed this batch into the nightly compute job untouched.`);
      process.exitCode = 1;
    }
  }
})();
