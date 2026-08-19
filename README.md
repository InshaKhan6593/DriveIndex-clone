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
| sales | **262,501** | 110,043 |
| **listings (for-sale now)** | **5,043** (5,026 active) | ~35,309 |
| cars | 71,482 | 7,148 (model+generation ranges) |
| **sales per car** | **3.67** | — |
| cars with repeat sales | 27,664 | — |
| distinct makes | 394 | 84 |
| date range | 2012-08-18 → 2026-08-16 | — |
| review queue | 36,027 (12.1%) | none — they ingest everything |

Sources with **sales** — **8 of 13**, and the top 4 are DriveIndex's #1–#4. Weighted by their
own measured source mix, what we hold represents **96.2%** of it
(`node validation/source-coverage.js`):

| source | sales | their mix |
|---|---|---|
| Bring a Trailer | 162,582 | 72.2% |
| **Mecum** | **49,038** | 6.4% |
| Cars & Bids | 35,788 | 5.5% |
| Bonhams | 9,864 | 3.4% |
| RM Sotheby's | 2,753 | 6.2% |
| Gooding & Company | 2,046 | not in their mix (they don't carry it) |
| Broad Arrow | 405 | not in their mix |
| Sotheby's Motorsport | 25 (partial — see below) | not in their mix |

> **Mecum went 7,309 → 49,038 on 2026-08-19, and it is what pushed the corpus back to 2012.**
> Three things did it, in order of size: event discovery moved from slug-guessing to their own
> `auction-sitemap{1..3}.xml` (257 slugs back to 2012, where guessing failed on 5 of 14 because
> Indianapolis is `indianapolis-YYYY` in some years and `indy-YYYY` in others); a pagination
> truncation was fixed and every affected event requeued; and two front gates were added to the
> adapter — an automobilia matcher (big Kissimmee-scale events carry porcelain signs, pedal cars
> and tool kits inline, 3,273 of ~19k records had no model year at all) and a `$1` sentinel gate
> (Mecum publishes undisclosed/charity results as $1 — a 1931 Cadillac V16 at $1 would have
> dragged that car's whole curve to the floor). Both gates were written against real car names
> they must not destroy: bare `neon` is a Plymouth, bare `model` is a Ford Model T, `print` is
> inside "Sprint". **55 of 186 discovered events are fully harvested** — the rest is coverage
> work, not access work.
>
> Bonhams went 496 → 9,864 after three bugs were fixed in its harvester: auction pages
> server-render only the first 48 lots (67 of 113 car auctions had yielded *nothing*), 72
> sitemap ids were retried forever because they 308 to Bonhams' partner houses, and 92.9% of its
> titles append `Chassis no. …`, which was going into `model_key` and making every lot its own
> model. See `notes/source-registry.md`. **Its non-USD share is the corpus's whole FX exposure**
> (GBP 4,329 · EUR 2,801 · CHF 384 sales). Those carry a correct `price_usd` (ECB rate for the
> day they sold, `fx/`), but they are still excluded from the maths — deliberately, because they
> sold outside the US. See below. The 1,838 rows that still have no `price_usd` are all
> `price = 0` bought-in Bonhams lots: no published bid, so there is nothing to convert.

### This is a US-market index, and that is a choice

`engine/clean.js` applies two independent gates. The first, "is this price comparable at all",
**was a defect** and is fixed: DriveIndex ingests 10 currencies and computes on 1, so a €10M
Ferrari was shown to the user as evidence and silently ignored by the maths. `price_usd` is now
populated at ingest from the ECB reference rate **for the day the lot sold** — not today's rate,
which would inject years of FX drift into every trend.

The second gate, `non_us_sale`, is **kept on purpose**: a Paris or London result is a different
buyer pool, tax treatment and fee structure. Measured cost of that choice, so it is an informed
one rather than an accident:

| | |
|---|---|
| priced, comparable sales excluded | **8,954** (bon 4,640 · bat 3,166 · rms 901 · good 145 · broadarrow 102) |
| cars that would newly reach 3+ clean sales | 436 |
| cars reporting "insufficient" that do have priced overseas sales | 5,578 |

The flag is **not** a currency proxy — 5,651 USD-denominated sales are flagged non-US from real
country data (bat 5,619, bon 32). Adapters that still derive it from currency alone are wrong in
both directions; `bat` and `bon` read a real country field.

Sources with **listings** — asking-price inventory, a separate table from `sale` and never
mixed into it:

| source | listings | what they are |
|---|---|---|
| DuPont Registry | 4,852 | dealer/private asking prices (no auction) |
| Broad Arrow | 174 | upcoming-auction consignments, price = estimate midpoint |
| RM Sotheby's | 17 | upcoming consignments |

**Re-verified at 262,501 sales (2026-08-19):** 0 hard splits · 0 duplicate lot keys · 0
same-physical-car cross-source duplicates · 0 duplicate car identities · 0 NULL-attribute splits
on any intrinsic column · 0 sales unattached to a car · **236+ tests passing**.

Two honest footnotes on that line. `validation/duplication-audit.js` now flags **6** rows at its
level-4 check (identical car + date + price + source); all six were inspected and every one has a
distinct source lot id — they are single-marque Bonhams sales hammering several examples of one
model on one day, plus one RM pair worth a second look, not re-ingested rows. And
`validation/cron-safety.test.js` has **not** been re-run since Mecum quadrupled: a 3-pass
re-ingest against a 198 MB BaT harvest is hours, so its "exact +0" result stands from the
219k-sale corpus, not this one.

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

## Ranking: why leaderboards don't order by the number they display

`engine/ranking.js`. Ordering Trending by `annual_return` puts artifacts on top — measured, the
top 8 "appreciating" cars were all **+130%..+198%/yr** fits over 3–6 sales, against a real-world
ceiling nearer +30% (DriveIndex's own public market-trends page maxes at +30.4%).

The obvious fix — `WHERE confidence >= 0.7 AND sales_count >= 15` — was tried and **rejected**.
Those numbers were reverse-engineered from one day's data, and they are cliffs: a nightly cron
walks cars over them in a single step and the cliff never adapts. What's used instead:

```
score = populationMean + (lowerConfidenceBound − populationMean) × df/(df + K)
```

- **Lower confidence bound** handles NOISE — a trend through scattered sales has a large standard
  error, so the conservative end of its interval collapses on its own. Every one of the old
  top-8 artifacts has a lower bound below −86%.
- **Shrinkage by degrees of freedom** handles THIN EVIDENCE — three collinear points give a tiny
  SE and a falsely tight interval. `df = n−2` is the right weight because fitting a line consumes
  two observations.
- It is **self-dissolving**: `df/(df+K) → 1` as sales accumulate, so a car rises by earning
  evidence rather than by clearing a fixed bar. `K` is a documented prior strength, not a
  threshold, and never needs retuning as the crawlers add data.

Measured: the 1970 Ford Torino GT that ranked top-8 at +165.9%/yr falls to **rank 7,466 of
9,600**. The board now reads BMW M3 ZCP (n=15), Ferrari 430 Scuderia 16M (n=19), Porsche 911
Carrera 4S (n=87). Declines come out as Rivian R1S, Hummer EV, Cybertruck and Land Rovers —
which independently matches DriveIndex's own published declines list.

Stored as `trend_se` / `trend_lcb` / `trend_score` by `nightly-compute` (a two-pass run, because
the shrinkage target isn't known until every car is fitted). Ranking 9,600 cars per request would
mean redoing every mileage-adjusted regression on every page load.

**Deal Radar** uses the same philosophy: `judgeAsk()` validates each ask against that car's OWN
observed sale prices rather than a fixed max-discount rule — self-calibrating as sales arrive. An
ask below everything the model has ever sold for is a different car (project, salvage, replica),
not a discount: **198 of 363** candidates are rejected on that basis. Survivors are ordered by
`discount × confidence`, because a 63% discount against a 22%-confidence value is a worse lead
than 29% against 64%.

### Signal audit (2026-08-19)

The signal implementation is directionally useful, but it is not a complete or exact reproduction
of DriveIndex's documented method. The ground truth confirms the method description, not the
server-side constants, so this distinction matters.

**Implemented and checked:**

- `engine/signal.js` fits log-price against years ago, with the sign arranged so a rising market
  produces a positive annual return.
- Clean-sale filtering, mileage normalization, a minimum of 3 sales, a 180-day minimum sale span,
  and an independent +/-200% annual-return plausibility guard are applied before a directional call.
- The independent `validation/signal-sanity.js` check found the expected direction in 92% of
  appreciating cars and 92% of depreciating cars. Bottomed cars showed a 92% historical decline,
  which is expected for a call that means a decline has recently turned.
- `engine/reconciliation.test.js` passes 40 checks and `engine/verbatim-conformance.test.js`
  passes 54 checks. Those suites validate supporting engine arithmetic; they do not establish
  DriveIndex's unknown signal thresholds.

**What the implementation does not yet match:**

- The documented description says three-window regression with seasonal adjustment. The current
  classifier uses one long-window regression and an optional recent one; `engine/seasonality.js`
  computes seasonality separately and does not feed it into signal classification.
- The independent stable check had a median newest/oldest price ratio of 0.996, but only 24% of
  stable cars were flat within the check's +/-5% band. This supports a flat median, not a strong
  per-car stable call.
- `signal.js` passes raw prices to `volatilityOf()` for confidence even though the regression uses
  mileage-normalized prices. This can penalize confidence for mileage spread; it remains a known
  defect, not a signal-direction failure.
- Bootstrap mileage and collectibility are currently derived from all sales before clean-sale and
  outlier filtering. Time-blind outlier detection can also remove a genuine market re-rating. Both
  distortions are documented under **Known-wrong, not yet fixed** below.
- There are no direct unit tests for the classifier's sign, stable-band boundary, recent-window
  behavior, or 180-day gate. The sanity check is an independent data check, not a parity test.

The honest status is therefore: **good directional evidence for appreciating/depreciating calls;
partial reconstruction for the full technique; no claim of exact DriveIndex parity.**

### Calibration against DriveIndex's published output

Their thresholds run server-side and were never in the client bundle, so they can't be read — but
their public pages are an oracle. Comparing 21 cars they publish on `/market-trends` against ours:

- **median value ratio ours/theirs = 0.97** — the valuation engine already agrees closely.
- Their **stable share is 72%** vs our 22%, which implies their `STABLE_BAND` is nearer **±15%**
  than our ±3%.

That second finding is **recorded but deliberately not copied**: calling a car appreciating 14%/yr
"stable" would gut the point of the product. It is a product decision, not a bug to fix silently.

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
all** (their pages rendered blank). Both fixed: `listings_count` now sums to **5,026**, exactly
matching active listings with a resolved car, and 0 cars are missing a row.

### The single biggest quality constraint: mileage, and it got worse before it got better

Worth separating from the list below, because it is not a bug in the engine — it is a hole in
the input that the engine cannot compensate for.

| source | share of corpus | sales with mileage |
|---|---|---|
| **Bring a Trailer** | **62%** | **2.4%** — was 0.04%; `crawler/bat-detail.crawler.js` is filling it |
| **Mecum** | **19%** | **0.03%** |
| Cars & Bids | 14% | **99.5%** |
| everything else | 5% | ~0% |
| **corpus overall** | | **15.0%** — down from 16.3%, because Mecum added 49k odometer-less sales |

`engine/signal.js` mileage-adjusts every price before fitting a trend, and a sale with no
odometer falls back to `ctx.avgMiles` — it is treated as **average for its car**. That is the
safe default (it applies no adjustment) but it means that for roughly three quarters of the
corpus a 5,000-mile car and a 150,000-mile car of the same model are compared like for like.
For scale, the adjustment moves a delivery-mile example **+30%** against a 60k-mile one.

The number exists — it is on BaT's **lot page**, not the list API that
`crawler/bat-partitioned.crawler.js` reads. **That is now built.**
`crawler/bat-detail.crawler.js` fetches one lot page at a time, validates it against the stored
record before writing anything (og:title must match after normalising BaT's `No Reserve: ` prefix
and entity-encoded titles, the page's hammer price must agree, a VIN must pass `isValidVin`, and
TMU / kilometre / ambiguous-transmission rules apply), and runs as the `scrape:bat-detail` cron
stage at 150 lots per run so the backlog drains without hammering the host. Ingest keeps the
enrichment with a `COALESCE` upsert, so a later re-scrape of the list API — which carries none of
these fields — can never wipe it back off the row.

**Measured after 10,263 lot pages:** 8,912 clean, 809 with no details block, 518 rejected on a
price mismatch, 24 on a title mismatch. 3,844 BaT sales now carry an odometer, median **42,000
miles**, mean 53,700 — i.e. no low-mileage bias, which is exactly the trap a title regex would
have walked into. At 150 lots a night the remaining ~152k lots are a long grind, so this closes
gradually rather than in one pass. Bonhams and Mecum have the same hole and no equivalent
harvester yet.

### Known-wrong, not yet fixed

Found by the same audit, lower severity — none produce visibly false claims, but they quietly
distort numbers:

- **The mileage anchor is unreliable** (the consequence of the above). `avgMileage` normalises
  every price, but of 300 sampled cars with ≥10 sales, **136 (45%) have zero clean sales
  reporting mileage** and fall back to a hardcoded 50,000; another 64 anchor the entire model's
  curve on 1–2 reported values.
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
model list to maintain. All **71,482** cars were created from titles.

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
| `UNPROVEN_MODEL` | 30,729 | known make, unproven tokens — usually self-resolves on volume |
| `UNKNOWN_MAKE` | 3,022 | **lookup**: is this token a car marque? One answer covers every listing |
| `UNPARSEABLE` | 2,276 | doesn't fit `{year} {make} {model}` |
| `SAME_CAR?` | 0 | genuine merge/split judgement |

Rejections are **recorded, not discarded** — 15,972 structural, 4,599 out-of-scope, 3,688
standing decisions, each with a reason and the full record retained so any can be overturned.
The largest single rejection reason is still "no model year in title or URL" (8,149): a
model-year price index has nothing to attach such a record to.

The queue grew 28,764 → 36,027 with the Mecum harvest, and **that is the system working as
designed, not degrading.** Mecum titles are rebuilt from URL slugs and are terse, so a much
larger share of them land as `UNPROVEN_MODEL` — the bucket that self-resolves as volume arrives
rather than the one that needs a human. As a share of everything seen the queue moved 10.5% →
12.1%; the genuine-judgement bucket is still 0.

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

### Mecum — partition by event, with events found in their sitemap
Search route is a dead end (no prices, no pager, links point at auctions rather than lots). Real
archive is `/auctions/{event}/lots/?page=N`, up to ~4,400 lots per event. Selectors are
**structural**, never their hashed CSS-module class names (`CardLot-module__NbNTua__card` — that
hash changes every deploy).

Event discovery is their own `auction-sitemap{1..3}.xml`, **257 slugs back to 2012**. This
replaced slug-guessing, which failed on 5 of 14 attempts because the pattern is not
`{city}-{year}`: 2017–2023 Indianapolis sales are `indianapolis-YYYY`, 2020/2024/2025 are
`indy-YYYY`.

⚠️ **Lot cards carry no date** — resolved per event, from the event page's own og:description
("…in Dallas, TX on September 4-7, 2024", last day wins). Mecum previously ran at 0% `sold_at`,
which silently removed every Mecum sale from trend maths.

⚠️ **Car events carry memorabilia inline** and **$1 is a sentinel, not a price.** Both are
gated in `crawler/mecum-adapt.js` before the price and date gates, so the skip reason reported is
the true one. See the Mecum note under "Where it stands" for what each pattern was checked
against.

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

### Not built / blocked — three different situations (verified 2026-08-18)

Full detail in `notes/source-registry.md`; the distinction decides what a hand-written scraper
may do, so it is not collapsed into one bucket:

- **Permission-gated, and the permission was obtained.** **Mecum** — robots.txt prose bars
  automated collection *"without prior written permission from Mecum Auctions"*. The operator
  holds that written permission as of **2026-08-18**, which is why the crawler exists at all. A
  grant to a NAMED PARTY, not a general finding: if it lapses, stop running it — the standing
  data stays, collection stops.
  ⚠️ **It is run by hand, not by cron.** There is no `scrape:mecum` stage in `jobs/stages.js`,
  though the crawler's own header says there is. Deliberate or not, that is the current state:
  `node crawler/mecum.event.crawler.js run` is the only thing that advances it.
- **Named AI-crawler blocks.** **Collecting Cars**, **PCAR Market** — `User-agent: *` is
  `Allow: /`, then `ClaudeBot` / `anthropic-ai` / `GPTBot` / `CCBot` are each `Disallow: /`.
  Nothing here crawls them. Whether that binds a scraper a human writes and runs themselves is a
  Terms-of-Service question, not a robots.txt one.
- **Unreadable terms.** **Barrett-Jackson**, **Hagerty**, **Cars.com** — `robots.txt` itself
  returns 403, so permission cannot be established. Treated as closed.

**Open and now built:** **Bonhams** was the largest opportunity and is no longer unbuilt — the
proof-of-concept pinned to one auction with `maxLots: 5` became a sitemap-enumerated harvester
(`crawler/bonhams.crawler.js`, cron stage `scrape:bonhams`) carrying 9,864 sales. 4,359 of its
11,353 sitemap auction ids have been visited so far; 230 of those were car sales and 4,054 were
another Bonhams department. **Classic.com** is fully permissive but an aggregator
(`SOURCE_TRUST` 9, staging only, never authoritative) — `crawler/classic.crawler.js` writes
leads to `samples/staging/`, never to `samples/scraped/`.

See `notes/WRITING-A-SCRAPER.md` for the record contract and the Bonhams probe findings.

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
| 1 | 10 currencies ingested, computed on 1 | `price_usd` stamped at ingest from the ECB rate **on `sold_at`** | their defect #1 — non-USD silently dropped from maths while displayed. Ours are converted correctly, then held out of the maths by `non_us_sale` for a stated reason |
| 7 | `reserveNotMet` boolean | `status` enum: `sold` / `sold_after` / `reserve_not_met` | a boolean cannot hold *sold after auction*; we have **2,408** such real transactions (all Cars & Bids — the only source that publishes the third state) |
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
node crawler/bat-detail.crawler.js [nLots]     # lot-page enrichment: mileage/VIN/transmission/color
node crawler/mecum.event.crawler.js run [n]    # resumes by event; permission-gated, see below
node crawler/cab.crawler.js                    # incremental; --full re-walks
node crawler/rms.crawler.js run                # resumes by auction, 45-day recheck
node crawler/gooding.crawler.js run            # resumes by auction, 45-day recheck; --full re-walks
node crawler/sms.crawler.js                    # two fixed fetches every run — see source writeup for why
node crawler/broadarrow.crawler.js [eventCode] # one closed event at a time, 10s crawl-delay honored
node crawler/dupont.crawler.js [sitemapN] [max]# LISTINGS, not sales — see source writeup
node crawler/bonhams.crawler.js [budget]       # resumes by auction id; repairs before exploring
node fx/fetch-ecb-rates.js          # REQUIRED ON A FRESH CLONE, before the first ingest
node ingest/ingest.js               # samples/scraped/*.json -> `sale`
node ingest/ingest-listings.js      # samples/listings/*.json -> `listing`
node jobs/nightly-compute.js
```

`data/` is gitignored, so a fresh clone has **no FX rate table** until `fx/fetch-ecb-rates.js`
runs — it downloads the ECB daily reference series (~670 KB) that `ingest` uses to stamp
`price_usd`. `jobs/cron.js` runs it automatically as the `fx` stage, ordered before `ingest`;
only a manual first run needs it invoked by hand. Without it every non-USD sale ingests with
`price_usd = null` rather than a wrong number — `fx/convert.js` never guesses.

### API and frontend

```bash
node api/server.js                        # read API on :3000
npm --prefix web run dev                  # Next.js frontend on :3001
```

`web/.env.local` needs `ACCESS_CODE` (the shared login code) and `API_URL`.

**Frontend** — Next.js 16 App Router + shadcn/ui, deliberately monochrome. Six routes:

- `/login` — single shared access code, no accounts table. Checked server-side and exchanged for
  an HMAC-signed httpOnly cookie, so it can't be forged by setting a cookie in devtools.
  `src/proxy.ts` gates every other route. (Next 16 renamed `middleware.ts` → `proxy.ts`.)
- `/` — catalogue browse: server-side filtering by make / body / year bucket / price band /
  for-sale-now / free-text, sortable, paginated.
- `/cars/[id]` — price-history chart with range toggle, Sold + For Sale tables with source
  links, signal, forecast with bear/bull bands, collectibility, liquidity, seasonality, and a
  live mileage re-pricer backed by the engine's real `mileageAdjust()`.
- `/trending` — market health, top gainers/decliners, segment indexes, bottomed list.
- `/deals` — Market Deal Radar: live asks under computed value.
- `/compare` — up to four cars side by side, with a typeahead picker.

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
| BaT detail | `bat-detail.state.json` | lot id, with its outcome (`ok` / `no-details` / `price-mismatch` / `title-mismatch`) |
| Mecum | `mecum.state.json` | auction event, with its resolved date and lot count |
| Bonhams | `bonhams.state.json` | auction id — records `other` (wrong department) and `offsite` so neither is refetched |
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

**Listings: 5,043 vs DriveIndex's ~35,309.** Up from 137 on 2026-08-17, and the one number that
did *not* move with this data drop — every new record was a completed sale. DuPont Registry has
5,969 of 13,814 sitemap URLs visited (4,852 became listings); Broad Arrow contributes 174
upcoming-consignment estimates from 975 of ~2,730 lots, at their mandated 10s crawl-delay. Both
now advance on their own as cron stages, so this closes without anyone driving it.

### Field coverage — measured, not estimated

The blocker for most unbuilt features is a specific empty column, and they fall into three very
different categories:

Re-counted from the database 2026-08-19, not sampled:

| field | coverage | why it's empty |
|---|---|---|
| `sale.mileage` | **15.0%** | BaT **2.4%** and climbing via `bat-detail`; Mecum **0.03%** across 49k rows; Cars & Bids **99.5%** |
| `sale.vin` | 2.9% | BaT **4.0%** (bat-detail), Broad Arrow 78%, Bonhams 7% — and `listing.vin` is **98.7%**, from DuPont |
| `sale.transmission` | 7.2% | Cars & Bids 38%, BaT 3.1% (bat-detail); detail-page only elsewhere |
| `sale.color` | 2.4% | BaT 3.8% (bat-detail); detail-page only elsewhere — still blocks Spec Premiums |
| `sale.options` | ~0% | detail-page only, not parsed by any adapter |
| `car.generation` | **1.3%** | not scrapable; a per-marque curation project |
| `car.body_type` | 42.0% | partially title-inferable, rest needs per-model rules |
| `car.msrp` / `hp` / `zero_sixty` / `production` | **0%** | **no auction house publishes these** — needs a spec database |
| `car_valuation.peak_price` / `from_peak` / `market_repricing` / `class_rank` | **0%** | **not a data gap — nothing computes them yet** |
| `listing.image_url` | 0% | not captured by the DuPont/Broad Arrow adapters |

Three categories, in order of what they cost to close:

1. **Engine code only, no scraping** — `peak_price`, `from_peak`, momentum, `class_rank`.
   Estimated-bottom is already computed and simply never displayed.
2. **Data is on pages we already crawl, we just don't parse it** — BaT mileage/VIN/transmission
   (detail pages: **built**, draining at 150 lots/night), the same fields for Mecum and Bonhams
   (**not built**), and listing images. FX is no longer on this list: every priced sale converts,
   and the 1,838 rows without a `price_usd` are `price = 0` bought-in Bonhams lots with no
   published bid.
3. **Needs a source we don't have** — MSRP, hp, 0-60, production. Only two of DriveIndex's
   advertised features are genuinely blocked here: MSRP-based stats and spec-level option
   premiums.

⚠️ **BaT mileage — the cheap fix is a trap.** 23.9% of BaT titles state mileage, but only when
it is *notably low* ("7k-Mile 2005 Evo VIII"). Parsing titles alone harvests a low-mileage-biased
subsample, drags `avgMileage` down and makes every mileage adjustment systematically wrong —
worse than the current honest gap. The correct fix is detail-page scraping, not a regex.

**37.8% of cars get a signal** vs their 45.4% — up from 20%, and the gap is now mostly closed.
The cause was grain, not quality: our rows are exact model-years, theirs are generation ranges,
and 91.1% of `insufficient` cars have one or two sales *in existence* — no amount of harvesting
reaches transactions that never happened.

What closed it is the **model-window fallback** in `jobs/nightly-compute.js`, and it supersedes
the earlier finding here that grouping made the ratio worse. A fixed 5-year band did; a window
**centred on the car** (`±2` model years, same make + `model_key` + `body_type`) does not,
because a band splits generations at arbitrary boundaries — 1964 and 1965 Mustangs land in
different buckets — while a centred window cannot. Three rules keep a borrowed history from
passing as an owned one:

- it runs **only** when the car has no signal of its own, never overwriting an `own` verdict;
- confidence is discounted, so a pooled car can never outrank a car with real history (the
  pooled median sits a median 16.5% from the car's own sales, p90 62% — the cost is real);
- it **borrows only what is missing.** A car can have enough sales to know its price but too
  short a span to show direction (measured: a 2023 Subaru BRZ, 4 sales inside 84 days), so where
  the car priced itself its own price survives and only the trend is taken from the neighbours.

Every row records which happened, and the API exposes it: `own` 58,347 · `own-price/window-trend`
11,743 · `model-window` 1,381. Generation extraction (**1.3% populated**) is still the better
long-term fix; this is the honest interim one.

**BaT harvest — partitions are done, the cap is not.** All 224 partition×sort units
(56 partitions × 4 sorts) are complete. What remains is BaT's own 10,000-result-per-query
ceiling: 11 partitions exceed it, so 4 sorts reach at most ~40k of each (German/sold ~69.9k,
American/sold ~66.5k). Going further needs partitions narrower than 10k — by year or price band
inside a category — not more sorts.

**Mecum coverage** — 55 of 186 discovered events fully harvested. Two `indy-20NN` slugs are
marked dead (they genuinely do not exist; those years are `indianapolis-YYYY`).

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
`notes/reconciliation-report.md` (line-by-line against the ground truth),
`notes/WRITING-A-SCRAPER.md` (the record contract for a hand-written scraper, plus what is
left to build and the Bonhams probe findings).
