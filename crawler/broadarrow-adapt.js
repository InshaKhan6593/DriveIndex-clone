// Broad Arrow Auctions record adapter.
//
// Source: individual `/vehicles/{eventCode}_{lotNumber}/{slug}` detail pages, listed directly
// in their sitemap.xml.gz. NOT an API — robots.txt explicitly disallows the search/listing/API
// routes that would give bulk access (`/vehicles/results`, `/vehicles/auction_search`,
// `/api/v1/vehicles`, `/*/sold?`), so this is the one compliant path in: individual vehicle
// pages aren't in that disallow list, and the sitemap is the sanctioned way to enumerate them.
//
// GATE — "Estimate:" vs a bare price IS the sold/not-sold signal, and it's the only one this
// site exposes. There is no "Sold for $X" label anywhere on these pages. Confirmed on 8 real
// lots from one closed 2022 event (cars AND memorabilia): every one showed a single unlabeled
// `<span>$amount</span>`. Every lot sampled from an upcoming/current event (2026) showed a
// RANGE under an explicit `id='label'>Estimate:` span instead. No case of a genuinely unsold
// lot on a closed event was found in this sample — if the price-row is present but empty, that
// is treated as "no price" and skipped, same as every other adapter's convention.
//
// ⚠️ The page's own JSON-LD (`application/ld+json`, schema.org Car/Offer) is NOT trustworthy for
// price — a 1996 Porsche 911 GT2 showed `"price":"12500000"` ($12.5M) against a real page
// estimate of "$1,250,000 - $1,450,000", and a 2003 Ferrari Enzo showed $106,750,000 against a
// "$9M-$11M" estimate. It also goes missing entirely on roughly half of pages sampled ("<!--
// Structured data for this vehicle is skipped -->"), including on confirmed real cars (a 1965
// Shelby GT350). Title, price, and VIN are all read from the rendered page instead.
//
// LISTINGS (2026-08-17): a page showing "Estimate: $X - $Y" was originally just skipped — but
// an upcoming-consignment estimate is real, current, auction-house-published pricing for a car
// that's genuinely for sale right now, exactly what the (near-empty) `listing` table exists
// for. Emitted as its own `kind: "listing"`, price = the estimate MIDPOINT (the range itself is
// kept in `_extra` for anyone who wants the real bounds) — never conflated with `kind: "sale"`,
// so it can never be mistaken for a hammer price downstream.
"use strict";

const LOT_ID_RE = /\/vehicles\/([a-z0-9]+_[a-z0-9]+)\//i;

function extractBetween(html, startMarker, len) {
  const i = html.indexOf(startMarker);
  if (i === -1) return null;
  return html.slice(i, i + len);
}

function adaptVehiclePage(html, url, soldAt) {
  const lotMatch = url.match(LOT_ID_RE);
  const source_lot_id = lotMatch ? lotMatch[1] : null;
  if (!source_lot_id) return { kind: "skip", reason: "no lot id in URL" };

  const h1Match = html.match(/<h1>\s*([\s\S]*?)\s*<\/h1>/);
  const title = h1Match ? h1Match[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim() : "";
  if (!title) return { kind: "skip", reason: "no title" };

  const priceBlock = extractBetween(html, "price-row", 700);
  if (!priceBlock) return { kind: "skip", reason: "no price-row on page" };

  const currencyMatch = html.match(/id='original_currency'[^>]*>([A-Z]{3})</);
  const currency = currencyMatch ? currencyMatch[1] : "USD";
  const vinMatch = html.match(/"vehicleIdentificationNumber"\s*:\s*"([A-HJ-NPR-Z0-9]{6,17})"/i);

  if (/estimate/i.test(priceBlock)) {
    const rangeMatch = priceBlock.match(/\$([\d,]+)\s*-\s*\$?([\d,]+)/);
    if (!rangeMatch) return { kind: "skip", reason: "estimate label present but no parseable range" };
    const low = Number(rangeMatch[1].replace(/,/g, ""));
    const high = Number(rangeMatch[2].replace(/,/g, ""));
    if (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0 || high <= 0) {
      return { kind: "skip", reason: "estimate range unparseable" };
    }
    return {
      kind: "listing",
      record: {
        source: "broadarrow",
        source_lot_id,
        url,
        title,
        price: Math.round((low + high) / 2),
        currency,
        mileage: null,
        vin_raw: vinMatch ? vinMatch[1] : null,
        color: null,
        transmission: null,
        tc: null,
        image_url: null,
        is_active: true,
        fetched_at: new Date().toISOString(),
        _extra: { lotSlug: source_lot_id, estimateLow: low, estimateHigh: high },
      },
    };
  }

  const priceMatch = priceBlock.match(/\$([\d,]+)/);
  if (!priceMatch) return { kind: "skip", reason: "no price found (unsold or not yet posted)" };
  const price = Number(priceMatch[1].replace(/,/g, ""));
  if (!Number.isFinite(price) || price <= 0) return { kind: "skip", reason: `unparseable price "${priceMatch[0]}"` };

  if (!soldAt) return { kind: "skip", reason: "no auction date resolved — would be invisible to all trend maths" };

  return {
    kind: "sale",
    record: {
      source: "broadarrow",
      source_lot_id,
      url,
      title,
      sold_at: soldAt,
      price,
      currency,
      price_usd: currency === "USD" ? price : null,
      mileage: null,
      vin_raw: vinMatch ? vinMatch[1] : null,
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
      raw_source_shape: "broadarrow-vdp-v1",
      harvest_mode: "html",
      fetched_at: new Date().toISOString(),
      _extra: { lotSlug: source_lot_id },
    },
  };
}

module.exports = { adaptVehiclePage, LOT_ID_RE };
