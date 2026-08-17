// Adapter for RM Sotheby's. PARTIAL — built from the results-index sample
// (samples/raw/rm-sothebys-1.json), which gives title/price/sold-status/lot# per row but
// not VIN/mileage/color/transmission. Those live on the individual lot detail page
// (confirmed reachable, e.g. /auctions/mo26/lots/r0170-1996-mclaren-f1-gtr/ — but the lot
// URL slug is chassis-derived, not derivable from the lot number alone, so a real crawler
// has to follow the link from the results-index page rather than construct the URL).
//
// TODO before this is production-ready: capture one full lot detail page and extend this
// adapter with chassis number (RM's name for VIN on pre-war/vintage cars — feed it through
// the same normalizeVin() used for everything else; the spec's `>= 11 char` floor exists
// specifically to admit these), mileage, colors, transmission.

const SOURCE = "rms";

function parsePriceField(row) {
  // RM shows either a hammer price ("$758,500 USD") when Sold, or a pre-sale estimate
  // RANGE ("$300,000 - $400,000 USD") when Not Sold. A range is not a transaction —
  // never treat it as `price`.
  if (row.result !== "Sold") return null;
  const raw = row.price || "";
  const n = Number(raw.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {object} row - one entry from lots_sample in samples/raw/rm-sothebys-1.json
 * @param {{auctionName: string, auctionCode: string}} auctionMeta
 * @returns {Partial<import('./schema').NormalizedSale>} PARTIAL — vin/mileage/color/tc are null until detail-page capture lands
 */
function adaptRmSothebys(row, auctionMeta) {
  const reserve_not_met = row.result === "Not Sold";
  const price = parsePriceField(row);

  return {
    source: SOURCE,
    source_lot_id: `${auctionMeta.auctionCode}-${row.lot}`, // RM has no single global lot ID exposed client-side; composite key from auction code + lot number
    url: null, // needs the detail-page href, not present in the list-row sample
    title: row.title,
    sold_at: null, // needs detail page or auction end date; list view doesn't show per-lot timestamp
    price,
    currency: "USD", // Monterey lots are USD; Zürich/London/Munich auctions will need real currency parsing — untested this session
    price_usd: price, // only valid while currency === "USD"; do NOT assume this once non-USD auctions are ingested
    mileage: null, // NOT YET CAPTURED — detail page
    vin_raw: null, // NOT YET CAPTURED — RM calls this "Chassis No." on the detail page
    vin_normal: null,
    color: null, // NOT YET CAPTURED
    transmission: null, // NOT YET CAPTURED
    tc: null,
    options: [],
    image_url: null,

    is_outlier: false,
    outlier_note: null,
    carfax_damage: false,
    non_us_sale: false,
    reserve_not_met,

    raw_source_shape: "rm-sothebys-results-list-v1-PARTIAL",
    fetched_at: new Date().toISOString(),

    _extra: {
      collection: row.collection || null, // e.g. "The Quadrifoglio Collection" — RM groups lots into named collections, worth keeping for provenance/marketing copy even though it's not in the core sale schema
      auction_name: auctionMeta.auctionName,
      lot_number: row.lot,
    },
  };
}

module.exports = { adaptRmSothebys };
