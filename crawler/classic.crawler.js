// CLASSIC.COM AGGREGATOR LEAD HARVESTER.
//
// Classic.com is permitted by robots.txt, but it republishes other houses' data and calls its
// auction results unofficial. This crawler therefore writes only samples/staging/classic-leads.json.
// It never writes samples/scraped and is deliberately absent from the cron pipeline.
//
// Usage:
//   node crawler/classic.crawler.js discover [maxAuctions]
//   node crawler/classic.crawler.js run <classic-auction-url> [maxLots]
//   node crawler/classic.crawler.js run auto [maxLots]
"use strict";

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { adaptClassicLot, absoluteClassicUrl, auctionKey } = require("./classic-adapt");

const ROOT = "https://www.classic.com";
const PAST_AUCTIONS = `${ROOT}/auctions/past/`;
const OUT = path.join(__dirname, "..", "samples", "staging", "classic-leads.json");
const AUCTIONS_OUT = path.join(__dirname, "..", "samples", "staging", "classic-auctions.json");
const STATE = path.join(__dirname, "..", "samples", "classic.state.json");
const DELAY_MS = Number(process.env.DELAY_MS) || 1500;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BROWSER_ARGS = ["--disable-blink-features=AutomationControlled"];
const hideAutomation = (context) => context.addInitScript(() => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
});
function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 1));
}

async function goto(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForFunction(() => document.readyState === "complete", null, { timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(1200);
}

async function discoverAuctionUrls(page, max = Infinity) {
  await goto(page, PAST_AUCTIONS);
  const urls = await page.evaluate(() => [...new Set(
    [...document.querySelectorAll('a[href^="/a/"]')].map((a) => new URL(a.getAttribute("href"), location.origin).href)
  )]);
  return urls.slice(0, max);
}

async function extractCards(page) {
  return page.evaluate(() => [...document.querySelectorAll('[id^="vehicle-item-"]')].map((root) => {
    const titleLink = root.querySelector('h3 a[href*="/veh/"]');
    const badge = root.querySelector('[data-testid="badge"]');
    const image = root.querySelector('img[alt]');
    const price = [...root.querySelectorAll("span")].map((el) => el.innerText.trim()).find((text) => /^\$[\d,]/.test(text)) || null;
    const text = root.innerText || "";
    const date = text.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}, \d{4}\b/i)?.[0] || null;
    const lot = text.match(/\bLot:\s*([^\n]+)/i)?.[1]?.trim() || null;
    const lines = text.split(/\n+/).map((x) => x.trim()).filter(Boolean);
    const mileage = lines.find((line) => /\b(?:mi|miles|km|kilometers|kilometres)\b/i.test(line)) || null;
    const transmission = lines.find((line) => /^(manual|automatic|pdk|dct|cvt)$/i.test(line)) || null;
    const location = lines.find((line) => /,\s*[A-Z]{2,}(?:,|$)/.test(line)) || null;
    const originality = [...root.querySelectorAll("abbr")].map((el) => el.innerText.trim()).find(Boolean) || null;
    return {
      url: titleLink?.href || null,
      title: titleLink?.innerText?.trim() || null,
      outcome: badge?.innerText?.trim() || null,
      price,
      date,
      lot_number: lot,
      mileage,
      transmission,
      location,
      originality,
      image_url: image?.src || null,
    };
  }));
}

async function extractDetail(page, card) {
  await goto(page, card.url);
  return page.evaluate(() => {
    const text = document.body.innerText || "";
    const heading = document.querySelector("h1")?.innerText?.trim() || null;
    const vin = text.match(/\bVIN\s*[:.]?\s*([A-Z0-9][A-Z0-9./-]{3,})/i)?.[1] || null;
    const source = [...document.querySelectorAll("a[href]")].find((a) => /view source/i.test(a.innerText || ""));
    const image = document.querySelector('meta[property="og:image"]')?.content || null;
    const mileage = [...text.matchAll(/([\d,.]+\s*(?:k\s*)?(?:mi|miles|km|kilometers|kilometres)\b[^\n]*)/gi)][0]?.[1] || null;
    const transmission = text.match(/\b(Manual|Automatic|PDK|DCT|CVT)\b/i)?.[1] || null;
    const location = text.match(/(?:USA|Canada|United Kingdom|France|Germany|Italy|Switzerland|Australia)\b[^\n]*/i)?.[0] || null;
    return {
      title: heading,
      vin_raw: vin,
      mileage,
      transmission,
      location,
      upstream_url: source?.href || null,
      image_url: image,
    };
  });
}

async function collectAuction(page, auctionUrl, maxLots = Infinity) {
  await goto(page, auctionUrl);
  await page.waitForSelector('[id^="vehicle-item-"]', { timeout: 120000 });
  const pageCount = await page.evaluate(() => {
    const text = document.body.innerText || "";
    const matches = [...text.matchAll(/\b\d+\s*\/\s*(\d+)\b/g)];
    return matches.length ? Number(matches[matches.length - 1][1]) : 1;
  });
  const cards = [];
  for (let pageNumber = 1; pageNumber <= pageCount && cards.length < maxLots; pageNumber++) {
    if (pageNumber > 1) {
      const next = page.getByRole("link", { name: "chevron_right", exact: true }).first();
      if (!(await next.count())) throw new Error(`Classic auction has no next-page link for page ${pageNumber}`);
      await next.click();
      await page.waitForSelector('[id^="vehicle-item-"]', { timeout: 120000 });
      await page.waitForTimeout(2500);
    }
    const batch = await extractCards(page);
    if (!batch.length) throw new Error(`Classic auction page returned no vehicle cards on page ${pageNumber}`);
    for (const card of batch) {
      if (card.url && !cards.some((existing) => existing.url === card.url)) cards.push(card);
      if (cards.length >= maxLots) break;
    }
    console.log(`  page ${pageNumber}/${pageCount}: ${batch.length} cards, ${cards.length} unique`);
  }
  return cards;
}

async function run(auctionUrl, maxLots) {
  const browser = await chromium.launch({ headless: true, args: BROWSER_ARGS });
  const context = await browser.newContext({ userAgent: UA });
  await hideAutomation(context);
  const listPage = await context.newPage();
  const detailPage = await context.newPage();
  const state = loadJson(STATE, { auctions: {} });
  const leads = new Map(loadJson(OUT, []).map((lead) => [`${lead.source}|${lead.source_lot_id}`, lead]));
  const key = auctionKey(auctionUrl);
  if (!key) throw new Error(`not a Classic auction URL: ${auctionUrl}`);

  try {
    const cards = await collectAuction(listPage, auctionUrl, maxLots);
    let added = 0;
    let skipped = 0;
    for (const card of cards) {
      const existingKey = `${key}|${card.url}`;
      if (state.auctions[existingKey]) continue;
      await sleep(DELAY_MS);
      const detail = await extractDetail(detailPage, card);
      const out = adaptClassicLot({ ...card, ...detail, auction_url: auctionUrl });
      if (out.kind === "lead") {
        leads.set(`classic|${out.record.source_lot_id}`, out.record);
        added++;
      } else skipped++;
      state.auctions[existingKey] = { status: out.kind, reason: out.reason || null, fetched_at: new Date().toISOString() };
      saveJson(OUT, [...leads.values()]);
      saveJson(STATE, state);
    }
    state.auctions[key] = { complete: cards.length < maxLots, cards: cards.length, updated_at: new Date().toISOString() };
    saveJson(STATE, state);
    console.log(`\n${added} new Classic leads, ${skipped} refused, ${leads.size} total leads`);
    console.log(`Wrote ${OUT} (staging only; not an index input)`);
  } finally {
    await browser.close();
  }
}

async function main() {
  const [mode = "run", target = "auto", maxRaw] = process.argv.slice(2);
  const max = Number(maxRaw) || Infinity;
  const browser = await chromium.launch({ headless: true, args: BROWSER_ARGS });
  const page = await browser.newPage({ userAgent: UA });
  await page.addInitScript(() => Object.defineProperty(navigator, "webdriver", { get: () => undefined }));
  try {
    if (mode === "discover") {
      const discoverMax = Number(target) || max;
      const urls = await discoverAuctionUrls(page, discoverMax);
      saveJson(AUCTIONS_OUT, urls);
      console.log(`Discovered ${urls.length} Classic auction URLs; wrote ${AUCTIONS_OUT}`);
      return;
    }
    let auctionUrl = target;
    if (target === "auto") {
      const state = loadJson(STATE, { auctions: {} });
      const urls = await discoverAuctionUrls(page);
      auctionUrl = urls.find((url) => !state.auctions[auctionKey(url)]?.complete);
      if (!auctionUrl) throw new Error("no unfinished Classic auctions found");
      console.log(`auto selected ${auctionUrl}`);
    }
    await browser.close();
    await run(absoluteClassicUrl(auctionUrl), max);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

if (require.main === module) main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });

module.exports = { extractCards, extractDetail, discoverAuctionUrls };
