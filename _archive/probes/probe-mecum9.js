const { PlaywrightCrawler } = require("crawlee");

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: 1,
  requestHandlerTimeoutSecs: 45,
  async requestHandler({ page, log }) {
    await page.waitForTimeout(5000);
    const debug = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll("*"));
      const priceEl = all.find((e) => e.children.length === 0 && /^\$[\d,]+$/.test(e.textContent.trim()));
      const vinLabelEl = all.find((e) => e.children.length === 0 && e.textContent.trim() === "VIN / SERIAL");
      const odoLabelEl = all.find((e) => e.children.length === 0 && /^ODOMETER READS/.test(e.textContent.trim()));
      const lotLineEl = all.find((e) => e.children.length === 0 && /^LOT\s/.test(e.textContent.trim()));
      const specLabels = all.filter((e) => e.children.length === 0 && ["ENGINE", "TRANSMISSION", "BODY STYLE"].includes(e.textContent.trim()));

      const describe = (el) => el ? { tag: el.tagName, class: el.className, parentClass: el.parentElement?.className, nextText: el.nextElementSibling?.textContent?.trim() } : null;

      return {
        price: describe(priceEl),
        vinLabel: describe(vinLabelEl),
        odoLabel: describe(odoLabelEl),
        lotLine: describe(lotLineEl),
        specLabels: specLabels.map(describe),
      };
    });
    console.log("DEBUG::" + JSON.stringify(debug, null, 2));
  },
});

crawler.run(["https://www.mecum.com/lots/1178962/1956-chevrolet-nomad-wagon?aa_id=804160-0"]).catch((e) => console.log("ERROR::" + e.message));
