// SECOND ENDPOINT, found in the page's own bootstrap config:
//   window.BAT_MODEL_FILTER = { url: ".../data/keyword-filter", nonce: "..." }
// This is what make/model pages (e.g. /porsche/911/) drive their charts and result lists
// from — i.e. it is the per-model archive, which is exactly the partition the paginated
// listings-filter endpoint refuses to give up.
//
// Also captured: window.BAT_MODEL_FILTER_CRITERIA.categories — the real taxonomy, where
// each entry is {text: "American", value: 3}. NUMERIC ids. That is why category=porsche
// returned 0 earlier: the server read the param and found no term named "porsche".
//
// This script harvests the full criteria object and then probes keyword-filter for its
// parameter shape and, critically, whether it is subject to the same ~10k offset cap.
//
// Usage: node crawler/probe-keyword-filter.js

const fs = require("fs");
const path = require("path");
const { PlaywrightCrawler } = require("crawlee");

const OUT = path.join(__dirname, "..", "samples", "bat-filter-criteria.json");
const KEYWORD_URL = "https://bringatrailer.com/wp-json/bringatrailer/1.0/data/keyword-filter";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bootstrap = null;

new PlaywrightCrawler({
  maxRequestsPerCrawl: 1,
  requestHandlerTimeoutSecs: 180,
  navigationTimeoutSecs: 120,
  async requestHandler({ page, log }) {
    await page.waitForTimeout(6000);
    bootstrap = await page.evaluate(() => ({
      criteria: window.BAT_MODEL_FILTER_CRITERIA || null,
      filter: window.BAT_MODEL_FILTER || null,
      ctx: window.BAT_CTX || null,
      // The page must know its own taxonomy identity somewhere — capture any embedded
      // keyword/term hints so the partition value format can be inferred rather than guessed.
      bodyHints: (document.body.innerHTML.match(/"(keyword|term_?id|category_?id|taxonomy)"\s*:\s*("[^"]{0,60}"|\d+)/g) || []).slice(0, 40),
    }));
    log.info(`criteria keys: ${bootstrap.criteria ? Object.keys(bootstrap.criteria).join(",") : "none"}`);
  },
})
  .run(["https://bringatrailer.com/porsche/911/"])
  .then(async () => {
    if (!bootstrap || !bootstrap.criteria) return console.log("no bootstrap captured");

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(bootstrap, null, 1));
    console.log(`\nWrote ${OUT}`);

    for (const [k, v] of Object.entries(bootstrap.criteria)) {
      console.log(`\ncriteria.${k}: ${Array.isArray(v) ? `${v.length} entries` : typeof v}`);
      if (Array.isArray(v)) for (const e of v.slice(0, 8)) console.log(`   ${JSON.stringify(e)}`);
    }
    console.log("\nbody hints:");
    for (const h of bootstrap.bodyHints.slice(0, 15)) console.log(`   ${h}`);

    // ---- probe keyword-filter itself ----
    const nonce = bootstrap.filter && bootstrap.filter.nonce;
    const HEADERS = {
      "User-Agent": "Mozilla/5.0 (compatible; price-index-research/1.0)",
      Accept: "application/json",
      Referer: "https://bringatrailer.com/porsche/911/",
      ...(nonce ? { "X-WP-Nonce": nonce } : {}),
    };

    const shapes = [
      ["keyword=porsche-911", "keyword=porsche-911"],
      ["keyword=Porsche 911", "keyword=" + encodeURIComponent("Porsche 911")],
      ["keyword + paging", "keyword=porsche-911&page=1&per_page=48&get_items=1&get_stats=1&sort=td"],
      ["keyword + stats only", "keyword=porsche-911&get_items=0&get_stats=1"],
      ["no keyword", "page=1&per_page=48&get_items=1&get_stats=0&sort=td"],
    ];

    console.log("\n=== keyword-filter probes ===");
    for (const [label, qs] of shapes) {
      try {
        const res = await fetch(`${KEYWORD_URL}?${qs}`, { headers: HEADERS });
        const body = await res.text();
        if (res.status !== 200) {
          console.log(`${label.padEnd(22)} HTTP ${res.status}  ${body.slice(0, 130).replace(/\s+/g, " ")}`);
        } else {
          const j = JSON.parse(body);
          const items = j.items || [];
          console.log(
            `${label.padEnd(22)} HTTP 200  total=${j.items_total}  pages=${j.pages_total}  items=${items.length}  keys=${Object.keys(j).filter((k) => k !== "items").join(",")}`
          );
          if (items[0]) {
            const t = String(items[0].title || "").replace(/<[^>]+>/g, "");
            const s = String(items[0].sold_text || "").replace(/<[^>]+>/g, "");
            console.log(`${" ".repeat(22)}   e.g. ${t.slice(0, 50)} | ${s.slice(0, 44)}`);
          }
        }
      } catch (e) {
        console.log(`${label.padEnd(22)} ERR ${e.message}`);
      }
      await sleep(1100); // robots.txt Crawl-delay: 1
    }
  });
