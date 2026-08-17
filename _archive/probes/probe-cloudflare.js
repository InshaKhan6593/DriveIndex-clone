// One-off probe: can a headless Playwright browser (no stealth patches, default Crawlee
// config) get past Cars & Bids' Cloudflare managed challenge? Plain Node fetch() could not
// (see samples/raw/cars-and-bids-1.html — a Cloudflare "Just a moment..." page).
const { PlaywrightCrawler } = require("crawlee");

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: 1,
  requestHandlerTimeoutSecs: 45,
  async requestHandler({ page, request, log }) {
    await page.waitForTimeout(5000); // give the challenge time to resolve if it's going to
    const title = await page.title();
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 500));
    const blocked = title.includes("Just a moment") || bodyText.includes("Enable JavaScript");
    log.info(`URL: ${request.url}`);
    log.info(`Title: ${title}`);
    log.info(`Blocked by challenge: ${blocked}`);
    console.log("PROBE_RESULT::" + JSON.stringify({ title, blocked, bodyPreview: bodyText }));
  },
});

crawler.run(["https://carsandbids.com/auctions/9QJPXZZe/2007-porsche-911-turbo-coupe"]);
