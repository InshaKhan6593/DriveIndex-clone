-- SQLite port of the build spec's data model (notes/... / MEMORY: driveindex-clone-project §2).
-- Postgres -> SQLite adaptations made here:
--   cuid()        -> generated in JS (crypto.randomUUID()), stored as TEXT PRIMARY KEY
--   TEXT[]        -> TEXT column holding a JSON array (SQLite has no native array type)
--   BOOL          -> INTEGER 0/1 (SQLite has no native boolean type)
--   TIMESTAMPTZ   -> TEXT, ISO 8601
--   NUMERIC       -> REAL

CREATE TABLE IF NOT EXISTS car (
  id              TEXT PRIMARY KEY,
  year            INTEGER NOT NULL,
  year_end        INTEGER,
  make            TEXT NOT NULL,
  model           TEXT NOT NULL,   -- human-readable, original token order
  -- Canonical identity key: lowercased, punctuation-stripped, tokens SORTED and deduped.
  -- This is what makes "R8 V10 Performance Coupe Quattro" and "R8 V10 Performance Quattro
  -- Coupe" resolve to ONE car instead of two (ground truth §7 found 163 such near-duplicate
  -- pairs in DriveIndex's own catalogue).
  model_key       TEXT NOT NULL,
  generation      TEXT,
  body_type       TEXT,
  -- Singer / RWB / engine-swap / replica. Part of identity on purpose — a Singer 911 is a
  -- different asset from a stock 911 and must never share its price curve.
  modification    TEXT,
  -- Engine displacement ("3.6L", "427ci"). Structured rather than left inside model_key,
  -- because it is genuinely identity-bearing for some models (964 Turbo 3.6 vs 3.3,
  -- Diablo VT 6.0 vs VT) and pure noise for others. As a column the comparison is exact.
  displacement    TEXT,
  msrp            INTEGER,
  image_url       TEXT,
  description     TEXT,
  views           INTEGER DEFAULT 0,
  hp              INTEGER,
  zero_sixty      REAL,
  production      INTEGER,
  spec_src        TEXT,
  -- Identity is the CANONICAL key, not the display string. body_type is part of it because
  -- a Coupe and a Cabriolet of the same model-year are genuinely different price points
  -- (ground truth §7: "coupe still separate from cabriolet").
  UNIQUE (year, make, model_key, body_type, generation, modification, displacement)
);
CREATE INDEX IF NOT EXISTS idx_car_lookup ON car (year, make, model_key);

CREATE TABLE IF NOT EXISTS car_valuation (
  car_id                  TEXT PRIMARY KEY REFERENCES car(id),
  computed_at             TEXT NOT NULL,

  current_value           INTEGER,
  median_price            INTEGER,
  price_low               INTEGER,
  price_high              INTEGER,
  peak_price               INTEGER,
  from_peak                REAL,
  avg_mileage               INTEGER,
  retained_value             REAL,
  market_repricing            REAL,

  signal                       TEXT,
  confidence                    REAL,
  annual_return                  REAL,
  recent_return                   REAL,
  volatility                       REAL,

  forecast_1y INTEGER, forecast_3y INTEGER, forecast_5y INTEGER,
  bear_3y INTEGER, bull_3y INTEGER, bear_5y INTEGER, bull_5y INTEGER,
  projection_confidence REAL,
  estimated_bottom_value INTEGER,
  estimated_bottom_years REAL,
  estimated_bottom_status TEXT,

  monthly_indices TEXT, -- JSON[12]
  month_counts    TEXT, -- JSON[12]
  best_months     TEXT, -- JSON[]
  worst_months    TEXT, -- JSON[]
  seasonal_strength REAL,
  buy_discount_pct   REAL,
  sell_premium_pct    REAL,

  collectibility_score   INTEGER,
  collectibility_reasons TEXT, -- JSON[]
  liquidity_tier         TEXT,
  sales_per_year          REAL,
  days_between_sales       INTEGER,
  class_rank                 INTEGER,

  sales_count INTEGER, outlier_count INTEGER,
  recent_sales_count INTEGER, listings_count INTEGER,

  has_transmission_split INTEGER,
  has_option_split        INTEGER,
  data_basis                TEXT, -- 'auction' | 'listing'
  value_basis                 TEXT, -- 'signal' | 'listing'

  -- §4.10 / §4.11 / §4.8 outputs, persisted rather than re-derived at read time. The
  -- buy/hold/sell call depends on the NUMERIC confidence score and the annual return
  -- together (§4.10), so recomputing it in the serialiser from stored columns alone would
  -- risk drifting from what the engine actually decided. Store the decision, not the inputs.
  segment              TEXT,
  buy_hold_sell        TEXT,
  buy_hold_sell_copy   TEXT,
  liquidity_verdict    TEXT,
  liquidity_copy       TEXT,
  months_of_supply     REAL
);

CREATE TABLE IF NOT EXISTS sale (
  id            TEXT PRIMARY KEY,
  car_id        TEXT REFERENCES car(id),
  source        TEXT NOT NULL,
  source_lot_id TEXT,
  url           TEXT,
  title         TEXT,
  sold_at       TEXT NOT NULL,
  price         INTEGER NOT NULL,
  currency      TEXT DEFAULT 'USD',
  price_usd     INTEGER,
  mileage       INTEGER,
  vin           TEXT,
  vin_normal    TEXT,
  color         TEXT,
  transmission  TEXT,
  tc            TEXT,
  options       TEXT, -- JSON[]
  image_url     TEXT,
  repeat_group  TEXT,

  is_outlier      INTEGER DEFAULT 0,
  outlier_note    TEXT,
  carfax_damage   INTEGER DEFAULT 0,
  non_us_sale     INTEGER DEFAULT 0,

  -- DELIBERATE DIVERGENCE from DriveIndex (their defect #7). They store reserveNotMet as a
  -- BOOLEAN, which cannot represent Cars & Bids' third outcome state `sold_after` — missed
  -- reserve, then sold later by negotiation. That is a materially different price signal:
  -- it IS a real transaction (unlike a plain reserve-not-met high bid) but at a negotiated
  -- rather than competitive price. Stored as an enum so it can be treated as its own class.
  --   'sold'            — clean competitive sale, counts in the maths
  --   'sold_after'      — sold post-auction by negotiation, real transaction, weight separately
  --   'reserve_not_met' — high bid only, no sale, excluded from the maths
  status          TEXT NOT NULL DEFAULT 'sold' CHECK (status IN ('sold','sold_after','reserve_not_met')),
  reserve_not_met INTEGER GENERATED ALWAYS AS (CASE WHEN status = 'reserve_not_met' THEN 1 ELSE 0 END) VIRTUAL,

  UNIQUE (source, source_lot_id)
);
CREATE INDEX IF NOT EXISTS idx_sale_car_sold ON sale (car_id, sold_at DESC);
CREATE INDEX IF NOT EXISTS idx_sale_vin ON sale (vin_normal) WHERE vin_normal IS NOT NULL;

CREATE TABLE IF NOT EXISTS listing (
  id            TEXT PRIMARY KEY,
  car_id        TEXT REFERENCES car(id),
  source        TEXT,
  -- Native id at the source, mirroring `sale`'s idempotency key. Added 2026-08-17: the table
  -- had no natural key at all until then, so a re-scrape had no way to update an existing
  -- listing rather than insert a second copy of it. (Pre-existing rows get this backfilled via
  -- db/client.js's migration step, since SQLite can't add a column with CREATE TABLE IF NOT
  -- EXISTS once the table already exists.)
  source_lot_id TEXT,
  url           TEXT,
  price         INTEGER,
  currency      TEXT,
  mileage       INTEGER,
  vin           TEXT,
  vin_normal    TEXT,
  color         TEXT,
  transmission  TEXT,
  tc            TEXT,
  image_url     TEXT,
  dom           INTEGER,
  price_history TEXT, -- JSON [{date,price,change}]
  first_seen_at TEXT,
  last_seen_at  TEXT,
  is_active     INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_listing_source_lot ON listing (source, source_lot_id);

-- NOT in the original DriveIndex spec — our own addition, implementing the review-queue
-- principle the spec's methodology text implies but doesn't expose client-side (§4.5):
-- "Below confidence threshold -> human review queue, never a silent guess." A scraped sale
-- that can't be confidently resolved to a car_id lands here instead of either being dropped
-- or being force-matched to the wrong model-year.
CREATE TABLE IF NOT EXISTS car_resolution_queue (
  id                    TEXT PRIMARY KEY,
  source                TEXT NOT NULL,
  source_lot_id         TEXT,
  raw_title             TEXT,
  extracted_year        INTEGER,
  extracted_make        TEXT,
  extracted_model       TEXT,
  best_candidate_car_id TEXT,
  best_candidate_score  REAL,
  status                TEXT DEFAULT 'pending', -- pending | resolved | rejected
  -- WHY this item is here. The queue was unusable without it: a reviewer opening
  -- "1974 Jensen Healey 5-Speed" could see the title and nothing about what the pipeline
  -- could not decide, so every item required re-deriving the problem by hand. A queue whose
  -- items cannot be triaged is a queue nobody works.
  reason                TEXT,
  -- Coarse bucket for triage, so a reviewer can work one KIND of problem at a time instead of
  -- context-switching between "is this a marque?" and "are these the same car?".
  reason_class          TEXT,
  created_at            TEXT NOT NULL,
  raw_record_json       TEXT NOT NULL, -- full normalized sale record, so it can be re-ingested once a human resolves it

  -- ONE QUEUE ROW PER LOT, ENFORCED.
  --
  -- Without this, every scheduled ingest re-queued every unresolved lot. Measured after four
  -- runs: 25,734 queue rows for 12,843 distinct lots — the same title waiting four times. A
  -- queue that grows on each cron tick is a queue nobody works, which quietly defeats the whole
  -- "human review rather than bad data" policy.
  UNIQUE (source, source_lot_id)
);
