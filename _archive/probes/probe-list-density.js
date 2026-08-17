// Can we read price+title from the RESULTS LIST itself, instead of visiting one detail page
// per car? That single question decides whether matching DriveIndex's volume is feasible.
const { PlaywrightCrawler } = require("crawlee");

new PlaywrightCrawler({
  maxRequestsPerCrawl: 1, requestHandlerTimeoutSecs: 90,
  async requestHandler({ page, log }) {
    await page.waitForTimeout(4000);
    await page.evaluate(() => {
      const t = Array.from(document.querySelectorAll("a,button")).find(e => (e.textContent||"").trim().toLowerCase()==="results");
      if (t) t.click();
    });
    await page.waitForTimeout(3500);

    const total = await page.evaluate(() => {
      const m = document.body.innerText.match(/View\s+([\d,]+)\s+Completed Auctions/i);
      return m ? m[1] : null;
    });
    console.log("TOTAL_COMPLETED_ON_SITE::" + total);

    // Does each result card carry a sold price next to its link?
    const sample = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll("a[href*='/listing/']")).slice(0, 6);
      return anchors.map((a) => {
        let card = a;
        for (let i = 0; i < 5 && card.parentElement; i++) card = card.parentElement;
        const txt = (card.innerText || "").replace(/\s+/g, " ").trim().slice(0, 160);
        return { href: a.getAttribute("href"), cardText: txt };
      });
    });
    console.log("CARD_SAMPLES::" + JSON.stringify(sample, null, 1));
  },
}).run(["https://bringatrailer.com/auctions/results/"]).catch(e => console.log("ERR", e.message));
