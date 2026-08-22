// RECENT AUCTION BACKFILL — run the permitted, accessible sources one at a time.
//
// This is deliberately sequential. Each crawler owns a harvest file and a resume marker, but
// running two copies of the same source (or two sources that share a browser/IP budget) makes
// rate limits and partial files harder to diagnose. The command is for an intentional 2025-2026
// backfill; the daily workflow should keep using jobs/cron.js in its smaller recent window.
//
// Usage:
//   node jobs/recent-backfill.js
//   node jobs/recent-backfill.js --sources=mecum,sms
//   node jobs/recent-backfill.js --sources=all --recent-days=730

"use strict";

const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DEFAULT_SOURCES = ["mecum", "sms", "rms", "gooding", "bonhams", "broadarrow"];
const VALID = new Set(["mecum", "sms", "rms", "gooding", "bonhams", "broadarrow", "bj"]);

function option(name, fallback) {
  const value = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return value ? value.slice(name.length + 3) : fallback;
}

const rawSources = option("sources", DEFAULT_SOURCES.join(","));
const sources = rawSources === "all"
  ? DEFAULT_SOURCES
  : rawSources.split(",").map((source) => source.trim()).filter(Boolean);
const unknown = sources.filter((source) => !VALID.has(source));
if (unknown.length) throw new Error(`unknown source(s): ${unknown.join(", ")}`);

const recentDays = Number(option("recent-days", process.env.SCRAPE_RECENT_DAYS || 730));
if (!Number.isFinite(recentDays) || recentDays <= 0) throw new Error("--recent-days must be positive");

const baseEnv = {
  ...process.env,
  SCRAPE_MODE: "recent",
  SCRAPE_RECENT_DAYS: String(recentDays),
  DELAY_MS: process.env.DELAY_MS || "1500",
};

function run(label, args, extraEnv = {}) {
  console.log(`\n===== ${label} =====`);
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    env: { ...baseEnv, ...extraEnv },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} exited with status ${result.status}`);
}

for (const source of sources) {
  if (source === "mecum") {
    run("mecum discovery", ["crawler/mecum.event.crawler.js", "discover"], {
      MECUM_CURRENT_YEAR: process.env.MECUM_CURRENT_YEAR || String(new Date().getUTCFullYear()),
    });
    run("mecum recent events", ["crawler/mecum.event.crawler.js", "run", process.env.MECUM_RECENT_EVENTS || "6"]);
  } else if (source === "sms") {
    run("sotheby's motorsport", ["crawler/sms.crawler.js"], { SMS_PAGE_SIZE: process.env.SMS_PAGE_SIZE || "100" });
  } else if (source === "rms") {
    run("rm sotheby's", ["crawler/rms.crawler.js", "run"], {
      RMS_RECENT_DISCOVERY_PAGES: process.env.RMS_RECENT_DISCOVERY_PAGES || "50",
    });
  } else if (source === "gooding") {
    run("gooding", ["crawler/gooding.crawler.js", "run"]);
  } else if (source === "bonhams") {
    run("bonhams", ["crawler/bonhams.crawler.js", process.env.BONHAMS_BUDGET || "400"], {
      BONHAMS_RECENT_AUCTIONS: process.env.BONHAMS_RECENT_AUCTIONS || "400",
    });
  } else if (source === "broadarrow") {
    run("broad arrow", ["crawler/broadarrow.crawler.js", "auto"]);
  } else if (source === "bj") {
    if (!process.env.CRAWLER_PROXY_URL) {
      throw new Error("Barrett-Jackson requires CRAWLER_PROXY_URL for its authorized access path");
    }
    run("barrett-jackson", ["crawler/barrettjackson.crawler.js", "auto"]);
  }
}

console.log(`\nCompleted recent backfill for: ${sources.join(", ")} (${recentDays} days)`);
