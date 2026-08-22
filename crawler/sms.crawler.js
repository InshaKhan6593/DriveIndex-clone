// SOTHEBY'S MOTORSPORT (SOMO) HARVESTER.
//
// The results page is server-rendered with the first page embedded in __NEXT_DATA__, but the
// page's own client bundle calls the public same-origin endpoint below for every subsequent
// page. The old crawler stopped at the embedded first 15 records. That was a page-discovery
// limitation, not an access limitation: the endpoint accepts page + limit and currently exposes
// the complete sold archive without authentication.
//
// RECENT mode walks newest-first until the sold date is older than SCRAPE_RECENT_DAYS. FULL mode
// walks every API page. Records are still keyed by (source, source_lot_id), so the first repaired
// run expands the old 30-record sample without duplicating its existing oldest/newest rows.
//
// Usage: node crawler/sms.crawler.js
//        SCRAPE_MODE=full node crawler/sms.crawler.js
"use strict";

const fs = require("fs");
const path = require("path");
const { adaptAuction } = require("./sms-adapt");
const { BACKFILL_MODE, from, inWindow } = require("../jobs/backfill-window");

const UA = "Mozilla/5.0 (compatible; price-index-research/1.0)";
const API = "https://www.sothebysmotorsport.com/api/auctions/listings";
const SORT = "closed_date_desc";
const PAGE_SIZE = Math.min(100, Math.max(1, Number(process.env.SMS_PAGE_SIZE) || 100));
const FULL_MODE = process.env.SCRAPE_MODE === "full" || process.argv.includes("--full") || process.argv[2] === "full";
const RECENT_MODE = !FULL_MODE && !BACKFILL_MODE;
const RECENT_DAYS = Math.max(1, Number(process.env.SCRAPE_RECENT_DAYS) || 45);
const DELAY_MS = Number(process.env.DELAY_MS) || 1200;

const OUT = path.join(__dirname, "..", "samples", "scraped", "sms.json");

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function apiUrl(page, limit = PAGE_SIZE) {
  const params = new URLSearchParams({ page: String(page), limit: String(limit), type: "sold", sort: SORT });
  return `${API}?${params}`;
}

function soldTime(record) {
  const time = Date.parse(record?.soldDate || "");
  return Number.isFinite(time) ? time : null;
}

function pageIsOlderThan(pageRows, cutoff) {
  return pageRows.length > 0 && pageRows.every((row) => {
    const time = soldTime(row);
    return time != null && time < cutoff;
  });
}

async function fetchPage(page) {
  const res = await fetch(apiUrl(page), {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(30000),
  });
  if (res.status !== 200) return { http: res.status, auctions: [], pagination: null };

  let data;
  try { data = await res.json(); } catch { return { http: 200, auctions: [], pagination: null, reason: "bad json" }; }
  const payload = data?.data || data;
  if (!Array.isArray(payload?.auctions) || !payload?.pagination) {
    return { http: 200, auctions: [], pagination: null, reason: "unexpected API shape" };
  }
  return { http: 200, auctions: payload.auctions, pagination: payload.pagination };
}

async function run() {
  const sales = new Map(loadJson(OUT, []).map((r) => [`${r.source}|${r.source_lot_id}`, r]));
  const startCount = sales.size;
  const cutoff = Date.now() - RECENT_DAYS * 86400000;
  const backfillCutoff = from.getTime();

  let totalKnown = null;
  let pageCount = Infinity;
  let pagesFetched = 0;
  let added = 0;
  let skipped = 0;
  let olderRows = 0;
  let failures = 0;

  console.log(`resuming: ${startCount} sales on file`);
  console.log(`SOMO API mode=${RECENT_MODE ? "recent" : BACKFILL_MODE ? "backfill" : "full"} pageSize=${PAGE_SIZE} sort=${SORT}`);
  if (RECENT_MODE) console.log(`recent cutoff=${new Date(cutoff).toISOString().slice(0, 10)}`);
  if (BACKFILL_MODE) console.log(`backfill window=${from.toISOString().slice(0, 10)}..${process.env.SCRAPE_TO_DATE || "configured"}`);

  for (let page = 1; page <= pageCount; page++) {
    const r = await fetchPage(page);
    if (r.http !== 200 || !r.pagination) {
      failures++;
      console.log(`FAIL  page=${page} http=${r.http} ${r.reason || ""}`);
      break;
    }

    pagesFetched++;
    totalKnown = Number(r.pagination.totalCount) || totalKnown;
    pageCount = Number(r.pagination.pageCount) || page;
    let pageAdded = 0;
    let pageAccepted = 0;
    let pageSkipped = 0;

    for (const auction of r.auctions) {
      if (RECENT_MODE && soldTime(auction) != null && soldTime(auction) < cutoff) {
        olderRows++;
        continue;
      }
      if (BACKFILL_MODE && soldTime(auction) != null && !inWindow(auction.soldDate)) {
        olderRows++;
        continue;
      }

      const out = adaptAuction(auction);
      if (out.kind === "sale") {
        const k = `${out.record.source}|${out.record.source_lot_id}`;
        if (!sales.has(k)) { added++; pageAdded++; }
        sales.set(k, out.record);
        pageAccepted++;
      } else {
        skipped++;
        pageSkipped++;
      }
    }

    console.log(
      `page=${page}/${pageCount} fetched=${r.auctions.length} accepted=${pageAccepted} ` +
      `new=${pageAdded} skipped=${pageSkipped}`
    );

    if (RECENT_MODE && pageIsOlderThan(r.auctions, cutoff)) break;
    if (BACKFILL_MODE && pageIsOlderThan(r.auctions, backfillCutoff)) break;
    if (page >= pageCount || r.auctions.length < PAGE_SIZE) break;
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify([...sales.values()], null, 1));

  console.log(`\n${sales.size} sales (+${added} this run), ${skipped} skipped, ${olderRows} outside recent window`);
  if (totalKnown != null) {
    console.log(
      `SOMO reports ${totalKnown} total sold lots; fetched ${pagesFetched} API page(s)` +
      `${RECENT_MODE ? ` for the last ${RECENT_DAYS} days` : BACKFILL_MODE ? ` for ${from.toISOString().slice(0, 10)}..${process.env.SCRAPE_TO_DATE || "configured"}` : " for the full archive"}`
    );
  }
  console.log(`Wrote ${OUT}`);
  if (failures) process.exitCode = 1;
}

if (require.main === module) run();

module.exports = { apiUrl, pageIsOlderThan, soldTime };
