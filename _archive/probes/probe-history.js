// Do auction houses keep PER-EVENT archives going back years?
// This is the decisive question for the product: signals need repeat sales of the same car
// spread over years, and BaT's rolling feed only exposes ~52 days.
const { PlaywrightCrawler } = require("crawlee");

const urls = [
  "https://www.mecum.com/auctions/monterey-2023/lots/",
  "https://www.mecum.com/auctions/kissimmee-2022/lots/",
  "https://www.mecum.com/auctions/indy-2021/lots/",
];

new PlaywrightCrawler({
  maxRequestsPerCrawl: urls.length, requestHandlerTimeoutSecs: 60,
  maxConcurrency: 2, maxRequestRetries: 0,
  async requestHandler({ page, request, log }) {
    await page.waitForTimeout(5000);
    const d = await page.evaluate(() => {
      const txt = document.body.innerText;
      return {
        lots: document.querySelectorAll("a[href*='/lots/']").length,
        prices: (txt.match(/\$[\d,]{4,}/g) || []).length,
        notFound: /page not found|404/i.test(txt.slice(0, 400)),
      };
    });
    log.info(`${request.url.split("/auctions/")[1].padEnd(22)} lots=${d.lots} prices=${d.prices} 404=${d.notFound}`);
  },
  failedRequestHandler({ request, log }) { log.warning(`FAILED ${request.url}`); },
}).run(urls);
