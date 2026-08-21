// Pure Hagerty Marketplace mapper.
//
// Hagerty uses one Marketplace for two different datasets:
//   * live classified/auction inventory -> listing
//   * ended auction outcomes -> sale, but only when the page says Sold for/Sold after
//
// Keeping this mapper independent from Playwright makes the source gates testable against
// captured page text and prevents a selector change from silently turning a high bid into a
// sold price.
"use strict";

const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11,
};

const USD_SYMBOLS = { $: "USD", "€": "EUR", "£": "GBP", "¥": "JPY" };
const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i;

function sourceLotId(url) {
  const s = String(url || "");
  const uuid = s.match(UUID_RE);
  if (uuid) return uuid[1].toLowerCase();
  const parts = s.split(/[/?#]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1].slice(0, 160) : null;
}

function parseMoney(raw) {
  const s = String(raw || "").replace(/\u00a0/g, " ").trim();
  const m = s.match(/([€£$¥])\s*([\d][\d,]*(?:\.\d+)?)/);
  if (!m) return null;
  const amount = Number(m[2].replace(/,/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { amount, currency: USD_SYMBOLS[m[1]] || "USD" };
}

function isoDate(year, month, day, hour = 0, minute = 0) {
  const d = new Date(Date.UTC(year, month, day, hour, minute));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Hagerty has used ISO dates, US numeric dates, and prose dates in different Marketplace
// surfaces. The reference date is passed by the crawler so tests and replays are deterministic.
function parseHagertyDate(raw, referenceNow = new Date()) {
  const text = String(raw || "").replace(/\u00a0/g, " ").trim();
  if (!text) return null;

  const iso = text.match(/\b(20\d{2})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/);
  if (iso) return iso[4]
    ? new Date(iso[0]).toISOString()
    : isoDate(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));

  const numeric = text.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/);
  if (numeric) {
    const y = Number(numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3]);
    return isoDate(y, Number(numeric[1]) - 1, Number(numeric[2]));
  }

  const prose = text.match(/\b(?:mon|tue|wed|thu|fri|sat|sun)(?:day)?[,]?\s+([a-z]+)\s+(\d{1,2})(?:[,]?\s+(\d{4}))?(?:\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm))?/i)
    || text.match(/\b([a-z]+)\s+(\d{1,2})(?:[,]?\s+(\d{4}))?(?:\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm))?/i);
  if (!prose) return null;
  const month = MONTHS[prose[1].toLowerCase()];
  if (month == null) return null;
  const year = Number(prose[3] || referenceNow.getUTCFullYear());
  let hour = Number(prose[4] || 0);
  const minute = Number(prose[5] || 0);
  if (prose[6]) {
    const pm = prose[6].toLowerCase() === "pm";
    if (hour === 12) hour = 0;
    if (pm) hour += 12;
  }
  return isoDate(year, month, Number(prose[2]), hour, minute);
}

function titleFromText(text, suppliedTitle) {
  if (suppliedTitle && String(suppliedTitle).trim()) {
    const candidate = String(suppliedTitle).replace(/\s+/g, " ").trim();
    if (!/^(view|details|learn more|place bid|bid now)$/i.test(candidate)) return candidate;
  }
  const lines = String(text || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  return lines.find((line) =>
    /\b(19|20)\d{2}\b/.test(line)
    && !/^(sold for|bid to|withdrawn|reserve|ending|current bid|place bid|auction results)/i.test(line)
  ) || lines[0] || null;
}

function labelledMoney(text, labels) {
  const label = labels.join("|");
  const m = String(text || "").match(new RegExp(`(?:${label})\\s*[:\\-]?\\s*([^\\n|]{0,80})`, "i"));
  return m ? parseMoney(m[1]) : null;
}

function outcomeOf(text, now = new Date()) {
  const body = String(text || "").replace(/\u00a0/g, " ");
  const sold = body.match(/\bSold\s+(?:for|after)\s*[:\-]?\s*([^\n|]{0,90})/i);
  if (sold) {
    const money = parseMoney(sold[1]);
    const date = parseHagertyDate(sold[1], now) || parseHagertyDate(body, now);
    return { kind: "sale", status: /sold\s+after/i.test(sold[0]) ? "sold_after" : "sold", money, date };
  }

  const bidTo = body.match(/\bBid\s+to\s*[:\-]?\s*([^\n|]{0,90})/i);
  if (bidTo) return { kind: "listing", status: "bid_to", money: parseMoney(bidTo[1]), date: parseHagertyDate(bidTo[1], now) || parseHagertyDate(body, now) };

  const withdrawn = body.match(/\bWithdrawn(?:\s+on)?\s*[:\-]?\s*([^\n|]{0,90})/i);
  if (withdrawn) return { kind: "listing", status: "withdrawn", money: null, date: parseHagertyDate(withdrawn[1], now) || parseHagertyDate(body, now) };

  if (/\breserve\s+not\s+met\b/i.test(body)) {
    const money = labelledMoney(body, ["high bid", "current bid", "bid"]);
    return { kind: "listing", status: "reserve_not_met", money, date: parseHagertyDate(body, now) };
  }

  const ending = body.match(/\bEnding\s+([^\n|]{0,100})/i);
  const endsAt = ending ? parseHagertyDate(ending[1], now) : null;
  const currentBid = labelledMoney(body, ["current bid", "bid"]);
  const asking = labelledMoney(body, ["asking price", "price", "buy now"]);
  const hasLiveSignal = /\b(place bid|current bid|make an offer|for sale|available)\b/i.test(body);
  if (endsAt && new Date(endsAt) <= now) return { kind: "listing", status: "ended", money: currentBid || asking, date: endsAt };
  if (endsAt || hasLiveSignal) return { kind: "listing", status: "live", money: currentBid || asking, date: null, endsAt };

  return { kind: "listing", status: "unknown", money: asking, date: null, endsAt: null };
}

function listingType(url, text) {
  return /\/auction\//i.test(String(url || "")) || /\b(auction|bid|ending)\b/i.test(String(text || ""))
    ? "auction" : "classified";
}

function baseListing({ url, title, outcome, text, now, extra = {} }) {
  const id = sourceLotId(url);
  if (!id) return { kind: "skip", reason: "no stable Hagerty lot id" };
  if (!title) return { kind: "skip", reason: "no title" };
  const money = outcome.money;
  const active = outcome.status === "live" || outcome.status === "upcoming";
  const priceType = outcome.status === "bid_to" || outcome.status === "reserve_not_met"
    ? "high_bid" : listingType(url, text) === "auction" ? "current_bid" : "asking";
  return {
    kind: "listing",
    record: {
      source: "hagerty",
      source_lot_id: id,
      url: String(url).split("?")[0],
      title,
      price: money?.amount ?? null,
      currency: money?.currency || "USD",
      mileage: extra.mileage ?? null,
      vin_raw: extra.vin_raw ?? null,
      color: extra.color ?? null,
      transmission: extra.transmission ?? null,
      tc: null,
      image_url: extra.image_url ?? null,
      is_active: active,
      listing_type: listingType(url, text),
      listing_status: outcome.status,
      price_type: priceType,
      current_bid: outcome.status === "live" || outcome.status === "bid_to" || outcome.status === "reserve_not_met" ? money?.amount ?? null : null,
      estimate_low: extra.estimate_low ?? null,
      estimate_high: extra.estimate_high ?? null,
      ends_at: outcome.endsAt || extra.ends_at || null,
      closed_at: active ? null : (outcome.date || null),
      status_reason: outcome.status === "unknown" ? "no explicit Marketplace outcome" : null,
      fetched_at: now.toISOString(),
      _extra: { ...extra, statusText: String(text || "").slice(0, 500) },
    },
  };
}

function saleRecord({ url, title, outcome, text, now, extra = {} }) {
  const id = sourceLotId(url);
  if (!id) return { kind: "skip", reason: "no stable Hagerty lot id" };
  if (!title) return { kind: "skip", reason: "no title" };
  if (!outcome.money) return { kind: "skip", reason: "auction outcome has no parseable price" };
  if (!outcome.date) return { kind: "skip", reason: "auction outcome has no parseable date" };
  const currency = outcome.money.currency;
  return {
    kind: "sale",
    record: {
      source: "hagerty",
      source_lot_id: id,
      url: String(url).split("?")[0],
      title,
      sold_at: outcome.date,
      price: outcome.money.amount,
      currency,
      price_usd: currency === "USD" ? outcome.money.amount : null,
      mileage: extra.mileage ?? null,
      vin_raw: extra.vin_raw ?? null,
      vin_normal: null,
      color: extra.color ?? null,
      transmission: extra.transmission ?? null,
      tc: null,
      options: [],
      image_url: extra.image_url ?? null,
      is_outlier: false,
      outlier_note: null,
      carfax_damage: false,
      non_us_sale: currency !== "USD",
      reserve_not_met: false,
      status: outcome.status,
      raw_source_shape: "hagerty-marketplace-v1",
      harvest_mode: "playwright",
      fetched_at: now.toISOString(),
      _extra: { ...extra, outcomeText: String(text || "").slice(0, 500) },
    },
  };
}

function adaptHagertyPage({ url, title, text, now = new Date(), extra = {} }) {
  const outcome = outcomeOf(text, now);
  if (outcome.kind === "sale") return saleRecord({ url, title: titleFromText(text, title), outcome, text, now, extra });
  return baseListing({ url, title: titleFromText(text, title), outcome, text, now, extra });
}

// Search cards sometimes contain only the outcome/date and omit the detail-page fields. They
// are still valid records: the crawler enriches live cards from their detail page when budget
// allows, while historical sale cards do not need another request.
function adaptHagertyResultCard(input) {
  return adaptHagertyPage(input);
}

function listingFromSale(sale, now = new Date()) {
  return {
    source: sale.source,
    source_lot_id: sale.source_lot_id,
    url: sale.url,
    title: sale.title,
    price: sale.price,
    currency: sale.currency,
    mileage: sale.mileage ?? null,
    vin_raw: sale.vin_raw ?? null,
    color: sale.color ?? null,
    transmission: sale.transmission ?? null,
    tc: sale.tc ?? null,
    image_url: sale.image_url ?? null,
    is_active: false,
    listing_type: "auction",
    listing_status: sale.status === "sold_after" ? "sold_after" : "sold",
    price_type: "sold",
    current_bid: null,
    estimate_low: null,
    estimate_high: null,
    ends_at: null,
    closed_at: sale.sold_at,
    status_reason: null,
    fetched_at: now.toISOString(),
    _extra: { lifecycleFrom: "sale" },
  };
}

module.exports = {
  adaptHagertyPage,
  adaptHagertyResultCard,
  listingFromSale,
  outcomeOf,
  parseHagertyDate,
  parseMoney,
  sourceLotId,
};
