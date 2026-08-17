// Capture ONE real /v2/autos/auctions payload by interception, to learn the record shape the
// adapter must handle. Forging the call is impossible (signature + access-token cookie), but
// reading what the page itself receives is straightforward.
const { PlaywrightCrawler } = require("crawlee");

let sample = null, total = null, keysSeen = new Set();

new PlaywrightCrawler({
  maxRequestsPerCrawl: 1,
  requestHandlerTimeoutSecs: 180,
  navigationTimeoutSecs: 120,
  preNavigationHooks: [
    async ({ page }) => {
      page.on("response", async (res) => {
        if (!/\/v2\/autos\/auctions/.test(res.url()) || res.status() !== 200) return;
        try {
          const j = await res.json();
          if (total == null) total = j.total;
          for (const a of j.auctions || []) for (const k of Object.keys(a)) keysSeen.add(k);
          if (!sample && j.auctions && j.auctions[0]) sample = j.auctions[0];
        } catch {}
      });
    },
  ],
  async requestHandler({ page, log }) {
    await page.waitForTimeout(9000);
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2500);
    }
    log.info(`total=${total}  distinct keys=${keysSeen.size}`);
  },
}).run(["https://carsandbids.com/past-auctions/"]).then(() => {
  console.log(`\ntotal closed auctions reported: ${total}`);
  console.log(`\nall keys across captured records:\n  ${[...keysSeen].sort().join(", ")}`);
  if (sample) {
    console.log(`\nSAMPLE RECORD:`);
    console.log(JSON.stringify(sample, null, 1).slice(0, 3000));
  } else {
    console.log("\nno payload captured — the feed may not have fired");
  }
});
