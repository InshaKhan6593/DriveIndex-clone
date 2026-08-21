// RM Sotheby's record adapter.
//
// Two gates matter more here than at any other source, and both are enforced in this file so no
// caller can skip them.
//
// GATE 1 — ASKING PRICES ARE NOT SALES.
// RM publishes PRIVATE SALES in the same feed as auction results. Measured on one page of 200:
// Sold 118, blank 58, "Offered Without Reserve" 17, "Asking" 7. An Asking row is a listing
// (sold:false, e.g. "$3,300,000 USD"), not a transaction. Letting one into `sale` is the exact
// DuPont defect the ground truth flags — an ask inflating a sold-price curve. Only
// sold === true AND valueType === "Sold" becomes a sale; everything else is classified and
// handed back for the `listing` table or discarded.
//
// GATE 2 — A SALE WITHOUT A DATE IS USELESS.
// The list endpoint carries no date at all. An undated sale cannot join any trend, signal,
// forecast or repeat-sale calculation — it is invisible to the entire engine while still
// inflating record counts. Mecum had exactly this defect (0% sold_at) and every Mecum sale was
// silently absent from the maths until it was caught. So the adapter REFUSES to emit a sale
// without a resolved date rather than emitting a hollow one.
"use strict";

// "$15,000 USD" / "€1,200,000 EUR" / "£85,000 GBP" / "Price Upon Request"
const VALUE_RE = /([€£$¥])?\s*([\d][\d,]*)\s*([A-Z]{3})?/;

const SYMBOL_CURRENCY = { $: "USD", "€": "EUR", "£": "GBP", "¥": "JPY" };

function parseValue(raw) {
  const s = String(raw || "").trim();
  if (!s || /request|refer|n\/?a/i.test(s)) return null;
  const m = s.match(VALUE_RE);
  if (!m) return null;
  const amount = Number(String(m[2]).replace(/,/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const currency = m[3] || SYMBOL_CURRENCY[m[1]] || "USD";
  return { amount, currency };
}

/**
 * @param {object} item      one entry from SearchLots `items`
 * @param {string|null} soldAt ISO date resolved from the AUCTION, not the lot
 * @param {object} extra
 * @returns {{kind:"sale"|"listing"|"skip", record?:object, reason?:string}}
 */
// GATE 0 — RM runs entire auctions of racing memorabilia (signed suits, trophies, model
// aircraft), not mixed into individual car auctions but as their own dedicated sales
// ("THE FEBRUARY MEMORABILIA SALE", "THE OSCAR DAVIS MEMORABILIA COLLECTION") that share the
// exact same API feed as their car auctions. Measured: 396 lots, sample-checked at 20/20 real
// (zero titles containing a body-style word like coupe/convertible/roadster). Rejecting the
// whole auction by name is a structural, defense-in-depth backstop — resolve/evidence.js's
// "racing-memorabilia" title patterns catch individual memorabilia lots mixed into otherwise
// normal car auctions, which this can't (it only sees one auction's name at a time).
function isMemorabiliaAuction(auctionName) {
  return /\bmemorabilia\b/i.test(String(auctionName || ""));
}

function adaptLot(item, soldAt, extra = {}) {
  const title = String(item.publicName || "").trim();
  if (!title) return { kind: "skip", reason: "no title" };
  if (isMemorabiliaAuction(item.header)) return { kind: "skip", reason: "dedicated memorabilia auction, not vehicles" };

  const value = parseValue(item.value);
  const isSold = item.sold === true && /^sold$/i.test(String(item.valueType || "").trim());

  // GATE 1 — anything that is not an auction result is not a sale.
  if (!isSold) {
    if (/asking/i.test(String(item.valueType || ""))) {
      return { kind: "listing", reason: "private-sale asking price", record: baseRecord(item, title, value, null, extra) };
    }
    return { kind: "skip", reason: `not a sale (valueType="${item.valueType || ""}", sold=${item.sold})` };
  }
  if (!value) return { kind: "skip", reason: `sold but unparseable value "${item.value}"` };

  // GATE 2 — no date, no sale.
  if (!soldAt) return { kind: "skip", reason: "no auction date resolved — would be invisible to all trend maths" };

  return { kind: "sale", record: { ...baseRecord(item, title, value, soldAt, extra), status: "sold" } };
}

function baseRecord(item, title, value, soldAt, extra) {
  const link = String(item.link || "");
  const url = link.startsWith("http") ? link : `https://rmsothebys.com${link}`;
  // The lot's own URL slug is the most stable identifier RM exposes; `id` is a GUID that also
  // works. Prefer id, fall back to the slug.
  const lotId = item.id || (link.match(/\/lots\/([^/?#]+)/) || [])[1] || null;

  return {
    source: "rms",
    source_lot_id: lotId ? String(lotId) : null,
    url: url.split("?")[0],
    title,
    sold_at: soldAt,
    price: value ? value.amount : null,
    currency: value ? value.currency : null,
    // Never assert USD for a non-USD sale — ground-truth defect #1 is computing on mixed
    // currencies as though they were all dollars.
    price_usd: value && value.currency === "USD" ? value.amount : null,
    mileage: null,
    vin_raw: null,
    vin_normal: null,
    color: null,
    transmission: null,
    tc: null,
    options: [],
    image_url: null,
    is_active: /asking/i.test(String(item.valueType || "")),
    listing_type: "classified",
    listing_status: /asking/i.test(String(item.valueType || "")) ? "live" : "unknown",
    price_type: "asking",
    current_bid: null,
    estimate_low: null,
    estimate_high: null,
    ends_at: null,
    closed_at: null,
    status_reason: null,
    is_outlier: false,
    outlier_note: null,
    carfax_damage: false,
    non_us_sale: !!(value && value.currency !== "USD"),
    reserve_not_met: false,
    raw_source_shape: "rms-api-searchlots-v1",
    harvest_mode: "api",
    fetched_at: new Date().toISOString(),
    _extra: {
      auction: extra.auctionCode || null,
      auctionName: item.header || null,
      lotNumber: item.lot || null,
      preSaleEstimate: item.preSaleEstimate || null,
      valueType: item.valueType || null,
      ...extra,
    },
  };
}

module.exports = { adaptLot, parseValue };
