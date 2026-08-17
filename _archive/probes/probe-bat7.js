const { PlaywrightCrawler } = require("crawlee");

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: 1,
  requestHandlerTimeoutSecs: 60,
  async requestHandler({ page, log }) {
    await page.waitForTimeout(3000);
    // Try clicking the "View X Completed Auctions" element if it's a button, then wait.
    const clicked = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll("a,button")).find((e) => /View [\d,]+ Completed Auctions/.test(e.textContent || ""));
      if (el) { el.click(); return true; }
      return false;
    });
    console.log("CLICKED::" + clicked);
    await page.waitForTimeout(4000);

    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a[href]")).map((a) => a.getAttribute("href")).filter((h) => h && h.includes("/listing/"))
    );
    console.log("LINKS_AFTER_CLICK::" + JSON.stringify([...new Set(links)].slice(0, 10), null, 2));

    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 1500));
    console.log("BODY_AFTER::" + bodyText);
  },
});

crawler.run(["https://bringatrailer.com/auctions/results/"]).catch((e) => console.log("ERROR::" + e.message));
