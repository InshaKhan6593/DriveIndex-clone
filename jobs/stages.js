// The pipeline definition, extracted so it has exactly ONE definition.
//
// It cannot live in jobs/cron.js: that file runs the whole pipeline at module level and ends
// with process.exit(), so `require("./cron")` from anywhere — the API, a test — would execute a
// full scrape/ingest/compute and then kill the calling process. Anything that needs to KNOW the
// stages without RUNNING them imports this instead.
"use strict";

const MINUTES = 60 * 1000;

const STAGES = [
  { name: "scrape:bat", cmd: ["crawler/bat-partitioned.crawler.js", "run"], budget: 90 * MINUTES, env: { DELAY_MS: "2500" }, optional: true },
  { name: "scrape:cab", cmd: ["crawler/cab.crawler.js"], budget: 30 * MINUTES, optional: true },
  { name: "scrape:rms", cmd: ["crawler/rms.crawler.js", "run"], budget: 30 * MINUTES, optional: true },
  { name: "scrape:good", cmd: ["crawler/gooding.crawler.js", "run"], budget: 15 * MINUTES, optional: true },
  { name: "scrape:sms", cmd: ["crawler/sms.crawler.js"], budget: 5 * MINUTES, optional: true },
  // Both take `auto`, which advances to the next unfinished unit of work. Passing a fixed
  // event/sitemap here would make every scheduled run re-confirm the same finished unit and
  // never progress — the crawlers default that way for manual use, which is wrong for cron.
  // Broad Arrow honours a 10s crawl-delay, so its budget buys ~6 lots per minute, not per second.
  { name: "scrape:broadarrow", cmd: ["crawler/broadarrow.crawler.js", "auto"], budget: 60 * MINUTES, optional: true },
  { name: "scrape:dupont", cmd: ["crawler/dupont.crawler.js", "auto", "999"], budget: 45 * MINUTES, optional: true },
  { name: "ingest", cmd: ["ingest/ingest.js"], budget: 45 * MINUTES, optional: false },
  // Was missing entirely: listings were harvested to samples/listings/ and never loaded, so
  // every listing-dependent feature (for-sale counts, Deal Radar, liquidity) silently ran on
  // whatever had last been ingested by hand.
  { name: "ingest:listings", cmd: ["ingest/ingest-listings.js"], budget: 20 * MINUTES, optional: false },
  { name: "compute", cmd: ["jobs/nightly-compute.js"], budget: 45 * MINUTES, optional: false },
];

module.exports = { STAGES, MINUTES };
