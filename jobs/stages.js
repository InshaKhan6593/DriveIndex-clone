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
  // Detail-page enrichment for BaT (mileage/VIN/transmission/color — see that file's header
  // for why the list API cannot supply them and why title-regex mileage is a measured trap).
  // Budget is LOTS, not time: at the paced 1.5s+ request interval, 150 lots ≈ 4 minutes, so
  // nightly runs drain the backlog incrementally without ever hammering the host.
  { name: "scrape:bat-detail", cmd: ["crawler/bat-detail.crawler.js", "150"], budget: 10 * MINUTES, optional: true },
  { name: "scrape:cab", cmd: ["crawler/cab.crawler.js"], budget: 30 * MINUTES, optional: true },
  // MECUM IS PERMISSION-GATED. Their robots.txt prose bars automated collection "without prior
  // written permission from Mecum Auctions"; the operator obtained that written permission on
  // 2026-08-18. The grant is to a NAMED PARTY, not a general finding about the site.
  //
  //   IF THAT PERMISSION LAPSES, DELETE THIS LINE. The standing 49k sales stay in the database;
  //   only collection stops. Nothing else in the pipeline depends on this stage existing.
  //
  // `auto` = discover from their sitemap, then harvest 3 events — the shape meant for a
  // scheduled run. Passing a fixed event instead would make every run re-confirm the same
  // finished event and never advance through the 131 that remain.
  { name: "scrape:mecum", cmd: ["crawler/mecum.event.crawler.js", "auto"], budget: 60 * MINUTES, optional: true },
  { name: "scrape:rms", cmd: ["crawler/rms.crawler.js", "run"], budget: 30 * MINUTES, optional: true },
  { name: "scrape:good", cmd: ["crawler/gooding.crawler.js", "run"], budget: 15 * MINUTES, optional: true },
  { name: "scrape:sms", cmd: ["crawler/sms.crawler.js"], budget: 5 * MINUTES, optional: true },
  // Both take `auto`, which advances to the next unfinished unit of work. Passing a fixed
  // event/sitemap here would make every scheduled run re-confirm the same finished unit and
  // never progress — the crawlers default that way for manual use, which is wrong for cron.
  // Broad Arrow honours a 10s crawl-delay, so its budget buys ~6 lots per minute, not per second.
  { name: "scrape:broadarrow", cmd: ["crawler/broadarrow.crawler.js", "auto"], budget: 60 * MINUTES, optional: true },
  { name: "scrape:dupont", cmd: ["crawler/dupont.crawler.js", "auto", "999"], budget: 45 * MINUTES, optional: true },
  // Bonhams was harvested by hand and never scheduled, so it stopped growing the moment nobody
  // ran it — 8.5k of its 11.3k sitemap auctions were still unvisited. The argument is an AUCTION
  // budget, not a time budget: at ~1.3s per auction (a self-imposed delay, plus extra requests
  // on the multi-page car sales) 1200 fits inside the 45 minutes below with room to spare. The
  // crawler resumes from its own state file, so each run continues where the last one stopped.
  { name: "scrape:bonhams", cmd: ["crawler/bonhams.crawler.js", "1200"], budget: 45 * MINUTES, optional: true },
  // Barrett-Jackson exposes completed 2025-2026 vehicle results through its docket API. The
  // crawler discovers the recent completed-event facet and resumes one API page at a time.
  // Access requires the authorized proxy/VPN path supplied by the GitHub Actions environment.
  { name: "scrape:bj", cmd: ["crawler/barrettjackson.crawler.js", "auto"], budget: 45 * MINUTES, optional: true },
  // MUST run before ingest: ingest stamps price_usd from this table, and a sale dated after the
  // last row in it converts to null and silently falls out of the maths. Optional because a
  // stale table still converts every historical sale correctly — only the newest days are
  // affected — so an ECB outage should not fail the run.
  { name: "fx", cmd: ["fx/fetch-ecb-rates.js"], budget: 5 * MINUTES, optional: true },
  { name: "ingest", cmd: ["ingest/ingest.js"], budget: 45 * MINUTES, optional: false },
  // Was missing entirely: listings were harvested to samples/listings/ and never loaded, so
  // every listing-dependent feature (for-sale counts, Deal Radar, liquidity) silently ran on
  // whatever had last been ingested by hand.
  { name: "ingest:listings", cmd: ["ingest/ingest-listings.js"], budget: 20 * MINUTES, optional: false },
  { name: "compute", cmd: ["jobs/nightly-compute.js"], budget: 45 * MINUTES, optional: false },
];

module.exports = { STAGES, MINUTES };
