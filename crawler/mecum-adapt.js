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

// AUTOMOBILIA, measured on the 2026-08-18 sitemap-scale harvest: big car events (Kissimmee
// et al) carry inline memorabilia lots — 3,273 of ~19k records had titles with no model year,
// and sampling showed signs, tether cars, tool kits, badges, models and neon gas-station
// memorabilia ("1950S Ford A 1 Used Cars Double Sided Dealership Sign" — a make word on a
// SIGN, so make-detection cannot catch it). Left in, all 3,273 flood the review queue as
// UNPARSEABLE, one porcelain sign at a time — the exact failure mode that drove BaT's
// taxonomy-level category exclusion. The resolver's component head-noun rule (wheels/seats/
// manifold/gauges) stays authoritative for anything that slips past; this is the cheap
// bounded front gate, keyed on OBJECT phrases only.
//
// ⚠️ Every pattern here was checked against REAL CAR NAMES it would destroy:
//   bare "neon"   -> Plymouth Neon          bare "model"  -> Ford Model T / Model A
//   bare "manual" -> "5-Speed Manual"       sign (no \b)  -> AMG "Designo"
//   "print\b"     -> "Sprint" trims         bare "kit"    -> kit-car replicas (review's job)
// Hence "sign\b", "model\s+(kit|by)", "owner's manual", no bare neon/kit.
const AUTOMOBILIA_RE =
  /\b(?:signs?\b|billboard|poster|banner\b|pedestal|display\b|diorama|scale\s+(?:tether\s+)?car|tether\s+car|slot\s+car|pedal\s+car|ride-on|models?\s+(?:kit|by)\b|scale\s+model|toys?\b|badges?\b|pins?\b|buttons?\b|medal|trophy|helmet|jackets?\b|shirt|hats?\b|caps?\b|globe\b|gas\s+pump|lubester|oil\s+bottle|bottles?\b|crate\b|(?:owner'?s?|shop|service)\s+manual|brochure|booklet|literature|\bprint\b|lithograph|painting|artwork|photograph|toolbox|tool\s+kit|tools?\b|jacks?\b|vise\b|anvil|grease\s+gun|spark\s+plug|engine\s+stand|gas\s+can|oil\s+can|grenade|granade|whiskey|decanter|hydroplane\s+model|mailbox|phones?\b|radios?\b|clocks?\b|thermometer|syrup|soda\s+machine|cooler\b|cabinet|chests?\b|trunk\s+lid|keychain|license\s+plates?\b|assortment|collection\s+of|lot\s+of|autographed|signed\s+shadowbox|shadowbox|stadium\s+seats?|kiddie\s+ride|coin\s+operated|rocking\s+boat)\b/i;

function isAutomobilia(title) {
  return AUTOMOBILIA_RE.test(String(title || ""));
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

  // Automobilia gate — BEFORE the price/date gates so the reason reported is the true one.
  if (isAutomobilia(title)) return { kind: "skip", reason: "automobilia/memorabilia" };

  // A card with no price is an unsold lot or a listing not yet run. Mecum shows "Bid Goes On"
  // for lots that did not meet reserve — a real outcome, but not a sale. The outcome label is
  // checked BEFORE the price: a "Bid Goes On" card that also displays a high-bid figure must
  // never be ingested as a transaction (a high bid is not a hammer price).
  if (/bid goes on/i.test(card.cardText || "")) {
    return { kind: "skip", reason: "reserve not met (Bid Goes On)" };
  }
  const price = parsePrice(card.cardText);
  if (!price) {
    return { kind: "skip", reason: "no price on card" };
  }
  // $1 is Mecum's undisclosed/charity sentinel, not a market price — measured: a 1931
  // Cadillac V16 Coach at $1, a 1941 Harley at $1. Ingesting it would drag that car's
  // entire price curve toward zero. Same call as Gooding's `salePrice: 1` private-sale
  // sentinel. $59 hammers on cheap memorabilia are real and unaffected by this gate.
  if (price <= 1) return { kind: "skip", reason: "sentinel price ($1 = undisclosed/charity)" };

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

module.exports = { adaptLot, titleFromSlug, parseLotUrl, parsePrice, isAutomobilia };
