const { PlaywrightCrawler } = require("crawlee");

const urls = [
  "https://bringatrailer.com/auctions/results/",
  "https://bringatrailer.com/porsche/911/#results",
];

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: urls.length,
  requestHandlerTimeoutSecs: 45,
  async requestHandler({ page, request, log }) {
    await page.waitForTimeout(5000);
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 800));
    console.log(`URL::${request.url}`);
    console.log("BODY::" + bodyText);
    console.log("---");
  },
});

crawler.run(urls).catch((e) => console.log("ERROR::" + e.message));
