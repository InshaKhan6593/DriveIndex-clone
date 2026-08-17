// Title hygiene: HTML entities, typography, and telling a component from a car.
//
// Every case is drawn from a real record in the corpus.
//
// Run: node resolve/title-hygiene.test.js

const assert = require("assert");
const { parseTitle } = require("./resolve-car-v2");
const { structuralVerdict } = require("./evidence");

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};
const key = (title) => parseTitle(title, {}).modelKey;

console.log("\nHTML ENTITIES MUST NOT REACH THE IDENTITY KEY");
// Measured: 1,046 of 22,506 titles carried entities; &#215; (the x in 4x4) appeared 497 times.
// Undecoded, its own digits became a model token: "4&#215;4" -> "42154".

t("4&#215;4 decodes to 4x4, not the junk token 42154", () => {
  const k = key("Black-Plate 1964 Nissan Patrol 4&#215;4");
  assert.ok(!/42154/.test(k), `entity digits leaked into the key: "${k}"`);
  assert.ok(/4x4/.test(k), `expected a 4x4 token, got "${k}"`);
});

t("encoded and plain spellings produce the SAME car", () => {
  assert.strictEqual(key("1964 Nissan Patrol 4&#215;4"), key("1964 Nissan Patrol 4x4"),
    "the same car written two ways must not split");
});

t("a curly apostrophe does not corrupt the parse", () => {
  const p = parseTitle("Jerry Hathaway&#8217;s 1972 Citroen SM 5-Speed", {});
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.year, 1972);
  assert.ok(!/8217/.test(p.modelKey), `entity digits in key: "${p.modelKey}"`);
});

t("hex entities decode too", () => {
  assert.ok(!/xd7|215/.test(key("1984 Jeep J10 4&#xd7;4 V8")), "hex entity leaked");
});

t("unicode typography folds to ASCII", () => {
  assert.strictEqual(key("1964 Nissan Patrol 4×4"), key("1964 Nissan Patrol 4x4"));
});

console.log("\nA COMPONENT IS NOT A CAR");
// Real leak: this became a $4,877 "1987 Porsche 911" and pulled that model-year's average down.

t("wheels listing is rejected even though the make leads the title", () => {
  const v = structuralVerdict('Porsche 911 16x7 and 8" Fuchs Wheels', { hasYear: true });
  assert.ok(v && v.verdict === "reject", `expected reject, got ${JSON.stringify(v)}`);
});

t("other components are rejected by the same shape", () => {
  for (const title of [
    "Ferrari 308 Cromodora Wheels",
    "Porsche 911 Recaro Sport Seats",
    "Chevrolet Corvette L88 Intake Manifold",
    "Jaguar E-Type Dashboard Gauges",
  ]) {
    const v = structuralVerdict(title, { hasYear: true });
    assert.ok(v && v.verdict === "reject", `not rejected: "${title}"`);
  }
});

t("REAL CARS ARE NOT rejected by the component rule", () => {
  // Body styles are not components. Over-rejecting silently deletes real sales, which is the
  // more expensive error of the two.
  for (const title of [
    "1965 Ford Mustang Fastback",
    "1987 Porsche 911 Carrera Cabriolet",
    "1970 Chevrolet Chevelle SS 454",
    "1963 Chevrolet Corvette Split-Window Coupe",
    "1994 Land Rover Defender 90 4x4 5-Speed",
    "1932 Ford Roadster",
    "1969 Chevrolet Camaro",
  ]) {
    const v = structuralVerdict(title, { hasYear: true });
    assert.ok(!v || v.verdict !== "reject", `wrongly rejected a real car: "${title}" (${v && v.reason})`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
