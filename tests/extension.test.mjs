import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";

const sourceExtensionPath = path.resolve(import.meta.dirname, "..");

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
  const gmailUrl = "https://mail.google.com/mail/u/0/#inbox/newsletter-thread";
  let emailBody = "";
  let emailRequests = [];
  const emailArticle = "https://medium.com/@writer/shared-path-0123456789ab";
  const otherArticle = "https://newsletter.test/test/shared-path";
  const missingEmailArticle = "https://medium.com/@writer/missing-0123456789ac";
  const redirectRequests = [];
  const redirectServer = http.createServer((request, response) => {
    redirectRequests.push(request.url);
    if (request.url === "/redirect") {
      response.writeHead(302, { location: `http://localhost:${redirectServer.address().port}/resolved` });
      response.end();
    } else {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(`<article><h1>Resolved article</h1><p>${"Distinct full-article evidence. ".repeat(60)}</p></article>`);
    }
  });
  await new Promise((resolve) => redirectServer.listen(0, resolve));
  const redirectArticle = `http://127.0.0.1:${redirectServer.address().port}/redirect`;
  const resolvedArticle = `http://localhost:${redirectServer.address().port}/resolved`;
  const previewArticle = "https://medium.com/@writer/preview-0123456789ad";
  const unreadableEmailArticle = "https://medium.com/@writer/unreadable-0123456789ae";
  const profilePath = await fs.mkdtemp(path.join(os.tmpdir(), "website-reader-test-"));
  // Grant only fixture origins in the test installation: native permission
  // dialogs cannot be answered in headless Chromium. Production permissions
  // remain optional; the popup's grant/decline boundary is tested below.
  const extensionPath = path.join(profilePath, "extension");
  await fs.mkdir(extensionPath);
  for (const name of ["collection.js", "manifest.json", "popup.js", "popup.html", "popup.css", "background.js", "issue-digest-prompt.md", "email-digest-prompt.md"]) {
    await fs.copyFile(path.join(sourceExtensionPath, name), path.join(extensionPath, name));
  }
  const manifest = JSON.parse(await fs.readFile(path.join(extensionPath, "manifest.json"), "utf8"));
  manifest.host_permissions.push("https://medium.com/*", "https://newsletter.test/*", "http://127.0.0.1/*", "http://localhost/*");
  await fs.writeFile(path.join(extensionPath, "manifest.json"), JSON.stringify(manifest));
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
      if (url === "https://mail.google.com/mail/u/0/") {
        await route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><div role="main"><h2 class="hP">Weekly reading</h2>${emailBody}</div>` });
        return;
      }
      if (url === unreadableEmailArticle) {
        emailRequests.push(url);
        await route.fulfill({ status: 200, contentType: "text/html", body: "<title>Missing body</title>" });
        return;
      }
      if (url === previewArticle) {
        emailRequests.push(url);
        await route.fulfill({ status: 200, contentType: "text/html", body: "<article><h1>Member preview</h1><p>Only this preview is available.</p></article>" });
        return;
      }
      if ([emailArticle, otherArticle, missingEmailArticle].includes(url)) {
        emailRequests.push(url);
        await route.fulfill({ status: url === missingEmailArticle ? 403 : 200, contentType: "text/html", body: url === missingEmailArticle ? "Unavailable" : `<article><h1>Linked argument</h1><p>${"Distinct full-article evidence. ".repeat(60)}</p></article>` });
        return;
      }
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

    // tabs.create's initial navigation can bypass Playwright routing. Establish
    // the test tab first, then navigate after Playwright has attached to it.
    await worker.evaluate(() => {
      globalThis.originalContains = chrome.permissions.contains;
      const create = chrome.tabs.create.bind(chrome.tabs);
      chrome.tabs.create = async options => {
        const tab = await create({ ...options, url: "about:blank" });
        await new Promise(resolve => setTimeout(resolve, 100));
        return await chrome.tabs.update(tab.id, { url: options.url });
      };
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

    function message(id, text, hidden = false) {
      return `<div class="adn" data-legacy-message-id="${id}"><span class="gD" email="${id}@newsletter.test">${id}</span><span class="g3" title="Sep 30, 2026, 8:00 AM">Today</span><div class="a3s aiL" ${hidden ? 'style="display:none"' : ""}>${text}</div></div>`;
    }

    for (const mode of ["articles", "text-only"]) {
      await t.test(`collects Gmail email (${mode}) with provenance`, async () => {
        await worker.evaluate(async () => await chrome.storage.local.clear());
        emailRequests = [];
        const links = mode === "text-only" ? "" : `<a href="${emailArticle}?utm_source=digest#comments">Shareholders and evidence</a><a href="${emailArticle}?source=email-digest-author">Read again</a><a href="https://medium.com/@phynixai?source=email-digest">PhynixAI</a><a href="https://medium.com/@dddreyfus">Your profile</a><a href="https://medium.com/towards-ai">Towards AI</a><a href="${otherArticle}">Different publisher</a><a href="${missingEmailArticle}">Missing article</a><a href="https://medium.com/unsubscribe">Unsubscribe</a><a href="https://medium.com/manage?unsubscribe=1">Change settings</a><a href="https://medium.com/login">Sign in</a><a href="https://medium.com/advertisement">Sponsored</a>`;
        emailBody = message("chosen", `<h3>Question of the week</h3><p>Newsletter-only argument and teaser evidence.</p>${links}<div hidden>Hidden preheader<a href="https://medium.com/test/hidden">Hidden article</a></div>`)
          + message("collapsed", "Secret collapsed message", true);
        const gmailPage = await context.newPage();
        await gmailPage.goto(gmailUrl);
        const popup = await openPopup(gmailPage);
        try {
          await popup.getByRole("button", { name: "Collect email and articles" }).waitFor();
          // Native permission UI is not available in headless tests. Preserve
          // the click path and emulate a grant/decline only at that API boundary.
          await popup.evaluate(() => {
            chrome.permissions.request = async ({ origins }) => { globalThis.requestedOrigins = origins; return true; };
          });
          await popup.getByRole("button", { name: "Collect email and articles" }).click();
          const count = mode === "text-only" ? 0 : 3;
          await popup.getByText(`Downloaded email and ${count} articles`, { exact: false }).waitFor({ timeout: 30000 });
          const state = await worker.evaluate(async () => (await chrome.storage.local.get("collectionState")).collectionState);
          assert.deepEqual(await popup.evaluate(() => globalThis.requestedOrigins || []), count ? ["https://*.medium.com/*", "https://newsletter.test/*"] : []);
          assert.equal(state.status, "completed");
          assert.equal(state.emailId, "chosen");
          assert.equal(state.filename, "newsletter-newsletter.test-chosen.md");
          assert.equal(state.editionUrl, `${gmailUrl}::chosen`);
          assert.match(state.emailMarkdown, /Newsletter-only argument/);
          assert.match(state.emailMarkdown, /Subject: Weekly reading/);
          assert.match(state.emailMarkdown, /chosen@newsletter.test/);
          assert.doesNotMatch(state.emailMarkdown, /Secret collapsed|Hidden preheader/);
          if (count) {
            assert.deepEqual(state.articles.map(({ url }) => url), [emailArticle, otherArticle, missingEmailArticle]);
            assert.match(state.emailMarkdown, /Unsubscribe/);
            assert.deepEqual(emailRequests, [emailArticle, otherArticle, missingEmailArticle]);
            assert.match(state.articles[0].markdown, /Provenance: Linked article/);
            assert.match(state.articles[0].markdown, /Distinct full-article evidence/);
            assert.match(state.articles[2].markdown, /Unavailable.*No article title or body/);
          }
          if (count) {
            assert.match(state.emailMarkdown, /PhynixAI/);
            assert.match(state.emailMarkdown, /Your profile/);
          }
          const downloads = await worker.evaluate(async () => await chrome.downloads.search({}));
          const saved = downloads.sort((a, b) => b.id - a.id).find((item) => item.url?.startsWith("data:text/markdown"));
          assert.ok(saved);
          const markdown = decodeURIComponent(saved.url.split(",").slice(1).join(","));
          assert.match(markdown, /Original email/);
          assert.match(markdown, /Newsletter-only argument/);
          await popup.getByRole("button", { name: "Copy email digest prompt" }).click();
          await popup.getByText("Copied the email digest prompt", { exact: false }).waitFor();
          await context.grantPermissions(["clipboard-read"], { origin: "https://clipboard.test" });
          const clipboard = await context.newPage();
          await clipboard.goto("https://clipboard.test/");
          const prompt = await clipboard.evaluate(async () => await navigator.clipboard.readText());
          assert.match(prompt, /question → claim → evidence → open questions → why this might be interesting/);
          assert.match(prompt, /Evidence unavailable in the email/);
          assert.match(prompt, /position, reasoning, assumptions/);
          await clipboard.close();
        } finally {
          await gmailPage.close();
          await popup.close();
        }
      });
    }

    await t.test("Gmail labels clipped messages, redirects, and short previews", async () => {
      await worker.evaluate(async () => await chrome.storage.local.clear());
      await worker.evaluate(() => { chrome.permissions.contains = globalThis.originalContains; });
      emailRequests = [];
      emailBody = message("partial", `<p>Newsletter excerpt</p><a href="https://www.google.com/url?q=${encodeURIComponent(redirectArticle)}">Redirected article</a><a href="${previewArticle}">Preview</a><a href="${unreadableEmailArticle}">Unreadable</a>`).replace('</div></div>', '</div><span class="ajR">Message clipped</span></div>');
      const gmailPage = await context.newPage();
      await gmailPage.goto(gmailUrl);
      const popup = await openPopup(gmailPage);
      try {
        await popup.getByRole("button", { name: "Collect email and articles" }).waitFor();
        await popup.evaluate(() => { chrome.permissions.request = async () => true; });
        await popup.getByRole("button", { name: "Collect email and articles" }).click();
        await popup.getByText("Downloaded email and 3 articles; 2 unsupported or unavailable.", { exact: true }).waitFor({ timeout: 40000 });
        const state = await worker.evaluate(async () => (await chrome.storage.local.get("collectionState")).collectionState);
        assert.match(state.emailMarkdown, /Partial email/);
        assert.deepEqual(redirectRequests, ["/redirect", "/resolved"]);
        assert.deepEqual(emailRequests, [previewArticle, unreadableEmailArticle]);
        assert.equal(state.articles[0].sourceUrl, resolvedArticle);
        assert.match(state.articles[0].markdown, /Distinct full-article evidence/);
        assert.match(state.articles[1].markdown, /Incomplete extraction/);
        assert.doesNotMatch(state.articles[1].markdown, /preview or paywall/);
        assert.doesNotMatch(state.articles[1].markdown, /interactive article/);
        assert.match(state.articles[2].markdown, /Unavailable.*No article title or body/);
      } finally {
        await gmailPage.close();
        await popup.close();
      }
    });

    await t.test("Gmail requires explicit selection among expanded messages and rejects stale selection", async () => {
      await worker.evaluate(async () => await chrome.storage.local.clear());
      emailBody = message("first", "First substantive email") + message("second", "Second substantive email");
      const gmailPage = await context.newPage();
      await gmailPage.goto(gmailUrl);
      const popup = await openPopup(gmailPage);
      try {
        const collect = popup.getByRole("button", { name: "Collect email and articles" });
        await collect.waitFor();
        assert.equal(await collect.isEnabled(), false);
        await popup.getByLabel("Expanded email", { exact: true }).selectOption("second");
        assert.equal(await collect.isEnabled(), true);
        await gmailPage.evaluate(() => { document.querySelector('[data-legacy-message-id="second"]').remove(); });
        await collect.click();
        await popup.getByText("Select one expanded email. Reopen Website Reader", { exact: false }).waitFor();
        assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get("collectionState")).collectionState), undefined);
        await popup.getByLabel("Expanded email", { exact: true }).selectOption("first");
        await collect.click();
        await popup.getByText("Downloaded email and 0 articles.", { exact: true }).waitFor();
        const state = await worker.evaluate(async () => (await chrome.storage.local.get("collectionState")).collectionState);
        assert.match(state.emailMarkdown, /First substantive email/);
        assert.doesNotMatch(state.emailMarkdown, /Second substantive email/);
      } finally {
        await gmailPage.close();
        await popup.close();
      }
    });

    for (const interruption of ["navigation", "reload", "close"]) {
      await t.test(`Gmail ${interruption} and closing the panel do not interrupt saved email collection`, async () => {
        await worker.evaluate(async () => await chrome.storage.local.clear());
        emailRequests = [];
        emailBody = message("independent-email", `<p>Original email snapshot</p><a href="${emailArticle}">First article</a><a href="${otherArticle}">Second article</a>`);
        const gmailPage = await context.newPage();
        await gmailPage.goto(gmailUrl);
        let popup = await openPopup(gmailPage);
        try {
          await popup.getByRole("button", { name: "Collect email and articles" }).waitFor();
          await popup.evaluate(() => { chrome.permissions.request = async () => true; });
          await worker.evaluate(() => { chrome.permissions.contains = globalThis.originalContains; });
          await popup.getByRole("button", { name: "Collect email and articles" }).click();
          await popup.getByText("Collecting 1 of 2:", { exact: false }).waitFor();
          await popup.close();
          if (interruption === "reload") await gmailPage.reload();
          else if (interruption === "close") await gmailPage.close();
          else await gmailPage.evaluate(() => {
            location.hash = "#inbox/other-thread";
            document.querySelector(".a3s").textContent = "A different email";
          });
          // No panel or source document is needed to finish and download.
          const observer = await context.newPage();
          await observer.goto("https://clipboard.test/");
          for (let attempt = 0; attempt < 200; attempt++) {
            const state = await worker.evaluate(async () => (await chrome.storage.local.get("collectionState")).collectionState);
            if (state.status === "completed") break;
            await observer.waitForTimeout(100);
          }
          const state = await worker.evaluate(async () => (await chrome.storage.local.get("collectionState")).collectionState);
          assert.equal(state.status, "completed");
          assert.equal(state.currentIndex, 2);
          assert.match(state.emailMarkdown, /Original email snapshot/);
          assert.doesNotMatch(state.emailMarkdown, /A different email/);
          assert.ok(state.articles.every(article => /Distinct full-article evidence/.test(article.markdown)));
          assert.deepEqual(emailRequests, [emailArticle, otherArticle]);
          assert.equal(state.articleTabId, undefined);
          await observer.close();
        } finally {
          if (!gmailPage.isClosed()) await gmailPage.close();
          if (!popup.isClosed()) await popup.close();
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
    await new Promise((resolve) => redirectServer.close(resolve));
    await fs.rm(profilePath, { recursive: true, force: true });
  }
});
