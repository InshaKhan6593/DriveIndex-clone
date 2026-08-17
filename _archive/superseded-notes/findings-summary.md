# Pipeline findings — session summary, 2026-08-14

## How the pipeline handles new/changing data going forward

Four layers, each catching a different failure mode. "New data" breaks a scraper in three
distinct ways, and no single check catches all three:

1. **Routine new listings (the normal case)** — handled by the `(source, source_lot_id)`
   unique key (`dedup/dedup.js` → `upsertKey`). Re-running a crawler is always a safe no-op
   upsert; a genuinely new listing just gets a new row. No special handling needed, this is
   the default behavior.

2. **One record is malformed** (a date that doesn't parse, a negative price, a VIN-shaped
   string that's too short) — `validation/validate-record.js`. Runs on every record, every
   scrape. Rejects individually, doesn't touch the rest of the batch.

3. **The site changed and a selector now silently returns null for everyone** — the failure
   mode per-record validation CANNOT catch, because a null field is often individually legal
   (plenty of real cars have no listed VIN). `validation/drift-detector.js` tracks
   field-population RATE per source against a saved baseline and flags any field whose
   population drops more than 35 percentage points between runs. Proven against a real
   scenario in `validation/health-check.demo.js`: it re-creates the actual Cars & Bids
   selector break this session hit for real (§ below) and catches it — VIN/mileage/
   transmission all correctly flagged as "likely a broken selector, not a real data change."
   Every crawler now calls this automatically after scraping and sets a non-zero exit code
   on `NEEDS_REVIEW`, so a CI/cron wrapper can refuse to feed a broken batch into the nightly
   compute job (build spec §6) without a human looking at it first.

4. **NOT YET BUILT: title → car_id entity resolution** (build spec §4.5) — a genuinely new
   nameplate we've never seen (or a higher-spec variant that shouldn't be absorbed into a base
   model) needs a review queue, not a silent guess. Today's adapters produce normalized sale
   records tied to a source; they don't yet resolve to a catalogue `car_id`. This is the next
   layer to build, not something the current health check covers — flagging the gap rather
   than implying it's handled.

Baselines live in `validation/baselines/{source}.json`, one file per source, auto-created on
first run. They are NOT auto-updated on every run by design — `checkDrift()` only overwrites
a baseline when explicitly called with `updateBaseline: true`, so a slow, silent break can't
quietly redefine "normal" one run at a time and disarm the detector. Re-baselining after a
confirmed legitimate site change (not a break) is a deliberate, human-triggered action.

Caveat: baselines here were established from batches of 4-5 records (this session's sample
size). The 35-point drift threshold is tuned for that — a real production baseline should use
50-100+ records so run-to-run sampling noise doesn't false-positive.

## What's real vs. what's synthetic in this workspace

- `samples/raw/cars-and-bids-1.json` — **real**, live-captured from a Cars & Bids sold listing.
- `samples/raw/rm-sothebys-1.json` — **real**, live-captured from RM Sotheby's Monterey 2025 results index (list-level fields only; no detail-page VIN/mileage yet).
- `dedup/dedup.demo.js` — the aggregator-republish and unrelated-car records inside it are **synthetic fixtures**, built by hand to exercise the scorer. Everything else in that file (the real C&B record, the scorer itself) is real/from-spec.

## Bug found and fixed: the build-spec's own dedup formula has a blind spot

The reverse-engineered DriveIndex spec documents a cross-source duplicate scorer with price-closeness
bands at <0.5% and <2%. Its own prose warns that buyer's premium typically creates a 5–12% gap
between a hammer price and an all-in republished price — but the formula never actually covers
that range.

Tested it against the one real sale we have (Cars & Bids, $170,000) with a synthetic same-car
republish at $164,900 (3% under, VIN dropped — both realistic for an aggregator): **the documented
formula scored it 0.479**, well under the 0.75 collapse threshold. It would have shipped as two
separate sales, double-counting one physical car.

Fix applied in `dedup/dedup.js` (see inline comment): added a third band, 2%–13% gap → +0.30,
covering the actual buyer's-premium range. Re-ran the same test: **0.779, correctly collapses.**
The unrelated-car control case still correctly scores 0.000. This is a real, tested correction,
not a guess — rerun `node dedup/dedup.demo.js` any time to re-verify both cases.

## Per-source data quality, as observed

| Source | Fields confirmed available | Fields NOT yet confirmed | Currency |
|---|---|---|---|
| **Cars & Bids** | title, price, sold date+time, make/model/generation, engine, drivetrain, mileage, transmission, **VIN**, body style, title status, exterior/interior color, location, seller name+type, bid count, views, watchers, full equipment/options list, modifications, known flaws, Carfax summary | multi-currency case (US-only site, so N/A) | USD only |
| **RM Sotheby's** | lot number, title, sold status (Sold/Not Sold), hammer price OR pre-sale estimate range, collection grouping | VIN/chassis number, mileage, color, transmission — these are on the per-lot detail page, not the results list; need one more capture pass | USD confirmed for Monterey; Zürich/London/Munich auctions will be non-USD, untested |
| Bonhams, Mecum, Classic.com | not yet sampled this session | — | — |
| Bring a Trailer | **blocked** — this session's browser policy would not load bringatrailer.com at all. No fields confirmed hands-on. | everything | — |

## The reserve-not-met signal looks different per source — adapters must special-case it

- **Cars & Bids**: result line reads `"Sold for $X"` vs (inferred, not yet observed directly) something like `"Bid to $X, Reserve Not Met"`.
- **RM Sotheby's**: confirmed directly — a `"Not Sold"` tag replaces `"Sold"`, and the price field is replaced by a **pre-sale estimate range** (e.g. `$300,000 - $400,000 USD`) instead of a single number. An adapter that naively regexes for `$[\d,]+` and takes the first match will wrongly ingest the low end of an estimate range as if it were a real sale price — this is exactly the kind of bug the build spec's `reserve_not_met` flag exists to prevent. `adapters/rm-sothebys.js` already guards this (`parsePriceField` returns `null` unless `result === "Sold"`).

## What's still open

1. Bonhams, Mecum, Classic.com samples — not pulled yet.
2. RM Sotheby's detail-page fields (VIN/chassis, mileage, color, transmission) — need one lot detail page captured to complete that adapter.
3. Bring a Trailer — blocked in-session; no tooling gap gets around the compliance question, see `data-sourcing-strategy.md`.
4. No Crawlee project scaffolded yet — everything here ran through manual browser capture + hand-written adapters. Next real step is wiring an actual crawler so this stops being manual.
