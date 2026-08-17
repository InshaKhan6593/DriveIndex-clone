// Finds the REAL results route for sources whose landing page returned 0 listing links.
// Tries several candidate URLs per source and reports which one actually yields lots.
const { PlaywrightCrawler } = require("crawlee");

const CANDIDATES = [
  ["collectingcars", "https://collectingcars.com/auctions/results"],
  ["collectingcars", "https://collectingcars.com/buy?status=sold"],
  ["collectingcars", "https://collectingcars.com/for-sale/results"],
  ["pcar", "https://pcarmarket.com/auction/closed/"],
  ["pcar", "https://pcarmarket.com/search/?status=closed"],
  ["pcar", "https://pcarmarket.com/auctions/"],
  ["dupont", "https://www.dupontregistry.com/autos/results/all/all"],
  ["dupont", "https://www.dupontregistry.com/autos/search"],
  ["dupont", "https://www.dupontregistry.com/autos/listings"],
];

const found = {};
const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: CANDIDATES.length,
  requestHandlerTimeoutSecs: 45,
  navigationTimeoutSecs: 35,
  maxRequestRetries: 0,
  maxConcurrency: 2,
  async requestHandler({ page, request, log }) {
    const [code] = request.userData.pair;
    await page.waitForTimeout(4000);
    const info = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll("a[href]")).map((a) => a.href);
      const lot = links.filter((h) => /\/(auction|listing|lot|vehicle|veh|car|inventory)s?\/[^/?#]{4,}/i.test(h));
      const body = document.body.innerText;
      return {
        title: document.title.slice(0, 60),
        lotCount: [...new Set(lot)].length,
        samples: [...new Set(lot)].slice(0, 3),
        prices: (body.match(/(?:USD|US\$|\$|£|€)\s?[\d,]{4,}/g) || []).length,
        blocked: /just a moment|enable javascript|access denied|robot/i.test(body.slice(0, 300)),
      };
    });
    log.info(`${code.padEnd(15)} ${info.lotCount.toString().padStart(3)} lots  ${info.prices.toString().padStart(3)} prices  ${request.url}`);
    if (!found[code] || info.lotCount > found[code].lotCount) found[code] = { url: request.url, ...info };
  },
  failedRequestHandler({ request, log }, err) {
    log.warning(`${request.userData.pair[0].padEnd(15)} FAILED ${request.url} :: ${String(err && err.message).slice(0, 70)}`);
  },
});

(async () => {
  await crawler.run(CANDIDATES.map((pair) => ({ url: pair[1], userData: { pair } })));
  console.log("\n=== BEST ROUTE PER SOURCE ===");
  for (const [code, r] of Object.entries(found)) {
    console.log(`${code.padEnd(15)} lots=${r.lotCount} prices=${r.prices}\n   ${r.url}\n   samples: ${r.samples.join(" | ")}`);
  }
})();
