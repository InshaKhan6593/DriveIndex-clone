// Entity resolution v2 — "is this a car we already have, or a genuinely new one?"
//
// v1 failed this outright: 12 real records produced 12 new car_ids, 0 matches. Every sale
// became its own singleton "model", so no car ever accumulated the sale history the whole
// valuation engine depends on. A price index where every car has n=1 can only ever output
// "insufficient data" — which is exactly what the nightly job reported.
//
// v2 pipeline, per title:
//   1. out-of-scope gate      -> human review (the ONLY thing that should reach review)
//   2. strip noise prefixes   ("28k-Mile", "RoW", "ca.", "34-Years-Owned")
//   3. extract year           (handles "1963.5", "ca.1945")
//   4. longest-prefix make    (mapping table — the one place DriveIndex also uses one)
//   5. extract body style     -> own column        (§7: 29% of their models are polluted)
//   6. extract generation     -> own column
//   7. extract transmission   -> own column
//   8. extract modification   -> own column        (Singer/RWB/swap never merge with stock)
//   9. token-sort the rest    -> canonical model key
//  10. find-or-create against (year, make, model_key, body, gen, modification)
//
// Step 9 is the ground-truth §7 recommendation. It is what makes
//   "R8 V10 Performance Coupe Quattro"  ==  "R8 V10 Performance Quattro Coupe"
// while VARIANT_TOKENS keeps "GT3 RS" != "GT3".

const { newId } = require("../db/client");
const {
  BODY_STYLES, BODY_WORDS_ALSO_MODELS, VARIANT_TOKENS,
  NOISE_PREFIX_PATTERNS, MODIFICATION_MARKERS, OUT_OF_SCOPE, MOTORCYCLE_MAKES,
  GENERATION_PATTERNS, GENERATION_CODES, MOTORCYCLE_MODEL_PATTERNS,
} = require("./vocab");

const { MAKE_ALIASES } = require("./vocab");

const MAKE_KEYS_LONGEST_FIRST = [...MAKE_ALIASES.keys()].sort((a, b) => b.split(" ").length - a.split(" ").length || b.length - a.length);

function stripNoisePrefixes(title) {
  let t = title.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of NOISE_PREFIX_PATTERNS) {
      const next = t.replace(re, "");
      if (next !== t) { t = next.trim(); changed = true; }
    }
  }
  return t;
}

function extractYear(text) {
  // "1963.5 Ford Falcon" -> 1963 ; "ca.1945 T-34" handled by prefix strip first
  const m = text.match(/\b(1[89]\d{2}|20[0-4]\d)(?:\.\d)?\b/);
  if (!m) return null;
  const year = Number(m[1]);
  if (year < 1885 || year > new Date().getFullYear() + 2) return null;
  return { year, index: m.index, length: m[0].length };
}

// Fold accents onto their base letters for MATCHING only. The alias table stores plain-ASCII
// keys ("citroen"), while sources print the real spelling ("Citroën"), so every Citroën in the
// corpus failed to match a make and went to human review — along with Škoda, Citroën's stablemates
// and anything else Latin-accented.
//
// NFD splits an accented character into base + combining mark, and dropping the mark leaves the
// base at the SAME string length, so match indices stay valid for the caller's slicing. The
// canonical make name returned is still the accented one — this affects lookup, not display.
const foldDiacritics = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "");

// Words that follow a year but are descriptors, not marques. Shape-based: these are the
// condition/provenance adjectives auction houses put in front of the make, plus body words.
// Kept deliberately small — it is a stop-list for POSITION, not a catalogue of brands.
const NOT_A_MAKE = new Set([
  "the", "a", "an", "custom", "modified", "restored", "original", "vintage", "classic",
  "rare", "one", "two", "three", "four", "five", "six", "twin", "single", "ex", "former",
  "believed", "circa", "ca", "sold", "lot", "no", "with", "and", "for", "from", "style",
  "styled", "replica", "tribute", "recreation", "series", "model", "type", "project",
  "barn", "estate", "family", "owned", "owner", "mile", "miles", "km", "kilometer",
]);

// Take the marque from its POSITION after the year. Returns the same shape extractMake does,
// so the caller treats it identically — except the caller marks it `makeInferred`, and the
// evidence layer then has to vouch for it before anything is indexed.
//
// EXACTLY ONE TOKEN. A first attempt joined a second capitalised word so that "Avions Voisin"
// and "American Underslung" stayed whole — but it also produced "Imperial Hemi" from
// "Restored 1956 Imperial Hemi Sedan", because Hemi is an engine name and there is no
// principled way to tell engine names, trim names and marque second-words apart without
// starting exactly the kind of hand-maintained list this whole approach exists to avoid.
//
// Taking one token is strictly safer and loses nothing that matters:
//   * IDENTITY is preserved — every Avions Voisin resolves to make "Avions" with "voisin" in
//     the model key, so they all land on the same car. Nothing splits.
//   * COLLISIONS do not merge cars — "American Underslung" and "American Austin" share the
//     make "American" but differ in model key, so they remain separate cars.
//   * the display name is imperfect for a handful of two-word marques; that is a cosmetic
//     cost, paid to avoid a correctness risk, and a human can correct it from the queue.
function inferMakeFromPosition(afterYear) {
  const tokens = String(afterYear).trim().split(/\s+/).filter(Boolean);
  const clean = (t) => t.replace(/[^A-Za-zÀ-ÿ&'.-]/g, "");

  let i = 0;
  while (i < tokens.length && NOT_A_MAKE.has(clean(tokens[i]).toLowerCase())) i++;
  if (i >= tokens.length) return null;

  const first = clean(tokens[i]);
  // A marque is a word, not a number or a single initial.
  if (first.length < 2 || !/^[A-Za-zÀ-ÿ]/.test(first)) return null;
  if (BODY_STYLES.has(first.toLowerCase()) || VARIANT_TOKENS.has(first.toLowerCase())) return null;

  // Lowercase FIRST, then title-case — an all-caps source title ("1949 REO Speed Wagon", REO
  // being a real acronym-style marque) must normalise to the same make as a mixed-case one
  // ("1949 Reo Speed Wagon"). The earlier version only ever uppercased, never lowercased, so
  // "REO" passed straight through unchanged while "Reo" normalised correctly — two different
  // `make` strings for the identical car, splitting its price history in two (measured: BaT
  // lots 15543970 and 65604226, "1949 Reo/REO Speed Wagon D19XA Pickup").
  const titleCase = first.toLowerCase().replace(/\b[a-zà-ÿ]/g, (c) => c.toUpperCase());
  return { make: titleCase, matchedKey: titleCase.toLowerCase(), index: 0, length: first.length, inferred: true };
}

function extractMake(text) {
  const lower = foldDiacritics(text.toLowerCase());
  for (const key of MAKE_KEYS_LONGEST_FIRST) {
    // word-boundary match so "mg" doesn't fire inside "MGB-something" incorrectly, and
    // "ford" doesn't match inside "Bradford"
    const re = new RegExp(`(^|[^a-z0-9])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i");
    const m = lower.match(re);
    if (m) {
      const start = m.index + m[1].length;
      return { make: MAKE_ALIASES.get(key), matchedKey: key, index: start, length: key.length };
    }
  }
  return null;
}

function extractBodyStyle(tokens) {
  // Scan right-to-left: body style is nearly always a trailing token.
  for (let i = tokens.length - 1; i >= 0; i--) {
    const clean = tokens[i].toLowerCase().replace(/[^a-z-]/g, "");
    if (BODY_STYLES.has(clean)) {
      // Guard: if removing it would leave nothing, it IS the model ("Speedster", "Targa").
      const remaining = tokens.filter((_, j) => j !== i);
      if (remaining.length === 0 && BODY_WORDS_ALSO_MODELS.has(clean)) return null;
      return { body: BODY_STYLES.get(clean), index: i };
    }
  }
  return null;
}

function extractGeneration(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const bare = tokens[i].replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    if (GENERATION_CODES.has(bare)) return { generation: bare, index: i };
    for (const re of GENERATION_PATTERNS) {
      if (re.test(tokens[i])) return { generation: tokens[i].toUpperCase(), index: i };
    }
  }
  return null;
}

// Engine displacement — "3.6", "3.8L", "6.0", "5.0L", "427" (cubic inches).
//
// This started life as an AMBIGUITY: "911 turbo" vs "3.8l 911 turbo" went to human review
// because the scorer could not tell whether "3.8l" was identity or noise. It is neither —
// it is a THIRD thing: a structured attribute. Sometimes it genuinely distinguishes models
// (a 964 Turbo 3.6 is not a Turbo 3.3; a Diablo VT 6.0 is not a Diablo VT), and sometimes
// it is just descriptive. Pulling it into its own column makes the distinction deterministic
// rather than a judgement call — different displacement means a different car, same
// displacement (including both absent) means the same car, and nobody has to review it.
function extractDisplacement(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].toLowerCase();
    // metric litres: 3.6, 3.8l, 6.0-liter
    let m = t.match(/^(\d\.\d)l?$/) || t.match(/^(\d\.\d)-?lit(er|re)$/);
    if (m) return { displacement: `${m[1]}L`, index: i };
    // cubic inches: 427ci, 302-ci
    m = t.match(/^(\d{3})-?ci$/);
    if (m) return { displacement: `${m[1]}ci`, index: i };
  }
  return null;
}

function extractTransmission(text) {
  const m = text.match(/\b(\d)-speed\b/i);
  if (m) return { speeds: Number(m[1]), raw: m[0] };
  if (/\bpdk\b/i.test(text)) return { speeds: null, raw: "PDK" };
  if (/\bdct\b/i.test(text)) return { speeds: null, raw: "DCT" };
  if (/\btiptronic\b/i.test(text)) return { speeds: null, raw: "Tiptronic" };
  return null;
}

function extractModification(text) {
  for (const { re, tag } of MODIFICATION_MARKERS) {
    if (re.test(text)) return tag;
  }
  return null;
}

function checkOutOfScope(title) {
  for (const { re, reason } of OUT_OF_SCOPE) {
    if (re.test(title)) return reason;
  }
  // Makes that build BOTH cars and motorcycles (Honda, Suzuki, BMW, Yamaha) can only be
  // separated on the model, never the make — rejecting Honda outright would discard NSXs.
  for (const re of MOTORCYCLE_MODEL_PATTERNS) {
    if (re.test(title)) return "motorcycle model, out of scope";
  }
  return null;
}

/**
 * Canonical model key: lowercase, punctuation-normalised, tokens SORTED.
 * Sorting is what collapses word-order variants. VARIANT_TOKENS are preserved (they're
 * still in the sorted set), so ordering can't lose a variant — only reorder it.
 */
function canonicalModelKey(tokens) {
  const cleaned = tokens
    .map((t) => t.toLowerCase().replace(/[^a-z0-9/.\-]/g, ""))
    // An INTERNAL hyphen inside a model CODE carries no meaning — it is a typesetting choice
    // the auction house made, not a property of the car. Real split caught by the audit:
    // "corvette l-82" and "corvette l82" were two different 1978 Corvettes with one car's price
    // history torn between them.
    //
    // A code is told from a compound NAME by fragment length: codes have a one- or two-letter
    // fragment (l-82, f-250, gt-r, e-type, cx-5, s-class) while genuine compound names are two
    // real words (mercedes-benz, rolls-royce, alfa-romeo). Any digit also marks a code.
    // Shape-based, so it holds for designations nobody has enumerated.
    .map((t) => {
      if (!t.includes("-")) return t;
      const parts = t.split("-").filter(Boolean);
      const isCode = /\d/.test(t) || parts.some((p) => p.length <= 2);
      return isCode ? parts.join("") : t;
    })
    .filter((t) => t.length > 0)
    .filter((t) => !/^(the|a|an|with|and|for|w)$/.test(t))
    // Transmission is a SALE attribute (captured per-sale in `tc`), never part of the CAR's
    // identity — DriveIndex models it the same way, with a has_transmission_split flag on the
    // car rather than separate car rows. Leaving these in the key split "240Z" from
    // "240Z Automatic" and sent a stream of real cars to human review.
    .filter((t) => !/^(automatic|auto|manual|stick|tiptronic|pdk|dct|speed)$/.test(t));
  return [...new Set(cleaned)].sort().join(" ");
}

/**
 * Parse a raw auction title into structured car identity fields.
 * Pure function — no DB access, so it is directly unit-testable.
 *
 * @param {string} rawTitle
 * @param {{url?: string}} [ctx] - the listing URL is used ONLY as a year fallback. Auction
 *   houses title cars for drama ("“5 Ton Fred” Wrecker-Style...", "Ferrari 250 GT Speciale
 *   Spyder Re-Creation") but their URL slugs are machine-generated and nearly always start
 *   with the year. Measured on this dataset: recovers 3 of 6 review cases with no loss of
 *   precision. Only the YEAR is taken from the URL — never the make/model, because the slug
 *   can disagree with the title (a real example here: title "Ferrari 212 Barchetta
 *   Re-Creation" on URL slug ".../1965-ferrari-330gt-6/" — a 330GT rebodied as a 212 replica.
 *   Trusting the slug's model there would file a replica under a genuine 330GT).
 */
// ── HTML ENTITIES AND TYPOGRAPHY ───────────────────────────────────────────────────────
//
// Source titles arrive HTML-encoded, and leaving them that way silently corrupts identity.
// Measured across the corpus: 1,046 of 22,506 titles (4.6%) carry entities, `&#215;` (the
// multiplication sign, i.e. the × in "4×4") alone appearing 497 times. Undecoded, the entity's
// own digits become part of the model key:
//
//     "Black-Plate 1964 Nissan Patrol 4&#215;4"  ->  model key "42154 patrol"
//     "1994 Land Rover Defender 90 4&#215;4"     ->  model key "42154 90 defender"
//
// So a Patrol 4x4 and a Patrol became different cars over an encoding artefact, and "42154"
// entered the catalogue as if it were a model designation.
//
// Decoding happens HERE, in the shared parser, rather than in each adapter: it is a property
// of HTML, not of any one auction house, and doing it here also repairs titles already
// scraped without re-fetching them. Every source added later gets it for free.
const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-" };

function decodeEntities(s) {
  return String(s || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return " "; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return " "; } })
    .replace(/&([a-z]+);/gi, (m, n) => NAMED_ENTITIES[n.toLowerCase()] ?? m);
}

// Fold typographic characters onto their plain-ASCII equivalents so that "4×4", "4x4" and
// "4X4" all reach the key as the same token. Without the × mapping the cleaner strips it and
// leaves "44", which then collides with the plain number 44.
function normalizeTypography(s) {
  return String(s || "")
    .replace(/[×✕✖]/g, "x")        // × multiplication sign -> x
    .replace(/[‘’‛]/g, "'")        // curly single quotes
    .replace(/[“”‟]/g, '"')        // curly double quotes
    .replace(/[′‵]/g, "'")              // prime (feet)
    .replace(/[″‶]/g, '"')              // double prime (inches)
    .replace(/[–—−]/g, "-")        // en/em dash, minus
    .replace(/ /g, " ")                      // non-breaking space
    .replace(/\s+/g, " ")
    .trim();
}

function parseTitle(rawTitle, ctx = {}) {
  const title = normalizeTypography(decodeEntities(String(rawTitle || "").trim()));

  const outOfScope = checkOutOfScope(title);
  if (outOfScope) return { ok: false, reason: outOfScope, needsReview: true };

  const stripped = stripNoisePrefixes(title);

  let yearInfo = extractYear(stripped);
  let afterYear;

  if (yearInfo) {
    afterYear = stripped.slice(yearInfo.index + yearInfo.length).trim();
  } else if (ctx.url) {
    const slugYear = String(ctx.url).match(/\/(1[89]\d{2}|20[0-4]\d)-/);
    if (slugYear) {
      yearInfo = { year: Number(slugYear[1]), index: 0, length: 0, fromUrl: true };
      afterYear = stripped; // whole title is model text; no year to cut around
    }
  }

  if (!yearInfo) return { ok: false, reason: "no parseable year in title or URL", needsReview: true };

  let makeInfo = extractMake(afterYear);
  let makeInferred = false;

  if (!makeInfo) {
    // Might be a motorcycle marque, which reads as a plausible make but is out of scope.
    //
    // Check the first TWO words as well as the first. Many motorcycle marques are two-word
    // names — Moto Guzzi, MV Agusta, Royal Enfield — and a first-word-only test let them
    // straight through positional inference as makes "Moto" and "MV". Measured in the queue:
    // Moto 211 items, MV 139, which would have been the single largest source of non-cars
    // entering the index once inference was switched on.
    const words = afterYear.split(/\s+/).map((w) => foldDiacritics(w.toLowerCase()).replace(/[^a-z0-9-]/g, ""));
    const firstWord = words[0] || "";
    const firstTwo = words.slice(0, 2).filter(Boolean).join(" ");
    if (MOTORCYCLE_MAKES.has(firstWord) || (firstTwo && MOTORCYCLE_MAKES.has(firstTwo))) {
      return { ok: false, reason: "motorcycle marque, out of scope", needsReview: true, year: yearInfo.year };
    }

    // ── POSITIONAL MAKE INFERENCE ──────────────────────────────────────────────────────
    // Auction titles are overwhelmingly "{year} {make} {model} ...", so the word right after
    // the year is the marque. Relying only on a curated alias list means every marque nobody
    // has hand-added is discarded — and the corpus showed how expensive that is: 4,366 queued
    // items with no make at all, including real and valuable cars ("1913 Mercer Model 35-J
    // Raceabout", "1924 Hispano-Suiza H6C Monza Speedster", "1948 Delahaye 135 M Cabriolet").
    // RM Sotheby's catalogue is largely pre-war, so 73% of its lots were being dropped.
    //
    // THIS DOES NOT ACCEPT THE CAR. It only produces a CANDIDATE make, flagged
    // `makeInferred`, which still has to clear the structural rejects and then earn acceptance
    // from the evidence layer's batch-diversity gate. That gate is what separates a real marque
    // (many model years, several models) from a repeated mis-parse (one frozen string).
    // Measured on the head of this bucket: only ~1 in 6 distinct first-words is a car marque —
    // the rest are motorcycles, RVs, race constructors, tyres and coachbuilders — which is
    // exactly why inference alone must never be trusted.
    const inferred = inferMakeFromPosition(afterYear);
    if (!inferred) {
      return { ok: false, reason: "no recognised make in title", needsReview: true, year: yearInfo.year };
    }
    makeInfo = inferred;
    makeInferred = true;
  }
  if (MOTORCYCLE_MAKES.has(makeInfo.matchedKey)) {
    return { ok: false, reason: "motorcycle marque, out of scope", needsReview: true, year: yearInfo.year, make: makeInfo.make };
  }

  const modification = extractModification(title); // check the FULL title — markers appear in prefixes too
  const transmission = extractTransmission(afterYear);

  // Everything after the make is candidate model text.
  let rest = afterYear.slice(makeInfo.index + makeInfo.length).trim();

  // Remove transmission and modification words so they don't fragment the model.
  if (transmission) rest = rest.replace(new RegExp(transmission.raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), " ");
  for (const { re } of MODIFICATION_MARKERS) rest = rest.replace(re, " ");
  rest = rest.replace(/["“”'’]/g, " ").replace(/\s+/g, " ").trim();

  let tokens = rest.split(/\s+/).filter(Boolean);

  const genInfo = extractGeneration(tokens);
  if (genInfo) tokens = tokens.filter((_, i) => i !== genInfo.index);

  const bodyInfo = extractBodyStyle(tokens);
  if (bodyInfo) tokens = tokens.filter((_, i) => i !== bodyInfo.index);

  const dispInfo = extractDisplacement(tokens);
  if (dispInfo) tokens = tokens.filter((_, i) => i !== dispInfo.index);

  if (tokens.length === 0) {
    // Make-only title, e.g. "2006 Ford GT" where GT got eaten. Fall back to the raw rest.
    tokens = rest.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      return { ok: false, reason: "no model text after make", needsReview: true, year: yearInfo.year, make: makeInfo.make };
    }
  }

  const modelKey = canonicalModelKey(tokens);
  if (!modelKey) {
    return { ok: false, reason: "model resolved to empty after normalisation", needsReview: true, year: yearInfo.year, make: makeInfo.make };
  }

  return {
    ok: true,
    year: yearInfo.year,
    make: makeInfo.make,
    modelDisplay: tokens.join(" "),   // human-readable, original order
    modelKey,                          // canonical, sorted — the identity key
    bodyType: bodyInfo ? bodyInfo.body : null,
    displacement: dispInfo ? dispInfo.displacement : null,
    generation: genInfo ? genInfo.generation : null,
    transmissionSpeeds: transmission ? transmission.speeds : null,
    modification,
    // TRUE when the make came from POSITION rather than the curated alias list. The evidence
    // layer treats these strictly: an inferred make can never take the curated fast path, and
    // must earn acceptance from batch diversity. Carried through so the distinction survives
    // into the review queue and is visible to a human.
    makeInferred,
  };
}

/**
 * Decide whether two model keys that are NOT identical represent the same car.
 *
 * Returns "different" (confidently distinct), "ambiguous" (needs a human), or "same".
 *
 * The discriminator is WHICH tokens differ:
 *   • differ by a VARIANT token (rs, s, 4s, turbo, gts...) -> confidently DIFFERENT.
 *     "911 gt3" vs "911 gt3 rs" is a real, price-relevant distinction and the whole reason
 *     VARIANT_TOKENS exists (ground truth §4.5: one GT3 RS mis-filed under GT3 drags a
 *     model-year's value up and can flip its signal).
 *   • differ ONLY by non-variant tokens (engine displacement "3.6", filler words, marketing
 *     noise) -> AMBIGUOUS. "911 turbo" vs "3.6 911 turbo" is probably the same 964 Turbo, but
 *     "probably" is not good enough to either merge or split silently.
 */
// A "model designator" is the token that actually names the model, as opposed to trim or
// package words. Pattern (not a word list): model names overwhelmingly either contain a
// digit (F-350, 911, 488, MX-5, E30) or are the longest distinctive alphabetic token
// (Bronco, Mustang, Corvette). Trim words — XLT, Ranger, Limited, SE — are short, shared
// across a manufacturer's whole range, and are exactly what made the naive overlap metric
// fail.
// An ENGINE CONFIGURATION is never a model name. V8, V12, I6, flat-6 and friends contain a
// digit, so the "has a digit => probably the model" heuristic mistook them for model
// designators. Real failure caught by the split audit: "f-250 v8" vs "mustang v8" matched on
// the shared "v8" and a 1970 F-250 was scored as possibly the same car as a Mustang.
// This is a shape (letter + digit engine layout), not a list of engines.
const ENGINE_CONFIG = /^(v|i|l|b|r|w|flat|h)-?\d{1,2}$/i;

// BUG FIX — when several tokens TIE for longest, return them ALL rather than an arbitrary one.
// Taking `sorted[0]` silently depended on sort order for equal-length tokens. Real failure:
// "eleanor mustang" vs "bullitt mustang" — both tokens are 7 characters, so A's designator
// resolved to "eleanor" and B's to "bullitt", they failed to match, and two nickname builds of
// the SAME base model were declared different with no review. The model token was right there
// in both keys; the tie-break threw it away.
function modelDesignators(tokens) {
  const usable = tokens.filter((t) => !ENGINE_CONFIG.test(t));
  const pool = usable.length ? usable : tokens;
  const withDigits = pool.filter((t) => /\d/.test(t) && t.length >= 2);
  if (withDigits.length) return new Set(withDigits);
  const max = pool.reduce((m, t) => Math.max(m, t.length), 0);
  return new Set(pool.filter((t) => t.length === max));
}

// The longest PURELY ALPHABETIC token(s) — the part of a key that spells a model name rather
// than a number. Kept separate from modelDesignators because a shared NUMBER is much weaker
// evidence of sameness than a shared NAME: American keys routinely carry a cubic-inch engine
// size ("327 camaro" vs "327 corvette"), and matching on 327 alone made a Camaro and a
// Corvette look like the same car.
function alphaDesignators(tokens) {
  const alpha = tokens.filter((t) => /^[a-z]+$/i.test(t) && t.length >= 3);
  if (!alpha.length) return new Set();
  const max = alpha.reduce((m, t) => Math.max(m, t.length), 0);
  return new Set(alpha.filter((t) => t.length === max));
}

function compareModelKeys(a, b) {
  if (a === b) return "same";
  const listA = a.split(" ").filter(Boolean), listB = b.split(" ").filter(Boolean);
  const ta = new Set(listA), tb = new Set(listB);
  const onlyA = [...ta].filter((t) => !tb.has(t));
  const onlyB = [...tb].filter((t) => !ta.has(t));
  const diff = [...onlyA, ...onlyB];
  if (diff.length === 0) return "same";

  // BUG FIX — the model designator decides FIRST, before any overlap maths.
  // Real failure this fixes: "bronco ranger xlt" vs "44 f-350 ranger xlt" was scored
  // AMBIGUOUS and sent to a human, because the shared trim words "ranger xlt" gave it 0.5
  // overlap. A Bronco and an F-350 are not remotely the same vehicle. Shared TRIM is not
  // evidence of sameness; a differing MODEL is proof of difference.
  // A key that is a strict SUBSET of the other is a BASE model vs a qualified variant of it
  // ("m3" vs "dinan m3", "240z" vs "240z widebody"). That is a real, decidable distinction —
  // the extra token qualifies the car — not an ambiguity a human needs to arbitrate. Before
  // this, every base model in the corpus queued against its own tuned/qualified siblings.
  const aSubsetB = [...ta].every((t) => tb.has(t));
  const bSubsetA = [...tb].every((t) => ta.has(t));
  if (aSubsetB || bSubsetA) return "different";

  const dA = modelDesignators(listA), dB = modelDesignators(listB);
  const designatorsMatch = [...dA].some((t) => dB.has(t)) || [...dB].some((t) => dA.has(t));
  if (!designatorsMatch) return "different";

  // A shared NUMBER is not enough when the NAMES disagree. "327 camaro" and "327 corvette"
  // share a cubic-inch engine size and nothing else; so do "510 bre" (a BRE race tribute) and
  // "510 station" (a wagon). If both keys name a model in letters and those names are
  // disjoint, they are different cars however many numbers they have in common.
  const aA = alphaDesignators(listA), aB = alphaDesignators(listB);
  if (aA.size && aB.size && ![...aA].some((t) => aB.has(t))) return "different";

  const shared = [...ta].filter((t) => tb.has(t)).length;
  const overlap = shared / Math.max(ta.size, tb.size);

  // Nothing meaningful in common -> plainly different cars, no review needed.
  if (overlap < 0.5) return "different";

  // Any differing token that is a known variant => a real distinction.
  if (diff.some((t) => VARIANT_TOKENS.has(t))) return "different";

  // Same model designator, high overlap, differing only by unrecognised tokens => genuinely
  // uncertain, so a human decides.
  return "ambiguous";
}

// ── WHAT A MISSING ATTRIBUTE MEANS ─────────────────────────────────────────────────────
//
// Not all blanks are the same, and treating them alike was splitting real cars.
//
// INTRINSIC attributes describe something EVERY car necessarily has. A car always has a body
// style, an engine size, a generation. If the title does not say, the value is UNKNOWN — not
// absent. "1965 Ford Mustang" is not a Mustang with no body style; it is a Mustang whose body
// style the seller did not type.
//
// ASSERTED attributes describe something UNUSUAL being present. Absence is a real, positive
// claim: no modification found means STOCK. A race-prepped M3 and a stock M3 are genuinely
// different assets, so here a blank must keep separating.
//
// Measured on the live catalogue before this fix: 171 body_type and 38 displacement pairs were
// one car recorded twice, split purely on whether a listing happened to mention the attribute.
// The 92 `modification` pairs in the same scan were CORRECT and are deliberately untouched.
//
// This matters much more as sources are added. BaT titles are unusually descriptive
// ("34K-Mile 1987 Porsche 911 Carrera Cabriolet G50"); Mecum's are terse ("1969 Chevrolet
// Camaro"). Without this rule every terse source forks a parallel catalogue beside the
// descriptive one, and the two never join. It is a property of the DATA MODEL, not of any
// source's formatting, so it needs no per-source tuning.
const INTRINSIC_ATTRS = ["body_type", "generation", "displacement"];
const ASSERTED_ATTRS = ["modification"];

const blank = (v) => v === null || v === undefined || v === "";

// Two values for an INTRINSIC attribute are compatible when they agree, or when either side
// simply does not know. Unknown is a wildcard, never a distinct value.
const intrinsicCompatible = (a, b) => blank(a) || blank(b) || String(a) === String(b);

const PARSED_FIELD = { body_type: "bodyType", generation: "generation", displacement: "displacement", modification: "modification" };

/**
 * Find an existing car matching this parse, create one, or refuse and ask for a human.
 *
 * Identity = (year, make, model_key, body_type, generation, modification, displacement).
 * modification is part of identity on purpose: a Singer 911 and a stock 911 of the same year
 * are different assets and must never share a price curve.
 *
 * POLICY (this is the "perfect, or human review — never bad data" rule):
 *   exact key match                    -> ATTACH   (no new car; this is just another sale)
 *   one compatible car, blanks aside   -> ATTACH   (and enrich the row with what we learned)
 *   several compatible cars that       -> REVIEW   (a coin flip is not a decision)
 *     disagree on a stated value
 *   no similar car in (year, make)     -> CREATE   (genuinely new)
 *   similar-but-not-identical car      -> REVIEW   (never guess in either direction)
 *
 * DriveIndex does NOT do this — ground truth §7 measured 163 near-duplicate model pairs in
 * their own catalogue, e.g. "R8 V10 Performance Coupe Quattro" AND "R8 V10 Performance
 * Quattro Coupe" as separate models with separate price histories. Token-sorting kills that
 * particular class outright; this ambiguity gate catches the rest rather than reproducing it.
 */
function findOrCreateCar(db, parsed) {
  const exact = db.prepare(
    `SELECT id FROM car
     WHERE year = ? AND make = ? AND model_key = ?
       AND IFNULL(body_type,'') = IFNULL(?,'')
       AND IFNULL(generation,'') = IFNULL(?,'')
       AND IFNULL(modification,'') = IFNULL(?,'')
       AND IFNULL(displacement,'') = IFNULL(?,'')`
  ).get(parsed.year, parsed.make, parsed.modelKey, parsed.bodyType, parsed.generation, parsed.modification, parsed.displacement);

  if (exact) return { carId: exact.id, created: false, decision: "attached" };

  // Look for near-misses within the same model-year and make before creating anything.
  const siblings = db.prepare(
    `SELECT id, model, model_key, body_type, generation, modification, displacement
     FROM car WHERE year = ? AND make = ?`
  ).all(parsed.year, parsed.make);

  // ---- UNKNOWN-ATTRIBUTE MATCHING (see INTRINSIC_ATTRS above) ----
  // Same model, and every intrinsic attribute either agrees or is unknown on one side.
  // `modification` is NOT relaxed: blank there asserts "stock", so it must still match exactly.
  const compatible = siblings.filter(
    (s) =>
      s.model_key === parsed.modelKey &&
      ASSERTED_ATTRS.every((a) => (s[a] || "") === (parsed[PARSED_FIELD[a]] || "")) &&
      INTRINSIC_ATTRS.every((a) => intrinsicCompatible(s[a], parsed[PARSED_FIELD[a]]))
  );

  if (compatible.length === 1) {
    const match = compatible[0];
    // The incoming listing may state something the stored row never knew. Fill those in so the
    // catalogue improves as better-described listings arrive — a terse Mecum row can attach to
    // a car a descriptive BaT row later completes.
    const learned = INTRINSIC_ATTRS.filter((a) => blank(match[a]) && !blank(parsed[PARSED_FIELD[a]]));
    if (learned.length) {
      const candidate = {};
      for (const a of INTRINSIC_ATTRS) candidate[a] = blank(match[a]) ? parsed[PARSED_FIELD[a]] ?? null : match[a];
      // Enriching changes the identity tuple, which could collide with a row that already holds
      // those exact values. Only enrich when the completed identity is still unique; otherwise
      // attach as-is rather than risk a constraint violation.
      const clash = db.prepare(
        `SELECT id FROM car
         WHERE year = ? AND make = ? AND model_key = ? AND id <> ?
           AND IFNULL(body_type,'') = IFNULL(?,'')
           AND IFNULL(generation,'') = IFNULL(?,'')
           AND IFNULL(modification,'') = IFNULL(?,'')
           AND IFNULL(displacement,'') = IFNULL(?,'')`
      ).get(parsed.year, parsed.make, parsed.modelKey, match.id,
            candidate.body_type, candidate.generation, parsed.modification ?? null, candidate.displacement);

      if (!clash) {
        db.prepare(`UPDATE car SET body_type = ?, generation = ?, displacement = ? WHERE id = ?`)
          .run(candidate.body_type, candidate.generation, candidate.displacement, match.id);
      }
    }
    return { carId: match.id, created: false, decision: "attached", enriched: learned };
  }

  if (compatible.length > 1) {
    // Several existing cars could all be this listing — e.g. a "1920 Ford Model T" with no body
    // style, against rows for both a Convertible and a Pickup. Attaching would be a guess and
    // creating a third row would fragment further, so a human decides.
    const shown = compatible
      .map((c) => INTRINSIC_ATTRS.map((a) => `${a}=${c[a] || "unknown"}`).join(" "))
      .join("  |  ");
    return {
      carId: null, created: false, decision: "ambiguous",
      candidate: { id: compatible[0].id, model: compatible[0].model, modelKey: compatible[0].model_key },
      reason: `title leaves ${INTRINSIC_ATTRS.filter((a) => blank(parsed[PARSED_FIELD[a]])).join("/")} unstated and ${compatible.length} existing cars are compatible (${shown}) — attaching would be a guess`,
    };
  }

  for (const s of siblings) {
    // A different body style or modification is a legitimate, intentional split.
    if ((s.body_type || "") !== (parsed.bodyType || "")) continue;
    if ((s.modification || "") !== (parsed.modification || "")) continue;
    // Different engine displacement = a different car (964 Turbo 3.6 vs 3.3). Structured,
    // so it is a clean split rather than an ambiguity needing review.
    if ((s.displacement || "") !== (parsed.displacement || "")) continue;

    const verdict = compareModelKeys(parsed.modelKey, s.model_key);
    if (verdict === "same") return { carId: s.id, created: false, decision: "attached" };
    if (verdict === "ambiguous") {
      return {
        carId: null, created: false, decision: "ambiguous",
        candidate: { id: s.id, model: s.model, modelKey: s.model_key },
        reason: `ambiguous vs existing "${s.model}" (key "${s.model_key}" vs "${parsed.modelKey}") — differs only by unrecognised tokens; a human must decide whether these are the same car`,
      };
    }
  }

  const carId = newId();
  db.prepare(
    `INSERT INTO car (id, year, make, model, model_key, generation, body_type, modification, displacement, spec_src)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(carId, parsed.year, parsed.make, parsed.modelDisplay, parsed.modelKey,
        parsed.generation, parsed.bodyType, parsed.modification, parsed.displacement, "derived-from-title");

  return { carId, created: true, decision: "created" };
}

function resolveCarV2(db, saleRecord) {
  const parsed = parseTitle(saleRecord.title, { url: saleRecord.url });
  if (!parsed.ok) {
    return { status: "queued", reason: parsed.reason, year: parsed.year ?? null, make: parsed.make ?? null };
  }

  // YEAR CONFLICT GATE (found by resolve/per-source-report.js on a real BaT lot:
  // title "1971 Ferrari 365 GTB/4 Daytona Berlinetta" on URL slug ".../1973-ferrari-365-
  // gtb-4-daytona-berlinetta-3/"). Model-year IS identity here — a two-year error files the
  // sale against a different car and corrupts both cars' price history. The source itself
  // disagrees with the source, so there is no defensible way to pick one automatically.
  // YEAR CONFLICT POLICY — the TITLE wins, and the disagreement is recorded rather than
  // sent to a human.
  //
  // Rationale (general, not case-by-case): a listing slug is generated ONCE when the lot is
  // created and is never rewritten if the year is later corrected — BaT slugs even carry a
  // trailing dedupe counter ("-3"), confirming they are creation-time artifacts. The title
  // is the curated value the auction house actually displays and edits. So on disagreement
  // the title is the better default.
  //
  // Adjudicated against the one real conflict in the corpus: title "1971 Ferrari 365 GTB/4
  // Daytona Berlinetta" vs slug ".../1973-ferrari-...". Chassis 14867 falls in the 1971-72
  // band of Daytona production (~12547-17615 spanning 1968-73), which supports the title.
  //
  // The conflict is preserved on the record so it can be audited later, and a large spike in
  // conflicts for one source is itself a drift signal worth alerting on.
  const { parseSlugForSource } = require("./slug-parsers");
  const slug = parseSlugForSource(saleRecord.source, saleRecord.url);
  const yearConflict = slug?.year && parsed.year && slug.year !== parsed.year
    ? { titleYear: parsed.year, urlYear: slug.year }
    : null;
  const outcome = findOrCreateCar(db, parsed);
  if (outcome.decision === "ambiguous") {
    return {
      status: "queued", reason: outcome.reason,
      year: parsed.year, make: parsed.make, model: parsed.modelDisplay,
      candidateCarId: outcome.candidate.id,
    };
  }
  return { status: "matched", carId: outcome.carId, created: outcome.created, decision: outcome.decision, parsed, yearConflict };
}

module.exports = { parseTitle, findOrCreateCar, resolveCarV2, canonicalModelKey, stripNoisePrefixes, compareModelKeys, extractYear };
