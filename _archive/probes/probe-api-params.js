// The envelope leaks `is_default_keyword_filter`, and `category` is honoured (it changed
// items_total to 0, meaning the server READ it and my value was simply wrong). So the
// partition key exists — I just do not know its spelling or its value format.
//
// Guessing is the slow way. The site's own model pages must already issue exactly the call
// I want: "all completed Porsche 911 auctions". So watch a MAKE page and a MODEL page make
// their own XHR and read the parameters off the wire.
//
// This is the same technique that found the endpoint in the first place (probe-api.js);
// here it is pointed at the taxonomy pages instead of the global results page.
//
// Usage: node crawler/probe-api-params.js

const { PlaywrightCrawler } = require("crawlee");

const captured = [];

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: 3,
  maxConcurrency: 1,
  maxRequestRetries: 1,
  requestHandlerTimeoutSecs: 180,
  navigationTimeoutSecs: 120,
  preNavigationHooks: [
    async ({ page, request }) => {
      page.on("request", (req) => {
        const u = req.url();
        if (/wp-json|listings-filter|\/api\//i.test(u)) {
          captured.push({ from: request.url, method: req.method(), url: u, body: (req.postData() || "").slice(0, 600) });
        }
      });
    },
  ],
  async requestHandler({ page, request, log }) {
    await page.waitForTimeout(6000);

    // Force the archive to load and paginate once — the pagination call carries the full
    // parameter set, including whatever narrows the query to this taxonomy.
    for (const rx of [/View\s+[\d,]+\s+(Completed|Results)/i, /^show more/i]) {
      await page.evaluate((src) => {
        const re = new RegExp(src.slice(1, src.lastIndexOf("/")), "i");
        const el = Array.from(document.querySelectorAll("a,button")).find((e) => re.test((e.textContent || "").trim()));
        if (el) { el.scrollIntoView(); el.click(); }
      }, rx.toString());
      await page.waitForTimeout(4500);
    }

    // Their bootstrap config is usually inlined on the page; the taxonomy id lives there.
    const inline = await page.evaluate(() => {
      const out = {};
      for (const k of Object.keys(window)) {
        if (/bat|listing|filter|config/i.test(k)) {
          try {
            const v = window[k];
            if (v && typeof v === "object") out[k] = JSON.stringify(v).slice(0, 400);
          } catch {}
        }
      }
      return out;
    });
    log.info(`${request.url} -> ${captured.length} api calls, ${Object.keys(inline).length} globals`);
    for (const [k, v] of Object.entries(inline).slice(0, 6)) console.log(`   window.${k} = ${v}`);
  },
  failedRequestHandler({ request, log }) { log.warning(`FAILED ${request.url}`); },
});

crawler
  .run([
    "https://bringatrailer.com/porsche/911/",
    "https://bringatrailer.com/porsche/",
    "https://bringatrailer.com/auctions/results/",
  ])
  .then(() => {
    console.log("\n=== listings-filter CALLS, WITH PARAMETERS ===");
    const seen = new Set();
    for (const c of captured) {
      if (!/listings-filter/.test(c.url)) continue;
      const qs = c.url.split("?")[1] || "";
      const shape = [...new URLSearchParams(qs).keys()].sort().join(",");
      const key = c.from + shape;
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(`\nfrom ${c.from}`);
      console.log(`  ${c.method} params:`);
      for (const [k, v] of new URLSearchParams(qs)) console.log(`    ${k} = ${v}`);
      if (c.body) console.log(`  body: ${c.body}`);
    }

    console.log("\n=== all other wp-json endpoints seen ===");
    const others = [...new Set(captured.filter((c) => !/listings-filter/.test(c.url)).map((c) => c.url.split("?")[0]))];
    for (const u of others.slice(0, 25)) console.log(`  ${u}`);
  });
