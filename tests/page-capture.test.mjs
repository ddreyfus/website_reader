import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";

test("unlisted sites expose page/feed capture and preserve the saved batch", async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "reader-page-capture-"));
  const source = path.resolve(import.meta.dirname, "..");
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium", headless: true, acceptDownloads: true,
    args: [`--disable-extensions-except=${source}`, `--load-extension=${source}`]
  });
  try {
    let [worker] = context.serviceWorkers();
    worker ||= await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    // Attach Playwright before navigation so background-tab fixtures are routed.
    await worker.evaluate(() => {
      const create = chrome.tabs.create.bind(chrome.tabs);
      chrome.tabs.create = async options => {
        const tab = await create({ ...options, url: "about:blank" });
        await new Promise(resolve => setTimeout(resolve, 100));
        return chrome.tabs.update(tab.id, { url: options.url });
      };
    });
    const saved = { status: "completed", editionUrl: "https://mail.google.com/::old", emailId: "old", sourceUrl: "https://mail.google.com/", filename: "old-newsletter.md", statusMessage: "Downloaded email and 15 articles.", heading: "Earlier email", articles: [], log: [] };
    await worker.evaluate(async saved => chrome.storage.local.set({ collectionState: saved }), saved);
    await context.route("http://127.0.0.1/page*", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><title>Unlisted site</title><nav>Navigation outside main</nav><main><h1>Current page evidence</h1><p>Loaded rendered content.</p><p hidden>Hidden text excluded.</p><article>First loaded post.</article><article>Second loaded post.</article><a href="/linked">Source link</a><a href="/linked-two">Second article</a><a href="/hidden" hidden>Hidden link</a><a href="javascript:void(0)">Page action</a></main>` }));
    let releaseArticle;
    const articleReady = new Promise(resolve => { releaseArticle = resolve; });
    let releaseSecond;
    const secondReady = new Promise(resolve => { releaseSecond = resolve; });
    await context.route("http://127.0.0.1/linked-two", async route => {
      await secondReady;
      await route.fulfill({ contentType: "text/html", body: `<article><h1>Second article</h1><p>${"Second unique article evidence. ".repeat(60)}</p></article>` });
    });
    await context.route("http://127.0.0.1/linked", async route => {
      await articleReady;
      await route.fulfill({ contentType: "text/html", body: `<article><h1>Linked article</h1><h2>Introductory deck</h2></article><section><p>${"Unique linked article evidence. ".repeat(60)}</p></section>` });
    });
    const page = await context.newPage();
    await page.goto("http://127.0.0.1/page");
    const panel = await context.newPage();
    await page.bringToFront();
    await panel.goto(`chrome-extension://${extensionId}/popup.html`);
    await panel.setViewportSize({ width: 353, height: 700 });
    await panel.waitForFunction(() => !document.querySelector("#capture-page").disabled);
    assert.equal(await panel.locator("#collect").isVisible(), false);
    assert.equal(await panel.locator("#feed-recorder").isVisible(), true);
    assert.doesNotMatch(await panel.locator("#status").textContent(), /Downloaded email/);
    await panel.evaluate(() => { chrome.permissions.request = async () => false; });
    await panel.click("#capture-page");
    await panel.getByText("Page access was declined.", { exact: true }).waitFor();
    assert.equal(await panel.locator("#attachment-file").evaluate(input => input.files.length), 0);
    await panel.evaluate(() => { chrome.permissions.request = () => new Promise(resolve => { window.resolvePageAccess = resolve; }); });
    await panel.click("#capture-page");
    await panel.waitForFunction(() => typeof window.resolvePageAccess === "function");
    assert.equal(await panel.locator("#attachment-file").isDisabled(), true);
    assert.equal(await panel.locator("#handoff").isDisabled(), true);
    await page.goto("http://127.0.0.1/page?changed");
    await panel.evaluate(() => window.resolvePageAccess(true));
    await panel.getByText(/The current page changed/).waitFor();
    assert.equal(await panel.locator("#attachment-file").evaluate(input => input.files.length), 0);
    await page.goto("http://127.0.0.1/page");
    await panel.waitForFunction(() => currentPageTab?.url === "http://127.0.0.1/page");
    await panel.evaluate(() => { chrome.permissions.request = async () => true; });
    await panel.click("#capture-page");
    await panel.getByText(/Collecting 1 of 2:/).waitFor();
    assert.equal(await panel.locator("#page-capture-progress").isVisible(), true);
    assert.deepEqual(await panel.locator("#page-capture-progress").evaluate(element => ({ value: element.value, max: element.max })), { value: 0, max: 2 });
    releaseArticle();
    await panel.getByText(/Collecting 2 of 2:/).waitFor();
    assert.deepEqual(await panel.locator("#page-capture-progress").evaluate(element => ({ value: element.value, max: element.max })), { value: 1, max: 2 });
    releaseSecond();
    await panel.getByText(/Captured Unlisted site/).waitFor();
    assert.match(await panel.locator("#page-capture-status").textContent(), /Collected 2 articles/);
    assert.equal(await panel.locator("#page-capture-progress").evaluate(element => element.value), 2);
    const file = await panel.locator("#attachment-file").evaluate(async input => ({ name: input.files[0].name, text: await input.files[0].text() }));
    assert.match(file.name, /^page-127\.0\.0\.1-.*\.md$/);
    assert.match(file.text, /Current page evidence/);
    assert.match(file.text, /Unique linked article evidence/);
    assert.match(file.text, /Second unique article evidence/);
    assert.match(file.text, /First loaded post/);
    assert.match(file.text, /Second loaded post/);
    assert.match(file.text, /\[Source link\]\(<http:\/\/127\.0\.0\.1\/linked>\)/);
    assert.doesNotMatch(file.text, /Hidden text|Hidden link|Navigation outside main|javascript:/);
    assert.equal(await panel.locator("#handoff").isEnabled(), true);
    assert.match(await panel.locator("#attachment-status").textContent(), /page-127/);
    assert.deepEqual(await worker.evaluate(async () => (await chrome.storage.local.get("collectionState")).collectionState), saved);
    const downloads = await worker.evaluate(async () => chrome.downloads.search({}));
    assert.equal(downloads.length, 1);
    assert.equal(decodeURIComponent(downloads[0].url.split(",").slice(1).join(",")), file.text);
    let handedOff;
    await panel.evaluate(() => {
      chrome.permissions.request = async () => true;
      chrome.runtime.sendMessage = async message => { window.testHandoff = message; return { ok: true }; };
      navigator.clipboard.writeText = async text => { window.testPrompt = text; };
    });
    await panel.click("#handoff");
    await panel.waitForFunction(() => window.testHandoff?.type === "handoff");
    handedOff = await panel.evaluate(() => window.testHandoff);
    assert.equal(handedOff.content, file.text);
    assert.equal(handedOff.filename, file.name);
    const prompt = await panel.evaluate(() => window.testPrompt);
    assert.match(prompt, /website article collection/);
    assert.match(prompt, /listing as an index/);
    assert.doesNotMatch(prompt, /Read the uploaded newsletter reading batch/);
    await panel.screenshot({ path: path.join(os.tmpdir(), "website-reader-page-controls.png"), fullPage: true });
    const newWindow = context.waitForEvent("page");
    await panel.click("#feed-recorder");
    const recording = await newWindow;
    await recording.waitForURL(/feed-recorder\.html\?tabId=/);
    await recording.getByText(/Unlisted site: http/).waitFor();
    await page.goto("http://127.0.0.1/page?next");
    await recording.getByText(/Source tab navigated/).waitFor();
  } finally {
    await context.close();
    await fs.rm(profile, { recursive: true, force: true });
  }
});
