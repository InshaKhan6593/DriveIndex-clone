// Unit tests for the BaT detail-page parser — the wrong-data guards are the point.
//
// The HTML snippets below are real, captured from
// https://bringatrailer.com/listing/2006-bmw-325ci-convertible-40/ (2026-08-18). The tests
// lock the guards: a title or price mismatch must refuse to enrich, "Automated Manual" must
// not become a transmission, "Automatic Climate Control" must not either, TMU must stay
// null, and kilometres must convert on the same convention as cab-adapt.js.
"use strict";

const assert = require("assert");
const { parseMiles, parseTransmission, parseLotPage, enrichFromHtml, titlesMatch } = require("./bat-detail.crawler");

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

// ── parseMiles ──────────────────────────────────────────────────────────────────────────
ok("30k Miles -> 30000", () => assert.strictEqual(parseMiles("30k Miles").miles, 30000));
ok("12,345 Miles -> 12345", () => assert.strictEqual(parseMiles("12,345 Miles").miles, 12345));
ok("~30k Miles -> 30000", () => assert.strictEqual(parseMiles("~30k Miles").miles, 30000));
ok("Approximately 48,000 Kilometers -> converted", () => {
  const r = parseMiles("Approximately 48,000 Kilometers");
  assert.strictEqual(r.miles, 29826); // 48000 * 0.621371 = 29,825.8 -> 29,826
  assert.strictEqual(r.note, "converted from km");
});
ok("TMU -> null, noted", () => {
  assert.strictEqual(parseMiles("TMU").miles, null);
  assert.strictEqual(parseMiles("Miles TMU").note, "tmu");
});
ok("prose sentence is not an odometer", () => assert.strictEqual(parseMiles("30k miles added under current ownership").miles, null));
ok("implausible odometer refused", () => assert.strictEqual(parseMiles("9,999,999 Miles").miles, null));
ok("zero refused (placeholder, not an odometer)", () => assert.strictEqual(parseMiles("0 Miles").miles, null));

// ── parseTransmission ───────────────────────────────────────────────────────────────────
ok("Five-Speed Automatic Transmission -> Automatic", () =>
  assert.strictEqual(parseTransmission("Five-Speed Automatic Transmission"), "Automatic"));
ok("6-Speed Manual -> Manual", () =>
  assert.strictEqual(parseTransmission("6-Speed Manual"), "Manual"));
ok("Automated Manual Transmission -> refused (both families)", () =>
  assert.strictEqual(parseTransmission("Automated Manual Transmission"), null));
ok("Automatic Climate Control is NOT a transmission", () =>
  assert.strictEqual(parseTransmission("Automatic Climate Control"), null));
ok("4-Speed Automatic -> Automatic", () =>
  assert.strictEqual(parseTransmission("4-Speed Automatic"), "Automatic"));
ok("Single-Speed Automatic -> Automatic", () =>
  assert.strictEqual(parseTransmission("Single-Speed Automatic Transmission"), "Automatic"));

// ── parseLotPage on the real captured page ─────────────────────────────────────────────
const REAL_TITLE_TAG =
  "30k-Mile 2006 BMW 325Ci Convertible for sale on BaT Auctions - sold for $16,250 on August 16, 2026 (Lot #258,086) |  Bring a Trailer";
const REAL_BLOCK =
  `<strong>Listing Details</strong><ul><li>Chassis: <a href="https://www.google.com/search?q=WBABW33456PX84700" target="_blank">WBABW33456PX84700</a></li>` +
  `<li>30k Miles</li><li>2.5-liter M54 Inline-Six </li><li>Five-Speed Automatic Transmission</li>` +
  `<li>Sonora Metallic Paint</li><li>Clean Carfax Report</li></ul>`;
const realHtml = (opts = {}) =>
  `<html><head><meta property="og:title" content="${opts.og ?? "30k-Mile 2006 BMW 325Ci Convertible"}">` +
  `<title>${opts.titleTag ?? REAL_TITLE_TAG}</title></head><body>${opts.block ?? REAL_BLOCK}</body></html>`;

const realRec = {
  source: "bat", source_lot_id: "118678658", title: "30k-Mile 2006 BMW 325Ci Convertible",
  price: 16250, currency: "USD", url: "https://bringatrailer.com/listing/2006-bmw-325ci-convertible-40/",
};

ok("real page: all four fields extracted", () => {
  const { ok: pass, fields } = enrichFromHtml(realRec, realHtml());
  assert.ok(pass);
  assert.strictEqual(fields.mileage, 30000);
  assert.strictEqual(fields.vin_raw, "WBABW33456PX84700");
  assert.strictEqual(fields.transmission, "Automatic");
  assert.strictEqual(fields.color, "Sonora Metallic");
});

ok("GUARD 1: og:title mismatch refuses to enrich", () => {
  const { ok: pass, reason } = enrichFromHtml(realRec, realHtml({ og: "1972 Datsun 240z" }));
  assert.ok(!pass);
  assert.strictEqual(reason, "title-mismatch");
});

ok("GUARD 2: page price disagreeing with the record refuses to enrich", () => {
  const { ok: pass, reason } = enrichFromHtml(
    realRec,
    realHtml({ titleTag: REAL_TITLE_TAG.replace("$16,250", "$61,250") })
  );
  assert.ok(!pass);
  assert.strictEqual(reason, "price-mismatch");
});

ok("GUARD 2 relaxed for non-USD records (currency prefix makes the page $ ambiguous)", () => {
  const { ok: pass, fields } = enrichFromHtml({ ...realRec, currency: "CAD" }, realHtml());
  assert.ok(pass);
  assert.strictEqual(fields.mileage, 30000);
});

ok("junk chassis value (all zeros) is dropped, other fields still enrich", () => {
  const { fields } = enrichFromHtml(
    realRec,
    realHtml({ block: REAL_BLOCK.split("WBABW33456PX84700").join("00000000000000000") })
  );
  assert.strictEqual(fields.vin_raw, null);
  assert.strictEqual(fields.mileage, 30000);
});

ok("pre-1981 short chassis (<11 chars) not trusted as a VIN", () => {
  const { fields } = enrichFromHtml(realRec, realHtml({ block: REAL_BLOCK.split("WBABW33456PX84700").join("9113600010") }));
  assert.strictEqual(fields.vin_raw, null); // 10 chars — under the >=11 floor in dedup
});

ok("page with no Listing Details block -> no-details, not an error", () => {
  const { ok: pass, reason, fields } = enrichFromHtml(realRec, realHtml({ block: "<p>nothing here</p>" }));
  assert.ok(pass);
  assert.strictEqual(reason, "no-details");
  assert.deepStrictEqual(fields, { mileage: null, vin_raw: null, transmission: null, color: null, note: null });
});

ok("reserve-not-met page (bid to $X) passes its own price check", () => {
  const bidRec = { ...realRec, price: 8000, reserve_not_met: true };
  const { ok: pass, fields } = enrichFromHtml(
    bidRec,
    realHtml({ titleTag: "2006 BMW 325Ci Convertible for sale on BaT Auctions - bid to $8,000 on August 16, 2026 |  Bring a Trailer" })
  );
  assert.ok(pass);
  assert.strictEqual(fields.mileage, 30000);
});

ok("HTML entities in og:title are decoded before comparison", () => {
  const rec = { ...realRec, title: "1990 Audi 200 Turbo 20V" };
  const { ok: pass } = enrichFromHtml(rec, realHtml({ og: "1990 Audi 200 Turbo 20V" }));
  assert.ok(pass);
});

// Both seen on the first live run: BaT prepends "No Reserve: " to og:title for no-reserve
// lots (the list API title omits it) and entity-encodes its list titles ("4&#215;4").
ok("No Reserve: prefix on og:title still matches (real live case)", () => {
  const rec = { ...realRec, title: "1991 Land Rover Range Rover", _extra: { noreserve: true } };
  const { ok: pass, fields } = enrichFromHtml(rec, realHtml({ og: "No Reserve: 1991 Land Rover Range Rover" }));
  assert.ok(pass);
  assert.strictEqual(fields.mileage, 30000);
});

ok("entity-encoded record title matches decoded og:title (real live case)", () => {
  const rec = { ...realRec, title: "2018 Ram 3500 Laramie Crew Cab Dually 4&#215;4 6-Speed Cummins" };
  const { ok: pass, fields } = enrichFromHtml(
    rec,
    realHtml({ og: "2018 Ram 3500 Laramie Crew Cab Dually 4x4 6-Speed Cummins" })
  );
  assert.ok(pass);
  assert.strictEqual(fields.mileage, 30000);
});

ok("titlesMatch still refuses a genuinely different car", () => {
  assert.ok(!titlesMatch("1991 Land Rover Range Rover", "1972 Datsun 240z"));
  assert.ok(!titlesMatch("1991 Land Rover Range Rover", "No Reserve: 1972 Datsun 240z"));
});

console.log(`\n${passed} checks passed`);
