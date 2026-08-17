const { PlaywrightCrawler } = require("crawlee");

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: 1,
  requestHandlerTimeoutSecs: 45,
  async requestHandler({ page, log }) {
    await page.waitForTimeout(4000);
    // Click the "Sold" filter checkbox/label
    await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll("*")).find((e) => e.children.length === 0 && e.textContent.trim() === "Sold");
      if (el) el.click();
    });
    await page.waitForTimeout(4000);
    console.log("URL_AFTER_CLICK::" + page.url());
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 1000));
    console.log("BODY::" + bodyText);
    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a[href*='/lots/']")).map((a) => a.getAttribute("href"))
    );
    console.log("LOT_LINKS::" + JSON.stringify([...new Set(links)].slice(0, 8), null, 2));
  },
});

crawler.run(["https://www.mecum.com/auctions/monterey-2026/lots/"]).catch((e) => console.log("ERROR::" + e.message));
