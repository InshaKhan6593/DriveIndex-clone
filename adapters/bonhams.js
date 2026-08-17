// Adapter for Bonhams. Built and field-checked against a real captured sale:
// 2000 Lamborghini Diablo GT, VIN ZA9DE21A0YLA12561, sold US$2,425,000 inc. premium,
// The Laguna Seca Auction, 13 Aug 2026 (see crawler/probe-bonhams*.js).
//
// This is the LEAST structured of the three sources built so far. Cars & Bids has a dt/dd
// table; BaT has an unlabeled-but-bulleted list; Bonhams has NONE of that — mileage,
// transmission, and every other spec live inside multi-paragraph auction-house prose
// ("Showing just 14,208 kilometers at the time of cataloging... gated five-speed manual
// gearbox..."). Regex-over-prose extraction is inherently lower-confidence than a table
// lookup — every extracted field here should be treated as best-effort, not authoritative,
// until spot-checked against more lots.
//
// Also confirmed: the displayed price is "inc. premium" — i.e. Bonhams shows the all-in
// hammer+buyer's-premium total directly, not a bare hammer price. That matters for
// cross-source dedup (dedup/dedup.js's price-band scorer assumes a possible hammer/all-in
// GAP between sources — a Bonhams price should never need that adjustment against itself,
// only when compared to a source that reports bare hammer price).
//
// And: this car is denominated in KILOMETERS despite being sold at a US auction (Laguna
// Seca) — it's a Euro-spec import. Auction location tells you nothing about odometer units;
// every mileage figure must carry its own unit.

const SOURCE = "bon";

const CURRENCY_SYMBOLS = { "US$": "USD", "£": "GBP", "€": "EUR", "CHF": "CHF", "HK$": "HKD", "A$": "AUD", "C$": "CAD" };

// GATE — "no 'Sold for' text" is NOT the same fact as "confirmed reserve not met", and treating
// them as one caused a real bug: 7 of 30 real sample records were lots whose page still showed
// a pre-sale "Estimate: $X - $Y" range four days after the auction date (verified live,
// 2026-08-17) — the true outcome is simply unknown, not "bid too low to sell". The old code set
// reserve_not_met=true for both cases alike, which technically kept them out of sold-price
// maths (status excludes it) but permanently mislabeled an unknown outcome as a confirmed one,
// with no path to ever correct it since this crawler isn't actively re-run. A genuine
// reserve-not-met result says so explicitly ("Not Sold", "Passed", "Withdrawn"); anything else
// with no price is an honest "don't know" and should be skipped, not stored as a guess.
function parsePriceLine(text) {
  // e.g. "Sold for US$2,425,000 inc. premium" or "Sold for £180,000 inc. premium"
  const m = text.match(/Sold\s*for\s*(US\$|HK\$|A\$|C\$|£|€|CHF\s?)\s?([\d,]+)/i);
  if (m) {
    const currency = CURRENCY_SYMBOLS[m[1].trim()] || CURRENCY_SYMBOLS[m[1]] || "USD";
    return { price: Number(m[2].replace(/,/g, "")), currency, reserve_not_met: false, unknown: false };
  }
  const confirmedNotSold = /\b(not sold|passed|withdrawn|no sale)\b/i.test(text);
  return { price: null, currency: null, reserve_not_met: confirmedNotSold, unknown: !confirmedNotSold };
}

function extractVinOrChassis(headingText) {
  const vin = headingText.match(/VIN\.?\s*([A-Z0-9]{5,20})/i);
  if (vin) return vin[1];
  // Stop at the next label ("Engine no.", etc.) rather than swallowing it — some pre-war
  // lots list both ("Chassis no. 0S2-1255 Engine no. FC2764"), and the loose version of
  // this regex captured "0S2-1255 Engine no" as the chassis number.
  const chassis = headingText.match(/Chassis\s*No\.?\s*([A-Z0-9\-]{3,20})/i);
  if (chassis) return chassis[1].trim();
  return null;
}

function extractMileage(bodyText) {
  const m = bodyText.match(/([\d,]+)\s*(kilometers|kilometres|km)\b/i) || bodyText.match(/([\d,]+)\s*(miles|mi)\b/i);
  if (!m) return { mileage_raw: null, mileage_unit: null, mileage_miles: null };
  const value = Number(m[1].replace(/,/g, ""));
  const isKm = /^k/i.test(m[2]);
  return {
    mileage_raw: value,
    mileage_unit: isKm ? "km" : "mi",
    mileage_miles: isKm ? Math.round(value / 1.60934) : value,
  };
}

// BUG FIX (per-source-report: color was 0% for Bonhams). Unlike Mecum there is no labeled
// colour field — it lives in the catalogue prose, e.g.
//   "...finished in Black Rage with a matching rare Nero leather interior"
// so this is a prose extraction and inherently lower-confidence than a table lookup. It is
// good enough for display and for spotting a Paint-to-Sample premium, but should NOT be
// treated as authoritative spec data.
function extractColor(bodyText) {
  const m = String(bodyText).match(/\bfinished in\s+([A-Z][A-Za-z' -]{2,28}?)(?=\s+(?:with|over|and|,|\.|$))/);
  if (m) return m[1].trim();
  const m2 = String(bodyText).match(/\bpainted\s+(?:in\s+)?([A-Z][A-Za-z' -]{2,28}?)(?=\s+(?:with|over|and|,|\.|$))/);
  return m2 ? m2[1].trim() : null;
}

function extractTransmission(bodyText) {
  const m = bodyText.match(/(\w[\w\- ]*?(?:speed)?\s*(?:manual|automatic|automated manual|PDK|DCT)\s*(?:gearbox|transmission)?)/i);
  return m ? m[0].trim() : null;
}

function normalizeTransmission(raw) {
  if (!raw) return "unknown";
  const s = raw.toLowerCase();
  if (s.includes("pdk")) return "pdk";
  if (s.includes("dct")) return "dct";
  if (s.includes("manual")) return "manual";
  if (s.includes("automatic")) return "auto";
  return "unknown";
}

/**
 * @param {object} raw - { headingText, priceLineText, bodyText, auctionName, auctionDate, auctionId, lotNumber }
 * @param {string} url
 * @returns {import('./schema').NormalizedSale | null} null when the outcome can't be
 *   determined (no "Sold for" text and no explicit not-sold/withdrawn signal either) — refused
 *   rather than guessed, same as every other adapter's "no price = skip" convention.
 */
function adaptBonhams(raw, url) {
  const { price, currency, reserve_not_met, unknown } = parsePriceLine(raw.priceLineText || "");
  if (unknown) return null;
  const mileageInfo = extractMileage(raw.bodyText || "");
  const transmissionRaw = extractTransmission(raw.bodyText || "");

  return {
    source: SOURCE,
    source_lot_id: `${raw.auctionId}-${raw.lotNumber}`,
    url,
    title: (raw.headingText || "").replace(/\s*VIN\.?\s*[A-Z0-9]+\s*$/i, "").trim() || raw.headingText || null,
    sold_at: raw.auctionDate ? new Date(raw.auctionDate).toISOString() : null, // single-day live auction — event date used as sold date, no per-lot timestamp observed
    price,
    currency: currency || "USD",
    price_usd: currency === "USD" ? price : null, // non-USD needs real FX at sold_at — see build spec §11.1
    mileage: mileageInfo.mileage_miles, // converted to miles for schema consistency; raw value+unit kept in _extra
    vin_raw: extractVinOrChassis(raw.headingText || ""),
    vin_normal: null,
    color: extractColor(raw.bodyText || ""), // prose-extracted, lower confidence — see extractColor()
    transmission: transmissionRaw,
    tc: normalizeTransmission(transmissionRaw),
    options: [],
    image_url: null,

    is_outlier: false,
    outlier_note: null,
    carfax_damage: false,
    non_us_sale: currency !== "USD",
    reserve_not_met,

    raw_source_shape: "bonhams-lot-page-v1-PROSE_EXTRACTION_LOW_CONFIDENCE",
    fetched_at: new Date().toISOString(),

    _extra: {
      price_includes_buyers_premium: true, // confirmed via "inc. premium" suffix — do not re-add a premium estimate on top of this
      mileage_raw_value: mileageInfo.mileage_raw,
      mileage_raw_unit: mileageInfo.mileage_unit,
      auction_name: raw.auctionName,
    },
  };
}

module.exports = { adaptBonhams };
