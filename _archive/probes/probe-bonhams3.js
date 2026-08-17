const { PlaywrightCrawler } = require("crawlee");

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: 1,
  requestHandlerTimeoutSecs: 45,
  async requestHandler({ page, log }) {
    await page.waitForTimeout(5000);
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 2500));
    console.log("BODY::" + bodyText);
    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a[href]")).map((a) => a.getAttribute("href")).filter((h) => h && /\/lot\//i.test(h))
    );
    console.log("LOT_LINKS::" + JSON.stringify([...new Set(links)].slice(0, 15), null, 2));
  },
});

crawler.run(["https://cars.bonhams.com/auctions/results/"]).catch((e) => console.log("ERROR::" + e.message));
