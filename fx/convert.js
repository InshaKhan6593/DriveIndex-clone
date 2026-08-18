// Convert a sale price to USD using the rate that applied on the day it sold.
//
// The table (data/fx-rates.json, written by fetch-ecb-rates.js) is EUR-based: each entry is
// units of that currency per 1 EUR. So the USD cross rate for currency X on date D is
//
//     usd = amount / rate[D][X] * rate[D].USD
//
// with EUR itself a special case (rate 1 by definition — the ECB does not quote EUR/EUR).
//
// NEVER GUESSES. An unknown currency, a date outside the table, or a gap longer than the
// weekend/holiday window all return null, and null means "leave price_usd unset" — which
// keeps the sale out of the maths exactly as before. Silently converting at a wrong or
// stale rate would be worse than the exclusion this replaces: a bad number in a price curve
// is invisible, whereas a missing one is merely absent.
"use strict";

const fs = require("fs");
const path = require("path");

const TABLE = path.join(__dirname, "..", "data", "fx-rates.json");

let table = null;
function load() {
  if (table) return table;
  try {
    table = JSON.parse(fs.readFileSync(TABLE, "utf8"));
  } catch {
    table = { rates: {} }; // absent table => everything returns null, nothing breaks
  }
  return table;
}

// ECB publishes on TARGET business days only. A sale dated on a Saturday, a Sunday or a
// holiday is valued at the last published rate before it, which is the ordinary convention.
// Ten days covers the longest run of consecutive non-publication days in the series.
const MAX_LOOKBACK_DAYS = 10;

/** Rates for `isoDate`, or the most recent business day before it. */
function ratesOn(isoDate) {
  const t = load();
  const day = String(isoDate || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  if (t.rates[day]) return t.rates[day];

  const d = new Date(day + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return null;
  for (let i = 1; i <= MAX_LOOKBACK_DAYS; i++) {
    d.setUTCDate(d.getUTCDate() - 1);
    const key = d.toISOString().slice(0, 10);
    if (t.rates[key]) return t.rates[key];
  }
  return null;
}

/**
 * @returns {number|null} the amount in USD, rounded to whole dollars, or null if it cannot be
 *   converted with a rate that actually applied on that date.
 */
function toUsd(amount, currency, isoDate) {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) return null;

  const cur = String(currency || "USD").toUpperCase();
  if (cur === "USD") return Math.round(amt);

  const r = ratesOn(isoDate);
  if (!r || !r.USD) return null;

  // The ECB quotes every currency against EUR, so EUR has no row of its own.
  const perEur = cur === "EUR" ? 1 : r[cur];
  if (!Number.isFinite(perEur) || perEur <= 0) return null;

  return Math.round((amt / perEur) * r.USD);
}

/** Which currencies this table can convert, for reporting. */
function supportedCurrencies() {
  const t = load();
  const day = Object.keys(t.rates).sort().pop();
  return day ? ["EUR", ...Object.keys(t.rates[day])].sort() : [];
}

function coverage() {
  const t = load();
  const days = Object.keys(t.rates).sort();
  return { days: days.length, from: days[0] || null, to: days[days.length - 1] || null };
}

module.exports = { toUsd, ratesOn, supportedCurrencies, coverage, MAX_LOOKBACK_DAYS };
