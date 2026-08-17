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

crawler.run(["https://cars.bonhams.com/auction/31959/lot/52/lessbgreater2000-lamborghini-diablo-gtlessbgreater-lessbr-greater-vin-za9de21a0yla12561/"]).catch((e) => console.log("ERROR::" + e.message));
