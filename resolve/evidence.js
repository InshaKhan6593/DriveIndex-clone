// EVIDENCE-BASED ACCEPTANCE — replaces enumerating edge cases with scoring repeated patterns.
//
// WHY THIS REPLACES THE LISTS
// The earlier approach reacted to each review-queue item by adding it to a table: Fisker,
// Yamaha V Star, Reliant Regal, "18×8″ wheels", the Evinrude outboard. That is memorisation.
// It cannot handle the next unseen make, and the tables grow without bound while accuracy on
// NEW data stays flat. Auction catalogues have a long tail by nature — there will always be
// one more marque.
//
// What generalises is STRUCTURE and REPETITION:
//
//   1. STRUCTURAL SIGNALS — properties of the text itself that hold regardless of brand.
//      A part is "X for {Make}"; wheels carry a dimensional prefix (18×8″); a motorcycle
//      quotes displacement in cc rather than litres. These are shapes, not names.
//
//   2. CORPUS EVIDENCE — how often this make/token has ALREADY been seen, and across how
//      many independent sources. A make appearing 40 times from 3 sources is real whatever
//      it is called. A token appearing once, from one source, is unproven — and unproven is
//      exactly what a human should look at.
//
// The lists in vocab.js are NOT deleted: they remain as a fast path for the ~20 marques that
// dominate volume. But they are no longer the decision procedure, and a make missing from
// them is no longer automatically wrong — it just has to earn acceptance from evidence.
//
// GUIDING RULE (the client's, and it is the right one): bad data is worse than less data.
// Anything the evidence cannot support goes to a human rather than into the index.

// ---------------------------------------------------------------------------
// 1. STRUCTURAL SIGNALS — brand-independent shapes
// ---------------------------------------------------------------------------

const STRUCTURAL = [
  {
    name: "dimensional-prefix",
    // 18×8″, 19x9.5", 20X12 — a size pair opening the title is a wheel/tyre listing, never a car.
    test: (t) => /^\s*\d{2}\s*[×x]\s*\d+(\.\d+)?\s*[”"″']?/i.test(t) || /\b\d{2}[×x]\d+(\.\d+)?″/.test(t),
    verdict: "reject", reason: "dimensional prefix — wheels/tyres listing",
  },
  {
    name: "part-for-make",
    // "Seats for Porsche 911", "Wheels for Lamborghini Aventador" — the "for {Something}"
    // construction marks an accessory TO a car, not a car.
    test: (t) => /\b(for|from)\s+(a\s+)?[A-Z][A-Za-z-]+/.test(t) && !/\bfor\s+sale\b/i.test(t)
                 && /\b(wheels?|seats?|engine|motor|gearbox|transmission|hood|bumper|door|panel|kit|set|pair|parts?)\b/i.test(t),
    verdict: "reject", reason: "accessory/part listed for a vehicle",
  },
  {
    name: "part-as-head-noun",
    // What a title ENDS with is what the listing IS — the head noun. "Porsche 911 16x7 and 8\"
    // Fuchs Wheels" is a set of wheels; "1965 Ford Mustang Fastback" is a car.
    //
    // This exists because the `part-for-make` rule below needs the words "for {Make}", and the
    // dimensional-prefix rule needs the size at the START. The real listing had neither — the
    // make led, the dimensions sat mid-title — so it slipped through and became a $4,877
    // "1987 Porsche 911" in the catalogue, dragging that model-year's average down.
    //
    // The vocabulary here is COMPONENT NOUNS, not brands or models: it is the same short list
    // whatever marque is in the title, and it does not grow as new makes appear. Body styles
    // (coupe, roadster, wagon) are deliberately absent — those are cars.
    test: (t) => /\b(wheels?|tyres?|tires?|seats?|engines?|motors?|gearboxes?|transmissions?|hoods?|bumpers?|doors?|panels?|fenders?|grilles?|mirrors?|badges?|emblems?|manifolds?|carburet(?:or|tor)s?|radiators?|exhausts?|headers?|dashboards?|gauges?|steering wheels?|hubcaps?|signs?|posters?|brochures?|manuals?|literature|memorabilia|parts?|spares?)\s*$/i
                 .test(String(t || "").replace(/\s*\(.*?\)\s*$/, "").trim()),
    verdict: "reject", reason: "component/accessory is the subject of the title, not a vehicle",
  },
  {
    name: "cc-displacement",
    // Motorcycles quote displacement in cc (883cc, 1200 cc); cars quote litres. A reliable
    // structural tell that needs no model list.
    test: (t) => /\b\d{3,4}\s?cc\b/i.test(t),
    verdict: "reject", reason: "cc displacement — motorcycle/small engine",
  },
  {
    name: "engine-only-listing",
    test: (t) => /^\s*(crate\s+)?(engine|motor|powerplant|drivetrain)\b/i.test(t) || /\bengine\s+(assembly|only|no\s+car)\b/i.test(t),
    verdict: "reject", reason: "engine/drivetrain listing, not a vehicle",
  },
  {
    name: "non-vehicle-object",
    // Simulators, wall art, models, display pieces. Pattern: the object noun IS the subject,
    // and it is not a vehicle. Found in real BaT results ("SimXperience Stage 5 Simulator",
    // "1970 Chevelle-Style Wall Art").
    test: (t) => /\b(simulator|wall art|artwork|painting|print|sculpture|scale model|die-?cast|neon|clock|jukebox|pinball|arcade)\b/i.test(t),
    verdict: "reject", reason: "non-vehicle object (art/simulator/display piece)",
  },
  {
    name: "style-of-not-actual",
    // "-Style" / "-Inspired" describe an object made to LOOK like a car, not the car.
    test: (t) => /\b[A-Z][\w-]*-Style\b\s+(art|wall|sign|body|kit)\b/i.test(t),
    verdict: "reject", reason: "styled-after object, not the vehicle",
  },
  {
    name: "non-car-vehicle-class",
    // RVs, trailers, boats, scooters, ATVs. These arrive constantly in auction feeds and are
    // whole CATEGORIES, not stray brands — so match the vehicle-class noun rather than trying
    // to enumerate Thor / Airstream / Tiffin / Chris-Craft / Vespa / Sea-Doo one by one.
    test: (t) => /\b(motor ?home|camper(van)?|travel trailer|fifth[- ]wheel|toy hauler|class [abc] (rv|motorhome)|rv\b)/i.test(t)
              || /\b(boat|yacht|jet ?ski|personal watercraft|sailboat|catamaran|runabout)\b/i.test(t)
              || /\b(scooter|moped|atv|utv|side[- ]by[- ]side|mini ?bike|snowmobile|golf cart)\b/i.test(t),
    verdict: "reject", reason: "vehicle class outside a car price index (RV/boat/scooter/ATV)",
  },
  {
    name: "toy-or-model",
    test: (t) => /\b(pedal car|children'?s ride|kid'?s car|scale[- ]?model|die[- ]?cast|toy|junior car|go[- ]?kart)\b/i.test(t),
    verdict: "reject", reason: "toy / scale model, not a road vehicle",
  },
  {
    name: "racing-memorabilia",
    // Found on real RM Sotheby's / Bonhams data (2026-08-17): genuine race memorabilia
    // (trophies, signed suits/caps/helmets, press kits) sitting in `sale` alongside real cars.
    //
    // ⚠️ A first version of this rule end-anchored on bare nouns (trophy, cap, helmet, ...) and
    // was WRONG — caught while sample-checking before shipping, not after: "Land Rover Discovery
    // Camel Trophy" (a real, desirable special edition) and "Renault Sport Spider Trophy" /
    // "Megane V6 Trophy" (real trim names) would have been silently deleted from the index, and
    // "Land Rover Defender 130 Hi-Cap" (a real body style) was caught by the bare "cap" branch.
    // "Trophy" and "Cap" are both real manufacturer trim/model words across multiple brands —
    // there is no way to end-anchor on them safely. Rule rewritten to require an explicit,
    // unambiguous memorabilia signal instead of a bare noun: an ordinal race PLACEMENT (no
    // production trim is ever named "1st-Place"), or the word "signed" specifically (no vehicle
    // model is ever named "Signed" anything). This deliberately catches LESS than the first
    // version — under-catching a few stray memorabilia items is a minor data-quality issue;
    // over-catching real cars is a correctness bug that destroys real sales. Bias kept toward
    // the former on purpose (see the project's own "bad data is worse than less data" rule,
    // read here as: WRONGLY REMOVING real data is worse than leaving a little noise in).
    test: (t) => /\b\d(st|nd|rd|th)[-\s]place\s+(trophy|trophies|award|awards)\b/i.test(t)
              || /\b(pole\s+position|fastest\s+lap)\s+trophy\b/i.test(t)
              || /\bsigned\b/i.test(t) && /\b(cap|caps|visor|shirt|shirts|glove|gloves|suit|helmet|helmets|jersey|photograph|print|poster|bottle|belt|cheque|boots|balaclava|shield|panel|postcard|letter)\b/i.test(t)
              || /\bmodel\s+(airplane|aircraft|sailboat)\b/i.test(t)
              || /\bwall\s+sculpture/i.test(t)
              || /\bpress\s+kit\b/i.test(t)
              || /\bframed\s+photograph\b/i.test(t),
    verdict: "reject", reason: "racing memorabilia (trophy/signed item/press kit), not a vehicle",
  },
  {
    name: "kit-car-brand",
    // Unambiguous: these ARE kit-car/replica manufacturers, not model years of anything.
    test: (t) => /\bfactory five\b|\bcontemporary classic\b|\bsuperformance\b|\bbackdraft\b/i.test(t),
    verdict: "reject", reason: "kit car / engine-swap build, not a factory model-year",
  },
  {
    name: "displacement-led-title",
    // ⚠️ NOT a safe reject on its own. "429-Powered ..." leading a title is just as often a
    // bone-stock factory big-block being described the way BaT/Mecum sellers normally describe
    // one, as it is a genuine engine swap — and telling them apart needs per-model-year factory
    // engine-option knowledge no text shape can supply. Measured on real rejections: "396-Powered
    // 1967 Chevrolet Chevelle Malibu" (396 was a real factory Chevelle option) and "440-Powered
    // 1971 Plymouth Road Runner" (440 was a real factory Road Runner option) were being discarded
    // alongside genuine swaps like "350-Powered 1959 Chevrolet Corvette" (350ci didn't exist
    // until 1967, so that one really is non-stock). Two experts would need a build sheet or VIN
    // decode to settle this — exactly the "would reasonable experts disagree" test for REVIEW,
    // not an automatic reject that silently discards real numbers-matching muscle cars.
    test: (t) => /^\s*[\d.]+\s*(L\b|stroker\b|ci\b)?[- ]?powered\b/i.test(t),
    verdict: "review", reason: "displacement-led title — could be a genuine factory engine option or a swap; needs a build-sheet/VIN judgement a title alone can't make",
  },
  {
    name: "no-year-anywhere",
    // Model-year is identity for a price index. Without one there is nothing to index against.
    //
    // THIS IS A REJECT, NOT A REVIEW — changed after measuring the queue. 5,050 of 14,531
    // pending items (34.8%) were year-less titles like "Mini Clubman VTEC AWD Project" and
    // "Rotary-Powered Wharton Roadster". A human cannot supply a year the listing never had, so
    // there was no decision available to make: the items were pure noise crowding out the ones
    // that ARE decidable. A queue a third full of unanswerable questions is a queue nobody works.
    //
    // Nothing is lost: the full record is preserved in car_resolution_queue.raw_record_json with
    // status='rejected', so if the product ever supports undated cars they can be revisited.
    test: (t, ctx) => !ctx.hasYear,
    verdict: "reject", reason: "no model year in title or URL — cannot be indexed against a model-year price curve",
  },
];

function structuralVerdict(title, ctx = {}) {
  for (const s of STRUCTURAL) {
    try { if (s.test(String(title || ""), ctx)) return { verdict: s.verdict, reason: s.reason, rule: s.name }; }
    catch { /* a malformed title should never crash classification */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 2. CORPUS EVIDENCE — learned from what has already been ingested
// ---------------------------------------------------------------------------

/**
 * Builds frequency statistics from the sales already accepted into the DB, and — critically —
 * from the batch currently being ingested.
 *
 * THE BOOTSTRAPPING DEADLOCK THIS SOLVES
 * Counting only ACCEPTED sales makes the evidence layer unable to ever learn a new marque:
 * a make cannot be accepted until it has been seen 3 times, and it cannot be seen at all until
 * it has been accepted. Measured cost of that deadlock: ~450 review items stuck on makes like
 * MGA, Morris Minor, Corvair, Imperial and Jeepster — all real marques, none of them learnable.
 *
 * @param {object} db
 * @param {Array<{make:string, modelKey:string, year:number|null, source:string}>} [incoming]
 *   Parsed records from the batch about to be ingested. Optional — omitting it reproduces the
 *   old accepted-corpus-only behaviour exactly.
 */
function buildCorpusStats(db, incoming = []) {
  const makeFreq = new Map();     // make -> sale count
  const makeSources = new Map();  // make -> Set(source)
  const tokenFreq = new Map();    // model token -> count

  const rows = db.prepare(`
    SELECT c.make, c.model_key, s.source
    FROM sale s JOIN car c ON c.id = s.car_id
  `).all();

  for (const r of rows) {
    makeFreq.set(r.make, (makeFreq.get(r.make) || 0) + 1);
    if (!makeSources.has(r.make)) makeSources.set(r.make, new Set());
    makeSources.get(r.make).add(r.source);
    for (const t of String(r.model_key || "").split(" ")) {
      if (t) tokenFreq.set(t, (tokenFreq.get(t) || 0) + 1);
    }
  }

  // Batch evidence is tracked SEPARATELY and never merged into makeFreq. Accepted sales have
  // survived the whole pipeline; batch rows are unvetted. Conflating them would let a batch
  // vouch for itself at the same threshold real history has to meet.
  const batchMakeFreq = new Map();
  const batchMakeYears = new Map();   // make -> Set(model year)
  const batchMakeModels = new Map();  // make -> Set(model_key)
  const batchMakeSources = new Map(); // make -> Set(source)
  const batchTokenFreq = new Map();   // model token -> count

  for (const p of incoming) {
    if (!p || !p.make) continue;
    batchMakeFreq.set(p.make, (batchMakeFreq.get(p.make) || 0) + 1);
    if (!batchMakeYears.has(p.make)) batchMakeYears.set(p.make, new Set());
    if (!batchMakeModels.has(p.make)) batchMakeModels.set(p.make, new Set());
    if (!batchMakeSources.has(p.make)) batchMakeSources.set(p.make, new Set());
    if (p.year) batchMakeYears.get(p.make).add(p.year);
    if (p.modelKey) batchMakeModels.get(p.make).add(p.modelKey);
    if (p.source) batchMakeSources.get(p.make).add(p.source);
    for (const t of String(p.modelKey || "").split(" ")) {
      if (t) batchTokenFreq.set(t, (batchTokenFreq.get(t) || 0) + 1);
    }
  }

  return {
    makeFreq, makeSources, tokenFreq, totalSales: rows.length,
    batchMakeFreq, batchMakeYears, batchMakeModels, batchMakeSources, batchTokenFreq,
    batchSize: incoming.length,
  };
}

const MIN_SIGHTINGS_TO_TRUST = 3;   // a make must recur before the corpus vouches for it
const MIN_SOURCES_TO_TRUST = 2;     // ...or be corroborated by a second, independent source

// ── THRESHOLDS FOR AN UNSEEN MAKE TO EARN TRUST FROM THE BATCH ALONE ────────────────────
// Deliberately stricter than the corpus thresholds, and deliberately about DIVERSITY rather
// than raw repetition.
//
// Raw count is a weak signal here: a mis-parse repeats the SAME wrong string, so "seen 40
// times" is equally consistent with a real marque and with one systematic bug. What a genuine
// marque produces that a bug does not is SPREAD — Morris Minor turns up across a dozen model
// years and several body styles, whereas a bad parse is one frozen string.
//
// So an unseen make must show: enough sightings, across several distinct model years, across
// more than one distinct model. That is a structural property of real catalogue data, which
// keeps this a pattern rule rather than another name list.
const MIN_BATCH_SIGHTINGS = 8;
const MIN_BATCH_YEARS = 4;
const MIN_BATCH_MODELS = 2;

/**
 * Does the incoming batch itself provide enough spread to vouch for a make the corpus has
 * never accepted? Returns null when the make needs no bootstrapping or does not qualify.
 */
function batchEvidence(make, stats) {
  const n = stats.batchMakeFreq?.get(make) || 0;
  if (!n) return null;
  const years = (stats.batchMakeYears?.get(make) || new Set()).size;
  const models = (stats.batchMakeModels?.get(make) || new Set()).size;
  const sources = (stats.batchMakeSources?.get(make) || new Set()).size;

  const qualifies = n >= MIN_BATCH_SIGHTINGS && years >= MIN_BATCH_YEARS && models >= MIN_BATCH_MODELS;
  return { n, years, models, sources, qualifies };
}

/**
 * How well does the corpus support this parse?
 * @returns {{score:number, level:"strong"|"weak"|"none", reasons:string[]}}
 */
function scoreAgainstCorpus(parsed, stats) {
  const reasons = [];
  let score = 0;

  const sightings = stats.makeFreq.get(parsed.make) || 0;
  const sourceCount = (stats.makeSources.get(parsed.make) || new Set()).size;

  if (sightings >= MIN_SIGHTINGS_TO_TRUST) { score += 0.5; reasons.push(`make seen ${sightings}x in corpus`); }
  else if (sightings > 0) { score += 0.2; reasons.push(`make seen only ${sightings}x`); }
  else {
    // Never accepted before. Before sending it to a human, ask whether THIS batch shows the
    // spread a real marque produces — otherwise an unfamiliar make can never become familiar.
    const be = batchEvidence(parsed.make, stats);
    if (be?.qualifies) {
      score += 0.5;
      reasons.push(
        `make unseen in corpus but batch shows ${be.n} sightings across ${be.years} model years and ${be.models} distinct models — spread consistent with a real marque`
      );
    } else if (be) {
      score += 0.1;
      reasons.push(
        `make never accepted before; batch has only ${be.n} sightings / ${be.years} years / ${be.models} models — too narrow to self-vouch`
      );
    } else {
      reasons.push("make never seen before in corpus");
    }
  }

  if (sourceCount >= MIN_SOURCES_TO_TRUST) { score += 0.3; reasons.push(`corroborated by ${sourceCount} independent sources`); }
  else if (sourceCount === 1) { score += 0.1; reasons.push("seen from a single source only"); }

  // Model tokens that recur are a further signal the parse landed on real vocabulary.
  // Recurrence counts whether it comes from accepted history or from the batch: "Minor"
  // appearing across several Morris listings is the same evidence either way, and requiring it
  // to come from accepted history only would re-create the deadlock this layer just escaped.
  const tokens = String(parsed.modelKey || "").split(" ").filter(Boolean);
  const known = tokens.filter(
    (t) => (stats.tokenFreq.get(t) || 0) >= 2 || (stats.batchTokenFreq?.get(t) || 0) >= 2
  ).length;
  if (tokens.length) {
    const ratio = known / tokens.length;
    score += 0.2 * ratio;
    if (ratio > 0) reasons.push(`${known}/${tokens.length} model tokens recur in corpus`);
  }

  const level = score >= 0.6 ? "strong" : score >= 0.25 ? "weak" : "none";
  return { score: Math.min(1, score), level, reasons };
}

/**
 * Final acceptance decision, combining structure + evidence + the fast-path vocabulary.
 *
 * @param {object} p
 * @param {string} p.title
 * @param {object|null} p.parsed        - parseTitle() output, or null if it failed
 * @param {boolean} p.knownMake         - did the curated vocabulary recognise the make?
 * @param {object} p.stats              - buildCorpusStats() output
 * @param {boolean} p.hasYear
 * @returns {{action:"accept"|"review"|"reject", reason:string, confidence:number}}
 */
function classify({ title, parsed, knownMake, stats, hasYear }) {
  const structural = structuralVerdict(title, { hasYear });
  if (structural) {
    return { action: structural.verdict, reason: structural.reason, confidence: structural.verdict === "reject" ? 0.9 : 0 };
  }

  if (!parsed || !parsed.ok) {
    return { action: "review", reason: parsed?.reason || "could not parse title", confidence: 0 };
  }

  // A POSITIONALLY INFERRED make never takes the fast path.
  //
  // The parser can always produce *a* word after the year, so an inferred make is a guess, not
  // a recognition. Measured on the head of that bucket, only about 1 in 6 distinct first-words
  // is a car marque — the rest are motorcycles (Moto Guzzi, MV Agusta), RVs (Airstream,
  // Winnebago), race constructors (Lola, Ralt), tyres (Goodyear) and coachbuilders (Bertone).
  // So inference must earn its place from evidence every time, or go to a human.
  if (parsed.makeInferred) {
    const ev = scoreAgainstCorpus(parsed, stats);
    if (ev.level === "strong") {
      return { action: "accept", reason: `make inferred from title position, then corroborated — ${ev.reasons.join("; ")}`, confidence: Math.min(ev.score, 0.8) };
    }
    return {
      action: "review",
      reason: `make "${parsed.make}" inferred from position after the year and NOT corroborated (${ev.reasons.join("; ")}) — could be a marque, a motorcycle, an RV or a coachbuilder, so a human decides rather than the index taking a guess`,
      confidence: ev.score,
    };
  }

  // Fast path: a curated make is accepted immediately. These ~20 marques carry most volume,
  // and re-deriving evidence for them on every record is pointless work.
  if (knownMake) {
    return { action: "accept", reason: "make in curated vocabulary", confidence: 0.95 };
  }

  // Otherwise the corpus has to vouch for it.
  const ev = scoreAgainstCorpus(parsed, stats);
  if (ev.level === "strong") {
    return { action: "accept", reason: `corpus evidence: ${ev.reasons.join("; ")}`, confidence: ev.score };
  }
  return {
    action: "review",
    reason: `insufficient evidence (${ev.reasons.join("; ")}) — unproven make/model, sending to a human rather than indexing it`,
    confidence: ev.score,
  };
}

module.exports = {
  classify, structuralVerdict, buildCorpusStats, scoreAgainstCorpus, batchEvidence,
  STRUCTURAL, MIN_SIGHTINGS_TO_TRUST, MIN_SOURCES_TO_TRUST,
  MIN_BATCH_SIGHTINGS, MIN_BATCH_YEARS, MIN_BATCH_MODELS,
};
