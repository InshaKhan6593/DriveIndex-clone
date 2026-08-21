"use strict";

const assert = require("assert");
const { adaptVehiclePage } = require("./broadarrow-adapt");

const URL = "https://www.broadarrowauctions.com/vehicles/jc26_0001/1965-ford-mustang";
const estimate = adaptVehiclePage(
  "<h1>1965 Ford Mustang</h1><div class='price-row'><span id='label'>Estimate:</span> $100,000 - $120,000</div>",
  URL,
  null
);
assert.strictEqual(estimate.kind, "listing");
assert.strictEqual(estimate.record.is_active, true);
assert.strictEqual(estimate.record.listing_status, "upcoming");
assert.strictEqual(estimate.record.price_type, "estimate");
assert.strictEqual(estimate.record.estimate_low, 100000);
assert.strictEqual(estimate.record.estimate_high, 120000);

const sale = adaptVehiclePage(
  "<h1>1965 Ford Mustang</h1><div class='price-row'>$125,000</div>",
  URL,
  "2026-08-20T00:00:00.000Z"
);
assert.strictEqual(sale.kind, "sale");
assert.strictEqual(sale.record.status, "sold");

console.log("Broad Arrow listing closure inputs passed");
