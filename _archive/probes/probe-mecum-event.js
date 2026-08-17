// Mecum's SEARCH route renders no prices and no pager, and its lot links point at AUCTION
// pages (/auctions/{event}/lots/) rather than individual lots. So the archive is probably
// organised per event, exactly like RM Sotheby's — which would make the auction code the
// partition key again.
//
// This checks whether an event's lots page actually renders sold prices, and whether it
// paginates.
//
// Usage: node crawler/probe-mecum-event.js

const { PlaywrightCrawler } = require("crawlee");

const URLS = [
  "https://www.mecum.com/auctions/kissimmee-2022/lots/",
  "https://www.mecum.com/auctions/monterey-2025/lots/",
  "https://www.mecum.com/auctions/indy-2024/lots/",
];

new PlaywrightCrawler({
  maxRequestsPerCrawl: URLS.length,
  maxConcurrency: 1,
  maxRequestRetries: 0,
  requestHandlerTimeoutSecs: 150,
  navigationTimeoutSecs: 120,
  async requestHandler({ page, request, log }) {
    await page.waitForTimeout(8000);
    // Nudge lazy content
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(3000);

    const d = await page.evaluate(() => {
      const text = document.body.innerText;
      const priceRe = /\$[\d,]{4,}/g;
      const lotAnchors = Array.from(document.querySelectorAll("a[href*='/lots/']"));
      const withLotId = lotAnchors.filter((a) => /\/lots\/[A-Za-z0-9-]+\/?$/.test(a.getAttribute("href") || ""));
      const sampleCard = withLotId[0] ? (withLotId[0].closest("div,li,article") || withLotId[0]).innerText : "";
      return {
        lotAnchors: lotAnchors.length,
        individualLots: withLotId.length,
        prices: (text.match(priceRe) || []).length,
        soldWord: (text.match(/\bSold\b/gi) || []).length,
        pager: (text.match(/Page\s+\d+\s+of\s+[\d,]+|Showing\s+[\d,]+|[\d,]+\s+Lots?/i) || [])[0] || null,
        sampleHref: withLotId[0] ? withLotId[0].href : null,
        sampleCard: sampleCard.replace(/\s+/g, " ").slice(0, 170),
      };
    });
    log.info(`${request.url.replace("https://www.mecum.com/auctions/", "")}\n     ${JSON.stringify(d, null, 1).replace(/\n/g, "\n     ")}`);
  },
  failedRequestHandler({ request, log }) { log.warning(`FAILED ${request.url}`); },
}).run(URLS);
