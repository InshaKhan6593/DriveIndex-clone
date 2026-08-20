// Smoke tests for the Barrett-Jackson adapter — written against REAL lot URLs observed on
// the live 2026-las-vegas docket (via reader proxy, 2026-08-19), since direct access is
// blocked from this network. Locks the URL parse, the vehicle/automobilia split, the $1
// charity sentinel, and the no-date refusal.
"use strict";

const { adaptLot, parseLotUrl } = require("./barrettjackson-adapt");

const DATE = "2026-09-12T23:00:00.000Z"; // Las Vegas sale close, last day of range

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}`); }
}

// URL parse — real shape from the live docket.
check("vehicle lot URL parses",
  JSON.stringify(parseLotUrl("/2026-las-vegas/docket/vehicle/1962-chevrolet-corvette-custom-convertible-299449?origin=featured")) ===
  JSON.stringify({ kind: "vehicle", slug: "1962-chevrolet-corvette-custom-convertible", lotId: "299449" }));

check("automobilia lot URL parses and is typed",
  parseLotUrl("/2026-las-vegas/docket/automobilia/1955-michelin-tires-porcelain-sign-302349?origin=featured_automobilia").kind === "automobilia");

// Full card adaptation.
const soldCard = adaptLot(
  { href: "/2026-las-vegas/docket/vehicle/1962-chevrolet-corvette-custom-convertible-299449?origin=featured",
    cardText: "1962 CHEVROLET CORVETTE CUSTOM CONVERTIBLE\nSOLD\n$143,500" },
  DATE, { event: "2026-las-vegas" });

check("sold card -> sale", soldCard.kind === "sale");
check("price parsed", soldCard.record && soldCard.record.price === 143500);
check("title from slug", soldCard.record && soldCard.record.title === "1962 Chevrolet Corvette Custom Convertible");
check("source is bj", soldCard.record && soldCard.record.source === "bj");
check("lot id is the trailing numeric", soldCard.record && soldCard.record.source_lot_id === "299449");
check("url strips query", soldCard.record && soldCard.record.url === "https://www.barrett-jackson.com/2026-las-vegas/docket/vehicle/1962-chevrolet-corvette-custom-convertible-299449");

// Gates.
check("automobilia path refused",
  adaptLot({ href: "/2026-las-vegas/docket/automobilia/1955-michelin-tires-porcelain-sign-302349", cardText: "$2,750" }, DATE, {}).kind === "skip");

check("automobilia TITLE gate catches vehicle-path misfiles",
  adaptLot({ href: "/2026-las-vegas/docket/vehicle/1955-michelin-tires-porcelain-sign-302349", cardText: "$2,750" }, DATE, {}).kind === "skip");

check("no price -> refused",
  adaptLot({ href: "/2026-las-vegas/docket/vehicle/1962-chevrolet-corvette-custom-convertible-299449", cardText: "1962 CHEVROLET CORVETTE" }, DATE, {}).kind === "skip");

check("$1 charity sentinel -> refused",
  adaptLot({ href: "/2026-las-vegas/docket/vehicle/2024-ford-mustang-charity-302000", cardText: "SOLD\n$1" }, DATE, {}).kind === "skip");

check("no date -> REFUSED (never a hollow row)",
  adaptLot({ href: "/2026-las-vegas/docket/vehicle/1962-chevrolet-corvette-custom-convertible-299449", cardText: "$143,500" }, null, {}).kind === "skip");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
