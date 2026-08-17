const { PlaywrightCrawler } = require("crawlee");

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: 1,
  requestHandlerTimeoutSecs: 45,
  async requestHandler({ page, log }) {
    await page.waitForTimeout(5000);
    const title = await page.title();
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 1200));
    console.log("TITLE::" + title);
    console.log("BODY::" + bodyText);
  },
});

crawler.run(["https://www.mecum.com/auctions/"]).catch((e) => console.log("ERROR::" + e.message));
