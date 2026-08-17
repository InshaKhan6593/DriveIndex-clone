// Sotheby's Motorsport (SOMO) record adapter.
//
// Source: the Next.js SSR payload every `/listings/sold/filter:sort={X}` page embeds in
// `__NEXT_DATA__` — no separate API call needed, same read-the-page's-own-JSON approach as
// Gooding. Structured make/model/year again (a Next.js + Contentful-adjacent stack, not a
// title to parse).
//
// GATE — vehicleStatus MUST be "sold". The `/listings/sold/...` route is server-filtered (every
// sample checked had status="closed" AND vehicleData.vehicleStatus="sold", reservePrice <=
// bidDetails.value in every case), unlike RM's mixed sold/asking feed — but the field is kept
// as an explicit gate rather than trusted implicitly, on the same "never assert what you can
// check" principle as every other adapter here.
"use strict";

const SOURCE = "sms";

function adaptAuction(a) {
  const v = a.vehicleData || {};
  if (v.vehicleStatus !== "sold") return { kind: "skip", reason: `not sold (vehicleStatus="${v.vehicleStatus}")` };

  const price = a.bidDetails && a.bidDetails.value;
  if (!Number.isFinite(price) || price <= 0) return { kind: "skip", reason: "unparseable bid value" };

  if (!a.soldDate) return { kind: "skip", reason: "no sold date" };

  const title = `${v.year || ""} ${v.make || ""} ${v.model || ""}`.replace(/\s+/g, " ").trim();
  if (!title) return { kind: "skip", reason: "no title" };

  const currency = (a.reservePrice && a.reservePrice.currency) || (a.startingPrice && a.startingPrice.currency) || "USD";
  const lotId = a.lotNumber != null ? String(a.lotNumber) : v.slug;
  if (!lotId) return { kind: "skip", reason: "no stable lot id" };

  return {
    kind: "sale",
    record: {
      source: SOURCE,
      source_lot_id: lotId,
      url: v.slug ? `https://www.sothebysmotorsport.com/auction/${v.slug}` : null,
      title,
      sold_at: a.soldDate,
      price,
      currency,
      price_usd: currency === "USD" ? price : null,
      mileage: null,
      vin_raw: null,
      vin_normal: null,
      color: null,
      transmission: null,
      tc: null,
      options: [],
      image_url: v.files && v.files.titleImage ? v.files.titleImage.fullUrl : null,
      is_outlier: false,
      outlier_note: null,
      carfax_damage: false,
      non_us_sale: currency !== "USD",
      reserve_not_met: false,
      status: "sold",
      raw_source_shape: "sms-next-data-v1",
      harvest_mode: "api",
      fetched_at: new Date().toISOString(),
      _extra: {
        auctionId: a.auctionId || null,
        vehicleId: v.vehicleId || null,
        startingPrice: (a.startingPrice && a.startingPrice.value) ?? null,
        reservePrice: (a.reservePrice && a.reservePrice.value) ?? null,
        location: v.location ? `${v.location.city || ""} ${v.location.state || ""}`.trim() : null,
        isPremierPartnerListing: !!a.isPremierPartnerListing,
        makeWholeStatus: a.makeWholeStatus ?? null,
      },
    },
  };
}

module.exports = { adaptAuction };
