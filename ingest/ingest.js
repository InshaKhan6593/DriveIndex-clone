// Real ingestion pipeline: samples/scraped/*.json (actual scraper output) -> resolve car_id
// -> cross-source dedup against what's already in the DB for that car -> insert into `sale`.
//
// Usage: node ingest/ingest.js [file1.json file2.json ...]   (defaults to all of samples/scraped/*.json)

const fs = require("fs");
const path = require("path");
const { openDb, newId } = require("../db/client");
const { resolveCarV2 } = require("../resolve/resolve-car-v2");
const { standingDecision } = require("../resolve/review-decisions");
const { classify, buildCorpusStats, structuralVerdict } = require("../resolve/evidence");
const { extractYear, parseTitle } = require("../resolve/resolve-car-v2");
const { MAKE_ALIASES } = require("../resolve/vocab");
const { queueForReview, recordRejection, recordDuplicate } = require("../resolve/resolve-car");
const { toUsd } = require("../fx/convert");

// price_usd is what the whole engine actually computes on — engine/clean.js drops any sale
// without it. Filling it only for currency === "USD" is what excluded 7,468 non-USD sold lots
// (60.8% of Bonhams, 28.3% of RM Sotheby's). Converted at the ECB rate FOR THE DAY IT SOLD,
// never today's: see fx/fetch-ecb-rates.js. Returns null when no rate applies, and null keeps
// the sale excluded exactly as before rather than inventing a number.
const usdFor = (rec) =>
  rec.price_usd ?? toUsd(rec.price, rec.currency, rec.sold_at);
const { normalizeVin, duplicateScore, DUPLICATE_THRESHOLD, SOURCE_TRUST, daysApart } = require("../dedup/dedup");

const SCRAPED_DIR = path.join(__dirname, "..", "samples", "scraped");

function getExistingSalesForCar(db, carId) {
  const rows = db.prepare("SELECT * FROM sale WHERE car_id = ?").all(carId);
  return rows.map((r) => ({ ...r, price_usd: r.price_usd, mileage: r.mileage, sold_at: r.sold_at, title: r.title, source: r.source }));
}

// Adapters still emit the boolean `reserve_not_met` (that is what the source pages
// actually expose today). Map it onto the richer status enum here — `sold_after` can only
// arrive once a source adapter learns to detect it (Cars & Bids exposes it; see
// notes/findings-summary.md), and until then nothing fabricates that state.
function statusOf(rec) {
  if (rec.status) return rec.status;
  return rec.reserve_not_met ? "reserve_not_met" : "sold";
}

function insertSale(db, carId, rec) {
  const vinNormal = rec.vin_raw ? normalizeVin(rec.vin_raw) : null;
  // Upsert refreshes the live fields (price/date/status) unconditionally, and the
  // detail-page-enrichment fields (mileage/vin/color/transmission) only when the incoming
  // record actually has one — COALESCE keeps the stored value otherwise, so a later re-scrape
  // of the list API (which carries none of them) never wipes enrichment written by
  // crawler/bat-detail.crawler.js back off the row.
  db.prepare(
    `INSERT INTO sale
     (id, car_id, source, source_lot_id, url, title, sold_at, price, currency, price_usd,
      mileage, vin, vin_normal, color, transmission, tc, options, image_url,
      is_outlier, outlier_note, carfax_damage, non_us_sale, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source, source_lot_id) DO UPDATE SET
       price = excluded.price, sold_at = excluded.sold_at, status = excluded.status,
       mileage = COALESCE(excluded.mileage, mileage),
       vin = COALESCE(excluded.vin, vin),
       vin_normal = COALESCE(excluded.vin_normal, vin_normal),
       color = COALESCE(excluded.color, color),
       transmission = COALESCE(excluded.transmission, transmission)`
  ).run(
    newId(), carId, rec.source, rec.source_lot_id, rec.url, rec.title,
    rec.sold_at || new Date().toISOString(), rec.price || 0, rec.currency || "USD", rec.price_usd,
    rec.mileage, rec.vin_raw, vinNormal, rec.color, rec.transmission, rec.tc,
    JSON.stringify(rec.options || []), rec.image_url,
    rec.is_outlier ? 1 : 0, rec.outlier_note, rec.carfax_damage ? 1 : 0,
    rec.non_us_sale ? 1 : 0, statusOf(rec)
  );
}

function ingestRecord(db, rec, stats) {
  if (rec.price == null && !rec.reserve_not_met) {
    stats.skippedNoPrice++;
    return;
  }

  // ALREADY-RESOLVED FAST PATH — a lot that already has a `sale` row must not be re-litigated.
  //
  // Found on the real corpus: a full re-ingest re-ran evidence classification and resolveCarV2
  // for EVERY record on EVERY pass, including ones already sitting in `sale`. Because catalog
  // state shifts WITHIN one batch (new cars get created as earlier records in the same file are
  // processed), a record that resolved cleanly on an earlier pass could become "ambiguous"
  // against a just-created near-duplicate car on a later pass — even though its `sale` row was
  // already correct and never touched. Measured: 3,104 PENDING queue rows for lots that already
  // had a real sale (validation/cron-safety.test.js three-pass re-ingest never converged to
  // zero change; the queue grew every single pass instead of settling).
  //
  // Idempotent is supposed to mean "safe to re-run, converges to no-op" — this makes it true:
  // once a lot has a sale row, re-ingesting it only ever refreshes price/date/status (the same
  // fields insertSale's own ON CONFLICT updates, plus detail-page enrichment fields when the
  // incoming record carries them), never re-resolves or re-queues it.
  if (rec.source_lot_id) {
    const existing = db.prepare("SELECT car_id FROM sale WHERE source = ? AND source_lot_id = ?").get(rec.source, rec.source_lot_id);
    if (existing) {
      insertSale(db, existing.car_id, { ...rec, price_usd: usdFor(rec) });
      stats.alreadyIngested = (stats.alreadyIngested || 0) + 1;
      return;
    }
  }

  // PROVENANCE GATE — reject records that cannot have come from a trustworthy harvest.
  //
  // BaT's JSON API always returns a NUMERIC listing id. A slug-shaped lot id means the record
  // came from a DOM/list harvest, where the lot id was reverse-engineered from a URL that had
  // been matched to the title by positional guesswork. Measured on the two files that did this:
  // 58.6% of records paired a title with a URL for a DIFFERENT car — a fabricated sale, on a
  // car that never sold, at another car's price.
  //
  // Rejecting on the ID SHAPE rather than on a filename means no future harvester can
  // reintroduce the defect by writing to a new file.
  if (rec.source === "bat" && !/^\d+$/.test(String(rec.source_lot_id || ""))) {
    stats.provenanceRejects = stats.provenanceRejects || [];
    stats.provenanceRejects.push({ title: rec.title, lot: rec.source_lot_id });
    return;
  }

  // Search-page furniture that leaked into a title means the harvester captured page chrome
  // instead of the listing. Such a title cannot be parsed into a real car, and the price
  // beside it belongs to whatever row the parser drifted onto.
  if (/(Completed Auctions|Get Daily Updates|This Week's Popular|Recent Exceptional|Type Location Category|Auction Result High Bid)/i.test(rec.title || "")) {
    stats.provenanceRejects = stats.provenanceRejects || [];
    stats.provenanceRejects.push({ title: rec.title, lot: rec.source_lot_id, reason: "page chrome in title" });
    return;
  }

  // Settled review decisions still run first (cheap, and they encode real adjudications),
  // but they are no longer the main gate — see the evidence classifier below.
  const standing = standingDecision(rec.title);
  if (standing?.action === "reject") {
    stats.standingRejects.push({ title: rec.title, reason: standing.reason });
    recordRejection(db, rec, standing.reason, "REJECTED_STANDING");
    return;
  }

  // PATTERN + EVIDENCE GATE (resolve/evidence.js). This replaces enumerating every odd make
  // and model: structural shapes catch parts/wheels/cc-engines regardless of brand, and the
  // corpus itself vouches for makes that recur across sources. Anything unproven goes to a
  // human — bad data is worse than less data.
  // Reuse the pre-pass parse when available — on a 60k batch, parsing every title twice is
  // pure waste. Falls back to parsing on demand so single-record callers still work.
  const preParse = stats.parsedByTitle?.get(rec.title) || parseTitle(rec.title, { url: rec.url });
  const knownMake = preParse.ok && [...new Set(MAKE_ALIASES.values())].includes(preParse.make);
  const verdict = classify({
    title: rec.title, parsed: preParse, knownMake,
    stats: stats.corpusStats || { makeFreq: new Map(), makeSources: new Map(), tokenFreq: new Map(), totalSales: 0 },
    // When parseTitle bails early (an out-of-scope verdict returns before year extraction) it
    // leaves `year` undefined — that means "not parsed", NOT "no year present". This previously
    // fell back to checking the URL alone, so "1969 Merlyn Mk 11A Formula Ford" was recorded as
    // rejected for "no model year in title or URL" with 1969 sitting in plain sight. The rule
    // claims to test the title OR the url, so it must actually test both.
    hasYear: Boolean(preParse.ok ? preParse.year
      : (extractYear(rec.title) || String(rec.url || "").match(/\/(1[89]\d{2}|20[0-4]\d)-/))),
  });
  if (verdict.action === "reject") {
    stats.structuralRejects.push({ title: rec.title, reason: verdict.reason });
    // Persist it. Exclusions that leave no trace cannot be audited or overturned, and the
    // largest class here — year-less titles — is exactly the one a reviewer may want to argue with.
    recordRejection(db, rec, verdict.reason, "REJECTED_STRUCTURAL");
    return;
  }
  // A recognised motorcycle marque is a SETTLED category, not a judgement call — asking a
  // human whether a Ducati Monster belongs in a car index wastes the attention that should
  // go to genuinely ambiguous records. parseTitle already identifies these; treat its verdict
  // as a rejection rather than routing it to review.
  if (!preParse.ok && /motorcycle/i.test(preParse.reason || "")) {
    stats.structuralRejects.push({ title: rec.title, reason: preParse.reason });
    recordRejection(db, rec, preParse.reason, "REJECTED_OUT_OF_SCOPE");
    return;
  }

  if (verdict.action === "review") {
    // Pass the DECISION SHAPE, not prose, so triage is exact: an inferred make is a marque
    // lookup, a failed parse is an inspection, anything else is an unproven model that will
    // usually self-resolve as volume grows.
    queueForReview(db, rec, {
      reason: verdict.reason,
      year: preParse.year ?? null,
      make: preParse.make ?? null,
      confidence: verdict.confidence,
      makeInferred: Boolean(preParse.makeInferred),
      parsedOk: Boolean(preParse.ok),
    });
    stats.queued.push({ title: rec.title, reason: verdict.reason });
    return;
  }

  const resolution = resolveCarV2(db, rec);
  if (resolution.status === "queued") {
    queueForReview(db, rec, resolution);
    stats.queued.push({ title: rec.title, reason: resolution.reason });
    return;
  }
  if (!resolution.created) stats.attachedToExistingCar++;

  const carId = resolution.carId;
  const recWithUsd = { ...rec, price_usd: usdFor(rec) };

  // Cross-source dedup: score this record against every sale already on file for this
  // car_id (dedup/dedup.js §4.2). At current real data volume this rarely fires — most
  // cars in this dataset have exactly one real sale — but it runs on every ingest so the
  // moment two sources DO cover the same car, the logic is already live, not bolted on later.
  const existing = getExistingSalesForCar(db, carId);
  for (const ex of existing) {
    if (daysApart({ sold_at: ex.sold_at }, { sold_at: rec.sold_at }) > 7) continue;
    const score = duplicateScore(
      { ...ex, vin_normal: ex.vin_normal, price_usd: ex.price_usd },
      { ...recWithUsd, vin_normal: recWithUsd.vin_raw ? normalizeVin(recWithUsd.vin_raw) : null }
    );
    if (score >= DUPLICATE_THRESHOLD) {
      const exTrust = SOURCE_TRUST[ex.source] ?? 5;
      const newTrust = SOURCE_TRUST[rec.source] ?? 5;
      if (newTrust >= exTrust) {
        stats.duplicatesDropped.push({ title: rec.title, keptSource: ex.source, droppedSource: rec.source, score });
        recordDuplicate(db, rec, carId, score, `duplicate of an existing ${ex.source} sale for this car (score ${score.toFixed(2)}) — kept the existing row, dropped this one`);
        return; // existing record is equal-or-more trusted; drop the incoming one
      }
      // incoming is more trusted — remove the existing lower-trust row, fall through to insert
      db.prepare("DELETE FROM sale WHERE id = ?").run(ex.id);
      stats.duplicatesDropped.push({ title: rec.title, keptSource: rec.source, droppedSource: ex.source, score });
      recordDuplicate(
        db,
        { source: ex.source, source_lot_id: ex.source_lot_id, title: ex.title, sold_at: ex.sold_at, price: ex.price, url: ex.url },
        carId, score,
        `duplicate of the incoming ${rec.source} sale for this car (score ${score.toFixed(2)}) — the incoming source is more trusted, so this existing row was replaced`
      );
    }
  }

  insertSale(db, carId, recWithUsd);
  stats.inserted.push({ title: rec.title, carId, created: !!resolution.created });

  // CLEAR ANY STALE QUEUE ROW FOR THIS LOT — a lot that now has a real `sale` row must not
  // keep sitting in the review queue (pending OR rejected) from an earlier, less capable pass.
  // Found on the real corpus: fixing two overly broad reject rules (Pontiac/Plymouth "Formula"
  // trims, "Quad"-carbureted engines) let previously-REJECTED real cars resolve successfully —
  // but nothing was clearing their old queue row, so they would show as both a real sale AND a
  // permanently-rejected queue item. 'resolved' rather than deleted, so the history stays
  // auditable.
  db.prepare(
    "UPDATE car_resolution_queue SET status = 'resolved' WHERE source = ? AND source_lot_id = ? AND status IN ('pending','rejected')"
  ).run(rec.source, rec.source_lot_id);
}

function ingestFiles(db, files) {
  const stats = { inserted: [], queued: [], duplicatesDropped: [], skippedNoPrice: 0, attachedToExistingCar: 0, standingRejects: [], structuralRejects: [], corpusStats: null };

  const all = [];
  for (const file of files) {
    for (const rec of JSON.parse(fs.readFileSync(file, "utf8"))) all.push(rec);
  }

  // PRE-PASS: parse the whole batch before ingesting any of it.
  //
  // Needed because the evidence layer would otherwise deadlock — a make cannot be accepted
  // until the corpus has seen it, and it cannot enter the corpus until it is accepted. Reading
  // the batch first lets an unfamiliar-but-real marque prove itself by the SPREAD it shows
  // (many model years, several models), which is what separates a genuine marque from a
  // repeated mis-parse.
  //
  // Structurally-rejected rows are excluded from the evidence base: a batch full of
  // "Wheels for Porsche" must not be allowed to vouch for anything.
  const parsedByTitle = new Map();
  const incoming = [];
  for (const rec of all) {
    if (!rec || !rec.title || parsedByTitle.has(rec.title)) continue;
    const p = parseTitle(rec.title, { url: rec.url });
    parsedByTitle.set(rec.title, p);
    if (!p.ok) continue;
    if (structuralVerdict(rec.title, { hasYear: Boolean(p.year) })?.verdict === "reject") continue;
    incoming.push({ make: p.make, modelKey: p.modelKey, year: p.year ?? null, source: rec.source });
  }

  // Corpus statistics are the evidence base for accepting unfamiliar makes: accepted sales
  // from the DB (so trust accumulates across runs) PLUS the batch spread computed above.
  stats.corpusStats = buildCorpusStats(db, incoming);
  stats.parsedByTitle = parsedByTitle; // reused per record so parseTitle runs once per title

  for (const rec of all) ingestRecord(db, rec, stats);
  return stats;
}

function printReport(stats) {
  console.log(`\n=== INGESTION REPORT ===`);
  if (stats.alreadyIngested) console.log(`Already ingested (refreshed price/date/status; mileage/vin/color/transmission kept where enrichment provided them): ${stats.alreadyIngested}`);
  const newCars = stats.inserted.filter((i) => i.created).length;
  const attached = stats.inserted.length - newCars;
  console.log(`Inserted: ${stats.inserted.length}  (${newCars} created a new car, ${attached} ATTACHED to a car already in the catalogue)`);
  for (const i of stats.inserted) console.log(`  + ${i.title}${i.created ? " (new car)" : "  <-- ATTACHED to existing car"}`);
  console.log(`Queued for review: ${stats.queued.length}`);
  for (const q of stats.queued) console.log(`  ? ${q.title} — ${q.reason}`);
  console.log(`Duplicates dropped: ${stats.duplicatesDropped.length}`);
  for (const d of stats.duplicatesDropped) console.log(`  x ${d.title} — kept ${d.keptSource}, dropped ${d.droppedSource} (score ${d.score.toFixed(2)})`);
  if (stats.structuralRejects?.length) {
    const uniq = [...new Set(stats.structuralRejects.map((r) => r.reason))];
    console.log(`Rejected by structural pattern: ${stats.structuralRejects.length} (${uniq.join(", ")})`);
  }
  if (stats.standingRejects?.length) {
    const uniq = [...new Set(stats.standingRejects.map((r) => r.reason))];
    console.log(`Auto-rejected by standing review decisions: ${stats.standingRejects.length} (${uniq.join(", ")})`);
  }
  if (stats.skippedNoPrice) console.log(`Skipped (no price, not reserve_not_met — malformed): ${stats.skippedNoPrice}`);
}

if (require.main === module) {
  // SQLite takes ONE writer. Two concurrent ingests crash with "database is locked", and the
  // survivor silently produces wrong numbers — it reads rows the other is still inserting,
  // which reads as non-convergence. Both were observed for real. See jobs/lock.js.
  require("../jobs/lock").withLock("ingest", () => {
    const db = openDb();
    const args = process.argv.slice(2);
    // Only real record arrays — harvester sidecars (resume state, plans) live here too and are
    // not data. See ingest/load-scraped.js.
    const files = args.length ? args : require("./load-scraped").scrapedFiles(SCRAPED_DIR);
    console.log(`Ingesting ${files.length} file(s): ${files.map((f) => path.basename(f)).join(", ")}`);
    const stats = ingestFiles(db, files);
    printReport(stats);
    db.close();
  });
}

module.exports = { ingestFiles, ingestRecord };
