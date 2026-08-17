// Every probe returned HTTP 400 — including the exact baseline that harvested 8,952 records
// earlier today. Before concluding "no filters supported", establish whether the endpoint
// still answers AT ALL. A 400 on the known-good URL means the block is us (rate limit /
// header shape), not the parameters.
const BASE = "https://bringatrailer.com/wp-json/bringatrailer/1.0/data/listings-filter";

const HEADER_SETS = {
  "harvester (known-good)": {
    "User-Agent": "Mozilla/5.0 (compatible; price-index-research/1.0)",
    Accept: "application/json",
    Referer: "https://bringatrailer.com/auctions/results/",
  },
  "real browser UA": {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: "https://bringatrailer.com/auctions/results/",
    "X-Requested-With": "XMLHttpRequest",
  },
  "no headers": {},
};

const KNOWN_GOOD = "page=1&per_page=36&get_items=1&get_stats=0&sort=ta";

(async () => {
  for (const [name, headers] of Object.entries(HEADER_SETS)) {
    const url = `${BASE}?${KNOWN_GOOD}`;
    try {
      const res = await fetch(url, { headers });
      const body = await res.text();
      console.log(`${name.padEnd(24)} HTTP ${res.status}  len=${body.length}`);
      if (res.status !== 200) console.log(`   body: ${body.slice(0, 220).replace(/\s+/g, " ")}`);
      else {
        const j = JSON.parse(body);
        console.log(`   items=${(j.items || []).length}  total=${j.items_total}`);
      }
    } catch (e) {
      console.log(`${name.padEnd(24)} ERR ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
})();
