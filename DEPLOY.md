# Deploying — free tier, daily cron, nothing scrapes in production

Production serves a read-only snapshot. The snapshot is rebuilt once a day by a GitHub Actions
workflow, not by the API, and not on your machine.

    daily 04:00 America/New_York (DST-aware)
      job `plan`     decide which sources to run
      job `scrape`   ALL 10 SOURCES IN PARALLEL, one runner each, recent mode
                     bat(+bat-detail) · cab · mecum · rms · good · sms · broadarrow · dupont · bonhams · bj
      job `build`    fx -> ingest -> ingest:listings -> compute
                       -> data/serving.sqlite
                       -> push the DIFF into Turso   (what the API reads)
                       -> GitHub Release asset, tag `data-latest`  (rollback + tomorrow's diff base)
    Vercel           serves the API (serverless) and the Next.js frontend
    Turso            holds the data the API queries

**Every configured source can run.** Scheduled execution uses recent mode; historical backfills
are manual. The full pipeline budgets 505 minutes and GitHub kills a job at 360, so
one long job could never hold it — but the scrapers are independent (each writes its own harvest
file and its own resume marker; only ingest touches the database). Running them as a parallel
matrix gives **each source its own 6-hour budget** instead of a slice of a shared one, and the
whole thing finishes in about as long as the slowest single source.

## What each piece costs


| piece | where | cost | card needed? | the catch |
|---|---|---|---|---|
| Frontend | Vercel Hobby | free | **no** | none for this workload |
| Read API | Vercel serverless | free | **no** | cold start of a second or two |
| Data | Turso free tier | free | **no** | 5 GB storage, **10M row writes/month** — see below |
| Daily pipeline | GitHub Actions | free, unlimited | **no** | only because this repo is **public** |
| Snapshot + state storage | GitHub Release assets | free | **no** | 2 GB per file |

Nothing here asks for a payment method. That is the reason for the shape.

Three limits are load-bearing, and all three are measured rather than assumed:

* **Turso allows 10 million row writes per month.** The snapshot is 361,234 rows, so reloading
  it daily would be 10.8M — over the cap on day one, and it grows every day. This is why
  `db/load-turso.js` pushes only the DIFF against the previously published snapshot, which is
  about 70k rows a day (~2.1M/month) because nightly-compute rewrites every valuation while
  sales are append-mostly.
* **GitHub Actions is free and unlimited for public repositories.** If this repo is ever made
  private it falls back to 2,000 minutes/month, which a daily multi-hour run exhausts in about a
  week. Make the schedule weekly, or move the cron to a local machine, if that happens.
* **Render was the original plan and was dropped.** Its free tier has no cron jobs and no
  persistent disks (https://render.com/docs/free), and in practice it asked for a card for
  identity verification. Nothing here needs it. `render.yaml` is kept because that path still
  works if you ever want it, but it is not part of the deployment.

## Why Turso, when the whole design avoided a database

Because a serverless function cannot carry a 178 MB file, and going serverless is what removes
the need for a card. The read-only design is otherwise unchanged: production still never scrapes,
still never computes, and still only reads.

`db/client.js` already spoke hosted libSQL — that path was built and tested and simply unused.
The stated blocker was that loading data into it needed the Turso CLI, which on Windows means
WSL. **That blocker is gone**: the daily workflow runs on Ubuntu, and `db/load-turso.js` writes
through the `libsql` package directly, so no CLI is involved at all.

One thing this BUYS, beyond avoiding the card: **there is no redeploy step any more.** Under the
file-snapshot model the API had to be rebuilt to see new data. Reading from Turso, the rows
change and the very next request sees them.

The snapshot is still published to `data-latest` on every run. It is the rollback point, and it
is what the next day's run diffs against — so it costs nothing extra to keep.

Each successful build also stores an **immutable `pipeline-snapshot-<run_id>-<attempt>` artifact**
for 90 days. It contains the compressed working database, serving snapshot, crawler resume state,
the carried-forward harvest files, a manifest with row counts and run inputs, and `SHA256SUMS`.
The rolling `state` and `data-latest` releases are still used by the next run; the immutable
artifact is the history that makes a rollback possible. Per-source scraper diagnostics and build
logs are retained for 30 days, while the larger per-run harvest artifacts are retained for 3 days.

---

# First-time setup

## 1. Seed the state release  (once, browser upload — no CLI needed)

The workflow **continues** an existing corpus. It must never start from an empty database, so it
fails loudly if this release is missing rather than re-scraping 262k sales from zero.

Pack the four bootstrap assets (already done once — they are sitting in `data/state-upload/`; re-run
only if you want a fresher seed). Barrett-Jackson's harvest is optional at bootstrap: the first
successful BJ run creates `barrettjackson.json.gz` and the workflow adds it to the rolling state
automatically.

```bash
node -e "const{DatabaseSync}=require('node:sqlite');const fs=require('fs');fs.mkdirSync('data/state-upload',{recursive:true});fs.rmSync('data/state-upload/driveindex.sqlite',{force:true});new DatabaseSync('data/driveindex.sqlite',{readOnly:true}).exec(\"VACUUM INTO 'data/state-upload/driveindex.sqlite'\")"
```

`VACUUM INTO` rather than a file copy on purpose: it takes a transactionally consistent copy even
while the API holds the file open, and it compacts as it goes (294 MB → 269 MB → 77 MB gzipped).

```bash
gzip -f data/state-upload/driveindex.sqlite && tar -czf data/state-upload/crawler-state.tar.gz $(find samples -name '*.state.json') data/fx-rates.json
```

```bash
gzip -c samples/scraped/bat-partitioned.json > data/state-upload/bat-partitioned.json.gz && gzip -c samples/scraped/cars-and-bids.json > data/state-upload/cars-and-bids.json.gz
```

Then on GitHub: **Releases → Draft a new release → tag `state`** → title "Pipeline state
(internal)" → attach **all four** files from `data/state-upload/` → Publish.

| asset | size | who needs it |
|---|---|---|
| `driveindex.sqlite.gz` | 77 MB | the `build` job — the corpus itself |
| `crawler-state.tar.gz` | 0.4 MB | every scrape job — the resume markers |
| `bat-partitioned.json.gz` | 16 MB | the `bat` job — `bat-detail` writes enrichment into it |
| `cars-and-bids.json.gz` | 6 MB | the `cab` job — it decides when to stop by what it already has |

Only the harvest files that crawlers read back are carried. Every other crawler resumes from its
state marker alone and just writes a delta, which ingest folds in idempotently on
`(source, source_lot_id)` — so the database already holds whatever an older file contained. Gzip
is what makes this cheap: BaT's harvest is 190 MB raw and 16 MB compressed.

⚠️ The tag must be exactly `state`. The workflow looks it up by name.

## 2. Turso — the database the API reads

Sign up at **https://turso.tech** (GitHub login, no card). Then:

1. **Create a database** — any name, e.g. `driveindex`. **Region: `iad` (Ashburn, Virginia).**

   ⚠️ Not "closest to you", and not closest to the client either — **closest to the API**.
   Vercel Functions default to `iad1` (Washington DC) and Hobby plans get exactly one region, so
   `iad` puts the database in the same metro as the code querying it. A car detail page issues
   **6 separate queries**; at cross-country latency that is ~420ms of pure waiting per page, and
   next door it is single digits. Both `vercel.json` files pin `iad1` to keep the pair together.

   If you ever need US West instead, move BOTH: Turso `sjc` and Vercel `sfo1`. Splitting them is
   the worst of both.
2. On its page, copy the **Database URL**. It looks like `libsql://driveindex-<you>.turso.io`.
3. **Create a token** for it (Turso calls this an auth token / database token). Copy it — it is
   shown once.

Nothing to load by hand: the workflow pushes the data in step 5.

## 3. Add both to GitHub Actions

GitHub → **Settings → Secrets and variables → Actions → New repository secret**, twice:

    TURSO_DATABASE_URL    libsql://....turso.io
    TURSO_AUTH_TOKEN      the token from step 2

Without these the run still completes and publishes the snapshot, but warns and skips the load —
so the API would serve whatever it already had. That is deliberate: a missing secret should not
throw away a four-hour scrape.

## 4. API — Vercel (a second project, root = repo root)

**https://vercel.com/new** → import the repo.

- **Root Directory**: leave as the repository root (do NOT set it to `web` — that is the other
  project, in step 6)
- Environment variables:

```
TURSO_DATABASE_URL   same value as the secret above
TURSO_AUTH_TOKEN     same value as the secret above
SESSION_SECRET       a long random value shared with the frontend project
```

[vercel.json](vercel.json) routes every path to `api/index.js`, which hands the request to the
Express app in `api/server.js` unchanged — Vercel invokes a module export as `(req, res)`, and
that is exactly what an Express app is. `db/client.js` sees `TURSO_DATABASE_URL` and connects to
the hosted database instead of a local file, so nothing in the API needed rewriting.

✅ **Check:** `https://<api-project>.vercel.app/api/health` → `{"ok":true,"cars":...,"hosted":true}`

Note `hosted: true` — that is how you know it is reading Turso and not a file.

⚠️ Until step 5 runs, the database is empty and this returns `cars: 0`. That is correct at this
point, not a failure.

## 5. Load the data

GitHub → **Actions → daily → Run workflow** → **sources = `none`**.

This restores the corpus, recomputes, exports, and pushes everything into Turso. The first load
is the big one — all 361,234 rows, about 3.6% of the monthly write budget in one go. Every run
after it pushes only the diff.

✅ **Check:** the log shows a per-table breakdown ending in `remote matches the snapshot`, and
`/api/health` now reports the real car count.

## 6. Frontend — Vercel (the second project)

**https://vercel.com/new** → import the **same repo again**.

- **Root Directory**: set it to **`web`** ← the one thing people miss
- Environment variables:

```
API_URL       https://<api-project>.vercel.app
ACCESS_CODE   your shared login code
SESSION_SECRET same long random value used by the API project
```

✅ **Check:** the URL loads `/login`, your code gets you in, the catalogue renders, and a car
detail page, `/trending` and `/deals` all load.

The Garage uses an anonymous browser profile derived from a signed session. Its holdings and
daily valuation snapshots live in Turso, not in `data-latest` or the pipeline state release, so
the daily market rebuild and rollback workflows cannot overwrite them. Keep `SESSION_SECRET`
identical in both Vercel projects; without it, the frontend cannot authenticate garage requests
to the API. Clearing browser cookies intentionally creates a new empty profile.

## 7. Prove a real scrape end to end

Run the workflow again with **sources = `bonhams`** — fast, plain fetch, no browser.

✅ **Check:** the `scrape (bonhams)` job is green, the harvest summary shows a bonhams record
count, the Turso load reports a small diff rather than 361k rows, and the site shows the new
data **without any redeploy** — that last part is the whole point of reading from Turso.

---

# The daily run

[.github/workflows/daily.yml](.github/workflows/daily.yml) runs at **04:00 US Eastern local time**.
The workflow uses GitHub's timezone-aware schedule, so daylight saving time is handled.

GitHub's scheduler is best-effort: at busy times it starts 15–30 minutes late and it is
occasionally dropped altogether. That is expected rather than a bug to chase — every crawler is
incremental, so a missed day is absorbed by the next run.

## Running specific sources by hand

**Actions → daily → Run workflow** takes `sources`, `mode`, and `recent_days` inputs:

| input | effect |
|---|---|
| `none` (manual default) | skip scraping; ingest/recompute the existing staged data |
| `all` (schedule behavior) | every source's recent path |
| `bj` | only Barrett-Jackson's current and previous event years |
| `bat,bonhams` | only those two, each on its own runner |

Use `mode=recent` (the default) for a date-current refresh. Use `mode=full` only for an intentional
historical backfill. Barrett-Jackson also requires the repository secret `BJ_PROXY_URL`; a desktop
browser VPN is not inherited by a GitHub-hosted runner.

An unknown name **fails the run** rather than quietly producing an empty matrix, which would look
like a green run that scraped nothing. Test the selection logic locally without GitHub:

```bash
SOURCES=bat,bonhams node .github/scripts/plan-sources.js
```

Locally, the same selection is `--only` / `--skip` on the cron itself:

```bash
node jobs/cron.js --only=scrape:bonhams,scrape:rms
```

```bash
node jobs/cron.js --skip=scrape:bat --deadline-minutes=90
```

## Four sources that need watching, and why

None of these are excluded any more — but they are the ones most likely to fail quietly, so check
them in the first few runs rather than assuming.

| source | what to watch for |
|---|---|
| `cab` | drives a browser past Cloudflare. A datacenter IP is challenged more often than your home connection, so this is the likeliest to return 0 records from a runner. If it does, run it locally and let the daily job pick the results up. |
| `dupont` | bot-signature filter, same risk. It already needs a full realistic header set to get a 200 at all. |
| `bat-detail` | runs in the same job as `bat`, immediately after it, never in parallel — both rewrite `bat-partitioned.json` and concurrent writes would lose records. |
| **`mecum`** | ⚠️ **Permission-gated.** Their robots.txt bars automated collection *"without prior written permission from Mecum Auctions"*; you obtained that on 2026-08-18. It is a grant to **you as a named party**, so running it from GitHub's shared infrastructure is your call, not an engineering default. **If the permission lapses, delete the `scrape:mecum` line from `jobs/stages.js`** — the 49k standing sales remain, only collection stops. |

`.github/scripts/summarise-harvest.js` runs before ingest and prints record count and date range
per file, so a source that silently returned nothing is visible in the log the same day rather
than a week later when you notice the numbers stopped moving.

## ⚠️ One writer at a time

The `state` release is the single source of truth for the working database. If you run anything
locally that writes to `data/driveindex.sqlite` — any crawler, `ingest`, or `compute` — while the
cloud copy is also moving forward, **the next upload silently discards whichever side uploaded
first.**

So before a local writing run:

1. Download `driveindex.sqlite.gz` from the `state` release and replace `data/driveindex.sqlite`.
2. Run what you want (`node crawler/cab.crawler.js`, `node crawler/mecum.event.crawler.js run`, …).
3. Re-pack and re-upload the assets, as in step 1 of setup.

Now that every source runs in the cloud, the usual reason to run one locally is that it came back
empty from a runner — `cab` and `dupont` are the candidates. In that case the local run is a
*repair*, so the pull-run-push order matters: pull first or you will overwrite a day of cloud
progress with a stale copy.

Or simply do local runs at a time the workflow is not running, and accept that the daily job will
pick your work up on its next pass — the database it downloads is the one you uploaded.

## Guards built into the run

* **`--deadline-minutes=240` per source** — GitHub kills a job at 6 hours. Past the deadline a
  runner stops *starting* new work rather than being killed mid-write, so its harvest and resume
  marker are still uploaded. Backlogs drain over following days, which is how the crawlers are
  designed to work anyway. Override it per run from the **Run workflow** form.
* **`fail-fast: false`** on the scrape matrix — one auction site being down must not cancel the
  other eight runners.
* **`max-parallel: 6`** — politeness, not a limit GitHub imposes. Opening nine scrapers at once
  from one IP range is exactly the traffic shape that gets an IP range blocked.
* **`build` runs `if: always()`** — a dead source must not stop the day's recompute and publish.
  Without it a single failed scrape would mean no snapshot at all.
* **`--skip=`, not an allowlist** — it names what is excluded, so a stage added to
  `jobs/stages.js` later runs by default instead of being silently dropped. A typo in a stage
  name exits 2 rather than quietly skipping nothing.
* **Exit code 1 is success.** `jobs/cron.js` returns 0 clean, 1 when a source failed but the
  pipeline ran, 2 when the pipeline itself failed. One auction site being down must not fail the
  day, so only 2 fails the workflow.
* **The snapshot is row-counted before publishing** — a zero-car export is refused rather than
  deployed over good data.
* **State is saved even when scraping failed** (`if: always()`), so a partial day is not thrown
  away.
* **Every source writes a diagnostic artifact** with its exit code, timestamps, harvest counts/date
  range, and the last 80 scraper log lines. A source returning zero records is therefore visible in
  both the job summary and a downloadable 30-day artifact.
* **The immutable snapshot is checksum- and row-count-validated** before it is stored, so a
  rollback cannot silently restore a truncated database.
* **`concurrency: pipeline`** — a late run waits instead of racing; two runs would fight over the
  state release and one side's work would vanish.
* **Lock files are never carried between machines.** `data/cron.lock` names a PID that means
  nothing on a runner, so it is excluded from the state tarball and deleted on restore.

## Updating data by hand

Everything still works manually — the workflow just automates it:

```bash
node jobs/cron.js
```

```bash
node db/export-serving.js
```

Then attach `data/serving.sqlite` to the `data-latest` release (replacing the existing asset) and
hit the Render deploy hook, or just let the next scheduled run do both.

## Rolling back a bad build

If a scraper or mapper produced a bad but technically valid update, open **Actions → Roll back
pipeline snapshot → Run workflow**. Enter the `run_id` and `run_attempt` of the good daily run,
then type `ROLLBACK` in the confirmation field. The workflow verifies `SHA256SUMS`, opens both
SQLite files, checks their manifest row counts, diffs the target serving snapshot against the
current `data-latest`, loads that diff into Turso, and only then replaces the rolling `state` and
`data-latest` assets. The run keeps validation/publish logs as a 90-day artifact.

The rollback workflow requires `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`. It refuses to perform
an unbounded full Turso reload if the current `data-latest` asset is missing, because that could
consume the free-tier write budget unexpectedly. A rollback does not delete the newer immutable
artifacts, so you can choose another snapshot afterward if needed.

## Region pinning — why `iad1` is in both vercel.json files

Recorded here because it cannot be recorded where it belongs: `vercel.json` is validated against
a schema with `additionalProperties: false`, so a `_comment` key fails the deploy with
*"should NOT have additional property"*. JSON has no comments, so this is the note.

Both [vercel.json](vercel.json) (API) and [web/vercel.json](web/vercel.json) (frontend) pin
`"regions": ["iad1"]`, and the Turso database is in `aws-us-east-1`. All three are the same
metro — Northern Virginia — on purpose.

The reason is the query pattern, not where anyone lives. `/api/cars/:id` issues **6 separate
database queries**; the whole API makes 26 across its routes. Every millisecond between the
function and the database is paid per query, so ~70 ms of cross-country distance is ~420 ms of
dead time on one page load. The visitor's own distance is paid once, and static assets come from
whichever CDN edge is nearest them regardless of this setting.

**If you ever move the database, move all three together.** Turso `sjc` with Vercel `sfo1`, or
Turso `iad` with Vercel `iad1`. A split pair is the worst case and it fails silently — the site
still works, it is just slow, and nothing reports it. Hobby plans allow exactly one region, so
there is no hedging.

## Notes

* Free Render services sleep when idle — the first request after a quiet period takes ~1 minute.
  Worth hitting the URL yourself before showing anyone.
* `playwright` and `crawlee` are devDependencies; the API and the daily workflow both install
  with `--omit=dev`, which keeps browser binaries out of both.
* The snapshot keeps `car_resolution_queue` as an EMPTY table rather than dropping it —
  api/server.js queries it in two places and dropping it returns 500 from both.
* `DB_READONLY=1` opens the file read-only, so anything that tries to write fails loudly rather
  than silently mutating a snapshot that gets replaced on the next deploy.
* Harvest JSONs (`samples/scraped/*.json`, ~700 MB) are deliberately **not** carried between
  runs. Ingest is idempotent on `(source, source_lot_id)`, so the database already holds every
  record they contained; each run's files are just that run's delta.
* If you later want a live database instead, db/client.js still supports TURSO_DATABASE_URL —
  that path is built and tested, it just needs WSL on Windows to load the data.
