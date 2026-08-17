// Probes every source in the registry and records its ACTUAL patterns — reachability,
// bot-challenge posture, results entry point, listing URL shape, and whether sold prices
// are visible without auth. Evidence for building adapters, instead of guessing.
//
// Usage: node crawler/probe-all-sources.js [sourceCode ...]
// Output: samples/raw/source-patterns.json

const fs = require("fs");
const path = require("path");
const { PlaywrightCrawler } = require("crawlee");

const TARGETS = [
  { code: "bat",            name: "Bring a Trailer",     url: "https://bringatrailer.com/auctions/results/" },
  { code: "cab",            name: "Cars & Bids",         url: "https://carsandbids.com/past-auctions/" },
  { code: "rms",            name: "RM Sotheby's",        url: "https://rmsothebys.com/results/" },
  { code: "bon",            name: "Bonhams",             url: "https://cars.bonhams.com/auctions/results/" },
  { code: "mecum",          name: "Mecum",               url: "https://www.mecum.com/results/" },
  { code: "bj",             name: "Barrett-Jackson",     url: "https://www.barrett-jackson.com/Events/Event/Docket/" },
  { code: "good",           name: "Gooding & Company",   url: "https://www.goodingco.com/auctions/" },
  { code: "broadarrow",     name: "Broad Arrow",         url: "https://www.broadarrowauctions.com/auctions" },
  { code: "collectingcars", name: "Collecting Cars",     url: "https://collectingcars.com/results" },
  { code: "hagerty",        name: "Hagerty Marketplace", url: "https://www.hagerty.com/marketplace/auctions/results" },
  { code: "dupont",         name: "DuPont Registry",     url: "https://www.dupontregistry.com/autos" },
  { code: "pcar",           name: "PCAR Market",         url: "https://pcarmarket.com/auctions/closed/" },
  { code: "sms",            name: "Sotheby's Motorsport", url: "https://sothebysmotorsport.com/" },
  { code: "classic",        name: "Classic.com (aggregator)", url: "https://www.classic.com/" },
];

const only = process.argv.slice(2);
const list = only.length ? TARGETS.filter((t) => only.includes(t.code)) : TARGETS;

const OUT = path.join(__dirname, "..", "samples", "raw", "source-patterns.json");
fs.mkdirSync(path.dirname(OUT), { recursive: true });
let results = {};
try { results = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch {}

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: list.length,
  requestHandlerTimeoutSecs: 60,
  navigationTimeoutSecs: 45,
  maxRequestRetries: 1,
  maxConcurrency: 2,
  async requestHandler({ page, request, log }) {
    const meta = request.userData;
    await page.waitForTimeout(4500);

    const info = await page.evaluate(() => {
      const bodyText = document.body ? document.body.innerText : "";
      const links = Array.from(document.querySelectorAll("a[href]")).map((a) => a.href);
      // sample the hrefs that look like individual vehicle listings
      const listingish = links.filter((h) => /\/(listing|lot|lots|auctions?|veh|vehicle|inventory|item)\/[^/?#]+/i.test(h));
      const priceHits = (bodyText.match(/(?:USD|US\$|\$|£|€)\s?[\d,]{4,}/g) || []).slice(0, 5);
      return {
        title: document.title,
        bodyLen: bodyText.length,
        bodyHead: bodyText.slice(0, 220).replace(/\s+/g, " "),
        totalLinks: links.length,
        listingLinkCount: listingish.length,
        listingSamples: [...new Set(listingish)].slice(0, 4),
        priceSamples: priceHits,
        hasShowMore: /show more|load more|view more|next page/i.test(bodyText),
        hasResultsWord: /result/i.test(bodyText),
      };
    });

    const blocked = /just a moment|enable javascript|access denied|are you a robot|attention required/i.test(info.bodyHead) ||
                    /just a moment|attention required/i.test(info.title);

    results[meta.code] = {
      name: meta.name, probedUrl: request.url, probedAt: new Date().toISOString(),
      reachable: !blocked, botChallenge: blocked,
      pageTitle: info.title,
      listingLinkCount: info.listingLinkCount,
      listingUrlSamples: info.listingSamples,
      pricesVisibleUnauthenticated: info.priceSamples.length > 0,
      priceSamples: info.priceSamples,
      paginationControl: info.hasShowMore,
      bodyPreview: info.bodyHead,
    };
    log.info(`${meta.code.padEnd(15)} reachable=${!blocked} listings=${info.listingLinkCount} prices=${info.priceSamples.length > 0}`);
  },
  failedRequestHandler({ request, log }, err) {
    const meta = request.userData;
    results[meta.code] = {
      name: meta.name, probedUrl: request.url, probedAt: new Date().toISOString(),
      reachable: false, error: String(err && err.message).slice(0, 160),
    };
    log.warning(`${meta.code.padEnd(15)} FAILED: ${String(err && err.message).slice(0, 90)}`);
  },
});

(async () => {
  await crawler.run(list.map((t) => ({ url: t.url, userData: t })));
  fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
  console.log(`\n${"=".repeat(70)}\nSOURCE PATTERN SUMMARY\n${"=".repeat(70)}`);
  for (const [code, r] of Object.entries(results)) {
    const status = r.reachable ? (r.listingLinkCount > 0 ? "OK" : "reachable, no listing links found") : (r.botChallenge ? "BOT CHALLENGE" : "UNREACHABLE");
    console.log(`${code.padEnd(15)} ${String(status).padEnd(34)} listings=${r.listingLinkCount ?? "-"} prices=${r.pricesVisibleUnauthenticated ?? "-"}`);
  }
  console.log(`\nWrote ${OUT}`);
})();
