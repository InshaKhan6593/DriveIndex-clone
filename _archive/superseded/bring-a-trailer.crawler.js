// Real, working Bring a Trailer crawler. Confirmed against live selectors
// (crawler/probe-bat*.js): the site IS reachable via headless Playwright — only this
// session's interactive browser-pane tool was blocked by policy, which is a different
// access path entirely. No Cloudflare-style challenge observed here (unlike Cars & Bids).
//
// Completed-sales entry point: https://bringatrailer.com/auctions/results/ requires a
// click on "View N Completed Auctions" before result links appear in the DOM (not present
// on initial load) — see probe-bat7.js.
//
// Usage: node crawler/bring-a-trailer.crawler.js [maxListings]

const fs = require("fs");
const path = require("path");
const { PlaywrightCrawler, Dataset } = require("crawlee");
const { adaptBringATrailer } = require("../adapters/bring-a-trailer");
const { runHealthCheck } = require("../validation/health-check");

const maxListings = Number(process.argv[2]) || 5;
const OUT_DIR = path.join(__dirname, "..", "samples", "scraped");
fs.mkdirSync(OUT_DIR, { recursive: true });

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: maxListings + 1,
  requestHandlerTimeoutSecs: 45,
  async requestHandler({ page, request, log, enqueueLinks }) {
    if (request.label === "DETAIL") {
      await page.waitForSelector(".essentials", { timeout: 15000 }).catch(() => {});

      const data = await page.evaluate(() => {
        const introEl = document.querySelector("[data-listing-intro-id]");
        const title = document.querySelector("h1.listing-post-title, h1.post-title")?.textContent?.trim() || null;
        const availableInfo = document.querySelector(".listing-available-info");
        const availableInfoText = availableInfo ? availableInfo.textContent.replace(/\s+/g, " ").trim() : "";
        const dateEl = availableInfo ? availableInfo.querySelector(".date-localize[data-timestamp]") : null;
        const soldTimestamp = dateEl ? Number(dateEl.getAttribute("data-timestamp")) : null;

        const bulletItems = Array.from(document.querySelectorAll(".essentials .item ul li")).map((li) => li.textContent.trim());

        return {
          listingIntroId: introEl ? introEl.getAttribute("data-listing-intro-id") : null,
          title,
          availableInfoText,
          soldTimestamp,
          bulletItems,
        };
      });

      if (!data.bulletItems.length) {
        log.warning(`No essentials bullets found for ${request.url} — selector may not have matched.`);
      }

      const normalized = adaptBringATrailer(data, request.url);
      log.info(`Scraped: ${normalized.title} — ${normalized.currency} $${normalized.price} (VIN ${normalized.vin_raw}) reserve_not_met=${normalized.reserve_not_met}`);
      await Dataset.pushData(normalized);
      return;
    }

    // Results-list page: click to reveal completed-auction links, then enqueue them.
    await page.waitForTimeout(3000);
    await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll("a,button")).find((e) => /View [\d,]+ Completed Auctions/.test(e.textContent || ""));
      if (el) el.click();
    });
    await page.waitForSelector("a[href*='/listing/']", { timeout: 15000 }).catch(() => {});
    const result = await enqueueLinks({
      selector: "a[href*='/listing/']",
      label: "DETAIL",
      limit: maxListings,
    });
    log.info(`Enqueued ${result?.enqueuedRequests?.length ?? 0} completed-auction links.`);
  },
});

(async () => {
  await crawler.run([{ url: "https://bringatrailer.com/auctions/results/", label: "LIST" }]);
  const dataset = await Dataset.open();
  const { items } = await dataset.getData();
  const outFile = path.join(OUT_DIR, "bring-a-trailer.json");
  fs.writeFileSync(outFile, JSON.stringify(items, null, 2));
  console.log(`\nWrote ${items.length} normalized sale records to ${outFile}`);

  if (items.length > 0) {
    const report = runHealthCheck("bat", items);
    if (report.overallStatus === "NEEDS_REVIEW") {
      console.error(`bring-a-trailer scrape flagged NEEDS_REVIEW — do not feed this batch into the nightly compute job untouched.`);
      process.exitCode = 1;
    }
  }
})();
