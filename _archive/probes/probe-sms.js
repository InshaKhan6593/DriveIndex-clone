const { PlaywrightCrawler } = require("crawlee");
new PlaywrightCrawler({
  maxRequestsPerCrawl: 1, requestHandlerTimeoutSecs: 60,
  async requestHandler({ page }) {
    await page.waitForTimeout(5000);
    const info = await page.evaluate(() => ({
      title: document.title,
      body: document.body.innerText.slice(0, 900).replace(/\n{2,}/g, "\n"),
      links: [...new Set(Array.from(document.querySelectorAll("a[href]")).map(a => a.href)
        .filter(h => /lot|vehicle|listing|auction/i.test(h)))].slice(0, 12),
    }));
    console.log("TITLE::" + info.title);
    console.log("BODY::" + info.body);
    console.log("LINKS::" + JSON.stringify(info.links, null, 1));
  },
}).run(["https://sothebysmotorsport.com/"]).catch(e => console.log("ERR", e.message));
