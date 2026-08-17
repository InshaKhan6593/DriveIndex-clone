// Gooding & Company record adapter.
//
// Source of the record: the Gatsby page-data JSON every "realized prices" auction page ships
// with — https://www.goodingco.com/page-data/auction/realized/{slug}/page-data.json — read
// directly, no DOM scraping. Unlike every other source in this pipeline it carries STRUCTURED
// make/model/modelYear fields (not just a title to parse), because Gooding's site is built on
// a Contentful CMS with a real `ContentfulVehicle` content type. Kept in `_extra` for now
// rather than fed straight past parseTitle() — see crawler/gooding.crawler.js header.
//
// Three gates, each found by inspecting real auction payloads (Amelia Island 2026, Scottsdale
// 2020, London 2024, Pebble Beach 2025, Geared Online Spring 2025):
//
// GATE 1 — NOT EVERY LOT IS A CAR.
// "Geared Online" sales are automobilia-only (signs, memorabilia) — one sampled sale
// (Online25B, 525 lots) was 100% `item.__typename === "ContentfulAutomobilia"`, zero vehicles.
// This is a STRUCTURAL field, not a title guess, so it is a cleaner reject than every other
// source's component/head-noun regex.
//
// GATE 2 — `privateSalesPrice: true` MEANS THE PRICE IS UNDISCLOSED, NOT THAT IT IS "1".
// One real example: a 1965 Aston Martin DB5 Vantage at London 2024 carries
// `salePrice: 1, privateSalesPrice: true`. That is a sentinel for "sold privately, real figure
// not published" — not a one-pound car. Confirmed across 4 sampled auctions: privateSalesPrice
// is a BOOLEAN flag (true/false/null), never itself a number. Treating `salePrice` as real
// whenever `privateSalesPrice === true` would silently inject a fabricated $1 sale.
//
// GATE 3 — `salePrice: null` IS A REAL OUTCOME (unsold / reserve not met / withdrawn), NOT
// MISSING DATA. Measured on Pebble Beach 2025: 29 of 183 lots had null on both `salePrice` and
// `privateSalesPrice` — a genuine "no result", same class as RM's `Not Sold`. No estimate
// range is published here (unlike RM), so there is nothing to route to `listing` either — it
// is simply skipped.
"use strict";

const SOURCE = "good";

// GATE 4 — GOODING BAKES ITS OWN LOT-DISAMBIGUATION CODE INTO THE DISPLAY TITLE.
//
// Not found until a real ingest run: 821 of 2,327 harvested titles (35%) end in a trailing
// parenthetical like "(PB26)", "(FL22-1)", "(O23G)", or bare "(1)" — Gooding's own consignment
// tracking code (venue+year, e.g. Pebble Beach '26; sometimes a repeat-lot counter), the same
// job BaT's URL-only "-3" dedupe suffix does, except Gooding leaks it straight into the title
// text every OTHER adapter treats as the identity source. Left in, it silently token-sorts
// into `model_key` and forks one real model into N near-duplicate cars — one for each auction
// it was consigned to (measured: "300 SL (PB24)" vs "300 SL (PB26)" resolved as two different
// cars). Confirmed exhaustively against all 39 distinct suffixes seen across the full harvest
// (2020-2026) before writing this — every one fits {PB|FL|RP|SL|UK|VA|PM|PS}{2-digit year}?
// {[-\s]repeat-counter}? or a bare repeat-counter, never a real trim/spec word, so this is safe
// to strip rather than a guess. The untouched original is kept in `_extra.rawTitle` for
// provenance/debugging.
const TRAILING_LOT_CODE = /\s*\((?:\d{1,3}|(?:PB|FL|RP|SL|UK|VA|PM|PS)\d{0,2}(?:[\s-]\d{1,3})?|O\d{2}[A-Z](?:[\s-]\d{1,3})?)\)\s*$/;

function stripLotCode(title) {
  return String(title || "").replace(TRAILING_LOT_CODE, "").trim();
}

function adaptLot(lot, soldAt, auctionMeta = {}) {
  const item = lot.item;
  if (!item || item.__typename !== "ContentfulVehicle") {
    return { kind: "skip", reason: `not a vehicle lot (${item ? item.__typename : "no item"})` };
  }

  const rawTitle = String(item.title || "").trim();
  const title = stripLotCode(rawTitle);
  if (!title) return { kind: "skip", reason: "no title" };

  if (lot.privateSalesPrice === true) {
    return { kind: "skip", reason: "private sale, price undisclosed (salePrice is a non-numeric sentinel)" };
  }
  if (lot.salePrice == null) {
    return { kind: "skip", reason: "no result recorded (unsold / reserve not met / withdrawn)" };
  }
  const price = Number(lot.salePrice);
  if (!Number.isFinite(price) || price <= 0) {
    return { kind: "skip", reason: `unparseable salePrice "${lot.salePrice}"` };
  }

  // GATE — no resolved auction date, no sale. Mirrors RM Sotheby's Gate 2: an undated sale is
  // invisible to every trend/signal/forecast calculation while still inflating record counts.
  if (!soldAt) return { kind: "skip", reason: "no auction date resolved — would be invisible to all trend maths" };

  // Gooding's `currency` field is set per-auction and was reliably populated for every
  // auction sampled EXCEPT its own oldest (Scottsdale 2020, Amelia Island 2020) — both
  // in-person US venues, where it was simply never backfilled. Defaulting null to USD there
  // is a venue-grounded inference, not a blind assumption: every non-USD auction sampled
  // (London -> GBP, Rétromobile Paris -> EUR) DID carry an explicit currency code.
  const currency = auctionMeta.currency || "USD";

  const url = `https://www.goodingco.com/lot/${lot.slug}`;

  return {
    kind: "sale",
    record: {
      source: SOURCE,
      source_lot_id: lot.slug, // Gooding's own slug already carries a dedupe suffix (e.g. "-1", "-pb26")
      url,
      title,
      sold_at: soldAt,
      price,
      currency,
      price_usd: currency === "USD" ? price : null, // never assert USD for a non-USD sale
      mileage: null,      // not exposed by this endpoint (per-lot detail page, not fetched)
      vin_raw: null,
      vin_normal: null,
      color: null,
      transmission: null,
      tc: null,
      options: [],
      image_url: null,
      is_outlier: false,
      outlier_note: null,
      carfax_damage: false,
      non_us_sale: currency !== "USD",
      reserve_not_met: false,
      status: "sold",
      raw_source_shape: "gooding-page-data-v1",
      harvest_mode: "api",
      fetched_at: new Date().toISOString(),
      _extra: {
        rawTitle: rawTitle !== title ? rawTitle : null,
        auctionSlug: auctionMeta.auctionSlug || null,
        auctionName: auctionMeta.auctionName || null,
        lotNumber: lot.lotNumber ?? null,
        structuredMake: item.make ? item.make.name : null,
        structuredModel: item.model || null,
        structuredYear: item.modelYear ?? null,
        salesForceId: item.salesForceId || null,
      },
    },
  };
}

module.exports = { adaptLot };
