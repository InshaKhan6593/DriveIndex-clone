const { PlaywrightCrawler } = require("crawlee");

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: 1,
  requestHandlerTimeoutSecs: 45,
  async requestHandler({ page, log }) {
    await page.waitForTimeout(5000);
    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a[href]"))
        .filter((a) => /view results/i.test(a.textContent || ""))
        .map((a) => a.getAttribute("href"))
    );
    console.log("VIEW_RESULTS_LINKS::" + JSON.stringify(links.slice(0, 10), null, 2));
  },
});

crawler.run(["https://cars.bonhams.com/auctions/results/"]).catch((e) => console.log("ERROR::" + e.message));
