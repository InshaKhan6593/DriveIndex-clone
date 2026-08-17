// Title -> car_id resolution (build spec §4.5). Designed against the ACTUAL real titles
// this pipeline has scraped (see samples/scraped/*.json) rather than idealized examples —
// that set turned out to contain a genuinely useful spread of hard cases: a WWII tank, two
// 1916 motorcycles, a one-off Indy racing chassis with no real "make", and a Singer 911
// restomod that would badly corrupt a stock-911 price curve if merged into it. Real titles,
// real edge cases.
//
// Core rule, straight from the spec: below a confidence threshold, go to the review queue.
// Never silently guess — a wrong auto-match is worse than an unresolved row, because it
// corrupts every downstream valuation for that model-year, not just the one sale.

const { newId } = require("../db/client");

// Deliberately an allowlist, not a denylist — an unrecognized make is a signal to route to
// review, not a bug to work around. Covers every make actually seen across all 5 sources'
// real scraped output plus the makes referenced in the earlier DriveIndex collectibility
// rules (build spec §7.5), so the two layers of this project stay consistent.
const KNOWN_CAR_MAKES = new Set([
  "porsche", "ferrari", "lamborghini", "mclaren", "bugatti", "pagani", "koenigsegg",
  "aston martin", "bentley", "rolls-royce", "maserati", "lotus", "alfa romeo",
  "mercedes-benz", "mercedes-amg", "mercedes-maybach", "bmw", "audi", "volkswagen",
  "chevrolet", "ford", "dodge", "cadillac", "buick", "pontiac", "oldsmobile", "chrysler",
  "jeep", "gmc", "lincoln", "toyota", "lexus", "honda", "acura", "nissan", "infiniti",
  "mazda", "mazdaspeed", "subaru", "mitsubishi", "datsun", "jaguar", "land rover",
  "range rover", "mini", "fiat", "cord", "packard", "studebaker", "duesenberg", "hudson",
  "plymouth", "amc", "shelby", "de tomaso", "iso",
]);

// Not a rejection of the CAR — a rejection of AUTO-RESOLUTION. These patterns mean "this
// title needs a human," either because it isn't a production car at all (tank, motorcycle,
// one-off racing chassis) or because folding it into its base model's price curve would be
// actively wrong (a restomod sells for a different order of magnitude than the donor car).
const REVIEW_FLAG_PATTERNS = [
  { re: /\bmedium tank\b|\btank\b/i, reason: "not a production car (tank)" },
  { re: /\bmotorcycle\b|\bmodel [a-z]?\d*\s*(light twin|featherweight)\b/i, reason: "motorcycle, out of catalogue scope" },
  { re: /\bby singer\b|\bsinger vehicle design\b|\brestomod\b|\breimagined by\b/i, reason: "restomod/reimagined build — would corrupt the donor model's price curve if merged" },
  { re: /\bracing single-seater\b|\bindy(?:anapolis)? racing\b|\busac\b/i, reason: "one-off racing chassis, no consumer make/model" },
  { re: /\breplica\b|\btribute\b|\bkit car\b/i, reason: "replica/tribute — spec §4.5 explicit exclusion category" },
];

// MOTORCYCLE MARQUES — a bounded vocabulary class, not edge-case memorisation.
//
// The standing rule is to prefer patterns over lists, and this is one of the few places a list
// is the right answer: the set of motorcycle marques is CLOSED and does not grow as the car
// corpus grows, exactly like the component nouns in evidence.js. A pattern cannot separate
// "1974 Moto Guzzi 850 Eldorado" from "1974 Maserati Bora" — both are "{year} {Name} {Model}".
//
// This list had SEVEN entries, which was fine while makes came only from a curated alias table.
// It became load-bearing the moment positional make-inference was switched on: measured in the
// review queue, "Moto" appeared 211 times and "MV" 139, and with a first-word-only check they
// would have entered the index as car makes "Moto" and "MV" — the single largest source of
// non-cars in the whole bucket. Entries are stored lowercase, one AND two word forms, because
// the caller tests both.
//
// The structural cc-displacement rule in evidence.js catches motorcycles that quote engine size
// in cc; this catches the ones that do not.
const MOTORCYCLE_MAKES = new Set([
  // originally present
  "indian", "harley-davidson", "harley", "triumph motorcycles", "ducati", "yamaha", "vollstedt-ford",
  // Italian
  "moto", "moto guzzi", "guzzi", "mv", "mv agusta", "agusta", "aprilia", "benelli", "bimota",
  "cagiva", "laverda", "gilera", "morini", "moto morini", "vespa", "piaggio", "lambretta",
  "ducati meccanica",
  // British
  "norton", "bsa", "matchless", "ajs", "velocette", "vincent", "brough", "brough superior",
  "royal", "royal enfield", "ariel", "sunbeam motorcycles", "rudge",
  // Japanese
  "kawasaki", "bridgestone motorcycle",
  // European / other
  "bultaco", "montesa", "ossa", "husqvarna", "husaberg", "ktm", "puch", "zundapp", "zündapp",
  "maico", "sachs", "jawa", "cz", "mz", "simson", "derbi", "gas gas", "gasgas", "beta",
  "sherco", "rieju", "motobecane", "peugeot motocycles", "terrot", "monet-goyon",
  // American
  "excelsior", "excelsior-henderson", "henderson", "cushman", "whizzer", "buell", "victory motorcycles",
  "confederate", "boss hoss",
]);

function extractYear(title) {
  // Handles real prefixes seen in this dataset: "28k-Mile 1994 Porsche...", "ca.1945 T-34..."
  const m = title.match(/\b(1[89]\d{2}|20[0-3]\d)\b/);
  if (!m) return null;
  const year = Number(m[0]);
  const currentYear = new Date().getFullYear();
  if (year < 1885 || year > currentYear + 1) return null;
  return { year, matchIndex: m.index, matchLength: m[0].length };
}

function extractMake(title, afterIndex) {
  const rest = title.slice(afterIndex).trim();
  // Try two-word makes first ("Mercedes-Benz", "Land Rover", "Aston Martin", "De Tomaso")
  const words = rest.split(/\s+/);
  const twoWord = words.slice(0, 2).join(" ").toLowerCase();
  const oneWord = (words[0] || "").toLowerCase().replace(/[^a-z-]/g, "");
  if (KNOWN_CAR_MAKES.has(twoWord)) return { make: words.slice(0, 2).join(" "), consumedWords: 2, isMotorcycle: false };
  if (KNOWN_CAR_MAKES.has(oneWord)) return { make: words[0], consumedWords: 1, isMotorcycle: false };
  if (MOTORCYCLE_MAKES.has(oneWord) || MOTORCYCLE_MAKES.has(twoWord)) return { make: words[0], consumedWords: 1, isMotorcycle: true };
  return null;
}

function checkReviewFlags(title) {
  for (const { re, reason } of REVIEW_FLAG_PATTERNS) {
    if (re.test(title)) return reason;
  }
  return null;
}

function extractModel(title, make, consumedWords, afterMakeIndex) {
  const rest = title.slice(afterMakeIndex).trim().split(/\s+/).slice(consumedWords >= 0 ? 0 : 0);
  // rest here is already past make; take up to 4 more words as a workable "model" string —
  // deliberately not trying to perfectly separate model from trim/body-style (e.g. "GT2 RS
  // Weissach" vs "GT2 RS" + trim "Weissach") — that level of precision needs the curated
  // alias tables the build spec describes (§4.5, §7.5) and is out of scope for this pass.
  return rest.slice(0, 4).join(" ").replace(/[.,]$/, "");
}

/**
 * @param {object} saleRecord - a normalized sale record from any adapter (has .title)
 * @returns {{ status: "matched"|"queued", carId?: string, confidence: number, reason?: string, year?: number, make?: string, model?: string }}
 */
function resolveCar(db, saleRecord) {
  const title = saleRecord.title || "";

  const flagReason = checkReviewFlags(title);
  if (flagReason) {
    return { status: "queued", confidence: 0, reason: flagReason };
  }

  const yearInfo = extractYear(title);
  if (!yearInfo) {
    return { status: "queued", confidence: 0, reason: "no parseable year in title" };
  }

  const makeInfo = extractMake(title, yearInfo.matchIndex + yearInfo.matchLength);
  if (!makeInfo) {
    return { status: "queued", confidence: 0, reason: "no recognized make in title", year: yearInfo.year };
  }
  if (makeInfo.isMotorcycle) {
    return { status: "queued", confidence: 0, reason: "motorcycle make, out of catalogue scope", year: yearInfo.year, make: makeInfo.make };
  }

  const modelStart = yearInfo.matchIndex + yearInfo.matchLength + title.slice(yearInfo.matchIndex + yearInfo.matchLength).indexOf(makeInfo.make) + makeInfo.make.length;
  const model = extractModel(title, makeInfo.make, makeInfo.consumedWords, modelStart);
  if (!model) {
    return { status: "queued", confidence: 0, reason: "could not extract a model string after make", year: yearInfo.year, make: makeInfo.make };
  }

  // find-or-create on (make, model, generation=NULL, year) — matches the UNIQUE constraint
  // on `car`. A real production system would fuzzy-match model spelling variants here
  // (spec §4.5's trigram/longest-match step); this does exact case-insensitive match plus
  // create, which is enough to prove the resolve -> queue -> ingest pipeline end to end.
  const existing = db.prepare(
    "SELECT id FROM car WHERE year = ? AND lower(make) = lower(?) AND lower(model) = lower(?) AND generation IS NULL"
  ).get(yearInfo.year, makeInfo.make, model);

  if (existing) {
    return { status: "matched", carId: existing.id, confidence: 0.9, year: yearInfo.year, make: makeInfo.make, model };
  }

  const carId = newId();
  db.prepare(
    "INSERT INTO car (id, year, make, model, spec_src) VALUES (?, ?, ?, ?, ?)"
  ).run(carId, yearInfo.year, makeInfo.make, model, "auto-created from " + saleRecord.source);

  return { status: "matched", carId, confidence: 0.75, year: yearInfo.year, make: makeInfo.make, model, created: true };
}

// IDEMPOTENT QUEUEING — a scheduled ingest must not re-queue what is already waiting.
//
// This was a plain INSERT with a fresh id. Every cron run therefore added another copy of every
// unresolved lot: measured after four runs, 25,734 queue rows for 12,843 distinct lots, the same
// title waiting four times. A queue that grows on each tick is a queue nobody works, which
// defeats the "human review rather than bad data" policy it exists to serve.
//
// ON CONFLICT UPDATE rather than DO NOTHING, so a re-queued lot refreshes its reason and
// confidence — the evidence base grows between runs, and the newest assessment is the useful
// one. `created_at` is deliberately NOT touched, so queue age still reflects first sighting.
// A row a human has already resolved or rejected is left alone.
// TRIAGE CLASS COMES FROM THE SHAPE OF THE DECISION, NOT FROM ITS PROSE.
//
// The first version regex-matched the reason TEXT, and it mis-sorted at scale: 11,837 items
// landed in SAME_CAR? including "1987 Suzuki Alto Works RS/X", which is not a merge decision at
// all. Matching on wording is inherently fragile — the class silently changes whenever someone
// rewords a message, and two different decisions can share a phrase.
//
// The pipeline already KNOWS which decision it made, and each leaves a distinct structural
// fingerprint. Reading that is exact and cannot drift:
//
//   candidate car present   -> a specific rival row exists, so this IS a merge/split judgement
//   make was inferred       -> a positional guess needing a marque LOOKUP
//   parse failed outright   -> the title does not fit {year} {make} {model}
//   otherwise               -> known make, model tokens simply unproven (self-resolves on volume)
//
// The reason text is still stored for the human to read; it is just no longer load-bearing.
function classifyResolution(resolution = {}) {
  if (resolution.reasonClass) return resolution.reasonClass;      // caller stated it explicitly
  if (resolution.candidate) return "SAME_CAR?";                   // there is a specific rival car
  if (resolution.makeInferred) return "UNKNOWN_MAKE";
  if (resolution.parsedOk === false) return "UNPARSEABLE";
  return "UNPROVEN_MODEL";
}

function queueForReview(db, saleRecord, resolution) {
  const reason = resolution.reason ?? null;
  // WHERE allows 'pending' (routine refresh) AND 'rejected' (a machine verdict can legitimately
  // change — e.g. a false-positive reject rule getting fixed and softened to "review" — so a
  // rejected row must be reopenable). 'resolved' is deliberately excluded: that status means a
  // HUMAN decided, and no automated reclassification may silently overwrite that.
  db.prepare(
    `INSERT INTO car_resolution_queue
     (id, source, source_lot_id, raw_title, extracted_year, extracted_make, extracted_model, best_candidate_car_id, best_candidate_score, status, reason, reason_class, created_at, raw_record_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
     ON CONFLICT (source, source_lot_id) DO UPDATE SET
       raw_title            = excluded.raw_title,
       extracted_year       = excluded.extracted_year,
       extracted_make       = excluded.extracted_make,
       extracted_model      = excluded.extracted_model,
       best_candidate_score = excluded.best_candidate_score,
       reason               = excluded.reason,
       reason_class         = excluded.reason_class,
       raw_record_json      = excluded.raw_record_json,
       status               = 'pending'
     WHERE car_resolution_queue.status IN ('pending', 'rejected')`
  ).run(
    newId(), saleRecord.source, saleRecord.source_lot_id, saleRecord.title,
    resolution.year ?? null, resolution.make ?? null, resolution.model ?? null,
    resolution.candidate ? resolution.candidate.id : null,
    resolution.confidence ?? 0,
    reason, classifyResolution(resolution),
    new Date().toISOString(), JSON.stringify(saleRecord)
  );
}

/**
 * Record a REJECTION so the pipeline's exclusions are auditable.
 *
 * Rejects previously vanished — counted in an in-memory stat and never written anywhere. That
 * left no way to answer "what did we throw away, and was that right?", which matters most for
 * the largest exclusion class: 5,050 year-less titles. Ground truth §11.3 makes the same point
 * from the product side — the exclusions are a credibility asset, so they have to be SHOWN.
 *
 * Written with status='rejected' into the same table, so nothing enters `sale`, the full record
 * is retained in raw_record_json, and a reviewer can overturn any of it.
 */
function recordRejection(db, saleRecord, reason, reasonClass = "REJECTED") {
  db.prepare(
    `INSERT INTO car_resolution_queue
     (id, source, source_lot_id, raw_title, extracted_year, extracted_make, extracted_model, best_candidate_car_id, best_candidate_score, status, reason, reason_class, created_at, raw_record_json)
     VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, 0, 'rejected', ?, ?, ?, ?)
     ON CONFLICT (source, source_lot_id) DO UPDATE SET
       reason       = excluded.reason,
       reason_class = excluded.reason_class,
       status       = CASE WHEN car_resolution_queue.status = 'resolved' THEN 'resolved' ELSE 'rejected' END`
  ).run(
    newId(), saleRecord.source, saleRecord.source_lot_id, saleRecord.title,
    reason, reasonClass, new Date().toISOString(), JSON.stringify(saleRecord)
  );
}

/**
 * Record a DUPLICATE DROP so it's as auditable as a rejection.
 *
 * Found while checking whether every scraped record was accounted for (2026-08-17): 122 real,
 * correctly-priced records (a Ferrari F355 Spider re-listed under a new BaT lot id, BaT's own
 * `bat_repeat` flag confirming it) were being correctly identified and dropped as duplicates by
 * dedup/dedup.js, but the drop only ever lived in an in-memory stats array printed to the
 * console during that one ingest run — nothing persisted. A week later there would be no way to
 * answer "why isn't this lot in the index" for any of them. Same fix as recordRejection: write
 * it to car_resolution_queue with its own status, so the record survives past the run that
 * dropped it and a reviewer can find (and if wrong, overturn) the decision.
 *
 * `keptCarId`/`score` are stored in the existing best_candidate_* columns — unlike a structural
 * rejection, a duplicate drop DOES have a specific candidate it was scored against, and that is
 * exactly the information someone auditing the decision needs.
 */
function recordDuplicate(db, saleRecord, keptCarId, score, reason) {
  db.prepare(
    `INSERT INTO car_resolution_queue
     (id, source, source_lot_id, raw_title, extracted_year, extracted_make, extracted_model, best_candidate_car_id, best_candidate_score, status, reason, reason_class, created_at, raw_record_json)
     VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?, 'duplicate', ?, 'DUPLICATE', ?, ?)
     ON CONFLICT (source, source_lot_id) DO UPDATE SET
       best_candidate_car_id = excluded.best_candidate_car_id,
       best_candidate_score  = excluded.best_candidate_score,
       reason                = excluded.reason,
       raw_record_json       = excluded.raw_record_json,
       status                = CASE WHEN car_resolution_queue.status = 'resolved' THEN 'resolved' ELSE 'duplicate' END`
  ).run(
    newId(), saleRecord.source, saleRecord.source_lot_id, saleRecord.title,
    keptCarId, score, reason, new Date().toISOString(), JSON.stringify(saleRecord)
  );
}

module.exports = { resolveCar, queueForReview, recordRejection, recordDuplicate, classifyResolution, extractYear, extractMake, KNOWN_CAR_MAKES, MOTORCYCLE_MAKES };
