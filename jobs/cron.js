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
//
//   node jobs/cron.js --skip=scrape:cab,scrape:dupont      # run everything EXCEPT these
//   node jobs/cron.js --only=fx,ingest,compute             # run ONLY these
//   node jobs/cron.js --deadline-minutes=300               # see DEADLINE below
//
// --skip and --only exist because not every environment may run every stage. The daily GitHub
// Actions run skips the three sources that need a residential IP or a named-party permission
// (Cars & Bids' Cloudflare check, DuPont's bot filter, Mecum's written grant) and the BaT
// detail crawler, which rewrites a 198MB harvest file in place and is therefore local-only.
// --skip is the right flag for that policy: it names what is EXCLUDED, so a stage added later
// runs by default rather than being silently dropped from a hardcoded allowlist.
//
// DEADLINE. A CI runner is killed at a hard wall-clock limit (GitHub Actions: 6 hours), and a
// run killed mid-compute publishes nothing at all — the scrape time is wasted. --deadline-minutes
// stops STARTING new optional scrape stages once elapsed time passes it, so ingest and compute
// are always reached. Backlogs then drain over subsequent days, which is how the crawlers are
// designed to work anyway. It never interrupts a stage already running: each stage has its own
// budget, and killing one mid-write is what the state files are there to avoid.

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

// Stage definitions live in jobs/stages.js so they have exactly one definition and can be
// read (by the ops API, by tests) without requiring this file — which would run the whole
// pipeline at module level and then process.exit().
const { STAGES, MINUTES } = require("./stages");

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

// A scraper can legitimately be very chatty, especially a browser crawler. Keep failure output
// useful without turning one matrix job's artifact into hundreds of megabytes: the tail contains
// the exception, response status, and the last URL in practically every failure mode.
function diagnosticTail(text, maxLines = 120, maxChars = 24000) {
  const lines = String(text || "").trim().split(/\r?\n/).filter(Boolean);
  const tail = lines.slice(-maxLines).join("\n");
  return tail.length > maxChars ? `[...truncated...]\n${tail.slice(-maxChars)}` : tail;
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
  const spawnError = res.error ? `${res.error.code || "SPAWN"}: ${res.error.message}` : "";
  const stdout = String(res.stdout || "");
  const stderr = [String(res.stderr || ""), spawnError].filter(Boolean).join("\n");
  const { klass, advice } = classify(stdout, stderr, res.status, timedOut);

  // Pull the harvester's own summary line out of its output, so history records WORK DONE and
  // not merely that the process exited.
  const summary =
    (stdout.match(/^\s*\d[\d,]* (?:records|sales) \(\+[\d,]+.*$/m) ||
     stdout.match(/^Inserted: .*$/m) ||
     stdout.match(/^\s*wrote .*$/mi) || [""])[0].trim();

  const diagnostics = diagnosticTail([stdout, stderr].filter(Boolean).join("\n"));
  // Successful stages remain compact. A non-empty stderr is still shown because warnings such as
  // a browser challenge often precede an exit-0 empty harvest; the harvest summary catches that
  // second symptom, while this preserves the first one.
  if (klass !== "OK" || stderr.trim()) {
    console.log(`\n  ${stage.name} diagnostics (last ${Math.min(120, diagnostics.split(/\r?\n/).length)} lines):`);
    console.log(diagnostics || "(no subprocess output)");
  }

  return {
    stage: stage.name,
    klass,
    advice,
    exit: res.status,
    minutes: Number(((Date.now() - started) / 60000).toFixed(1)),
    summary,
    diagnostics: klass === "OK" ? "" : diagnostics,
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

function listArg(name) {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!raw) return null;
  const items = raw.slice(name.length + 3).split(",").map((x) => x.trim()).filter(Boolean);
  return items.length ? items : null;
}
const skipList = listArg("skip");
const onlyList = listArg("only");

// Fail loudly on a name that matches no stage. A typo in a CI workflow would otherwise silently
// mean "skip nothing" — i.e. quietly scrape the very sources the flag exists to exclude.
const known = new Set(STAGES.map((s) => s.name));
for (const name of [...(skipList || []), ...(onlyList || [])]) {
  if (!known.has(name)) {
    console.error(`unknown stage: ${name}`);
    console.error(`known stages: ${[...known].join(", ")}`);
    process.exit(2);
  }
}

const deadlineRaw = process.argv.find((a) => a.startsWith("--deadline-minutes="));
const deadlineMin = deadlineRaw ? Number(deadlineRaw.split("=")[1]) : null;
if (deadlineRaw && !(Number.isFinite(deadlineMin) && deadlineMin > 0)) {
  console.error(`--deadline-minutes needs a positive number, got: ${deadlineRaw.split("=")[1]}`);
  process.exit(2);
}

const started = Date.now();
const results = [];
let deadlineHit = false;

process.on("exit", releaseLock);
process.on("SIGINT", () => { releaseLock(); process.exit(130); });

console.log(`cron run ${got.lock.runId} (pid ${process.pid})\n`);

for (const stage of STAGES) {
  if (noScrape && stage.name.startsWith("scrape:")) continue;
  if (onlyList && !onlyList.includes(stage.name)) continue;
  if (skipList && skipList.includes(stage.name)) {
    console.log(`  ${stage.name.padEnd(14)} SKIPPED (--skip)`);
    continue;
  }

  // Past the deadline, stop starting optional scrapes so the required tail (ingest, compute)
  // still runs. Required stages are never skipped this way: a run that scrapes and then fails
  // to compute has published nothing, which is worse than a run that scraped less.
  if (deadlineMin && stage.optional) {
    const elapsedMin = (Date.now() - started) / 60000;
    if (elapsedMin >= deadlineMin) {
      if (!deadlineHit) {
        console.log(`
  -- deadline of ${deadlineMin}min reached at ${elapsedMin.toFixed(1)}min; skipping remaining optional stages --`);
        deadlineHit = true;
      }
      results.push({ stage: stage.name, klass: "SKIPPED", advice: `deadline ${deadlineMin}min reached — backlog drains next run`, exit: null, minutes: 0, summary: "", required: false });
      continue;
    }
  }

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
