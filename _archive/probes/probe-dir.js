const { PlaywrightCrawler } = require("crawlee");
const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: 1, requestHandlerTimeoutSecs: 60,
  async requestHandler({ page }) {
    await page.waitForTimeout(6000);
    const txt = await page.evaluate(() => document.body.innerText.slice(0, 1200));
    console.log("BODY::" + txt);
    const hrefs = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a[href]")).map(a=>a.getAttribute("href")).filter(h=>h&&/porsche|ferrari|bmw/i.test(h)).slice(0,10));
    console.log("CARLINKS::" + JSON.stringify(hrefs));
  },
});
crawler.run(["https://bringatrailer.com/makes-and-models/"]).catch(e=>console.log("ERR",e.message));
