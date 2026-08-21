// Shared transitions for sources that emit both listing and sale records.
// A closed listing is retained for audit/history; the is_active flag controls whether it appears
// in the current For Sale view.
"use strict";

function closeListingFromSale(existing, sale) {
  if (!existing) return null;
  return {
    ...existing,
    price: sale.price ?? existing.price ?? null,
    currency: sale.currency || existing.currency || "USD",
    is_active: false,
    listing_status: sale.status === "sold_after" ? "sold_after" : "sold",
    price_type: "sold",
    current_bid: null,
    closed_at: sale.sold_at || existing.closed_at || null,
    status_reason: null,
    fetched_at: sale.fetched_at || new Date().toISOString(),
  };
}

function closeListingAsEnded(existing, closedAt, reason) {
  if (!existing) return null;
  return {
    ...existing,
    is_active: false,
    listing_status: "ended",
    current_bid: null,
    closed_at: closedAt || existing.closed_at || null,
    status_reason: reason || "source no longer reports an active listing",
    fetched_at: new Date().toISOString(),
  };
}

module.exports = { closeListingFromSale, closeListingAsEnded };
