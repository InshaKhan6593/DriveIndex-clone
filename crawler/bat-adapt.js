// Shared BaT API record adapter.
//
// Extracted so the plain feed harvester (bat-api.crawler.js) and the partitioned harvester
// (bat-partitioned.crawler.js) cannot drift apart. Two harvesters producing subtly different
// record shapes for the same source is exactly how a "split sale" gets born: the same lot
// ingested twice under two shapes resolves to two cars.
//
// Output shape is the pipeline's normalized scraped-record contract, consumed by ingest/.
"use strict";

const stripTags = (s) => String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

// "Sold for USD $45,500 on 7/30/2014"  |  "Bid to USD $8,000 on 8/14/2026"
const RESULT_RE = /(Sold for|Bid to)\s+([A-Z]{3})?\s*\$?([\d,]+)\s+on\s+(\d{1,2}\/\d{1,2}\/\d{4})/i;

function adaptListingItem(item, extra = {}) {
  const text = stripTags(item.sold_text);
  const m = text.match(RESULT_RE);
  if (!m) return null;

  const [mm, dd, yyyy] = m[4].split("/").map(Number);
  const price = Number(m[3].replace(/,/g, ""));
  const currency = m[2] || "USD";

  // Prefer the server's own timestamp; the printed date is a fallback only. Noon UTC avoids
  // a date-only value drifting a day either way across timezones.
  const soldAt = item.sold_text_timestamp
    ? new Date(item.sold_text_timestamp * 1000).toISOString()
    : new Date(Date.UTC(yyyy, mm - 1, dd, 12)).toISOString();

  const lotId =
    item.id != null ? String(item.id) : (String(item.url || "").match(/\/listing\/([^/?#]+)/) || [])[1] || null;
  if (!lotId) return null;

  return {
    source: "bat",
    source_lot_id: lotId,
    url: String(item.url || "").split("?")[0],
    title: stripTags(item.title),
    sold_at: soldAt,
    price,
    currency,
    // Only assert USD when it IS USD. Guessing here is ground-truth defect #1 (they compute
    // on mixed currencies as if all were dollars).
    price_usd: currency === "USD" ? price : null,
    mileage: null,
    vin_raw: null,
    vin_normal: null,
    color: null,
    transmission: null,
    tc: null,
    options: [],
    image_url: item.thumbnail_url || null,
    is_outlier: false,
    outlier_note: null,
    carfax_damage: false,
    non_us_sale: (item.country_code && item.country_code !== "US") || currency !== "USD",
    reserve_not_met: !/sold for/i.test(text),
    raw_source_shape: "bat-wp-json-listings-filter-v1",
    harvest_mode: "api",
    fetched_at: new Date().toISOString(),
    _extra: {
      views: item.views ?? null,
      watchers: item.watchers ?? null,
      country: item.country || null,
      noreserve: Boolean(item.noreserve),
      premium: Boolean(item.premium),
      // BaT's OWN repeat-sale marker — independent corroboration for our VIN-based repeat
      // detection, so keep it even though we never trust it alone.
      bat_repeat: item.repeat ?? null,
      ...extra,
    },
  };
}

module.exports = { adaptListingItem, stripTags };
