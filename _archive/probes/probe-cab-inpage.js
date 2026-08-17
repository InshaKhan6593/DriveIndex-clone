// Cars & Bids: 40,344 closed auctions behind Cloudflare.
//
// Plain fetch gets a "Just a moment..." interstitial on every shape tried, so the `signature`
// query param is not the gate — Cloudflare is. The site itself calls this endpoint successfully
// from the browser, which means a real browser context already holds the clearance cookie.
//
// So: drive a Playwright page to the results URL, then issue the API call FROM INSIDE that page.
// It inherits the session, and we find out whether `signature` is actually required or merely
// decorative. If it is decorative, offset paging gives the whole archive cheaply.
//
// Usage: node crawler/probe-cab-inpage.js

const { PlaywrightCrawler } = require("crawlee");

new PlaywrightCrawler({
  maxRequestsPerCrawl: 1,
  requestHandlerTimeoutSecs: 240,
  navigationTimeoutSecs: 120,
  async requestHandler({ page, log }) {
    await page.waitForTimeout(9000); // let the Cloudflare challenge settle

    // 1. Does an UNSIGNED call work from inside the page?
    const unsigned = await page.evaluate(async () => {
      try {
        const r = await fetch("/v2/autos/auctions?limit=5&status=closed&offset=0", { headers: { Accept: "application/json" } });
        const t = await r.text();
        let j = null; try { j = JSON.parse(t); } catch {}
        return { status: r.status, total: j && j.total, got: j && j.auctions ? j.auctions.length : 0, head: t.slice(0, 90) };
      } catch (e) { return { err: String(e).slice(0, 120) }; }
    });
    log.info(`unsigned in-page call: ${JSON.stringify(unsigned)}`);

    // 2. How deep does offset go? BaT capped at 10,000; C&B may not.
    if (unsigned.status === 200) {
      for (const off of [0, 5000, 20000, 40000]) {
        const r = await page.evaluate(async (o) => {
          const res = await fetch(`/v2/autos/auctions?limit=5&status=closed&offset=${o}`, { headers: { Accept: "application/json" } });
          const j = await res.json().catch(() => null);
          return { status: res.status, n: j && j.auctions ? j.auctions.length : 0, first: j && j.auctions && j.auctions[0] ? j.auctions[0].title : null };
        }, off);
        log.info(`offset=${String(off).padStart(6)} -> HTTP ${r.status} items=${r.n}  ${r.first || ""}`);
      }
    }

    // 3. What does one record carry? Field availability decides the adapter.
    const sample = await page.evaluate(async () => {
      const res = await fetch("/v2/autos/auctions?limit=3&status=closed&offset=0", { headers: { Accept: "application/json" } });
      const j = await res.json().catch(() => null);
      return j && j.auctions ? j.auctions[0] : null;
    });
    if (sample) {
      console.log(`\nrecord keys: ${Object.keys(sample).join(", ")}`);
      console.log(`\nfull sample record:`);
      console.log(JSON.stringify(sample, null, 1).slice(0, 2600));
    }
  },
}).run(["https://carsandbids.com/past-auctions/"]);
