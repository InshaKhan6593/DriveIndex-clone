const { PlaywrightCrawler } = require("crawlee");

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: 1,
  requestHandlerTimeoutSecs: 45,
  async requestHandler({ page, log }) {
    await page.waitForTimeout(5000);
    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a[href]"))
        .filter((a) => /past auction|monterey|results/i.test(a.textContent || "") || /past-auction|monterey|result/i.test(a.getAttribute("href") || ""))
        .map((a) => ({ text: a.textContent.trim().slice(0, 40), href: a.getAttribute("href") }))
    );
    console.log("LINKS::" + JSON.stringify(links.slice(0, 15), null, 2));
  },
});

crawler.run(["https://www.mecum.com/auctions/"]).catch((e) => console.log("ERROR::" + e.message));
