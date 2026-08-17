const { PlaywrightCrawler } = require("crawlee");

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: 1,
  requestHandlerTimeoutSecs: 45,
  async requestHandler({ page, log }) {
    await page.waitForTimeout(5000);
    await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll("*")).find((e) => e.children.length === 0 && e.textContent.trim() === "Details");
      if (el) el.click();
    });
    await page.waitForTimeout(2000);
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 4500));
    console.log("BODY_AFTER_CLICK::" + bodyText);

    // Grab the raw HTML around the sold-price + lot heading area for real selectors
    const html = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll("*")).find((e) => /Sold for/i.test(e.textContent || "") && e.textContent.length < 60);
      let c = el;
      for (let i = 0; i < 4 && c; i++) c = c.parentElement;
      return c ? c.outerHTML.slice(0, 2000) : "NOT_FOUND";
    });
    console.log("PRICE_HTML::" + html);
  },
});

crawler.run(["https://cars.bonhams.com/auction/31959/lot/52/lessbgreater2000-lamborghini-diablo-gtlessbgreater-lessbr-greater-vin-za9de21a0yla12561/"]).catch((e) => console.log("ERROR::" + e.message));
