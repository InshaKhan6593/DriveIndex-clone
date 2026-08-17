// Cars & Bids record adapter.
//
// Their payload is the richest of any source so far — it carries a real ISO sale date, real
// mileage, a no-reserve flag, and a THREE-STATE status. That last one matters beyond this
// source: ground truth §2 flags `reserveNotMet` being a boolean as DriveIndex defect #7,
// because C&B returns `sold` / `sold_after` / `reserve_not_met` and a boolean cannot hold the
// middle one. `sold_after` — missed reserve, then sold by negotiation — IS a real transaction
// at a real price, so forcing it into "sold" inflates live-auction results and forcing it into
// "not sold" discards a genuine sale. Our `sale.status` enum was built for exactly this, and
// this is the first adapter that can actually populate it.
"use strict";

// "146,900 Miles" | "12,000 Kilometers" | "TMU"
function parseMileage(raw) {
  const s = String(raw || "");
  const m = s.match(/([\d][\d,]*)\s*(mile|mi|kilometer|km)/i);
  if (!m) return { miles: null, note: s.trim() || null };
  const n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return { miles: null, note: s.trim() || null };
  // Normalise to miles; the engine's mileage curve is defined in miles and mixing units would
  // silently distort every adjustment.
  const isKm = /kilometer|km/i.test(m[2]);
  return { miles: isKm ? Math.round(n * 0.621371) : n, note: isKm ? "converted from km" : null };
}

// Their status strings map onto our enum. Anything unrecognised is REFUSED rather than guessed
// at — a wrong outcome silently corrupts both the price curve and the liquidity read.
const STATUS = new Map([
  ["sold", "sold"],
  ["sold_after", "sold_after"],
  ["sold-after", "sold_after"],
  ["soldafter", "sold_after"],
  ["reserve_not_met", "reserve_not_met"],
  ["reserve-not-met", "reserve_not_met"],
  ["reservenotmet", "reserve_not_met"],
  ["unsold", "reserve_not_met"],
  ["not_sold", "reserve_not_met"],
]);

function adaptAuction(a, extra = {}) {
  if (!a || !a.id) return { kind: "skip", reason: "no id" };

  const title = String(a.title || "").trim();
  if (!title) return { kind: "skip", reason: "no title" };

  const statusRaw = String(a.status || "").toLowerCase().trim();
  const status = STATUS.get(statusRaw);
  if (!status) return { kind: "skip", reason: `unrecognised status "${a.status}" — refusing to guess an outcome` };

  // A live or upcoming auction has no result yet.
  const price = a.sale_amount != null ? Number(a.sale_amount) : Number(a.current_bid);
  if (!Number.isFinite(price) || price <= 0) return { kind: "skip", reason: "no price" };

  if (!a.auction_end) return { kind: "skip", reason: "no auction_end date" };
  const soldAt = new Date(a.auction_end);
  if (Number.isNaN(soldAt.getTime())) return { kind: "skip", reason: `unparseable date "${a.auction_end}"` };

  const mileage = parseMileage(a.mileage);

  // Cars & Bids is a US marketplace and quotes USD throughout; there is no currency field to
  // read. That is asserted here rather than assumed silently, so if they ever internationalise
  // the omission is visible in one place.
  const currency = "USD";

  return {
    kind: "sale",
    record: {
      source: "cab",
      source_lot_id: String(a.id),
      url: `https://carsandbids.com/auctions/${a.id}`,
      title,
      sold_at: soldAt.toISOString(),
      price,
      currency,
      price_usd: price,
      mileage: mileage.miles,
      vin_raw: null,
      vin_normal: null,
      color: null,
      // `transmission` arrives as an opaque numeric code with no published mapping, so the
      // human-readable value is taken from the subtitle where present rather than inventing a
      // decode. The raw code is preserved in _extra for later.
      transmission: /manual/i.test(a.sub_title || "") ? "Manual"
                  : /automatic|dct|pdk|tiptronic/i.test(a.sub_title || "") ? "Automatic"
                  : null,
      tc: null,
      options: [],
      image_url: a.main_photo && a.main_photo.base_url ? `https://${a.main_photo.base_url}/${a.main_photo.path}` : null,
      is_outlier: false,
      outlier_note: null,
      carfax_damage: false,
      non_us_sale: false,
      status,
      reserve_not_met: status === "reserve_not_met",
      raw_source_shape: "cab-v2-autos-auctions-v1",
      harvest_mode: "api-intercept",
      fetched_at: new Date().toISOString(),
      _extra: {
        subTitle: a.sub_title || null,
        noReserve: Boolean(a.no_reserve),
        hasInspection: Boolean(a.has_inspection),
        location: a.location || null,
        seller: a.seller ? a.seller.username : null,
        transmissionCode: a.transmission ?? null,
        mileageRaw: a.mileage || null,
        mileageNote: mileage.note,
        submissionId: a.submission_id || null,
        statusRaw,
        ...extra,
      },
    },
  };
}

module.exports = { adaptAuction, parseMileage, STATUS };
