const { PlaywrightCrawler } = require("crawlee");

const urls = [
  "https://carsandbids.com/auctions/KPdZRdgN/2026-lexus-lc-500-inspiration-series-convertible",
];

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: 1,
  requestHandlerTimeoutSecs: 45,
  async requestHandler({ page, log }) {
    await page.waitForTimeout(5000);
    const statsMetaText = await page.evaluate(() => {
      const el = document.querySelector(".stats-meta");
      return el ? el.textContent.replace(/\s+/g, " ").trim() : "NOT_FOUND";
    });
    console.log("RAW_STATS_META::" + statsMetaText);
  },
});

crawler.run(urls).catch((e) => console.log("ERROR::" + e.message));
