const { PlaywrightCrawler } = require("crawlee");

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: 1,
  requestHandlerTimeoutSecs: 45,
  async requestHandler({ page }) {
    await page.waitForTimeout(4000);
    const hrefs = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a[href]")).map((a) => a.getAttribute("href")).filter((h) => h && h.includes("auction"))
    );
    console.log("AUCTION_HREFS::" + JSON.stringify(hrefs.slice(0, 20), null, 2));
    console.log("TOTAL_LINKS::" + (await page.evaluate(() => document.querySelectorAll("a[href]").length)));
  },
});

crawler.run(["https://carsandbids.com/past-auctions"]);
