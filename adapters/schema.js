// Target normalized "sale" record. Every source adapter must return objects
// shaped exactly like this — nulls where a source doesn't provide a field.
//
// This mirrors the `sale` table from the build spec (see MEMORY: driveindex-clone-project).

/**
 * @typedef {Object} NormalizedSale
 * @property {string} source            - registry code, e.g. "bat", "cab", "rms", "bon", "mecum", "classic"
 * @property {string} source_lot_id     - native ID at the source (stable, used for idempotent upsert)
 * @property {string} url               - canonical listing URL
 * @property {string} title             - raw listing title, kept verbatim for re-matching
 * @property {string} sold_at           - ISO 8601 timestamp
 * @property {number} price             - price in listed currency (NOT converted)
 * @property {string} currency          - ISO 4217 code, default "USD"
 * @property {number|null} price_usd    - price converted to USD at sold_at FX rate (fixes DriveIndex's dropped-currency bug)
 * @property {number|null} mileage
 * @property {string|null} vin_raw      - VIN exactly as scraped, pre-normalization
 * @property {string|null} vin_normal   - normalizeVin(vin_raw) output, the identity key
 * @property {string|null} color
 * @property {string|null} transmission - raw transmission string
 * @property {string|null} tc           - normalized transmission code: manual|auto|pdk|dct|unknown
 * @property {string[]}   options       - parsed option/spec tags
 * @property {string|null} image_url
 *
 * // exclusion flags — sale stays visible, drops out of the maths
 * @property {boolean} is_outlier
 * @property {string|null} outlier_note
 * @property {boolean} carfax_damage
 * @property {boolean} non_us_sale
 * @property {boolean} reserve_not_met
 *
 * // provenance / debugging
 * @property {string} raw_source_shape  - name of the source-specific shape this was adapted from
 * @property {string} fetched_at        - ISO 8601 timestamp of when we captured this record
 */

const SOURCE_CODES = {
  bat: "Bring a Trailer",
  cab: "Cars & Bids",
  rms: "RM Sotheby's",
  sms: "Sotheby's Motorsport",
  good: "Gooding & Company",
  pcar: "PCAR Market",
  mecum: "Mecum",
  bj: "Barrett-Jackson",
  bon: "Bonhams",
  broadarrow: "Broad Arrow",
  collectingcars: "Collecting Cars",
  hagerty: "Hagerty Marketplace",
  dupont: "DuPont Registry",
  carscom: "Cars.com",
  classic: "Classic.com", // aggregator — see dedup/README.md, never authoritative
};

const AUCTION_SOURCES = new Set([
  "bat", "cab", "rms", "sms", "good", "pcar", "mecum", "bj", "bon",
  "broadarrow", "collectingcars", "hagerty", "dupont",
]);

module.exports = { SOURCE_CODES, AUCTION_SOURCES };
