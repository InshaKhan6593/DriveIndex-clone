const { PlaywrightCrawler } = require("crawlee");

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: 1,
  requestHandlerTimeoutSecs: 45,
  async requestHandler({ page, log }) {
    await page.waitForTimeout(6000);
    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a[href*='/lots/']"))
        .map((a) => a.getAttribute("href"))
        .filter((h) => /^\/lots\/\d+/.test(h))
    );
    console.log("SOLD_LOT_LINKS::" + JSON.stringify([...new Set(links)].slice(0, 10), null, 2));
  },
});

crawler.run(["https://www.mecum.com/auctions/monterey-2026/lots/?saleResult[0]=sold&sortBy=wp_posts_lot_sort_order_asc"]).catch((e) => console.log("ERROR::" + e.message));
