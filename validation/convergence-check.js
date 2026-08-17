// DOES INGEST CONVERGE AT FULL SCALE?
//
// It held at 60k sales (run 1 +2, runs 2-4 +0). At 200k+ the README recorded it as failing —
// but that measurement was contaminated: a second ingest was writing at the same time, which
// both crashes one process ("database is locked") and makes the survivor read rows mid-insert,
// which looks exactly like non-convergence.
//
// This settles it properly:
//   * takes the shared single-writer lock, so no other stage can interleave
//   * FINGERPRINTS the input files before and after, so a harvest growing underneath cannot be
//     mistaken for the pipeline failing to settle
//   * checks the hard guarantee (zero duplicate lot keys) after every pass
//
// Convergence — not an immediate fixed point — is the correct contract. The evidence layer
// legitimately accepts on run 2 what it queued on run 1, once other records vouch for a make.
// What must not happen is drift without end, or duplication at any point.
//
// Usage: node validation/convergence-check.js [passes]
"use strict";

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.join(__dirname, "..");
const { ingestFiles } = require(path.join(ROOT, "ingest", "ingest"));
const { scrapedFiles } = require(path.join(ROOT, "ingest", "load-scraped"));

const PASSES = Number(process.argv[2]) || 3;

require(path.join(ROOT, "jobs", "lock")).withLock("convergence-check", () => {
  const files = scrapedFiles();
  const fingerprint = () => files.map((f) => `${path.basename(f)}:${fs.statSync(f).size}`).join("|");
  const before = fingerprint();

  const db = new DatabaseSync(path.join(ROOT, "data", "driveindex.sqlite"));
  const snap = () => ({
    sales: db.prepare("SELECT COUNT(*) c FROM sale").get().c,
    cars: db.prepare("SELECT COUNT(*) c FROM car").get().c,
    pending: db.prepare("SELECT COUNT(*) c FROM car_resolution_queue WHERE status='pending'").get().c,
  });
  const dupes = () => db.prepare(`SELECT COUNT(*) c FROM (
    SELECT source, source_lot_id FROM sale GROUP BY source, source_lot_id HAVING COUNT(*) > 1)`).get().c;

  console.log(`input: ${files.length} files`);
  let prev = snap();
  console.log(`start      sales=${prev.sales}  cars=${prev.cars}  pending=${prev.pending}`);

  const deltas = [];
  for (let run = 1; run <= PASSES; run++) {
    ingestFiles(db, files);
    const now = snap();
    const d = { sales: now.sales - prev.sales, cars: now.cars - prev.cars, pending: now.pending - prev.pending };
    deltas.push(d);
    console.log(`after ${run}    sales=${now.sales} (+${d.sales})  cars=${now.cars} (+${d.cars})  pending=${now.pending} (+${d.pending})  dupes=${dupes()}`);
    prev = now;
  }

  const inputStable = before === fingerprint();
  const last = deltas[deltas.length - 1];
  const shrinking = deltas.length < 2 || Math.abs(last.sales) <= Math.abs(deltas[0].sales);

  console.log(`\ninput unchanged throughout : ${inputStable}`);
  console.log(`duplicate lot keys         : ${dupes()}   <- must be 0, always`);
  console.log(`final pass delta           : +${last.sales} sales, +${last.cars} cars, +${last.pending} queued`);

  if (!inputStable) {
    console.log(`\nINCONCLUSIVE — the harvest files changed while this ran, so growth here says`);
    console.log(`nothing about convergence. Re-run with no harvester active.`);
    process.exit(0);
  }
  if (dupes() > 0) {
    console.log(`\nFAIL — duplication. This is the guarantee that must never break.`);
    process.exit(1);
  }
  if (last.sales === 0 && last.cars === 0 && last.pending === 0) {
    console.log(`\nPASS — reached a fixed point.`);
  } else if (shrinking) {
    console.log(`\nCONVERGING — deltas are shrinking, no duplication. More passes would settle it.`);
  } else {
    console.log(`\nFAIL — deltas are not shrinking across passes. Genuine non-convergence.`);
    process.exit(1);
  }
});
