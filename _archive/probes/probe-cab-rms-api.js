// Two APIs found by watching the sites' own traffic (crawler/probe-source-apis.js):
//
//   Cars & Bids  GET /v2/autos/auctions?limit=50&status=closed&offset=N&timestamp=..&signature=..
//                -> {"count":50,"total":40344,"auctions":[...]}   40,344 CLOSED AUCTIONS.
//                   We currently hold 42 records from this source.
//                   Open question: is `signature` enforced, or decorative?
//
//   RM Sotheby's POST /api/search/SearchLots?page=0&pageSize=40
//                body {"LocationCountry":[],"OfferStatus":null,"SortBy":"Availability",...}
//                -> 40 KB of JSON, no signature at all.
//
// Both matter more than any DOM crawler we could write. This establishes what each will accept
// before a harvester is built on top of it.
//
// Usage: node crawler/probe-cab-rms-api.js

const UA = "Mozilla/5.0 (compatible; price-index-research/1.0)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function jget(url, opts = {}) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", ...(opts.headers || {}) }, ...opts });
    const body = await res.text();
    let j = null; try { j = JSON.parse(body); } catch {}
    return { status: res.status, j, raw: body.slice(0, 180).replace(/\s+/g, " ") };
  } catch (e) { return { status: 0, err: e.cause?.code || e.message }; }
}

(async () => {
  console.log("=== CARS & BIDS ===");
  const CAB = "https://carsandbids.com/v2/autos/auctions";

  // 1. Is the signature enforced?
  for (const [label, qs] of [
    ["no signature at all", "limit=10&status=closed&offset=0"],
    ["with stale timestamp", `limit=10&status=closed&offset=0&timestamp=${Date.now()}`],
    ["page-style paging", "limit=10&status=closed&page=1"],
  ]) {
    const r = await jget(`${CAB}?${qs}`, { headers: { Referer: "https://carsandbids.com/past-auctions/" } });
    console.log(`  ${label.padEnd(22)} HTTP ${r.status}  ${r.j ? `total=${r.j.total} got=${(r.j.auctions || []).length}` : r.raw || r.err}`);
    await sleep(1200);
  }

  // 2. How deep does offset go? BaT capped at 10,000 — check whether C&B does the same.
  console.log("\n  offset depth (BaT's equivalent capped at 10,000):");
  for (const off of [0, 1000, 5000, 10000, 20000, 40000]) {
    const r = await jget(`${CAB}?limit=5&status=closed&offset=${off}`, { headers: { Referer: "https://carsandbids.com/past-auctions/" } });
    const n = r.j && r.j.auctions ? r.j.auctions.length : 0;
    const first = n ? String(r.j.auctions[0].title || "").slice(0, 40) : "-";
    console.log(`     offset=${String(off).padStart(6)}  HTTP ${r.status}  items=${n}  ${first}`);
    await sleep(1200);
  }

  // 3. What does one record carry? Field availability decides which engine parts can run.
  const one = await jget(`${CAB}?limit=1&status=closed&offset=0`, { headers: { Referer: "https://carsandbids.com/past-auctions/" } });
  if (one.j && one.j.auctions && one.j.auctions[0]) {
    console.log(`\n  record shape: ${Object.keys(one.j.auctions[0]).join(", ").slice(0, 400)}`);
  }

  console.log("\n=== RM SOTHEBY'S ===");
  const RMS = "https://rmsothebys.com/api/search/SearchLots";
  for (const [label, page, size] of [["page 0", 0, 40], ["page 5", 5, 40], ["big page size", 0, 200]]) {
    const r = await jget(`${RMS}?page=${page}&pageSize=${size}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Referer: "https://rmsothebys.com/search" },
      body: JSON.stringify({ LocationCountry: [], OfferStatus: null, SortBy: "Availability", CategoryTag: [] }),
    });
    const keys = r.j ? Object.keys(r.j).join(",") : "-";
    const lots = r.j && (r.j.results || r.j.lots || r.j.items || []);
    console.log(`  ${label.padEnd(14)} HTTP ${r.status}  keys=${keys.slice(0, 90)}  lots=${Array.isArray(lots) ? lots.length : "?"}`);
    if (Array.isArray(lots) && lots[0]) console.log(`     record: ${Object.keys(lots[0]).join(", ").slice(0, 300)}`);
    await sleep(1200);
  }
})();
