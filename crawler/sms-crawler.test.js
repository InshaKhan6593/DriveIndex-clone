"use strict";

const assert = require("assert");
const { apiUrl, pageIsOlderThan, soldTime } = require("./sms.crawler");

assert.ok(apiUrl(2).includes("page=2"));
assert.ok(apiUrl(2).includes("limit=100"));
assert.ok(apiUrl(2).includes("type=sold"));
assert.ok(apiUrl(2).includes("sort=closed_date_desc"));

const cutoff = Date.parse("2026-07-01T00:00:00.000Z");
assert.strictEqual(pageIsOlderThan([
  { soldDate: "2026-06-30T12:00:00.000Z" },
  { soldDate: "2026-06-20T12:00:00.000Z" },
], cutoff), true);
assert.strictEqual(pageIsOlderThan([
  { soldDate: "2026-07-02T12:00:00.000Z" },
  { soldDate: "2026-06-20T12:00:00.000Z" },
], cutoff), false);
assert.strictEqual(pageIsOlderThan([{ soldDate: null }], cutoff), false);
assert.strictEqual(soldTime({ soldDate: "2026-08-20T12:00:00.000Z" }), Date.parse("2026-08-20T12:00:00.000Z"));

console.log("SMS pagination tests passed");
