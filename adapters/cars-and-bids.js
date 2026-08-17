// Adapter for Cars & Bids. Built and field-checked against a real captured sample:
// samples/raw/cars-and-bids-1.json (2007 Porsche 911 Turbo Coupe, sold $170,000).
//
// Cars & Bids serves a clean server-rendered spec table per listing — no JS-rendering
// tricks needed once the page is fetched. robots.txt only disallows /sell-car/, /widgets,
// /dealers, so auction result pages are fair game there.

const SOURCE = "cab";

function parseMoney(str) {
  if (!str) return null;
  const n = Number(String(str).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function parseMileage(str) {
  if (!str) return null;
  const n = Number(String(str).replace(/[^0-9]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function normalizeTransmission(raw) {
  if (!raw) return "unknown";
  const s = raw.toLowerCase();
  if (s.includes("manual")) return "manual";
  if (s.includes("pdk")) return "pdk";
  if (s.includes("dct") || s.includes("dual-clutch")) return "dct";
  if (s.includes("auto")) return "auto";
  return "unknown";
}

/**
 * @param {object} raw - the spec_table + closed_auction_stats shape captured from a
 *                        Cars & Bids auction page (see samples/raw/cars-and-bids-1.json)
 * @param {string} url - canonical listing URL
 * @returns {import('./schema').NormalizedSale}
 */
function adaptCarsAndBids(raw, url) {
  const spec = raw.spec_table || {};
  const stats = raw.closed_auction_stats || {};

  // "/auctions/{lotId}/{slug}" — the lotId segment is C&B's stable native ID
  const lotIdMatch = url.match(/\/auctions\/([^/]+)\//);
  const source_lot_id = lotIdMatch ? lotIdMatch[1] : null;

  const resultLine = raw.result_line || "";
  const reserve_not_met = /reserve not met/i.test(resultLine) || /^bid to/i.test(resultLine);
  const price = reserve_not_met
    ? parseMoney((resultLine.match(/\$[\d,]+/) || [])[0])
    : parseMoney(stats.price || (resultLine.match(/\$[\d,]+/) || [])[0]);

  return {
    source: SOURCE,
    source_lot_id,
    url,
    title: raw.title || null,
    sold_at: stats.ended ? new Date(stats.ended).toISOString() : null,
    price,
    currency: "USD", // Cars & Bids is US-only, no multi-currency case observed
    price_usd: price,
    mileage: parseMileage(spec["Mileage"]),
    vin_raw: spec["VIN"] || null,
    vin_normal: null, // filled by dedup/dedup.js normalizeVin()
    color: spec["Exterior Color"] || null,
    transmission: spec["Transmission"] || null,
    tc: normalizeTransmission(spec["Transmission"]),
    options: raw.equipment_list || [],
    image_url: null, // not captured in this text-only sample; DOM has gallery <img> srcs

    is_outlier: false,
    outlier_note: null,
    carfax_damage: false, // C&B: would need to parse "Vehicle History Report" text for accident language
    non_us_sale: false,
    reserve_not_met,

    raw_source_shape: "cars-and-bids-detail-page-v1",
    fetched_at: raw._meta ? raw._meta.captured_at : new Date().toISOString(),

    // fields with no equivalent in our schema yet but present at the source —
    // kept for the model-matching / analyst-notes layer, not for the sale table itself
    _extra: {
      seller: spec["Seller"] || null,
      seller_type: spec["Seller Type"] || null,
      sold_to: stats.sold_to || null,
      bids: stats.bids ?? null,
      views: stats.views ?? null,
      title_status: spec["Title Status"] || null,
      drivetrain: spec["Drivetrain"] || null,
      known_flaws: raw.known_flaws || [],
      modifications: raw.modifications_list || [],
    },
  };
}

module.exports = { adaptCarsAndBids };
