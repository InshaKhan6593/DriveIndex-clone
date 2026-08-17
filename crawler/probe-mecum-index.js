// FIND MECUM'S PAST-AUCTION INDEX.
//
// This is the one thing standing between Mecum and running unattended. /auctions/ lists only
// UPCOMING sales — harvesting those yields zero (measured: nashville-2026 gave 0 sales from 706
// cards, correctly, because the sale has not happened). Past events must be supplied by name,
// and guessing slugs failed on 5 of 14: kissimmee-YYYY works, indy-2022 / glendale-2024 /
// las-vegas-2024 / dallas-2024 all return ERR_EMPTY_RESPONSE.
//
// So: find the page that lists COMPLETED sales, the same way the BaT category ids and the RM
// auction codes were found — by looking rather than guessing.
//
// Usage: node crawler/probe-mecum-index.js

const { PlaywrightCrawler } = require("crawlee");

// Routes a results archive plausibly lives at.
const CANDIDATES = [
  "https://www.mecum.com/auctions/past/",
  "https://www.mecum.com/auctions/results/",
  "https://www.mecum.com/past-auctions/",
  "https://www.mecum.com/auctions/archive/",
  "https://www.mecum.com/results/",
  "https://www.mecum.com/auctions/",
];

// A slug we already know is real, to confirm the shape of what we are looking for.
const KNOWN_GOOD = /kissimmee-20\d{2}|monterey-20\d{2}|indy-20\d{2}|harrisburg-20\d{2}/;

const found = new Map();

new PlaywrightCrawler({
  maxRequestsPerCrawl: CANDIDATES.length,
  maxConcurrency: 1,
  maxRequestRetries: 0,
  requestHandlerTimeoutSecs: 120,
  navigationTimeoutSecs: 90,
  async requestHandler({ page, request, log }) {
    await page.waitForTimeout(6000);
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2000);
    }

    const d = await page.evaluate(() => {
      const events = new Set();
      for (const a of Array.from(document.querySelectorAll('a[href*="/auctions/"]'))) {
        const m = (a.getAttribute("href") || "").match(/\/auctions\/([a-z0-9-]+-(?:19|20)\d{2})\/?/i);
        if (m) events.add(m[1]);
      }
      const txt = document.body.innerText;
      return {
        events: [...events],
        hasPastWording: /past auction|previous auction|auction results|archive/i.test(txt),
        // A year filter is the usual signature of an archive page.
        yearsOffered: [...new Set((txt.match(/\b(?:19|20)\d{2}\b/g) || []))].sort().slice(0, 30),
        title: document.title,
      };
    });

    for (const e of d.events) found.set(e, request.url);
    log.info(
      `${request.url.replace("https://www.mecum.com", "")}\n` +
      `     events=${d.events.length}  pastWording=${d.hasPastWording}  years=${d.yearsOffered.length}\n` +
      `     sample: ${d.events.slice(0, 8).join(", ") || "(none)"}`
    );
  },
  failedRequestHandler({ request, log }) { log.warning(`FAILED ${request.url.replace("https://www.mecum.com", "")}`); },
})
  .run(CANDIDATES)
  .then(() => {
    const all = [...found.keys()].sort();
    const past = all.filter((e) => KNOWN_GOOD.test(e) || /-(?:19|20)[0-2]\d$/.test(e));
    console.log(`\n=== ${all.length} distinct event slugs discovered ===`);
    for (const e of all.slice(0, 60)) console.log(`   ${e.padEnd(28)} (from ${found.get(e).replace("https://www.mecum.com", "")})`);

    // Group by year so it is obvious whether history is reachable or only the current season.
    const byYear = {};
    for (const e of all) {
      const y = (e.match(/((?:19|20)\d{2})$/) || [])[1];
      if (y) (byYear[y] = byYear[y] || []).push(e);
    }
    console.log(`\n=== BY YEAR ===`);
    for (const y of Object.keys(byYear).sort()) console.log(`   ${y}  ${byYear[y].length} events`);
    console.log(`\n${past.length} look like real past events. If only the current year appears,`);
    console.log(`the archive is behind a filter or a different route and needs another pass.`);
  });
