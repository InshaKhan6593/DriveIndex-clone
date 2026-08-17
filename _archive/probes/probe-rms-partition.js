// RM Sotheby's reports 98,595 lots but caps paging around 10-20k, exactly like BaT. So it needs
// the same treatment: find a partition key that slices the archive below the cap.
//
// The natural candidate here is the AUCTION. Every lot belongs to one sale event (MIAMI 2026,
// HERSHEY 2023, THE MONTEREY AUCTION 2026...), and an event is a few hundred lots — comfortably
// under any cap. If the API accepts an auction filter, the whole archive becomes reachable as
// the union of its events, with no truncation anywhere.
//
// Also pins down the sold/asking split, which matters more here than at any other source: RM
// publishes PRIVATE SALES with "Asking" prices in the same feed as auction results. Letting an
// ask into sold-price maths is ground-truth defect territory (they do it with DuPont).
//
// Usage: node crawler/probe-rms-partition.js

const BASE = "https://rmsothebys.com/api/search";
const UA = "Mozilla/5.0 (compatible; price-index-research/1.0)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(path, qs, body) {
  try {
    const res = await fetch(`${BASE}/${path}?${qs}`, {
      method: "POST",
      headers: { "User-Agent": UA, Accept: "application/json", "Content-Type": "application/json", Referer: "https://rmsothebys.com/search" },
      body: JSON.stringify(body),
    });
    if (res.status !== 200) return { status: res.status };
    return { status: 200, j: await res.json() };
  } catch (e) { return { status: 0, err: e.cause?.code || e.message }; }
}

const BODY = { LocationCountry: [], OfferStatus: null, SortBy: "Recent", CategoryTag: [] };

(async () => {
  // What selection options does the site itself offer? Those are the legal filter keys.
  try {
    const r = await fetch(`${BASE}/GetSearchSelectionOptions?auction=`, { headers: { "User-Agent": UA, Accept: "application/json" } });
    const j = await r.json();
    console.log(`GetSearchSelectionOptions keys: ${Object.keys(j).join(", ")}`);
    for (const k of Object.keys(j)) {
      const v = j[k];
      if (Array.isArray(v)) console.log(`   ${k}: ${v.length} entries  e.g. ${JSON.stringify(v[0]).slice(0, 110)}`);
    }
  } catch (e) { console.log(`options failed: ${e.message}`); }

  // Where exactly is the paging cap?
  console.log(`\ncap probe (pageSize=200, SortBy=Recent):`);
  for (const p of [50, 60, 70, 80, 90, 99]) {
    const r = await post("SearchLots", `page=${p}&pageSize=200`, BODY);
    const n = r.j && r.j.items ? r.j.items.length : 0;
    console.log(`   page=${String(p).padStart(3)} (offset ${p * 200})  HTTP ${r.status}  items=${n}`);
    await sleep(1100);
    if (n === 0) break;
  }

  // Does an auction filter exist? Try the spellings the API's own naming style implies.
  console.log(`\nauction partition attempts:`);
  const first = await post("SearchLots", "page=0&pageSize=200", BODY);
  const items = (first.j && first.j.items) || [];
  const auctionIds = [...new Set(items.map((i) => i.auctionId).filter(Boolean))];
  const headers = [...new Set(items.map((i) => i.header).filter(Boolean))];
  console.log(`   auctionIds seen on page 0: ${auctionIds.slice(0, 5).join(", ")}`);
  console.log(`   auction names seen:        ${headers.slice(0, 4).join(" | ")}`);

  const baseTotal = first.j && first.j.pager ? first.j.pager.totalItems : null;
  for (const key of ["Auction", "AuctionId", "Auctions", "AuctionIds"]) {
    if (!auctionIds.length) break;
    const r = await post("SearchLots", "page=0&pageSize=20", { ...BODY, [key]: Array.isArray(auctionIds[0]) ? auctionIds[0] : [auctionIds[0]] });
    const t = r.j && r.j.pager ? r.j.pager.totalItems : null;
    console.log(`   ${key.padEnd(12)} -> totalItems=${t}${t != null && t !== baseTotal ? "   <-- HONOURED" : ""}`);
    await sleep(1100);
  }
  // Query-string form, in case the filter is not part of the JSON body.
  for (const qs of [`page=0&pageSize=20&auction=${auctionIds[0]}`, `page=0&pageSize=20&auctionId=${auctionIds[0]}`]) {
    const r = await post("SearchLots", qs, BODY);
    const t = r.j && r.j.pager ? r.j.pager.totalItems : null;
    console.log(`   ?${qs.split("&").pop().padEnd(28)} -> totalItems=${t}${t != null && t !== baseTotal ? "   <-- HONOURED" : ""}`);
    await sleep(1100);
  }

  // Sold vs asking, measured.
  console.log(`\nsold / asking split on a Recent page:`);
  const byType = {};
  for (const i of items) byType[i.valueType || "(blank)"] = (byType[i.valueType || "(blank)"] || 0) + 1;
  for (const [k, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) console.log(`   ${String(k).padEnd(14)} ${n}`);
  const sold = items.filter((i) => i.sold === true && /sold/i.test(i.valueType || ""));
  console.log(`   usable auction results on this page: ${sold.length}/${items.length}`);
  if (sold[0]) console.log(`   e.g. "${sold[0].publicName}" ${sold[0].value} lot=${sold[0].lot} link=${sold[0].link}`);
})();
