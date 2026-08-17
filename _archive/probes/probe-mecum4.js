const { PlaywrightCrawler } = require("crawlee");

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: 1,
  requestHandlerTimeoutSecs: 45,
  async requestHandler({ page, log }) {
    await page.waitForTimeout(5000);
    const allHrefs = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a[href]")).map((a) => a.getAttribute("href"))
    );
    console.log("ALL_HREFS_SAMPLE::" + JSON.stringify([...new Set(allHrefs)].filter(h => h && h.includes('ferrari')).slice(0, 5), null, 2));
    console.log("ALL_HREFS_COUNT::" + allHrefs.length);
    console.log("ALL_HREFS_UNIQUE_SAMPLE::" + JSON.stringify([...new Set(allHrefs)].slice(20, 40), null, 2));
  },
});

crawler.run(["https://www.mecum.com/auctions/monterey-2026/lots/"]).catch((e) => console.log("ERROR::" + e.message));
