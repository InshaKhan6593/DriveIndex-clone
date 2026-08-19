// Automobilia gate tests for the Mecum adapter — written after measuring 3,273 no-year
// memorabilia titles in the harvest, and AFTER catching this file's own first draft killing
// real cars (Plymouth Neon, Ford Model T, Designo, Sprint, 5-Speed Manual — see the
// AUTOMOBILIA_RE comment). Objects must be caught; cars must survive.
"use strict";

const { isAutomobilia } = require("./mecum-adapt");

const OBJECTS = [
  "Bidder Badge 1 To Benefit Curing Kids Cancer",
  "Bantam Midget 118 Scale Tether Car",
  "Bb Korn 118 Scale Indy Tether Car",
  "The Boyle Dayton Co Lubester Chart",
  "1930S Frigidaire Double Sided Porcelain Neon Sign",
  "1950S Ford A 1 Used Cars Double Sided Dealership Sign",
  "Ferrari 348 Tool Kit",
  "Buick Single Sided Porcelain Neon Dealer Sign",
  "Mr Debonair Lamborghini Grenade",
  "Ferrari Arno Xi Hydroplane Model By Kiade",
  "Vintage Gas Pump Restore",
  "Assortment Of Spark Plugs",
];

const CARS = [
  "1927 Ford Model T",
  "1931 Ford Model A",
  "1995 Plymouth Neon",
  "2000 Mercedes Benz Clk430 Designo",
  "1969 Amc Hornet Sprint",
  "1963 Ford Falcon Sprint",
  "1987 Porsche 911 Carrera 5 Speed Manual",
  "1969 Chevrolet Camaro Z28",
  "1965 Shelby Cobra 427",
  "2019 Porsche 911 Gt3 Rs",
  "1957 Chevrolet Bel Air Nomad",
  "1970 Dodge Charger R T",
  "1967 Corvette L88 Coupe",
  "1988 BMW M3",
  "2023 Ford Bronco Raptor",
  "1955 Mercedes Benz 300Sl Gullwing",
];

let fail = 0;
for (const t of OBJECTS) if (!isAutomobilia(t)) { console.log(`FAIL  missed object:  ${t}`); fail++; }
for (const t of CARS) if (isAutomobilia(t)) { console.log(`FAIL  killed real car: ${t}`); fail++; }
console.log(`\n${OBJECTS.length + CARS.length - fail} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
