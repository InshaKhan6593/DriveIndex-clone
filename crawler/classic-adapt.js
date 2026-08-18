// CLASSIC.COM lead adapter.
//
// Classic.com is an aggregator. Its auction pages explicitly describe results as unofficial
// and convert foreign prices to USD, so this adapter intentionally returns `lead`, never `sale`
// or `listing`. A lead is useful for coverage and manual cross-checking, but cannot contaminate
// the authoritative price index.
"use strict";

const CLASSIC_HOST = "www.classic.com";

function absoluteClassicUrl(value) {
  try {
    const url = new URL(value, "https://www.classic.com");
    if (url.hostname !== CLASSIC_HOST) return null;
    url.search = "";
    url.hash = "";
    return url.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

function absoluteUpstreamUrl(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.hostname.endsWith("classic.com")) return null;
    url.search = "";
    url.hash = "";
    return url.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

function auctionKey(value) {
  const url = absoluteClassicUrl(value);
  const m = url && url.match(/\/a\/([^/]+)$/i);
  return m ? m[1] : null;
}

function vehicleKey(value, auctionUrl) {
  const url = absoluteClassicUrl(value);
  const m = url && url.match(/\/veh\/([^/]+)$/i);
  const event = auctionKey(auctionUrl);
  return m && event ? `${event}|${m[1]}` : null;
}

function parseMoneyUsd(value) {
  const text = String(value || "").trim();
  if (!text || /ask for price|contact seller|price upon request|n\/a/i.test(text)) return null;
  // Classic's auction pages expose converted USD values. Refuse a symbol we cannot prove is USD
  // rather than treating a native EUR/GBP value as dollars.
  if (!/\$/.test(text)) return null;
  const match = text.match(/\$\s*([\d,]+(?:\.\d+)?)/);
  if (!match) return null;
  const amount = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function parseMileage(value) {
  const text = String(value || "");
  const matches = [...text.matchAll(/([\d,.]+)\s*(k|m)?\s*(mi|miles|km|kilometers|kilometres)\b/gi)];
  if (!matches.length) return null;
  const miles = matches.find((m) => /mi|miles/i.test(m[3]));
  const match = miles || matches[0];
  const n = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const scaled = n * (String(match[2] || "").toLowerCase() === "k" ? 1000 : 1);
  return /km|kilometer/i.test(match[3]) ? Math.round(scaled * 0.621371) : Math.round(scaled);
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(String(value).trim());
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeOutcome(value) {
  const text = String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (text === "sold") return "sold";
  if (text === "not sold") return "not_sold";
  if (text === "pending sale") return "pending";
  if (text === "for sale") return "for_sale";
  return null;
}

function upstreamHouse(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Adapt one DOM-extracted Classic.com auction card and its detail-page fields.
 * The result is intentionally not compatible with NormalizedSale.
 */
function adaptClassicLot(raw) {
  const url = absoluteClassicUrl(raw?.url);
  const sourceLotId = vehicleKey(raw?.url, raw?.auction_url);
  const title = String(raw?.title || "").replace(/\s+/g, " ").trim();
  const outcome = normalizeOutcome(raw?.outcome);
  const upstreamUrl = absoluteUpstreamUrl(raw?.upstream_url);

  if (!url) return { kind: "skip", reason: "missing or non-Classic vehicle URL" };
  if (!sourceLotId) return { kind: "skip", reason: "missing stable vehicle/event key" };
  if (!title) return { kind: "skip", reason: "missing title" };
  if (!outcome) return { kind: "skip", reason: `unrecognised outcome "${raw?.outcome || ""}"` };
  if (!upstreamUrl) return { kind: "skip", reason: "missing upstream auction-house URL" };

  const soldAt = outcome === "sold" ? parseDate(raw?.date) : null;
  const priceUsd = outcome === "sold" ? parseMoneyUsd(raw?.price) : null;
  if (outcome === "sold" && !soldAt) return { kind: "skip", reason: "sold lot has no usable sale date" };
  if (outcome === "sold" && priceUsd == null) return { kind: "skip", reason: "sold lot has no explicit USD price" };

  return {
    kind: "lead",
    record: {
      source: "classic",
      source_lot_id: sourceLotId,
      url,
      title,
      outcome,
      sold_at: soldAt,
      reported_price_usd: priceUsd,
      reported_currency: priceUsd == null ? null : "USD",
      mileage: parseMileage(raw?.mileage),
      vin_raw: raw?.vin_raw ? String(raw.vin_raw).trim() : null,
      transmission: raw?.transmission ? String(raw.transmission).trim() : null,
      image_url: raw?.image_url || null,
      upstream_url: upstreamUrl,
      upstream_house: upstreamHouse(upstreamUrl),
      auction_url: absoluteClassicUrl(raw?.auction_url),
      location: raw?.location ? String(raw.location).replace(/\s+/g, " ").trim() : null,
      originality: raw?.originality ? String(raw.originality).replace(/\s+/g, " ").trim() : null,
      raw_source_shape: "classic-auction-lead-v1",
      fetched_at: new Date().toISOString(),
      _extra: {
        lot_number: raw?.lot_number ?? null,
        status_text: raw?.outcome ?? null,
        mileage_raw: raw?.mileage ?? null,
        price_raw: raw?.price ?? null,
        note: "Aggregator lead only; verify against upstream auction-house page before promotion.",
      },
    },
  };
}

module.exports = {
  adaptClassicLot,
  absoluteClassicUrl,
  absoluteUpstreamUrl,
  auctionKey,
  parseDate,
  parseMileage,
  parseMoneyUsd,
  normalizeOutcome,
  vehicleKey,
};
