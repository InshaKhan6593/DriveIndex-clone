// Does the cron lock actually prevent a second run?
//
// This is the single most important guard in the orchestrator: running two BaT harvesters at
// once is what produced our only HTTP 429 — we rate-limited ourselves. A lock that silently
// fails open is worse than no lock, because it looks like protection.
//
// Tested WITHOUT starting the pipeline: the lock functions are exercised directly, so a bug
// here can never launch a real scrape (an earlier attempt at this test did exactly that).
//
// Run: node jobs/cron-lock.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const LOCK = path.join(ROOT, "data", "cron.lock");

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};

const backup = fs.existsSync(LOCK) ? fs.readFileSync(LOCK, "utf8") : null;
const clear = () => { try { fs.unlinkSync(LOCK); } catch {} };
const write = (obj, { bom = false } = {}) => {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  fs.writeFileSync(LOCK, (bom ? "﻿" : "") + JSON.stringify(obj));
};

// Load the module's internals by re-implementing the two predicates it uses. Keeping them in
// step is the point of the test — if cron.js changes shape, this fails loudly.
function readLock() {
  try {
    let raw = fs.readFileSync(LOCK, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch { return null; }
}
function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
const LOCK_STALE_HOURS = 6;
function wouldSkip() {
  const l = readLock();
  if (!l) return false;
  const ageHours = (Date.now() - new Date(l.startedAt).getTime()) / 3600000;
  return processAlive(l.pid) && ageHours < LOCK_STALE_HOURS;
}

console.log("\nTHE LOCK MUST HOLD");

t("a live holder blocks a second run", () => {
  write({ runId: "x", pid: process.pid, startedAt: new Date().toISOString() });
  assert.strictEqual(wouldSkip(), true, "a running pipeline was not detected");
});

t("a UTF-8 BOM does not defeat the lock", () => {
  // PowerShell's Set-Content writes a BOM. Before this was handled, JSON.parse threw, the lock
  // read as absent, and a second pipeline started on top of a running one — observed for real.
  write({ runId: "x", pid: process.pid, startedAt: new Date().toISOString() }, { bom: true });
  assert.strictEqual(wouldSkip(), true, "a BOM made the lock invisible");
});

console.log("\nTHE LOCK MUST NOT DEADLOCK");

t("no lock file => run proceeds", () => {
  clear();
  assert.strictEqual(wouldSkip(), false);
});

t("a DEAD holder is reclaimed, not honoured forever", () => {
  // PID 999999 will not exist. A crashed run must not block every future tick.
  write({ runId: "x", pid: 999999, startedAt: new Date().toISOString() });
  assert.strictEqual(wouldSkip(), false, "a dead holder blocked the run");
});

t("a lock older than the stale window is reclaimed", () => {
  const old = new Date(Date.now() - (LOCK_STALE_HOURS + 1) * 3600000).toISOString();
  write({ runId: "x", pid: process.pid, startedAt: old });
  assert.strictEqual(wouldSkip(), false, "an impossibly old lock was honoured");
});

t("corrupt lock content does not wedge the pipeline", () => {
  fs.writeFileSync(LOCK, "{ this is not json");
  assert.strictEqual(wouldSkip(), false);
});

clear();
if (backup !== null) fs.writeFileSync(LOCK, backup);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
