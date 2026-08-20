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
  const words = String(slug).split("-").filter(Boolean);
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
  const m = String(text || "").match(/\$\s?([\d][\d,]*)/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
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

  const price = parsePrice(card.cardText);
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
      reserve_not_met: false, // BJ is overwhelmingly no-reserve; card-level status if present later
      status: "sold",
      raw_source_shape: "bj-docket-v1",
      fetched_at: new Date().toISOString(),
    },
  };
}

module.exports = { adaptLot, parseLotUrl, titleFromSlug };
