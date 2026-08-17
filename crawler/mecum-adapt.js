// Mecum record adapter.
//
// Mecum is DriveIndex's #2 source (6.4% of their mix) and we held 18 records. Its structure,
// read off the real markup rather than guessed:
//
//   lot URL     /lots/{lotId}/{year}-{make}-{model}-{slug}/?aa_id=...
//               /lots/{EVENT}-{lotId}/{slug}/         (some carry an event prefix)
//   card        <article> containing that link plus a price badge
//   pagination  /auctions/{event}/lots/?page=N
//
// ⚠️ THE DATE PROBLEM, which bit us before.
// Mecum previously produced 0% sold_at, and every Mecum sale was therefore silently absent from
// all trend maths while still inflating record counts. The lot card carries no date — only the
// auction event does. So the harvester resolves ONE date per event and stamps its lots, and
// this adapter REFUSES any record without one rather than emitting a hollow row.
"use strict";

// "1969-ford-mustang-boss-429-fastback" -> "1969 Ford Mustang Boss 429 Fastback"
// The slug is the most reliable title source: the rendered card text is layout-dependent and
// picks up badges, while the slug is generated from the catalogue entry.
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
  const m = String(href || "").match(/\/lots\/([^/]+)\/([^/?#]+)/);
  if (!m) return null;
  return { lotId: m[1], slug: m[2] };
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
 * @param {object} extra
 */
function adaptLot(card, soldAt, extra = {}) {
  const parsed = parseLotUrl(card.href);
  if (!parsed) return { kind: "skip", reason: "unrecognised lot URL" };

  const title = titleFromSlug(parsed.slug);
  if (!title) return { kind: "skip", reason: "no title derivable from slug" };

  const price = parsePrice(card.cardText);
  // A card with no price is an unsold lot or a listing not yet run. Mecum shows "Bid Goes On"
  // for lots that did not meet reserve — a real outcome, but not a sale.
  if (!price) {
    return { kind: "skip", reason: /bid goes on/i.test(card.cardText || "") ? "reserve not met (Bid Goes On)" : "no price on card" };
  }

  // GATE: no date, no sale. See the header — this is the defect that removed every Mecum sale
  // from trend maths last time.
  if (!soldAt) return { kind: "skip", reason: "no auction date resolved — would be invisible to all trend maths" };

  const url = card.href.startsWith("http") ? card.href : `https://www.mecum.com${card.href}`;

  return {
    kind: "sale",
    record: {
      source: "mecum",
      source_lot_id: String(parsed.lotId),
      url: url.split("?")[0],
      title,
      sold_at: soldAt,
      price,
      // Mecum is a US auction house quoting USD. Asserted here rather than assumed silently,
      // so if that ever changes the omission is visible in one place.
      currency: "USD",
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
      status: "sold",
      reserve_not_met: false,
      raw_source_shape: "mecum-event-lots-card-v1",
      harvest_mode: "dom",
      fetched_at: new Date().toISOString(),
      _extra: { event: extra.event || null, eventName: extra.eventName || null, slug: parsed.slug, ...extra },
    },
  };
}

module.exports = { adaptLot, titleFromSlug, parseLotUrl, parsePrice };
