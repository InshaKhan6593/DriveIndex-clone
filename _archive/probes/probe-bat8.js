const { PlaywrightCrawler } = require("crawlee");

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: 1,
  requestHandlerTimeoutSecs: 45,
  async requestHandler({ page, log }) {
    await page.waitForTimeout(5000);
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 2500));
    console.log("BODY::" + bodyText);

    // Look for the essentials/spec list structure
    const essentials = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll("ul,dl,div")).filter((el) => {
        const t = el.textContent || "";
        return t.includes("Chassis:") || t.includes("VIN:") || (t.includes("Make:") && t.includes("Model:"));
      });
      return candidates.slice(0, 3).map((el) => ({ tag: el.tagName, class: el.className, html: el.outerHTML.slice(0, 1500) }));
    });
    console.log("ESSENTIALS::" + JSON.stringify(essentials, null, 2));
  },
});

crawler.run(["https://bringatrailer.com/listing/2018-porsche-911-gt2-rs-90/"]).catch((e) => console.log("ERROR::" + e.message));
