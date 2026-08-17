// Can BaT's results be windowed by date/page? That decides whether deep history is
// reachable by many small bounded harvests (parallelisable, restartable) instead of one
// giant paginated session that must hold 100k+ cards in the DOM.
const { PlaywrightCrawler } = require("crawlee");

const CANDIDATES = [
  "https://bringatrailer.com/auctions/results/?page=5",
  "https://bringatrailer.com/auctions/results/?paged=5",
  "https://bringatrailer.com/auctions/results/page/5/",
  "https://bringatrailer.com/auctions/results/?end_date_from=2025-01-01&end_date_to=2025-02-01",
  "https://bringatrailer.com/auctions/results/?s=porsche",
];

const out = [];
new PlaywrightCrawler({
  maxRequestsPerCrawl: CANDIDATES.length,
  requestHandlerTimeoutSecs: 60, maxRequestRetries: 0, maxConcurrency: 2,
  async requestHandler({ page, request, log }) {
    await page.waitForTimeout(4500);
    const d = await page.evaluate(() => {
      const txt = document.body.innerText.replace(/\s+/g, " ");
      const results = (txt.match(/Sold for/gi) || []).length;
      const dates = [...txt.matchAll(/on\s+(\d{1,2}\/\d{1,2}\/(\d{4}))/g)].map(m => m[2]);
      return {
        title: document.title.slice(0, 50),
        soldCount: results,
        years: [...new Set(dates)].sort(),
        notFound: /page not found|404/i.test(txt.slice(0, 400)),
      };
    });
    log.info(`${d.soldCount.toString().padStart(4)} sold | years=${d.years.join(",") || "-"} | ${request.url}`);
    out.push({ url: request.url, ...d });
  },
  failedRequestHandler({ request, log }, e) { log.warning(`FAILED ${request.url} :: ${String(e&&e.message).slice(0,60)}`); },
}).run(CANDIDATES).then(() => {
  console.log("\n=== WINDOWING VIABILITY ===");
  for (const r of out) console.log(`${r.soldCount.toString().padStart(4)} sold  years=${r.years.join(",")||"-"}  ${r.url}`);
});
