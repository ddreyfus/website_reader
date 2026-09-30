import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import vm from "node:vm";
import { chromium } from "playwright";

test("Free Press redirects discard external sources before permissions or extraction", async () => {
  const code = await fs.readFile(path.resolve(import.meta.dirname, "../background.js"), "utf8");
  for (const destination of ["https://cbsnews.com/news/story", "https://thefp.com.fake.test/p/story", "https://www.thefp.com/p/story"]) {
    let receive, permissionChecks = 0, reads = 0, closed = false;
    const state = { emailId: "email", emailMarkdown: "From: The Free Press <sender@icloud.com>", status: "running", tabId: 1, sourceUrl: "https://mail.google.com/", currentIndex: 0, articles: [{ url: "https://substack.com/redirect/opaque" }] };
    const event = { addListener() {}, removeListener() {} };
    const chrome = {
      sidePanel: { async setPanelBehavior() {} },
      runtime: { onMessage: { addListener(listener) { receive = listener; } }, onStartup: event },
      storage: { local: { async get() { return { collectionState: state }; }, async set() {} } },
      tabs: { async create() { return { id: 2 }; }, async get() { return { id: 2, status: "complete", url: destination }; }, async remove() { closed = true; }, onUpdated: event, onRemoved: event },
      permissions: { async contains() { permissionChecks++; return true; } },
      scripting: { async executeScript() { reads++; return [{ result: { html: "Rendered story", url: destination } }]; } },
      downloads: { onChanged: event }
    };
    vm.runInNewContext(code, { chrome, URL });
    const result = await new Promise(resolve => receive({ type: "fetchArticle", index: 0 }, { tab: { id: 1 }, url: state.sourceUrl }, resolve));
    const allowed = destination === "https://www.thefp.com/p/story";
    assert.equal(permissionChecks, allowed ? 1 : 0);
    assert.equal(reads, allowed ? 1 : 0);
    assert.equal(!!result.ignored, !allowed);
    assert.ok(closed);
  }
});

test("Medium permission requests include author subdomains without granting lookalike domains", async () => {
  const code = await fs.readFile(path.resolve(import.meta.dirname, "../popup.js"), "utf8");
  let requested;
  const context = vm.createContext({
    URL, emails: [{ id: "selected", articles: [
      { url: "https://medium.com/@author/story-123456789abc" },
      { url: "https://dataexpert.medium.com/story-123456789abc" },
      { url: "https://fake-medium.com/story" }
    ] }],
    emailSelect: { value: "selected" },
    status: { querySelector: () => ({ href: "https://pub.towardsai.net/story" }) },
    chrome: { permissions: { request(options) { requested = options.origins; return Promise.resolve(true); } } },
    async runCollection(resume, permissionRequest) { assert.equal(resume, true); await permissionRequest; },
    setStatus(message) { assert.fail(message); }
  });
  vm.runInContext(code.slice(code.indexOf("async function collectFromClick("), code.indexOf("collectButton.addEventListener(\"click\"")), context);
  await context.collectFromClick(true);
  assert.deepEqual([...requested], ["https://*.medium.com/*", "https://fake-medium.com/*", "https://pub.towardsai.net/*"]);
});

test("persistent controls target the saved source while its article is active", async () => {
  const code = await fs.readFile(path.resolve(import.meta.dirname, "../popup.js"), "utf8");
  const active = { id: 2, windowId: 7, url: "https://medium.com/story" };
  const source = { id: 1, windowId: 7, url: "https://mail.google.com/" };
  let state = { status: "paused", tabId: 1 };
  const context = vm.createContext({ chrome: {
    tabs: { async query() { return [active]; }, async get(id) { assert.equal(id, 1); return source; } },
    storage: { local: { async get() { return { collectionState: state }; } } }
  } });
  vm.runInContext(code.slice(code.indexOf("async function readingBatchTab("), code.indexOf("function isGmailUrl(")), context);
  assert.equal(await context.readingBatchTab(), source);
  assert.equal(await context.readingBatchTab(false), active);
  source.windowId = 8;
  assert.equal(await context.readingBatchTab(), active);
  state = { status: "completed", tabId: 1 };
  assert.equal(await context.readingBatchTab(), active);
});

test("newsletter articles use rendered tabs and pause for user access", async (t) => {
  let loggedIn = false;
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.setHeader("Content-Type", "text/html");
    if (req.url === "/navigation") {
      res.writeHead(302, { Location: "/" }); res.end();
    } else if (req.url === "/media") {
      res.writeHead(302, { Location: "/decorative.png" }); res.end();
    } else if (req.url.startsWith("/cdn-cgi/")) {
      res.setHeader("Content-Type", "text/javascript");
      res.end("");
    } else if (req.url === "/challenge") {
      res.end('<title>Just a moment</title><main><h1>Verify you are human</h1><form id="challenge-form">Complete the browser challenge</form></main>');
    } else if (req.url === "/redirect") {
      res.writeHead(302, { Location: `http://localhost:${server.address().port}/rendered` });
      res.end();
    } else if (req.url === "/locked" && !loggedIn) {
      res.end('<title>Login</title><main><h1>Sign in to read</h1><input type="password"></main>');
    } else if (req.url === "/missing") {
      res.writeHead(404); res.end('<title>404 Page not found</title><h1>Page not found</h1>');
    } else {
      res.end(`<title>Rendered story</title><article><h1>Rendered story</h1><div id="body"></div></article><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script><script>setTimeout(() => document.querySelector('#body').innerHTML = '<p>${"Evidence only available after rendering. ".repeat(70)}</p>', 250)</script>`);
    }
  });
  await new Promise(resolve => server.listen(0, "0.0.0.0", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const destination = `http://localhost:${server.address().port}`;
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "website-reader-article-tabs-"));
  const extensionPath = path.join(profile, "extension");
  await fs.mkdir(extensionPath);
  const source = path.resolve(import.meta.dirname, "..");
  for (const name of ["manifest.json", "popup.html", "popup.css", "popup.js", "background.js", "issue-digest-prompt.md", "email-digest-prompt.md"]) await fs.copyFile(path.join(source, name), path.join(extensionPath, name));
  const manifest = JSON.parse(await fs.readFile(path.join(extensionPath, "manifest.json")));
  manifest.host_permissions.push("http://127.0.0.1/*", "http://localhost/*");
  await fs.writeFile(path.join(extensionPath, "manifest.json"), JSON.stringify(manifest));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: true, acceptDownloads: true, args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
    let [worker] = context.serviceWorkers();
    worker ||= await context.waitForEvent("serviceworker");
    const id = new URL(worker.url()).host;
    assert.equal((await worker.evaluate(async () => await chrome.sidePanel.getPanelBehavior())).openPanelOnActionClick, true);
    let articleLinks = [];
    await context.route("https://mail.google.com/**", route => route.fulfill({ contentType: "text/html", body: `<div role="main"><h2 class="hP">Newsletter</h2><div class="adn" data-legacy-message-id="selected"><span class="gD" email="sender@newsletter.test">Sender</span><div class="a3s"><p>Email commentary</p><a href="https://substack.com/profile/123-author">Author</a><a href="https://substack.com/app-link/post">LIKE</a><a href="https://substack.com/redirect/header"><img src="header.png"></a><a href="https://substack.com/redirect/app">View in App</a><a href="https://substack.com/redirect/podcast">Spotify</a><a href="https://maps.google.com/maps?q=address">Postal address</a><a href="https://www.google.com/maps/place/address">Address</a><a href="https://newsletter.test/jobs">Careers</a><footer><a href="https://newsletter.test/contact">Footer utility</a></footer>${articleLinks.map(url => `<a href="${url}">Story</a>`).join("")}<a href="https://medium.com/@phynixai">Author</a><a href="https://itunes.apple.com/app/medium/id828256236">Get the app</a></div></div></div>` }));
    const gmail = await context.newPage();
    const gmailUrl = "https://mail.google.com/mail/u/0/#inbox/newsletter";
    async function openPopup() {
      const popup = await context.newPage();
      await gmail.bringToFront();
      await popup.goto(`chrome-extension://${id}/popup.html`);
      await popup.getByRole("button", { name: "Collect email and articles" }).waitFor();
      await popup.evaluate(() => { chrome.permissions.request = async ({ origins }) => { globalThis.requestedOrigins = origins; return true; }; });
      return popup;
    }
    async function state() { return await worker.evaluate(async () => (await chrome.storage.local.get("collectionState")).collectionState); }
    async function waitState(popup, status) {
      for (let attempt = 0; attempt < 300; attempt++) {
        if ((await state())?.status === status) return;
        await popup.waitForTimeout(100);
      }
      assert.fail(JSON.stringify(await state()));
    }

    await t.test("redirect access pauses, then reads rendered content and closes its tab", async () => {
      articleLinks = [`${origin}/redirect`];
      await gmail.goto(gmailUrl);
      await worker.evaluate(() => { globalThis.originalContains = chrome.permissions.contains; chrome.permissions.contains = async options => options.origins.some(origin => origin.startsWith("http://localhost/")) ? false : await globalThis.originalContains(options); });
      let popup = await openPopup();
      await popup.getByRole("button", { name: "Collect email and articles" }).click();
      await waitState(popup, "paused");
      const paused = await state();
      assert.equal(paused.challengeUrl, `${destination}/rendered`);
      assert.equal(paused.currentIndex, 0);
      assert.equal(paused.articles.length, 1);
      assert.match(paused.statusMessage, /Site access required/);
      assert.ok(context.pages().some(page => page.url() === paused.challengeUrl));
      await popup.close();
      await worker.evaluate(() => { chrome.permissions.contains = globalThis.originalContains; });
      await worker.evaluate(async () => {
        const { collectionState } = await chrome.storage.local.get("collectionState");
        collectionState.articles.push({ url: "https://maps.google.com/maps?q=address", title: "Postal address", markdown: "" });
        await chrome.storage.local.set({ collectionState });
      });
      popup = await openPopup();
      await popup.getByRole("button", { name: "Continue collection" }).click();
      await waitState(popup, "completed");
      assert.ok((await popup.evaluate(() => globalThis.requestedOrigins)).includes("http://localhost/*"));
      const done = await state();
      assert.equal(done.articles.length, 1, "saved footer links are removed before resuming");
      assert.match(done.articles[0].markdown, /Evidence only available after rendering/);
      assert.equal(done.articles[0].sourceUrl, `${destination}/rendered`);
      assert.equal(done.articleTabId, undefined);
      assert.deepEqual(requests.filter(url => url === "/redirect"), ["/redirect"]);
      assert.ok(!context.pages().some(page => page.url() === `${destination}/rendered`));
      await popup.close();
    });

    await t.test("redirects to a homepage or decorative media are discarded without expanding the email queue", async () => {
      await worker.evaluate(async () => await chrome.storage.local.clear());
      articleLinks = [`${origin}/navigation`, `${origin}/media`, `${origin}/rendered`];
      await gmail.reload();
      const popup = await openPopup();
      await popup.getByRole("button", { name: "Collect email and articles" }).click();
      await waitState(popup, "completed");
      const done = await state();
      assert.equal(done.articles.length, 1);
      assert.equal(done.articles[0].url, `${origin}/rendered`);
      assert.equal(done.currentIndex, 1);
      assert.equal(done.articleTabId, undefined);
      assert.match(done.log.join("\n"), /IGNORED.*navigation/);
      assert.match(done.log.join("\n"), /IGNORED.*media/);
      assert.ok(!context.pages().some(page => page.url().startsWith(origin)));
      await popup.close();
    });

    await t.test("a visible browser challenge still pauses and keeps its tab open", async () => {
      await worker.evaluate(async () => await chrome.storage.local.clear());
      articleLinks = [`${origin}/challenge`];
      await gmail.reload();
      const popup = await openPopup();
      await popup.getByRole("button", { name: "Collect email and articles" }).click();
      await waitState(popup, "paused");
      assert.match((await state()).statusMessage, /Browser challenge detected/);
      const article = context.pages().find(page => page.url() === `${origin}/challenge`);
      assert.ok(article);
      await article.close();
      await popup.close();
    });

    await t.test("login tab stays open and Continue reuses it after sign-in", async () => {
      await worker.evaluate(async () => await chrome.storage.local.clear());
      articleLinks = [`${origin}/locked`];
      await gmail.reload();
      let popup = await openPopup();
      await popup.getByRole("button", { name: "Collect email and articles" }).click();
      await waitState(popup, "paused");
      const paused = await state();
      assert.match(paused.statusMessage, /Login or subscription required/);
      const article = context.pages().find(page => page.url() === `${origin}/locked`);
      assert.ok(article);
      loggedIn = true;
      await article.reload();
      await popup.close();
      popup = await openPopup();
      await popup.getByRole("button", { name: "Continue collection" }).click();
      await waitState(popup, "completed");
      assert.match((await state()).articles[0].markdown, /Evidence only available after rendering/);
      assert.ok(article.isClosed());
      await popup.close();
    });

    await t.test("Skip closes the login tab and missing articles do not block completion", async () => {
      await worker.evaluate(async () => await chrome.storage.local.clear());
      loggedIn = false;
      articleLinks = [`${origin}/locked`, `${origin}/missing`];
      await gmail.reload();
      let popup = await openPopup();
      await popup.getByRole("button", { name: "Collect email and articles" }).click();
      await waitState(popup, "paused");
      await popup.close();
      popup = await openPopup();
      await popup.getByRole("button", { name: "Skip article" }).click();
      await waitState(popup, "completed");
      const done = await state();
      assert.match(done.articles[0].markdown, /Skipped by the user/);
      assert.match(done.articles[1].markdown, /Article page not found/);
      assert.ok(!context.pages().some(page => page.url().startsWith(origin)));
      assert.equal(gmail.url(), gmailUrl);
      await popup.close();
    });
    await t.test("Free Press email candidates exclude external sources but retain Substack redirects", async () => {
      await gmail.evaluate(() => {
        document.querySelector(".gD").textContent = "The Free Press";
        document.querySelector(".a3s").innerHTML = '<a href="https://www.thefp.com/p/story">Free Press story</a><a href="https://substack.com/redirect/opaque">Tracked story</a><a href="https://cbsnews.com/news/story">CBS source</a><a href="https://thefp.com.fake.test/p/story">Lookalike</a><a href="https://www.thefp.com/archive">Archive</a>';
      });
      const code = await fs.readFile(path.join(source, "popup.js"), "utf8");
      const capture = vm.runInNewContext(code.slice(code.indexOf("function captureEmails("), code.indexOf("function isIssueUrl(")) + ";captureEmails;");
      const [email] = await gmail.evaluate(capture);
      assert.deepEqual(email.articles.map(article => article.url), ["https://www.thefp.com/p/story", "https://substack.com/redirect/opaque"]);
      assert.match(email.markdown, /CBS source/);
    });
  } finally {
    await context?.close();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(profile, { recursive: true, force: true });
  }
});

test("browser restart forgets stale article tab IDs without operating on tabs", async () => {
  let restart;
  let state = { status: "running", articleTabId: 123, currentIndex: 2, articles: [{ title: "Saved article" }] };
  const event = { addListener() {} };
  const chrome = {
    sidePanel: { async setPanelBehavior() {} },
    runtime: { onMessage: event, onStartup: { addListener(listener) { restart = listener; } } },
    tabs: { onRemoved: event, onUpdated: event },
    downloads: { onChanged: event },
    storage: { local: { async get() { return { collectionState: structuredClone(state) }; }, async set(value) { state = value.collectionState; } } }
  };
  vm.runInNewContext(await fs.readFile(path.resolve(import.meta.dirname, "../background.js"), "utf8"), { chrome });
  await restart();
  assert.equal(state.articleTabId, undefined);
  assert.equal(state.status, "paused");
  assert.equal(state.currentIndex, 2);
  assert.equal(state.articles[0].title, "Saved article");
  assert.match(state.statusMessage, /Browser restarted/);
});
