// CRON ORCHESTRATOR — what runs unattended, and what happens when it fails.
//
// The individual harvesters are already safe to re-run: keyed on (source, source_lot_id),
// resumable from state files, converging rather than duplicating. What was missing is
// everything AROUND them, and the gap is not theoretical — running two BaT harvesters at once
// is what produced our only HTTP 429 of the day. We rate-limited ourselves.
//
// So this adds the five things an unattended job actually needs:
//
//   1. AN EXCLUSIVE LOCK. A cron tick must never start while the previous one is still going.
//      This is the single most important guard: a long scrape overrunning into the next tick
//      is the normal way scrapers end up hammering a source.
//   2. TIME BUDGETS. Each stage is capped so one slow source cannot consume the window and
//      starve ingest and compute.
//   3. FAILURE ISOLATION. Sources are independent. Cars & Bids failing must not stop RM
//      Sotheby's, and neither should stop the ingest of what was already collected.
//   4. ERROR CLASSIFICATION. HTTP 429 means back off for hours. ENOTFOUND means local DNS,
//      retry now. A crash means a code bug and a human. These need different responses and the
//      log must say which happened.
//   5. RUN HISTORY. Append-only, so "it worked yesterday" is checkable rather than remembered.
//
// DriveIndex runs "5AM scrape / 7AM recompute" (ground truth §9). This mirrors that shape:
// scrape, then ingest, then recompute — each gated on the previous.
//
// Usage:
//   node jobs/cron.js                 # full run: scrape -> ingest -> compute
//   node jobs/cron.js --no-scrape     # ingest + compute only
//   node jobs/cron.js --status        # show lock state and recent history
//   node jobs/cron.js --release       # force-release a stale lock

"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const LOCK = path.join(ROOT, "data", "cron.lock");
const HISTORY = path.join(ROOT, "data", "cron-history.jsonl");

// A lock older than this is presumed abandoned (machine rebooted mid-run, process killed).
// Longer than the longest legitimate run, shorter than the cron interval.
const LOCK_STALE_HOURS = 6;

const MINUTES = 60 * 1000;

// Stage definitions. Budgets are deliberate: a source that cannot finish in its window is
// resumable, so being cut off costs nothing but a later restart.
const STAGES = [
  { name: "scrape:bat", cmd: ["crawler/bat-partitioned.crawler.js", "run"], budget: 90 * MINUTES, env: { DELAY_MS: "2500" }, optional: true },
  { name: "scrape:cab", cmd: ["crawler/cab.crawler.js"], budget: 30 * MINUTES, optional: true },
  { name: "scrape:rms", cmd: ["crawler/rms.crawler.js", "run"], budget: 30 * MINUTES, optional: true },
  { name: "scrape:good", cmd: ["crawler/gooding.crawler.js", "run"], budget: 15 * MINUTES, optional: true },
  { name: "scrape:sms", cmd: ["crawler/sms.crawler.js"], budget: 5 * MINUTES, optional: true },
  { name: "ingest", cmd: ["ingest/ingest.js"], budget: 45 * MINUTES, optional: false },
  { name: "compute", cmd: ["jobs/nightly-compute.js"], budget: 45 * MINUTES, optional: false },
];

// ── LOCK ───────────────────────────────────────────────────────────────────────────────
// Strip a UTF-8 BOM before parsing. PowerShell's Set-Content writes one by default, and a BOM
// makes JSON.parse throw — which here would mean readLock() returns null, the lock is treated
// as absent, and a SECOND pipeline starts on top of a running one. That is the precise failure
// this file exists to prevent, so it must not be defeated by an encoding detail.
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

function acquireLock() {
  const existing = readLock();
  if (existing) {
    const ageHours = (Date.now() - new Date(existing.startedAt).getTime()) / 3600000;
    const alive = processAlive(existing.pid);
    if (alive && ageHours < LOCK_STALE_HOURS) {
      return { ok: false, reason: `run ${existing.runId} still active (pid ${existing.pid}, ${ageHours.toFixed(1)}h)` };
    }
    // Stale: the holder is gone, or it has run impossibly long. Reclaim and say so — a silent
    // reclaim would hide a crash loop.
    console.log(`reclaiming stale lock: pid ${existing.pid} ${alive ? "alive but" : "dead,"} ${ageHours.toFixed(1)}h old`);
  }
  const lock = { runId: new Date().toISOString().replace(/[:.]/g, "-"), pid: process.pid, startedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  fs.writeFileSync(LOCK, JSON.stringify(lock, null, 1));
  return { ok: true, lock };
}

const releaseLock = () => { try { fs.unlinkSync(LOCK); } catch {} };

// ── ERROR CLASSIFICATION ───────────────────────────────────────────────────────────────
// Each class needs a different response, and the log must name which occurred.
function classify(stdout, stderr, code, timedOut) {
  const text = `${stdout}\n${stderr}`;
  if (timedOut) return { klass: "BUDGET", advice: "hit its time budget; resumable, will continue next run" };
  if (/HTTP 429|rest_too_many/i.test(text)) return { klass: "THROTTLED", advice: "the host is rate-limiting; back off HOURS, do not retry soon" };
  if (/ENOTFOUND|EAI_AGAIN/i.test(text)) return { klass: "DNS", advice: "local resolver, not the host; safe to retry immediately" };
  if (/ECONNRESET|CONNECT_TIMEOUT|ETIMEDOUT/i.test(text)) return { klass: "TRANSPORT", advice: "ambiguous; a fresh process usually succeeds" };
  if (/RangeError|TypeError|ReferenceError|SyntaxError|Cannot read/i.test(text)) return { klass: "CODE", advice: "a genuine bug — needs a human, retrying will not help" };
  if (code !== 0) return { klass: "EXIT", advice: `non-zero exit ${code}` };
  return { klass: "OK", advice: "" };
}

function runStage(stage) {
  const started = Date.now();
  const res = spawnSync(process.execPath, stage.cmd, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: stage.budget,
    env: { ...process.env, ...(stage.env || {}) },
    maxBuffer: 64 * 1024 * 1024,
  });
  const timedOut = res.error && res.error.code === "ETIMEDOUT";
  const { klass, advice } = classify(res.stdout || "", res.stderr || "", res.status, timedOut);

  // Pull the harvester's own summary line out of its output, so history records WORK DONE and
  // not merely that the process exited.
  const summary =
    (String(res.stdout || "").match(/^\s*\d[\d,]* (?:records|sales) \(\+[\d,]+.*$/m) ||
     String(res.stdout || "").match(/^Inserted: .*$/m) ||
     String(res.stdout || "").match(/^\s*wrote .*$/mi) || [""])[0].trim();

  return {
    stage: stage.name,
    klass,
    advice,
    exit: res.status,
    minutes: Number(((Date.now() - started) / 60000).toFixed(1)),
    summary,
  };
}

function appendHistory(entry) {
  fs.mkdirSync(path.dirname(HISTORY), { recursive: true });
  fs.appendFileSync(HISTORY, JSON.stringify(entry) + "\n");
}

// ── CLI MODES ──────────────────────────────────────────────────────────────────────────
if (process.argv.includes("--status")) {
  const l = readLock();
  console.log(l ? `LOCKED by pid ${l.pid} since ${l.startedAt} (alive: ${processAlive(l.pid)})` : "not locked");
  try {
    const lines = fs.readFileSync(HISTORY, "utf8").trim().split("\n").slice(-8);
    console.log(`\nlast ${lines.length} runs:`);
    for (const l2 of lines) {
      const r = JSON.parse(l2);
      console.log(`  ${r.runId}  ${r.outcome.padEnd(8)} ${r.durationMin}min  ${r.stages.map((s) => `${s.stage}:${s.klass}`).join(" ")}`);
    }
  } catch { console.log("\nno history yet"); }
  process.exit(0);
}

if (process.argv.includes("--release")) {
  const l = readLock();
  releaseLock();
  console.log(l ? `released lock held by pid ${l.pid}` : "no lock to release");
  process.exit(0);
}

// ── RUN ────────────────────────────────────────────────────────────────────────────────
const got = acquireLock();
if (!got.ok) {
  // This is the guard that would have prevented today's self-inflicted 429. Exiting 0 on
  // purpose: an overlapping tick is expected operation, not an error to alert on.
  console.log(`SKIPPING: ${got.reason}`);
  process.exit(0);
}

const noScrape = process.argv.includes("--no-scrape");
const started = Date.now();
const results = [];

process.on("exit", releaseLock);
process.on("SIGINT", () => { releaseLock(); process.exit(130); });

console.log(`cron run ${got.lock.runId} (pid ${process.pid})\n`);

for (const stage of STAGES) {
  if (noScrape && stage.name.startsWith("scrape:")) continue;

  // A required stage is skipped if an earlier required stage failed — ingesting after a broken
  // scrape is fine, but computing on a failed ingest would publish half-built valuations.
  const requiredFailed = results.some((r) => r.required && r.klass !== "OK");
  if (!stage.optional && requiredFailed) {
    results.push({ stage: stage.name, klass: "SKIPPED", advice: "an earlier required stage failed", exit: null, minutes: 0, summary: "", required: true });
    console.log(`  ${stage.name.padEnd(14)} SKIPPED (earlier required stage failed)`);
    continue;
  }

  const r = runStage(stage);
  r.required = !stage.optional;
  results.push(r);
  console.log(`  ${r.stage.padEnd(14)} ${r.klass.padEnd(10)} ${String(r.minutes).padStart(5)}min  ${r.summary || r.advice}`);
}

const durationMin = Number(((Date.now() - started) / 60000).toFixed(1));
const requiredBad = results.filter((r) => r.required && r.klass !== "OK");
const optionalBad = results.filter((r) => !r.required && r.klass !== "OK");
const outcome = requiredBad.length ? "FAILED" : optionalBad.length ? "PARTIAL" : "OK";

appendHistory({ runId: got.lock.runId, startedAt: got.lock.startedAt, durationMin, outcome, stages: results });

console.log(`\noutcome: ${outcome} in ${durationMin}min`);
for (const r of results.filter((x) => x.klass !== "OK")) console.log(`  ${r.stage}: ${r.klass} — ${r.advice}`);
if (outcome === "PARTIAL") console.log(`  (optional scrape stages can fail without blocking ingest/compute — that is by design)`);

releaseLock();
// 0 = clean, 1 = a source failed but the pipeline ran, 2 = the pipeline itself failed.
process.exit(outcome === "OK" ? 0 : outcome === "PARTIAL" ? 1 : 2);
