// THE RETAIL COMPLEMENT — the source class we have zero of.
//
// Every source scraped so far is an auction house: a hammer falls, money moves, we record what
// it SOLD for. Cars.com and Classic.com are different — cars sitting for sale with an asking
// price on them. That is where "4 listed" and the "For sale" badge come from, and it is the
// only input for months-of-supply, deal score and price-cut pressure.
//
// Two things to establish before building anything:
//   1. are they reachable, and what does robots.txt permit
//   2. what do they actually serve — listings, republished auction results, or both
//
// ⚠️ CLASSIC.COM IS AN AGGREGATOR. Ground truth §3: DriveIndex uses it but refuses to let it
// claim venue attribution — `"Classic.com" === e.v ? "Other venues" : e.v` — because it
// republishes other houses' results. So its rows are a DEDUP RISK, not just new data: a BaT
// sale we already hold can arrive again wearing a Classic.com label. Our SOURCE_TRUST already
// ranks classic lowest (9) so it always loses the survivor pick, which is the right posture.
//
// Usage: node crawler/probe-retail.js

const UA = "Mozilla/5.0 (compatible; price-index-research/1.0)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TARGETS = [
  { code: "classic", name: "Classic.com", robots: "https://www.classic.com/robots.txt",
    pages: ["https://www.classic.com/m/porsche/911/", "https://www.classic.com/search/?q=porsche+911"] },
  { code: "carscom", name: "Cars.com", robots: "https://www.cars.com/robots.txt",
    pages: ["https://www.cars.com/shopping/results/?makes[]=porsche&models[]=porsche-911"] },
];

(async () => {
  for (const t of TARGETS) {
    console.log(`\n=== ${t.name} (${t.code}) ===`);

    // robots.txt first — posture before payload.
    try {
      const r = await fetch(t.robots, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
      const body = await r.text();
      console.log(`  robots.txt HTTP ${r.status}`);
      const lines = body.split("\n").map((l) => l.trim());
      const star = [];
      let inStar = false;
      for (const l of lines) {
        if (/^user-agent:/i.test(l)) inStar = /\*\s*$/.test(l);
        else if (inStar && /^(disallow|allow|crawl-delay)/i.test(l)) star.push(l);
      }
      console.log(`  rules for *: ${star.length ? star.slice(0, 14).join(" | ") : "(none)"}`);
    } catch (e) {
      console.log(`  robots.txt FAILED: ${e.cause?.code || e.name}`);
    }
    await sleep(1500);

    for (const p of t.pages) {
      try {
        const r = await fetch(p, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(25000) });
        const html = await r.text();
        const prices = (html.match(/\$[\d,]{4,}/g) || []).length;
        const sold = (html.match(/\bsold\b/gi) || []).length;
        const forSale = (html.match(/for sale|asking/gi) || []).length;
        const cf = /just a moment|cf-browser-verification|challenge-platform/i.test(html);
        console.log(`  HTTP ${r.status}  ${(html.length / 1024).toFixed(0)} KB  prices=${prices} sold=${sold} forSale=${forSale}${cf ? "  <-- CLOUDFLARE CHALLENGE" : ""}`);
        console.log(`     ${p.slice(0, 92)}`);
      } catch (e) {
        console.log(`  FAILED ${p.slice(0, 70)}  ${e.cause?.code || e.name}`);
      }
      await sleep(2000);
    }
  }
})();
