// Adapter tests for the Mecum event crawler, written BEFORE harvesting at volume — the same
// discipline as crawler/rms-adapt.test.js. The date parser is what previously failed
// silently (0% sold_at), so every measured og:description shape gets a check.
"use strict";

const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "mecum.event.crawler.js"), "utf8");

// The crawler runs a pipeline at module level, so import just the two pure functions.
const MONTHS = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6,
  august: 7, september: 8, october: 9, november: 10, december: 11 };

function extractFn(name) {
  const m = SRC.match(new RegExp(`function ${name}[\\s\\S]*?\\n}\\n`));
  if (!m) throw new Error(`${name} not found`);
  return new Function("MONTHS", `const MONTH_INDEX = MONTHS; ${m[0]}; return ${name};`)(MONTHS);
}

const dateFromLanding = extractFn("dateFromLanding");
const dateFromLotsPage = extractFn("dateFromLotsPage");

const { adaptLot } = require("./mecum-adapt");

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

// ── dateFromLanding: measured og:description forms ─────────────────────────────────────
check("single day", dateFromLanding("held in Dallas, TX on March 26, 2024."), "2024-03-26T12:00:00.000Z");
check("range same month", dateFromLanding("on September 4-7, 2024."), "2024-09-07T12:00:00.000Z");
check("range crossing month", dateFromLanding("on May 28-June 1, 2024."), "2024-06-01T12:00:00.000Z");
check("multiple ranges -> last", dateFromLanding("July 15-19, 2025 and again August 1-3, 2025."), "2025-08-03T12:00:00.000Z");
check("no date -> null (never a hollow date)", dateFromLanding("no dates here"), null);

// ── dateFromLotsPage: rendered day filters, year from slug ─────────────────────────────
check(
  "day filters -> last day",
  dateFromLotsPage("Wednesday, January 5 Thursday, January 6 Friday, January 7", "kissimmee-2022"),
  "2022-01-07T12:00:00.000Z"
);
check("no filters -> null", dateFromLotsPage("nothing useful", "kissimmee-2022"), null);

// ── adaptLot gates ─────────────────────────────────────────────────────────────────────
const CARD = { href: "/lots/4319421/1969-ford-mustang-boss-429-fastback/", cardText: "1969 Ford Mustang Boss 429 Fastback SOLD $275,000" };

const ok = adaptLot(CARD, "2024-09-07T12:00:00.000Z", { event: "dallas-2024" });
check("sold card -> sale, price+date+id", [ok.kind, ok.record.price, ok.record.source_lot_id, ok.record.sold_at.slice(0, 10), ok.record.currency],
  ["sale", 275000, "4319421", "2024-09-07", "USD"]);

check("no date -> REFUSED (the old silent defect)",
  adaptLot(CARD, null, { event: "dallas-2024" }).kind, "skip");

check("Bid Goes On with a visible high bid -> refused, not a $ sale",
  adaptLot({ ...CARD, cardText: "1969 Ford Mustang Boss 429 Fastback Bid Goes On $210,000" }, "2024-09-07T12:00:00.000Z").kind, "skip");

check("no price -> refused",
  adaptLot({ ...CARD, cardText: "1969 Ford Mustang Boss 429 Fastback" }, "2024-09-07T12:00:00.000Z").reason, "no price on card");

const r = adaptLot(CARD, "2024-09-07T12:00:00.000Z").record;
check("title from slug is display-cased", r.title, "1969 Ford Mustang Boss 429 Fastback");
check("url strips query, keeps canonical trailing slash", adaptLot({ ...CARD, href: "/lots/4319421/x/?aa_id=99" }, "2024-09-07T12:00:00.000Z").record.url,
  "https://www.mecum.com/lots/4319421/x/");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
