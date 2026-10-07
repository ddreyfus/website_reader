import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";

test("ChatGPT handoff uses the saved batch from any active tab", async (t) => {
  const source = path.resolve(import.meta.dirname, "..");
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "website-reader-handoff-"));
  const extensionPath = path.join(profile, "extension");
  await fs.mkdir(extensionPath);
  for (const name of ["collection.js", "manifest.json", "popup.js", "popup.html", "popup.css", "background.js", "issue-digest-prompt.md", "email-digest-prompt.md"]) {
    await fs.copyFile(path.join(source, name), path.join(extensionPath, name));
  }
  const manifest = JSON.parse(await fs.readFile(path.join(extensionPath, "manifest.json"), "utf8"));
  manifest.host_permissions.push("https://chatgpt.com/*");
  await fs.writeFile(path.join(extensionPath, "manifest.json"), JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium", headless: true, acceptDownloads: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  try {
    let [worker] = context.serviceWorkers();
    worker ||= await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    let signedIn = true;
    let startupDelay = 0;
    let uploadError = false;
    await context.route("https://**/*", async (route) => {
      await route.fulfill({ status: 200, contentType: "text/html", body: route.request().url().startsWith("https://chatgpt.com/")
        ? signedIn ? `<!doctype html><form><div ${startupDelay ? 'data-composer-markdown role="textbox"' : 'id="prompt-textarea"'} contenteditable="true"></div><input type="file" aria-label="Attach photos" accept="image/*"><input type="file" aria-label="Attach files"><div ${startupDelay ? 'data-test-attachments' : 'data-composer-attachments'}></div></form><script>const composer = document.querySelector("[contenteditable]"); composer.contentEditable = "false"; setTimeout(() => composer.contentEditable = "true", ${startupDelay});document.querySelector('[aria-label="Attach files"]').addEventListener('change', async event => { const file = event.target.files[0]; if (${uploadError}) { const alert = document.createElement("div"); alert.setAttribute("role", "alert"); alert.textContent = "Unable to find " + file.name; document.body.append(alert); return; } document.querySelector('[data-test-attachments], [data-composer-attachments]').textContent = file.name; document.querySelector('[data-test-attachments], [data-composer-attachments]').dataset.content = await file.text(); });</script>` : "<!doctype html><h1>Welcome</h1><button>Log in</button>"
        : "<!doctype html><h1>Unrelated tab</h1>" });
    });

    // tabs.create's initial navigation can bypass Playwright routing. Use a
    // preloaded fixture tab so this test never contacts the live service.
    await worker.evaluate(() => {
      chrome.tabs.create = async (options) => {
        if (options.url !== "https://chatgpt.com/" || !options.active) throw new Error("Unexpected handoff destination");
        const [fixture] = await chrome.tabs.query({ url: "https://chatgpt.com/" });
        await chrome.tabs.update(fixture.id, { active: true });
        return await chrome.tabs.get(fixture.id);
      };
    });

    for (const [publication, sourceUrl, promptPattern] of [
      ["email", "https://mail.google.com/mail/u/0/#inbox/selected-email", /Read the uploaded newsletter reading batch/],
      ["Economist", "https://www.economist.com/weeklyedition/2026-09-26", /Read the uploaded Economist issue/]
    ]) {
      startupDelay = publication === "email" ? 11000 : 0;
      await t.test(`attaches ${publication} content and copies its prompt`, async () => {
        const article = `## Example\n\nExact collected content: 100% — café.\n${"Long article text. ".repeat(10000)}`;
        const content = `# ${publication} batch\n\nSource: ${sourceUrl}\n\n## Contents\n\n- [Example](#article-1)\n\n---\n\n<a id="article-1"></a>\n\n${article}\n`;
        await worker.evaluate(async ({ content, sourceUrl, article, publication }) => {
          const downloadId = await chrome.downloads.download({ url: `data:text/markdown;charset=utf-8,${encodeURIComponent(content)}`, filename: "reading-batch.md" });
          await chrome.storage.local.set({ collectionState: { status: "completed", downloadId, sourceUrl, filename: "reading-batch.md", heading: `${publication} batch`, editionUrl: sourceUrl, articles: [{ title: "Example", markdown: article }], log: [] } });
          // Handoff must work even after the download record is cleared.
          await chrome.downloads.erase({ id: downloadId });
        }, { content, sourceUrl, article, publication });
        const unrelated = await context.newPage();
        await unrelated.goto("https://unrelated.test/");
        const popup = await context.newPage();
        await unrelated.bringToFront();
        await popup.goto(`chrome-extension://${extensionId}/popup.html`);
        await popup.getByRole("button", { name: "Open in ChatGPT" }).waitFor();
        await popup.evaluate(() => { chrome.permissions.request = async () => true; });
        const chat = await context.newPage();
        await chat.goto("https://chatgpt.com/");
        await popup.bringToFront();
        await popup.getByRole("button", { name: "Open in ChatGPT" }).click();

        // Simulate the real action popup being dismissed by the new active tab.
        await chat.locator('[aria-label="Attach files"]').evaluate(input => new Promise(resolve => { if (input.files.length) resolve(); else input.addEventListener("change", resolve, { once: true }); }));
        await popup.close();
        await chat.getByRole("status").waitFor({ timeout: 15000 });
        assert.match(await chat.getByRole("status").textContent(), /Reading batch attached/);
        const attached = await chat.locator("[data-test-attachments], [data-composer-attachments]").getAttribute("data-content");
        assert.equal(attached, content);
        await context.grantPermissions(["clipboard-read"], { origin: "https://chatgpt.com" });
        assert.match(await chat.evaluate(async () => await navigator.clipboard.readText()), promptPattern);
        assert.equal(await chat.locator('[aria-label="Attach photos"]').evaluate(input => input.files.length), 0);
        assert.equal(await chat.locator('[aria-label="Attach files"]').evaluate(input => input.files[0].name), "reading-batch.md");
        await chat.close();
        await unrelated.close();
      });
    }

    await t.test("Economist homepage opens its latest linked issue while retaining the saved batch", async () => {
      const before = await worker.evaluate(async () => (await chrome.storage.local.get("collectionState")).collectionState);
      const issueUrl = "https://www.economist.com/weeklyedition/2026-10-03";
      await context.route("https://www.economist.com/**", route => route.fulfill({ status: 200, contentType: "text/html", body: `<main><a href="/weeklyedition/2026-09-26">Previous issue</a><a href="${issueUrl}">Latest issue</a></main>` }));
      const source = await context.newPage();
      await source.goto("https://www.economist.com/");
      const popup = await context.newPage();
      await source.bringToFront();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      await popup.getByRole("button", { name: "Open Economist weekly edition" }).click();
      await source.waitForURL(issueUrl);
      await popup.getByRole("button", { name: "Collect The Economist issue", exact: true }).waitFor();
      assert.equal(await popup.locator("#collect").isEnabled(), true);
      assert.deepEqual(await worker.evaluate(async () => (await chrome.storage.local.get("collectionState")).collectionState), before);
      await popup.close();
      await source.close();
    });

    await t.test("chosen file attaches exact text without replacing the saved batch", async () => {
      startupDelay = 0;
      const before = await worker.evaluate(async () => (await chrome.storage.local.get("collectionState")).collectionState);
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      await popup.evaluate(() => { chrome.permissions.request = async () => true; });
      const content = "# Chosen issue\n\nExact file text — café.\n";
      await popup.locator("#attachment-file").setInputFiles({ name: "chosen.md", mimeType: "text/markdown", buffer: Buffer.from(content) });
      assert.match(await popup.locator("#attachment-status").textContent(), /chosen.md/);
      const chat = await context.newPage();
      await chat.goto("https://chatgpt.com/");
      await popup.bringToFront();
      await popup.getByRole("button", { name: "Open in ChatGPT" }).click();
      await chat.getByRole("status").waitFor();
      assert.equal(await chat.locator("[data-composer-attachments]").getAttribute("data-content"), content);
      assert.equal(await chat.locator('[aria-label="Attach files"]').evaluate(input => input.files[0].name), "chosen.md");
      assert.deepEqual(await worker.evaluate(async () => (await chrome.storage.local.get("collectionState")).collectionState), before);
      await popup.getByRole("button", { name: "Use saved collection instead" }).click();
      assert.match(await popup.locator("#attachment-status").textContent(), /reading-batch.md/);
      await chat.close();
      await popup.close();
    });

    await t.test("shows a manual-attachment fallback when ChatGPT requires login", async () => {
      signedIn = false;
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      await popup.getByRole("button", { name: "Open in ChatGPT" }).waitFor();
      await popup.evaluate(() => { chrome.permissions.request = async () => true; });
      const chat = await context.newPage();
      await chat.goto("https://chatgpt.com/");
      await popup.bringToFront();
      await popup.getByRole("button", { name: "Open in ChatGPT" }).click();

      await chat.getByRole("status").filter({ hasText: "Automatic attachment unavailable" }).waitFor({ timeout: 35000 });
      assert.match(await chat.getByRole("status").textContent(), /showing a sign-in control/);
      await popup.waitForFunction(() => document.querySelector("#status").textContent.includes("showing a sign-in control"));
      await chat.close();
      await popup.close();
    });

    await t.test("preserves ChatGPT upload errors in the panel and log", async () => {
      signedIn = true;
      startupDelay = 0;
      uploadError = true;
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      await popup.evaluate(() => { chrome.permissions.request = async () => true; });
      const chat = await context.newPage();
      await chat.goto("https://chatgpt.com/");
      await popup.bringToFront();
      await popup.getByRole("button", { name: "Open in ChatGPT" }).click();
      await chat.getByRole("status").waitFor();
      assert.match(await chat.getByRole("status").textContent(), /ChatGPT reported: Unable to find reading-batch.md/);
      assert.doesNotMatch(await chat.getByRole("status").textContent(), /Sign in/);
      await popup.waitForFunction(() => document.querySelector("#status").textContent.includes("Unable to find"));
      const log = await worker.evaluate(async () => (await chrome.storage.local.get("latestLog")).latestLog);
      assert.match(log, /ChatGPT handoff failed:.*Unable to find reading-batch.md/);
      await chat.close();
      await popup.close();
    });
  } finally {
    await context.close();
    await fs.rm(profile, { recursive: true, force: true });
  }
});
