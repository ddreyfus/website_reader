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
  },
  {
    publication: "The New York Times",
    issueUrl: "https://www.nytimes.com/",
    filename: `nyt-${new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())}.md`,
    links: [
      ["https://www.nytimes.com/2026/09/29/world/test-world-story.html", "A world news story"],
      ["https://www.nytimes.com/2026/09/28/us/test-national-story.html", "A national news story"]
    ]
  }
];

test("Website Reader extension", async (t) => {
  const notFoundIssueUrl = "https://cacm.acm.org/issue/not-found-test/";
  const notFoundArticleUrl = "https://cacm.acm.org/news/missing-article/";
  let notFoundRequests = 0;
  let notFoundLinks = [];
  let failureStatus = 404;
  let failureBody = "Not found";
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
          body: `<!doctype html><main><h1>Missing Article Test</h1>${notFoundLinks.map(([url, title]) => `<a href="${url}">${title}</a>`).join("")}</main>`
        });
        return;
      }

      if (url === notFoundArticleUrl) {
        notFoundRequests += 1;
        await route.fulfill({ status: failureStatus, contentType: "text/html", body: failureBody });
        return;
      }

      const fixture = fixtures.find((item) => item.issueUrl === url);
      if (fixture) {
        const links = fixture.links.map(([href, title]) => `<a href="${href}">${title}</a>`).join("\n");
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: `<!doctype html><main><h1>${fixture.publication} Test Issue</h1>${links}<a href="/search">Search publication</a>${fixture.publication === "The New York Times" ? `<a href="/section/world">World</a><a href="/games/wordle/index.html">Wordle</a><a href="${fixture.links[0][0]}?campaign=home#comments">${fixture.links[0][1]}</a>` : ""}${fixture.publication === "Communications of the ACM" ? '<a href="/news/promotional-page/">Learn More</a>' : ""}</main>`
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
          if (fixture.publication === "The New York Times") {
            await popup.getByText("Downloaded 2 articles.", { exact: true }).waitFor({ timeout: 15000 });
            state = await worker.evaluate(async () => (await chrome.storage.local.get("collectionState")).collectionState);
            assert.ok(state.articles.every(({ markdown }) => markdown.includes("Evidence-rich article body.")));
            await popup.getByRole("button", { name: "Copy The New York Times digest prompt", exact: true }).click();
            await popup.getByText("Copied the The New York Times digest prompt.", { exact: false }).waitFor();
          }
        } finally {
          await issuePage.close();
          await popup.close();
        }
      });
    }

    for (const position of [0, 1, 2, "only", "resume", "forbidden", "challenge", "server", "unreadable"]) {
      await t.test(`skips an unreadable article (${position}) and completes`, async () => {
        await worker.evaluate(async () => await chrome.storage.local.clear());
        notFoundRequests = 0;
        failureStatus = position === "forbidden" ? 403 : position === "server" ? 500 : position === "unreadable" ? 200 : 404;
        failureBody = position === "challenge" ? "<title>Just a moment</title>" : "Not found";
        if (position === "challenge") failureStatus = 403;
        notFoundLinks = position === "only" ? [] : [...fixtures[2].links];
        notFoundLinks.splice(typeof position === "number" ? position : position === "resume" ? notFoundLinks.length : 1, 0, [notFoundArticleUrl, "Missing Article"]);
        const issuePage = await context.newPage();
        await issuePage.goto(notFoundIssueUrl);
        if (position === "resume") {
          await worker.evaluate(async ({ issueUrl, links }) => {
            await chrome.storage.local.set({ collectionState: {
              editionUrl: issueUrl, sourceUrl: issueUrl, filename: "resumed.md",
              heading: "Resumed issue", status: "paused", currentIndex: 2, log: [],
              articles: links.map(([url, title], index) => ({ url, title, markdown: index < 2 ? `## ${title}\n\nPreviously collected body.` : "", unsupported: false }))
            } });
          }, { issueUrl: notFoundIssueUrl, links: notFoundLinks });
        }
        const popup = await openPopup(issuePage);

        try {
          await popup.getByRole("button", { name: position === "resume" ? "Continue collection" : "Collect Communications of the ACM issue", exact: true }).click();
          const expectedLinks = position === "only" ? [] : fixtures[2].links;
          await popup.getByText(`Downloaded ${expectedLinks.length} articles.`, { exact: true }).waitFor({ timeout: 100000 });
          const state = await worker.evaluate(async () => (await chrome.storage.local.get("collectionState")).collectionState);
          assert.equal(notFoundRequests, ["server", "unreadable"].includes(position) ? 5 : 1);
          assert.equal(state.status, "completed");
          assert.equal(state.currentIndex, expectedLinks.length);
          assert.deepEqual(state.articles.map(({ url }) => url), expectedLinks.map(([url]) => url));
          assert.ok(state.articles.every(({ markdown }) => markdown.length > 0));
          assert.match(state.log.join("\n"), /SKIPPED .*missing-article/);
          if (failureStatus === 404) assert.match(state.log.join("\n"), /HTTP 404/);
          assert.doesNotMatch(state.log.join("\n"), /PAUSED/);
          if (!["server", "unreadable"].includes(position)) assert.doesNotMatch(state.log.join("\n"), /retrying/);
          assert.equal(await popup.getByRole("button", { name: "Continue collection", exact: true }).isVisible(), false);
        } finally {
          await issuePage.close();
          await popup.close();
        }
      });
    }

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
