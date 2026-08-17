// Adapter for Bring a Trailer. Built and field-checked against a real captured sale:
// 2018 Porsche 911 GT2 RS Weissach, sold $807,000 08/11/2026, chassis WP0AE2A96JS185417
// (confirmed via crawler/probe-bat8.js — this is the exact car the DriveIndex build spec
// uses as its own worked example, §11.1/§5).
//
// Unlike Cars & Bids' clean dt/dd table, BaT's "Listing Details" is an unlabeled <li> bullet
// list — only "Chassis:" is a labeled field. Everything else (mileage, engine, transmission,
// color) has to be pattern-matched out of free-text bullets. This is inherently less reliable
// than Cars & Bids' structured table — flag any adapter output with unmatched bullets for
// review rather than silently dropping them.

const SOURCE = "bat";

function parseMoney(str) {
  if (!str) return null;
  const n = Number(String(str).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function classifyBullet(text) {
  if (/^chassis:/i.test(text)) return { field: "vin_raw", value: text.replace(/^chassis:\s*/i, "").trim() };

  // Found against real data: BaT writes mileage two ways — "93 Miles" (exact) and
  // "28k Miles Shown" (abbreviated, with a trailing qualifier word). The exact-match-only
  // regex this started with silently dropped every "28k"-style bullet into `options`
  // instead of `mileage`. Handle both.
  const mileageMatch = text.match(/^([\d,.]+)\s*(k)?\s*miles\b/i);
  if (mileageMatch) {
    const n = Number(mileageMatch[1].replace(/,/g, ""));
    return { field: "mileage", value: mileageMatch[2] ? Math.round(n * 1000) : n };
  }

  if (/transaxle|transmission|-speed manual|-speed automatic|pdk|dct/i.test(text)) return { field: "transmission", value: text };
  if (/paint$/i.test(text)) return { field: "color", value: text.replace(/paint$/i, "").trim() };
  if (/interior$/i.test(text)) return { field: "interior_color", value: text };
  return { field: "option", value: text };
}

function normalizeTransmission(raw) {
  if (!raw) return "unknown";
  const s = raw.toLowerCase();
  if (s.includes("pdk")) return "pdk";
  if (s.includes("dct") || s.includes("dual-clutch")) return "dct";
  if (s.includes("manual")) return "manual";
  if (s.includes("automatic")) return "auto";
  return "unknown";
}

/**
 * @param {object} raw - { listingIntroId, title, availableInfoText, soldTimestamp, bulletItems: string[] }
 * @param {string} url
 * @returns {import('./schema').NormalizedSale}
 */
function adaptBringATrailer(raw, url) {
  const reserve_not_met = !/sold for/i.test(raw.availableInfoText || "");
  const priceMatch = (raw.availableInfoText || "").match(/([A-Z]{3})\s*\$([\d,]+)/);
  const currency = priceMatch ? priceMatch[1] : "USD";
  const price = priceMatch ? parseMoney(priceMatch[2]) : null;

  const fields = { vin_raw: null, mileage: null, transmission: null, color: null, interior_color: null };
  const options = [];
  for (const bullet of raw.bulletItems || []) {
    const { field, value } = classifyBullet(bullet);
    if (field === "option") options.push(value);
    else if (fields[field] == null) fields[field] = value;
    else options.push(value); // second match for an already-filled field — don't silently drop it
  }

  return {
    source: SOURCE,
    source_lot_id: raw.listingIntroId || null, // BaT's own internal post ID, from data-listing-intro-id
    url,
    title: raw.title || null,
    sold_at: raw.soldTimestamp ? new Date(raw.soldTimestamp * 1000).toISOString() : null,
    price,
    currency,
    price_usd: currency === "USD" ? price : null, // non-USD needs real FX conversion — see build spec §11.1, do NOT assume parity
    mileage: fields.mileage,
    vin_raw: fields.vin_raw,
    vin_normal: null, // filled by dedup/dedup.js normalizeVin()
    color: fields.color,
    transmission: fields.transmission,
    tc: normalizeTransmission(fields.transmission),
    options,
    image_url: null,

    is_outlier: false,
    outlier_note: null,
    carfax_damage: false, // BaT: would need to parse "clean Carfax" vs damage language in the body text
    non_us_sale: currency !== "USD",
    reserve_not_met,

    raw_source_shape: "bring-a-trailer-listing-page-v1",
    fetched_at: new Date().toISOString(),

    _extra: {
      interior_color: fields.interior_color,
      unmatched_bullet_count: 0, // classifyBullet never truly "fails" (falls back to option), kept for future tightening
    },
  };
}

module.exports = { adaptBringATrailer };
