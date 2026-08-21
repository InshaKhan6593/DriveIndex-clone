"use strict";

const assert = require("assert");
const { closeListingFromSale, closeListingAsEnded } = require("./listing-lifecycle");

const listing = {
  source: "broadarrow", source_lot_id: "jc26_001", price: 100000, currency: "USD",
  is_active: true, listing_type: "auction", listing_status: "upcoming", price_type: "estimate",
  current_bid: null, closed_at: null,
};
const sale = { price: 125000, currency: "USD", status: "sold", sold_at: "2026-08-20T00:00:00.000Z", fetched_at: "2026-08-21T00:00:00.000Z" };

const closed = closeListingFromSale(listing, sale);
assert.strictEqual(closed.is_active, false);
assert.strictEqual(closed.listing_status, "sold");
assert.strictEqual(closed.price_type, "sold");
assert.strictEqual(closed.price, 125000);
assert.strictEqual(closed.closed_at, sale.sold_at);

const ended = closeListingAsEnded(listing, "2026-08-15T00:00:00.000Z", "event closed without a sale price");
assert.strictEqual(ended.is_active, false);
assert.strictEqual(ended.listing_status, "ended");
assert.strictEqual(ended.closed_at, "2026-08-15T00:00:00.000Z");

console.log("listing lifecycle transitions passed");
