// RM Sotheby's SearchLots answers unauthenticated and accepts pageSize=200. Before building a
// harvester on it, establish the three things that decide whether it is worth building:
//   1. how many lots exist in total
//   2. whether there is an offset/page cap like BaT's 10,000
//   3. whether SOLD lots (with hammer prices) can be isolated, or whether every lot needs a
//      detail fetch to find its price
//
// Usage: node crawler/probe-rms-depth.js

const URL = "https://rmsothebys.com/api/search/SearchLots";
const UA = "Mozilla/5.0 (compatible; price-index-research/1.0)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function search(page, pageSize, body = {}) {
  try {
    const res = await fetch(`${URL}?page=${page}&pageSize=${pageSize}`, {
      method: "POST",
      headers: { "User-Agent": UA, Accept: "application/json", "Content-Type": "application/json", Referer: "https://rmsothebys.com/search" },
      body: JSON.stringify({ LocationCountry: [], OfferStatus: null, SortBy: "Availability", CategoryTag: [], ...body }),
    });
    if (res.status !== 200) return { status: res.status };
    const j = await res.json();
    return { status: 200, items: j.items || [], pager: j.pager, options: j.options, availableOptions: j.availableOptions };
  } catch (e) { return { status: 0, err: e.cause?.code || e.message }; }
}

(async () => {
  const first = await search(0, 200);
  console.log(`pager: ${JSON.stringify(first.pager)}`);
  console.log(`availableOptions keys: ${Object.keys(first.availableOptions || {}).join(", ")}`);

  const it = (first.items || [])[0];
  if (it) {
    console.log(`\nsample record:`);
    for (const k of ["header", "publicName", "lot", "value", "valueType", "preSaleEstimate", "sold", "auctioned", "link", "spec"])
      console.log(`   ${k.padEnd(16)} ${String(JSON.stringify(it[k])).slice(0, 110)}`);
  }

  // Is there a cap? Walk outward until it stops answering.
  console.log(`\ndepth probe (pageSize=200):`);
  for (const p of [0, 5, 20, 50, 100, 200, 400]) {
    const r = await search(p, 200);
    const n = (r.items || []).length;
    const sample = n ? String(r.items[0].header || "").slice(0, 42) : "-";
    console.log(`   page=${String(p).padStart(4)}  HTTP ${r.status}  items=${String(n).padStart(3)}  ${sample}`);
    await sleep(1200);
    if (r.status !== 200 || n === 0) break;
  }

  // Can sold lots with prices be isolated?
  console.log(`\nfiltering for results/sold:`);
  for (const [label, body] of [
    ["OfferStatus=Sold", { OfferStatus: "Sold" }],
    ["SortBy=Recent", { SortBy: "Recent" }],
    ["IncludeSold true", { IncludeSold: true }],
  ]) {
    const r = await search(0, 20, body);
    const items = r.items || [];
    const withValue = items.filter((x) => x.value && String(x.value).trim() && String(x.value) !== "null");
    console.log(`   ${label.padEnd(20)} HTTP ${r.status} items=${items.length} withValue=${withValue.length}`);
    if (withValue[0]) console.log(`      e.g. "${String(withValue[0].header).slice(0, 44)}" value=${JSON.stringify(withValue[0].value)} type=${JSON.stringify(withValue[0].valueType)} sold=${JSON.stringify(withValue[0].sold)}`);
    await sleep(1200);
  }

  // How many of a plain page already carry a price? That decides whether detail fetches are needed.
  const plain = await search(0, 200);
  const withPrice = (plain.items || []).filter((x) => x.value && /[\d,]/.test(String(x.value)));
  console.log(`\nprice availability on the LIST endpoint: ${withPrice.length}/${(plain.items || []).length}`);
  if (withPrice[0]) console.log(`   example: ${withPrice[0].header} -> ${withPrice[0].value} (${withPrice[0].valueType})`);
})();
