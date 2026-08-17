// Can the evidence layer LEARN a marque it has never accepted — without also learning junk?
//
// The deadlock being tested: counting only accepted sales means a make needs 3 sightings to be
// accepted and needs to be accepted to get any sightings. Measured cost was ~450 review items
// stuck on real marques (MGA, Morris Minor, Corvair, Imperial, Jeepster).
//
// The fix lets an unseen make earn trust from the SPREAD it shows in the incoming batch —
// many model years, several distinct models — rather than from raw repetition. These tests
// exist to hold that line in both directions: a real marque must get through, and the three
// ways a fake one could sneak in must each stay blocked.
//
// Run: node resolve/bootstrap.test.js

const assert = require("assert");
const {
  classify, buildCorpusStats, batchEvidence,
  MIN_BATCH_SIGHTINGS, MIN_BATCH_YEARS, MIN_BATCH_MODELS,
} = require("./evidence");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

// An empty DB stand-in: the corpus has accepted nothing, which is the worst case and exactly
// the situation the deadlock describes.
const emptyDb = { prepare: () => ({ all: () => [] }) };

const mk = (make, modelKey, year, source = "bat") => ({ make, modelKey, year, source });

console.log("\nBOOTSTRAPPING AN UNSEEN MAKE\n");

t("a marque with real spread qualifies on batch evidence", () => {
  const incoming = [
    mk("Morris", "minor 1000", 1959), mk("Morris", "minor 1000", 1961),
    mk("Morris", "minor traveller", 1963), mk("Morris", "minor convertible", 1965),
    mk("Morris", "minor 1000", 1967), mk("Morris", "minor van", 1968),
    mk("Morris", "oxford", 1955), mk("Morris", "minor 1000", 1970),
  ];
  const stats = buildCorpusStats(emptyDb, incoming);
  const be = batchEvidence("Morris", stats);
  assert.ok(be.qualifies, `expected qualify, got n=${be.n} years=${be.years} models=${be.models}`);

  const v = classify({
    title: "1959 Morris Minor 1000", knownMake: false, stats, hasYear: true,
    parsed: { ok: true, make: "Morris", modelKey: "minor 1000", year: 1959 },
  });
  assert.strictEqual(v.action, "accept", `expected accept, got ${v.action}: ${v.reason}`);
});

t("the corpus stays clean: batch counts never merge into makeFreq", () => {
  const stats = buildCorpusStats(emptyDb, [mk("Morris", "minor", 1959)]);
  assert.strictEqual(stats.makeFreq.get("Morris"), undefined,
    "batch sightings leaked into the accepted-corpus counts");
  assert.strictEqual(stats.batchMakeFreq.get("Morris"), 1);
});

console.log("\nTHE THREE WAYS JUNK COULD SNEAK IN — each must stay blocked\n");

t("repetition alone is not enough (one frozen string, many times)", () => {
  // The signature of a systematic mis-parse: same year, same model, repeated.
  const incoming = Array.from({ length: 40 }, () => mk("Zzqqx", "widget", 1999));
  const stats = buildCorpusStats(emptyDb, incoming);
  const be = batchEvidence("Zzqqx", stats);
  assert.ok(!be.qualifies, "40 identical rows must not vouch for a make");

  const v = classify({
    title: "1999 Zzqqx Widget", knownMake: false, stats, hasYear: true,
    parsed: { ok: true, make: "Zzqqx", modelKey: "widget", year: 1999 },
  });
  assert.strictEqual(v.action, "review", `expected review, got ${v.action}`);
});

t("many years but only one model is not enough", () => {
  const incoming = Array.from({ length: 12 }, (_, i) => mk("Zzqqx", "widget", 1990 + i));
  const stats = buildCorpusStats(emptyDb, incoming);
  assert.ok(!batchEvidence("Zzqqx", stats).qualifies,
    "single-model spread must not qualify — that is what a mis-parse looks like");
});

t("many models but only one year is not enough", () => {
  const incoming = Array.from({ length: 12 }, (_, i) => mk("Zzqqx", `widget ${i}`, 1999));
  const stats = buildCorpusStats(emptyDb, incoming);
  assert.ok(!batchEvidence("Zzqqx", stats).qualifies, "single-year spread must not qualify");
});

t("a thin batch does not qualify even with perfect diversity", () => {
  const incoming = [mk("Zzqqx", "a", 1990), mk("Zzqqx", "b", 1991), mk("Zzqqx", "c", 1992), mk("Zzqqx", "d", 1993)];
  const stats = buildCorpusStats(emptyDb, incoming);
  const be = batchEvidence("Zzqqx", stats);
  assert.ok(be.years >= MIN_BATCH_YEARS && be.models >= MIN_BATCH_MODELS, "fixture should have diversity");
  assert.ok(be.n < MIN_BATCH_SIGHTINGS && !be.qualifies, "too few sightings must still fail");
});

console.log("\nBACKWARD COMPATIBILITY\n");

t("omitting the batch reproduces the old accepted-corpus-only behaviour", () => {
  const stats = buildCorpusStats(emptyDb);
  assert.strictEqual(stats.batchSize, 0);
  assert.strictEqual(batchEvidence("Morris", stats), null);
  const v = classify({
    title: "1959 Morris Minor 1000", knownMake: false, stats, hasYear: true,
    parsed: { ok: true, make: "Morris", modelKey: "minor 1000", year: 1959 },
  });
  assert.strictEqual(v.action, "review", "with no batch evidence an unseen make must go to a human");
});

t("an accepted-corpus make still wins without any batch help", () => {
  const db = {
    prepare: () => ({
      all: () => [
        { make: "Porsche", model_key: "911 carrera", source: "bat" },
        { make: "Porsche", model_key: "911 turbo", source: "cab" },
        { make: "Porsche", model_key: "911 gt3", source: "mecum" },
      ],
    }),
  };
  const stats = buildCorpusStats(db);
  const v = classify({
    title: "1995 Porsche 911 Carrera", knownMake: false, stats, hasYear: true,
    parsed: { ok: true, make: "Porsche", modelKey: "911 carrera", year: 1995 },
  });
  assert.strictEqual(v.action, "accept");
});

t("structural rejection still outranks any amount of batch evidence", () => {
  const incoming = Array.from({ length: 30 }, (_, i) => mk("Porsche", `wheels ${i % 5}`, 1990 + (i % 10)));
  const stats = buildCorpusStats(emptyDb, incoming);
  const v = classify({
    title: '18×8" Wheels for Porsche 911', knownMake: true, stats, hasYear: false,
    parsed: { ok: true, make: "Porsche", modelKey: "wheels", year: null },
  });
  assert.strictEqual(v.action, "reject", "a parts listing must be rejected regardless of evidence");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
