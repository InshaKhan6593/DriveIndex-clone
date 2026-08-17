const { PlaywrightCrawler } = require("crawlee");

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: 1,
  requestHandlerTimeoutSecs: 45,
  async requestHandler({ page, log }) {
    await page.waitForTimeout(5000);
    // Find links that look like completed/sold listings
    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a[href]"))
        .map((a) => a.getAttribute("href"))
        .filter((h) => h && h.includes("/listing/"))
    );
    console.log("BAT_LISTING_LINKS::" + JSON.stringify([...new Set(links)].slice(0, 15), null, 2));
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 1500));
    console.log("BODY::" + bodyText);
  },
});

crawler.run(["https://bringatrailer.com/porsche/911/"]).catch((e) => console.log("CRAWLER_ERROR::" + e.message));
