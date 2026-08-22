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

  -- Ranking inputs, computed once per night rather than per request (see engine/ranking.js).
  -- trend_se     : standard error of the fitted slope — how noisy the trend actually is.
  -- trend_lcb    : conservative end of the annualised-return interval.
  -- trend_score  : trend_lcb shrunk toward the market mean by degrees of freedom. THIS is what
  --                leaderboards order by; annual_return is the headline number to DISPLAY.
  --                Ranking on annual_return directly puts 3-sale artifacts on top.
  trend_se REAL,
  trend_lcb REAL,
  trend_score REAL,

  -- WHICH SALES THIS NUMBER CAME FROM. 'own' = this exact model-year's sales. 'model-window' =
  -- pooled from the same make/model/body across year +/- SCOPE_HALF_WIDTH, used ONLY when the
  -- car's own sales cannot produce a signal at all. Measured: 91.1% of "insufficient" cars have
  -- one or two sales IN EXISTENCE, so no amount of harvesting reaches them — but 11,558 of them
  -- sit inside a model line that does have history. Never silently: a pooled number carries its
  -- scope so the UI can say "based on 1965-1969, 47 sales" instead of implying it is the car's
  -- own record.
  signal_scope   TEXT,     -- 'own' | 'model-window'
  scope_from     INTEGER,  -- first model-year pooled
  scope_to       INTEGER,  -- last model-year pooled
  scope_n        INTEGER,  -- clean sales in the pool

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
  is_active     INTEGER,
  -- Lifecycle fields are source-neutral. They let an auction move from live -> sold/bid_to/
  -- withdrawn without treating a high bid or an asking price as a completed sale.
  listing_type  TEXT, -- 'auction' | 'classified'
  listing_status TEXT, -- live | upcoming | sold | sold_after | bid_to | reserve_not_met | withdrawn | ended | unknown
  price_type    TEXT, -- current_bid | asking | estimate | high_bid | sold
  current_bid   INTEGER,
  estimate_low  INTEGER,
  estimate_high INTEGER,
  ends_at       TEXT,
  closed_at     TEXT,
  status_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_listing_source_lot ON listing (source, source_lot_id);

-- User-owned portfolio data. These tables deliberately sit outside the serving snapshot: the
-- daily market pipeline replaces global car/sale/valuation rows, but must never replace a user's
-- garage. In production they live in the same Turso database as the read API and are left out of
-- db/load-turso.js's diff tables so daily publishes and rollbacks preserve them.
CREATE TABLE IF NOT EXISTS app_user (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS garage_vehicle (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  car_id           TEXT NOT NULL REFERENCES car(id),
  nickname         TEXT,
  purchase_price   INTEGER CHECK (purchase_price IS NULL OR purchase_price >= 0),
  purchase_date    TEXT,
  current_mileage  INTEGER CHECK (current_mileage IS NULL OR current_mileage >= 0),
  fees             INTEGER NOT NULL DEFAULT 0 CHECK (fees >= 0),
  vin              TEXT,
  color            TEXT,
  transmission     TEXT,
  options          TEXT NOT NULL DEFAULT '[]',
  notes            TEXT,
  status           TEXT NOT NULL DEFAULT 'owned' CHECK (status IN ('owned', 'sold', 'archived')),
  sold_at         TEXT,
  sold_price      INTEGER CHECK (sold_price IS NULL OR sold_price >= 0),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (user_id, vin)
);
CREATE INDEX IF NOT EXISTS idx_garage_vehicle_user_status ON garage_vehicle (user_id, status);
CREATE INDEX IF NOT EXISTS idx_garage_vehicle_car ON garage_vehicle (car_id);

CREATE TABLE IF NOT EXISTS garage_valuation_snapshot (
  id                 TEXT PRIMARY KEY,
  garage_vehicle_id  TEXT NOT NULL REFERENCES garage_vehicle(id) ON DELETE CASCADE,
  snapshot_date      TEXT NOT NULL,
  market_value       INTEGER,
  mileage_used       INTEGER,
  base_value         INTEGER,
  computed_at        TEXT NOT NULL,
  UNIQUE (garage_vehicle_id, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_garage_snapshot_vehicle_date
  ON garage_valuation_snapshot (garage_vehicle_id, snapshot_date DESC);

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
  -- 'sale' | 'listing'. The queue is shared by both pipelines, and their record shapes are NOT
  -- interchangeable: a listing has no sold_at / price_usd / outlier_note. Without this marker
  -- validation/reprocess-queue.js replayed every row through the SALE path, fed a listing to
  -- insertSale(), and aborted the whole 47k-row run on the first one it hit.
  kind                  TEXT NOT NULL DEFAULT 'sale' CHECK (kind IN ('sale','listing')),
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
