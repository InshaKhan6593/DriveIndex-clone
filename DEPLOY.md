# Deploying (snapshot model — nothing scrapes in production)

Crawling, ingest and compute run on YOUR machine. Production serves a read-only snapshot.
Data updates when you push a new snapshot, not on its own. No cron, by design, for now.

    local:   crawl -> ingest -> compute -> data/driveindex.sqlite   (248 MB)
    export:  node db/export-serving.js  ->  data/serving.sqlite     (160 MB)
    upload:  serving.sqlite -> Turso
    serve:   Render (API, reads Turso)  ->  Vercel (Next.js frontend)

Everything below has been verified locally against the real snapshot: all endpoints answer
200 through the hosted driver, and `/api/health` reports `{"ok":true,"cars":64296,"hosted":true}`.

## 1. Database — Turso

    curl -sSfL https://get.tur.so/install.sh | bash
    turso auth signup

    node db/export-serving.js
    turso db create driveindex --from-file data/serving.sqlite

    turso db show driveindex --url
    turso db tokens create driveindex

Keep the URL and the token.

## 2. API — Render

Dashboard -> New -> Blueprint -> this repo. `render.yaml` supplies build and start commands.
Set two environment variables (they are `sync: false`, so they never enter the repo):

    TURSO_DATABASE_URL   the libsql:// url from step 1
    TURSO_AUTH_TOKEN     the token from step 1

`TURSO_DATABASE_URL` is the switch: present, db/client.js uses the hosted database; absent, it
looks for a local file that is not in the repo, so the variable is not optional.

Render is used rather than a serverless host because `libsql` is a native module and this keeps
one warm connection in a normal Node process instead of opening a handle per cold start.

## 3. Frontend — Vercel

Import the repo, root directory `web`, and set:

    API_URL   the https://... URL Render gave you

That Vercel URL is what goes to the client.

## Updating the data later

    node db/export-serving.js
    turso db create driveindex-v2 --from-file data/serving.sqlite
    # point TURSO_DATABASE_URL at v2 in Render, redeploy, then:
    turso db destroy driveindex

Turso will not overwrite an existing database from a file, so a new one is created and the URL
swapped. About a minute, and the old database stays intact until the new one is serving.

## Notes

* `playwright` and `crawlee` are devDependencies — they belong to the crawlers, and the API
  never loads them. `render.yaml` installs with `--omit=dev` so no browser binaries are
  downloaded for a service that does not scrape.
* The snapshot keeps `car_resolution_queue` as an EMPTY table rather than dropping it:
  api/server.js queries it in two places and dropping it returns 500 from both.
* `data/` is gitignored. The snapshot is never committed; it is uploaded.
