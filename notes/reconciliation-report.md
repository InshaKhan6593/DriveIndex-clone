# Reconciliation against the verbatim ground truth

Date: 2026-08-14. Source of truth: `DRIVEINDEX-GROUND-TRUTH.md` (verbatim extraction from
their shipped bundle). Everything below was found by diffing my implementation against it.

Verification: `node engine/reconciliation.test.js` — **40 checks, all passing.** Each check
locks one behaviour that was wrong before, so a future refactor can't silently reintroduce it.

---

## 1. `[V]` §4.4 — the one the doc explicitly warns about, and I walked straight into it

The table `[[25e3,.1],[75e3,0],[15e4,.075],[35e4,.045],[5e5,.09]]` is indexed by **DOLLARS**.
The call site is `b(adjustedValue)` — a price.

I had it in `engine/mileage.js` named `MILEAGE_CURVE`, taking `miles`.

**What that produced:** a 50,000-mile car got a ~0%/yr baseline depreciation regardless of
whether it was a $20k Miata or a $2M Bugatti; a 400,000-mile car got 4.5%. Value — the thing
the band is actually keyed on — had no influence at all. Every forecast baseline was wrong.

**Fixed:** new `engine/depreciation.js`, keyed on value, with the correction logged in-file.
`engine/mileage.js` now holds only `mileageAdjust()` (§4.5), which was correct.

## 2. `[V]` §4.10 — my buy/hold/sell labels were invented, and gave opposite advice

I had written `"Hold"` / `"Consider Selling"` / `"Approaching Entry"`. None of those exist.

The real vocabulary is **buyer-side throughout** — DriveIndex never tells you to sell, only
when to buy or wait. That's a product-positioning decision, not a wording detail.

On the GT2 RS fixture the corrected code now returns **"Buy Now (Rising Fast)"** where mine
said **"Hold"**. Same car, same data, opposite instruction to a client.

Three separate bugs, all fixed and locked by tests:
- gate was on confidence **level** `=== "high"`; verbatim is the **numeric score `> 0.6`**
  (different thresholds — level applies honesty caps on top, so they diverge)
- `appreciating` collapsed to one branch; verbatim splits on **annual return > 8%**
- all nine labels + their copy strings replaced with the verbatim set

## 3. `[V]` §4.6 — collectibility lists partial, override table 7% complete

- Lists were lowercase and partially transcribed; now verbatim uppercase substring match.
- **Tier order matters and I hadn't preserved it:** `NISMO` appears in *both* the track list
  (+3) and the perf list (+2). Strict else-if order means track wins. Same for `GT R`.
- Curated override table: I had **7 of ~100** entries. Now complete.
- On the GT2 RS fixture: my version computed **10**; the curated table says **9**. The table
  *discards* the computed score — I was reporting a rules score the real system never uses.
- Added `useCuratedOverrides: false` for backtests — the doc flags that this table encodes
  2026 hindsight, so applying it inside a historical fold is **lookahead bias**.

## 4. `[V]` §4.7 — two forecast components missing entirely

- **Age-factor collectibility floor.** A 2-year-old collectible was taking the full −10% age
  drag instead of being floored at −3%; a 10-year-old collectible should be lifted to +2%.
  Materially understated near-term forecasts for exactly the cars the product exists to track.
- **Falling-car brake.** For `depreciating`/`approaching` with trend ≤ −3%, the blended rate
  is capped at a fraction of the raw trend (0.34× / 0.5× / 0.65× by signal and age). Without
  it the collectibility clamp (floor −6% at collectibility ≥8) handed sharply-falling
  collectibles a forecast far more optimistic than their own trend supported.
- Also added the recovery leg of the decline simulation (~1.5%/yr toward 60% of the gap).

## 5. `[V]` §4.11 — segment classifier was missing

Not implemented at all. Now in `engine/segment.js`, verbatim. Note the deliberate tension
in their own logic: **Maserati is in the EXOTIC list, but §4.6 docks it −1 as "historically
depreciates."** Positioned as exotic, priced as depreciating. Both reproduced.

## 6. `[V]` §4.8 — liquidity verdicts and copy

Thresholds were right; the verdict labels and user-facing copy were mine, not theirs.
Replaced with the verbatim five-state set. Added `priceCutPressure()` (retail listings only).

---

## Deliberate divergences — where I did NOT copy them, and why

| # | Their behaviour | What I did | Why |
|---|---|---|---|
| **1** | `[V]` §4.13 / defect #1 — ingest 10 currencies, compute on 1. Non-USD sales silently dropped from all maths while still *displayed*. | `isClean()` takes `{dropNonUsd}`; the correct path gates on `price_usd` being populated at ingest via the FX rate **on `sold_at`**. | Their behaviour discards a large share of the corpus from international sources. It's the defect the doc lists first. |
| **7** | `[V]` defect #7 — `reserveNotMet` is a **boolean**, so C&B's third state `sold_after` (missed reserve, sold later by negotiation) can't be represented. | `sale.status` enum: `sold` / `sold_after` / `reserve_not_met`, with `reserve_not_met` kept as a generated column for compatibility. | `sold_after` *is* a real transaction, just at a negotiated rather than competitive price. A boolean forces you to either discard it or misclassify it. |
| **§6** | `[V]` `/api/cars` silently ignores every param except `make`/`limit`/`page`; all 6,805 cars ship inline in a 2.98 MB payload and filter client-side. | Real server-side filtering + pagination. | Works at 7k cars, untenable past ~20k. |
| **§5** | `[V]` defect #5 — paywalled sold prices are readable unauthenticated on `/cars/{make}/{model}/{year}` SEO pages. | Not reproduced. Gating is at one serialisation choke point. | **This is a business decision, not a technical one — flagging it for the client rather than deciding it.** The middle path in the doc: publish 10–15 recent sales for SEO, gate deep history + signal + projections. |
| **§7** | `[V]` catalogue is title-derived; 163 near-duplicate model pairs, 29% have body style inside the model name, `generation` populated on 6 of 7,240. | Title-derived (same zero-maintenance property) **plus a review queue** for non-cars and restomods. | The doc's own §7 recommendation. My queue also catches things their approach would happily ingest as models — see below. |

### The review queue is earning its place on real data

Of 17 real scraped records, 5 were correctly held back rather than silently becoming
catalogue entries:

- `ca.1945 T-34/85 Medium Tank` — not a car
- `1916 Indian Model O Light Twin`, `1916 Indian Model K Featherweight` — motorcycles
- `1967 Vollstedt-Ford 67 USAC 'Indianapolis' Racing Single-Seater` — one-off racing chassis
- `1989 Porsche 911 Carrera Classic Turbo by Singer` — **restomod**

That last one is the important one. A Singer sells for multiples of a stock 911 of the same
year. A purely title-derived catalogue would either create a separate model for it (fine) or,
after token-sorting, risk folding it into the 911 Carrera curve (**catastrophic** — one
Singer would drag an entire model-year's value up and could flip its signal). This is the
same failure mode the doc describes for `GT3 RS` mis-filed under `GT3`.

---

## Still open

1. **§4.2 / §9** — the Value Signal classifier's exact thresholds and window lengths are
   `[U]` **explicitly not established**. My `engine/signal.js` implements the confirmed
   *method* (three-window regression, long window drives the call) with clearly-marked
   arbitrary constants. **This will not match their calls exactly and I'm not claiming it
   does.** It's the single biggest remaining gap.
2. **§4.3 warning** — their confidence measures *trend fit*, not *classification certainty*.
   A car sitting on a decision boundary is a coin flip however cleanly the line fits. The doc
   recommends scaling by distance from the nearest boundary. Not yet implemented — it needs
   the thresholds from (1) first.
3. Outlier detection is `[U]` — mine is a MAD construction, not theirs.
4. `currentValue`'s robust estimator is `[U]` — mine is a recency-weighted trimmed mean.
5. **§3 strategic** — BaT is ~72% of their source mix by model-year. It is not one source
   among thirteen; it is roughly the product. My BaT adapter works, but this concentration
   is the single largest business risk in the build.
