const { PlaywrightCrawler } = require("crawlee");

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: 1,
  requestHandlerTimeoutSecs: 45,
  async requestHandler({ page, log }) {
    await page.waitForTimeout(5000);
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 3500));
    console.log("BODY::" + bodyText);
  },
});

crawler.run(["https://www.mecum.com/lots/1178962/1956-chevrolet-nomad-wagon?aa_id=804160-0"]).catch((e) => console.log("ERROR::" + e.message));
