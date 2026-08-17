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
| **Headless browser, text-pattern selectors** | `_archive/superseded/bonhams.crawler.js` | Client-rendered sites. Note it selects on TEXT, never on CSS-in-JS class hashes. |

**Always add a state file** (`samples/{source}.state.json`) keyed per lot or per event, so a
re-run resumes instead of re-fetching. Every crawler here does this; it is why re-running is
cheap and why the cron converges to +0.

---

## 3. What is actually left to build

### Open — robots.txt permits, worth your time

**Bonhams (`bon`) — the biggest opportunity.** 24 sales collected of a real archive.
DriveIndex's #5 source (3.4% of their mix), and international, so it also fills the
currency gap. `robots.txt` only blocks `Bytespider` and disallows `*/aggregate$` and
`*/head_image*`; everything else is `Allow: /`.

Probed 2026-08-18, hand this straight to your scraper:

- `https://cars.bonhams.com/auction/{id}/` returns `__NEXT_DATA__` containing
  `props.pageProps.lotData.auctionLots` — **every lot for the auction in ONE fetch** (57 lots
  for auction 31959), plus `nbHits`, `pagesOfLots`, `currencySymbol`, `highestPrice`.
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

### Already built — just needs running, no new code

| source | remaining | command |
|---|---|---|
| Bring a Trailer | 4 partitions unstarted (~130k sales: German/sold ~69.8k, American/sold ~66.4k, Truck & 4x4, Convertibles) | `node crawler/bat-partitioned.crawler.js run` |
| Broad Arrow | 25 of 33 events (~2,200 lots, 10s crawl-delay) | `node crawler/broadarrow.crawler.js {eventCode}` |
| DuPont Registry | sitemaps 7–15 (~9,000 listings) | `node crawler/dupont.crawler.js {n} 999` |

That BaT figure is the single largest block of data available anywhere on this list, and it
needs no new scraper at all.

### Capped

**Sotheby's Motorsport (`sms`)** — 729 lots exist, anonymous access returns 15 and pagination is
gated behind a session. This pipeline does not create accounts, so it stopped there.

### Blocked, and why — read this before writing anything for them

These are three genuinely different situations, and the difference matters:

| source | what's in the way | note |
|---|---|---|
| **Mecum** | robots.txt prose prohibits data mining "for any commercial purposes" and for developing software/ML/AI | This binds **anyone**, not just bots. We keep the 7,300 sales already collected but add none. |
| **Collecting Cars** | `User-agent: *` is `Allow: /, Crawl-delay: 1`. Separately blocks `ClaudeBot`, `anthropic-ai`, `GPTBot`, `CCBot` by name | The named blocks are aimed at AI crawlers specifically. A generic crawler is not disallowed by their robots.txt — but their **Terms of Service**, not robots.txt, is the real question. Check it. |
| **PCAR Market** | `ClaudeBot → Disallow: /` | Same distinction as above. |
| **Barrett-Jackson**, **Hagerty**, **Cars.com** | `robots.txt` itself returns **403** | You cannot read their terms, so you cannot establish permission. Treated as closed. |

Nothing in this repo routes around any of these. Where a block names an AI crawler specifically
it is a rule about AI crawling, and whether it applies to a scraper you write and run yourself
is a question for the site's ToS and your own judgement — not something this pipeline decides
for you.

---

## 4. Two fixes worth doing while you're in there

**FX conversion.** 1,114 EUR/GBP/CHF sales currently have `price_usd = null` and are dropped
from every calculation — `engine/clean.js` gates on it. This gets much worse the moment Bonhams
scales, since it is the international source. If your scraper can populate `price_usd` using the
FX rate **at `sold_at`** (not today's rate), those sales become usable immediately.

**Condition / grade.** The single biggest quality gap in the whole system. Deal Radar rejects
198 of 363 candidates because nothing distinguishes a project car from a concours car, so a
large "discount" is ambiguous. No source we have exposes a condition grade. If a source you
scrape does — even a coarse one — capture it; it is worth more than raw volume.
