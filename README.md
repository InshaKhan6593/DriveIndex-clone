# DriveIndex-equivalent price index — pipeline

A collector-car price index built from auction results: scrape 13 auction houses, resolve every
sale to a specific car, and compute valuations and buy/sell signals.

Built as a feature-equivalent rebuild of **driveindex.com**, working from
`research/DRIVEINDEX-GROUND-TRUTH.md` — an extraction of their shipped JavaScript, live API
responses and rendered pages, where every claim carries an evidence class (`[V]` verified,
`[M]` measured, `[I]` inferred, `[U]` unknown).

> ⚠️ **That research file is not in this repository.** It is cited by section number throughout
> the code and these notes (`§4.5`, `§7.2`, …) and those citations were accurate when written,
> but the document itself was never committed — so the `[V]`/`[M]` evidence classes cannot
> currently be re-checked against their source. Anything marked verbatim-verified should be
> treated as unverifiable until it is restored.

---

## Where it stands

| | ours | DriveIndex |
|---|---|---|
| sales | **209,928** | 110,043 |
| **listings (for-sale now)** | **4,975** (4,958 active) | ~35,309 |
| cars | 55,934 | 7,148 (model+generation ranges) |
| **sales per car** | **3.82** | — |
| cars with repeat sales | 22,495 | — |
| distinct makes | 357 | 84 |
| date range | 2014-07-30 → 2026-08-16 | — |
| review queue | 27,238 (13.0%) | none — they ingest everything |

Sources with **sales** — **8 of 13**, and the top 4 are DriveIndex's #1–#4, carrying **~90% of
their measured source mix**:

| source | sales | their mix |
|---|---|---|
| Bring a Trailer | 162,012 | 72.2% |
| Cars & Bids | 35,609 | 5.5% |
| Mecum | 7,300 | 6.4% |
| RM Sotheby's | 2,676 | 6.2% |
| Gooding & Company | 2,030 | not in their mix (they don't carry it) |
| Broad Arrow | 252 | not in their mix |
| Sotheby's Motorsport | 25 (partial — see below) | not in their mix |
| Bonhams | 24 (sample) | 3.4% |

Sources with **listings** — asking-price inventory, a separate table from `sale` and never
mixed into it:

| source | listings | what they are |
|---|---|---|
| DuPont Registry | 4,786 | dealer/private asking prices (no auction) |
| Broad Arrow | 172 | upcoming-auction consignments, price = estimate midpoint |
| RM Sotheby's | 17 | upcoming consignments |

**Verified at this scale:** 0 hard splits · 0 duplicate lot keys · 0 same-physical-car
cross-source duplicates · 0 duplicate car identities · 0 NULL-attribute splits ·
`validation/cron-safety.test.js` converges to **exact +0** across 3 consecutive re-ingest
passes · **236+ tests passing**.

**A note on that convergence number, for anyone re-running this:** it briefly looked broken at
this scale — a 3-pass re-ingest test was still adding thousands of sales on every pass instead
of settling. Root cause was two independent, real things, not one bug:

1. `data/cron.lock` had a stale entry from a `jobs/cron.js` run that started 2026-08-16 18:30 and
   died (process no longer exists) without releasing its lock, apparently mid-way through a large
   BaT scrape (`bat-partitioned.json` had grown to 196,609 records). Every re-ingest pass during
   this session was catching up a real, growing backlog that dead run never got to ingest itself
   — not re-processing a static file three times. Once fully drained, convergence was immediate
   and exact.
2. Separately, three real bugs were letting good cars get silently discarded or fragmented (see
   "Bugs found and fixed" below) — fixing them made previously-rejected records newly resolvable,
   which also shows up as "growth" on a re-ingest but is a one-time recovery, not non-convergence.

## Bugs found and fixed while clearing the review queue at volume (2026-08-17)

- **Two structural reject rules were discarding real cars.** `"Formula WS6"` (a genuine Pontiac
  Firebird trim) and `"Formula S"` (a genuine Plymouth Barracuda trim) were being rejected as
  open-wheel race cars; `"Quad Webers"` / `"Dual Quad"` (four-barrel carburetor setups) were
  being rejected as ATVs. 49 + 6 real cars recovered.
- **A much bigger one: 6,003 records were hard-rejected** for leading with a displacement
  ("396-Powered 1967 Chevelle Malibu") on the assumption that meant an engine swap — but that's
  completely normal BaT/Mecum phrasing for bone-stock factory cars (396 and 440 were both real
  factory options on those exact models). Telling stock from swapped needs a build sheet, not a
  text shape, so this is now a REVIEW verdict instead of an automatic REJECT.
- **A make-casing bug fragmented real cars across catalogue entries.** The positional make-
  inference code only ever uppercased letters, never lowercased them, so an all-caps title
  ("1949 REO Speed Wagon") and a normally-cased one ("1949 Reo Speed Wagon") for the *same real
  car* produced two different `make` strings — a silent catalogue split the UNIQUE constraint
  can't catch because the strings are genuinely different. Fixed the normalization and cleaned up
  4 pre-existing casing families (REO/Reo, MGA/Mga, ERA/Era, AM/Am) it had already caused.
- Added ~70 confirmed real historic marques to the curated list (including LaSalle and
  Steyr-Puch, which earlier research in this project had verified but never actually wired into
  the code) and ~15 confirmed motorcycle/moped marques — cutting the pending queue from 21,169 to
  a base that, combined with the fixes above, nets out at 26,722 after also absorbing a much
  larger corpus (see the source counts above).

---

## Engine defects found by audit and fixed (2026-08-17)

An audit of the valuation logic — not the data — found three defects producing **visibly false
output**. All three are fixed and the whole catalogue recomputed.

**1. The regression had no minimum time-span guard.** `classifySignal()` gated on sale *count*
(`n >= 3`) but never on the *time* those sales spanned. Four sales in one week satisfied the
count gate, and their slope — fitted per year — was extrapolated ~50x. Worst real case: a 2013
Ford E-350 van whose four sales spanned **7 days** was published as

```
+2,655,925,070,192,485 %/yr · Appreciating · "Buy Now (Rising Fast)"
```

The dollar forecasts looked sane the whole time, because `forecast.js` clamps by
collectibility — so only the *rate* and the *buy/sell call* were garbage, which is exactly the
part a user acts on. Threshold chosen from measured data rather than guessed:

| clean-sale span | share with \|annualReturn\| > 100% |
|---|---|
| < 30 days | 40% |
| 30–90 days | 37% |
| 90–180 days | 21% |
| 180–365 days | 8% |
| 2 years+ | ~0% |

Now gated at **180 days minimum span** (at most a 2x extrapolation to make an annual claim) plus
an independent **±200%/yr plausibility bound**. Both report `insufficient` rather than silently
clamping — a clamped number reads as a real measurement. Result: readings above 1000%/yr went
**21 → 0**, above 1,000,000%/yr **2 → 0**, max reading now 197.8%. Cost: directional signals
11,347 → 11,068, i.e. **2.5% less coverage to remove every absurd reading**.

**2. Reserve-not-met bids were served and displayed as completed sales.** The engine correctly
excluded them from the maths, but `serializeSale()` never exposed `status`, so the client had no
way to tell them apart. One Porsche detail page listed 20 "sales" of which **6 were
`reserve_not_met`** — and the price-history chart was drawing a trend line through sales that
never happened. `status` is now part of the sale payload; the table labels and de-emphasises
bids, the "Sold (N)" count excludes them, and the chart plots transactions only.

**3. `nightly-compute.js` passed a hardcoded `0` for listings.** So `listings_count` was 0 on
**all 54,818 valuation rows** and `computeLiquidity()` had never once seen real supply —
months-of-supply and every liquidity verdict were derived from an assumed-empty market. It also
inner-joined `sale`, so **1,008 cars with live listings but no sales got no valuation row at
all** (their pages rendered blank). Both fixed: `listings_count` now sums to 4,958, exactly
matching active listings with a resolved car, and 0 cars are missing a row.

### Known-wrong, not yet fixed

Found by the same audit, lower severity — none produce visibly false claims, but they quietly
distort numbers:

- **The mileage anchor is unreliable.** `avgMileage` normalises every price, but of 300 sampled
  cars with ≥10 sales, **136 (45%) have zero clean sales reporting mileage** and fall back to a
  hardcoded 50,000; another 64 anchor the entire model's curve on 1–2 reported values.
- **Recency weighting flattens.** `Math.max(1, round(w*10))` means everything **≥3 years old is
  weighted identically** — a 4-year-old sale counts the same as a 30-year-old one.
- **`volatilityOf()` is fed raw prices** while its own docstring says mileage-normalised, so
  confidence is penalised for mileage spread it was meant to have removed.
- **The collectibility bootstrap uses dirty data** — `bootstrapValue` averages *all* sales
  including reserve-not-met and damaged, and that score then steers outlier detection and the
  mileage curve.
- **Outlier detection is time-blind.** MAD compares each sale to the median with no time
  weighting, so a genuine market re-rating is indistinguishable from noise. Observed: a 1997
  911 Carrera 4 whose three most recent sales ($113k/$158k/$179k) were all excluded as outliers,
  leaving the value pinned at $62,886.

---

## The core problem

**No source gives structured data.** Checked across every source we scrape:

| source | structured make/model/year/body? |
|---|---|
| Bring a Trailer | none — all in the title |
| Cars & Bids | none — all in the title |
| RM Sotheby's | none — all in the title |
| Bonhams | none — all in the title |
| Mecum | partial (`declared_make`, `declared_model` — seller-entered free text) |

Everything arrives as one sentence written for a human buyer:

```
"34K-Mile 1987 Porsche 911 Carrera Cabriolet G50"
"1987 Porsche 911 G50 Cabriolet"          <- the same car, typed differently
```

Turning that into a price index *is* the work. Every design decision below follows from it.

---

## How identity works

```
UNIQUE (year, make, model_key, body_type, generation, modification, displacement)
```

Three strings do three different jobs, and conflating them is what breaks DriveIndex's
catalogue:

| field | job | example |
|---|---|---|
| `model_key` | identity — **never displayed** | `"2000 gtv"` (token-sorted) |
| `model` | display, original word order | `"GTV 2000"` |
| `body_type` etc. | structure, own columns | `Coupe`, `2.8L`, `Restomod` |

Deliberately **not** in the key: **transmission**. A 240Z and a 240Z Automatic are one car with
an option, so it lives on the sale.

### Three-way outcome, never a silent guess

```
exact identity match            -> ATTACH   (just another sale)
one compatible car              -> ATTACH + enrich the row with what was learned
several compatible candidates   -> REVIEW   (a coin flip is not a decision)
nothing similar                 -> CREATE
```

The catalogue is **fully derived** — no seed data, no `INSERT INTO car` in the schema, no
model list to maintain. All 47,426 cars were created from titles.

---

## Patterns handled automatically

Each is a *shape*, brand-independent, and holds for sources not yet added. All were found by
measuring real failures, and each has a regression test.

| pattern | rule | why |
|---|---|---|
| word-order variants | model key is token-**sorted** | their catalogue has 163 near-duplicate pairs from this alone |
| HTML entities | decode named/decimal/hex before parsing | `4&#215;4` was becoming model token `42154`; 1,046 titles affected |
| typography | fold `× ' " – —` to ASCII | `4×4` and `4x4` must be one car |
| diacritics | NFD-fold for LOOKUP, keep accented display | `Citroën` never matched alias `citroen` — every one went to review |
| hyphens in codes | strip when a fragment is ≤2 chars or has a digit | `corvette l-82` and `corvette l82` were two 1978 Corvettes |
| engine configs | `V8`, `I6`, `flat-6` are never model designators | a shared "V8" made an F-250 look like a Mustang |
| shared numbers vs names | disagreeing alphabetic names ⇒ different cars | `327 camaro` vs `327 corvette` — 327 is an engine size |
| unknown intrinsic attrs | blank `body_type`/`generation`/`displacement` = UNKNOWN, acts as wildcard | 209 pairs were one car split on whether a seller typed "Coupe" |
| asserted attrs | blank `modification` = STOCK, keeps separating | a race-prepped M3 is genuinely not a stock M3 |
| component head-noun | title ENDING in wheels/seats/manifold ⇒ reject | a wheel set became a $4,877 "1987 Porsche 911" |
| positional make | word after the year is a CANDIDATE make | unlocked pre-war marques: Mercer, Hispano-Suiza, Delahaye |
| provenance by id shape | slug-shaped BaT lot id ⇒ DOM harvest ⇒ reject | that harvester fabricated title↔URL pairs 58.6% of the time |

### The one place lists are used

`MOTORCYCLE_MAKES` (74), `BODY_STYLES` (36), `VARIANT_TOKENS` (123), component nouns.

These are **bounded classes that do not grow with the corpus**. No pattern separates
*"1974 Moto Guzzi 850"* from *"1974 Maserati Bora"* — both are `{year} {Name} {Model}`.
`MAKE_ALIASES` (196) is a fast path only: we hold 252 makes, so 56 arrived through inference
and earned acceptance from evidence.

---

## The evidence layer

An unfamiliar make is not rejected — it must **earn** acceptance:

```
>= 8 sightings, across >= 4 model years, across >= 2 distinct models
```

Diversity rather than repetition, because a mis-parse repeats one frozen string while a real
marque spreads out. Batch evidence counts alongside accepted history — without that the system
deadlocks, since a make needs sightings to be accepted and acceptance to get sightings.

An inferred make can never take the curated fast path.

---

## The review queue

The pipeline's honest "I don't know", triaged by the **shape of the decision** rather than by
regex over its prose (the first version mis-sorted 11,837 items that way):

| class | count | what it is |
|---|---|---|
| `UNPROVEN_MODEL` | 12,154 | known make, unproven tokens — usually self-resolves on volume |
| `UNKNOWN_MAKE` | 1,990 | **lookup**: is this token a car marque? One answer covers every listing |
| `UNPARSEABLE` | 1,046 | doesn't fit `{year} {make} {model}` |
| `SAME_CAR?` | 0 | genuine merge/split judgement |

Rejections are **recorded, not discarded** — 15,086 structural, 3,584 out-of-scope, 2,432
standing decisions, each with a reason and the full record retained so any can be overturned.

**Standing rule: bad data is worse than less data.** When in doubt, queue it.

---

## Sources: how each was cracked

The first question for every source is never "how do we parse this HTML" but **"what does its
own JavaScript request"**. BaT went from ~8,700 records to 124,412 the moment we stopped
scraping the DOM.

### Bring a Trailer — partition past a 10,000-record cap
`listings-filter` reports 257,919 listings but serves at most **10,000 to any one query**
(measured: `per_page=48`, page 208 → 48 items, page 210 → 0). The cap is **per query**, proven
with a partition smaller than it (Boats, 505 records, walked 1→11 then terminated naturally).

Partition on `category` (39 numeric ids) × `state` × `sort` = 312 independent windows.
Ten non-car categories (~30,000 records) are excluded at the taxonomy level.

**Does not work** (tested, so nobody retries): no AND across categories (comma gives union),
`range` ignored, `make`/`model`/`keyword`/`year` don't exist.

### Cars & Bids — read the site's own API responses
40,344 closed auctions. Plain fetch hits Cloudflare; a warmed browser still gets
`{"error_code":3,"message":"Invalid parameters|No Access token cookie"}`. So the harvester
drives the page and **reads the responses it issues**. Richest payload of any source: real ISO
date, real mileage, and the **three-state status** that populates `sold_after`.

### RM Sotheby's — partition by auction code
`POST /api/search/SearchLots` answers unauthenticated, 98,595 lots, same ~10k offset cap.
Partition key `Auctions: ["mo26"]` → 199 lots. Prices are on the list endpoint.

⚠️ **Mixes asking prices with sold prices.** One page of 200: Sold 118, blank 58, Offered
Without Reserve 17, **Asking 7**. Asks route to `listing`, never `sale`.

⚠️ **No date field** — resolved once per auction from schema.org `Event`.

### Mecum — partition by event
Search route is a dead end. Real archive is `/auctions/{event}/lots/?page=N`, ~1,300 sales per
event. Selectors are **structural**, never their hashed CSS-module class names
(`CardLot-module__NbNTua__card` — that hash changes every deploy).

⚠️ **Lot cards carry no date** — resolved per event. Mecum previously ran at 0% `sold_at`,
which silently removed every Mecum sale from trend maths.

### Gooding & Company — read the Gatsby build's own JSON, no scraping
Every `/auction/realized/{slug}` page ships its full lot list at
`/page-data/auction/realized/{slug}/page-data.json` — a Gatsby site, so this is data the page
already has, not an API to guess at. 41 realized auctions found via `sitemap.xml`, 2020–2026,
no offset cap (largest single auction: 525 lots, one request). The only source in this pipeline
with **structured make/model/year**, not a title to parse.

⚠️ **Titles carry Gooding's own consignment code** — 35% of titles end in a trailing
`" (PB26)"`, `" (FL22-1)"`, or bare `" (1)"` (venue+year+repeat-counter, their equivalent of
BaT's URL-only `-3` dedupe suffix, except leaked into the display title). Stripped before
identity resolution (`crawler/gooding-adapt.js`) — left in, it forked one real model into a
separate car per auction it was consigned to. Found by ingesting once, reading the inflated
review queue, and rolling the ingest back before fixing it — see the adapter's Gate 4 comment.

⚠️ **`privateSalesPrice: true` means the price is undisclosed, not that it's `$1`** —
`salePrice` holds a `1` sentinel for negotiated-private sales; treated as unpriced and skipped.

### Sotheby's Motorsport — same JSON-in-the-page approach, but capped for anonymous access
`/listings/sold/filter:sort={X}` embeds the same data in Next.js's `__NEXT_DATA__`. Structured
make/model/year again, real ISO `soldDate`, pre-filtered to actually-sold lots.

⚠️ **PARTIAL, honestly.** The feed reports 729 total sold lots archive-wide but never renders
past the first 15 for an unauthenticated request — no page/offset/make/year param tried moved
the window, and the one thing that does (`sort`) only exposes two non-overlapping 15-lot
windows: newest-sold and oldest-sold. Real pagination looks session-gated; logging in is out of
scope. ~30 of 729 lots is what this harvest honestly is — see `crawler/sms.crawler.js` header.

### Broad Arrow Auctions — one page per lot, sitemap-only, honestly small
No bulk endpoint exists that robots.txt allows: `/vehicles/results`, `/vehicles/auction_search`,
`/api/v1/vehicles`, `/*/sold?` are all explicitly disallowed. Individual
`/vehicles/{eventCode}_{lotNumber}/{slug}` pages are not, and the sitemap lists ~2,697 of them
directly — the one compliant way in, at one request per lot.

⚠️ **No "Sold for $X" label anywhere on the site.** The only signal is a bare, unlabeled price
on a closed event's lot page vs. a labeled, ranged `"Estimate: $X - $Y"` on an upcoming one —
confirmed against 8 real lots (cars and memorabilia alike) from one closed 2022 event. The
page's own `schema.org` JSON-LD price field is unusable (a real $1.25M–$1.45M estimate showed as
literal "$12,500,000" in the markup; missing entirely on roughly half of pages sampled).

⚠️ **`robots.txt` states `Crawl-delay: 10`, honored rather than ignored.** Harvesting all ~2,697
sitemap-listed lots at that rate is ~7.5 hours — deliberately out of scope for a first pass. This
harvest is one bounded, confirmed-closed event (93 lots, 80 real sales, 13 correctly-skipped
unsold lots), the same shape as the existing Bonhams sample.

### DuPont Registry — server-rendered detail pages, `/api/` deliberately avoided
The search page (`/cars-for-sale/all`) is a client-rendered SPA calling `POST /api/graphql` —
but `robots.txt` disallows `/api/`, so that route is off-limits regardless of whether it's
called directly or triggered by driving a browser through the page (same principle as the PCAR
decision: a disallowed path is a disallowed path). Individual
`/car/{make}/{model}/{year}/{vin}/{id}` pages don't have this problem — they're server-rendered
(Next.js App Router RSC streaming), so the real listing data (`listingData`: make, model, year,
price, mileage, VIN) is already sitting in the plain HTML, no JS execution or API call needed.
Listed directly in `vdp-sitemap-{1..15}.xml`, ~15,000 URLs total; harvested a 200-page bounded
sample (133 real listings) as a first pass.

⚠️ **`isSold: false` on every record, confirming this is asking-price data** — feeds `listing`,
never `sale`. ⚠️ A bare `curl -A "Mozilla/5.0"` gets a 403 from a basic bot filter even though
`robots.txt` is `Allow: /` with no bot-specific rules; a normal full browser header set gets 200.
Not a targeted block, so a realistic header set is used rather than treated as evasion.

Building this also surfaced that `listing` had no natural key (`source`/`source_lot_id`) at all,
and nothing ever ingested `samples/listings/*.json` into it — RM Sotheby's 17 real private-sale
listings had been sitting scraped-and-unloaded since RM was built. Both fixed: `db/schema.sql` +
`db/client.js` migration added the key, `ingest/ingest-listings.js` now loads both sources.

### PCAR Market — explicitly off-limits, not just unbuilt
`robots.txt` names `ClaudeBot` specifically: `User-agent: ClaudeBot` / `Disallow: /`. That's a
targeted instruction, not a generic wall — respected without attempting to route around it via a
different agent identity. Different situation from a 403 (a technical block, arguably either a
business decision or an oversight); this is an explicit, named "no."

### Not built / blocked
Barrett-Jackson, Hagerty, Collecting Cars: **403** — a commercial decision, not engineering.
DuPont Registry: asking prices only. Classic.com: aggregator, `SOURCE_TRUST` 9, staging only per
the build spec — never authoritative even once built.
Cars.com: its **robots.txt itself 403s**, so there are no terms to work within.

---

## The engine

11 of 13 components are `[V]` verbatim from their shipped bundle, and
`engine/verbatim-conformance.test.js` proves ours match **digit for digit** (54 checks), with
every expected value computed by hand from the doc:

```
confidence   n=20 R²=.45 vol=.15 -> 0.40+0.35+0.25 = 1.00
depreciation $50,000 -> 0.050    $112,500 -> 0.0375   (DOLLARS, not miles)
deal score   clamp(round(55 - 250u), 5, 98)
VIN          /^[A-HJ-NPR-Z0-9]{17}$/ plus the deliberate >=11 floor for pre-1981 chassis
```

**Four things are `[U]` and we do not pretend otherwise:** the Value Signal classifier's
thresholds and window lengths, `currentValue`'s robust estimator, the outlier method, and
seasonality. Ours implement the confirmed *method* with constants marked arbitrary in code.

Signals were sanity-checked independently — comparing each call against the ratio of newest-
to oldest-third mean price, which is *not* the engine's own regression:

```
appreciating   406 cars   median 1.358   86% rose
depreciating   506 cars   median 0.705   92% fell
stable         484 cars   median 0.993
```

---

## Deliberate divergences from DriveIndex

| # | theirs | ours | why |
|---|---|---|---|
| 1 | 10 currencies ingested, computed on 1 | `price_usd` only when currency IS USD | their defect #1 — non-USD silently dropped from maths while displayed |
| 7 | `reserveNotMet` boolean | `status` enum: `sold` / `sold_after` / `reserve_not_met` | a boolean cannot hold *sold after auction*; we have **2,404** such real transactions |
| — | ~30 valuation fields flattened onto `car` | separate `car_valuation` | recompute without touching editorial data |
| — | body style inside model name (29%) | own column | root cause of their 163 duplicate pairs |
| — | ingest everything | review queue | fragmentation is not accepted as a cost |

---

## Running it

```bash
node jobs/cron.js              # scrape -> ingest -> compute, with an exclusive lock
node jobs/cron.js --status     # lock state + recent run history
node jobs/cron.js --no-scrape  # ingest + compute only
```

Individual stages:

```bash
node crawler/bat-partitioned.crawler.js run    # resumes by partition
node crawler/cab.crawler.js                    # incremental; --full re-walks
node crawler/rms.crawler.js run                # resumes by auction, 45-day recheck
node crawler/mecum.event.crawler.js run [n]    # resumes by event
node crawler/gooding.crawler.js run            # resumes by auction, 45-day recheck; --full re-walks
node crawler/sms.crawler.js                    # two fixed fetches every run — see source writeup for why
node crawler/broadarrow.crawler.js [eventCode] # one closed event at a time, 10s crawl-delay honored
node crawler/dupont.crawler.js [sitemapN] [max]# LISTINGS, not sales — see source writeup
node ingest/ingest.js               # samples/scraped/*.json -> `sale`
node ingest/ingest-listings.js      # samples/listings/*.json -> `listing`
node jobs/nightly-compute.js
```

### API and frontend

```bash
node api/server.js                        # read API on :3000
npm --prefix web run dev                  # Next.js frontend on :3001
```

`web/.env.local` needs `ACCESS_CODE` (the shared login code) and `API_URL`.

**Frontend** — Next.js 16 App Router + shadcn/ui, deliberately monochrome. Three routes:

- `/login` — single shared access code, no accounts table. Checked server-side and exchanged for
  an HMAC-signed httpOnly cookie, so it can't be forged by setting a cookie in devtools.
  `src/proxy.ts` gates every other route. (Next 16 renamed `middleware.ts` → `proxy.ts`.)
- `/` — catalogue browse: server-side filtering by make / body / year bucket / price band /
  for-sale-now / free-text, sortable, paginated.
- `/cars/[id]` — price-history chart with range toggle, Sold + For Sale tables with source
  links, signal, forecast with bear/bull bands, collectibility, liquidity, seasonality, and a
  live mileage re-pricer backed by the engine's real `mileageAdjust()`.

**No tier gating is applied in this phase** — `fetchCars()` requests `tier=collector` so every
computed field is visible. The gating architecture in `api/serialize.js` is intact and unchanged;
only the caller is permissive. Tier still comes from a query parameter and **must** move to the
session record before this is public.

`MAKE_GROUPS` in `api/server.js` collapses Mercedes-Benz / Mercedes-AMG / Mercedes-Maybach into
one browse filter while keeping them separate catalogue entries — they have genuinely different
price curves. Verified against the data: Mercedes is the only such family in the catalogue.

### What resumes from where

| stage | marker | unit |
|---|---|---|
| BaT | `bat-partitioned.state.json` | partition — unmarked on failure, so it retries |
| RM | `rms.state.json` | auction event, immutable once settled + 45-day recheck |
| Gooding | `gooding.state.json` | auction — same immutable + recheck-window shape as RM |
| C&B | the harvest file | auction id — stops after 8 batches with nothing new |
| SMS | none | no state to resume — every run re-fetches the same two fixed windows |
| Broad Arrow | `broadarrow.state.json` | per-lot, so a re-run never re-fetches an already-harvested lot |
| ingest | the database | re-reads everything; converges, never duplicates |
| compute | none, by design | **full** recompute — one new sale moves `avg_mileage`, hence every normalised price |

---

## Verification

```bash
node validation/split-audit.js            # is one car's history split across rows?
node validation/duplication-audit.js      # scrape / ingest / cross-source / catalogue levels
node validation/null-attribute-splits.js  # split merely on an unstated attribute?
node validation/cron-safety.test.js       # does a scheduled re-run converge and not duplicate?
node validation/review-queue.js           # triaged queue, highest-leverage questions first
node validation/source-coverage.js        # coverage across the 13
node validation/freshness.js              # how current is the data?
node validation/signal-sanity.js          # do signals point the right way?
node jobs/engine-health.js                # is the engine producing usable output?
```

`validation/split-audit.js` blocks on `(year, make)` — 637,427 comparisons instead of
1,115,785,180, exact rather than approximate.

---

## Known gaps

**Listings: 4,975 vs DriveIndex's ~35,309.** Up from 137 on 2026-08-17. DuPont Registry
sitemaps 1–6 harvested (~6,000 URLs of ~15,000 listed); sitemaps 7–15 untouched. Broad Arrow
contributes 172 upcoming-consignment estimates across 8 events; ~2,200 lots across 25 more
events remain unharvested at their mandated 10s crawl-delay.

### Field coverage — measured, not estimated

The blocker for most unbuilt features is a specific empty column, and they fall into three very
different categories:

| field | coverage | why it's empty |
|---|---|---|
| `sale.mileage` | **16.9%** | BaT is **0.04%** (71 / 162,012) vs Cars & Bids **99.5%** — and BaT is 77% of the corpus |
| `sale.vin` | 0.1% | not in BaT's list API (but `listing.vin` is **98.7%**, from DuPont) |
| `sale.transmission` | 6.6% | detail-page only |
| `sale.color` / `sale.options` | ~0.04% | detail-page only — blocks Spec Premiums entirely |
| `car.generation` | **0.9%** | not scrapable; a per-marque curation project |
| `car.body_type` | 37.7% | partially title-inferable, rest needs per-model rules |
| `car.msrp` / `hp` / `zero_sixty` / `production` | **0%** | **no auction house publishes these** — needs a spec database |
| `car_valuation.peak_price` / `from_peak` / `market_repricing` / `class_rank` | **0%** | **not a data gap — nothing computes them yet** |
| `listing.image_url` | 0% | not captured by the DuPont/Broad Arrow adapters |

Three categories, in order of what they cost to close:

1. **Engine code only, no scraping** — `peak_price`, `from_peak`, momentum, `class_rank`.
   Estimated-bottom is already computed and simply never displayed.
2. **Data is on pages we already crawl, we just don't parse it** — BaT mileage/VIN/transmission
   (detail pages), listing images, and FX rates for the **1,114 EUR/GBP/CHF sales** currently
   dropped from all maths because `price_usd` is null.
3. **Needs a source we don't have** — MSRP, hp, 0-60, production. Only two of DriveIndex's
   advertised features are genuinely blocked here: MSRP-based stats and spec-level option
   premiums.

⚠️ **BaT mileage — the cheap fix is a trap.** 23.9% of BaT titles state mileage, but only when
it is *notably low* ("7k-Mile 2005 Evo VIII"). Parsing titles alone harvests a low-mileage-biased
subsample, drags `avgMileage` down and makes every mileage adjustment systematically wrong —
worse than the current honest gap. The correct fix is detail-page scraping, not a regex.

**20% of cars get a signal** vs their 45.4%. Grain, not quality: our rows are exact model-years,
theirs are generation ranges. Real fix is generation extraction (**0.9% populated**), not
grouping — tested, and grouping alone made the ratio *worse*.

**Mecum discovery** finds events via `/results/` (21 years deep), but past-event slugs are not
uniform (`kissimmee-2022` works, `indy-2022` does not exist).

**BaT harvest incomplete** — 4 large partitions unstarted (German/sold 69,806, American/sold
66,380, Truck & 4x4, Convertibles).

---

## Layout

```
crawler/     harvesters + adapters, one pair per source
resolve/     title -> car identity; vocabulary; evidence layer
engine/      valuation, signal, forecast, liquidity, collectibility
ingest/      scraped JSON -> sale / listing tables
dedup/       VIN/URL/score-based duplicate collapse
validation/  audits and health checks
jobs/        cron orchestrator, nightly compute, status
api/         read API + the single tier-gating choke point
web/         Next.js 16 frontend (shadcn/ui, access-code auth)
notes/       source registry, reconciliation report, onboarding playbook
_archive/    one-off probes and superseded crawlers, kept for provenance
```

Further reading: `notes/SOURCE-ONBOARDING.md` (how to add a source, and what to automate versus
send to a human), `notes/source-registry.md` (per-source quirks measured on real data),
`notes/reconciliation-report.md` (line-by-line against the ground truth).
