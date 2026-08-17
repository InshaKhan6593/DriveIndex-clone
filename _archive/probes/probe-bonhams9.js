const { PlaywrightCrawler } = require("crawlee");

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: 1,
  requestHandlerTimeoutSecs: 45,
  async requestHandler({ page, log }) {
    await page.waitForTimeout(5000);
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 1200));
    console.log("BODY::" + bodyText);
  },
});

crawler.run(["https://cars.bonhams.com/auction/31959/lot/24/lessbgreater1967-vollstedt-ford-67-usac-indianapolis-racing-single-seaterlessbgreaterlessbr-greater-chassis-no-67b/"]).catch((e) => console.log("ERROR::" + e.message));
