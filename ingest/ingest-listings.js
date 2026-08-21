// LISTINGS INGESTION: samples/listings/*.json (asking-price scraper output) -> resolve car_id
// -> upsert into `listing`.
//
// Separate from ingest/ingest.js on purpose — a listing is never a sale (no dedup-against-sales
// scoring, no reserve_not_met/status enum, no BaT-specific provenance gate) but DOES need the
// exact same car-identity resolution so a listing and a sale for the same real car land on the
// same `car_id` — that's the whole point of populating this table (deal score, months-of-supply,
// price-cut pressure are all per-car). Reuses resolve-car-v2's evidence/queue pipeline unchanged.
//
// Usage: node ingest/ingest-listings.js [file1.json file2.json ...]   (defaults to all of samples/listings/*.json)

"use strict";

const fs = require("fs");
const path = require("path");
const { openDb, newId } = require("../db/client");
const { resolveCarV2, parseTitle, extractYear } = require("../resolve/resolve-car-v2");
const { classify, buildCorpusStats, structuralVerdict } = require("../resolve/evidence");
const { MAKE_ALIASES } = require("../resolve/vocab");
const { queueForReview, recordRejection } = require("../resolve/resolve-car");

const LISTINGS_DIR = path.join(__dirname, "..", "samples", "listings");

function upsertListing(db, carId, rec) {
  const existing = db.prepare("SELECT id, first_seen_at FROM listing WHERE source = ? AND source_lot_id = ?").get(rec.source, rec.source_lot_id);
  const now = rec.fetched_at || new Date().toISOString();
  const legacyAsking = /asking/i.test(String(rec._extra?.valueType || ""));
  const isActive = rec.is_active != null ? Boolean(rec.is_active) : legacyAsking;
  const listingType = rec.listing_type || (rec._extra?.estimateLow != null ? "auction" : "classified");
  const listingStatus = rec.listing_status || (isActive ? "live" : "unknown");
  const priceType = rec.price_type || (rec._extra?.estimateLow != null ? "estimate" : listingType === "auction" ? "current_bid" : "asking");
  if (existing) {
    db.prepare(
      `UPDATE listing SET
         url = COALESCE(?, url), price = ?, currency = COALESCE(?, currency),
         mileage = COALESCE(?, mileage), vin = COALESCE(?, vin), color = COALESCE(?, color),
         transmission = COALESCE(?, transmission), tc = COALESCE(?, tc), image_url = COALESCE(?, image_url),
         is_active = ?, listing_type = ?, listing_status = ?, price_type = ?, current_bid = ?,
         estimate_low = ?, estimate_high = ?, ends_at = ?, closed_at = ?, status_reason = ?,
         last_seen_at = ? WHERE id = ?`
    ).run(
      rec.url, rec.price, rec.currency || "USD", rec.mileage, rec.vin_raw, rec.color,
      rec.transmission, rec.tc, rec.image_url, isActive ? 1 : 0,
      listingType, listingStatus, priceType, rec.current_bid ?? null, rec.estimate_low ?? null,
      rec.estimate_high ?? null, rec.ends_at ?? null, rec.closed_at ?? null, rec.status_reason ?? null,
      now, existing.id
    );
    return;
  }
  db.prepare(
    `INSERT INTO listing
     (id, car_id, source, source_lot_id, url, price, currency, mileage, vin, vin_normal, color,
      transmission, tc, image_url, dom, first_seen_at, last_seen_at, is_active,
      listing_type, listing_status, price_type, current_bid, estimate_low, estimate_high,
      ends_at, closed_at, status_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    newId(), carId, rec.source, rec.source_lot_id, rec.url, rec.price, rec.currency || "USD",
    rec.mileage, rec.vin_raw, rec.color, rec.transmission, rec.tc, rec.image_url,
    now, now, isActive ? 1 : 0, listingType, listingStatus, priceType,
    rec.current_bid ?? null, rec.estimate_low ?? null, rec.estimate_high ?? null,
    rec.ends_at ?? null, rec.closed_at ?? null, rec.status_reason ?? null
  );
}

function ingestListingRecord(db, rec, stats) {
  // A closed Hagerty listing may legitimately have no price (for example Withdrawn). Keep the
  // lifecycle row so a previously-live auction can be closed deterministically; price is not a
  // prerequisite for identity resolution or for the active/inactive state.
  if (rec.price == null) stats.noPrice = (stats.noPrice || 0) + 1;

  const already = db.prepare("SELECT id FROM listing WHERE source = ? AND source_lot_id = ?").get(rec.source, rec.source_lot_id);
  // Still refresh price/last_seen_at even when already resolved, same "don't re-litigate a
  // decision that's already made" reasoning as ingest.js's already-ingested fast path — but a
  // listing has no stable car_id to look up without going through resolveCarV2 again first, so
  // just let the normal path run; the resolution itself is idempotent for an unchanged title.
  void already;

  const preParse = stats.parsedByTitle?.get(rec.title) || parseTitle(rec.title, { url: rec.url });
  const knownMake = preParse.ok && [...new Set(MAKE_ALIASES.values())].includes(preParse.make);
  const verdict = classify({
    title: rec.title, parsed: preParse, knownMake,
    stats: stats.corpusStats || { makeFreq: new Map(), makeSources: new Map(), tokenFreq: new Map(), totalSales: 0 },
    // See the note in ingest/ingest.js: a failed parse means "not parsed", not "no year",
    // so the title must be tested too or the recorded rejection reason is false.
    hasYear: Boolean(preParse.ok ? preParse.year
      : (extractYear(rec.title) || String(rec.url || "").match(/\/(1[89]\d{2}|20[0-4]\d)\//))),
  });
  if (verdict.action === "reject") {
    stats.structuralRejects.push({ title: rec.title, reason: verdict.reason });
    recordRejection(db, rec, verdict.reason, "REJECTED_STRUCTURAL");
    return;
  }
  if (verdict.action === "review") {
    queueForReview(db, rec, {
      reason: verdict.reason, year: preParse.year ?? null, make: preParse.make ?? null,
      confidence: verdict.confidence, makeInferred: Boolean(preParse.makeInferred), parsedOk: Boolean(preParse.ok),
    }, "listing");
    stats.queued.push({ title: rec.title, reason: verdict.reason });
    return;
  }

  const resolution = resolveCarV2(db, rec);
  if (resolution.status === "queued") {
    queueForReview(db, rec, resolution, "listing");
    stats.queued.push({ title: rec.title, reason: resolution.reason });
    return;
  }

  upsertListing(db, resolution.carId, rec);
  stats.inserted.push({ title: rec.title, carId: resolution.carId, created: !!resolution.created });
}

function ingestListingFiles(db, files) {
  const stats = { inserted: [], queued: [], skippedNoPrice: 0, noPrice: 0, structuralRejects: [], corpusStats: null };

  const all = [];
  for (const file of files) for (const rec of JSON.parse(fs.readFileSync(file, "utf8"))) all.push(rec);

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
  stats.corpusStats = buildCorpusStats(db, incoming);
  stats.parsedByTitle = parsedByTitle;

  for (const rec of all) ingestListingRecord(db, rec, stats);
  return stats;
}

function printReport(stats) {
  console.log(`\n=== LISTINGS INGESTION REPORT ===`);
  const newCars = stats.inserted.filter((i) => i.created).length;
  console.log(`Inserted/updated: ${stats.inserted.length}  (${newCars} created a new car, ${stats.inserted.length - newCars} attached to an existing car)`);
  console.log(`Queued for review: ${stats.queued.length}`);
  if (stats.structuralRejects.length) console.log(`Rejected by structural pattern: ${stats.structuralRejects.length}`);
  if (stats.noPrice) console.log(`Retained lifecycle rows without a price: ${stats.noPrice}`);
}

if (require.main === module) {
  const db = openDb();
  const args = process.argv.slice(2);
  const files = args.length ? args : fs.existsSync(LISTINGS_DIR)
    ? fs.readdirSync(LISTINGS_DIR).filter((f) => f.endsWith(".json")).map((f) => path.join(LISTINGS_DIR, f))
    : [];
  console.log(`Ingesting ${files.length} file(s): ${files.map((f) => path.basename(f)).join(", ")}`);
  const stats = ingestListingFiles(db, files);
  printReport(stats);
  db.close();
}

module.exports = { ingestListingFiles, ingestListingRecord, upsertListing };
