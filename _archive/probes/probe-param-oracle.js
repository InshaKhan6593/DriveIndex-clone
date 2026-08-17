// PARAMETER DISCOVERY BY ORACLE — stop guessing, ask the server.
//
// Observed behaviour of this WP REST endpoint:
//   registered param + invalid value  ->  400 {"code":"rest_invalid_param","params":{"NAME":...}}
//   UNregistered param (any value)    ->  200, param silently ignored
//
// That asymmetry is a perfect membership oracle. Send NAME=@@@ (a value no sane param
// accepts) and read the reply:
//   400 naming NAME  -> NAME is real, and the error body usually states the allowed values
//   200              -> NAME does not exist; stop trying variations of it
//
// This turns "guess the spelling" into an enumeration, and — because WP echoes the enum in
// the error — it also hands over the legal values for free.
//
// Usage: node crawler/probe-param-oracle.js

const LISTINGS = "https://bringatrailer.com/wp-json/bringatrailer/1.0/data/listings-filter";
const KEYWORD = "https://bringatrailer.com/wp-json/bringatrailer/1.0/data/keyword-filter";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; price-index-research/1.0)",
  Accept: "application/json",
  Referer: "https://bringatrailer.com/auctions/results/",
};
const CRAWL_DELAY_MS = 1100; // robots.txt: Crawl-delay: 1
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CANDIDATES = [
  // paging / shape
  "page", "per_page", "results", "offset", "get_items", "get_stats", "sort",
  // taxonomy & text
  "category", "categories", "keyword", "keywords", "search", "s", "q", "term", "terms",
  "make", "makes", "model", "models", "marque", "brand", "tag", "tags", "taxonomy", "slug",
  // state / type
  "state", "states", "status", "type", "types", "premium", "noreserve", "no_reserve", "reserve",
  // numeric / temporal
  "year", "years", "year_min", "year_max", "minyear", "maxyear",
  "range", "ranges", "date", "date_from", "date_to", "after", "before", "since", "until",
  "min_bid", "max_bid", "minimum_bids", "maximum_bids", "bid_min", "bid_max", "price_min", "price_max",
  // misc levers worth knowing about
  "featured", "country", "location", "seller", "include", "exclude", "ids", "post__in",
];

// A value no legitimate param accepts: not a number, not a slug, not an enum member.
const POISON = "@@@__probe__@@@";

async function ask(base, name) {
  // Keep every REQUIRED param valid so a 400 can only be caused by the param under test.
  const required = base === KEYWORD ? "page=1&results=1" : "page=1&per_page=48&get_items=1&get_stats=0&sort=td";
  const qs = `${required}&${encodeURIComponent(name)}=${encodeURIComponent(POISON)}`;
  try {
    const res = await fetch(`${base}?${qs}`, { headers: HEADERS });
    const body = await res.text();
    if (res.status === 200) {
      const j = JSON.parse(body);
      return { real: false, total: j.items_total };
    }
    let detail = "";
    try {
      const j = JSON.parse(body);
      const p = j.data && j.data.params;
      // WP echoes the allowed enum in the per-param message — that is the payload we want.
      detail = p ? (typeof p[name] === "string" ? p[name] : JSON.stringify(p)) : j.message || "";
      // A 400 that does NOT name our param means we broke a required param instead.
      if (p && !(name in p) && !(j.message || "").includes(name)) return { real: false, note: `400 (other): ${detail.slice(0, 60)}` };
    } catch {
      detail = body.slice(0, 120);
    }
    return { real: true, detail: detail.replace(/\s+/g, " ").slice(0, 175) };
  } catch (e) {
    return { real: false, note: `ERR ${e.message}` };
  }
}

(async () => {
  for (const [label, base] of [["listings-filter", LISTINGS], ["keyword-filter", KEYWORD]]) {
    console.log(`\n=== ${label} — registered parameters ===`);
    const real = [];
    for (const name of CANDIDATES) {
      const r = await ask(base, name);
      if (r.real) {
        real.push(name);
        console.log(`  [REAL] ${name.padEnd(14)} ${r.detail}`);
      }
      await sleep(CRAWL_DELAY_MS);
    }
    console.log(`\n  ${real.length} registered: ${real.join(", ")}`);
    console.log(`  (all other candidates returned 200 = silently ignored = do not exist)`);
  }
})();
