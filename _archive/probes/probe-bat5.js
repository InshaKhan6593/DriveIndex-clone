const { PlaywrightCrawler } = require("crawlee");

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: 1,
  requestHandlerTimeoutSecs: 45,
  async requestHandler({ page, log }) {
    await page.waitForTimeout(5000);
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 3000));
    console.log("BODY::" + bodyText);
  },
});

crawler.run(["https://bringatrailer.com/listing/1978-porsche-911sc-targa-93/"]).catch((e) => console.log("ERROR::" + e.message));
