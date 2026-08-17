// Capture the XHR/fetch calls BaT's own results page makes. Their robots.txt exposes a
// wp-json namespace, and /data/listings-filter answered 400 (endpoint exists, wrong params)
// rather than 404 — so the site knows how to call it correctly. Watch it do so.
const { PlaywrightCrawler } = require("crawlee");

const seen = [];
new PlaywrightCrawler({
  maxRequestsPerCrawl: 1, requestHandlerTimeoutSecs: 120,
  preNavigationHooks: [async ({ page }) => {
    page.on("request", (req) => {
      const u = req.url();
      if (/wp-json|\/api\/|listings-filter|graphql/i.test(u)) {
        seen.push({ method: req.method(), url: u, postData: (req.postData() || "").slice(0, 400) });
      }
    });
  }],
  async requestHandler({ page, log }) {
    await page.waitForTimeout(5000);
    // trigger the archive load + one pagination step so we see the real query shape
    await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll("a,button")).find((e) => /View\s+[\d,]+\s+Completed/i.test(e.textContent || ""));
      if (el) el.click();
    });
    await page.waitForTimeout(4000);
    await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll("a,button")).find((e) => /^show more/i.test((e.textContent || "").trim()));
      if (el) el.click();
    });
    await page.waitForTimeout(4000);
    log.info(`captured ${seen.length} api-ish requests`);
  },
}).run(["https://bringatrailer.com/auctions/results/"]).then(() => {
  const uniq = [...new Map(seen.map((s) => [s.url.split("?")[0] + s.method, s])).values()];
  console.log("\n=== API CALLS THE SITE MAKES ===");
  for (const s of uniq.slice(0, 12)) {
    console.log(`${s.method} ${s.url.slice(0, 200)}`);
    if (s.postData) console.log(`     body: ${s.postData}`);
  }
});
