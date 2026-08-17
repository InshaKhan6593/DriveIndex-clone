// Straight diagnostic: WHY do only ~42 of ~1080 cards carry a price?
const { PlaywrightCrawler } = require("crawlee");

new PlaywrightCrawler({
  maxRequestsPerCrawl: 1, requestHandlerTimeoutSecs: 300,
  async requestHandler({ page, log }) {
    await page.waitForTimeout(4000);
    const clicked = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll("a,button")).find((e) => /View\s+[\d,]+\s+Completed Auctions/i.test(e.textContent||""));
      if (el) { el.click(); return true; } return false;
    });
    await page.waitForTimeout(4000);
    console.log("clicked_completed::" + clicked);
    console.log("url_after::" + page.url());

    for (let i = 0; i < 10; i++) {
      const ok = await page.evaluate(() => {
        const el = Array.from(document.querySelectorAll("a,button")).find((e) => /^show more/i.test((e.textContent||"").trim()));
        if (el) { el.scrollIntoView(); el.click(); return true; } return false;
      });
      if (!ok) break;
      await page.waitForTimeout(1800);
    }

    const diag = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll("a[href*='/listing/']"));
      const uniqueHrefs = new Set(anchors.map(a => a.href.split("?")[0]));
      const bodyText = document.body.innerText;
      return {
        anchorCount: anchors.length,
        uniqueListings: uniqueHrefs.size,
        soldForOccurrences: (bodyText.match(/Sold for/gi) || []).length,
        bidToOccurrences: (bodyText.match(/Bid to/gi) || []).length,
        endsInOccurrences: (bodyText.match(/Ends? in|Time Left/gi) || []).length,
        bodyLength: bodyText.length,
      };
    });
    console.log("DIAG::" + JSON.stringify(diag, null, 1));
  },
}).run(["https://bringatrailer.com/auctions/results/"]).catch(e => console.log("ERR", e.message));
