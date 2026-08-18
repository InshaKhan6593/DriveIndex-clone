# Deploying — snapshot model, nothing scrapes in production

Crawling, ingest and compute run on YOUR machine. Production serves a read-only snapshot that
only changes when you publish a new one. No cron, by design, for now.

    local:   crawl -> ingest -> compute -> data/driveindex.sqlite   248 MB
    export:  node db/export-serving.js  ->  data/serving.sqlite     160 MB
    publish: serving.sqlite -> GitHub Release asset  (2 GB limit)
    serve:   Render fetches it at build  ->  Vercel serves the frontend

## Why no database service

The data is read-only, so it travels with the API instead of living in a hosted database. That
removes a moving part — and on Windows it removes the Turso CLI, which requires WSL, i.e. a
reboot and a Linux install to upload one file.

The snapshot cannot be committed: 160 MB against GitHub's 100 MB file limit. Release assets
allow 2 GB, so that is where it goes.

Verified locally against the real snapshot: /api/health returns
{"ok":true,"cars":64296,"hosted":false} and cars/trending/deals/detail all answer 200 with the
file opened READ-ONLY.

## 1. Publish the snapshot  (browser, no CLI)

    node db/export-serving.js

Then on GitHub: Releases -> Draft a new release -> tag `data-2026-08-18` -> attach
`data/serving.sqlite` -> Publish. Right-click the uploaded asset and copy its link. It looks
like:

    https://github.com/<you>/<repo>/releases/download/data-2026-08-18/serving.sqlite

A PRIVATE repo's release assets need a token to download, which the build does not have. If the
repo is private, either make it public or upload the file somewhere the build can reach
unauthenticated.

## 2. API — Render

Dashboard -> New -> Blueprint -> this repo. `render.yaml` supplies build and start commands.
Set one variable:

    SNAPSHOT_URL   the release asset link from step 1

The build downloads the snapshot with `curl -fL`, so a bad URL fails the BUILD loudly instead of
deploying an API with no database, and then opens it to count rows before the service starts.

## 3. Frontend — Vercel

Import the repo, root directory `web`, set:

    API_URL   the https://... URL Render gave you

That Vercel URL is what goes to the client.

## Updating the data later

    node db/export-serving.js

Publish a new release (`data-2026-08-25`), update SNAPSHOT_URL in Render, redeploy. The old
release stays as a rollback point.

## Notes

* Free Render services sleep when idle — the first request after a quiet period takes ~30s.
  Worth hitting the URL yourself before showing anyone.
* `playwright` and `crawlee` are devDependencies; the API never loads them, and `--omit=dev`
  keeps browser binaries out of the deploy.
* The snapshot keeps `car_resolution_queue` as an EMPTY table rather than dropping it —
  api/server.js queries it in two places and dropping it returns 500 from both.
* `DB_READONLY=1` opens the file read-only, so anything that tries to write fails loudly rather
  than silently mutating a snapshot that gets replaced on the next deploy.
* If you later want a live database instead, db/client.js still supports TURSO_DATABASE_URL —
  that path is built and tested, it just needs WSL on Windows to load the data.
