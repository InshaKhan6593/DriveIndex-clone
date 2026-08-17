// The captured criteria object (samples/bat-filter-criteria.json) exposes FIVE filter axes,
// each a potential partition key for getting under the ~10k offset cap:
//
//   categories  39 numeric term ids  (American=3, British=4, German=..., etc.)
//   ranges      7D / 30D / 1Y / 2Y / 5Y / "" (all time)   <- slices the exact axis we lack
//   sorts       td, ta, vd (popularity), bd (highest bid) <- FOUR windows, not two
//   states      sold / unsold
//   types       premium / no-reserve
//
// And keyword-filter named its own required params in the 400 body: `page` and `results`.
//
// This script establishes, for each axis: (a) is it honoured, (b) what parameter spelling,
// (c) does it drop items_total below the reachable window. Only (c) actually matters —
// a filter that narrows to 9,000 is a solved partition; one that narrows to 40,000 is not.
//
// Usage: node crawler/probe-partitions.js

const fs = require("fs");
const path = require("path");

const LISTINGS = "https://bringatrailer.com/wp-json/bringatrailer/1.0/data/listings-filter";
const KEYWORD = "https://bringatrailer.com/wp-json/bringatrailer/1.0/data/keyword-filter";
const CRITERIA = path.join(__dirname, "..", "samples", "bat-filter-criteria.json");

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; price-index-research/1.0)",
  Accept: "application/json",
  Referer: "https://bringatrailer.com/auctions/results/",
};
const CRAWL_DELAY_MS = 1100; // robots.txt: Crawl-delay: 1
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

async function hit(base, qs) {
  try {
    const res = await fetch(`${base}?${qs}`, { headers: HEADERS });
    const body = await res.text();
    if (res.status !== 200) return { err: `HTTP ${res.status} ${body.slice(0, 110).replace(/\s+/g, " ")}` };
    const j = JSON.parse(body);
    const items = j.items || [];
    return {
      total: j.items_total ?? null,
      pages: j.pages_total ?? null,
      n: items.length,
      first: items[0] ? strip(items[0].title).slice(0, 32) : "-",
      date: items[0] ? (strip(items[0].sold_text).match(/\d{1,2}\/\d{1,2}\/\d{4}/) || ["-"])[0] : "-",
      keys: Object.keys(j).filter((k) => k !== "items"),
    };
  } catch (e) {
    return { err: `ERR ${e.message}` };
  }
}

function row(label, r, baseline) {
  if (r.err) return console.log(`  ${label.padEnd(28)} ${r.err}`);
  const under = r.total != null && r.total < 10000 ? "  ** UNDER CAP **" : "";
  const changed = baseline != null && r.total !== baseline ? "  <- honoured" : "";
  console.log(
    `  ${label.padEnd(28)} total=${String(r.total).padStart(7)} pages=${String(r.pages).padStart(5)} n=${String(r.n).padStart(3)}  ${r.date}${changed}${under}`
  );
}

(async () => {
  const crit = JSON.parse(fs.readFileSync(CRITERIA, "utf8")).criteria;
  const GOOD = "page=1&per_page=48&get_items=1&get_stats=0&sort=td";

  const base = await hit(LISTINGS, GOOD);
  console.log("BASELINE (listings-filter, unfiltered)");
  row("no filter", base);
  const B = base.total;

  // ---- keyword-filter: it asked for page + results, so give it those ----
  console.log("\n=== keyword-filter (needs page + results) ===");
  for (const [label, qs] of [
    ["page+results", "page=1&results=48"],
    ["+ keyword=porsche-911", "page=1&results=48&keyword=porsche-911"],
    ["+ keyword=911", "page=1&results=48&keyword=911"],
    ["+ s=porsche-911", "page=1&results=48&s=porsche-911"],
    ["+ get_stats", "page=1&results=48&keyword=porsche-911&get_stats=1"],
  ]) {
    const r = await hit(KEYWORD, qs);
    row(label, r, B);
    if (r.keys) console.log(`  ${" ".repeat(28)} keys: ${r.keys.join(",")}`);
    await sleep(CRAWL_DELAY_MS);
  }

  // ---- axis: range (the date axis — most valuable, 2019-2025 is the hole) ----
  console.log("\n=== axis: range ===");
  for (const r0 of crit.ranges) {
    if (!r0.value) continue;
    for (const p of ["range", "date_range", "period"]) {
      const r = await hit(LISTINGS, `${GOOD}&${p}=${r0.value}`);
      row(`${p}=${r0.value} (${r0.text})`, r, B);
      await sleep(CRAWL_DELAY_MS);
      if (r.total !== B) break; // found the right spelling; no need to try the others
    }
  }

  // ---- axis: category (39 numeric ids) ----
  console.log("\n=== axis: category (numeric term id) ===");
  for (const c of crit.categories.filter((c) => c.value).slice(0, 6)) {
    const r = await hit(LISTINGS, `${GOOD}&category=${c.value}`);
    row(`category=${c.value} (${strip(c.text)})`, r, B);
    await sleep(CRAWL_DELAY_MS);
  }

  // ---- axis: state / type ----
  console.log("\n=== axis: state / type ===");
  for (const [label, qs] of [
    ["state=sold", `${GOOD}&state=sold`],
    ["states=sold", `${GOOD}&states=sold`],
    ["status=sold", `${GOOD}&status=sold`],
    ["type=premium", `${GOOD}&type=premium`],
    ["type=no-reserve", `${GOOD}&type=no-reserve`],
  ]) {
    row(label, await hit(LISTINGS, qs), B);
    await sleep(CRAWL_DELAY_MS);
  }

  // ---- axis: sort (each direction is its own reachable window) ----
  console.log("\n=== axis: sort — where does each window START? ===");
  for (const s of crit.sorts) {
    const r = await hit(LISTINGS, GOOD.replace("sort=td", `sort=${s.value}`));
    row(`sort=${s.value} (${s.text})`, r, B);
    await sleep(CRAWL_DELAY_MS);
  }

  // ---- how deep can any single partition actually be paged? ----
  console.log("\n=== depth check: deepest reachable page ===");
  for (const p of [200, 260, 277, 290, 400]) {
    const r = await hit(LISTINGS, GOOD.replace("page=1", `page=${p}`));
    row(`page=${p}`, r, B);
    await sleep(CRAWL_DELAY_MS);
  }
})();
