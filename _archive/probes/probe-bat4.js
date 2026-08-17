const { PlaywrightCrawler } = require("crawlee");

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: 1,
  requestHandlerTimeoutSecs: 45,
  async requestHandler({ page, log }) {
    await page.waitForTimeout(5000);
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 1500));
    console.log("BODY::" + bodyText);
    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a[href]")).map((a) => a.getAttribute("href")).filter((h) => h && h.includes("/listing/"))
    );
    console.log("LINKS::" + JSON.stringify([...new Set(links)].slice(0, 10), null, 2));
  },
});

crawler.run(["https://bringatrailer.com/porsche/911/?sold=true"]).catch((e) => console.log("ERROR::" + e.message));
