// BaT MODEL-PAGE crawler — deliberately different entry point from bring-a-trailer.crawler.js.
//
// The results-feed crawler pulls whatever sold most recently, which gives a scattered set of
// unrelated cars. To actually stress-test entity resolution and cross-source dedup you need
// MANY sales of the SAME models. BaT's model pages (/porsche/911/, /ferrari/f355/, ...) give
// exactly that, and they include the completed-auction archive.
//
// Usage: node crawler/bat-model.crawler.js <path> <maxListings> <outfile>
//   node crawler/bat-model.crawler.js porsche/911 40 bat-porsche-911.json

const fs = require("fs");
const path = require("path");
const { PlaywrightCrawler, Dataset, Configuration } = require("crawlee");
const { adaptBringATrailer } = require("../adapters/bring-a-trailer");

const modelPath = process.argv[2] || "porsche/911";
const maxListings = Number(process.argv[3]) || 20;
const outName = process.argv[4] || `bat-${modelPath.replace(/\//g, "-")}.json`;

const OUT_DIR = path.join(__dirname, "..", "samples", "scraped");
fs.mkdirSync(OUT_DIR, { recursive: true });

// Isolate storage per run so concurrent/sequential crawls don't share a request queue.
Configuration.getGlobalConfig().set("purgeOnStart", true);

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: maxListings + 1,
  requestHandlerTimeoutSecs: 60,
  maxConcurrency: 3,
  async requestHandler({ page, request, log, enqueueLinks }) {
    if (request.label === "DETAIL") {
      await page.waitForSelector(".essentials", { timeout: 20000 }).catch(() => {});

      const data = await page.evaluate(() => {
        const introEl = document.querySelector("[data-listing-intro-id]");
        const title = document.querySelector("h1.listing-post-title, h1.post-title")?.textContent?.trim() || null;
        const availableInfo = document.querySelector(".listing-available-info");
        const availableInfoText = availableInfo ? availableInfo.textContent.replace(/\s+/g, " ").trim() : "";
        const dateEl = availableInfo ? availableInfo.querySelector(".date-localize[data-timestamp]") : null;
        const soldTimestamp = dateEl ? Number(dateEl.getAttribute("data-timestamp")) : null;
        const bulletItems = Array.from(document.querySelectorAll(".essentials .item ul li")).map((li) => li.textContent.trim());
        return {
          listingIntroId: introEl ? introEl.getAttribute("data-listing-intro-id") : null,
          title, availableInfoText, soldTimestamp, bulletItems,
        };
      });

      // Only keep COMPLETED sales — a model page mixes live auctions in with the archive.
      if (!/sold for/i.test(data.availableInfoText || "")) {
        log.info(`skip (not a completed sale): ${data.title}`);
        return;
      }

      const normalized = adaptBringATrailer(data, request.url);
      log.info(`${normalized.title} — $${normalized.price} (${normalized.mileage ?? "?"}mi, VIN ${normalized.vin_raw ?? "none"})`);
      await Dataset.pushData(normalized);
      return;
    }

    // Model page: a BaT model page defaults to LIVE auctions. The completed archive sits
    // behind a "Results" tab, and that list lazy-paginates behind "Show More". Both must be
    // driven or you get ~2 completed sales out of 35 links (measured — that was the first
    // run of this crawler).
    await page.waitForTimeout(3500);

    await page.evaluate(() => {
      const tab = Array.from(document.querySelectorAll("a,button")).find(
        (e) => (e.textContent || "").trim().toLowerCase() === "results"
      );
      if (tab) tab.click();
    });
    await page.waitForTimeout(3000);

    // Click "Show More" until we have enough listing links or it stops appearing.
    // NOTE: BaT's "Results" tab serves a GLOBAL results feed, not one filtered to the model
    // path in the URL — measured: /porsche/911/, /porsche/911-turbo/ and /porsche/911-gt3/
    // returned largely the same 57 unique titles. To reach repeat model-years you have to
    // paginate DEEP into the archive rather than switch model paths.
    for (let i = 0; i < 40; i++) {
      const count = await page.evaluate(() => document.querySelectorAll("a[href*='/listing/']").length);
      if (count >= maxListings * 1.5) break;
      const clicked = await page.evaluate(() => {
        const el = Array.from(document.querySelectorAll("a,button")).find((e) =>
          /^show more/i.test((e.textContent || "").trim())
        );
        if (el) { el.scrollIntoView(); el.click(); return true; }
        return false;
      });
      if (!clicked) break;
      await page.waitForTimeout(2200);
    }
    log.info(`links visible after pagination: ${await page.evaluate(() => document.querySelectorAll("a[href*='/listing/']").length)}`);

    const result = await enqueueLinks({
      selector: "a[href*='/listing/']",
      label: "DETAIL",
      limit: maxListings,
    });
    log.info(`Enqueued ${result?.enqueuedRequests?.length ?? 0} listing links from /${modelPath}/`);
  },
});

(async () => {
  await crawler.run([{ url: `https://bringatrailer.com/${modelPath}/`, label: "LIST" }]);
  const dataset = await Dataset.open();
  const { items } = await dataset.getData();
  const outFile = path.join(OUT_DIR, outName);
  fs.writeFileSync(outFile, JSON.stringify(items, null, 2));
  console.log(`\nWrote ${items.length} completed sales to ${outFile}`);
})();
