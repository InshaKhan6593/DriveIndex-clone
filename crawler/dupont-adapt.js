// DuPont Registry record adapter.
//
// Source: individual `/car/{make}/{model}/{year}/{vin}/{id}` vehicle-detail pages, listed
// directly in `vdp-sitemap-{1..15}.xml`. Deliberately NOT the site's `/api/graphql` endpoint —
// robots.txt disallows `/api/`, and this pipeline treats that the same way it treats an
// explicit named bot-block: not a puzzle to route around. The VDP pages don't need it anyway —
// they're server-rendered (Next.js App Router RSC streaming), so the real listing data is
// already sitting in the plain HTML response, no JS execution or API call required.
//
// ⚠️ THIS IS A LISTING SOURCE, NOT A SALE SOURCE. Every record carries `isSold: false` — these
// are asking prices from dealer inventory, never auction results. Populates `listing`, never
// `sale` (ground truth's own defect #5/§3 note: DuPont mixes asks into "auction" data upstream;
// this pipeline does not reproduce that).
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

  if (data.isSold) return { kind: "skip", reason: "marked sold — belongs to whoever ran the actual auction, not here" };

  const title = `${data.year || ""} ${data.make || ""} ${data.model || ""}`.replace(/\s+/g, " ").trim();
  if (!title) return { kind: "skip", reason: "no title" };

  const price = Number(data.price);
  if (!Number.isFinite(price) || price <= 0) return { kind: "skip", reason: "no price posted (call for price / not disclosed)" };

  if (!data.listingId) return { kind: "skip", reason: "no stable lot id" };

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
      fetched_at: new Date().toISOString(),
      _extra: {
        dealerId: data.dealerId || null,
        dealerName: data.dealerName || null,
        city: data.city || null,
        state: data.state || null,
        isPromoted: !!data.isPromoted,
        priceStatus: data.priceStatus ?? null,
      },
    },
  };
}

module.exports = { adaptVdpPage, extractListingData };
