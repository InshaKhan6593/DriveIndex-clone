// Fast make/model harvester. Collects LISTING URLS ONLY — never visits detail pages — so it
// can cover thousands of vehicles in the time a detail crawl covers dozens.
//
// BaT listing slugs are machine-generated as {year}-{make}-{model...}, e.g.
//   /listing/2004-porsche-911-carrera-4s-cabriolet-86/
// which makes the URL corpus a cheap, high-volume census of the makes and models that
// actually trade — built from the SOURCE itself, not from any competitor's catalogue.
//
// Usage: node crawler/harvest-urls.js [showMoreClicks]

const fs = require("fs");
const path = require("path");
const { PlaywrightCrawler } = require("crawlee");

const clicks = Number(process.argv[2]) || 60;
const OUT = path.join(__dirname, "..", "samples", "raw", "harvested-urls.json");
fs.mkdirSync(path.dirname(OUT), { recursive: true });

let urls = [];
try { urls = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch {}

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: 1,
  requestHandlerTimeoutSecs: 600,
  navigationTimeoutSecs: 120,
  async requestHandler({ page, log }) {
    await page.waitForTimeout(4000);
    await page.evaluate(() => {
      const tab = Array.from(document.querySelectorAll("a,button")).find(
        (e) => (e.textContent || "").trim().toLowerCase() === "results");
      if (tab) tab.click();
    });
    await page.waitForTimeout(3000);

    let stagnant = 0;
    for (let i = 0; i < clicks; i++) {
      const before = await page.evaluate(() => document.querySelectorAll("a[href*='/listing/']").length);
      const clicked = await page.evaluate(() => {
        const el = Array.from(document.querySelectorAll("a,button")).find((e) => /^show more/i.test((e.textContent || "").trim()));
        if (el) { el.scrollIntoView(); el.click(); return true; }
        return false;
      });
      if (!clicked) break;
      await page.waitForTimeout(1800);
      const after = await page.evaluate(() => document.querySelectorAll("a[href*='/listing/']").length);
      if (after === before) { if (++stagnant >= 3) break; } else stagnant = 0;
      if (i % 10 === 0) log.info(`click ${i}: ${after} listing links visible`);
    }

    const found = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a[href*='/listing/']")).map((a) => a.href));
    log.info(`harvested ${found.length} raw links`);
    urls = [...new Set([...urls, ...found])];
  },
});

(async () => {
  await crawler.run(["https://bringatrailer.com/auctions/results/"]);
  fs.writeFileSync(OUT, JSON.stringify(urls, null, 0));
  console.log(`Total unique listing URLs on file: ${urls.length}`);
})();
