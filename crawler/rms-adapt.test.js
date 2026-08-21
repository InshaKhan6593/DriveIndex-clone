// Gates on the RM Sotheby's adapter. Both failure modes here are SILENT — they produce records
// that look fine and corrupt the maths downstream — so they are tested rather than trusted.
//
// Run: node crawler/rms-adapt.test.js

const assert = require("assert");
const { adaptLot, parseValue } = require("./rms-adapt");

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};

const DATE = "2026-08-15T12:00:00.000Z";
const lot = (over = {}) => ({
  id: "abc-123", publicName: "1957 BMW 507 Roadster Series II",
  link: "/auctions/mo26/lots/s0023-1957-bmw-507/", value: "$1,500,000 USD",
  valueType: "Sold", sold: true, lot: "123", header: "THE MONTEREY AUCTION 2026", ...over,
});

console.log("\nGATE 1 — AN ASKING PRICE IS NOT A SALE");
// RM mixes private sales into the results feed. Measured on one page of 200: Sold 118,
// blank 58, "Offered Without Reserve" 17, Asking 7. Letting an ask into `sale` is the DuPont
// defect the ground truth flags.

t("a Sold lot becomes a sale", () => {
  const r = adaptLot(lot(), DATE);
  assert.strictEqual(r.kind, "sale");
  assert.strictEqual(r.record.price, 1500000);
  assert.strictEqual(r.record.currency, "USD");
  assert.strictEqual(r.record.status, "sold");
});

t("an Asking row becomes a LISTING, never a sale", () => {
  const r = adaptLot(lot({ valueType: "Asking", sold: false, value: "$3,300,000 USD" }), DATE);
  assert.strictEqual(r.kind, "listing", `an ask leaked in as ${r.kind}`);
  assert.strictEqual(r.record.is_active, true);
  assert.strictEqual(r.record.listing_status, "live");
  assert.strictEqual(r.record.price_type, "asking");
});

t("sold:true with a non-Sold valueType is still not a sale", () => {
  // Both conditions must hold. Trusting either alone is how an ask gets through.
  assert.strictEqual(adaptLot(lot({ valueType: "Asking", sold: true }), DATE).kind, "listing");
  assert.strictEqual(adaptLot(lot({ valueType: "Sold", sold: false }), DATE).kind, "skip");
});

t("'Offered Without Reserve' is not a sale outcome", () => {
  assert.strictEqual(adaptLot(lot({ valueType: "Offered Without Reserve", sold: false }), DATE).kind, "skip");
});

t("'Price Upon Request' never yields a price", () => {
  assert.strictEqual(parseValue("Price Upon Request"), null);
  assert.strictEqual(adaptLot(lot({ value: "Price Upon Request" }), DATE).kind, "skip");
});

console.log("\nGATE 2 — A SALE WITHOUT A DATE IS REFUSED");
// An undated sale joins no trend, signal, forecast or repeat-sale calculation. It is invisible
// to the whole engine while still inflating record counts — exactly the Mecum defect.

t("no resolved auction date => skipped, not emitted", () => {
  const r = adaptLot(lot(), null);
  assert.strictEqual(r.kind, "skip");
  assert.match(r.reason, /date/i);
});

t("a resolved date is carried onto the sale", () => {
  assert.strictEqual(adaptLot(lot(), DATE).record.sold_at, DATE);
});

console.log("\nCURRENCY — DEFECT #1 MUST NOT BE REPRODUCED");

t("a non-USD sale does NOT get a price_usd", () => {
  const r = adaptLot(lot({ value: "€1,200,000 EUR" }), DATE);
  assert.strictEqual(r.record.currency, "EUR");
  assert.strictEqual(r.record.price_usd, null, "guessing USD for a EUR sale is defect #1");
  assert.strictEqual(r.record.non_us_sale, true);
});

t("a USD sale does get price_usd", () => {
  assert.strictEqual(adaptLot(lot(), DATE).record.price_usd, 1500000);
});

t("symbol-only values still resolve a currency", () => {
  assert.deepStrictEqual(parseValue("£85,000"), { amount: 85000, currency: "GBP" });
});

console.log("\nIDENTITY — STABLE KEYS SO CRON RE-RUNS CANNOT DUPLICATE");

t("the same lot always yields the same natural key", () => {
  const a = adaptLot(lot(), DATE).record;
  const b = adaptLot(lot(), DATE).record;
  assert.strictEqual(`${a.source}|${a.source_lot_id}`, `${b.source}|${b.source_lot_id}`);
});

t("lot id falls back to the URL slug when id is absent", () => {
  const r = adaptLot(lot({ id: null }), DATE);
  assert.strictEqual(r.record.source_lot_id, "s0023-1957-bmw-507");
});

t("url is absolute and query-stripped", () => {
  const r = adaptLot(lot({ link: "/auctions/mo26/lots/x/?utm=1" }), DATE);
  assert.ok(r.record.url.startsWith("https://rmsothebys.com/"), r.record.url);
  assert.ok(!r.record.url.includes("?"), r.record.url);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
