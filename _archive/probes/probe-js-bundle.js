// Stop guessing `results`. Read the code that calls the endpoint.
//
// window.BAT_MODEL_FILTER points at .../data/keyword-filter, so some shipped JS bundle
// builds that query string. Minified or not, the parameter NAMES survive minification —
// they are string literals in the request payload. Pull every script the model page loads
// and grep for the call site.
//
// Usage: node crawler/probe-js-bundle.js

const fs = require("fs");
const path = require("path");
const { PlaywrightCrawler } = require("crawlee");

const OUT = path.join(__dirname, "..", "samples", "bat-js-callsite.txt");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let scripts = [];

new PlaywrightCrawler({
  maxRequestsPerCrawl: 1,
  requestHandlerTimeoutSecs: 120,
  navigationTimeoutSecs: 120,
  async requestHandler({ page, log }) {
    await page.waitForTimeout(5000);
    scripts = await page.evaluate(() =>
      Array.from(document.querySelectorAll("script[src]"))
        .map((s) => s.src)
        .filter((u) => /bringatrailer|bat/i.test(u))
    );
    log.info(`${scripts.length} candidate scripts`);
  },
})
  .run(["https://bringatrailer.com/porsche/911/"])
  .then(async () => {
    const found = [];
    for (const url of scripts) {
      try {
        const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; price-index-research/1.0)" } });
        if (res.status !== 200) continue;
        const js = await res.text();
        if (!/keyword-filter|keywordFilter|listings-filter/i.test(js)) continue;

        console.log(`\n### HIT ${url.split("/").pop()}  (${(js.length / 1024).toFixed(0)} KB)`);
        found.push(url);

        // Show generous context around every mention so the query-building code is visible.
        for (const m of js.matchAll(/keyword-filter|keywordFilter/g)) {
          const s = Math.max(0, m.index - 700);
          const chunk = js.slice(s, m.index + 900);
          console.log("\n--- context ---");
          console.log(chunk.replace(/\s+/g, " ").slice(0, 1500));
          fs.appendFileSync(OUT, `\n\n=== ${url} @${m.index} ===\n${chunk}`);
        }

        // The param names appear as literals; surface any object that mentions `results`
        // alongside the other known params so the expected shape is unambiguous.
        for (const m of js.matchAll(/results\s*[:=]\s*[^,;}]{0,60}/g)) {
          const ctx = js.slice(Math.max(0, m.index - 220), m.index + 220).replace(/\s+/g, " ");
          if (/per_page|page|sort|category|state|range|keyword/.test(ctx)) {
            console.log(`\n--- 'results' near known params ---\n${ctx.slice(0, 440)}`);
            fs.appendFileSync(OUT, `\n\n=== results-ctx ${url} ===\n${ctx}`);
          }
        }
      } catch (e) {
        console.log(`  fetch failed ${url.split("/").pop()}: ${e.message}`);
      }
      await sleep(400);
    }

    if (!found.length) {
      console.log("\nNo bundle referenced the endpoint. Scripts seen:");
      for (const s of scripts) console.log(`  ${s}`);
    } else {
      console.log(`\nAppended raw context to ${OUT}`);
    }
  });
