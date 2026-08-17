// Per-record schema validation. Catches ONE record being garbage — a malformed date, an
// impossible price, a VIN-shaped string that isn't one. Does NOT catch "this field is null
// for every record in the batch" — a car legitimately having no listed VIN (see: 1916 Indian
// motorcycles in samples/scraped/mecum.json) is individually valid. That failure mode is
// drift-detector.js's job, not this file's — the two layers catch different things.

const { SOURCE_CODES } = require("../adapters/schema");

function isIsoDateNotFuture(str) {
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) return false;
  return d.getTime() <= Date.now() + 24 * 3600 * 1000; // 1-day slack for clock skew
}

function validateRecord(rec) {
  const errors = [];
  const warnings = [];

  if (!rec.source || !SOURCE_CODES[rec.source]) errors.push(`unknown or missing source: ${rec.source}`);
  if (!rec.source_lot_id) errors.push("missing source_lot_id");
  if (!rec.url || !/^https?:\/\//.test(rec.url)) errors.push(`missing or malformed url: ${rec.url}`);
  if (!rec.title || typeof rec.title !== "string" || rec.title.trim().length === 0) errors.push("missing title");

  if (rec.sold_at != null && !isIsoDateNotFuture(rec.sold_at)) errors.push(`sold_at is not a valid past/present date: ${rec.sold_at}`);

  if (rec.price != null) {
    if (typeof rec.price !== "number" || !Number.isFinite(rec.price) || rec.price <= 0) {
      errors.push(`price must be a positive number, got: ${rec.price}`);
    } else if (rec.price > 50_000_000) {
      warnings.push(`price is unusually high, verify: ${rec.price}`); // real ceiling ~$70M for the most expensive cars ever sold; flag, don't reject
    }
  } else if (rec.reserve_not_met !== true) {
    warnings.push("price is null but reserve_not_met is not true — expected one or the other");
  }

  if (rec.currency != null && !/^[A-Z]{3}$/.test(rec.currency)) errors.push(`currency is not a 3-letter ISO code: ${rec.currency}`);

  if (rec.mileage != null) {
    if (typeof rec.mileage !== "number" || rec.mileage < 0 || rec.mileage > 1_000_000) {
      errors.push(`mileage out of plausible range: ${rec.mileage}`);
    }
  }

  if (rec.vin_raw != null && (typeof rec.vin_raw !== "string" || rec.vin_raw.trim().length < 2 || rec.vin_raw.trim().length > 30)) {
    warnings.push(`vin_raw looks malformed, verify: "${rec.vin_raw}"`);
  }

  if (typeof rec.reserve_not_met !== "boolean") errors.push("reserve_not_met must be a boolean");
  if (typeof rec.non_us_sale !== "boolean") errors.push("non_us_sale must be a boolean");

  return { valid: errors.length === 0, errors, warnings };
}

module.exports = { validateRecord };
