// ONE-TIME CLEANUP: collapse make-casing variants left over from the inferMakeFromPosition
// title-casing bug (fixed 2026-08-17 in resolve-car-v2.js — see its comment). That fix only
// prevents NEW mis-casing; it cannot retroactively correct car rows the buggy code already
// created, and this pipeline's own "already ingested" fast path (ingest.js) means a lot that
// already has a `sale` row is never re-resolved, so an old wrong car_id assignment persists
// forever unless something goes looking for it. This does that, once.
//
// For each group of car rows whose `make` differs only by case:
//   - if a row under the OTHER casing is otherwise IDENTICAL (year, model_key, body_type,
//     generation, modification, displacement) to one under the canonical casing, merge —
//     move its sales onto the canonical row, drop the duplicate.
//   - otherwise (no colliding row), just rename `make` to the canonical casing in place.
//
// Usage: node validation/fix-make-casing.js [--dry-run]
"use strict";

const { openDb } = require("../db/client");
const { MAKE_ALIASES } = require("../resolve/vocab");

// No safe general FORMATTING rule exists — "Reo" (title case is right) and "AM"/"ERA"/"MGA"
// (acronyms, title case is wrong) need opposite answers, and there is no way to tell which
// from the string alone. Picking by majority vote across real SALES avoids guessing a rule and
// just asks the actual corpus which spelling sellers overwhelmingly use.
function canonicalCasing(variants, db) {
  const lower = variants[0].toLowerCase();
  const curated = MAKE_ALIASES.get(lower);
  if (curated) return curated;
  let best = variants[0], bestCount = -1;
  for (const v of variants) {
    const n = db.prepare("SELECT COUNT(*) n FROM sale s JOIN car c ON c.id = s.car_id WHERE c.make = ?").get(v).n;
    if (n > bestCount) { best = v; bestCount = n; }
  }
  return best;
}

function run() {
  const dryRun = process.argv.includes("--dry-run");
  const db = openDb();

  const makes = db.prepare("SELECT DISTINCT make FROM car").all().map((r) => r.make);
  const byLower = new Map();
  for (const m of makes) {
    const k = m.toLowerCase();
    if (!byLower.has(k)) byLower.set(k, []);
    byLower.get(k).push(m);
  }
  const groups = [...byLower.entries()].filter(([, v]) => v.length > 1);
  console.log(`${groups.length} case-variant groups found\n`);

  let merged = 0, renamed = 0;
  for (const [, variants] of groups) {
    const canon = canonicalCasing(variants, db);
    console.log(`${variants.join(" / ")}  ->  "${canon}"`);
    if (dryRun) continue;

    for (const variant of variants) {
      if (variant === canon) continue;
      const losers = db.prepare("SELECT * FROM car WHERE make = ?").all(variant);
      for (const loser of losers) {
        const survivor = db.prepare(
          `SELECT id FROM car WHERE make = ? AND year IS ? AND model_key = ? AND body_type IS ? AND generation IS ? AND modification IS ? AND displacement IS ?`
        ).get(canon, loser.year, loser.model_key, loser.body_type, loser.generation, loser.modification, loser.displacement);

        if (survivor) {
          db.prepare("UPDATE sale SET car_id = ? WHERE car_id = ?").run(survivor.id, loser.id);
          db.prepare("UPDATE listing SET car_id = ? WHERE car_id = ?").run(survivor.id, loser.id);
          const val = db.prepare("SELECT car_id FROM car_valuation WHERE car_id = ?").get(loser.id);
          if (val) db.prepare("DELETE FROM car_valuation WHERE car_id = ?").run(loser.id);
          db.prepare("DELETE FROM car WHERE id = ?").run(loser.id);
          merged++;
        } else {
          db.prepare("UPDATE car SET make = ? WHERE id = ?").run(canon, loser.id);
          renamed++;
        }
      }
    }
  }

  if (!dryRun) console.log(`\nmerged ${merged} duplicate car rows, renamed ${renamed} non-colliding rows to canonical casing`);
  db.close();
}

run();
