// Dedup logic, implemented from the DriveIndex build spec (§4).
// Three layers:
//   A. Idempotent ingestion  — upsertKey()          (same lot, scraped twice)
//   B. Cross-source collision — duplicateScore()     (same lot, two sources — the dangerous one)
//   C. Repeat sales           — groupRepeatSales()   (same car, sold twice — NOT a duplicate, it's signal)

const VIN_17 = /^[A-HJ-NPR-Z0-9]{17}$/; // no I, O, Q — ISO 3779
const JUNK = new Set([
  "NUMBER", "NUMBERS", "NUMER", "NO", "N", "VIN", "CHASSIS",
  "SERIAL", "NONE", "NA", "N/A", "UNKNOWN", "TBD", "UPGRADES", "PENDING",
  "ONFILE", "AVAILABLE", "REQUEST",
]);

function normalizeVin(raw) {
  if (!raw) return null;
  const v = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (v.length < 5 || v.length > 17) return null;
  if (JUNK.has(v)) return null;
  if (!/[0-9]/.test(v)) return null; // letters only = prose, not a VIN
  if (/^(.)\1+$/.test(v)) return null; // "00000000000"
  return v;
}

function isValidVin(raw) {
  const v = normalizeVin(raw);
  if (!v || v.length < 11) return false; // >=11 admits pre-1981 chassis numbers (RM's "Chassis No.")
  return v.length !== 17 || VIN_17.test(v); // exactly 17 chars must be a legal modern VIN
}

// Position 10 of a 17-char VIN encodes the MODEL YEAR (ISO 3779 / 49 CFR 565) on a 30-year
// cycle: A..Y (no I, O, Q, U, Z) = 1980..2000, 1..9 = 2001..2009, then the cycle repeats from
// 2010. A code therefore has two candidate years 30 apart, which is still enough to catch a VIN
// attached to the wrong car.
const VIN_YEAR_CODES = "ABCDEFGHJKLMNPRSTVWXY123456789";

/** @returns {number[]|null} the two model years a 17-char VIN's year code can mean. */
function vinModelYears(raw) {
  const v = normalizeVin(raw);
  if (!v || v.length !== 17) return null;
  const i = VIN_YEAR_CODES.indexOf(v[9]);
  if (i < 0) return null;
  return [1980 + i, 2010 + i];
}

/**
 * Does a VIN's own year code agree with the year claimed for the car?
 *
 * Auction catalogues copy-paste. Bonhams lot 25719-178 is titled "2012 Mercedes-Benz SLS
 * Roadster" but carries WDDAJ76F96M001144 — a 2006 SLR McLaren VIN, the same one printed on
 * lot 168 of that very sale. Storing it made two different cars share a vin_normal, which
 * silently corrupts both cross-source dedup and repeat-sale detection, since both key on VIN.
 *
 * Unknown is not disagreement: no VIN, no year, or a non-17-char chassis number all pass. Only
 * a VIN that positively contradicts the year is rejected. ±1 year of slack because a model year
 * legitimately runs ahead of the calendar year on early-release cars.
 */
function vinYearPlausible(raw, year) {
  const years = vinModelYears(raw);
  if (!years || !Number.isFinite(year)) return true;
  return years.some((y) => Math.abs(y - year) <= 1);
}

// Layer A — idempotent ingestion key. (source, source_lot_id) is UNIQUE in the sale table;
// re-scraping the same lot is a no-op upsert keyed on this.
function upsertKey(sale) {
  if (!sale.source || !sale.source_lot_id) {
    throw new Error(`upsertKey: source and source_lot_id are required (got source=${sale.source}, source_lot_id=${sale.source_lot_id})`);
  }
  return `${sale.source}::${sale.source_lot_id}`;
}

function daysApart(a, b) {
  if (!a.sold_at || !b.sold_at) return Infinity;
  return Math.abs(new Date(a.sold_at) - new Date(b.sold_at)) / 86400000;
}

// crude trigram Jaccard similarity — good enough to catch title paraphrase between sources
function trigramSimilarity(a, b) {
  if (!a || !b) return 0;
  const grams = (s) => {
    const t = s.toLowerCase().replace(/\s+/g, " ").trim();
    const set = new Set();
    for (let i = 0; i < t.length - 2; i++) set.add(t.slice(i, i + 3));
    return set;
  };
  const ga = grams(a), gb = grams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return inter / (ga.size + gb.size - inter);
}

// A listing URL, stripped of query string and trailing slash. This is the identity of an
// auction EVENT, and it is the strongest evidence the pipeline has.
function canonicalListingUrl(u) {
  const s = String(u || "").split("?")[0].split("#")[0].replace(/\/+$/, "").toLowerCase();
  return s || null;
}

// Layer B — cross-source collision score, per the build spec.
// Same listing URL, or a VIN match within 7 days, = certain duplicate. Otherwise: price
// closeness (buyer's-premium aware), date closeness, mileage closeness, and title similarity,
// summed. Collapse at >= 0.75.
function duplicateScore(a, b) {
  // SAME SOURCE + SAME LISTING URL + SAME WEEK => ONE AUCTION EVENT, recorded twice.
  //
  // Added after a real miss: two harvesters recorded the same BaT lot under different ids (the
  // API issues a numeric id, the DOM crawler reverse-engineered a slug), so the natural key did
  // not collide. Scoring then reached 0.7375 against a 0.75 threshold — short by 0.0125,
  // because one title carried page chrome which diluted trigram similarity from 0.10 to 0.0375.
  // One sale entered the index twice. Both records had the same URL throughout: that is
  // identity, and weighing it on a similarity scale was the error.
  //
  // SCOPED TO ONE SOURCE ON PURPOSE. A URL identifies a listing ON ITS OWN SITE. Cross-source
  // duplicates — the case Layer B mainly exists for — are two sites reporting one event, and
  // by definition have different URLs; there the evidence really is circumstantial and must be
  // scored. Comparing URLs across sources would only ever fire on malformed data.
  //
  // DATE-GUARDED ON PURPOSE. Verified on the real corpus that BaT issues a fresh slug (-2, -3 …)
  // for a relist rather than reusing one — across 21,171 API records, zero URLs appear under
  // more than one lot id. That is verified for BaT, not for all thirteen sources, so if some
  // other house does reuse a lot URL months later the pair falls through to scoring instead of
  // being collapsed. Wrongly merging a genuine repeat sale would destroy the product's most
  // valuable signal, so the uncertain case must not take the certain path.
  const ua = canonicalListingUrl(a.url), ub = canonicalListingUrl(b.url);
  if (ua && ub && ua === ub && a.source === b.source && daysApart(a, b) <= 7) return 1.0;

  if (a.vin_normal && b.vin_normal) {
    return a.vin_normal === b.vin_normal && daysApart(a, b) <= 7 ? 1.0 : 0;
  }

  let score = 0;
  const pa = a.price_usd, pb = b.price_usd;
  if (pa != null && pb != null && Math.max(pa, pb) > 0) {
    const pDiff = Math.abs(pa - pb) / Math.max(pa, pb);
    // FIX (found empirically, see dedup/dedup.demo.js): the build-spec formula only gave
    // credit up to a 2% gap, but the spec's own note says buyer's premium is typically
    // 5-12% — so any real hammer-vs-all-in republish (the single most common cross-source
    // duplicate shape) fell into a dead zone and scored ~0 on price. Tested against a real
    // Cars & Bids sale republished at 3% under: pre-fix this band contributed 0, and the
    // pair scored 0.479 overall — well under the 0.75 collapse threshold, i.e. a genuine
    // false negative. This band closes that gap.
    if (pDiff < 0.005) score += 0.45; // same hammer price
    else if (pDiff < 0.02) score += 0.20; // rounding / minor fee variance
    else if (pDiff <= 0.13) score += 0.30; // consistent with hammer vs. all-in (buyer's premium)
  }

  const d = daysApart(a, b);
  if (d <= 2) score += 0.25;
  else if (d <= 7) score += 0.10;

  if (a.mileage != null && b.mileage != null &&
      Math.abs(a.mileage - b.mileage) <= Math.max(100, 0.01 * a.mileage)) {
    score += 0.20;
  }

  score += 0.10 * trigramSimilarity(a.title, b.title);
  return score;
}

const DUPLICATE_THRESHOLD = 0.75;

// Aggregators always lose the survivor pick, even against a low-trust primary source.
const SOURCE_TRUST = {
  bat: 1, cab: 1, rms: 1, sms: 1, good: 1, bon: 1, bj: 1,
  mecum: 1, broadarrow: 1, pcar: 1, collectingcars: 1,
  hagerty: 2, dupont: 2, carscom: 3, classic: 9,
};

function pickSurvivor(a, b) {
  const ta = SOURCE_TRUST[a.source] ?? 5;
  const tb = SOURCE_TRUST[b.source] ?? 5;
  return ta <= tb ? a : b;
}

// Layer B driver: given a pool of candidate sales for ONE car (already resolved to the same
// car_id), collapse cross-source duplicates and return { kept, dropped } lists.
function collapseDuplicates(sales) {
  const kept = [];
  const dropped = [];
  const consumed = new Set();

  for (let i = 0; i < sales.length; i++) {
    if (consumed.has(i)) continue;
    let survivor = sales[i];
    for (let j = i + 1; j < sales.length; j++) {
      if (consumed.has(j)) continue;
      if (daysApart(survivor, sales[j]) > 7) continue; // candidate window
      const score = duplicateScore(survivor, sales[j]);
      if (score >= DUPLICATE_THRESHOLD) {
        const loser = pickSurvivor(survivor, sales[j]) === survivor ? sales[j] : survivor;
        const winner = loser === survivor ? sales[j] : survivor;
        dropped.push({ ...loser, _dropped_reason: `duplicate of ${winner.source}:${winner.source_lot_id} (score ${score.toFixed(2)})` });
        survivor = winner;
        consumed.add(j);
      }
    }
    kept.push(survivor);
  }
  return { kept, dropped };
}

// Layer C — repeat sales. Same VIN, sold 2+ times, on CLEAN sales only. This is signal, not
// a duplicate — never collapse it.
function groupRepeatSales(sales) {
  const eligible = sales.filter((s) =>
    !s.is_outlier && !s.carfax_damage && !s.non_us_sale && !s.reserve_not_met &&
    s.price > 0 &&
    (!s.currency || s.currency === "USD") &&
    isValidVin(s.vin_raw)
  );

  const byVin = new Map();
  for (const s of eligible) {
    const key = normalizeVin(s.vin_raw);
    const g = byVin.get(key) || [];
    g.push(s);
    byVin.set(key, g);
  }

  return [...byVin.entries()]
    .filter(([, g]) => g.length >= 2)
    .map(([vin, g]) => ({
      vin,
      sales: g.sort((a, b) => new Date(a.sold_at) - new Date(b.sold_at)),
    }));
}

module.exports = {
  normalizeVin, isValidVin, vinModelYears, vinYearPlausible, upsertKey, duplicateScore, DUPLICATE_THRESHOLD,
  SOURCE_TRUST, pickSurvivor, collapseDuplicates, groupRepeatSales, daysApart, trigramSimilarity,
  canonicalListingUrl,
};
