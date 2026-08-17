// POSITIONAL MAKE INFERENCE — it must rescue real marques WITHOUT admitting everything else.
//
// The bucket it targets is 4,366 queued items whose make the alias list never knew, including
// genuinely valuable cars: "1913 Mercer Model 35-J Raceabout", "1924 Hispano-Suiza H6C Monza
// Speedster", "1948 Delahaye 135 M Cabriolet". RM Sotheby's is largely pre-war, so 73% of its
// catalogue was being dropped.
//
// But the measured head of that same bucket is mostly NOT cars — Moto Guzzi, MV Agusta, Vespa,
// Airstream, Winnebago, Lola, Goodyear, Bertone. So inference on its own would be a disaster.
// Both halves are tested here: it must extract, and it must not be trusted.
//
// Run: node resolve/make-inference.test.js

const assert = require("assert");
const { parseTitle } = require("./resolve-car-v2");
const { classify, buildCorpusStats } = require("./evidence");

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};
const emptyDb = { prepare: () => ({ all: () => [] }) };

console.log("\nIT EXTRACTS THE MARQUE FROM POSITION");

t("pre-war American marque", () => {
  // Mercer was this fixture's original example, but it graduated to the curated MAKE_ALIASES
  // fast path after earning acceptance from evidence (2026-08-17) — exactly the lifecycle the
  // evidence layer is meant to produce, so it no longer exercises INFERENCE. Marmon (built the
  // 1911 Indy 500-winning Wasp, real and well-documented, not curated) tests the same mechanism.
  const p = parseTitle("1928 Marmon Model 78 Roadster", {});
  assert.strictEqual(p.ok, true, p.reason);
  assert.strictEqual(p.make, "Marmon");
  assert.strictEqual(p.makeInferred, true);
});

t("hyphenated European marque", () => {
  const p = parseTitle("1924 Hispano-Suiza H6C Monza Speedster", {});
  assert.strictEqual(p.make, "Hispano-Suiza");
});

t("a two-word marque takes only its first token, and does NOT split", () => {
  // Deliberate: joining a second capitalised word also produced "Imperial Hemi" (Hemi being an
  // engine), and separating engine/trim words from marque second-words needs exactly the
  // hand-maintained list this design avoids. One token is safer, and identity survives because
  // the second word stays in the model key — every Avions Voisin lands on the same make.
  const a = parseTitle("1934 Avions Voisin C23 Roadster", {});
  const b = parseTitle("1936 Avions Voisin C28 Aerosport", {});
  assert.strictEqual(a.make, "Avions");
  assert.strictEqual(b.make, "Avions");
  assert.ok(a.modelKey.includes("voisin"), `second word must survive in the key: "${a.modelKey}"`);
});

t("a curated make inside the title still wins over position", () => {
  // "1930 American Austin Coupe" resolves to Austin, not the positional "American", because
  // Austin is in the alias table. Curated recognition always outranks inference.
  const s = parseTitle("1930 American Austin Coupe", {});
  assert.strictEqual(s.make, "Austin");
  assert.ok(!s.makeInferred);
});

t("a following NUMBER does not get glued on", () => {
  assert.strictEqual(parseTitle("1948 Delahaye 135 M Cabriolet", {}).make, "Delahaye");
});

t("a following BODY WORD does not get glued on", () => {
  assert.strictEqual(parseTitle("1910 Pierce Coupe", {}).make, "Pierce");
});

t("condition adjectives before the make are skipped", () => {
  assert.strictEqual(parseTitle("Restored 1956 Imperial Hemi Sedan", {}).make, "Imperial");
  assert.strictEqual(parseTitle("1967 Morris Minor Pick-Up", {}).make, "Morris");
});

t("a CURATED make still wins and is NOT marked inferred", () => {
  const p = parseTitle("1965 Ford Mustang Fastback", {});
  assert.strictEqual(p.make, "Ford");
  assert.ok(!p.makeInferred, "a known make must not be flagged as inferred");
});

console.log("\nIT IS NEVER TRUSTED ON ITS OWN");

t("an inferred make with no corroboration goes to REVIEW, not the index", () => {
  const stats = buildCorpusStats(emptyDb, []);
  const p = parseTitle("1913 Mercer Model 35-J Raceabout", {});
  const v = classify({ title: "1913 Mercer Model 35-J Raceabout", parsed: p, knownMake: false, stats, hasYear: true });
  assert.strictEqual(v.action, "review", `expected review, got ${v.action}`);
});

t("an inferred make WITH batch diversity is accepted", () => {
  // A real marque spreads: many model years, several models.
  const incoming = [
    { make: "Mercer", modelKey: "raceabout 35j", year: 1913, source: "rms" },
    { make: "Mercer", modelKey: "raceabout 35j", year: 1914, source: "rms" },
    { make: "Mercer", modelKey: "runabout", year: 1912, source: "rms" },
    { make: "Mercer", modelKey: "raceabout", year: 1915, source: "rms" },
    { make: "Mercer", modelKey: "touring", year: 1911, source: "rms" },
    { make: "Mercer", modelKey: "raceabout 35j", year: 1916, source: "rms" },
    { make: "Mercer", modelKey: "runabout", year: 1917, source: "rms" },
    { make: "Mercer", modelKey: "touring", year: 1918, source: "rms" },
  ];
  const stats = buildCorpusStats(emptyDb, incoming);
  const p = parseTitle("1913 Mercer Model 35-J Raceabout", {});
  const v = classify({ title: "1913 Mercer Model 35-J Raceabout", parsed: p, knownMake: false, stats, hasYear: true });
  assert.strictEqual(v.action, "accept", `expected accept, got ${v.action}: ${v.reason}`);
  assert.ok(v.confidence <= 0.8, "an inferred make must never reach curated-level confidence");
});

t("repetition WITHOUT diversity still fails — that is a mis-parse, not a marque", () => {
  const incoming = Array.from({ length: 40 }, () => ({ make: "Goodyear", modelKey: "tires", year: 1970, source: "bat" }));
  const stats = buildCorpusStats(emptyDb, incoming);
  const p = parseTitle("1970 Goodyear Polyglas Tires", {});
  const v = classify({ title: "1970 Goodyear Polyglas Tires", parsed: p, knownMake: false, stats, hasYear: true });
  assert.notStrictEqual(v.action, "accept", "40 identical rows must not vouch for a make");
});

console.log("\nOUT-OF-SCOPE CLASSES ARE STILL REJECTED BEFORE INFERENCE RUNS");

t("motorcycle marques are rejected, not inferred", () => {
  for (const title of ["1974 Moto Guzzi 850 Eldorado", "1972 MV Agusta 750 Sport"]) {
    const p = parseTitle(title, {});
    assert.ok(!p.ok || p.makeInferred !== true || true, "");
    // The motorcycle gate runs before inference, so these must not parse as cars.
    assert.strictEqual(p.ok, false, `"${title}" parsed as a car: make=${p.make}`);
  }
});

t("a tractor is still out of scope even with a famous make", () => {
  assert.strictEqual(parseTitle("1960 Lamborghini 5C Cingolato Tractor", {}).ok, false);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
