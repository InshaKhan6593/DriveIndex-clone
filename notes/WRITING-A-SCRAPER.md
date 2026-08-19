# Writing a scraper by hand: the contract, and what's left to build

Companion to `SOURCE-ONBOARDING.md` (which covers *deciding* what to automate). This one covers
the mechanical contract: what your scraper must emit so the rest of the pipeline picks it up
with no further wiring.

---

## 1. The contract — this is all that's required

Write a JSON array to one of two places. Nothing else needs changing; the ingesters glob these
directories.

| what you scraped | write to | loaded by |
|---|---|---|
| completed auction results | `samples/scraped/{source}.json` | `node ingest/ingest.js` |
| asking prices / for-sale inventory | `samples/listings/{source}-listings.json` | `node ingest/ingest-listings.js` |

**Never mix them.** A `listing` is an asking price; a `sale` is a completed transaction. The
whole valuation engine depends on that separation — DuPont asks leaking into sold-price maths is
a defect the ground truth explicitly calls out.

### Required shape (`adapters/schema.js` is the source of truth)

```js
{
  source: "bon",                  // registry code — see SOURCE_CODES in adapters/schema.js
  source_lot_id: "31959-45",      // native stable ID. THE idempotency key.
  url: "https://…",
  title: "2024 Bugatti Chiron Super Sport",   // verbatim, do not clean it up
  sold_at: "2026-08-13T17:00:00.000Z",        // ISO 8601. sales only.
  price: 4570000,                 // in the listed currency, NOT converted
  currency: "USD",                // ISO 4217
  price_usd: 4570000,             // null if you can't convert — see §4
  mileage: 1325,
  vin_raw: "VF9SW3V39RM795109",
  vin_normal: null,               // leave null, the resolver fills it
  color: null, transmission: null, tc: null, options: [], image_url: null,

  is_outlier: false, outlier_note: null, carfax_damage: false,
  non_us_sale: false,
  status: "sold",                 // sold | sold_after | reserve_not_met

  raw_source_shape: "bonhams-nextdata-v1",   // free text, for debugging provenance
  fetched_at: new Date().toISOString(),
}
```

**Rules that actually matter:**

- `(source, source_lot_id)` is a UNIQUE key. Get it stable and re-running is free — the ingester
  upserts, never duplicates. If it isn't stable, every run creates new rows.
- **Keep `title` verbatim.** Resolution, make inference and evidence-scoring all run off the raw
  title. "Helpfully" normalising it destroys signal.
- **A lot with no price is not a $0 sale — skip it.** Bonhams shipped 24 hollow rows this way
  before the adapter was fixed to distinguish "confirmed not sold" from "outcome unknown".
- **`status`, not a boolean.** `reserve_not_met` is a high bid, not a sale; it is displayed but
  excluded from every calculation. Guessing `sold` here corrupts price curves.
- Anything you can't determine → `null`. Never invent a value. Unknown and asserted are
  different things to the resolver.

### Then

```bash
node ingest/ingest.js            # or ingest-listings.js
node jobs/nightly-compute.js     # recompute valuations
node validation/duplication-audit.js && node validation/split-audit.js
```

---

## 2. Reference implementations — copy the closest shape

| pattern | reference | when to use it |
|---|---|---|
| **JSON embedded in the page** (`__NEXT_DATA__`) | `crawler/gooding.crawler.js` | Next.js/Gatsby sites. Best case: one fetch returns a whole auction. |
| **Sitemap-driven, one page per item** | `crawler/dupont.crawler.js` | Server-rendered detail pages, no bulk endpoint. |
| **Sitemap + crawl-delay + emits BOTH kinds** | `crawler/broadarrow.crawler.js` | Where upcoming lots carry estimates worth capturing as listings. |
| **Real API with a record cap** | `crawler/bat-partitioned.crawler.js` | Beats a 10,000-record ceiling by partitioning the query space. |
| **Headless browser, structural selectors** | `crawler/mecum.event.crawler.js` | Client-rendered sites. Selects on STRUCTURE (an `<article>` holding a `/lots/{id}/{slug}/` link), never on CSS-module class hashes that change every deploy. Its adapter is also the reference for sentinel-price and inline-memorabilia gates. |
| **Detail-page enrichment of rows already ingested** | `crawler/bat-detail.crawler.js` | When the list API is missing a field the lot page has. Validates every page against the stored record before writing, and ingest keeps the result with a `COALESCE` upsert so a later list re-scrape cannot wipe it. |
| **Headless browser, text-pattern selectors** | `_archive/superseded/bonhams.crawler.js` | Client-rendered sites. Note it selects on TEXT, never on CSS-in-JS class hashes. |

**Always add a state file** (`samples/{source}.state.json`) keyed per lot or per event, so a
re-run resumes instead of re-fetching. Every crawler here does this; it is why re-running is
cheap and why the cron converges to +0.

---

## 3. What is actually left to build

### Open — robots.txt permits, worth your time

**Bonhams (`bon`) — BUILT since 2026-08-18, no longer an opportunity.** What follows was the
probe that unblocked it, kept because the shape is a good reference and the page-cap trap is
easy to walk back into. The production harvester is `crawler/bonhams.crawler.js` (cron stage
`scrape:bonhams`), carrying **9,864 sales**; 4,359 of the 11,353 sitemap auction ids have been
visited. ⚠️ **The probe finding below is incomplete in one dangerous way**: `auctionLots` is the
FIRST 48 LOTS ONLY, not the whole auction — reading it and stopping cost 71% of the data before
it was caught. See `source-registry.md` -> Bonhams for the `_next/data` route that pages past it.
`robots.txt` only blocks `Bytespider` and disallows `*/aggregate$` and `*/head_image*`;
everything else is `Allow: /`.

Probed 2026-08-18:

- `https://cars.bonhams.com/auction/{id}/` returns `__NEXT_DATA__` containing
  `props.pageProps.lotData.auctionLots` — the auction's FIRST PAGE of lots (48 max; 57 lots
  were reported for auction 31959, which is why this looked complete), plus `nbHits` (the true
  total), `pagesOfLots`, `currencySymbol`, `highestPrice`.
- Per-lot fields present: `id` ("31959-1" — use as `source_lot_id`), `lotId`, `title`, `slug`,
  `status` ("SOLD"), `price`, `currency`, `auctionEndDate`, `image`, `styledDescription`.
- `https://cars.bonhams.com/auctions/` exposes only `liveAuctions` (5 upcoming). **Past auction
  IDs are not indexed there** — that is the one unsolved problem. Known-good IDs: 31857, 31858,
  31959, 32043, 32045, 32060. A bounded sequential scan around these works; a real past-results
  index would be better if you can find one.
- No `Sitemap:` line in robots.txt.

**Classic.com (`classic`).** Fully permissive (`Allow: /`; only `/chart-data/`, `/garage/*`,
`/partners/*`, `/tracker/*`, `/sell/list-your-car/` disallowed). ⚠️ It is an **aggregator** —
`SOURCE_TRUST 9`, staging-only per the build spec, **never authoritative**. Its real value is
indirect: it aggregates across houses we cannot reach directly, so it can partially cover
Barrett-Jackson / Hagerty / Collecting Cars. Treat anything from it as a lead, not a fact.

The implementation is `crawler/classic.crawler.js` plus `crawler/classic-adapt.js`. It uses the public
past-auction and vehicle detail pages, stores data in `samples/staging/classic-leads.json`, and
preserves the upstream auction-house URL. It refuses a sold lead without an explicit USD price,
sale date, and upstream URL. It is intentionally not a cron stage and must never write to
`samples/scraped/` or `samples/listings/`.

### Already built — just needs running, no new code

| source | remaining | command |
|---|---|---|
| **Mecum** | **131 of 186 discovered events** — the largest block of data on this list, and it needs no new code. Not a cron stage, so nothing advances it unless you run it | `node crawler/mecum.event.crawler.js run [n]` |
| Bring a Trailer | lot-page enrichment: ~152k lots still without mileage/VIN, draining at 150/run | `node crawler/bat-detail.crawler.js [nLots]` |
| Bonhams | 6,994 of 11,353 sitemap auction ids unvisited (~93% will be another department) | `node crawler/bonhams.crawler.js [budget]` |
| Broad Arrow | 975 of ~2,730 lots done, 10s crawl-delay | `node crawler/broadarrow.crawler.js auto` |
| DuPont Registry | 5,969 of 13,814 sitemap URLs done | `node crawler/dupont.crawler.js auto 999` |

**BaT's partition walk is finished** — all 224 partition x sort units are complete. What is left
there is not coverage of the partition space but BaT's own 10,000-result-per-query ceiling: 11
partitions exceed it, so no combination of sorts reaches all of German/sold (~69.9k) or
American/sold (~66.5k). Breaking those needs partitions narrower than 10k (by year or price band
inside a category), which is new code, not a re-run.

### Capped

**Sotheby's Motorsport (`sms`)** — 729 lots exist, anonymous access returns 15 and pagination is
gated behind a session. This pipeline does not create accounts, so it stopped there.

### Blocked, and why — read this before writing anything for them

These are three genuinely different situations, and the difference matters:

| source | what's in the way | note |
|---|---|---|
| **Collecting Cars** | `User-agent: *` is `Allow: /, Crawl-delay: 1`. Separately blocks `ClaudeBot`, `anthropic-ai`, `GPTBot`, `CCBot` by name | The named blocks are aimed at AI crawlers specifically. A generic crawler is not disallowed by their robots.txt — but their **Terms of Service**, not robots.txt, is the real question. Check it. |
| **PCAR Market** | `ClaudeBot → Disallow: /` | Same distinction as above. |
| **Barrett-Jackson**, **Hagerty**, **Cars.com** | `robots.txt` itself returns **403** | You cannot read their terms, so you cannot establish permission. Treated as closed. |

⚠️ **Mecum used to be in this table and has been removed — do not put it back.** Its robots.txt
prose prohibits automated collection *"without prior written permission from Mecum Auctions"*,
and **the operator obtained that written permission on 2026-08-18**. That is why
`crawler/mecum.event.crawler.js` exists and why the source now carries **49,038 sales**. The
grant is to a NAMED PARTY, not a general finding: if it lapses, stop running the crawler — the
standing data stays, collection stops. Note it is run BY HAND; there is no `scrape:mecum` stage
in `jobs/stages.js`.

Nothing in this repo routes around any of these. Where a block names an AI crawler specifically
it is a rule about AI crawling, and whether it applies to a scraper you write and run yourself
is a question for the site's ToS and your own judgement — not something this pipeline decides
for you.

---

## 4. Two fixes worth doing while you're in there

**FX conversion — DONE, don't rebuild it.** `fx/fetch-ecb-rates.js` stores the ECB daily
reference series (2013-01-02 onward) and `fx/convert.js` converts at the rate **on `sold_at`**,
never today's. Every priced sale in the database now carries a `price_usd`; the 1,838 rows
without one are `price = 0` bought-in Bonhams lots with no published bid. Your scraper should
emit `price` + `currency` and let ingest stamp `price_usd` — do not convert yourself, and never
guess a rate.

⚠️ Two things this did NOT fix, and you should know both. The ECB series starts 2013-01-02, so a
non-USD sale dated earlier converts to `null` rather than a wrong number — Mecum reaches back to
2012 but is USD-only, so nothing is affected today. And a correct `price_usd` does not make a
sale count: `engine/clean.js` has a second, independent gate, `non_us_sale`, which holds 8,954
priced overseas sales out of the maths on purpose. See the README.

**Condition / grade.** Still the single biggest quality gap in the whole system. Deal Radar
rejects a large share of its candidates because nothing distinguishes a project car from a
concours car, so a big "discount" is ambiguous. No source we have exposes a condition grade. If a
source you scrape does — even a coarse one — capture it; it is worth more than raw volume.

**Mileage on a source that has none.** BaT's is now being closed by
`crawler/bat-detail.crawler.js` (lot page, one GET, validated against the stored record before
anything is written). **Mecum and Bonhams have exactly the same hole** — 49,038 and 9,864 sales
at ~0% odometer — and no equivalent harvester. Copying that crawler's shape for either is the
highest-value work left. ⚠️ Do not parse mileage out of titles: only *notably low* readings get
stated there, so a title regex harvests a low-mileage-biased subsample and makes every mileage
adjustment systematically wrong. Measured on the real bat-detail harvest, the median lot is
42,000 miles — nothing like what titles suggest.
