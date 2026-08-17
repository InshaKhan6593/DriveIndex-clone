// Thirteen partitions exceed the 10k cap — German/sold alone is 69,806. Four sorts reach at
// most ~40k of that, and they overlap, so a big chunk of the archive stays unreachable.
//
// Unless categories can be INTERSECTED. Categories are not mutually exclusive (a 911 Cabrio
// is German AND Convertible), so if the endpoint ANDs two category terms, then
// German x {Convertibles, Truck, Wagons, Race Cars, Projects, Prewar, RHD, ...} becomes a
// set of sub-partitions that each fit under the cap. That is the difference between partial
// and near-complete coverage of the biggest makes.
//
// Test discipline: an intersection must return FEWER records than either operand. A param
// spelling that silently ORs, or ignores the second value, will return >= the larger operand
// and must be rejected. Also retries `type`, which the oracle proved is registered but whose
// legal values are unknown.
//
// Usage: node crawler/probe-category-intersect.js

"use strict";

const BASE = "https://bringatrailer.com/wp-json/bringatrailer/1.0/data/listings-filter";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; price-index-research/1.0)",
  Accept: "application/json",
  Referer: "https://bringatrailer.com/auctions/results/",
};
const CRAWL_DELAY_MS = 1100; // robots.txt: Crawl-delay: 1
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GERMAN = 7, CONVERTIBLES = 434, TRUCK = 21;

async function total(qs) {
  try {
    const res = await fetch(`${BASE}?page=1&per_page=48&get_items=1&get_stats=0&sort=td&${qs}`, { headers: HEADERS });
    if (res.status !== 200) {
      const b = await res.text();
      return { err: `HTTP ${res.status} ${b.slice(0, 95).replace(/\s+/g, " ")}` };
    }
    const j = await res.json();
    const it = (j.items || [])[0];
    return {
      t: j.items_total,
      first: it ? String(it.title || "").replace(/<[^>]+>/g, "").slice(0, 44) : "-",
    };
  } catch (e) {
    return { err: `ERR ${e.message}` };
  }
}

const show = (label, r) =>
  console.log(r.err ? `  ${label.padEnd(38)} ${r.err}` : `  ${label.padEnd(38)} ${String(r.t).padStart(7)}  ${r.first}`);

(async () => {
  console.log("operands:");
  const g = await total(`category=${GERMAN}`); show(`category=${GERMAN} (German)`, g); await sleep(CRAWL_DELAY_MS);
  const c = await total(`category=${CONVERTIBLES}`); show(`category=${CONVERTIBLES} (Convertibles)`, c); await sleep(CRAWL_DELAY_MS);

  console.log("\nintersection spellings (want: LESS than both operands):");
  const spellings = [
    ["repeated key", `category=${GERMAN}&category=${CONVERTIBLES}`],
    ["comma list", `category=${GERMAN},${CONVERTIBLES}`],
    ["plus list", `category=${GERMAN}+${CONVERTIBLES}`],
    ["array brackets", `category[]=${GERMAN}&category[]=${CONVERTIBLES}`],
    ["categories comma", `categories=${GERMAN},${CONVERTIBLES}`],
    ["category_and", `category_and=${GERMAN},${CONVERTIBLES}`],
    ["category + cat", `category=${GERMAN}&cat=${CONVERTIBLES}`],
  ];
  for (const [label, qs] of spellings) {
    const r = await total(qs);
    if (!r.err && r.t != null) {
      const verdict =
        r.t < Math.min(g.t, c.t) ? "  ** INTERSECTS **"
        : r.t === c.t ? "  (2nd won - no AND)"
        : r.t === g.t ? "  (1st won - no AND)"
        : r.t > Math.max(g.t, c.t) ? "  (union/OR - not useful)"
        : "";
      show(label + verdict, r);
    } else show(label, r);
    await sleep(CRAWL_DELAY_MS);
  }

  console.log("\nsecond pair, to confirm whatever spelling won is real:");
  for (const [label, qs] of [
    ["German x Truck (repeated)", `category=${GERMAN}&category=${TRUCK}`],
    ["German x Truck (comma)", `category=${GERMAN},${TRUCK}`],
  ]) { show(label, await total(qs)); await sleep(CRAWL_DELAY_MS); }

  console.log("\n`type` is registered but its values are unknown - try the criteria values:");
  for (const v of ["premium", "no-reserve", "noreserve", "1", "all", ""]) {
    show(`type=${v || "(empty)"}`, await total(`type=${v}`));
    await sleep(CRAWL_DELAY_MS);
  }
})();
