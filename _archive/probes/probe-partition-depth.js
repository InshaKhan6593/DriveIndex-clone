// THE DECISIVE TEST.
//
// listings-filter + category=<numeric id> is PROVEN to narrow (American=87,881,
// British=29,196, Boats=505 …). But a small items_total is worthless if the ~10k offset cap
// is global rather than per-query: we would still only reach the first ~200 pages of each
// partition and the archive would stay unreachable.
//
// So: take one partition and walk it to destruction. Two outcomes, and they imply completely
// different harvest strategies:
//
//   cap is PER-QUERY  -> each (category x sort x state) combination yields its own ~9,600
//                        records. 39 x 4 x 2 = 312 partitions. Archive becomes reachable.
//   cap is GLOBAL     -> partitions are cosmetic; need a different mechanism entirely.
//
// Also measures whether a partition SMALLER than the cap can be walked end to end, which is
// the cleanest possible confirmation (Boats = 505 records = 11 pages; if page 11 returns
// items and page 12 is empty, that partition is provably 100% harvested).
//
// Usage: node crawler/probe-partition-depth.js

const LISTINGS = "https://bringatrailer.com/wp-json/bringatrailer/1.0/data/listings-filter";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; price-index-research/1.0)",
  Accept: "application/json",
  Referer: "https://bringatrailer.com/auctions/results/",
};
const CRAWL_DELAY_MS = 1100; // robots.txt: Crawl-delay: 1
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

async function hit(qs) {
  try {
    const res = await fetch(`${LISTINGS}?${qs}`, { headers: HEADERS });
    if (res.status !== 200) return { err: `HTTP ${res.status}` };
    const j = await res.json();
    const items = j.items || [];
    return {
      total: j.items_total ?? null,
      pages: j.pages_total ?? null,
      n: items.length,
      date: items[0] ? (strip(items[0].sold_text).match(/\d{1,2}\/\d{1,2}\/\d{4}/) || ["-"])[0] : "-",
      title: items[0] ? strip(items[0].title).slice(0, 34) : "-",
    };
  } catch (e) {
    return { err: `ERR ${e.message}` };
  }
}

const P = (cat, page, sort = "td", state = "") =>
  `page=${page}&per_page=48&get_items=1&get_stats=0&sort=${sort}` +
  (cat ? `&category=${cat}` : "") +
  (state ? `&state=${state}` : "");

const show = (label, r) =>
  console.log(
    r.err
      ? `  ${label.padEnd(30)} ${r.err}`
      : `  ${label.padEnd(30)} n=${String(r.n).padStart(3)}  total=${String(r.total).padStart(6)}  ${r.date}  ${r.title}`
  );

(async () => {
  // ---- 1. a SMALL partition, walked to its own end ----
  // Boats (383) claims ~505 records / 11 pages. If page 11 has items and 12 is empty, the
  // partition is provably exhaustible and the cap did not interfere.
  console.log("=== small partition: category=383 (Boats), claims ~505 / 11 pages ===");
  for (const p of [1, 5, 10, 11, 12, 15]) {
    show(`page=${p}`, await hit(P(383, p)));
    await sleep(CRAWL_DELAY_MS);
  }

  // ---- 2. a LARGE partition, pushed past where the GLOBAL feed died (page ~200) ----
  // This is the whole question. Global feed: page 200 OK, page 260 empty.
  console.log("\n=== large partition: category=3 (American), claims ~87,881 / 1,831 pages ===");
  for (const p of [1, 100, 200, 208, 210, 250, 400, 1000, 1831]) {
    show(`page=${p}`, await hit(P(3, p)));
    await sleep(CRAWL_DELAY_MS);
  }

  // ---- 3. does the cap MOVE when the partition is smaller? ----
  // British (29,196) — if the cap is per-query and offset-based, it dies at the same page
  // number as American. If it dies later/never, the cap is proportional to result-set size.
  console.log("\n=== mid partition: category=4 (British), claims ~29,196 / 609 pages ===");
  for (const p of [200, 208, 210, 300, 609]) {
    show(`page=${p}`, await hit(P(4, p)));
    await sleep(CRAWL_DELAY_MS);
  }

  // ---- 4. do sort + state open INDEPENDENT windows within one partition? ----
  // If each (sort,state) pair reaches its own ~9,600, one category yields 8 x 9,600.
  console.log("\n=== independent windows within category=3 (American) ===");
  for (const sort of ["td", "ta", "vd", "bd"]) {
    for (const state of ["sold", "unsold"]) {
      const r = await hit(P(3, 1, sort, state));
      show(`sort=${sort} state=${state}`, r);
      await sleep(CRAWL_DELAY_MS);
    }
  }
})();
