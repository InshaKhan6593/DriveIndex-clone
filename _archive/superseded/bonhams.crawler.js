// Real, working Bonhams crawler. Confirmed against live selectors (crawler/probe-bonhams*.js).
// Reachable via plain headless Playwright, no bot-challenge observed.
//
// Structure note: class names on this site are CSS-in-JS hashes (styled-components,
// e.g. "sc-30a0eb9c-4 iPeZLl bYOzJ") that will change on their next deploy — do NOT select
// on them. Everything here selects on stable TEXT PATTERNS instead ("Sold for", "VIN.",
// "LOT n") which is slower to write but survives a frontend rebuild that a class-name
// selector would not.
//
// Usage: node crawler/bonhams.crawler.js [auctionId] [maxLots]
// Default auction: 31959 = The Laguna Seca Auction, 13 Aug 2026 (confirmed ENDED).

const fs = require("fs");
const path = require("path");
const { PlaywrightCrawler, Dataset } = require("crawlee");
const { adaptBonhams } = require("../adapters/bonhams");
const { runHealthCheck } = require("../validation/health-check");

const auctionId = process.argv[2] || "31959";
const maxLots = Number(process.argv[3]) || 5;
const OUT_DIR = path.join(__dirname, "..", "samples", "scraped");
fs.mkdirSync(OUT_DIR, { recursive: true });

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: maxLots + 1,
  requestHandlerTimeoutSecs: 45,
  async requestHandler({ page, request, log, enqueueLinks }) {
    if (request.label === "DETAIL") {
      await page.waitForTimeout(5000);

      const data = await page.evaluate(() => {
        // Scope to document.body, NOT document.* — the <title> tag also matches the
        // VIN/Chassis regex (SEO title includes it) and, being earlier in DOM order than
        // the real on-page heading, was winning the .find() and polluting every title with
        // a "Bonhams Cars : " prefix from the browser tab title.
        const all = Array.from(document.body.querySelectorAll("*"));
        const headingEl = all.find((e) => e.children.length === 0 && /VIN\.|Chassis No\./i.test(e.textContent || "") && e.textContent.length < 150);
        // NOT children.length===0 — Premium lots render "LOT 52<!-- --> <span>P</span>",
        // giving that <p> a child element. The leaf-only check silently skipped every
        // Premium lot and left lotNumber null, which produced duplicate source_lot_id
        // ("31959-null" x2 — Bugatti Chiron AND Lamborghini Diablo GT, both Premium lots)
        // that would collide on the sale table's UNIQUE(source, source_lot_id) constraint.
        // Match on the element's OWN leading text instead of requiring no children.
        const lotEl = all.find((e) => /^LOT\s*\d+/i.test((e.textContent || "").trim()) && e.textContent.trim().length < 20);
        // 60-char cap was too tight: some lots append a "LOT TO BE SOLD WITHOUT RESERVE"
        // tag inline right after the price, pushing the same container past 60 chars and
        // making the match fail entirely (found via a real lot: Vollstedt-Ford '67 chassis
        // 67B, which DID sell for $698,000 but got reported as null price before this fix).
        const priceEl = all.find((e) => /Sold\s*for|Not\s*Sold|Withdrawn/i.test(e.textContent || "") && e.textContent.length < 150);

        return {
          headingText: headingEl ? headingEl.textContent.trim() : null,
          lotNumber: lotEl ? (lotEl.textContent.match(/\d+/) || [])[0] : null,
          priceLineText: priceEl ? priceEl.textContent.replace(/\s+/g, " ").trim() : "",
          priceElFound: !!priceEl,
          bodyText: document.body.innerText,
          auctionName: document.title,
        };
      });
      if (!data.priceElFound) {
        log.warning(`No price/result element found for ${request.url} — check manually.`);
      }

      const normalized = adaptBonhams(
        { ...data, auctionId, auctionDate: "2026-08-13T17:00:00Z" }, // 10:00 PDT confirmed on the auction page
        request.url
      );
      log.info(`Scraped: ${normalized.title} — ${normalized.currency} ${normalized.price} (VIN/chassis ${normalized.vin_raw}, ${normalized.mileage ?? "?"} mi)`);
      await Dataset.pushData(normalized);
      return;
    }

    // Auction results page: enqueue individual lot links
    await page.waitForSelector("a[href*='/lot/']", { timeout: 15000 }).catch(() => {});
    const result = await enqueueLinks({
      selector: "a[href*='/lot/']",
      label: "DETAIL",
      limit: maxLots,
    });
    log.info(`Enqueued ${result?.enqueuedRequests?.length ?? 0} lot links.`);
  },
});

(async () => {
  await crawler.run([{ url: `https://cars.bonhams.com/auction/${auctionId}/the-laguna-seca-auction/`, label: "LIST" }]);
  const dataset = await Dataset.open();
  const { items } = await dataset.getData();
  const outFile = path.join(OUT_DIR, "bonhams.json");
  fs.writeFileSync(outFile, JSON.stringify(items, null, 2));
  console.log(`\nWrote ${items.length} normalized sale records to ${outFile}`);

  if (items.length > 0) {
    const report = runHealthCheck("bon", items);
    if (report.overallStatus === "NEEDS_REVIEW") {
      console.error(`bonhams scrape flagged NEEDS_REVIEW — do not feed this batch into the nightly compute job untouched.`);
      process.exitCode = 1;
    }
  }
})();
