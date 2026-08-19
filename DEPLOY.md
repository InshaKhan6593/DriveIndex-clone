# Deploying — free tier, daily cron, nothing scrapes in production

Production serves a read-only snapshot. The snapshot is rebuilt once a day by a GitHub Actions
workflow, not by the API, and not on your machine.

    daily 16:00 PKT
      job `plan`     decide which sources to run
      job `scrape`   ALL 9 SOURCES IN PARALLEL, one runner each
                     bat(+bat-detail) · cab · mecum · rms · good · sms · broadarrow · dupont · bonhams
      job `build`    fx -> ingest -> ingest:listings -> compute
                       -> data/serving.sqlite
                       -> GitHub Release asset (fixed tag `data-latest`)
                       -> POST Render deploy hook
    Render           fetches the snapshot at build, serves the read API
    Vercel           serves the Next.js frontend

**Every scraper runs.** The full pipeline budgets 505 minutes and GitHub kills a job at 360, so
one long job could never hold it — but the scrapers are independent (each writes its own harvest
file and its own resume marker; only ingest touches the database). Running them as a parallel
matrix gives **each source its own 6-hour budget** instead of a slice of a shared one, and the
whole thing finishes in about as long as the slowest single source.

## What each piece costs


| piece | where | cost | the catch |
|---|---|---|---|
| Frontend | Vercel Hobby | free | none for this workload |
| Read API | Render free web service | free | **spins down after 15 min idle**, ~1 min cold start; 750 instance-hours/month |
| Daily pipeline | GitHub Actions | **free, unlimited** | only because this repo is **public** |
| Snapshot + state storage | GitHub Release assets | free | 2 GB per file |

Two limits are load-bearing, and both are documented rather than assumed:

* **Render's free tier has no cron jobs and no persistent disks.** That is why the pipeline
  cannot live there — it could not run on a schedule, and could not keep the 294 MB working
  database between runs if it could. https://render.com/docs/free
* **GitHub Actions is free and unlimited for public repositories.** If this repo is ever made
  private it falls back to 2,000 minutes/month, which a daily multi-hour run blows through in
  about a week. Make the schedule weekly or move the cron to a local machine if that happens.

## Why no database service

The data is read-only, so it travels with the API instead of living in a hosted database. That
removes a moving part — and on Windows it removes the Turso CLI, which requires WSL, i.e. a
reboot and a Linux install to upload one file.

The snapshot cannot be committed: 167 MB against GitHub's 100 MB file limit. Release assets
allow 2 GB, so that is where it goes.

---

# First-time setup

## 1. Seed the state release  (once, browser upload — no CLI needed)

The workflow **continues** an existing corpus. It must never start from an empty database, so it
fails loudly if this release is missing rather than re-scraping 262k sales from zero.

Pack the four assets (already done once — they are sitting in `data/state-upload/`; re-run only
if you want a fresher seed):

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

Only those two harvest files are carried. Every other crawler resumes from its state marker alone
and just writes a delta, which ingest folds in idempotently on `(source, source_lot_id)` — so the
database already holds whatever an older file contained. Gzip is what makes this cheap: BaT's
harvest is 190 MB raw and 16 MB compressed.

⚠️ The tag must be exactly `state`. The workflow looks it up by name.

## 2. API — Render

Dashboard → New → Blueprint → this repo. [render.yaml](render.yaml) supplies build and start
commands. Set one variable:

    SNAPSHOT_URL   https://github.com/InshaKhan6593/DriveIndex-clone/releases/download/data-latest/serving.sqlite

That URL is **fixed forever** — the workflow replaces the asset in place under the same
`data-latest` tag, so you never edit this value again. (The old flow used a dated tag per
publish and needed a manual dashboard edit every time; that is what this replaces.)

The build downloads the snapshot with `curl -fL`, so a bad URL fails the BUILD loudly instead of
deploying an API with no database, and then opens it to count rows before the service starts.

⚠️ A **private** repo's release assets need a token to download, which the build does not have.
This repo is public, so this works. If you ever make it private, this breaks.

Then: Render → your service → **Settings → Deploy Hook** → copy the URL.

## 3. Frontend — Vercel

Import the repo, **root directory `web`**, and set:

    API_URL       the https://... URL Render gave you
    ACCESS_CODE   the shared login code

## 4. Give Actions the deploy hook

GitHub → repo **Settings → Secrets and variables → Actions → New repository secret**:

    Name:   RENDER_DEPLOY_HOOK
    Value:  the Render deploy hook URL from step 2

Without it the workflow still publishes the snapshot, but warns and skips the redeploy — the API
would keep serving the previous day's data until something else triggers a build.

## 5. Test it before trusting the schedule

GitHub → **Actions → daily → Run workflow**, and set **sources** to `none`. That finishes in
minutes and exercises restore → ingest → compute → export → publish → redeploy without touching a
single auction site — so if something is wrong with Render, the secret, or the state release, you
find out immediately rather than after a four-hour scrape.

Once that is green, run it again with **sources** = `bonhams` (fast, plain fetch, no browser) to
prove a real scrape end-to-end. Then let the schedule take over.

---

# The daily run

[.github/workflows/daily.yml](.github/workflows/daily.yml), `0 11 * * *` UTC = **16:00 (4 PM)
Pakistan time**, which is UTC+5 year-round with no DST to track.

GitHub's scheduler is best-effort: at busy times it starts 15–30 minutes late and it is
occasionally dropped altogether. That is expected rather than a bug to chase — every crawler is
incremental, so a missed day is absorbed by the next run.

## Running specific sources by hand

**Actions → daily → Run workflow** takes a `sources` input:

| input | effect |
|---|---|
| `all` (default) | every source |
| `none` | skip scraping entirely — just ingest whatever is staged, recompute, publish |
| `bat,bonhams` | only those two, each on its own runner |

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
