# Data sourcing strategy — what to build vs. what to clone

Researched 2026-08-14. Goal: stop hand-scraping page-by-page and figure out what already
exists, so the pipeline is built on top of free, non-LLM tooling wherever possible.

## Bottom line

There is **no single off-the-shelf tool that covers all 13 sources**. The market splits
into three buckets:

| Bucket | Sources | What to do |
|---|---|---|
| **Free, open-source scraper exists** | Cars & Bids | Clone and adapt. |
| **No dedicated scraper, but a reusable free framework fits** | RM Sotheby's, Bonhams, Mecum, Barrett-Jackson, Gooding, Broad Arrow, Hagerty Marketplace, DuPont Registry, PCAR, Collecting Cars, Sotheby's Motorsport | Build a thin adapter per site on top of one shared crawler engine (Crawlee). This is normal — these are auction houses, not tech companies; nobody has open-sourced a scraper for them because the audience is tiny. |
| **Paid-only tooling found, no free option** | Bring a Trailer, Classic.com | Every BaT/Classic.com scraper I found is a paid Apify actor or RapidAPI listing ($). Building our own adapter is the free path, but see the compliance note below — this is also the pair with the most explicit anti-scraping posture. |

## Recommended crawler engine: Crawlee (not Scrapy, not an LLM scraper)

**[Crawlee](https://crawlee.dev)** — Apache-2.0, free, built by the Apify team, available for
Node.js and Python. Picked over Scrapy because:
- Native Playwright integration — most of these auction sites are JS-rendered SPAs (React/Next.js), so a plain HTTP+HTML scraper (what Scrapy assumes by default) will often get an empty shell.
- Built-in request queue, automatic retries, and a `RequestQueue` dedup key — the idempotent-ingest layer from the build spec (unique key = `source + source_lot_id`) maps directly onto it.
- Zero LLM involvement, zero per-request API cost — it's a library you run on your own infrastructure, not a hosted service you pay per call.

Scrapy is more mature (62k+ GitHub stars) and is the better choice *if* a source turns out
to be server-rendered HTML with no JS — worth falling back to per-source if a Crawlee/Playwright
run turns out to be overkill for a given site.

**Not recommended:** Apify's hosted actors (paid per run), Parse.bot / RapidAPI listings (paid,
third-party, and you'd be trusting a stranger's unaudited scraper with your production pipeline),
any "AI web scraper" that calls an LLM per page (unnecessary cost — every field on these sites
is in structured HTML/JSON, not free text that needs an LLM to parse).

## Per-source status

<!-- V = hands-on verified this session, browser-accessible · B = blocked in this sandbox · R = researched only -->

| Source | Status | Notes |
|---|---|---|
| **Cars & Bids** | **V** — real sample captured | Server-rendered detail page, clean spec table (see `samples/raw/cars-and-bids-1.json`). Existing free scraper: [BrianOyollo/carsnbids-scraper](https://github.com/BrianOyollo/carsnbids-scraper) — MIT license, Python + Selenium, safe to clone/adapt commercially. `robots.txt` disallows only `/sell-car/`, `/widgets`, `/dealers` — auction result pages are unrestricted. |
| **RM Sotheby's** | **V** — real sample captured | `/results/` is the real results index (not a guessable `/auctions/{code}/lots/` URL — confirmed live). Results list shows price *or* estimate-range + Sold/Not Sold status per lot — that's their reserve-not-met signal. No existing free scraper found; build a Crawlee adapter. |
| **Bring a Trailer** | **B** — blocked by this session's browsing policy | Couldn't inspect directly here. Every scraper I found (Apify ×4, RapidAPI, Parse.bot) is paid third-party — no free/open repo exists. This is also the source most associated with anti-scraping enforcement in the auction-data space; **confirm ToS and rate-limit posture with a lawyer before building an automated pipeline against it**, independent of the tooling question. |
| **Bonhams** | not yet pulled | `robots.txt` (cars.bonhams.com) blocks only `*/aggregate` and `*/head_image*` patterns — lot pages look open. Next up. |
| **Mecum** | not yet pulled | WebFetch couldn't reach `robots.txt` (bot-protection likely); browser access untested this session. |
| **Classic.com** | not yet pulled | `robots.txt` is permissive (`Allow: /`, blocks only `/chart-data/`, `/garage/*`, `/partners/*`, `/tracker/*`). Remember: per the build spec, this is an **aggregator** — treat anything scraped from it as a staging/backfill row, never authoritative, never counted in `sales_count`. |
| **Barrett-Jackson, Gooding, Broad Arrow, Hagerty Marketplace, DuPont Registry, PCAR, Collecting Cars, Sotheby's Motorsport** | not yet researched individually | No dedicated scrapers found for any of them in this pass. Same plan as RM Sotheby's: thin Crawlee adapter each, once the engine is scaffolded. |

## Licensing flag on the one other GitHub option

[dreamingspires/auction-scraper](https://github.com/dreamingspires/auction-scraper) is a
genuinely well-designed extensible scraper (abstract base class per site, already supports
eBay/LiveAuctioneers/Catawiki) and its *architecture* is worth copying — but it's
**GPL-3.0**. That's a copyleft license: pulling its code directly into a closed-source
commercial product can obligate you to release derivative work under GPL too. Safe use here is
"read it for the adapter-interface pattern, write our own implementation" — not "npm/pip
install it into the product." Flagging this explicitly rather than deciding it for you, since
it's a legal call, not a technical one.

## Proposed shape

```
driveindex-pipeline/
  adapters/
    schema.js            <- done: the normalized `sale` record every adapter must return
    cars-and-bids.js      <- done: real adapter, built from the captured sample
    rm-sothebys.js        <- done: partial, results-list fields only
    <source>.js            <- one per remaining source, same shape
  dedup/
    dedup.js              <- done: VIN normalizer/validator + cross-source duplicate scorer, from the build spec
  crawler/                <- not yet scaffolded — Crawlee-based fetch layer, one job per source,
                              writing into samples/raw/ before adapters normalize it
```

## What I'd do next, in order

1. Clone `carsnbids-scraper`, swap its output shape to match `adapters/schema.js` — fastest path to a working end-to-end source.
2. Scaffold the Crawlee project (`npm init`, `crawlee`, `playwright`) and write the RM Sotheby's adapter against it, since we already have verified real fields for it.
3. Bonhams next — it's the multi-currency forcing function the build spec recommended tackling early.
4. Get an explicit answer on BaT before writing anything against it — compliance risk, not a tooling gap.
