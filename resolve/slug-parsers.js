// PER-SOURCE URL slug parsers.
//
// Every source encodes year/make/model differently, and a single regex silently produces
// garbage for all but one of them. Measured on real scraped URLs:
//
//   bat    https://bringatrailer.com/listing/1945-czech-arsenal-t-34-85/
//   cab    https://carsandbids.com/auctions/KPdZRdgN/2026-lexus-lc-500-inspiration-series-convertible
//   mecum  https://www.mecum.com/lots/1178962/1956-chevrolet-nomad-wagon?aa_id=804160-0
//   bon    https://cars.bonhams.com/auction/31959/lot/45/lessbgreater2024-bugatti-chiron-super-sport-lessbgreaterlessbr-greater-vin-vf9sw3v39rm795109/
//   rms    https://rmsothebys.com/auctions/mo26/lots/r0170-1996-mclaren-f1-gtr/
//
// Note Bonhams: "lessbgreater" is a double-escaped "<b>" that leaked into their slug
// generator, and the slug carries a trailing "-vin-XXXXXXXX". Both must be scrubbed or the
// make/model tokens come out corrupted. RM Sotheby's prefixes a chassis/lot code (r0170)
// before the year. A generic parser cannot know any of this — hence one parser per source.

/** Strip a slug down to plain lowercase tokens. */
function tokenize(slug) {
  return String(slug)
    .toLowerCase()
    .replace(/less([a-z])greater/g, " ")   // Bonhams: "lessbgreater" -> <b>, "lessbr-greater" -> <br>
    .replace(/lessbr-?greater/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .split("-")
    .filter(Boolean);
}

/** Pull the leading 4-digit year out of a token list. */
function splitYear(tokens) {
  const i = tokens.findIndex((t) => /^(1[89]\d{2}|20[0-4]\d)$/.test(t));
  if (i === -1) return { year: null, rest: tokens };
  return { year: Number(tokens[i]), rest: [...tokens.slice(0, i), ...tokens.slice(i + 1)] };
}

const PARSERS = {
  // /listing/{year}-{make}-{model}-{dedupeCounter}/
  bat(url) {
    const m = url.match(/\/listing\/([^/?#]+)/);
    if (!m) return null;
    return splitYear(tokenize(m[1].replace(/-\d+$/, "")));
  },

  // /auctions/{lotId}/{year}-{make}-{model}
  cab(url) {
    const m = url.match(/\/auctions\/[^/]+\/([^/?#]+)/);
    if (!m) return null;
    return splitYear(tokenize(m[1]));
  },

  // /lots/{numericId}/{year}-{make}-{model}?aa_id=...
  mecum(url) {
    const m = url.match(/\/lots\/\d+\/([^/?#]+)/);
    if (!m) return null;
    return splitYear(tokenize(m[1]));
  },

  // /auction/{auctionId}/lot/{lotNo}/{mangledSlug}/
  // slug carries HTML-entity noise and a trailing "-vin-XXXXXXXXXXXXXXXXX" or "-chassis-no-X"
  bon(url) {
    const m = url.match(/\/lot\/[^/]+\/([^/?#]+)/);
    if (!m) return null;
    let slug = m[1]
      .replace(/-vin-[a-z0-9]+$/i, "")
      .replace(/-chassis-no-[a-z0-9-]+$/i, "")
      .replace(/-engine-no-[a-z0-9-]+$/i, "");
    return splitYear(tokenize(slug));
  },

  // /auctions/{auctionCode}/lots/{chassisCode}-{year}-{make}-{model}/
  rms(url) {
    const m = url.match(/\/lots\/([^/?#]+)/);
    if (!m) return null;
    // drop a leading lot/chassis code like "r0170" that precedes the year
    return splitYear(tokenize(m[1]).filter((t, i) => !(i === 0 && /^[a-z]\d+$/.test(t))));
  },

  // /auction/{year}-{make}-{modelSquishedTogether}-{numericId}
  //   2026-porsche-911turboscabriolet21miles-11061
  //   2023-landrover-rangeroversep530-11089
  // ⚠️ Sotheby's Motorsport strips ALL separators inside the model segment, and appends
  // mileage into it ("21miles"). There is no reliable way to re-tokenise "911turboscabriolet"
  // into "911 turbo s cabriolet" without a model dictionary, and guessing would silently
  // fabricate variants. So this parser returns the YEAR and MAKE only; the model must come
  // from the page title for this source. Callers get an explicit modelUnreliable flag rather
  // than a plausible-looking wrong answer.
  // /auction/{year}-{make}{modelSquishedTogether}-{lotNumber}
  //   1994-ferrari-512treurospec-10725
  // Same squished-model problem as the old sms parser this superseded — SOMO's real feed
  // (crawler/sms-adapt.js) carries make/model/year as separate structured fields, so the URL
  // is not actually needed for parsing; this exists only for the year-conflict cross-check.
  sms(url) {
    const m = url.match(/\/auction\/([^/?#]+)/);
    if (!m) return null;
    const parts = m[1].split("-");
    const yearIdx = parts.findIndex((p) => /^(1[89]\d{2}|20[0-4]\d)$/.test(p));
    if (yearIdx === -1) return null;
    const make = parts[yearIdx + 1] || null;
    return { year: Number(parts[yearIdx]), rest: make ? [make] : [], modelUnreliable: true };
  },

  // /car/{make}/{model-with--double--dashes}/{year}/{VIN}/{listingId}?list=true
  //   /car/audi/r8--v10--performance/2022/WUACEAFX9N7900678/617710
  // The most structured URL of any source: make, model, year AND VIN are all path segments,
  // so nothing has to be inferred from prose. Note the model uses DOUBLE dashes as word
  // separators ("r8--v10--performance" = "r8 v10 performance") — a single-dash split would
  // shred it into empty tokens.
  // ⚠️ DuPont Registry is a RETAIL LISTING site: these are ASKING prices, not sold prices.
  // Rows from here belong in `listing`, never in `sale`. (Ground truth §3 notes DriveIndex
  // classes dupont as an *auction* source despite this, and flags it as a possible defect
  // where asks may be leaking into sold-price maths. Do not reproduce that.)
  dupont(url) {
    const m = url.match(/\/car\/([^/]+)\/([^/]+)\/(\d{4})\/([A-Z0-9]{6,17})?/i);
    if (!m) return null;
    const make = m[1].replace(/-+/g, " ").trim();
    const model = m[2].replace(/-+/g, " ").trim();
    return { year: Number(m[3]), rest: [...make.split(" "), ...model.split(" ")].filter(Boolean), vin: m[4] || null };
  },

  // /lot/{year}-{make}-{model}[-{dedupeSuffix}]
  //   /lot/1989-ruf-928r
  //   /lot/1964-aston-martin-db5-convertible-1        <- Gooding's own dedupe suffix
  //   /lot/1976-ferrari-308-gtb-vetroresina-pb26       <- auction-code suffix (Pebble Beach '26)
  // Suffix shapes vary (numeric, "pb26", "1b"), so this only trusts the YEAR — same reasoning
  // as `sms`: guessing where the model ends and the suffix begins would fabricate a variant.
  good(url) {
    const m = url.match(/\/lot\/([^/?#]+)/);
    if (!m) return null;
    return splitYear(tokenize(m[1]));
  },

  // /auction/{slug}
  // ⚠️ PCAR Market mixes AUTOMOBILIA into the same route — observed real lots include
  // "sinclair-gas-aluminum-sign" and "large-illuminated-porsche-there-is-no-substitute-sign".
  // The slug carries no year, so there is nothing to anchor a vehicle parse on; the
  // out-of-scope gate in the resolver has to catch the signs from the TITLE instead.
  pcar(url) {
    const m = url.match(/\/auction\/([^/?#]+)/);
    if (!m) return null;
    return splitYear(tokenize(m[1]));
  },
};

// Aliases for sources that share a URL shape / registry code variants.
PARSERS.carsandbids = PARSERS.cab;
PARSERS["bring-a-trailer"] = PARSERS.bat;
PARSERS.bonhams = PARSERS.bon;
PARSERS["rm-sothebys"] = PARSERS.rms;
PARSERS.rm = PARSERS.rms;

/**
 * @returns {{year:number|null, rest:string[]}|null} null when the source has no parser or the
 *   URL doesn't match its expected shape — NEVER a silent wrong answer.
 */
function parseSlugForSource(source, url) {
  if (!source || !url) return null;
  const fn = PARSERS[String(source).toLowerCase()];
  if (!fn) return null;
  try { return fn(url); } catch { return null; }
}

function hasParser(source) {
  return Boolean(PARSERS[String(source || "").toLowerCase()]);
}

module.exports = { parseSlugForSource, hasParser, tokenize, splitYear, PARSERS };
