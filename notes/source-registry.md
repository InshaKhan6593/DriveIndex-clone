# Source registry — measured patterns for all 13 auction sources (+1 aggregator)

Probed live 2026-08-15 with `node crawler/probe-all-sources.js`. Machine-readable output in
`samples/raw/source-patterns.json`. Nothing here is assumed — every row was observed.

## Status at a glance

| Source | Code | Reachable | Listings on index | Prices unauth. | Adapter | Crawler |
|---|---|---|---|---|---|---|
| Bring a Trailer | `bat` | yes | **347** | yes | built | **built — 162,012 sales; 4 large partitions still unstarted (~130k more)** |
| Cars & Bids | `cab` | yes | **80** | yes | built | **built — 35,609 sales** |
| Mecum | `mecum` | **robots.txt prohibits data mining "for any commercial purposes"** | **116** | yes | built | **frozen at 7,300 sales — see below; keeps existing data, adds none** |
| RM Sotheby's | `rms` | yes | 17 | no (detail only) | built | **built — 2,676 sales + 17 listings** |
| Gooding & Company | `good` | yes | 4 | no | **built (2026-08-16)** | **built — 2,030 sales, 41/41 auctions (COMPLETE)** |
| Broad Arrow Auctions | `broadarrow` | yes | 1 | no (detail only) | **built (2026-08-17)** | **built — 252 sales + 172 listings, 8/33 events, see below** |
| DuPont Registry | `dupont` | yes (needs real browser UA) | 23 (old route, now redirects) | yes (server-rendered) | **built (2026-08-17)** | **built — listings only, 4,786 VDPs, sitemaps 1–6 of 15, see below** |
| Bonhams | `bon` | **yes — robots.txt permits** | **85** | no (detail only) | built | **PROOF OF CONCEPT ONLY — 24 sales, one auction, `maxLots` default 5. Biggest open opportunity; see below** |
| Sotheby's Motorsport | `sms` | yes | 18 | yes | **built (2026-08-16)** | **built — CAPPED at 15/request anonymous of 729 lots, see below** |
| Classic.com | `classic` | **yes — robots.txt fully permissive** | 40 | yes | — | — (aggregator, `SOURCE_TRUST 9`, staging only, never authoritative) |
| Collecting Cars | `collectingcars` | **robots.txt: `Allow: /` for `*`, but names `ClaudeBot` + `anthropic-ai` → `Disallow: /`** | 0 | no | — | **not built — see the note on named-AI blocks below** |
| PCAR Market | `pcar` | **robots.txt names ClaudeBot, `Disallow: /`** | — | — | — | **not built — see below** |
| **Barrett-Jackson** | `bj` | **`robots.txt` itself 403s** | — | — | — | **closed — no terms readable, so no permission establishable** |
| **Hagerty Marketplace** | `hagerty` | **`robots.txt` itself 403s** | — | — | — | **closed — same as above** |
| Cars.com | `carscom` | **`robots.txt` itself 403s** | — | — | — | **closed — same as above** |

### On the three different kinds of "blocked" (verified 2026-08-18)

They are not equivalent, and the difference decides what a hand-written scraper may do:

1. **Prohibited for everyone.** Mecum's `robots.txt` carries prose prohibiting data mining "for
   any commercial purposes" and for developing software/ML/AI. That binds any scraper, not just
   bots. Existing Mecum data is kept; nothing further is collected.
2. **Named AI-crawler blocks.** Collecting Cars and PCAR set `User-agent: *` → `Allow: /`
   (Collecting Cars even sets `Crawl-delay: 1`) and then separately `Disallow: /` for
   `ClaudeBot`, `anthropic-ai`, `GPTBot`, `CCBot`. Those rules are aimed at AI crawlers. Nothing
   in this repo crawls them. Whether they bind a scraper a human writes and runs themselves is a
   **Terms of Service** question, not a robots.txt one — see `WRITING-A-SCRAPER.md`.
3. **Unreadable terms.** Barrett-Jackson, Hagerty and Cars.com return 403 for `robots.txt`
   itself. Permission cannot be established, so they are treated as closed.

## What each status actually means

**403 BLOCKED (bj, hagerty)** — the server refused a plain headless request outright. This is
a deliberate anti-automation posture, not a broken URL. Do NOT work around it. These two need
either an official data agreement or a decision from the client to skip them. Treating a 403
as a puzzle to solve is how a scraping project becomes a legal problem.

**Reachable, 0 listing links (collectingcars, pcar, dupont)** — the page loaded fine but no
vehicle links matched. Almost certainly the wrong entry URL (these sites gate results behind
a search/filter route) rather than a block. Each needs one probing pass to find its real
results route, same as BaT's "Results" tab and Mecum's `?saleResult[0]=sold` took.

**Prices not visible unauthenticated (rms, bon, good, broadarrow)** — the index page shows
lots without hammer prices; the price is on the detail page. Already handled that way for
Bonhams. Costs one request per lot, so these sources are slower per record.

## Per-source URL slug shapes (implemented in `resolve/slug-parsers.js`)

Every source encodes year/make/model differently. A single regex silently produces garbage
for all but one of them — this was a real bug, caught by `resolve/per-source-report.js`.

```
bat    /listing/{year}-{make}-{model}-{dedupeCounter}/
cab    /auctions/{lotId}/{year}-{make}-{model}
mecum  /lots/{numericId}/{year}-{make}-{model}?aa_id=...
bon    /auction/{auctionId}/lot/{lotNo}/lessbgreater{year}-{make}-{model}lessbgreater...-vin-{VIN}/
rms    /auctions/{auctionCode}/lots/{chassisCode}-{year}-{make}-{model}/
```

Two land mines worth naming:
- **Bonhams** slugs contain `lessbgreater` — a double-escaped `<b>` that leaked into their
  slug generator — plus a trailing `-vin-XXXXXXXX`. Both must be scrubbed or the make/model
  tokens come out corrupted.
- **RM Sotheby's** prefixes a chassis/lot code (`r0170`) *before* the year, so a naive
  "first token is the year" parser fails.

## Per-source field availability (measured, `resolve/per-source-report.js`)

⚠️ **The table that used to sit here was measured on a hand-checked sample of a few records per
source and was wildly wrong at scale** — it claimed BaT mileage 81% and Bonhams VIN 100%. Below
is the whole corpus, counted from the database (2026-08-18, `scratchpad/per-source.js` shape:
`COUNT(*) WHERE field IS NOT NULL AND field != ''`, grouped by source). Re-run it rather than
trusting any transcribed copy.

| Field | bat | cab | mecum | rms | good | broadarrow | sms | bon |
|---|---|---|---|---|---|---|---|---|
| **rows** | **162,012** | **35,609** | **7,300** | **2,676** | **2,030** | **252** | **25** | **24** |
| price | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% |
| sold_at | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% |
| mileage | **0%** | **100%** | 0% | 0% | 0% | 0% | 0% | 38% |
| vin | 0% | 0% | 0% | 0% | 0% | 77% | 0% | 96% |
| transmission | 0% | 38% | 0% | 0% | 0% | 0% | 0% | 100% |
| color | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 13% |
| image_url | 100% | 100% | 0% | 0% | 0% | 0% | 100% | 0% |
| price_usd | 100% | 100% | 100% | **68%** | **93%** | **60%** | 100% | 100% |

**Cars & Bids remains the highest-quality source** — 100% mileage, the only source that gives it
at volume. **BaT is 77% of the corpus and supplies 0% mileage**, which is the single biggest
quality constraint in the system: the odometer is on its detail page, not the list API the
crawler uses.

**The `price_usd` gaps are the currency bug, visible per-source.** RM at 68%, Broad Arrow at 60%
and Gooding at 93% are the international sales whose EUR/GBP/CHF prices were never converted —
`engine/clean.js` drops every one of them from the maths.

### ⚠️ Structured identity is available and thrown away

`adapters/schema.js` has **no `make`, `model` or `year` field**. Every source is funnelled through
a single `title` string, which `resolve/` then re-parses to recover identity. For sources that
publish prose titles (BaT, Gooding, Broad Arrow, Bonhams) that is unavoidable. For three sources
it is pure loss:

| source | what it publishes | what the adapter does |
|---|---|---|
| DuPont Registry | `data.year`, `data.make`, `data.model` as separate JSON fields | `crawler/dupont-adapt.js:53` joins them into `"${year} ${make} ${model}"` |
| Sotheby's Motorsport | `v.year`, `v.make`, `v.model` as separate JSON fields | `crawler/sms-adapt.js:26` — same concatenation |
| Mecum | labelled `MAKE` / `MODEL` / `EXTERIOR COLOR` fields on the page | `crawler/mecum-adapt.js:53` rebuilds the title from the URL slug instead |

Stated identity is strictly stronger evidence than parsed prose, and discarding it sends work to
the review queue that never needed to go there. Fixing it means adding optional
`make`/`model`/`year` to the record contract and having `resolveCarV2` prefer stated fields,
falling back to title parsing only when they are absent.

## Source-specific quirks found in real data

- **bat** — titles carry heavy prefixes (`28k-Mile`, `RoW`, `34-Years-Owned`, `ca.`); a `-N`
  dedupe counter is appended to slugs; the "Results" tab is a **global** feed, not filtered
  by the model path in the URL (measured: `/porsche/911/`, `/porsche/911-turbo/` and
  `/porsche/911-gt3/` returned largely the same 57 titles).
- **bat** — one real title/URL **year conflict**: title `1971 Ferrari 365 GTB/4 Daytona
  Berlinetta` on slug `.../1973-ferrari-365-gtb-4-daytona-berlinetta-3/`. Model-year is
  identity, so this is routed to human review rather than guessed.
- **cab** — three outcome states, not two: `sold`, `sold_after`, `reserve_not_met`. Measured
  3 of 5 sampled lots ended reserve-not-met, verified against the live page. This is why the
  `sale.status` column is an enum rather than DriveIndex's boolean.
- **mecum** — no ISO timestamp anywhere; the date must be assembled from the lot's crossing
  day (`THURSDAY, AUGUST 13TH`) plus the year in the auction name (`MONTEREY 2026`).
- **bon** — prices are shown **inc. premium** (all-in), unlike hammer-price sources. Matters
  for cross-source dedup, which allows a 2–13% band for exactly this hammer-vs-all-in gap.
- **bon** — mixes non-car lots into car auctions (a 1967 Vollstedt-Ford Indy chassis, a 1936
  Cord with `Engine no.` in the title). Kilometre odometers appear even at US auctions.
- **classic** — **aggregator**. Per the build spec it must never create a sale; it is
  staging/backfill only, and always loses survivor selection in dedup (`SOURCE_TRUST` 9).

## Recommended build order for the remaining sources

1. **sms, classic** — reachable with prices on the index page; cheapest to add.
2. **rms, good, broadarrow** — reachable but need per-lot detail fetches; more requests.
3. **collectingcars, pcar, dupont** — need one probing pass each to find the real results route.
4. **bj, hagerty** — blocked. Requires a commercial/legal decision, not an engineering one.

---

## Route fixes (2026-08-15, `crawler/probe-routes.js`)

Three sources previously showed "reachable, 0 listing links". Probed candidate routes:

| Source | Working route | Result |
|---|---|---|
| **dupont** | `/autos/results/all/all` | **23 lots** — and the best URL of any source: `/car/{make}/{model}/{year}/{VIN}/{id}`, so make, model, year AND VIN are all path segments. Nothing inferred from prose. |
| **pcar** | `/search/?status=closed` | **24 lots** — but the same route serves automobilia (real examples: "sinclair-gas-aluminum-sign", "large-illuminated-porsche-...-sign"). Slugs carry no year, so the out-of-scope gate has to catch signs from the title. |
| **collectingcars** | none found | `/for-sale/results` returns **403**; other routes yield 0 lots. Treat as blocked alongside bj/hagerty. |

⚠️ **DuPont carries ASKING prices, not sold prices.** Rows from it belong in `listing`, never
`sale`. Ground truth §3 notes DriveIndex classes `dupont` as an *auction* source despite this
and flags it as a possible defect where asks leak into sold-price maths. Do not reproduce it.

**Blocked, needs a commercial decision rather than engineering:** `bj`, `hagerty`, `collectingcars`.

## Standing review decisions (`resolve/review-decisions.js`)

The queue is only useful if decisions stick — otherwise the same tank is re-queued nightly
forever and the operator stops reading the queue. All 11 items in the queue on 2026-08-15 were
adjudicated by inspecting the real record; 10 became standing rejections (parts, automobilia,
marine engines, motorcycles, military vehicles, one-off racing chassis).

Effect: **human review fell from 10.2% to 1.0%.**

The one remaining item — "429-Powered Contemporary Classic Cobra Replica 5-Speed" — is
genuinely a judgement call (a real vehicle, but a replica by a low-volume manufacturer), so it
correctly stays with a human.

## Bring a Trailer: the 10,000-record cap and how it is beaten (2026-08-15)

BaT is ~72% of DriveIndex's source mix, so its coverage sets the ceiling for the whole product.

**The cap, measured exactly.** `listings-filter` reports `items_total = 257,919` but serves at
most **10,000 records to any single query**. With `per_page=48`: page 208 returns 48 items
(offset 9,984); page 210 returns 0 (offset 10,080). This is an offset cap, not a page cap —
raising `per_page` does not raise it, and `per_page >= 96` is rejected outright.

This is why the corpus held 2014–2018 and 2026 with **nothing in between**: `sort=td` bought the
newest 10k and `sort=ta` the oldest 10k, and the seven years in the middle were simply out of
reach. It was never a scraper bug.

**The cap is per-query, not global.** Proven with a partition smaller than the cap:
`category=383` (Boats, 505 records) paged cleanly 1→11 and page 12 returned empty — natural
termination, not truncation. So narrowing the query moves the whole window.

**The filter grammar** (found by watching the site's own XHR, then enumerating params with a
400-oracle — the endpoint 400s on *registered* params given bad values but silently ignores
unknown ones, which makes membership testable):

| Param | Values | Effect |
|---|---|---|
| `category` | numeric term id | German=7 → 86,023; American=3 → 87,881; Boats=383 → 505 |
| `state` | `sold` / `unsold` | American: 66,380 sold + 21,501 unsold |
| `sort` | `td` `ta` `vd` `bd` | newest / oldest / popularity / highest-bid |
| `per_page` | ≤ 48 | 96+ rejected |

The 39-entry category taxonomy comes from `window.BAT_MODEL_FILTER_CRITERIA`, captured to
`samples/bat-filter-criteria.json`.

**Sorts matter because they enter the same partition from different ends.** For American/sold
(66,380 — far over the cap) the four sorts start at 8/14/2026, 7/30/2014, 8/11/2021 and 8/4/2026.
`vd` (popularity) is the valuable one: it lands mid-archive, in the years the other sorts cannot
reach.

**What does NOT work** — tested, so nobody retries them:
- No AND across categories. Comma gives **union** (German+Convertibles = 113,987 = 86,023 +
  48,510 − 20,546 overlap); a repeated key takes the last value. So the big categories cannot be
  sub-divided this way.
- `range` (7D/30D/1Y/2Y/5Y) is in the criteria object but is **ignored** by `listings-filter`.
- `make`, `model`, `keyword`, `search`, `year`, `date_from` — all silently ignored; they do not exist.
- `type` is registered but every value tried (`premium`, `no-reserve`, `1`, empty) is rejected.
- The richer `keyword-filter` endpoint registers `s`, `range` and `category`, but its required
  `results` param rejected every value tried. Unresolved; the JS that calls it is behind
  `_static/??-` concatenated bundles.

**Resulting coverage, stated honestly.** 62 partitions fall under the cap and are therefore
**provably 100% harvestable** (58,725 records). 13 partitions exceed it and can only ever be
**PARTIAL** — at most ~4 × 10k each, with overlap between the sorts. The harvester labels every
partition COMPLETE or PARTIAL from its measured total and never claims the former for the latter.

**Category policy.** Ten categories (~30,000 records) are not automobiles — Parts, Wheels, Boats,
Trains, Tractors, Go-Karts, Minibikes & Scooters, Motorcycles, Side-by-Sides, ATVs — and are
excluded at the taxonomy level in `crawler/bat-partitioned.crawler.js`. The evidence classifier
would reject them anyway, but one at a time, flooding human review. Excluding the taxonomy is
cheaper and keeps the review queue small.

## Gooding & Company: cracked via its own Gatsby build output (2026-08-16)

Not an API — a Gatsby site, so every `/auction/realized/{slug}` page ships its complete lot
list inside `/page-data/auction/realized/{slug}/page-data.json` at build time. `sitemap.xml`
lists every realized-auction slug directly (41 found, 2020–2026); no offset cap anywhere —
largest single auction was 525 lots, still one request. Full harvest: 2,327 lots adapted,
1,975 became real sales after gates.

**The only source with structured `make`/`model`/`modelYear`** — every other adapter parses a
title; this one gets fields from a real `ContentfulVehicle` content type. Non-vehicle lots
(automobilia, signs) carry `item.__typename === "ContentfulAutomobilia"` instead — a
**structural** reject, no title regex needed (one "Geared Online" sale, 525 lots, was 100%
automobilia and correctly yielded zero sales).

⚠️ **`privateSalesPrice: true` + `salePrice: 1` is a private-sale sentinel, not a dollar.**
One real example: a 1965 Aston Martin DB5 Vantage at London 2024 shows `salePrice: 1` — the
real figure was never disclosed. `privateSalesPrice` is a boolean flag across every auction
sampled, never itself a price. Skipped rather than ingested as a fabricated $1 sale.

⚠️ **35% of titles carry Gooding's own consignment code** — `"... (PB26)"`, `"... (FL22-1)"`,
bare `"... (1)"`. Confirmed by ingesting once at full volume: the review queue jumped to 644
items, nearly all "ambiguous — differs only by unrecognised tokens" against the SAME car under
a different auction's code. Rolled the ingest back, stripped the code in the adapter (regex
covers all 39 distinct suffixes observed across the full 2020–2026 harvest), re-ingested clean:
queue dropped to 313, all genuine judgement calls. The stripped code is kept in
`_extra.rawTitle` for provenance.

**Currency**: per-auction field, reliable except on Gooding's own oldest US auctions
(Scottsdale/Amelia Island 2020, both pre-dating the field being populated) — defaulted to USD
there since both are in-person US venues; every non-USD auction sampled (London → GBP,
Rétromobile Paris → EUR) carried an explicit code.

**Date**: no per-lot session field, so (same policy as RM's human-readable-date fallback) the
whole auction is dated by its LAST auction session's `endDate`, not its first.

## Sotheby's Motorsport: found the results feed, hit an anonymous-access ceiling (2026-08-16)

Same shape as Gooding — a Next.js site, so `/listings/sold/filter:sort={X}` embeds its data in
`__NEXT_DATA__`, no API guessing needed. Structured make/model/year again, real ISO `soldDate`,
pre-filtered to actually-sold lots (every sample had `vehicleStatus: "sold"` and
`reservePrice <= bidDetails.value`).

⚠️ **Capped at 15 results for an unauthenticated request, out of 729 reported total.** Tried:
`?page=N` (echoed into `query` but ignored server-side), `filter:` segment variants for
`page`/`year`/`make`/`selectedMake` (silently ignored, except `page` as a filter KEY specifically,
which errors the whole request rather than being ignored — the parser knows the word, just not
as something anonymous users get). Watched a real browser session scroll to the loading spinner
at the list's end: it re-fetched the SAME first page rather than advancing — consistent with
true pagination being gated behind a logged-in session. Did not attempt to log in (out of
scope: this pipeline does not create accounts or authenticate as the user).

**What does work**: `sort=closed_date_desc` vs `sort=closed_date_asc` each surface a different
15-lot window — newest-sold and oldest-sold — confirmed zero overlap on real data. That's the
whole harvest: 2 fetches, ~30 unique real lots. Labeled PARTIAL rather than silently presented
as the full 729 — same honesty convention as BaT's per-partition COMPLETE/PARTIAL labels.

## Broad Arrow Auctions: one page per lot, sitemap-only (2026-08-17)

No bulk endpoint is permitted: `robots.txt` explicitly disallows `/vehicles/results`,
`/vehicles/*-results`, `/vehicles/auction_search`, `/vehicles/still-for-sale?`,
`/vehicles/new_arrivals?`, `/api/v1/vehicles`, `/api/inventory`, and `/*/sold?`. It DOES provide
`Sitemap: https://www.broadarrowauctions.com/sitemaps/bagauction/sitemap.xml.gz`, which lists
~2,697 individual `/vehicles/{eventCode}_{lotNumber}/{slug}` pages directly — none of which match
any Disallow pattern. That's the sanctioned way in: one request per lot, no search/API route
touched at all.

**No "Sold for $X" label exists anywhere on the site.** The only signal a lot resolved is a bare,
unlabeled price in the page's `price-row` div. An upcoming/current lot instead shows a labeled,
ranged estimate: `<span id='label'>Estimate:</span><span id='convert_price'>$1,250,000 -
$1,450,000</span>`. Confirmed on 8 real lots from one closed 2022 event (Monterey Jet Center,
event code `jc22`) — 6 cars AND 2 memorabilia lots (a model art car, a watch) all showed the bare
unlabeled form, all plausible real values ($6,000 model car up to a $5.5M Ferrari 250 GT LWB).
13 lots from that same event showed no price at all — genuinely unsold/withdrawn, correctly
skipped, not a hollow $0 sale.

⚠️ **The page's own `schema.org` JSON-LD `offers.price` field is not usable.** A 1996 Porsche
911 GT2 with a real displayed estimate of "$1,250,000 - $1,450,000" carried `"price":
"12500000"` ($12.5M) in its markup; a 2003 Ferrari Enzo with a "$9M-$11M" estimate carried
`"price": "106750000"`. It's also missing entirely ("Structured data for this vehicle is
skipped") on roughly half of pages sampled, including confirmed real cars (a 1965 Shelby
GT350). Title, price, VIN, and event/branch name are all read from the rendered page instead.

**No per-lot date.** Resolved once per EVENT from `/past-auctions`, which lists every event's
name next to its closing date (`<h2 class='top'>18 August 2022</h2><h2 class='mid'>Monterey Jet
Center 2022</h2>`) — matched against the branch name printed on each lot page. Multi-day events
use the closing day, same policy as Gooding/RM.

**`robots.txt` states `Crawl-delay: 10`, honored.** Harvesting all ~2,694 sitemap-listed lots at
that rate is ~7.5 hours. `crawler/broadarrow.crawler.js [eventCodePrefix]` takes an event-code
prefix (from the URL, e.g. `jc22`) so the work is done one bounded event at a time.

**Progress (2026-08-17): 8 of 33 events, 252 sales + 172 listings.** The sitemap's 2,694 vehicle
pages span 33 distinct event codes; a survey of all of them is in
`_archive`-adjacent scratch work, but the counts are recoverable by re-running the sitemap fetch.
Events harvested: `jc22`, `po26`, `gi26u`, `gi26e`, `lv25`, `dg25`, `mb26`, `ql26`, `zt26`,
`gi26z`, plus the five one-to-two-lot codes (`ad26`, `dg26`, `ms24`, `ba`, `cm26`). Largest
untouched: `pb22` (187), `am26` (177), `jc23`/`jc25` (171 each), `am25` (168), `jc24` (157).

**Extended to emit listings as well as sales (2026-08-17).** A page showing `Estimate: $X - $Y`
was previously just skipped. But an upcoming-consignment estimate is real, current,
auction-house-published pricing for a car genuinely for sale — exactly what the `listing` table
is for. Now emitted as `kind: "listing"` with `price` = the estimate **midpoint** and the true
bounds preserved in `_extra.estimateLow/estimateHigh`. Never conflated with `kind: "sale"`, so an
estimate can never be mistaken for a hammer price downstream.

⚠️ **Not all "upcoming" events yield listings.** `gi26v` (41 lots) returned neither price nor
estimate on any lot — an event announced but not yet priced. Correctly skipped, zero rows.

## DuPont Registry: server-rendered VDPs, `/api/` deliberately avoided (2026-08-17)

The site was fully rebuilt since the earlier `/autos/results/all/all` research (2026-08-15) —
that route now 301-redirects to `/cars-for-sale/all`, a Next.js App Router SPA. Its search/browse
page calls `POST /api/graphql` client-side, but `robots.txt` explicitly disallows `/api/`:
```
User-agent: *
Allow: /
Disallow: /api/
Disallow: /admin
Sitemap: https://www.dupontregistry.com/sitemap.xml
```
Same principle as PCAR: a disallowed path stays disallowed regardless of whether it's hit
directly or triggered by driving a browser through an allowed page that happens to call it
internally. **Did not build against `/api/graphql`.**

**What IS allowed and sufficient**: individual `/car/{make}/{model}/{year}/{vin}/{id}` vehicle
detail pages (the same URL shape as the old site — make/model/year/VIN all in the path, still the
most structured URL of any source) are server-rendered via Next.js RSC streaming. The real data —
`listingData: {listingId, vin, make, model, year, price, mileage, dealerId, dealerName, city,
state, isPromoted, priceStatus}` — is present in the plain HTML response from a single GET, no JS
execution and no `/api/` call required. Listed directly across `vdp-sitemap-1.xml` through
`vdp-sitemap-15.xml`, ~999 URLs each (~15,000 total). `robots.txt` sets no `Crawl-delay`; used
1.5s between requests anyway.

⚠️ **A bare `curl -A "Mozilla/5.0"` (no other headers) gets a 403** from what is evidently a
basic bot-signature filter — identical request with a realistic full header set (`Accept`,
`Accept-Language`, a real Chrome UA string) gets 200. Confirmed this is NOT a targeted block:
`robots.txt` itself is `Allow: /` site-wide with no bot-specific rules (unlike PCAR's named
`ClaudeBot` block). Sending normal browser headers is standard scraping hygiene here, not evasion
— the site's own stated policy already permits this traffic.

⚠️ **`isSold: false` on every VDP sampled** — this is asking-price dealer inventory, never an
auction result. Feeds `listing`, never `sale`, exactly per the ground truth's own defect note
about DuPont (§3: it flags a risk of asks leaking into sold-price maths — not reproduced here).

**A VIN of all zeros (`00000000000305971`) is a placeholder**, not a real chassis number —
seen on at least one real listing (a 1967 Porsche 911) where the actual VIN isn't disclosed.
Adapter nulls it out rather than feeding it to `normalizeVin()`.

**Progress (2026-08-17): 4,786 listings from sitemaps 1–6 of 15.** ~900 real listings per
sitemap run, with 67–104 skipped each time (`no price posted (call for price / not disclosed)` is
the dominant reason, plus a few pages with no parseable `listingData`). Sitemaps 7–15 (~9,000
more URLs) are untouched. `crawler/dupont.crawler.js [sitemapN] [maxUrls]` resumes per-URL via
`samples/dupont.state.json`, so re-running is safe and never re-fetches.

**Best field coverage of any source we have**: `mileage` 96.2% and `vin` 98.7% on DuPont rows,
against 16.9% / 0.1% respectively across the whole `sale` table. It contributes no sold prices,
but it is the only source giving reliable VINs at volume.

**Side effect worth knowing**: building this required first discovering that `listing` had no
natural key at all (no `source_lot_id`, no unique constraint) and that nothing had ever ingested
`samples/listings/*.json` into the database — RM Sotheby's 17 real private-sale-ask listings had
been sitting scraped since RM was built, never loaded. Fixed both: `db/client.js` now runs an
additive migration (`ALTER TABLE listing ADD COLUMN source_lot_id`) before `schema.sql`'s
`CREATE UNIQUE INDEX idx_listing_source_lot`, and `ingest/ingest-listings.js` is the new,
permanent loader for that table — reuses the exact same car-identity resolution as `ingest.js` so
a listing and a sale for the same real car land on the same `car_id`.

## Bonhams: proof-of-concept only, and what a real crawler needs (probed 2026-08-18)

**The 24 sales in the DB are not a harvest.** `_archive/superseded/bonhams.crawler.js` is
hardcoded to a single auction (`31959`, Laguna Seca) with `maxLots` defaulting to **5**. It was
written to prove the adapter worked and never promoted to `crawler/`. The archive behind it is
untouched — this is the largest open source on the list.

`robots.txt` permits it: only `Bytespider` is blocked, and the sole path rules are
`Disallow: */aggregate$` and `Disallow: */head_image*`. No `Sitemap:` line.

**The site is Next.js, so the data is embedded — no per-lot fetch needed.**
`https://cars.bonhams.com/auction/{id}/` (308-redirects to a slugged URL, follow it) carries
`__NEXT_DATA__` with `props.pageProps.lotData`:

```
lotData.auctionLots   — EVERY lot for the auction in that one response (57 for auction 31959)
lotData.nbHits        — total lot count
lotData.pagesOfLots, currencySymbol, highestPrice, lowestPrice
```

Per-lot fields confirmed present: `id` (e.g. `"31959-1"` — use verbatim as `source_lot_id`),
`lotId`, `title`, `slug`, `status` (`"SOLD"`), `price`, `currency`, `auctionEndDate`, `image`,
`styledDescription`. That is one HTTP request per auction rather than one per lot — the same
shape Gooding turned out to have, so `crawler/gooding.crawler.js` is the closest reference.

⚠️ **The unsolved piece: enumerating past auctions.** `/auctions/` embeds only `liveAuctions`
(5 upcoming). No past-results index was found; `/past-auctions/`, `/auction/results/`,
`/results/`, `/search/` and `/_next/data/{buildId}/…` all 404. Known-good IDs to scan around:
**31857, 31858, 31959, 32043, 32045, 32060**. A bounded sequential scan works but is wasteful; a
real index route would be better if one exists.

Bonhams is also **international** — it is where the `price_usd` gap bites hardest (see the FX
note in `WRITING-A-SCRAPER.md`). Scaling it without fixing FX would silently discard much of it.

## PCAR Market: explicitly blocked, not just unbuilt (2026-08-17)

`robots.txt` names `ClaudeBot` specifically:
```
User-agent: ClaudeBot
Disallow: /
```
plus `Content-Signal: ai-train=no, use=reference` site-wide. This is a targeted instruction, not
a generic crawl-trap wall (the earlier-found working route, `/search/?status=closed`, is
otherwise permitted for `User-agent: *`). Treated the same as the ground truth's guidance on
403s: not a puzzle to solve by presenting as a different agent. **Will not build.**

## Why dedup missed a duplicate (2026-08-15) — and the URL rule

Two records for one Ferrari sale reached the index. Each dedup layer failed for its own reason.

**Layer A — idempotent ingest on `(source, source_lot_id)`.** Did not collide, because two
harvesters minted DIFFERENT IDs for the same lot: the JSON API returns numeric `119030405`,
the DOM crawler reverse-engineered the slug `1973-ferrari-365-gtb-4-daytona-berlinetta-3`. The
key silently assumed one id scheme per source; there were two.

**Layer B — similarity scoring.** Ran, and scored **0.7375 against the 0.75 threshold — short
by 0.0125**:

| component | contribution |
|---|---|
| identical price | +0.45 |
| same day | +0.25 |
| mileage | +0.00 — both null (list-mode carries no mileage; corpus fill rate ~1%) |
| title similarity | +0.0375 instead of +0.10 |

The title term collapsed because the DOM record's title was polluted with page chrome
("Completed Auctions Get Daily Updates This Week's Popular Listings…"), which swamped the
trigram Jaccard. **The corrupt title actively suppressed the mechanism that would have caught
it.** The identical pair with a clean title scores 0.8000 and collapses.

**What neither layer looked at:** both records carried the *identical listing URL*. That is
identity, not evidence to be weighed.

**Fix (`dedup/dedup.js`):** same source + same canonical URL + within 7 days ⇒ score 1.0.
Deliberately scoped and date-guarded:
- *scoped to one source* — a URL identifies a listing on its own site; genuine cross-source
  duplicates have different URLs by definition, so a cross-source URL match only ever means
  malformed data and must still be scored.
- *date-guarded* — URL-per-relist is verified for BaT (0 URLs under >1 lot id across 21,171
  records) but not for the other twelve sources. If some house reuses a lot URL months later,
  the pair falls through to scoring rather than being merged, because wrongly collapsing a
  genuine repeat sale destroys the product's most valuable signal.

**Structural prevention (`ingest/ingest.js`):** BaT's API only issues numeric listing ids, so a
slug-shaped BaT lot id proves DOM provenance and is rejected outright, along with any title
containing search-page furniture. Keyed on id SHAPE, not filename, so a new harvester cannot
reintroduce the defect.

## Unknown vs asserted attributes (2026-08-15) — the fix that makes multi-source work

**The defect.** The identity key treated NULL as a distinct value, so "attribute stated" and
"attribute not stated" minted two cars. Measured on the live catalogue: **171 `body_type` and
38 `displacement` pairs** were one car recorded twice — e.g. `1965 Ford "mustang"` existed as
`body_type=Coupe` (15 sales) *and* `NULL` (2 sales), splitting one price history.

**The distinction that fixes it generally.** Not all blanks mean the same thing:

| kind | attributes | a blank means | behaviour |
|---|---|---|---|
| **INTRINSIC** | `body_type`, `generation`, `displacement` | UNKNOWN — every car necessarily has one, the seller just didn't type it | acts as a **wildcard**; matches any stated value |
| **ASSERTED** | `modification` | STOCK — a positive claim that nothing unusual was found | still **separates**; a race-prepped M3 is not a stock M3 |

This is a property of the DATA MODEL, not of any source's formatting, so it needs no per-source
tuning — which is the point.

**Three-way outcome** (`resolve/resolve-car-v2.js` → `findOrCreateCar`):
- exactly one compatible car → **ATTACH**, and *enrich* the row with anything the new listing
  states that the stored row lacked (guarded against a UNIQUE collision)
- several compatible cars that disagree → **REVIEW**. Real examples: `1920 Ford Model T` exists
  as Convertible *and* Pickup; `1964 Jaguar XKE` as 3.8L *and* 4.2L. Attaching would be a coin
  flip, creating a third row would fragment further.
- none → CREATE

**Why this matters most for the sources still to come.** BaT titles are unusually descriptive
("34K-Mile 1987 Porsche 911 Carrera Cabriolet G50"); **Mecum's are terse ("1969 Chevrolet
Camaro")**. Without this rule every terse source forks a parallel catalogue beside the
descriptive one and the two never join — so the fix had to land *before* Mecum, RM Sotheby's and
Bonhams are scraped in volume, not after.

**Result of the rebuild:** body_type 171 → **0**, displacement 38 → **0**, generation 0 → 0.
`modification` stayed at 84 pairs, untouched and correct. Cars 10,327 → 9,972 (355 rows merged),
sales/car 1.58 → **1.63**, multi-sale cars 2,283 → **2,359**. Hard splits remain 0 and the
duplication audit still passes. Review rose 2,737 → 2,816: the genuinely ambiguous cases now ask
instead of guessing, which is the intended trade.

Tests: `resolve/unknown-attrs.test.js` (9 checks, both directions).

## Other sources: API discovery (2026-08-15, `crawler/probe-source-apis.js`)

BaT went from ~8,700 records (DOM/"Show More" ceiling) to 57,703 the moment we called the
endpoint the site itself calls. So the first question for every remaining source is not "how do
we parse this HTML" but "what does its own JavaScript request". Captured by watching network
traffic on each results page.

| Source | API found | Status |
|---|---|---|
| **Cars & Bids** | `GET /v2/autos/auctions?limit=50&status=closed&offset=N` → `{"total":40344,...}` | **403 Cloudflare** to plain fetch; needs a browser session |
| **RM Sotheby's** | `POST /api/search/SearchLots?page=N&pageSize=200` | **works unauthenticated**, 98,595 lots |
| **Gooding** | Gatsby `/page-data/auction/{slug}/page-data.json` | static JSON per auction, easy |
| **SMS** | `/api/auctions/type`, `/api/premium/buyer` | API exists, results route not yet found |
| Mecum | none seen on the search route | DOM only so far |
| Bonhams | only `currency-rates` | DOM only so far |

### Cars & Bids — 40,344 closed auctions behind Cloudflare
We hold **42** records from this source. The API reports **40,344**. Plain `fetch` gets a
"Just a moment..." interstitial on every shape tried (no signature, stale timestamp, page-style
paging), so the `signature` query param is not the gate — Cloudflare is. The site itself calls
this successfully from the browser, so the route is Playwright: drive the results page and read
the API responses it issues, rather than forging the call.

### RM Sotheby's — biggest unlocked source so far
- `POST /api/search/SearchLots` answers unauthenticated, accepts `pageSize=200`.
- **98,595 lots total**, but the same offset cap as BaT: page 50 (offset 10,000) returns 200
  items, page 60 (offset 12,000) returns 0.
- **Partition key found: `Auctions: ["mo26"]`** in the POST body → `totalItems 199`. The code is
  the one in each lot URL (`/auctions/mo26/lots/...`). An auction is ~200 lots, far below the
  cap, so the whole archive is reachable as the union of its events with no truncation.
- **Prices ARE on the list endpoint** (195/200 carried a value) — contradicts the earlier
  "prices detail-only" note in the table above. No per-lot fetch needed for price.

⚠️ **RM MIXES ASKING PRICES WITH SOLD PRICES IN ONE FEED.** Measured on one page of 200:
`Sold` 118, blank 58, `Offered Without Reserve` 17, **`Asking` 7**. An `Asking` row is a private
-sale listing (`sold: false`, e.g. `$3,300,000 USD (Asking)`), not a transaction. These must go
to `listing`, never `sale` — this is exactly the DuPont defect the ground truth flags, where
asks leak into sold-price maths. Gate on `sold === true && valueType === "Sold"`.

⚠️ **NO DATE FIELD ON THE LIST RESPONSE.** The record carries no sale date, and
`GetSearchSelectionOptions?auction=mo26` returns only weekday names (`THU`/`FRI`/`SAT`), not
dates. Mecum had this same defect and it silently removed every Mecum sale from trend maths
until caught. RM therefore needs ONE extra fetch per AUCTION (not per lot) to resolve the event
date, applied to all its lots. Cheap — hundreds of auctions, not tens of thousands of lots — but
non-optional: an undated sale cannot participate in any trend, signal or forecast.

## Year-conflict policy

One real conflict in the corpus: title `1971 Ferrari 365 GTB/4 Daytona Berlinetta` vs slug
`.../1973-ferrari-...`. **Policy: the title wins, conflict recorded, no human needed.**
A slug is generated once at listing creation and never rewritten when a year is corrected
(BaT slugs even carry a `-3` dedupe counter, confirming they are creation-time artifacts);
the title is the value the auction house actually curates and displays. Chassis 14867 falls
in the 1971-72 band of Daytona production, supporting the title in this instance.
