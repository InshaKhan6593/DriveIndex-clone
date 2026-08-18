// Classic.com is an aggregator, so these tests enforce the quarantine boundary as well as
// ordinary parsing. Run: node crawler/classic-adapt.test.js
"use strict";

const assert = require("assert");
const { adaptClassicLot, parseMileage, parseMoneyUsd } = require("./classic-adapt");

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
    pass++;
  } catch (error) {
    console.log(`  FAIL ${name}\n       ${error.message}`);
    fail++;
  }
}

const BASE = {
  url: "/veh/1999-vector-srv8-1v9ra1125x1048001-4VNyLD4/",
  auction_url: "/a/rm-sothebys-monterey-2026-bnw52yp",
  title: "1999 Vector SRV8",
  outcome: "Sold",
  price: "$940,000",
  date: "Aug 15, 2026",
  mileage: "2k mi",
  vin_raw: "1V9RA1125X1048001",
  transmission: "Manual",
  upstream_url: "https://rmsothebys.com/auctions/mo26/lots/r0087-1999-vector-srv8/",
};

test("sold records stay leads, never sales", () => {
  const result = adaptClassicLot(BASE);
  assert.strictEqual(result.kind, "lead");
  assert.strictEqual(result.record.outcome, "sold");
  assert.strictEqual(result.record.reported_price_usd, 940000);
  assert.ok(!Object.prototype.hasOwnProperty.call(result.record, "price"));
});

test("the key contains both auction and vehicle identity", () => {
  const result = adaptClassicLot(BASE);
  assert.match(result.record.source_lot_id, /^rm-sothebys-monterey-2026-bnw52yp\|/);
});

test("foreign or absent price is refused rather than guessed as USD", () => {
  assert.strictEqual(parseMoneyUsd("€1,200,000 EUR"), null);
  assert.strictEqual(adaptClassicLot({ ...BASE, price: "Ask For Price" }).kind, "skip");
});

test("non-sale outcomes are retained as leads without sale fields", () => {
  const result = adaptClassicLot({ ...BASE, outcome: "Not Sold", price: "$500,000" });
  assert.strictEqual(result.kind, "lead");
  assert.strictEqual(result.record.outcome, "not_sold");
  assert.strictEqual(result.record.sold_at, null);
  assert.strictEqual(result.record.reported_price_usd, null);
});

test("missing upstream provenance is refused", () => {
  const result = adaptClassicLot({ ...BASE, upstream_url: null });
  assert.strictEqual(result.kind, "skip");
  assert.match(result.reason, /upstream/i);
});

test("mileage prefers an explicit miles value and handles k suffix", () => {
  assert.strictEqual(parseMileage("8k km (5k mi)"), 5000);
  assert.strictEqual(parseMileage("27k mi TMU"), 27000);
  assert.strictEqual(parseMileage("TMU"), null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
