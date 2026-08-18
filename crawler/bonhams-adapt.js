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

const { vinYearPlausible } = require("../dedup/dedup");

const DEPT_CARS = "MOT-CAR";

/**
 * Pull the VIN out of a lot title, where Bonhams prints it as "VIN. WDBSK75F56F107641".
 *
 * Only a 17-character modern VIN is accepted. The standard excludes I, O and Q precisely so
 * they cannot be confused with 1 and 0, so a candidate containing one is not a VIN — that guard
 * is what keeps chassis numbers and lot references out of a column used for identity matching.
 * Everything else (a pre-1981 "Chassis no.", an engine number) is left alone: those are factory
 * serials, unique per car but not VINs, and merging the two concepts would make VIN-based
 * repeat-sale detection quietly wrong.
 */
function vinFields(title) {
  const m = String(title).match(/\bVIN\b\.?\s*([A-HJ-NPR-Z0-9]{17})\b/i);
  if (!m) return { vin_raw: null, vin_normal: null };
  const vin = m[1].toUpperCase();
  if (/[IOQ]/.test(vin)) return { vin_raw: null, vin_normal: null };

  // Cross-check the VIN's own year code against the year in the title. Bonhams lot 25719-178 is
  // titled "2012 Mercedes-Benz SLS Roadster" but prints WDDAJ76F96M001144 — the 2006 SLR McLaren
  // VIN already printed on lot 168 of the SAME sale. Keeping it gave two different cars one
  // vin_normal, and both cross-source dedup and repeat-sale detection key on exactly that.
  const y = String(title).match(/\b(1[89]\d{2}|20[0-4]\d)\b/);
  if (y && !vinYearPlausible(vin, Number(y[1]))) return { vin_raw: null, vin_normal: null };

  return { vin_raw: m[1], vin_normal: vin };
}

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
      // The VIN is IN the lot title ("... SL500 VIN. WDBSK75F56F107641"), which is why this is
      // populated here rather than left null as the old per-lot scraper's fields were. Taken
      // only from an explicit "VIN" clause: a pre-1981 "Chassis no." is a factory serial, not a
      // VIN, and the two must not be conflated in a column used for identity matching.
      ...vinFields(title),
      color: null,
      transmission: null,
      tc: null,
      options: [],
      image_url: lot?.image?.url || null,
      is_outlier: false,
      outlier_note: null,
      carfax_damage: false,
      // WHERE it sold, not what it sold in. Deriving this from currency (as most of the other
      // adapters still do) is wrong in both directions, and Bonhams shows both: 33 lots sold in
      // the UAE in USD would be recorded as US sales, and 78 sold in Great Britain were priced
      // in EUR. Bonhams gives a real per-lot country, so use it and fall back to the currency
      // proxy only when it is absent.
      non_us_sale: lot?.country?.code ? lot.country.code !== "US" : currency !== "USD",
      status: status === "SOLD" ? "sold" : "reserve_not_met",
      // Both forms are required. `status` is the richer enum the DB stores (it can express
      // Cars & Bids' third outcome, sold_after), but NormalizedSale in adapters/schema.js
      // declares `reserve_not_met` as a boolean and validation/validate-record.js enforces it.
      // Emitting only the enum made every Bonhams record fail the health check that is supposed
      // to gate a batch — 9,961 of 9,962 "invalid", which is the kind of result that trains
      // people to ignore the check.
      reserve_not_met: status !== "SOLD",
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

/** Pull __NEXT_DATA__ out of an auction page. Returns the pieces pagination needs too. */
function parseNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[1]);
    return { buildId: j.buildId ?? null, query: j.query ?? {}, pageProps: j?.props?.pageProps ?? null };
  } catch {
    return null;
  }
}

/** Just the pageProps, for callers that don't paginate. */
function parseAuctionPage(html) {
  return parseNextData(html)?.pageProps ?? null;
}

// The auction page server-renders only the FIRST 48 lots; the rest arrive client-side. See
// lotPageUrl below for how the remainder is reached.
const PAGE_SIZE = 48;

/**
 * URL for lots beyond the first page.
 *
 * The auction HTML renders its own pagination control as `href="?page=2#page2"`, but the SERVER
 * ignores ?page= — every value re-renders page 1. The site instead navigates client-side and
 * pulls subsequent pages from the Next.js data route for the very same page component, which
 * DOES honour ?page=. That route is the site's own public navigation endpoint, same origin, no
 * credentials — unlike the Algolia/Typesense keys in runtimeConfig, which stay untouched (see
 * the header of bonhams.crawler.js).
 *
 * buildId is deploy-scoped, so it is read from each auction page as it is fetched rather than
 * hardcoded — a Bonhams deploy mid-run invalidates it and the next page supplies a fresh one.
 */
function lotPageUrl(buildId, auctionId, auctionName, page) {
  const qs = new URLSearchParams({ auctionId: String(auctionId), auctionName, page: String(page) });
  return `https://cars.bonhams.com/_next/data/${buildId}/auction/${auctionId}/${auctionName}.json?${qs}`;
}

/** auctionLots out of a lot-page (data-route) response body. */
function parseLotPage(text) {
  try {
    return JSON.parse(text)?.pageProps?.lotData?.auctionLots ?? null;
  } catch {
    return null;
  }
}

/**
 * How many MOT-CAR lots this auction holds IN TOTAL.
 *
 * lotData.facets is computed over the whole auction, not the rendered page, so this is known
 * from page 1 alone. That is what lets pagination stop as soon as every car is in hand instead
 * of walking every page of a 240-lot mixed sale to reach 79 cars.
 */
function carLotCount(pageProps) {
  const n = pageProps?.lotData?.facets?.["department.code"]?.[DEPT_CARS];
  return Number.isFinite(n) ? n : null;
}

/** Does this auction contain ANY cars? Cheap gate before harvesting its lots. */
function auctionHasCars(pageProps) {
  // Facets count the ENTIRE auction, so this stays correct when every car sits past page 1 —
  // the case that made Goodwood 2023 (79 cars, none in the first 48 lots) look car-free.
  const facetCars = carLotCount(pageProps);
  if (facetCars != null) return facetCars > 0;
  const depts = pageProps?.auction?.departments;
  if (Array.isArray(depts) && depts.some((d) => d.sDepartment === DEPT_CARS)) return true;
  // Fall back to the lots themselves — department metadata is occasionally absent on old sales.
  const lots = pageProps?.lotData?.auctionLots;
  return Array.isArray(lots) && lots.some((l) => l?.department?.code === DEPT_CARS);
}

module.exports = {
  adaptLot, parseAuctionPage, parseNextData, parseLotPage,
  auctionHasCars, carLotCount, lotPageUrl, DEPT_CARS, PAGE_SIZE,
};
