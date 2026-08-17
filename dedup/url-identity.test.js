// Regression tests for the listing-URL certainty rule in duplicateScore.
//
// Written from a real miss. Two harvesters recorded the same BaT lot: the JSON API issued the
// numeric id 119030405, the DOM crawler reverse-engineered the slug
// "1973-ferrari-365-gtb-4-daytona-berlinetta-3". Because Layer A keys on
// (source, source_lot_id), the two did not collide. Layer B then scored the pair at 0.7375
// against a 0.75 threshold — short by 0.0125, because one title carried page chrome which
// diluted trigram similarity from 0.10 to 0.0375. One sale entered the index twice.
//
// Both records had the SAME listing URL the whole time. That is identity, not evidence, and
// weighing it on a similarity scale was the mistake.
//
// The tests below hold BOTH directions: same URL must always collapse, and a genuine repeat
// sale (a different auction, therefore a different URL) must never be collapsed by this rule.
//
// Run: node dedup/url-identity.test.js

const assert = require("assert");
const { duplicateScore, DUPLICATE_THRESHOLD, canonicalListingUrl } = require("./dedup");

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};

const U = "https://bringatrailer.com/listing/1973-ferrari-365-gtb-4-daytona-berlinetta-3/";

console.log("\nSAME LISTING URL IS CERTAINTY");

t("the exact pair that slipped through is now collapsed", () => {
  const api = {
    source: "bat", source_lot_id: "119030405", url: U,
    title: "1971 Ferrari 365 GTB/4 Daytona Berlinetta",
    price_usd: 865000, sold_at: "2026-08-08T12:00:00.000Z", vin_normal: null, mileage: null,
  };
  const dom = {
    source: "bat", source_lot_id: "1973-ferrari-365-gtb-4-daytona-berlinetta-3", url: U,
    title: "Completed Auctions Get Daily Updates This Week's Popular Listings 1971 Ferrari 365 GTB/4 Daytona Berlinetta",
    price_usd: 865000, sold_at: "2026-08-08T12:00:00.000Z", vin_normal: null, mileage: null,
  };
  const s = duplicateScore(api, dom);
  assert.ok(s >= DUPLICATE_THRESHOLD, `scored ${s}, needed >= ${DUPLICATE_THRESHOLD}`);
});

t("query string and trailing slash do not defeat the match", () => {
  const a = { source: "bat", url: U, price_usd: 1, sold_at: "2026-01-01" };
  const b = { source: "bat", url: U.replace(/\/$/, "") + "?utm_source=newsletter", price_usd: 999999, sold_at: "2026-01-01" };
  assert.strictEqual(duplicateScore(a, b), 1.0);
});

t("case differences do not defeat the match", () => {
  const a = { source: "bat", url: U, price_usd: 1, sold_at: "2026-01-01" };
  const b = { source: "bat", url: U.toUpperCase(), price_usd: 1, sold_at: "2026-01-01" };
  assert.strictEqual(duplicateScore(a, b), 1.0);
});

console.log("\nTHE RULE IS SCOPED, NOT A BLUNT INSTRUMENT");

t("a URL match across DIFFERENT sources does not take the certainty path", () => {
  // Two sites reporting one event have different URLs in reality, so a shared URL across
  // sources only ever means malformed data. Cross-source pairs must be SCORED, which is what
  // Layer B exists for.
  const a = { source: "bat", url: U, price_usd: 100000, sold_at: "2026-08-08", title: "x", vin_normal: "WP0AA2991VS111111" };
  const b = { source: "classic", url: U, price_usd: 100000, sold_at: "2026-08-08", title: "x", vin_normal: "JT2XX10AJ0000001" };
  assert.strictEqual(duplicateScore(a, b), 0, "differing VINs should decide, not the shared URL");
});

t("same URL months apart falls through to scoring, not certainty", () => {
  // URL-per-relist is verified for BaT but not for all thirteen sources. If some house does
  // reuse a lot URL, a genuine repeat sale must not be silently merged.
  const a = { source: "mecum", url: "https://www.mecum.com/lots/12345/", price_usd: 60000, sold_at: "2021-05-01", title: "1995 Porsche 911" };
  const b = { source: "mecum", url: "https://www.mecum.com/lots/12345/", price_usd: 95000, sold_at: "2026-05-01", title: "1995 Porsche 911" };
  assert.ok(duplicateScore(a, b) < DUPLICATE_THRESHOLD, "a five-year gap must not be certainty");
});

console.log("\nIT MUST NOT EAT GENUINE REPEAT SALES");

t("the same car at two different auctions is NOT collapsed", () => {
  // A relist gets its own slug on BaT, so a real repeat sale always has a distinct URL.
  // This is the single most valuable signal in the product — collapsing it would be far
  // worse than the duplicate the rule was added to catch.
  const first = {
    source: "bat", url: "https://bringatrailer.com/listing/1995-porsche-911-carrera",
    title: "1995 Porsche 911 Carrera", price_usd: 60000, sold_at: "2021-05-01T12:00:00.000Z",
    vin_normal: "WP0AA2991VS111111", mileage: 50000,
  };
  const second = {
    source: "bat", url: "https://bringatrailer.com/listing/1995-porsche-911-carrera-2",
    title: "1995 Porsche 911 Carrera", price_usd: 95000, sold_at: "2026-05-01T12:00:00.000Z",
    vin_normal: "WP0AA2991VS111111", mileage: 54000,
  };
  const s = duplicateScore(first, second);
  assert.ok(s < DUPLICATE_THRESHOLD, `repeat sale wrongly collapsed (scored ${s})`);
});

t("a missing URL falls back to scoring rather than matching on null", () => {
  const a = { url: null, price_usd: 50000, sold_at: "2026-01-01", title: "1995 Porsche 911" };
  const b = { url: null, price_usd: 50000, sold_at: "2026-01-01", title: "1995 Porsche 911" };
  const s = duplicateScore(a, b);
  assert.ok(s > 0 && s <= 1, `expected a scored result, got ${s}`);
  assert.notStrictEqual(canonicalListingUrl(null), "");
});

t("VIN certainty still works when URLs are absent", () => {
  const a = { url: null, vin_normal: "WP0AA2991VS111111", sold_at: "2026-01-01", price_usd: 1 };
  const b = { url: null, vin_normal: "WP0AA2991VS111111", sold_at: "2026-01-03", price_usd: 2 };
  assert.strictEqual(duplicateScore(a, b), 1.0);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
