// BONHAMS record adapter — reads the auction page's own __NEXT_DATA__.
//
// ── WHY THIS REPLACES THE OLD SCRAPER ─────────────────────────────────────────────────────
// _archive/superseded/bonhams.crawler.js drove a headless browser and read rendered text
// ("Sold for $X", "VIN."), one page per lot, with maxLots defaulting to 5. It produced 24
// records from a single auction. This reads structured JSON already embedded in the auction
// page, so ONE request returns every lot in that auction with price, currency, outcome and
// timestamp as typed fields — no prose parsing, no per-lot fetch.
//
// ── PER-LOT DEPARTMENT IS THE FILTER THAT MATTERS ─────────────────────────────────────────
// Bonhams runs mixed sales: the Laguna Seca auction (31959) contains both MOT-CAR and MOT-CYC
// lots, and the very first lot is a 1952 Triumph Thunderbird motorcycle. Filtering at auction
// level would drag every motorcycle in with the cars. `lot.department.code` is per-lot, so
// motorcycles are excluded precisely rather than by title guessing — which is what the
// motorcycle patterns in resolve/vocab.js otherwise have to do.
//
// ── OUTCOME IS A REAL ENUM HERE, NOT AN INFERENCE ─────────────────────────────────────────
// `status` is authoritative: SOLD, or BI ("bought in" — the house's term for reserve not met).
// The old adapter had to infer this from whether the words "Sold for" appeared, which is what
// produced hollow $0 rows and the reserve_not_met/unknown conflation fixed earlier. Anything
// not yet concluded (NEW, etc.) is skipped rather than guessed at.
//
// ── PRICE: hammerPremium, NOT hammerPrice ─────────────────────────────────────────────────
// `price.hammerPrice` is the hammer figure; `price.hammerPremium` is hammer plus buyer's
// premium, which is the number Bonhams publishes as the sale result and the one the previous
// 24 ingested records already carry. Using hammerPrice would silently make new Bonhams data
// ~15% cheaper than the existing rows for no visible reason.
"use strict";

const DEPT_CARS = "MOT-CAR";

/** @returns {{kind:"sale"|"skip", record?:object, reason?:string}} */
function adaptLot(lot, auctionId) {
  const dept = lot?.department?.code;
  if (dept !== DEPT_CARS) return { kind: "skip", reason: `department ${dept || "unknown"}, not cars` };

  const title = String(lot.title || "").replace(/\s+/g, " ").trim();
  if (!title) return { kind: "skip", reason: "no title" };

  const status = String(lot.status || "").toUpperCase();
  if (status !== "SOLD" && status !== "BI") {
    return { kind: "skip", reason: `status ${status || "none"} — not a concluded outcome` };
  }

  const p = lot.price || {};
  // Bonhams reports results inclusive of buyer's premium; fall back to hammer if premium is
  // absent on an older record.
  const price = Number(p.hammerPremium ?? p.hammerPrice ?? 0);
  if (status === "SOLD" && (!Number.isFinite(price) || price <= 0)) {
    return { kind: "skip", reason: "marked SOLD but carries no usable price" };
  }

  const soldAt = lot?.hammerTime?.datetime || lot?.auctionEndDate?.datetime;
  if (!soldAt) return { kind: "skip", reason: "no date — would be invisible to all trend maths" };

  const currency = lot?.currency?.iso_code || "USD";
  const id = lot.id || `${auctionId}-${lot.lotId}`;

  return {
    kind: "sale",
    record: {
      source: "bon",
      source_lot_id: String(id),
      url: `https://cars.bonhams.com/auction/${auctionId}/lot/${lot.lotId}/${lot.slug || ""}/`.replace(/\/+$/, "/"),
      title,
      sold_at: new Date(soldAt).toISOString(),
      // A bought-in lot has no sale price. Keep the high bid visible where one exists, but it
      // is excluded from the maths by engine/clean.js via status.
      price: status === "SOLD" ? price : (Number.isFinite(price) && price > 0 ? price : 0),
      currency,
      price_usd: currency === "USD" ? (status === "SOLD" ? price : null) : null,
      mileage: null,
      vin_raw: null,
      vin_normal: null,
      color: null,
      transmission: null,
      tc: null,
      options: [],
      image_url: lot?.image?.url || null,
      is_outlier: false,
      outlier_note: null,
      carfax_damage: false,
      non_us_sale: currency !== "USD",
      status: status === "SOLD" ? "sold" : "reserve_not_met",
      raw_source_shape: "bonhams-nextdata-v1",
      harvest_mode: "json-in-page",
      fetched_at: new Date().toISOString(),
      _extra: {
        auctionId: String(auctionId),
        lotNo: lot.lotId,
        estimateLow: p.estimateLow ?? null,
        estimateHigh: p.estimateHigh ?? null,
        hammerPrice: p.hammerPrice ?? null,
        country: lot?.country?.code ?? null,
      },
    },
  };
}

/** Pull __NEXT_DATA__ out of an auction page and return its parsed pageProps. */
function parseAuctionPage(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1])?.props?.pageProps ?? null;
  } catch {
    return null;
  }
}

/** Does this auction contain ANY cars? Cheap gate before harvesting its lots. */
function auctionHasCars(pageProps) {
  const depts = pageProps?.auction?.departments;
  if (Array.isArray(depts) && depts.some((d) => d.sDepartment === DEPT_CARS)) return true;
  // Fall back to the lots themselves — department metadata is occasionally absent on old sales.
  const lots = pageProps?.lotData?.auctionLots;
  return Array.isArray(lots) && lots.some((l) => l?.department?.code === DEPT_CARS);
}

module.exports = { adaptLot, parseAuctionPage, auctionHasCars, DEPT_CARS };
