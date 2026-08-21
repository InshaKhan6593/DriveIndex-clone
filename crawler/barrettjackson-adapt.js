// Barrett-Jackson record adapter.
//
// Structure, read from the live docket pages via reader proxy on 2026-08-19 (direct HTTP
// is 403 from this network — see crawler header):
//
//   lot URL   /{event}/docket/vehicle/{slug}-{lotId}?origin=...
//             /{event}/docket/automobilia/{slug}-{lotId}?origin=...
//   title     the slug is generated from the catalogue entry, same as Mecum — card text
//             picks up layout furniture, the slug does not
//
// Vehicle vs automobilia is usually free from the URL path. The Mecum automobilia regex
// is imported as the second gate for anything miscategorized — BJ Kissimmee-scale dockets
// carry the same inline-signs problem Mecum's do (the current Las Vegas docket shows gas
// pumps, porcelain signs, kiddie rides inline).
"use strict";

const { AUTOMOBILIA_RE } = require("./mecum-automobilia-patterns");

function titleFromSlug(slug) {
  if (!slug) return null;
  let decoded = String(slug);
  try { decoded = decodeURIComponent(decoded); } catch { /* keep the raw slug */ }
  const words = decoded.split("-").filter(Boolean);
  if (!words.length) return null;
  return words
    .map((w) => (/^\d+$/.test(w) || /^[a-z]?\d/.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ")
    .replace(/\b(\d{4})\b/, "$1");
}

function parseLotUrl(href) {
  // /2026-las-vegas/docket/vehicle/1962-chevrolet-corvette-custom-convertible-299449?origin=featured
  // Trailing numeric segment is the lot id.
  const m = String(href || "").match(/\/docket\/(vehicle|automobilia)\/([^/?#]+?)-(\d+)(?:[?#].*)?$/);
  if (!m) return null;
  return { kind: m[1], slug: m[2], lotId: m[3] };
}

function parsePrice(text) {
  const m = String(text || "").match(/\$\s?([\d][\d,]*(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseApiDate(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const cleaned = raw.replace(/^[A-Za-z]+\s*-\s*/, "");
  const named = cleaned.match(/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s*(\d{4})$/i);
  const naiveIso = cleaned.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/);
  const date = naiveIso
    // BJ omits a timezone from run_datetime. Preserve the source calendar day deterministically
    // instead of letting the scraper machine's local timezone move a late-night sale backward.
    ? new Date(`${cleaned}Z`)
    : named
    ? new Date(Date.UTC(
      Number(named[3]),
      ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"].indexOf(named[1].toLowerCase()),
      Number(named[2]),
      12,
    ))
    : new Date(cleaned);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function apiLotUrl(item) {
  const event = String(item.event_slug || "").trim();
  const slug = String(item.slug || "").trim();
  if (!event || !slug) return null;
  return `https://www.barrett-jackson.com/${event}/docket/vehicle/${slug}`;
}

/**
 * Adapt one record from BJ's live `/api/docket` response.
 *
 * The endpoint returns both upcoming preview inventory and completed results. The former has
 * `is_sold: false` and `price: "0"`; only completed records are allowed into `sale`.
 * `price_decimal` is the numeric source of truth, while `price` is a display string such as
 * "$525,000.00". Structured fields are retained in `_extra` for later detail enrichment.
 */
function adaptApiRecord(raw, fetchedAt = new Date().toISOString()) {
  const item = raw?.attributes || raw;
  if (!item || typeof item !== "object") return { kind: "skip", reason: "malformed API record" };
  if (item.is_canceled) return { kind: "skip", reason: "canceled lot" };
  if (item.is_sold !== true) return { kind: "skip", reason: "not sold (preview or unsold lot)" };

  const title = String(item.title || "").trim();
  if (!title) return { kind: "skip", reason: "no title" };

  const price = finiteNumber(item.price_decimal) ?? parsePrice(item.price);
  if (!price || price <= 1) return { kind: "skip", reason: "missing or sentinel price" };

  const soldAt = parseApiDate(item.run_datetime) || parseApiDate(item.run_date);
  if (!soldAt) return { kind: "skip", reason: "no sale date in API record" };

  const sourceLotId = item.item_id ?? item.objectID ?? item.lot_id ?? item.slug;
  if (sourceLotId === null || sourceLotId === undefined || sourceLotId === "") {
    return { kind: "skip", reason: "no stable lot id" };
  }

  const url = apiLotUrl(item);
  if (!url) return { kind: "skip", reason: "missing event or lot slug" };

  return {
    kind: "sale",
    record: {
      source: "bj",
      source_lot_id: String(sourceLotId),
      url,
      title,
      sold_at: soldAt,
      price,
      currency: "USD",
      price_usd: price,
      mileage: finiteNumber(item.mileage ?? item.mileage_numeric ?? item.odometer),
      vin_raw: item.vin ? String(item.vin).trim() : null,
      vin_normal: null,
      color: item.exterior_color ? String(item.exterior_color).trim() : null,
      transmission: item.transmission_type_name ? String(item.transmission_type_name).trim() : null,
      tc: null,
      options: [],
      image_url: item.main_image_url || null,
      is_outlier: false,
      outlier_note: null,
      carfax_damage: false,
      non_us_sale: false,
      reserve_not_met: false,
      status: "sold",
      raw_source_shape: "bj-api-docket-v1",
      harvest_mode: "api",
      fetched_at: fetchedAt,
      _extra: {
        event: item.event_slug || null,
        eventId: item.event_id || null,
        eventNumericId: item.event || null,
        lotId: item.lot_id || null,
        documentId: item.documentId || null,
        lotNumber: item.lot_number || null,
        lotNumberDecimal: item.lot_number_decimal || null,
        runDate: item.run_date || null,
        runDatetime: item.run_datetime || null,
        make: item.make || null,
        model: item.model || null,
        style: item.style || null,
        interiorColor: item.interior_color || null,
        engineSize: item.engine_size || null,
        cylinders: item.number_of_cylinders || null,
        transmissionTypeId: item.transmission_type_id || null,
        reserveType: item.reserve_type_name || null,
        isCharity: item.is_charity === true,
        rawPrice: item.price || null,
      },
    },
  };
}

// BJ exposes the auction outcome as visible card/detail text. Do not infer "sold"
// merely because a dollar amount is present: estimate ranges and bid-to/reserve-not-met
// cards also carry dollar amounts. The order matters because "NOT SOLD" contains "SOLD".
function parseStatus(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (/\bSOLD\s+AFTER\b/i.test(value)) return "sold_after";
  if (/\b(?:NOT\s+SOLD|RESERVE\s+NOT\s+MET|BID\s+GOES\s+ON|BID\s+TO)\b/i.test(value)) return "reserve_not_met";
  if (/\bSOLD\b/i.test(value)) return "sold";
  return null;
}

/**
 * @param {{href:string, cardText:string}} card  scraped card
 * @param {string|null} soldAt  ISO date resolved from the AUCTION EVENT
 * @param {object} extra  { event: slug }
 */
function adaptLot(card, soldAt, extra = {}) {
  const parsed = parseLotUrl(card.href);
  if (!parsed) return { kind: "skip", reason: "unrecognised lot URL" };

  // Automobilia docket path — excluded at the source, same as Mecum's non-car events.
  if (parsed.kind === "automobilia") return { kind: "skip", reason: "automobilia docket path" };

  const title = titleFromSlug(parsed.slug);
  if (!title) return { kind: "skip", reason: "no title derivable from slug" };

  // Second-line gate for automobilia filed inside the vehicle docket.
  if (AUTOMOBILIA_RE.test(title)) return { kind: "skip", reason: "automobilia/memorabilia" };

  const status = parseStatus([card.status, card.cardText].filter(Boolean).join(" "));
  if (status === "reserve_not_met") return { kind: "skip", reason: "not sold / reserve not met" };
  if (!status) return { kind: "skip", reason: "missing explicit sold status" };

  const price = parsePrice([card.priceText, card.cardText].filter(Boolean).join(" "));
  if (!price) return { kind: "skip", reason: "no price on card" };

  // BJ runs many charity lots; sentinel prices are $1 / undisclosed — same gate as Mecum.
  if (price <= 1) return { kind: "skip", reason: "sentinel price ($1 = undisclosed/charity)" };

  // No date, no sale — same rule as Mecum, learned the hard way there.
  if (!soldAt) return { kind: "skip", reason: "no auction date resolved — would be invisible to all trend maths" };

  const url = card.href.startsWith("http") ? card.href : `https://www.barrett-jackson.com${card.href}`;

  return {
    kind: "sale",
    record: {
      source: "bj",
      source_lot_id: String(parsed.lotId),
      url: url.split("?")[0],
      title,
      sold_at: soldAt,
      price,
      currency: "USD", // BJ is a US house, USD-only
      price_usd: price,
      mileage: null,
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
      non_us_sale: false,
      reserve_not_met: false,
      status,
      raw_source_shape: "bj-docket-v1",
      fetched_at: new Date().toISOString(),
    },
  };
}

module.exports = {
  adaptLot,
  adaptApiRecord,
  apiLotUrl,
  parseApiDate,
  parseLotUrl,
  parsePrice,
  parseStatus,
  titleFromSlug,
};
