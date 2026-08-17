// Shared loader for the scraped-samples directory.
//
// WHY THIS EXISTS
// Six separate scripts had independently written
//     for (const f of readdirSync(DIR)) if (f.endsWith(".json")) all.push(...JSON.parse(...))
// which assumes every .json in the directory is an array of scrape records. That assumption
// broke the moment a harvester checkpointed its resume state as
// `bat-partitioned.state.json` — spreading a non-iterable object threw, and two test suites
// died on a file that was never data.
//
// Centralising it means the rule is enforced in one place: only well-formed record ARRAYS are
// data; anything else in the directory (state files, plans, notes) is ignored rather than
// crashing the caller.
"use strict";

const fs = require("fs");
const path = require("path");

const SCRAPED_DIR = path.join(__dirname, "..", "samples", "scraped");

// Sidecar files a harvester may leave next to its output. Excluded by NAME as well as by
// shape, so a malformed one produces a clear skip rather than a confusing parse error.
const SIDECAR = /\.(state|plan|meta|progress)\.json$/i;

/** Paths of every file in `dir` that actually holds an array of scrape records. */
function scrapedFiles(dir = SCRAPED_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !SIDECAR.test(f))
    .map((f) => path.join(dir, f))
    .filter((p) => {
      try {
        return Array.isArray(JSON.parse(fs.readFileSync(p, "utf8")));
      } catch {
        return false; // truncated mid-checkpoint, or simply not data
      }
    });
}

/** Every scrape record across the directory, flattened. */
function loadScrapedRecords(dir = SCRAPED_DIR) {
  const out = [];
  for (const p of scrapedFiles(dir)) {
    try {
      for (const r of JSON.parse(fs.readFileSync(p, "utf8"))) out.push(r);
    } catch {
      /* already filtered; ignore a file that changed under us mid-read */
    }
  }
  return out;
}

/**
 * Append every scrape record into an EXISTING array, without spreading.
 *
 * Callers used to write `all.push(...loadScrapedRecords(dir))`, which passes every record as a
 * separate function argument. That works fine at 22,000 records and dies at 180,000 with
 * "RangeError: Maximum call stack size exceeded" — a failure that appears only once the corpus
 * grows, long after the code looked correct. Two test suites were silently failing this way.
 *
 * Exposed as a helper so no caller has to remember the hazard.
 */
function appendScrapedRecords(target, dir = SCRAPED_DIR) {
  for (const p of scrapedFiles(dir)) {
    try {
      for (const r of JSON.parse(fs.readFileSync(p, "utf8"))) target.push(r);
    } catch {
      /* already filtered */
    }
  }
  return target;
}

module.exports = { SCRAPED_DIR, scrapedFiles, loadScrapedRecords, appendScrapedRecords };
