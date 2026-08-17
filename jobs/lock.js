// SINGLE-WRITER LOCK, shared by every stage that writes the database.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────
// The lock previously lived inside jobs/cron.js, so it only protected the orchestrated path.
// Running `node ingest/ingest.js` or `node jobs/nightly-compute.js` directly bypassed it, and
// that is not hypothetical: a convergence measurement died with
//
//     Error: database is locked   (errcode 5)
//
// because a second ingest was already writing. Worse than the crash, the SURVIVING process
// produces misleading numbers — a re-ingest that reads rows another ingest is still inserting
// looks like non-convergence, which is exactly what got recorded as a pipeline defect.
//
// SQLite allows one writer. Every writer must therefore agree to queue, not just the ones that
// happen to go through cron.
//
// Same failure family as running two BaT harvesters at once and rate-limiting ourselves: a
// shared resource with an implicit single-user assumption, and no guard making it explicit.
"use strict";

const fs = require("fs");
const path = require("path");

const LOCK = path.join(__dirname, "..", "data", "pipeline.lock");

// Longer than the longest legitimate stage (a full ingest at 200k+ records), short enough that
// a crashed run does not block the next scheduled tick.
const STALE_HOURS = 6;

function read() {
  try {
    let raw = fs.readFileSync(LOCK, "utf8");
    // PowerShell's Set-Content writes a BOM, and a BOM makes JSON.parse throw — which would
    // read as "no lock" and let a second writer in. Measured for real on the cron lock.
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch { return null; }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; } // EPERM means it exists but is not ours
}

/**
 * Take the write lock, or explain why not.
 * @param {string} label  which stage is asking, for the diagnostic
 * @returns {{ok:true, release:Function} | {ok:false, reason:string}}
 */
function acquire(label) {
  const held = read();
  if (held) {
    const ageH = (Date.now() - new Date(held.startedAt).getTime()) / 3600000;
    if (alive(held.pid) && ageH < STALE_HOURS) {
      return { ok: false, reason: `"${held.label}" is writing (pid ${held.pid}, ${ageH.toFixed(1)}h)` };
    }
    // Reclaim, but SAY SO. A silent reclaim hides a crash loop.
    console.log(`reclaiming stale lock from "${held.label}" (pid ${held.pid}, ${ageH.toFixed(1)}h, alive=${alive(held.pid)})`);
  }

  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  fs.writeFileSync(LOCK, JSON.stringify({ label, pid: process.pid, startedAt: new Date().toISOString() }, null, 1));

  const release = () => { try { fs.unlinkSync(LOCK); } catch {} };
  // Release on every exit path, including Ctrl-C, so a killed run does not wedge the pipeline
  // for STALE_HOURS.
  process.on("exit", release);
  process.on("SIGINT", () => { release(); process.exit(130); });
  process.on("SIGTERM", () => { release(); process.exit(143); });
  return { ok: true, release };
}

/**
 * Wrapper for a stage's main(). Exits 0 when the lock is held by someone else — an overlapping
 * run is expected operation under cron, not an error worth alerting on.
 */
function withLock(label, fn) {
  const got = acquire(label);
  if (!got.ok) {
    console.log(`SKIPPING ${label}: ${got.reason}`);
    console.log(`(a second writer would corrupt measurements and can crash on "database is locked")`);
    process.exit(0);
  }
  try { return fn(); } finally { got.release(); }
}

module.exports = { acquire, withLock, status: read, LOCK_PATH: LOCK };
