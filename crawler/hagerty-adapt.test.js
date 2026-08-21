// Hagerty's most dangerous parsing failure is treating a high bid or an ask as a completed
// sale. These tests pin the source's lifecycle gates to representative Marketplace text.
"use strict";

const assert = require("assert");
const { adaptHagertyPage, adaptHagertyResultCard, listingFromSale, parseHagertyDate } = require("./hagerty-adapt");

const NOW = new Date("2026-08-21T12:00:00.000Z");
const AUCTION_URL = "https://www.hagerty.com/marketplace/auction/1965-Ford-Mustang/a20f4431-62fa-4389-be36-f9643e976a07";

let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};

check("live auction becomes an active listing", () => {
  const r = adaptHagertyPage({
    url: AUCTION_URL,
    title: "1965 Ford Mustang Coupe Pace Car Edition",
    text: "5 days\nBid $19,200\nCurrent bid $19,200\nBids 8\nEnding Mon, Aug 24 at 6:05 PM UTC",
    now: NOW,
  });
  assert.strictEqual(r.kind, "listing");
  assert.strictEqual(r.record.listing_type, "auction");
  assert.strictEqual(r.record.listing_status, "live");
  assert.strictEqual(r.record.is_active, true);
  assert.strictEqual(r.record.current_bid, 19200);
  assert.strictEqual(r.record.ends_at, "2026-08-24T18:05:00.000Z");
});

check("Sold for becomes a dated sale", () => {
  const r = adaptHagertyResultCard({
    url: AUCTION_URL,
    title: "1965 Ford Mustang Coupe Pace Car Edition",
    text: "Sold for $42,265 on 08/20/26",
    now: NOW,
  });
  assert.strictEqual(r.kind, "sale");
  assert.strictEqual(r.record.status, "sold");
  assert.strictEqual(r.record.price, 42265);
  assert.strictEqual(r.record.sold_at, "2026-08-20T00:00:00.000Z");
  assert.strictEqual(r.record.price_usd, 42265);
});

check("Sold after remains a sale with a distinct status", () => {
  const r = adaptHagertyResultCard({
    url: AUCTION_URL,
    title: "1965 Ford Mustang Coupe Pace Car Edition",
    text: "Sold after $42,265 on 08/20/26",
    now: NOW,
  });
  assert.strictEqual(r.kind, "sale");
  assert.strictEqual(r.record.status, "sold_after");
});

check("Bid to is an inactive listing, never a sale", () => {
  const r = adaptHagertyResultCard({
    url: AUCTION_URL,
    title: "1965 Ford Mustang Coupe Pace Car Edition",
    text: "Bid to $12,002 on 08/20/26",
    now: NOW,
  });
  assert.strictEqual(r.kind, "listing");
  assert.strictEqual(r.record.listing_status, "bid_to");
  assert.strictEqual(r.record.is_active, false);
  assert.strictEqual(r.record.price, 12002);
});

check("Withdrawn is retained as an inactive lifecycle record", () => {
  const r = adaptHagertyResultCard({
    url: AUCTION_URL,
    title: "1965 Ford Mustang Coupe Pace Car Edition",
    text: "Withdrawn on 08/20/26",
    now: NOW,
  });
  assert.strictEqual(r.kind, "listing");
  assert.strictEqual(r.record.listing_status, "withdrawn");
  assert.strictEqual(r.record.is_active, false);
  assert.strictEqual(r.record.price, null);
});

check("classified inventory is an active asking listing", () => {
  const r = adaptHagertyPage({
    url: "https://www.hagerty.com/marketplace/classified/1967-Ford-Mustang/11111111-1111-4111-8111-111111111111",
    title: "1967 Ford Mustang Fastback",
    text: "For sale\nPrice $65,000\nMake an offer",
    now: NOW,
  });
  assert.strictEqual(r.kind, "listing");
  assert.strictEqual(r.record.listing_type, "classified");
  assert.strictEqual(r.record.listing_status, "live");
  assert.strictEqual(r.record.price_type, "asking");
  assert.strictEqual(r.record.price, 65000);
});

check("sale lifecycle can close an existing listing", () => {
  const sale = adaptHagertyResultCard({
    url: AUCTION_URL,
    title: "1965 Ford Mustang Coupe Pace Car Edition",
    text: "Sold for $42,265 on 08/20/26",
    now: NOW,
  }).record;
  const listing = listingFromSale(sale, NOW);
  assert.strictEqual(listing.is_active, false);
  assert.strictEqual(listing.listing_status, "sold");
  assert.strictEqual(listing.closed_at, sale.sold_at);
});

check("re-scraping the same URL keeps one natural lot key", () => {
  const input = {
    url: AUCTION_URL,
    title: "1965 Ford Mustang Coupe Pace Car Edition",
    text: "Sold for $42,265 on 08/20/26",
    now: NOW,
  };
  const a = adaptHagertyResultCard(input).record;
  const b = adaptHagertyResultCard(input).record;
  assert.strictEqual(`${a.source}|${a.source_lot_id}`, `${b.source}|${b.source_lot_id}`);
});

check("prose date parsing stays deterministic", () => {
  assert.strictEqual(parseHagertyDate("Ending Mon, Aug 24 at 6:05 PM UTC", NOW), "2026-08-24T18:05:00.000Z");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
