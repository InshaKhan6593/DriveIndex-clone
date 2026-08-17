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

crawler.run(["https://www.mecum.com/lots/1175988/1963-ferrari-250-gt-l-berlinetta-lusso?aa_id=793591-0"]).catch((e) => console.log("ERROR::" + e.message));
