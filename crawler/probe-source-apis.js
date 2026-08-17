// FIND EACH SOURCE'S OWN JSON API — the technique that unlocked BaT.
//
// BaT went from ~8,700 records (the DOM/"Show More" ceiling) to 57,703 the moment we stopped
// scraping HTML and called the endpoint the site itself calls. DOM scraping is always the
// worst option: it is slow, it breaks on redesign, and it hits virtualisation limits that have
// nothing to do with how much data exists.
//
// So before writing or fixing any per-source DOM crawler, ask the same question of every
// source: what does the page's own JavaScript request? Watch the network while the results
// page loads and paginates, and keep anything that looks like data.
//
// Usage: node crawler/probe-source-apis.js [sourceCode]

const { PlaywrightCrawler } = require("crawlee");

// Entry points are the RESULTS/past-auction routes, not the homepage — that is where a site
// paginates completed sales, which is the only thing this product needs.
const SOURCES = {
  cab:   { name: "Cars & Bids",   url: "https://carsandbids.com/past-auctions/" },
  mecum: { name: "Mecum",         url: "https://www.mecum.com/search/?saleResult[0]=sold" },
  bon:   { name: "Bonhams",       url: "https://cars.bonhams.com/en/search?category=results" },
  rms:   { name: "RM Sotheby's",  url: "https://rmsothebys.com/search?SearchTerm=&Type=Auction" },
  sms:   { name: "SMS",           url: "https://sothebysmotorsport.com/auctions/" },
  good:  { name: "Gooding",       url: "https://www.goodingco.com/past-auctions/" },
};

const wanted = process.argv[2];
const targets = Object.entries(SOURCES).filter(([k]) => !wanted || k === wanted);

const captured = new Map(); // source -> [{method, url, body}]

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: targets.length,
  maxConcurrency: 1,
  maxRequestRetries: 1,
  requestHandlerTimeoutSecs: 150,
  navigationTimeoutSecs: 90,
  preNavigationHooks: [
    async ({ page, request }) => {
      const code = request.userData.code;
      if (!captured.has(code)) captured.set(code, []);
      page.on("response", async (res) => {
        const u = res.url();
        const ct = String(res.headers()["content-type"] || "");
        // Data, not assets: JSON content type, or a URL shaped like an API route.
        if (!/json|graphql/i.test(ct) && !/\/api\/|wp-json|graphql|\.json(\?|$)|_next\/data/i.test(u)) return;
        if (/analytics|segment|sentry|datadog|googletag|doubleclick|hotjar|optimizely|cookielaw|onetrust/i.test(u)) return;
        let size = 0, sample = "";
        try { const t = await res.text(); size = t.length; sample = t.slice(0, 160).replace(/\s+/g, " "); } catch {}
        captured.get(code).push({ status: res.status(), url: u, size, sample, method: res.request().method(), body: (res.request().postData() || "").slice(0, 200) });
      });
    },
  ],
  async requestHandler({ page, request, log }) {
    await page.waitForTimeout(7000);
    // Nudge the page into loading more results, which is when a paginating API shows itself.
    for (const rx of ["show more", "load more", "next", "view more", "see more"]) {
      await page.evaluate((needle) => {
        const el = Array.from(document.querySelectorAll("a,button")).find((e) =>
          (e.textContent || "").trim().toLowerCase().startsWith(needle));
        if (el) { el.scrollIntoView(); el.click(); }
      }, rx);
      await page.waitForTimeout(2500);
    }
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(4000);
    log.info(`${request.userData.code}: ${(captured.get(request.userData.code) || []).length} data responses`);
  },
  failedRequestHandler({ request, log }) { log.warning(`FAILED ${request.userData.code} ${request.url}`); },
});

crawler
  .run(targets.map(([code, s]) => ({ url: s.url, userData: { code } })))
  .then(() => {
    for (const [code, s] of targets) {
      const rows = (captured.get(code) || [])
        .filter((r) => r.size > 400)                       // ignore config/ping payloads
        .sort((a, b) => b.size - a.size);
      console.log(`\n=== ${s.name} (${code}) ===`);
      if (!rows.length) { console.log("   no JSON/API responses seen — DOM scraping may be the only route"); continue; }
      const seen = new Set();
      for (const r of rows.slice(0, 6)) {
        const base = r.url.split("?")[0];
        if (seen.has(base)) continue;
        seen.add(base);
        console.log(`   ${r.method} ${r.status}  ${(r.size / 1024).toFixed(0)} KB  ${r.url.slice(0, 130)}`);
        if (r.body) console.log(`        body: ${r.body}`);
        console.log(`        ${r.sample.slice(0, 120)}`);
      }
    }
  });
