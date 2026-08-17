// FAST list-mode harvester for Bring a Trailer.
//
// WHY THIS EXISTS — the throughput problem, measured:
//   detail-page mode : 1 page load per car, ~8s each at concurrency 3  ≈ 2.7s / record
//                      -> 110,000 records ≈ 80+ hours
//   list mode (this) : ~20 cars appear per "Show More" click, ~2s each ≈ 0.1s / record
//                      -> 110,000 records ≈ a few hours
//
// It works because BaT's results cards already carry everything the price index NEEDS:
//   "1971 Ferrari 365 GTB/4 Daytona Berlinetta  USA  Premium  182  70,373 Views
//    Sold for USD $865,000 on 8/8/2026"
// i.e. title, country, bid count, views, currency, PRICE and DATE — with no detail fetch.
//
// TRADE-OFF, stated plainly: list mode does NOT give VIN, mileage, colour or options. Those
// only exist on the detail page. So this is the right tool for building BREADTH (many cars,
// many sales each, which is what the valuation engine is starved of), and the detail crawler
// remains the right tool for DEPTH on cars that matter. Sales harvested this way are marked
// `harvest_mode: "list"` so the gaps are never mistaken for missing data.
//
// ⚠️ MEASURED CEILING — do not raise the click count past ~400.
//   120 clicks  -> ~3,000 records (~24 days of history)
//   400 clicks  -> ~8,700 records (~52 days)   <- practical maximum
//  1200 clicks  ->    141 records              <- WORSE, not better
// Past roughly 9,000 cards the page stops exposing the result text in
// document.body.innerText (virtualisation / memory pressure), so a longer run silently
// harvests LESS. 400 clicks is the sweet spot; deeper history is not reachable from this
// feed at all and needs a different mechanism (see notes/source-registry.md).
//
// Usage: node crawler/bat-list.crawler.js [showMoreClicks] [outFile]

const fs = require("fs");
const path = require("path");
const { PlaywrightCrawler } = require("crawlee");

const clicks = Number(process.argv[2]) || 40;
const outName = process.argv[3] || "bat-list.json";
const OUT = path.join(__dirname, "..", "samples", "scraped", outName);
fs.mkdirSync(path.dirname(OUT), { recursive: true });

function parseCard(text, href) {
  // "…Sold for USD $865,000 on 8/8/2026"  |  "…Bid to USD $50,000 on 8/8/2026"
  const sold = text.match(/Sold for\s+([A-Z]{3})?\s*\$?([\d,]+)\s+on\s+(\d{1,2}\/\d{1,2}\/\d{4})/i);
  const bid = text.match(/Bid to\s+([A-Z]{3})?\s*\$?([\d,]+)\s+on\s+(\d{1,2}\/\d{1,2}\/\d{4})/i);
  const m = sold || bid;
  if (!m) return null;

  const [mm, dd, yyyy] = m[3].split("/").map(Number);
  // Title is everything before the country/badge run — cut at the first all-caps country code
  // or at "Sold for"/"Bid to", whichever comes first.
  let title = text.split(/\s+(?:USA|CAN|GBR|DEU|ITA|JPN|AUS|CHE|FRA|NLD|ESP|SWE|Premium|Sold for|Bid to)\b/)[0].trim();
  title = title.replace(/^This Week's Popular Listings\s*/i, "").trim();

  return {
    source: "bat",
    source_lot_id: (href.match(/\/listing\/([^/?#]+)/) || [])[1] || null,
    url: href.split("?")[0],
    title,
    sold_at: new Date(Date.UTC(yyyy, mm - 1, dd, 12)).toISOString(),
    price: Number(m[2].replace(/,/g, "")),
    currency: m[1] || "USD",
    price_usd: (m[1] || "USD") === "USD" ? Number(m[2].replace(/,/g, "")) : null,
    mileage: null, vin_raw: null, vin_normal: null, color: null,
    transmission: null, tc: null, options: [], image_url: null,
    is_outlier: false, outlier_note: null, carfax_damage: false,
    non_us_sale: (m[1] || "USD") !== "USD",
    reserve_not_met: !sold,
    raw_source_shape: "bat-results-list-card-v1",
    harvest_mode: "list", // VIN/mileage/colour deliberately absent — see file header
    fetched_at: new Date().toISOString(),
  };
}

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: 1,
  requestHandlerTimeoutSecs: 900,
  navigationTimeoutSecs: 120,
  async requestHandler({ page, log }) {
    await page.waitForTimeout(4000);
    // Two different controls, and they are NOT equivalent — measured: clicking the "Results"
    // tab alone left the feed mostly LIVE auctions (1,380 cards visible, only 42 carrying a
    // sold price). The "View N Completed Auctions" control is the one that actually switches
    // the feed to the completed archive. Click both, completed-archive one first.
    const usedCompleted = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll("a,button")).find((e) =>
        /View\s+[\d,]+\s+Completed Auctions/i.test(e.textContent || ""));
      if (el) { el.click(); return true; }
      return false;
    });
    await page.waitForTimeout(3500);
    if (!usedCompleted) {
      await page.evaluate(() => {
        const t = Array.from(document.querySelectorAll("a,button")).find((e) => (e.textContent || "").trim().toLowerCase() === "results");
        if (t) t.click();
      });
      await page.waitForTimeout(3500);
    }
    log.info(`entry control used: ${usedCompleted ? "View N Completed Auctions" : "Results tab (fallback)"}`);

    let stagnant = 0;
    for (let i = 0; i < clicks; i++) {
      const before = await page.evaluate(() => document.querySelectorAll("a[href*='/listing/']").length);
      const clicked = await page.evaluate(() => {
        const el = Array.from(document.querySelectorAll("a,button")).find((e) => /^show more/i.test((e.textContent || "").trim()));
        if (el) { el.scrollIntoView(); el.click(); return true; }
        return false;
      });
      if (!clicked) break;
      await page.waitForTimeout(1900);
      const after = await page.evaluate(() => document.querySelectorAll("a[href*='/listing/']").length);
      if (after === before) { if (++stagnant >= 3) break; } else stagnant = 0;
      if (i % 10 === 0) log.info(`click ${i}: ${after} cards visible`);
    }

    // TEXT-SEQUENCE PARSING, not DOM-container walking.
    //
    // The first version walked up to 8 ancestors looking for one that held BOTH the listing
    // link and the price. It found only 42 of 403 listings — because on this page the price
    // is NOT inside the link's container; it sits in a sibling structure. Diagnosed with
    // crawler/diagnose-list.js: the page carried 449 "Sold for" strings and 403 unique
    // listings while the DOM walk returned 42. The data was always there; the selector was
    // wrong.
    //
    // What IS reliable is the repeating shape of the rendered text:
    //   "{title} {COUNTRY} [Premium] {bids} {views} Views Sold for USD ${price} on {M/D/YYYY}"
    // repeated once per result. So anchor on the result clause — which is highly regular —
    // and take each title as the run of text since the previous result ended. That depends
    // on a repeated pattern rather than on class names or DOM shape, so it survives a
    // frontend rebuild that would break any selector.
    const pageData = await page.evaluate(() => ({
      text: document.body.innerText.replace(/\s+/g, " "),
      hrefs: [...new Set(Array.from(document.querySelectorAll("a[href*='/listing/']")).map((a) => a.href.split("?")[0]))],
    }));

    const RESULT_RE = /(Sold for|Bid to)\s+([A-Z]{3})?\s*\$?([\d,]+)\s+on\s+(\d{1,2}\/\d{1,2}\/\d{4})/g;
    const segments = [];
    let cursor = 0, m;
    while ((m = RESULT_RE.exec(pageData.text)) !== null) {
      // Cap the lead. For the FIRST result the run of preceding text is the entire page
      // header ("Search Auctions Submit a Vehicle How BaT Works…"), which would otherwise
      // become the title. A real listing title is short, so keeping only the tail is both
      // correct and self-limiting.
      //
      // BUG FIX: a raw .slice(-140) cuts MID-WORD. It produced titles like "rtin DB5
      // Convertible" from "Aston Martin DB5 Convertible" — which then failed make extraction
      // and, worse, would have created a bogus car had it parsed. Always cut on a word
      // boundary; a corrupted title is exactly the "split/bad data" this pipeline must not
      // produce.
      let lead = pageData.text.slice(cursor, m.index).trim();
      if (lead.length > 140) lead = lead.slice(lead.length - 140).replace(/^\S*\s+/, "");
      segments.push({ lead, result: m[0] });
      cursor = m.index + m[0].length;
    }
    log.info(`result clauses found in page text: ${segments.length}  (unique listing links: ${pageData.hrefs.length})`);

    // Match each result to a listing URL by slug similarity — titles and slugs share tokens.
    const records = segments.map((seg, i) => {
      const rec = parseCard(`${seg.lead} ${seg.result}`, pageData.hrefs[i] || "");
      if (!rec) return null;
      const slugMatch = pageData.hrefs.find((h) => {
        const slug = (h.match(/\/listing\/([^/?#]+)/) || [])[1] || "";
        const t = rec.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        const words = t.split("-").filter((w) => w.length > 3).slice(0, 3);
        return words.length && words.every((w) => slug.includes(w));
      });
      if (slugMatch) {
        rec.url = slugMatch;
        rec.source_lot_id = (slugMatch.match(/\/listing\/([^/?#]+)/) || [])[1] || rec.source_lot_id;
      }
      return rec;
    }).filter((r) => r && r.title && r.title.length > 3);

    // merge with anything already harvested, keyed on the natural (source, lot) key
    let existing = [];
    try { existing = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch {}
    const byKey = new Map(existing.map((r) => [`${r.source}|${r.source_lot_id}`, r]));
    for (const r of records) byKey.set(`${r.source}|${r.source_lot_id}`, r);
    fs.writeFileSync(OUT, JSON.stringify([...byKey.values()], null, 1));
    log.info(`parsed ${records.length} priced records -> ${byKey.size} total on file`);
  },
});

crawler.run(["https://bringatrailer.com/auctions/results/"])
  .then(() => console.log(`\nWrote ${OUT}`))
  .catch((e) => console.log("ERR", e.message));
