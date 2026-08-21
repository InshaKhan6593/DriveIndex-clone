"use strict";

const assert = require("assert");
const { adaptVdpPage } = require("./dupont-adapt");

const URL = "https://www.dupontregistry.com/car/ford/mustang/1965/123456";
const html = (over = {}) => `listingData${JSON.stringify({
  listingId: "123456", year: 1965, make: "Ford", model: "Mustang", price: 65000,
  mileage: 42000, vin: "1F07F123456", isSold: false, ...over,
})}`;

const active = adaptVdpPage(html(), URL);
assert.strictEqual(active.kind, "listing");
assert.strictEqual(active.record.is_active, true);
assert.strictEqual(active.record.listing_status, "live");
assert.strictEqual(active.record.price_type, "asking");

const sold = adaptVdpPage(html({ isSold: true, price: null }), URL);
assert.strictEqual(sold.kind, "listing");
assert.strictEqual(sold.record.is_active, false);
assert.strictEqual(sold.record.listing_status, "sold");
assert.strictEqual(sold.record.price, null);

console.log("DuPont listing closure tests passed");
