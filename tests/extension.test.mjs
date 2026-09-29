import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";

const extensionPath = path.resolve(import.meta.dirname, "..");

const fixtures = [
  {
    publication: "The Economist",
    issueUrl: "https://www.economist.com/weeklyedition/2026-09-26",
    filename: "economist-2026-09-26.md",
    links: [
      ["https://www.economist.com/finance-and-economics/2026/09/26/a-substantive-economic-story", "A substantive economic story"],
      ["https://www.economist.com/science-and-technology/2026/09/26/a-substantive-science-story", "A substantive science story"]
    ]
  },
  {
    publication: "California Magazine",
    issueUrl: "https://alumni.berkeley.edu/issue/2026-fall/",
    filename: "california-magazine-2026-fall.md",
    links: [
      ["https://alumni.berkeley.edu/california-magazine/2026-fall/test-case/", "Test Case"],
      ["https://alumni.berkeley.edu/california-magazine/2026-fall/the-astounding-life-of-an-email/", "The Astounding Life of an Email"]
    ]
  },
  {
    publication: "Communications of the ACM",
    issueUrl: "https://cacm.acm.org/issue/september-2026/",
    filename: "cacm-september-2026.md",
    links: [
      ["https://cacm.acm.org/research/a-research-article/", "A Research Article"],
      ["https://cacm.acm.org/opinion/an-opinion-article/", "An Opinion Article"]
    ]
  }
];

test("Website Reader extension", async (t) => {
  const notFoundIssueUrl = "https://cacm.acm.org/issue/not-found-test/";
  const notFoundArticleUrl = "https://cacm.acm.org/news/missing-article/";
  let notFoundRequests = 0;
  const profilePath = await fs.mkdtemp(path.join(os.tmpdir(), "website-reader-test-"));
  const context = await chromium.launchPersistentContext(profilePath, {
    channel: "chromium",
    headless: true,
    acceptDownloads: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });

  try {
    let [worker] = context.serviceWorkers();
    worker ||= await context.waitForEvent("serviceworker", { timeout: 10000 });
    const extensionId = new URL(worker.url()).host;

    await context.route("https://**/*", async (route) => {
      const url = route.request().url();
      if (url === "https://clipboard.test/") {
        await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Clipboard reader</title>" });
        return;
      }

      if (url === notFoundIssueUrl) {
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: `<!doctype html><main><h1>Missing Article Test</h1><a href="${notFoundArticleUrl}">Missing Article</a></main>`
        });
        return;
      }

      if (url === notFoundArticleUrl) {
        notFoundRequests += 1;
        await route.fulfill({ status: 404, contentType: "text/html", body: "Not found" });
        return;
      }

      const fixture = fixtures.find((item) => item.issueUrl === url);
      if (fixture) {
        const links = fixture.links.map(([href, title]) => `<a href="${href}">${title}</a>`).join("\n");
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: `<!doctype html><main><h1>${fixture.publication} Test Issue</h1>${links}<a href="/search">Search publication</a>${fixture.publication === "Communications of the ACM" ? '<a href="/news/promotional-page/">Learn More</a>' : ""}</main>`
        });
        return;
      }

      const article = fixtures.flatMap((item) => item.links).find(([href]) => href === url);
      if (article) {
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: `<!doctype html><article><h1>${article[1]}</h1><p>${"Evidence-rich article body. ".repeat(100)}</p></article>`
        });
        return;
      }

      await route.abort();
    });

    async function openPopup(issuePage) {
      // Headless Chromium does not expose the action popup as a Page. Loading the
      // real popup document in a background extension tab preserves the active
      // issue tab that chrome.tabs.query() is expected to return.
      const popup = await context.newPage();
      await issuePage.bringToFront();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      return popup;
    }

    for (const fixture of fixtures) {
      await t.test(`collects ${fixture.publication} issue links`, async () => {
        await worker.evaluate(async () => await chrome.storage.local.clear());
        const issuePage = await context.newPage();
        await issuePage.goto(fixture.issueUrl);
        await issuePage.bringToFront();
        const popup = await openPopup(issuePage);

        try {
          const collect = popup.getByRole("button", { name: `Collect ${fixture.publication} issue`, exact: true });
          await assert.doesNotReject(async () => await collect.waitFor({ state: "visible" }));
          assert.equal(await collect.isEnabled(), true);
          await collect.click();

          let state;
          for (let attempt = 0; attempt < 30; attempt += 1) {
            state = await worker.evaluate(async () => (await chrome.storage.local.get("collectionState")).collectionState);
            if (state?.articles?.length) break;
            await popup.waitForTimeout(100);
          }

          assert.equal(state?.filename, fixture.filename);
          assert.deepEqual(state.articles.map((article) => article.url), fixture.links.map(([url]) => url));
        } finally {
          await issuePage.close();
          await popup.close();
        }
      });
    }

    await t.test("does not retry permanent HTTP errors", async () => {
      await worker.evaluate(async () => await chrome.storage.local.clear());
      const issuePage = await context.newPage();
      await issuePage.goto(notFoundIssueUrl);
      const popup = await openPopup(issuePage);

      try {
        await popup.getByRole("button", { name: "Collect Communications of the ACM issue", exact: true }).click();
        await popup.getByText("Could not collect “Missing Article”.", { exact: false }).waitFor({ timeout: 5000 });
        assert.equal(notFoundRequests, 1);
      } finally {
        await issuePage.close();
        await popup.close();
      }
    });

    await t.test("copies the publication-specific Economist prompt", async () => {
      await worker.evaluate(async () => await chrome.storage.local.clear());
      const issuePage = await context.newPage();
      await issuePage.goto(fixtures[0].issueUrl);
      await issuePage.bringToFront();
      const popup = await openPopup(issuePage);

      try {
        await popup.getByRole("button", { name: "Copy The Economist digest prompt", exact: true }).click();
        await popup.getByText("Copied the The Economist digest prompt.", { exact: false }).waitFor();
        await context.grantPermissions(["clipboard-read"], { origin: "https://clipboard.test" });
        const clipboardPage = await context.newPage();
        await clipboardPage.goto("https://clipboard.test/");
        const copied = await clipboardPage.evaluate(async () => await navigator.clipboard.readText());

        assert.match(copied, /^Read the uploaded Economist issue/);
        assert.match(copied, /\*\*The World This Week:\*\*/);
        assert.match(copied, /\*\*Leaders, columns and opinion:\*\*/);
        assert.doesNotMatch(copied, /\{\{publication/);
        await clipboardPage.close();
      } finally {
        await issuePage.close();
        await popup.close();
      }
    });
  } finally {
    await context.close();
    await fs.rm(profilePath, { recursive: true, force: true });
  }
});
