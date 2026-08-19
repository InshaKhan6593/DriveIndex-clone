// Build the READ-ONLY snapshot that gets uploaded to the hosted database.
//
// The working database is 249MB, and most of what makes it big is never read by the API:
// car_resolution_queue alone is 76MB, 46MB of which is raw_record_json — the full scraped
// record kept so a rejection can be audited or replayed. That matters on the machine that
// runs the pipeline. It is dead weight in production.
//
// Everything here is a COPY. The working database is never modified, so a bad export can be
// deleted and redone.
//
// Usage:  node db/export-serving.js [outfile]
"use strict";

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const SRC = path.join(__dirname, "..", "data", "driveindex.sqlite");
const OUT = process.argv[2] || path.join(__dirname, "..", "data", "serving.sqlite");

// Tables the API actually reads, kept with their rows.
const SERVED = ["car", "car_valuation", "sale", "listing"];

// EMPTIED, NOT DROPPED. api/server.js queries car_resolution_queue in two places (the review
// endpoint and the health counter), so dropping it 500s those routes — verified before this
// list existed. Its rows are what make the file big (76MB, 46MB of it raw_record_json) and the
// review queue is an internal tool, not something a client browses, so the structure ships and
// the contents do not.
const EMPTIED = ["car_resolution_queue"];

if (!fs.existsSync(SRC)) {
  console.error(`no working database at ${SRC}`);
  process.exit(1);
}
// On Windows an open SQLite handle locks the file, so a running API server holding the previous
// snapshot makes this fail with EBUSY and a raw stack trace. Say what is actually wrong.
for (const f of [OUT, `${OUT}-journal`]) {
  try {
    fs.rmSync(f, { force: true });
  } catch (err) {
    if (err.code !== "EBUSY" && err.code !== "EPERM") throw err;
    console.error(`
cannot replace ${f} — a process still has it open.`);
    console.error("Something is serving this snapshot. Stop it and re-run:");
    console.error("  PowerShell:  Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" |");
    console.error("                 Where-Object { $_.CommandLine -like '*api/server.js*' } |");
    console.error("                 Select-Object ProcessId, CommandLine");
    console.error("               then: Stop-Process -Id <pid> -Force
");
    process.exit(1);
  }
}

const db = new DatabaseSync(SRC);

// VACUUM INTO writes a fully compacted copy — no free pages, indexes rebuilt tight. It also
// leaves the source untouched, which a plain file copy plus DELETE would not.
console.log(`copying ${SRC} -> ${OUT} ...`);
db.exec(`VACUUM INTO '${OUT.replace(/'/g, "''")}'`);
db.close();

const out = new DatabaseSync(OUT);
const tables = out.prepare(
  `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
).all().map((r) => r.name);

let dropped = 0, emptied = 0;
for (const t of tables) {
  if (SERVED.includes(t)) continue;
  if (EMPTIED.includes(t)) {
    out.exec(`DELETE FROM "${t}"`);
    emptied++;
    console.log(`  emptied ${t} (structure kept — the API still queries it)`);
    continue;
  }
  out.exec(`DROP TABLE IF EXISTS "${t}"`);
  dropped++;
  console.log(`  dropped ${t}`);
}

// Reclaim the space the dropped tables were holding.
out.exec("VACUUM");

console.log("\nrows kept:");
for (const t of SERVED) {
  try {
    console.log(`  ${t.padEnd(16)} ${out.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n}`);
  } catch {
    console.log(`  ${t.padEnd(16)} MISSING`);
  }
}
out.close();

const mb = (f) => (fs.statSync(f).size / 1048576).toFixed(1);
console.log(`\n${dropped} tables dropped`);
console.log(`  working : ${mb(SRC)} MB`);
console.log(`  serving : ${mb(OUT)} MB   <- upload this one`);
