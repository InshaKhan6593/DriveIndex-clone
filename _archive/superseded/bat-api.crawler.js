// BaT JSON API harvester — replaces DOM scraping entirely.
//
// Discovered by capturing the site's own XHR (crawler/probe-api.js), after their robots.txt
// exposed the wp-json namespace:
//   /wp-json/bringatrailer/1.0/data/listings-filter?page=N&per_page=36&get_items=1&get_stats=0&sort=X
//
// WHY THIS BEATS THE DOM CRAWLER
//   • structured JSON — no regex over innerText, no virtualisation limits
//   • ~36 records per request instead of clicking "Show More" and hoping
//   • carries BaT's own `repeat` flag (their repeat-sale marker) for free
//
// THE CEILING, AND HOW TO GET AROUND IT
// The API reports items_total = 257,919 but refuses to paginate past ~page 277
// (~10,000 records). Measured: page 250 -> 36 items, page 300 -> 0 items.
//
// The way through is SORT DIRECTION, found by probing:
//   sort=td  -> newest first -> the ~10k most recent  (first item 8/14/2026)
//   sort=ta  -> OLDEST first -> the ~10k oldest       (first item 7/30/2014)
// So each sort direction opens its own 10k window at opposite ends of a 12-year archive.
// Running both roughly doubles coverage AND — far more valuable — the `ta` half is genuine
// historical data, which is what repeat-sale signals actually need.
//
// Respects the Crawl-delay: 1 declared in their robots.txt.
//
// Usage: node crawler/bat-api.crawler.js [sort=td|ta] [maxPages] [outFile]

const fs = require("fs");
const path = require("path");

const sort = process.argv[2] || "td";
const maxPages = Number(process.argv[3]) || 270;
const outName = process.argv[4] || `bat-api-${sort}.json`;
const OUT = path.join(__dirname, "..", "samples", "scraped", outName);
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const BASE = "https://bringatrailer.com/wp-json/bringatrailer/1.0/data/listings-filter";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; price-index-research/1.0)",
  "Accept": "application/json",
  "Referer": "https://bringatrailer.com/auctions/results/",
};
const CRAWL_DELAY_MS = 1100; // robots.txt: Crawl-delay: 1

const stripTags = (s) => String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

function adapt(item) {
  // "Sold for USD $45,500 on 7/30/2014"  |  "Bid to USD $8,000 on 8/14/2026"
  const text = stripTags(item.sold_text);
  const m = text.match(/(Sold for|Bid to)\s+([A-Z]{3})?\s*\$?([\d,]+)\s+on\s+(\d{1,2}\/\d{1,2}\/\d{4})/i);
  if (!m) return null;

  const [mm, dd, yyyy] = m[4].split("/").map(Number);
  const price = Number(m[3].replace(/,/g, ""));
  const currency = m[2] || "USD";
  const soldAt = item.sold_text_timestamp
    ? new Date(item.sold_text_timestamp * 1000).toISOString()
    : new Date(Date.UTC(yyyy, mm - 1, dd, 12)).toISOString();

  return {
    source: "bat",
    source_lot_id: item.id != null ? String(item.id) : (String(item.url || "").match(/\/listing\/([^/?#]+)/) || [])[1] || null,
    url: String(item.url || "").split("?")[0],
    title: stripTags(item.title),
    sold_at: soldAt,
    price,
    currency,
    price_usd: currency === "USD" ? price : null,
    mileage: null, vin_raw: null, vin_normal: null, color: null,
    transmission: null, tc: null, options: [],
    image_url: item.thumbnail_url || null,
    is_outlier: false, outlier_note: null, carfax_damage: false,
    non_us_sale: (item.country_code && item.country_code !== "US") || currency !== "USD",
    reserve_not_met: !/sold for/i.test(text),
    raw_source_shape: "bat-wp-json-listings-filter-v1",
    harvest_mode: "api",
    fetched_at: new Date().toISOString(),
    _extra: {
      views: item.views ?? null,
      watchers: item.watchers ?? null,
      country: item.country || null,
      noreserve: Boolean(item.noreserve),
      premium: Boolean(item.premium),
      // BaT's OWN repeat-sale marker — worth keeping; it is independent corroboration for
      // our VIN-based repeat detection.
      bat_repeat: item.repeat ?? null,
    },
  };
}

(async () => {
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch {}
  const byKey = new Map(existing.map((r) => [`${r.source}|${r.source_lot_id}`, r]));
  const startCount = byKey.size;

  let emptyStreak = 0;
  for (let page = 1; page <= maxPages; page++) {
    const url = `${BASE}?page=${page}&per_page=36&get_items=1&get_stats=0&sort=${sort}`;
    let json;
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.status !== 200) { console.log(`page ${page}: HTTP ${res.status} — stopping`); break; }
      json = await res.json();
    } catch (e) { console.log(`page ${page}: ${e.message} — stopping`); break; }

    const items = json.items || [];
    if (items.length === 0) {
      if (++emptyStreak >= 2) { console.log(`page ${page}: empty twice — reached the API ceiling`); break; }
    } else emptyStreak = 0;

    let added = 0;
    for (const it of items) {
      const rec = adapt(it);
      if (!rec || !rec.source_lot_id) continue;
      const k = `${rec.source}|${rec.source_lot_id}`;
      if (!byKey.has(k)) added++;
      byKey.set(k, rec);
    }

    if (page % 25 === 0 || page === 1) {
      const first = items[0] ? stripTags(items[0].sold_text).slice(0, 46) : "-";
      console.log(`[${sort}] page ${String(page).padStart(3)}  +${String(added).padStart(2)}  total ${byKey.size}  | ${first}`);
      fs.writeFileSync(OUT, JSON.stringify([...byKey.values()], null, 1)); // checkpoint
    }
    await new Promise((r) => setTimeout(r, CRAWL_DELAY_MS));
  }

  fs.writeFileSync(OUT, JSON.stringify([...byKey.values()], null, 1));
  const all = [...byKey.values()].map((r) => r.sold_at.slice(0, 10)).sort();
  console.log(`\n[${sort}] ${byKey.size} records (+${byKey.size - startCount} new)`);
  console.log(`[${sort}] date range ${all[0]} -> ${all[all.length - 1]}`);
  console.log(`Wrote ${OUT}`);
})();
