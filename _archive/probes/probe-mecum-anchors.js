// Mecum event pages render 98 lot anchors and ~23 prices, but my /lots/{id} selector matched
// zero — so the anchor shape is something else. Read the actual markup instead of guessing:
// dump real hrefs, the repeating card structure, and where the price sits relative to the link.
//
// Usage: node crawler/probe-mecum-anchors.js

const { PlaywrightCrawler } = require("crawlee");

new PlaywrightCrawler({
  maxRequestsPerCrawl: 1,
  maxRequestRetries: 0,
  requestHandlerTimeoutSecs: 180,
  navigationTimeoutSecs: 120,
  async requestHandler({ page, log }) {
    await page.waitForTimeout(9000);
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2500);
    }

    const d = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll("a[href]"));
      // Group hrefs by shape so the lot pattern is obvious rather than assumed.
      const shapes = {};
      for (const a of anchors) {
        const h = a.getAttribute("href") || "";
        const shape = h
          .replace(/\d+/g, "#")
          .replace(/[a-z0-9]{8,}/gi, "*")
          .slice(0, 60);
        (shapes[shape] = shapes[shape] || { n: 0, sample: h }).n++;
      }
      const top = Object.entries(shapes).sort((a, b) => b[1].n - a[1].n).slice(0, 12)
        .map(([s, v]) => `${String(v.n).padStart(4)}  ${s}   e.g. ${v.sample.slice(0, 70)}`);

      // Where do prices live? Find an element whose text is just a price, and describe its
      // ancestry — that tells us how to pair price with title.
      const priceEls = Array.from(document.querySelectorAll("*"))
        .filter((e) => e.children.length === 0 && /^\$[\d,]{4,}$/.test((e.textContent || "").trim()))
        .slice(0, 3);
      const priceCtx = priceEls.map((e) => {
        let p = e, chain = [];
        for (let i = 0; i < 5 && p; i++) { chain.push(`${p.tagName.toLowerCase()}.${(p.className || "").toString().split(/\s+/)[0] || "-"}`); p = p.parentElement; }
        const card = e.closest("li,article,div");
        return { price: e.textContent.trim(), chain: chain.join(" < "), card: (card ? card.innerText : "").replace(/\s+/g, " ").slice(0, 150) };
      });

      return { totalAnchors: anchors.length, top, priceCtx, bodySample: document.body.innerText.replace(/\s+/g, " ").slice(0, 400) };
    });

    log.info(`anchors: ${d.totalAnchors}`);
    console.log("\n=== HREF SHAPES ===");
    for (const s of d.top) console.log("  " + s);
    console.log("\n=== PRICE ELEMENT CONTEXT ===");
    for (const p of d.priceCtx) {
      console.log(`  ${p.price}`);
      console.log(`     ancestry: ${p.chain}`);
      console.log(`     card:     ${p.card}`);
    }
    console.log("\n=== BODY TEXT SAMPLE ===");
    console.log("  " + d.bodySample);
  },
}).run(["https://www.mecum.com/auctions/kissimmee-2022/lots/"]);
