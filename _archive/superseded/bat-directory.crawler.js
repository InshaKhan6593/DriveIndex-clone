// Scrapes Bring a Trailer's own "Makes and Models" directory.
//
// This is the mapping built FROM THE SOURCE, not from a competitor. BaT is ~72% of the
// source mix by model-year (ground truth §3), so its taxonomy is the closest thing to an
// authoritative list of what actually trades. Whatever it lists is in scope; whatever it
// doesn't is a candidate for review.
//
// Output: samples/raw/bat-directory.json  { makes: [...], models: { make: [models] } }
// Usage: node crawler/bat-directory.crawler.js

const fs = require("fs");
const path = require("path");
const { PlaywrightCrawler } = require("crawlee");

const OUT = path.join(__dirname, "..", "samples", "raw", "bat-directory.json");
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const result = { makes: [], models: {}, scrapedAt: null };

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: 1,
  requestHandlerTimeoutSecs: 90,
  async requestHandler({ page, log }) {
    await page.waitForTimeout(5000);

    // Expand anything collapsed
    for (let i = 0; i < 5; i++) {
      const clicked = await page.evaluate(() => {
        const el = Array.from(document.querySelectorAll("a,button")).find((e) =>
          /show (all|more)|view all|expand/i.test((e.textContent || "").trim())
        );
        if (el) { el.click(); return true; }
        return false;
      });
      if (!clicked) break;
      await page.waitForTimeout(1500);
    }

    // BaT model URLs are /{make}/{model}/ ; make hubs are /{make}/
    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a[href]"))
        .map((a) => a.getAttribute("href"))
        .filter(Boolean)
        .map((h) => (h.startsWith("http") ? h.replace(/^https?:\/\/[^/]+/, "") : h))
    );

    const IGNORE = new Set(["auctions", "listing", "member", "account", "stories", "podcast",
      "events", "shipping", "about", "contact", "search", "categories", "locations",
      "makes-and-models", "how-bat-works", "submit", "gear", "alerts", "local-partners",
      "verified-checkout", "wp-content", "wp-json", "privacy", "terms", "sitemap", "en", "es"]);

    const makes = new Set();
    const models = {};
    for (const h of links) {
      const parts = h.split("?")[0].split("#")[0].split("/").filter(Boolean);
      if (parts.length === 1 && !IGNORE.has(parts[0]) && /^[a-z0-9-]+$/.test(parts[0])) {
        makes.add(parts[0]);
      } else if (parts.length === 2 && !IGNORE.has(parts[0]) && /^[a-z0-9-]+$/.test(parts[0]) && /^[a-z0-9-]+$/.test(parts[1])) {
        makes.add(parts[0]);
        (models[parts[0]] ||= new Set()).add(parts[1]);
      }
    }

    result.makes = [...makes].sort();
    result.models = Object.fromEntries(Object.entries(models).map(([k, v]) => [k, [...v].sort()]));
    result.scrapedAt = new Date().toISOString();

    const modelCount = Object.values(result.models).reduce((a, v) => a + v.length, 0);
    log.info(`makes: ${result.makes.length} | model entries: ${modelCount}`);
  },
});

(async () => {
  await crawler.run(["https://bringatrailer.com/makes-and-models/"]);
  fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
  console.log(`Wrote ${result.makes.length} makes and ${Object.values(result.models).reduce((a, v) => a + v.length, 0)} models to ${OUT}`);
})();
