const { PlaywrightCrawler } = require("crawlee");

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: 1,
  requestHandlerTimeoutSecs: 45,
  async requestHandler({ page, log }) {
    await page.waitForTimeout(5000);
    const title = await page.title();
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 500));
    log.info(`Title: ${title}`);
    console.log("BAT_PROBE::" + JSON.stringify({ title, bodyPreview: bodyText }));
  },
});

crawler.run(["https://bringatrailer.com/auctions/"]).catch((e) => console.log("CRAWLER_ERROR::" + e.message));
