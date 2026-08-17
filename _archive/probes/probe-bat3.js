const { PlaywrightCrawler } = require("crawlee");

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: 1,
  requestHandlerTimeoutSecs: 45,
  async requestHandler({ page, log }) {
    await page.waitForTimeout(5000);
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 3000));
    console.log("BODY::" + bodyText);

    // Look for embedded structured data (JSON-LD, __NEXT_DATA__, or similar)
    const jsonLd = await page.evaluate(() =>
      Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map((s) => s.textContent)
    );
    console.log("JSONLD_COUNT::" + jsonLd.length);
    if (jsonLd.length) console.log("JSONLD_SAMPLE::" + jsonLd[0].slice(0, 2000));

    const hasNextData = await page.evaluate(() => !!document.getElementById("__NEXT_DATA__"));
    console.log("HAS_NEXT_DATA::" + hasNextData);
  },
});

crawler.run(["https://bringatrailer.com/listing/2018-porsche-911-gt3-194/"]).catch((e) => console.log("ERROR::" + e.message));
