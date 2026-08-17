// Mecum is DriveIndex's #2 source (6.4% of their mix) and we hold 18 records. Its search route
// exposes no data API, so the question is how its results ARE delivered:
//   * embedded JSON in the HTML (Next.js __NEXT_DATA__, Nuxt, or a bare <script> payload)
//   * server-rendered markup only
//   * a POST/XHR fired on interaction rather than load
// and, separately, whether the archive paginates by page number or by auction event.
//
// Usage: node crawler/probe-mecum-shape.js

const { PlaywrightCrawler } = require("crawlee");

const URLS = [
  "https://www.mecum.com/search/?saleResult[0]=sold",
  "https://www.mecum.com/search/?saleResult[0]=sold&page=2",
  "https://www.mecum.com/auctions/",
];

const xhr = [];

new PlaywrightCrawler({
  maxRequestsPerCrawl: URLS.length,
  maxConcurrency: 1,
  requestHandlerTimeoutSecs: 180,
  navigationTimeoutSecs: 120,
  preNavigationHooks: [
    async ({ page }) => {
      page.on("response", async (r) => {
        const u = r.url();
        if (/mecum\.com/.test(u) && /json|search|api|graphql|lots?/i.test(u) && r.status() === 200) {
          let len = 0; try { len = (await r.text()).length; } catch {}
          if (len > 500) xhr.push({ url: u.slice(0, 150), len });
        }
      });
    },
  ],
  async requestHandler({ page, request, log }) {
    await page.waitForTimeout(7000);
    const d = await page.evaluate(() => {
      const out = {};
      // Framework payloads
      const nextEl = document.querySelector("#__NEXT_DATA__");
      out.hasNextData = !!nextEl;
      if (nextEl) out.nextDataLen = nextEl.textContent.length;
      out.hasNuxt = typeof window.__NUXT__ !== "undefined";
      // Any inline script that looks like a lot payload
      const scripts = Array.from(document.querySelectorAll("script:not([src])"));
      out.inlineWithLots = scripts.filter((s) => /"lot|lotNumber|saleResult|hammer/i.test(s.textContent || "")).length;
      // Rendered markers
      const txt = document.body.innerText;
      out.lotLinks = document.querySelectorAll("a[href*='/lots/']").length;
      out.soldStrings = (txt.match(/\bSold\b/gi) || []).length;
      out.prices = (txt.match(/\$[\d,]{4,}/g) || []).length;
      out.pagerText = (txt.match(/Page\s+\d+\s+of\s+[\d,]+|\d[\d,]*\s+Results?/i) || [])[0] || null;
      // Sample a rendered card
      const a = document.querySelector("a[href*='/lots/']");
      out.sampleHref = a ? a.href : null;
      out.sampleText = a ? (a.closest("div,li,article") || a).innerText.replace(/\s+/g, " ").slice(0, 160) : null;
      return out;
    });
    log.info(`${request.url.slice(28)}\n     ${JSON.stringify(d, null, 1).replace(/\n/g, "\n     ")}`);
  },
}).run(URLS).then(() => {
  console.log(`\n=== mecum.com XHR/JSON responses seen ===`);
  const uniq = [...new Map(xhr.map((x) => [x.url.split("?")[0], x])).values()];
  for (const x of uniq.slice(0, 12)) console.log(`   ${(x.len / 1024).toFixed(0)} KB  ${x.url}`);
  if (!uniq.length) console.log("   none — results are server-rendered");
});
