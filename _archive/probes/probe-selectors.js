const { PlaywrightCrawler } = require("crawlee");

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: 1,
  requestHandlerTimeoutSecs: 45,
  async requestHandler({ page }) {
    await page.waitForTimeout(4000);

    const vinCandidates = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll("*"));
      return all
        .filter((el) => el.children.length === 0 && el.textContent.trim() === "VIN")
        .map((el) => ({
          tag: el.tagName,
          class: el.className,
          parentTag: el.parentElement?.tagName,
          parentClass: el.parentElement?.className,
          grandparentClass: el.parentElement?.parentElement?.className,
          nextSiblingText: el.nextElementSibling?.textContent?.trim(),
        }));
    });
    console.log("VIN_CANDIDATES::" + JSON.stringify(vinCandidates, null, 2));

    // Try the common "essentials"/"quick-facts" grid pattern directly
    const gridHtml = await page.evaluate(() => {
      const grid = document.querySelector(".essentials, .quick-facts, [class*='specs'], [class*='details-list']");
      return grid ? grid.outerHTML.slice(0, 3000) : "NOT_FOUND_BY_CLASS_GUESS";
    });
    console.log("GRID_HTML::" + gridHtml);

    const statsMeta = await page.evaluate(() => {
      const el = document.querySelector(".stats-meta");
      return el ? el.textContent.replace(/\s+/g, " | ").trim() : "NOT_FOUND";
    });
    console.log("STATS_META_TEXT::" + statsMeta);
  },
});

crawler.run(["https://carsandbids.com/auctions/9QJPXZZe/2007-porsche-911-turbo-coupe"]);
