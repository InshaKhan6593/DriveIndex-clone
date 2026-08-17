// Entity-resolution regression tests. Every case below is built from a REAL title actually
// scraped by this pipeline (samples/scraped/*.json) — no invented examples.
// Run: node resolve/resolve.test.js

const assert = require("node:assert");
const { parseTitle } = require("./resolve-car-v2");

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; process.exitCode = 1; }
}
const key = (t, url) => { const p = parseTitle(t, { url }); if (!p.ok) throw new Error(`queued: ${p.reason}`); return p; };

console.log("\nMUST MERGE — same car, different title dressing");
check("mileage prefix is not identity: '2015 911 GT3' == 'Ice Blue Metallic 2015 911 GT3'", () => {
  assert.strictEqual(key("2015 Porsche 911 GT3").modelKey, key("Ice Blue Metallic 2015 Porsche 911 GT3").modelKey);
});
check("'28k-Mile' prefix stripped", () => {
  assert.strictEqual(key("28k-Mile 1994 Porsche 911 Turbo 3.6").modelKey, key("1994 Porsche 911 Turbo 3.6").modelKey);
});
check("word order does not fragment (the §7 R8 case)", () => {
  assert.strictEqual(
    key("2015 Audi R8 V10 Performance Coupe Quattro").modelKey,
    key("2015 Audi R8 V10 Performance Quattro Coupe").modelKey
  );
});
check("transmission suffix is not identity", () => {
  assert.strictEqual(key("1998 Porsche 911 Carrera S Coupe 6-Speed").modelKey, key("1998 Porsche 911 Carrera S Coupe").modelKey);
});
check("region prefix (RoW/Euro) is not identity", () => {
  assert.strictEqual(key("RoW 1997 Porsche 911 Carrera 4S Coupe").modelKey, key("1997 Porsche 911 Carrera 4S Coupe").modelKey);
});
check("ownership prefix is not identity", () => {
  assert.strictEqual(key("34-Years-Owned 1987 Porsche 911 Turbo Coupe").modelKey, key("1987 Porsche 911 Turbo Coupe").modelKey);
});

console.log("\nMUST NOT MERGE — genuinely different assets");
check("GT3 RS != GT3  (the §4.5 failure that flips a signal)", () => {
  assert.notStrictEqual(key("2019 Porsche 911 GT3 RS").modelKey, key("2019 Porsche 911 GT3").modelKey);
});
check("GT2 RS Weissach != GT2 RS", () => {
  assert.notStrictEqual(key("2018 Porsche 911 GT2 RS Weissach").modelKey, key("2018 Porsche 911 GT2 RS").modelKey);
});
check("Turbo S != Turbo", () => {
  assert.notStrictEqual(key("2018 Porsche 911 Turbo S Coupe").modelKey, key("2018 Porsche 911 Turbo Coupe").modelKey);
});
check("Carrera 4S != Carrera S", () => {
  assert.notStrictEqual(key("1997 Porsche 911 Carrera 4S Coupe").modelKey, key("1997 Porsche 911 Carrera S Coupe").modelKey);
});
check("Coupe != Cabriolet (§7: 'coupe still separate from cabriolet')", () => {
  assert.notStrictEqual(key("2004 Porsche 911 Carrera Coupe").bodyType, key("2004 Porsche 911 Carrera Cabriolet").bodyType);
});
check("Singer restomod NEVER merges with a stock 911", () => {
  const singer = key("1989 Porsche 911 Carrera Classic Turbo by Singer");
  const stock = key("1989 Porsche 911 Carrera Turbo");
  assert.strictEqual(singer.modification, "Singer");
  assert.notStrictEqual(
    [singer.modelKey, singer.modification].join("|"),
    [stock.modelKey, stock.modification].join("|")
  );
});
check("RWD-converted car flagged as modified", () => {
  assert.strictEqual(key("RWD-Converted 1997 Porsche 911 Turbo 3.8L").modification, "Converted");
});
check("re-creation/replica flagged, not filed as the genuine car", () => {
  assert.strictEqual(key("Ferrari 250 GT Speciale Spyder Re-Creation", "https://x/listing/1970-ferrari-250-gt-speciale-tribute-2/").modification, "Replica");
});
check("different model years are different cars", () => {
  assert.notStrictEqual(key("2015 Porsche 911 GT3").year, key("2019 Porsche 911 GT3").year);
});

console.log("\nFIELD EXTRACTION");
check("911 is the MODEL, never eaten as a generation code", () => {
  const p = key("1994 Porsche 911 Turbo 3.6");
  assert.ok(p.modelKey.includes("911"), `911 missing from key: "${p.modelKey}"`);
  assert.strictEqual(p.generation, null);
});
check("a real generation code IS extracted (993)", () => {
  assert.strictEqual(key("1996 Porsche 911 993 Carrera Coupe").generation, "993");
});
check("body style pulled into its own column", () => {
  assert.strictEqual(key("1971 Ferrari 365 GTB/4 Daytona Berlinetta").bodyType, "Coupe");
});
check("body style removed from the model key", () => {
  assert.ok(!key("2004 Porsche 911 Carrera Coupe").modelKey.includes("coupe"));
});
check("multi-word make parsed whole (Aston Martin)", () => {
  assert.strictEqual(key("1953 Aston Martin DB2/4 Drophead Coupe").make, "Aston Martin");
});
check("hyphenated make normalised (Mercedes-Benz)", () => {
  assert.strictEqual(key("2011 Mercedes-Benz SLS AMG").make, "Mercedes-Benz");
});
check("fractional year handled (1963.5 Falcon)", () => {
  assert.strictEqual(key("1963.5 Ford Falcon Sprint Convertible 260 4-Speed").year, 1963);
});
check("year recovered from URL when title has none", () => {
  assert.strictEqual(key("Ferrari 212 Barchetta Re-Creation", "https://x/listing/1965-ferrari-330gt-6/").year, 1965);
});

console.log("\nOUT OF SCOPE -> human review (should be RARE)");
for (const [t, why] of [
  ["ca.1945 T-34/85 Medium Tank", "tank"],
  ["1916 Indian Model O Light Twin", "motorcycle"],
  ["Recaro Sport Seats for Porsche 911", "parts"],
]) {
  check(`queued: ${why}`, () => {
    const p = parseTitle(t);
    assert.strictEqual(p.ok, false, `expected review, got model "${p.modelKey}"`);
  });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
