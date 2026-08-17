// Cars & Bids adapter gates. Fixture is a VERBATIM captured payload.
// Run: node crawler/cab-adapt.test.js

const assert = require("assert");
const { adaptAuction, parseMileage } = require("./cab-adapt");

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};

// Captured live from /v2/autos/auctions.
const REAL = {
  id: "rb01yA4g", submission_id: "KmRQgjbx",
  main_photo: { base_url: "media.carsandbids.com", path: "ee7f/photos/x.jpg" },
  title: "2001 BMW M3 Coupe",
  sub_title: "6-Speed Manual, S54 6-Cylinder, Rod Bearings Replaced",
  no_reserve: true, has_inspection: false, location: "Saint Paul, MN 55112",
  transmission: 2, mileage: "146,900 Miles", seller: { username: "MisterSpyder" },
  current_bid: 26250, sale_amount: 26250,
  auction_end: "2026-08-14T20:07:57.106+00:00", status: "sold",
};

console.log("\nTHE REAL CAPTURED RECORD");
t("adapts to a sale with every field we need", () => {
  const r = adaptAuction(REAL);
  assert.strictEqual(r.kind, "sale");
  assert.strictEqual(r.record.source_lot_id, "rb01yA4g");
  assert.strictEqual(r.record.title, "2001 BMW M3 Coupe");
  assert.strictEqual(r.record.price, 26250);
  assert.strictEqual(r.record.price_usd, 26250);
  assert.strictEqual(r.record.mileage, 146900);
  assert.strictEqual(r.record.status, "sold");
  assert.strictEqual(r.record.transmission, "Manual");
  assert.strictEqual(r.record.sold_at, "2026-08-14T20:07:57.106Z");
  assert.strictEqual(r.record.url, "https://carsandbids.com/auctions/rb01yA4g");
});

console.log("\nTHE THREE-STATE STATUS — DriveIndex defect #7");
// Their `reserveNotMet` boolean cannot hold `sold_after`. Ours can, and this is the first
// source that actually emits it.
t("'sold' => sold", () => assert.strictEqual(adaptAuction({ ...REAL, status: "sold" }).record.status, "sold"));
t("'sold_after' => sold_after, and is NOT flagged reserve_not_met", () => {
  const r = adaptAuction({ ...REAL, status: "sold_after" });
  assert.strictEqual(r.record.status, "sold_after");
  assert.strictEqual(r.record.reserve_not_met, false, "a negotiated post-auction sale IS a real transaction");
});
t("'reserve_not_met' => reserve_not_met + flag", () => {
  const r = adaptAuction({ ...REAL, status: "reserve_not_met" });
  assert.strictEqual(r.record.status, "reserve_not_met");
  assert.strictEqual(r.record.reserve_not_met, true);
});
t("hyphen/compact spellings all map", () => {
  for (const s of ["sold-after", "soldafter", "reserve-not-met", "unsold"])
    assert.ok(adaptAuction({ ...REAL, status: s }).kind === "sale", `"${s}" failed to map`);
});
t("an UNRECOGNISED status is refused, never guessed", () => {
  const r = adaptAuction({ ...REAL, status: "pending_something_new" });
  assert.strictEqual(r.kind, "skip");
  assert.match(r.reason, /refusing to guess/);
});

console.log("\nMILEAGE — normalised to miles, because the engine curve is in miles");
t("miles parsed", () => assert.strictEqual(parseMileage("146,900 Miles").miles, 146900));
t("kilometres converted to miles", () => {
  const km = parseMileage("100,000 Kilometers");
  assert.strictEqual(km.miles, 62137);
  assert.match(km.note, /converted from km/);
});
t("TMU / unreadable keeps a note and no number", () => {
  const r = parseMileage("TMU");
  assert.strictEqual(r.miles, null);
  assert.strictEqual(r.note, "TMU");
});

console.log("\nREFUSALS");
t("no price => skip", () => assert.strictEqual(adaptAuction({ ...REAL, sale_amount: null, current_bid: 0 }).kind, "skip"));
t("no date => skip (an undated sale is invisible to all trend maths)", () =>
  assert.strictEqual(adaptAuction({ ...REAL, auction_end: null }).kind, "skip"));
t("unparseable date => skip", () =>
  assert.strictEqual(adaptAuction({ ...REAL, auction_end: "not a date" }).kind, "skip"));
t("no id => skip (idempotent ingest needs a stable key)", () =>
  assert.strictEqual(adaptAuction({ ...REAL, id: null }).kind, "skip"));

console.log("\nIDENTITY IS STABLE ACROSS RUNS");
t("same input yields the same natural key", () => {
  const a = adaptAuction(REAL).record, b = adaptAuction(REAL).record;
  assert.strictEqual(`${a.source}|${a.source_lot_id}`, `${b.source}|${b.source_lot_id}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
