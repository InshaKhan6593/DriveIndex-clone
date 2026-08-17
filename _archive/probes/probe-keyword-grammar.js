// keyword-filter is the richer endpoint. The oracle says it registers EIGHT params:
//   per_page, results, sort, category, s, state, type, range
// versus listings-filter's four. `s` is a text/keyword filter and `range` is the date axis —
// between them that is exactly the partitioning the ~10k offset cap has been denying us.
//
// Also learned: `results` is a FLAG, not a count. results=48 -> "Invalid parameter",
// results=1 -> accepted. It selects "include the result list", with per_page controlling size.
//
// This script pins down the working grammar and, most importantly, answers the only question
// that matters: DOES A PARTITION PAGE DEEPER THAN THE GLOBAL FEED? A filter that reports
// total=3,000 but still refuses page 30 is worthless. Verified here by walking to the last
// page a partition claims and checking that real items come back.
//
// Usage: node crawler/probe-keyword-grammar.js

const KEYWORD = "https://bringatrailer.com/wp-json/bringatrailer/1.0/data/keyword-filter";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; price-index-research/1.0)",
  Accept: "application/json",
  Referer: "https://bringatrailer.com/porsche/911/",
};
const CRAWL_DELAY_MS = 1100; // robots.txt: Crawl-delay: 1
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

async function hit(qs) {
  try {
    const res = await fetch(`${KEYWORD}?${qs}`, { headers: HEADERS });
    const body = await res.text();
    if (res.status !== 200) return { err: `HTTP ${res.status} ${body.slice(0, 100).replace(/\s+/g, " ")}` };
    const j = JSON.parse(body);
    const items = j.items || [];
    const dates = items
      .map((i) => (strip(i.sold_text).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/) || [])[0])
      .filter(Boolean);
    return {
      total: j.items_total ?? null,
      pages: j.pages_total ?? null,
      n: items.length,
      first: items[0] ? strip(items[0].title).slice(0, 40) : "-",
      dates,
      keys: Object.keys(j).filter((k) => k !== "items"),
    };
  } catch (e) {
    return { err: `ERR ${e.message}` };
  }
}

const show = (label, r) =>
  console.log(
    r.err
      ? `  ${label.padEnd(34)} ${r.err}`
      : `  ${label.padEnd(34)} total=${String(r.total).padStart(7)} pages=${String(r.pages).padStart(4)} n=${String(r.n).padStart(3)}  ${r.dates[0] || "-"}  ${r.first}`
  );

(async () => {
  // 1. what values does `results` take?
  console.log("=== `results` accepted values ===");
  for (const v of ["1", "0", "true", "48"]) {
    show(`results=${v}`, await hit(`page=1&results=${v}&per_page=48`));
    await sleep(CRAWL_DELAY_MS);
  }

  const BASE = "page=1&results=1&per_page=48&sort=td";

  // 2. does `s` actually narrow? try the spellings the site's URLs imply
  console.log("\n=== `s` keyword partition ===");
  for (const s of ["porsche", "porsche-911", "Porsche 911", "911", "ferrari", "bmw-m3"]) {
    show(`s=${s}`, await hit(`${BASE}&s=${encodeURIComponent(s)}`));
    await sleep(CRAWL_DELAY_MS);
  }

  // 3. range — the date axis, and the reason 2019-2025 is missing from the corpus
  console.log("\n=== `range` date partition ===");
  for (const r of ["7D", "30D", "1Y", "2Y", "5Y", ""]) {
    show(`range=${r || "(all)"}`, await hit(`${BASE}&range=${r}`));
    await sleep(CRAWL_DELAY_MS);
  }

  // 4. state / type, now with values the criteria object actually lists
  console.log("\n=== state / type ===");
  for (const [k, v] of [["state", "sold"], ["state", "unsold"], ["type", "premium"], ["type", "no-reserve"]]) {
    show(`${k}=${v}`, await hit(`${BASE}&${k}=${v}`));
    await sleep(CRAWL_DELAY_MS);
  }

  // 5. THE DECISIVE TEST — can a partition be paged to its own end?
  //    Reporting a small total means nothing if the offset cap still applies.
  console.log("\n=== depth test: page a narrow partition to its claimed end ===");
  const probe = `${BASE.replace("page=1", "page=1")}&s=${encodeURIComponent("porsche-911")}`;
  const head = await hit(probe);
  show("s=porsche-911 page=1", head);
  await sleep(CRAWL_DELAY_MS);
  if (head.pages && head.pages > 1) {
    for (const p of [2, Math.floor(head.pages / 2), head.pages - 1, head.pages, head.pages + 2]) {
      if (p < 2) continue;
      show(`  page=${p} of ${head.pages}`, await hit(probe.replace("page=1", `page=${p}`)));
      await sleep(CRAWL_DELAY_MS);
    }
  }
})();
