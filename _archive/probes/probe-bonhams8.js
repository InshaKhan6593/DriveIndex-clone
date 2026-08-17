const { PlaywrightCrawler } = require("crawlee");

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: 1,
  requestHandlerTimeoutSecs: 45,
  async requestHandler({ page, log }) {
    await page.waitForTimeout(5000);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 3));
    await page.waitForTimeout(1500);
    const bodyText = await page.evaluate(() => document.body.innerText);
    console.log("FULL_BODY_LEN::" + bodyText.length);
    console.log("FULL_BODY::" + bodyText.slice(1500, 6000));
  },
});

crawler.run(["https://cars.bonhams.com/auction/31959/lot/52/lessbgreater2000-lamborghini-diablo-gtlessbgreater-lessbr-greater-vin-za9de21a0yla12561/"]).catch((e) => console.log("ERROR::" + e.message));
