// SEARCH-WINDOWED harvester — the scalable path to deep history.
//
// WHY: BaT's results feed only paginates forward from the newest sale. Measured, 120 clicks
// reached ~3,000 records covering just 24 days. DriveIndex's 110,043 sales is roughly 2.4
// YEARS of BaT at ~125 sales/day, which a single session cannot reach — the DOM would have
// to hold 100k+ cards.
//
// URL windowing was probed and mostly does not exist:
//   ?page=5, ?paged=5, /page/5/, ?end_date_from=..&end_date_to=..   -> all IGNORED
//   ?s={query}                                                      -> WORKS
//
// So search is the only windowing primitive. That turns out to be the better axis anyway:
// searching by MAKE deepens cars we already hold (more sales each) rather than only
// discovering new ones — and sales-per-car is exactly what the valuation engine is starved
// of. Each query is an independent, restartable, parallelisable job.
//
// Usage: node crawler/bat-search.crawler.js "porsche" 60 bat-porsche.json

const fs = require("fs");
const path = require("path");
const { PlaywrightCrawler } = require("crawlee");

const query = process.argv[2] || "porsche";
const clicks = Number(process.argv[3]) || 40;
const outName = process.argv[4] || `bat-search-${query.replace(/\W+/g, "-")}.json`;
const OUT = path.join(__dirname, "..", "samples", "scraped", outName);
fs.mkdirSync(path.dirname(OUT), { recursive: true });

function parseCard(text, href) {
  const sold = text.match(/Sold for\s+([A-Z]{3})?\s*\$?([\d,]+)\s+on\s+(\d{1,2}\/\d{1,2}\/\d{4})/i);
  const bid = text.match(/Bid to\s+([A-Z]{3})?\s*\$?([\d,]+)\s+on\s+(\d{1,2}\/\d{1,2}\/\d{4})/i);
  const m = sold || bid;
  if (!m) return null;
  const [mm, dd, yyyy] = m[3].split("/").map(Number);
  let title = text.split(/\s+(?:USA|CAN|GBR|DEU|ITA|JPN|AUS|CHE|FRA|NLD|ESP|SWE|Premium|Sold for|Bid to)\b/)[0].trim();
  title = title.replace(/^This Week's Popular Listings\s*/i, "").trim();
  return {
    source: "bat",
    source_lot_id: (href.match(/\/listing\/([^/?#]+)/) || [])[1] || null,
    url: href.split("?")[0], title,
    sold_at: new Date(Date.UTC(yyyy, mm - 1, dd, 12)).toISOString(),
    price: Number(m[2].replace(/,/g, "")),
    currency: m[1] || "USD",
    price_usd: (m[1] || "USD") === "USD" ? Number(m[2].replace(/,/g, "")) : null,
    mileage: null, vin_raw: null, vin_normal: null, color: null,
    transmission: null, tc: null, options: [], image_url: null,
    is_outlier: false, outlier_note: null, carfax_damage: false,
    non_us_sale: (m[1] || "USD") !== "USD",
    reserve_not_met: !sold,
    raw_source_shape: "bat-search-results-v1",
    harvest_mode: "list", search_query: query,
    fetched_at: new Date().toISOString(),
  };
}

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: 1, requestHandlerTimeoutSecs: 900, navigationTimeoutSecs: 120,
  async requestHandler({ page, log }) {
    await page.waitForTimeout(4000);
    let stagnant = 0;
    for (let i = 0; i < clicks; i++) {
      const before = await page.evaluate(() => (document.body.innerText.match(/Sold for|Bid to/gi) || []).length);
      const clicked = await page.evaluate(() => {
        const el = Array.from(document.querySelectorAll("a,button")).find((e) => /^show more/i.test((e.textContent || "").trim()));
        if (el) { el.scrollIntoView(); el.click(); return true; }
        return false;
      });
      if (!clicked) break;
      await page.waitForTimeout(1900);
      const after = await page.evaluate(() => (document.body.innerText.match(/Sold for|Bid to/gi) || []).length);
      if (after === before) { if (++stagnant >= 3) break; } else stagnant = 0;
      if (i % 20 === 0) log.info(`[${query}] click ${i}: ${after} results`);
    }

    const pageData = await page.evaluate(() => ({
      text: document.body.innerText.replace(/\s+/g, " "),
      hrefs: [...new Set(Array.from(document.querySelectorAll("a[href*='/listing/']")).map((a) => a.href.split("?")[0]))],
    }));

    const RE = /(Sold for|Bid to)\s+([A-Z]{3})?\s*\$?([\d,]+)\s+on\s+(\d{1,2}\/\d{1,2}\/\d{4})/g;
    const segs = []; let cursor = 0, m;
    while ((m = RE.exec(pageData.text)) !== null) {
      let lead = pageData.text.slice(cursor, m.index).trim();
      if (lead.length > 140) lead = lead.slice(lead.length - 140).replace(/^\S*\s+/, "");
      segs.push({ lead, result: m[0] });
      cursor = m.index + m[0].length;
    }

    const records = segs.map((s, i) => {
      const rec = parseCard(`${s.lead} ${s.result}`, pageData.hrefs[i] || "");
      if (!rec) return null;
      const match = pageData.hrefs.find((h) => {
        const slug = (h.match(/\/listing\/([^/?#]+)/) || [])[1] || "";
        const words = rec.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").split("-").filter((w) => w.length > 3).slice(0, 3);
        return words.length && words.every((w) => slug.includes(w));
      });
      if (match) { rec.url = match; rec.source_lot_id = (match.match(/\/listing\/([^/?#]+)/) || [])[1] || rec.source_lot_id; }
      return rec;
    }).filter((r) => r && r.title && r.title.length > 3);

    let existing = [];
    try { existing = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch {}
    const byKey = new Map(existing.map((r) => [`${r.source}|${r.source_lot_id}`, r]));
    for (const r of records) byKey.set(`${r.source}|${r.source_lot_id}`, r);
    fs.writeFileSync(OUT, JSON.stringify([...byKey.values()], null, 1));
    log.info(`[${query}] parsed ${records.length} -> ${byKey.size} on file`);
  },
});

crawler.run([`https://bringatrailer.com/auctions/results/?s=${encodeURIComponent(query)}`])
  .then(() => console.log(`Wrote ${OUT}`))
  .catch((e) => console.log("ERR", e.message));
