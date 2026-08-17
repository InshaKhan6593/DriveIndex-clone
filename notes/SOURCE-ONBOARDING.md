# Onboarding a new source: what to automate, what to look up, what a human must decide

This is the procedure for adding any of the 13 auction sources — and for deciding, for each
odd record, whether it is a **pattern problem** (write code), a **fact problem** (look it up
once), or a **judgement problem** (a human decides, forever).

It exists because those three get confused constantly, and the cost of confusing them is
asymmetric: automating a judgement problem puts bad data in the index, while sending a pattern
problem to a human creates a queue nobody works.

**Standing rule, from the client: bad data is worse than less data.** When in doubt, queue it.

---

## 0. The decision procedure

For every record the pipeline cannot resolve, ask in this order:

| # | Question | If yes | Cost of getting it wrong |
|---|---|---|---|
| 1 | Does the title have a **repeating shape** the parser doesn't exploit yet? | **Write code.** Shapes generalise across every source and marque. | A human re-decides the same shape thousands of times. |
| 2 | Is the shape clear but a **fact** missing (is "Marsh Metz" a marque?) | **Look it up once**, record the answer, cache it. Web search is legitimate here. | Real, valuable cars are silently dropped. |
| 3 | Would **two reasonable experts disagree**? | **Human review. Permanently.** | Bad data enters a price curve and flips a buy/sell signal. |

Rule 1 is measured, not guessed: count how many queued items share the shape before writing
code for it (`node validation/review-taxonomy.js`).

---

## 1. Measured state of the review queue

12,843 pending items at the time of writing. The taxonomy tool buckets them by SHAPE, not brand:

| Bucket | Count | Share | Verdict |
|---|---|---|---|
| **No year anywhere** | 5,057 | 39.4% | **Structural reject.** A model-year price curve cannot index a car with no model year. |
| **`{year} {unknown word} {model}`** | 4,366 | 34.0% | **Automatable** — position implies the make. See §3. |
| **Known make, unproven model** | 3,420 | 26.6% | **Self-resolving** — corpus/batch evidence accepts these as volume arrives. |

So roughly **60% of the queue is code work, not human work** — but only if the automation is
gated properly, because the "unknown word after the year" bucket is NOT all cars (§3).

---

## 2. Patterns already automated (do not re-litigate these)

Each is a *shape*, brand-independent, and holds for every source added later.

| Pattern | Rule | Why it is safe |
|---|---|---|
| **Word-order variants** | model key is token-**sorted** | "Carrera Targa G50" ≡ "Carrera G50 Targa". DriveIndex has 163 near-duplicate pairs from exactly this. |
| **HTML entities** | decode named/decimal/hex before parsing | `4&#215;4` was becoming the model token `42154`. 1,046 of 22,506 titles affected. |
| **Typography** | fold `× ' " – —` to ASCII | `4×4` and `4x4` must be one car. |
| **Diacritics** | NFD-fold for make LOOKUP only, keep accented display name | `Citroën` never matched alias `citroen`. Every Citroën was going to review. |
| **Internal hyphens in codes** | strip when a fragment is ≤2 chars or contains a digit | `corvette l-82` and `corvette l82` were two 1978 Corvettes. Keeps `mercedes-benz` intact. |
| **Engine configs** | `V8`, `I6`, `flat-6` are never model designators | A shared "V8" made an F-250 look like a Mustang. |
| **Shared numbers vs names** | if both keys name a model in letters and those disagree → different cars | `327 camaro` vs `327 corvette` — 327 is an engine size. |
| **Unknown intrinsic attributes** | blank `body_type`/`generation`/`displacement` = UNKNOWN, acts as a wildcard | 171+38 pairs were one car split on whether a seller typed "Coupe". |
| **Asserted attributes** | blank `modification` = STOCK, keeps separating | A race-prepped M3 is genuinely not a stock M3. |
| **Component head-noun** | title ENDING in wheels/seats/manifold/gauges → reject | "Porsche 911 16×7 Fuchs Wheels" became a $4,877 "1987 Porsche 911". |
| **Provenance by id shape** | BaT slug-shaped lot id ⇒ DOM harvest ⇒ reject | That harvester fabricated title↔URL pairings 58.6% of the time. |

---

## 3. The `{year} {unknown word}` bucket — automatable, but ONLY with a gate

Auction titles are overwhelmingly `{year} {make} {model} …`, so the word after the year is
usually the marque. But the measured head of that bucket is **not all cars**:

```
211 Moto (Guzzi)      174 Michael (Andretti/Schumacher)   150 AM       139 MV (Agusta)
113 Vespa              80 MGB      75 Airstream    62 Steyr-Puch   62 Freightliner
60 Bultaco             57 MGA      53 Morris       52 Lola         48 Winnebago
44 LaSalle             35 Formula  33 Goodyear     27 Bertone      24 Autozam
```

920 distinct first-words. They fall into six kinds, and **only the first is a car**:

1. **Real marques missing from the alias list** — MGB, MGA, Morris, LaSalle, Steyr-Puch, Autozam
2. **Motorcycles / scooters** — Moto Guzzi, MV Agusta, Vespa, Bultaco, Laverda, Puch
3. **RVs, trailers, trucks** — Airstream, Winnebago, Thor, Freightliner
4. **Race constructors** — Lola, Ralt, Formula (open-wheel, no consumer model)
5. **Non-vehicles** — Goodyear (tyres), signed shirts, memorabilia
6. **Coachbuilders** — Bertone, Brewster, Chapron, Saliot (a *modifier*, not the make)

**Therefore positional inference must never accept on position alone.** The required chain:

```
no known make matches
  -> take the token(s) after the year as a CANDIDATE make
  -> run the existing structural rejects (motorcycle/RV/race/component/tractor)
  -> hand to the evidence layer: accept only on batch diversity
     (>=8 sightings across >=4 model years and >=2 distinct models)
  -> otherwise queue
```

The diversity gate is what separates a real marque from a mis-parse: a genuine marque spans
many model years and several models, a bad parse repeats one frozen string.

---

## 4. Facts that needed looking up (rule 2), and their answers

Recorded so they are never re-researched. Verified by web search:

| Token | Verdict | Evidence |
|---|---|---|
| **Steyr-Puch** | **Real car marque.** Austrian; Steyr merged with Austro-Daimler-Puch in 1934 to form Steyr-Daimler-Puch. Built the Puch 500 (~60,000 sold, Fiat 500 body, Steyr mechanics). | Wikipedia: Steyr automobile / Steyr-Daimler-Puch / Puch 500 |
| **LaSalle** | **Real car marque**, and its own make — GM marketed it as a *separate brand* from Cadillac, 1927–1940. Do not fold into Cadillac. | Wikipedia: LaSalle (automobile) |
| **Autozam** | *Unconfirmed by search.* Believed a Mazda kei-car sub-brand. **Leave queued** until confirmed — an unverified make is exactly what the evidence gate is for. | — |

**Note the discipline:** two were confirmed and can become code; the third was *not*, so it stays
in the queue rather than being guessed. Writing down "unconfirmed" is as valuable as confirming.

---

## 5. What stays human, permanently

No pattern will settle these. They are judgement calls where two experts disagree, and the
queue is the correct destination:

- **Replicas and tributes** — "429-Powered Contemporary Classic Cobra Replica". A real vehicle,
  but is it a Cobra for pricing purposes?
- **Competing unknown qualifiers** — `eleanor fastback mustang` vs `bullitt fastback mustang`:
  same base, two unrecognised nicknames, no evidence to choose.
- **Unstated attribute with several candidates** — a "1920 Ford Model T" with no body style
  against existing Convertible *and* Pickup rows. Attaching is a coin flip.
- **Restomods and engine swaps of ambiguous depth** — where the line between "modified" and
  "different asset" is a valuation opinion.
- **Coachbuilt one-offs** — "1928 Rolls-Royce Phantom I Ascot Tourer **by Brewster**". Whether the
  coachbuilder creates a separate asset is a market judgement, not a parsing one.

---

## 6. Where an LLM fits later — and its guardrails

Once volume is sufficient, an LLM is a good fit for **rule 2 (facts)** and a *proposer* for
rule 3 — never an autonomous decider.

**Safe to delegate:**
- "Is `{token}` a car marque, a motorcycle marque, an RV maker, or something else?" — a lookup
  with a small closed answer set, exactly the Steyr-Puch/LaSalle/Autozam question above.
- Extracting coachbuilder / body style / displacement from an unusual title.
- Proposing a canonical make for a variant spelling.

**Never delegate:**
- Whether two near-identical cars are the same asset — that decides whether a price history is
  merged or split, and a plausible-sounding wrong answer is invisible.
- Whether a replica or restomod prices as the original.
- Anything where the model would be guessing rather than looking up.

**Mandatory guardrails**, in this order:
1. **Structural rejects run first.** An LLM never sees a title the shape rules already settled.
2. **The LLM proposes, evidence disposes.** A proposed make still faces the batch-diversity gate.
3. **Answers are cached** as facts (§4), not re-asked. Same input ⇒ same output, forever.
4. **Never invent a date or a price.** Both are refused rather than inferred — a hallucinated
   sale date silently corrupts every trend calculation. See the RM Gate 2 rule.
5. **Sample-audit the output** against the same audits used on everything else
   (`split-audit`, `duplication-audit`, `null-attribute-splits`).

---

## 7. Adding a source: the checklist

1. **Look for the site's own JSON API before writing any DOM code.** Watch its network traffic
   (`crawler/probe-source-apis.js`). BaT went from ~8,700 DOM records to 57,703 via its API;
   RM Sotheby's exposed 98,595 lots the same way.
2. **Find the offset cap, then find a partition key that fits under it.** BaT caps at 10,000 per
   query → partition by category. RM caps at ~10,000 → partition by auction code (~200 lots each).
3. **Check what the feed MIXES IN.** RM publishes private-sale *asking* prices beside auction
   results; DuPont is asking-only. An ask in `sale` is a corrupted price curve — route to `listing`.
4. **Confirm a real sale DATE exists.** RM's list endpoint has none; Mecum's had none and every
   Mecum sale was silently absent from trend maths until caught. Resolve per-auction if needed,
   and **refuse the record if you cannot** — never emit a hollow date.
5. **Confirm the lot id is stable and source-native.** A reverse-engineered id (BaT slugs) defeats
   idempotent ingest and duplicates every sale on the next run.
6. **Write adapter gate tests before harvesting at volume** (`crawler/rms-adapt.test.js`).
7. **Run the audits**: `split-audit`, `duplication-audit`, `null-attribute-splits`,
   `cron-safety.test`.
8. **Record the source's quirks** in `notes/source-registry.md`.

---

## 8. Tools

| Command | Answers |
|---|---|
| `node validation/review-taxonomy.js` | what is in the queue, and which bucket is automatable |
| `node validation/split-audit.js` | is one car's history split across rows? |
| `node validation/duplication-audit.js` | duplication at scrape / ingest / cross-source / catalogue level |
| `node validation/null-attribute-splits.js` | is a car split merely on an unstated attribute? |
| `node validation/cron-safety.test.js` | does a scheduled re-run converge and never duplicate? |
| `node validation/harvest-quality.js` | is a harvest method fabricating title↔URL pairings? |
| `node crawler/probe-source-apis.js` | does this source have a JSON API? |
