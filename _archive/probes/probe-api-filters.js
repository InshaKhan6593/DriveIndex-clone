// THE CEILING PROBLEM, AND THE ONLY WAY THROUGH IT.
//
// listings-filter reports items_total ~258,000 but refuses to paginate past ~page 277
// (~10,000 records). Sort direction buys two windows at opposite ends of the archive
// (td = newest 10k, ta = oldest 10k) — which is why the corpus currently holds 2014-2018
// and 2026, and NOTHING from 2019-2025.
//
// More pagination cannot fix that; the window is a server-side cap on offset. The way
// through is to PARTITION: if a filter narrows the result set below the cap, every record
// inside that partition becomes reachable, and the union of partitions covers the archive.
//
// This script asks the endpoint which parameters it honours. A probe "counts" only if it
// CHANGES items_total — a param the server ignores silently returns the unfiltered total,
// which is the tell. A 400 means the param is rejected outright, which is also information.
//
// NOTE ON per_page / get_stats: the server validates these strictly. per_page=3 and
// get_stats=1 both 400. Probes therefore hold them at the known-good 36 / 0 so that a 400
// can only be caused by the parameter under test.
//
// Usage: node crawler/probe-api-filters.js

const BASE = "https://bringatrailer.com/wp-json/bringatrailer/1.0/data/listings-filter";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; price-index-research/1.0)",
  Accept: "application/json",
  Referer: "https://bringatrailer.com/auctions/results/",
};
const CRAWL_DELAY_MS = 1100; // robots.txt: Crawl-delay: 1

const stripTags = (s) => String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(qs) {
  try {
    const res = await fetch(`${BASE}?${qs}`, { headers: HEADERS });
    if (res.status !== 200) {
      const b = await res.text();
      return { note: `HTTP ${res.status} ${b.slice(0, 90).replace(/\s+/g, " ")}` };
    }
    const j = await res.json();
    const items = j.items || [];
    return {
      total: j.items_total ?? null,
      returned: items.length,
      first: items[0] ? stripTags(items[0].title).slice(0, 34) : "-",
      when: items[0] ? (stripTags(items[0].sold_text).match(/\d{1,2}\/\d{1,2}\/\d{4}/) || ["-"])[0] : "-",
      envelope: Object.keys(j).filter((k) => k !== "items"),
    };
  } catch (e) {
    return { note: `ERR ${e.message}` };
  }
}

(async () => {
  const GOOD = "page=1&per_page=36&get_items=1&get_stats=0&sort=td";

  const groups = {
    "— envelope & validation —": [
      ["BASELINE", GOOD],
      ["get_stats=1", GOOD.replace("get_stats=0", "get_stats=1")],
      ["per_page=48", GOOD.replace("per_page=36", "per_page=48")],
      ["per_page=96", GOOD.replace("per_page=36", "per_page=96")],
      ["per_page=100", GOOD.replace("per_page=36", "per_page=100")],
      ["per_page=250", GOOD.replace("per_page=36", "per_page=250")],
    ],
    "— make / model partition —": [
      ["make=porsche", `${GOOD}&make=porsche`],
      ["makes=porsche", `${GOOD}&makes=porsche`],
      ["keyword=porsche", `${GOOD}&keyword=porsche`],
      ["search=porsche", `${GOOD}&search=porsche`],
      ["s=porsche", `${GOOD}&s=porsche`],
      ["q=porsche", `${GOOD}&q=porsche`],
      ["category=porsche", `${GOOD}&category=porsche`],
      ["categories=porsche", `${GOOD}&categories=porsche`],
      ["term=porsche", `${GOOD}&term=porsche`],
      ["taxonomy=porsche", `${GOOD}&taxonomy=porsche`],
    ],
    "— year / date partition —": [
      ["year=1990", `${GOOD}&year=1990`],
      ["year_min+max", `${GOOD}&year_min=1990&year_max=1990`],
      ["yearfrom+to", `${GOOD}&yearfrom=1990&yearto=1990`],
      ["date_from+to", `${GOOD}&date_from=2021-01-01&date_to=2021-12-31`],
      ["after+before", `${GOOD}&after=2021-01-01&before=2021-12-31`],
    ],
    "— offset & alternate sorts —": [
      ["offset=20000", `offset=20000&per_page=36&get_items=1&get_stats=0&sort=td`],
      ["page=400", GOOD.replace("page=1", "page=400")],
      ["sort=pd", GOOD.replace("sort=td", "sort=pd")],
      ["sort=pa", GOOD.replace("sort=td", "sort=pa")],
      ["sort=bd", GOOD.replace("sort=td", "sort=bd")],
    ],
  };

  let baseline = null;
  for (const [heading, probes] of Object.entries(groups)) {
    console.log(`\n${heading}`);
    console.log("label              items_total  ret  first item                          date");
    for (const [label, qs] of probes) {
      const r = await probe(qs);
      if (label === "BASELINE") baseline = r.total;
      if (r.note) console.log(`${label.padEnd(18)} ${r.note}`);
      else {
        const flag = baseline != null && r.total !== baseline ? "  <-- HONOURED" : "";
        console.log(
          `${label.padEnd(18)} ${String(r.total).padStart(10)}  ${String(r.returned).padStart(3)}  ${r.first.padEnd(34)} ${r.when}${flag}`
        );
      }
      await sleep(CRAWL_DELAY_MS);
    }
  }

  const b = await probe("page=1&per_page=36&get_items=1&get_stats=0&sort=td");
  console.log(`\nenvelope keys: ${(b.envelope || []).join(", ")}`);
})();
