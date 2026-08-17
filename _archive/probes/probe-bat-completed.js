const { PlaywrightCrawler } = require("crawlee");

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: 1,
  requestHandlerTimeoutSecs: 60,
  async requestHandler({ page }) {
    await page.waitForTimeout(4000);
    // What buttons/links exist that mention results or completed?
    const candidates = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a,button")).map((e) => (e.textContent || "").trim())
        .filter((t) => /result|completed|sold|show more|load more|past/i.test(t) && t.length < 60)
        .slice(0, 20)
    );
    console.log("CANDIDATES::" + JSON.stringify([...new Set(candidates)], null, 1));

    // Any XHR/API the page uses for auction data?
    const apiish = await page.evaluate(() =>
      performance.getEntriesByType("resource").map((r) => r.name)
        .filter((n) => /wp-json|api|ajax|search|filter/i.test(n)).slice(0, 15)
    );
    console.log("NETWORK::" + JSON.stringify(apiish, null, 1));
  },
});

crawler.run(["https://bringatrailer.com/porsche/911/"]).catch((e) => console.log("ERR::" + e.message));
