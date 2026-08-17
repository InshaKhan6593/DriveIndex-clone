// Adapter for Mecum. Built and field-checked against a real captured sale:
// 1956 Chevrolet Nomad Wagon, LOT T10, Monterey 2026, sold $90,200, VIN VC56L021322,
// 93,265 miles (see crawler/probe-mecum8.js / probe-mecum9.js).
//
// Class names here are Next.js CSS-module hashes (e.g. "PriceBadge-module__B2ufSW__...")
// that will rotate on their next deploy, so — same call as Bonhams — this extracts from
// full body innerText with label/value line-pair regexes rather than selecting on classes.
// Unlike Bonhams' free-flowing prose, Mecum's page IS genuinely a label-then-value layout,
// just rendered as separate block elements instead of a table, so the regexes are tight
// (anchored to the label line) rather than fuzzy prose-scanning.
//
// Confirmed real query param for filtering to completed sales:
// /auctions/{slug}/lots/?saleResult[0]=sold — "Bid Goes On" is Mecum's term for reserve
// not met, used as the reserve_not_met signal here (not yet observed on a real lot this
// session — defensive fallback: no parseable price => reserve_not_met).

const SOURCE = "mecum";

function parsePrice(bodyText) {
  const m = bodyText.match(/\$([\d,]{4,})\s*\n\s*PHOTO GALLERY/);
  if (m) return Number(m[1].replace(/,/g, ""));
  return null; // no result price found near the expected position — likely "Bid Goes On" (reserve not met) or a not-yet-run lot
}

function parseLotLine(bodyText) {
  // "LOT T10 // THURSDAY, AUGUST 13TH// MONTEREY 2026"
  const m = bodyText.match(/LOT\s+(\S+)\s*\/\/\s*([A-Z]+,?\s*[A-Z]+\s*\d+\w*)\s*\/\/\s*(.+)/);
  return m ? { lotNumber: m[1], crossingDay: m[2].trim(), auctionName: m[3].trim() } : {};
}

const MONTHS = { january:0,february:1,march:2,april:3,may:4,june:5,july:6,august:7,september:8,october:9,november:10,december:11 };

// BUG FIX (found by resolve/per-source-report.js): sold_at was 0% populated for every Mecum
// lot, because the adapter gave up looking for a single ISO timestamp. Mecum never prints
// one — it prints the crossing DAY on the lot ("THURSDAY, AUGUST 13TH") and the YEAR in the
// auction name ("MONTEREY 2026"). Combined they are unambiguous. A sale with no date cannot
// take part in ANY trend, signal, or forecast calculation, so this was silently removing
// every Mecum sale from the engine while still counting it in sales_count.
function deriveSoldAt(crossingDay, auctionName) {
  if (!crossingDay || !auctionName) return null;
  const yearMatch = String(auctionName).match(/\b(20\d{2}|19\d{2})\b/);
  if (!yearMatch) return null;
  const dayMatch = String(crossingDay).match(/([A-Za-z]+)\s+(\d{1,2})/);
  if (!dayMatch) return null;
  const month = MONTHS[dayMatch[1].toLowerCase()];
  if (month === undefined) return null;
  const day = Number(dayMatch[2]);
  if (!(day >= 1 && day <= 31)) return null;
  // Auctions run during the day local time; noon UTC avoids any date rolling either way.
  return new Date(Date.UTC(Number(yearMatch[1]), month, day, 12, 0, 0)).toISOString();
}

function parseLabeledField(bodyText, label) {
  const re = new RegExp(`${label}\\s*\\n+\\s*(.+)`, "i");
  const m = bodyText.match(re);
  return m ? m[1].trim() : null;
}

function parseOdometer(bodyText) {
  const m = bodyText.match(/ODOMETER READS\*?\s*\n+\s*([\d,]+)\s*(miles|kilometers|km)/i);
  if (!m) return { mileage_miles: null, mileage_raw: null, mileage_unit: null };
  const value = Number(m[1].replace(/,/g, ""));
  const isKm = /^k/i.test(m[2]);
  return { mileage_miles: isKm ? Math.round(value / 1.60934) : value, mileage_raw: value, mileage_unit: isKm ? "km" : "mi" };
}

function normalizeTransmission(raw) {
  if (!raw) return "unknown";
  const s = raw.toLowerCase();
  if (s.includes("manual")) return "manual";
  if (s.includes("pdk")) return "pdk";
  if (s.includes("automatic") || s.includes("auto")) return "auto";
  return "unknown";
}

/**
 * @param {object} raw - { title, bodyText, lotId, url }
 * @param {string} url
 * @returns {import('./schema').NormalizedSale}
 */
function adaptMecum(raw, url) {
  const price = parsePrice(raw.bodyText);
  const lotInfo = parseLotLine(raw.bodyText);
  const odo = parseOdometer(raw.bodyText);
  const vin = parseLabeledField(raw.bodyText, "VIN \\/ SERIAL");
  const engine = parseLabeledField(raw.bodyText, "ENGINE");
  const transmission = parseLabeledField(raw.bodyText, "TRANSMISSION");
  const bodyStyle = parseLabeledField(raw.bodyText, "BODY STYLE");
  // BUG FIX (per-source-report: color was 0% for Mecum). The page DOES carry it — the
  // adapter simply never looked. Mecum's spec block is a clean label/value list and also
  // gives MAKE and MODEL explicitly, which is stronger evidence than parsing them out of
  // the title prose. Captured here so the resolver can prefer them over title-derived
  // guesses for this source.
  const exteriorColor = parseLabeledField(raw.bodyText, "EXTERIOR COLOR");
  const interiorColor = parseLabeledField(raw.bodyText, "INTERIOR COLOR");
  const declaredMake = parseLabeledField(raw.bodyText, "MAKE");
  const declaredModel = parseLabeledField(raw.bodyText, "MODEL");

  return {
    source: SOURCE,
    source_lot_id: raw.lotId,
    url,
    title: raw.title || null,
    sold_at: deriveSoldAt(lotInfo.crossingDay, lotInfo.auctionName),
    price,
    currency: "USD", // no non-USD Mecum sale observed this session — US-only auction house as far as sampled
    price_usd: price,
    mileage: odo.mileage_miles,
    vin_raw: vin,
    vin_normal: null,
    color: exteriorColor,
    transmission,
    tc: normalizeTransmission(transmission),
    options: [],
    image_url: null,

    is_outlier: false,
    outlier_note: null,
    carfax_damage: false,
    non_us_sale: false,
    reserve_not_met: price == null,

    raw_source_shape: "mecum-lot-page-v1",
    fetched_at: new Date().toISOString(),

    _extra: {
      lot_number: lotInfo.lotNumber || null,
      crossing_day: lotInfo.crossingDay || null,
      auction_name: lotInfo.auctionName || null,
      engine,
      body_style: bodyStyle,
      interior_color: interiorColor,
      // Source-declared, not title-derived. Higher trust than the title parse for this source.
      declared_make: declaredMake,
      declared_model: declaredModel,
      mileage_raw_value: odo.mileage_raw,
      mileage_raw_unit: odo.mileage_unit,
    },
  };
}

module.exports = { adaptMecum };
