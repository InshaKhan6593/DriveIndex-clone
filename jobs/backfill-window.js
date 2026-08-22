// Shared date window for the opt-in historical backfill mode.
// Normal recent/full runs do not import this helper's decision functions, so their behavior
// remains unchanged.
"use strict";

const MODE = String(process.env.SCRAPE_MODE || "recent").toLowerCase();
const BACKFILL_MODE = MODE === "backfill";

function dateOnly(value, endOfDay = false) {
  const text = String(value || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const suffix = endOfDay ? "T23:59:59.999Z" : "T00:00:00.000Z";
  const date = new Date(`${text}${suffix}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

const from = dateOnly(process.env.SCRAPE_FROM_DATE) || new Date("2024-01-01T00:00:00.000Z");
const to = dateOnly(process.env.SCRAPE_TO_DATE, true) || new Date("2026-08-22T23:59:59.999Z");

function inWindow(value) {
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date >= from && date <= to;
}

function yearInWindow(value) {
  const year = Number(String(value).match(/(?:19|20)\d{2}/)?.[0]);
  return Number.isFinite(year) && year >= from.getUTCFullYear() && year <= to.getUTCFullYear();
}

module.exports = { MODE, BACKFILL_MODE, from, to, inWindow, yearInWindow };
