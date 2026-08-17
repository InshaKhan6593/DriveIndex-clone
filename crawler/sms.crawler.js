// SOTHEBY'S MOTORSPORT (SOMO) HARVESTER.
//
// ── HONEST LIMITATION, STATED UP FRONT ─────────────────────────────────────────────────
// This source is fundamentally different from every other one in this pipeline: the results
// feed (`/listings/sold/filter:sort={X}`) reports 729 total sold lots, but ONLY EVER RENDERS
// THE FIRST 15 for an unauthenticated request — no offset/page/make/year/model query param
// tried moved the window (all silently ignored; `page` as a filter key is the one exception,
// which errors out rather than being ignored). The client-side "load more" observed in a real
// browser session re-requested the SAME first page rather than advancing it, which is
// consistent with pagination being gated behind a logged-in session — and logging in is out of
// scope (see repo-wide policy: never create accounts / authenticate on the user's behalf).
//
// The one lever that DOES work is `sort`: `closed_date_desc` and `closed_date_asc` each surface
// a different 15-item window (newest 15 / oldest 15 sold lots), with zero overlap confirmed on
// real data. So the harvest here is TWO fetches, ~30 unique real records out of 729 — a real,
// correct, but deliberately small slice. Labeled PARTIAL rather than pretended complete, same
// honesty convention BaT's partition labels use for the windows it can't fully reach.
//
// Usage: node crawler/sms.crawler.js run
"use strict";

const fs = require("fs");
const path = require("path");
const { adaptAuction } = require("./sms-adapt");

const UA = "Mozilla/5.0 (compatible; price-index-research/1.0)";
const SORTS = ["closed_date_desc", "closed_date_asc"];
const URL_FOR = (sort) => `https://www.sothebysmotorsport.com/listings/sold/filter:sort=${sort}`;

const OUT = path.join(__dirname, "..", "samples", "scraped", "sms.json");

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

async function fetchWindow(sort) {
  const res = await fetch(URL_FOR(sort), { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30000) });
  if (res.status !== 200) return { http: res.status, auctions: [], totalCount: null };
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return { http: 200, auctions: [], totalCount: null, reason: "no __NEXT_DATA__" };
  let data;
  try { data = JSON.parse(m[1]); } catch { return { http: 200, auctions: [], totalCount: null, reason: "bad json" }; }
  const pp = data?.props?.pageProps || {};
  return { http: 200, auctions: pp.auctions || [], totalCount: pp.pagination ? pp.pagination.totalCount : null };
}

async function run() {
  const sales = new Map(loadJson(OUT, []).map((r) => [`${r.source}|${r.source_lot_id}`, r]));
  const startCount = sales.size;

  let totalKnown = null, added = 0, skipped = 0;
  for (const sort of SORTS) {
    const r = await fetchWindow(sort);
    if (r.http !== 200) { console.log(`FAIL  sort=${sort} http=${r.http} ${r.reason || ""}`); continue; }
    totalKnown = r.totalCount;
    let windowAdded = 0;
    for (const a of r.auctions) {
      const out = adaptAuction(a);
      if (out.kind === "sale") {
        const k = `${out.record.source}|${out.record.source_lot_id}`;
        if (!sales.has(k)) { added++; windowAdded++; }
        sales.set(k, out.record);
      } else {
        skipped++;
      }
    }
    console.log(`sort=${sort.padEnd(17)} fetched=${r.auctions.length} new=${windowAdded}`);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify([...sales.values()], null, 1));

  console.log(`\n${sales.size} sales (+${added} this run), ${skipped} skipped`);
  if (totalKnown != null) {
    console.log(`SOMO reports ${totalKnown} total sold lots archive-wide — this harvest reaches only the newest/oldest ${sales.size} of them (anonymous-access ceiling, see file header)`);
  }
  console.log(`Wrote ${OUT}`);
}

run();
