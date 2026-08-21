// DuPont Registry record adapter.
//
// Source: individual `/car/{make}/{model}/{year}/{vin}/{id}` vehicle-detail pages, listed
// directly in `vdp-sitemap-{1..15}.xml`. Deliberately NOT the site's `/api/graphql` endpoint —
// robots.txt disallows `/api/`, and this pipeline treats that the same way it treats an
// explicit named bot-block: not a puzzle to route around. The VDP pages don't need it anyway —
// they're server-rendered (Next.js App Router RSC streaming), so the real listing data is
// already sitting in the plain HTML response, no JS execution or API call required.
//
// ⚠️ THIS IS A LISTING SOURCE, NOT A SALE SOURCE. Asking prices from dealer inventory populate
// `listing`, never `sale`. When the VDP explicitly reports isSold=true, that signal closes the
// existing listing row; it still does NOT fabricate a sale because DuPont is not the auction
// result source (ground truth's own defect #5/§3 note).
"use strict";

// The RSC stream backslash-escapes nested JSON (`\"listingData\":{...}`), and the object itself
// is flat (no nested braces in any field seen), so a simple balanced-brace scan from the first
// `{` after the key is robust to field order/additions without needing a full RSC parser.
function extractBalancedObject(text, openBraceIdx) {
  let depth = 0;
  for (let i = openBraceIdx; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") { depth--; if (depth === 0) return text.slice(openBraceIdx, i + 1); }
  }
  return null;
}

function extractListingData(html) {
  const key = html.indexOf("listingData");
  if (key === -1) return null;
  const open = html.indexOf("{", key);
  if (open === -1) return null;
  const raw = extractBalancedObject(html, open);
  if (!raw) return null;
  // Undo the RSC stream's backslash-escaping before parsing as JSON.
  const unescaped = raw.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  try { return JSON.parse(unescaped); } catch { return null; }
}

// A VIN of all zeros (with maybe one trailing real digit) is a placeholder some dealers post
// when the real VIN isn't disclosed — not a real chassis number, so don't feed it to
// normalizeVin() as if it were one.
function isPlaceholderVin(vin) {
  return !vin || /^0{8,}\d?$/.test(vin);
}

function adaptVdpPage(html, url) {
  const data = extractListingData(html);
  if (!data) return { kind: "skip", reason: "no listingData found on page" };

  const title = `${data.year || ""} ${data.make || ""} ${data.model || ""}`.replace(/\s+/g, " ").trim();
  if (!title) return { kind: "skip", reason: "no title" };

  if (!data.listingId) return { kind: "skip", reason: "no stable lot id" };

  const sold = data.isSold === true || /^(?:true|sold)$/i.test(String(data.isSold || ""));
  const price = Number(data.price);
  const hasPrice = Number.isFinite(price) && price > 0;
  if (sold) {
    return {
      kind: "listing",
      record: {
        source: "dupont",
        source_lot_id: String(data.listingId),
        url,
        title,
        price: hasPrice ? price : null,
        currency: "USD",
        mileage: Number.isFinite(Number(data.mileage)) ? Number(data.mileage) : null,
        vin_raw: isPlaceholderVin(data.vin) ? null : data.vin,
        color: null,
        transmission: null,
        tc: null,
        image_url: null,
        is_active: false,
        listing_type: "classified",
        listing_status: "sold",
        price_type: "sold",
        current_bid: null,
        estimate_low: null,
        estimate_high: null,
        ends_at: null,
        closed_at: data.soldAt || data.soldDate || null,
        status_reason: "DuPont VDP explicitly reported isSold=true",
        fetched_at: new Date().toISOString(),
        _extra: { isSold: true, sourceStatus: data.status || null },
      },
    };
  }

  if (!hasPrice) return { kind: "skip", reason: "no price posted (call for price / not disclosed)" };

  return {
    kind: "listing",
    record: {
      source: "dupont",
      source_lot_id: String(data.listingId),
      url,
      title,
      price,
      currency: "USD", // dealer inventory site, USD-only in every sample observed
      mileage: Number.isFinite(Number(data.mileage)) ? Number(data.mileage) : null,
      vin_raw: isPlaceholderVin(data.vin) ? null : data.vin,
      color: null,
      transmission: null,
      tc: null,
      image_url: null,
      is_active: true,
      listing_type: "classified",
      listing_status: "live",
      price_type: "asking",
      current_bid: null,
      estimate_low: null,
      estimate_high: null,
      ends_at: null,
      closed_at: null,
      status_reason: null,
      fetched_at: new Date().toISOString(),
      _extra: {
        dealerId: data.dealerId || null,
        dealerName: data.dealerName || null,
        city: data.city || null,
        state: data.state || null,
        isPromoted: !!data.isPromoted,
        priceStatus: data.priceStatus ?? null,
        isSold: false,
      },
    },
  };
}

module.exports = { adaptVdpPage, extractListingData };
