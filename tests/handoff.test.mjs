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
  for (const name of ["manifest.json", "popup.js", "popup.html", "popup.css", "background.js", "issue-digest-prompt.md", "email-digest-prompt.md"]) {
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
    await context.route("https://**/*", async (route) => {
      await route.fulfill({ status: 200, contentType: "text/html", body: route.request().url().startsWith("https://chatgpt.com/")
        ? signedIn ? `<!doctype html><input type="file" aria-label="Attach photos" accept="image/*"><input type="file" aria-label="Attach files"><div data-composer-attachments></div><script>document.querySelector('[aria-label="Attach files"]').addEventListener('change', async event => { const file = event.target.files[0]; document.querySelector('[data-composer-attachments]').textContent = file.name; document.querySelector('[data-composer-attachments]').dataset.content = await file.text(); });</script>` : "<!doctype html><h1>Sign in</h1>"
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
        const attached = await chat.locator("[data-composer-attachments]").getAttribute("data-content");
        assert.equal(attached, content);
        await context.grantPermissions(["clipboard-read"], { origin: "https://chatgpt.com" });
        assert.match(await chat.evaluate(async () => await navigator.clipboard.readText()), promptPattern);
        assert.equal(await chat.locator('[aria-label="Attach photos"]').evaluate(input => input.files.length), 0);
        assert.equal(await chat.locator('[aria-label="Attach files"]').evaluate(input => input.files[0].name), "reading-batch.md");
        await chat.close();
        await unrelated.close();
      });
    }

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

      await chat.getByRole("status").filter({ hasText: "Automatic attachment unavailable" }).waitFor({ timeout: 15000 });
      await chat.close();
      await popup.close();
    });
  } finally {
    await context.close();
    await fs.rm(profile, { recursive: true, force: true });
  }
});
