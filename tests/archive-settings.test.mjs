import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";

test("extension loads, saves, and reconnects archive settings", async () => {
  let settings = { port: 8766, archive_root: "~/reading-archive", index_directories: ["~/articles"], search_limit: 30 };
  const service = http.createServer(async (request, response) => {
    if (request.method === "PUT") {
      let body = "";
      for await (const chunk of request) body += chunk;
      settings = JSON.parse(body);
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ ...settings, active_port: service.address().port, active_archive_root: "/test/archive" }));
  });
  await new Promise(resolve => service.listen(0, "127.0.0.1", resolve));
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "archive-settings-"));
  let context;
  try {
    const extension = path.resolve(import.meta.dirname, "..");
    context = await chromium.launchPersistentContext(profile, {
      channel: "chromium", headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
    });
    let [worker] = context.serviceWorkers();
    worker ||= await context.waitForEvent("serviceworker");
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
    await page.locator("#archive-settings summary").click();
    await page.locator("#archive-connection-port").fill(String(service.address().port));
    await page.getByRole("button", { name: "Load settings" }).click();
    await page.getByText(/Connected on port/).waitFor();
    assert.equal(await page.locator("#archive-root").inputValue(), "~/reading-archive");
    assert.equal(await page.locator("#archive-directories").inputValue(), "~/articles");
    await page.locator("#archive-port").fill("9876");
    await page.locator("#archive-root").fill("~/new-archive");
    await page.locator("#archive-search-limit").fill("42");
    await page.locator("#archive-directories").fill("~/articles\n\n /test/source \n");
    await page.getByRole("button", { name: "Save settings" }).click();
    await page.getByText(/Settings saved. Restart/).waitFor();
    assert.deepEqual(settings, { port: 9876, archive_root: "~/new-archive", index_directories: ["~/articles", "/test/source"], search_limit: 42 });
    assert.equal(await page.locator("#archive-connection-port").inputValue(), "9876");
    // A failed reconnect must disable edits rather than retain stale service state.
    await page.locator("#archive-connection-port").fill("1");
    await page.getByRole("button", { name: "Load settings" }).click();
    await page.getByText(/Could not connect:/).waitFor();
    assert.equal(await page.getByRole("button", { name: "Save settings" }).isDisabled(), true);
  } finally {
    await context?.close();
    await new Promise(resolve => service.close(resolve));
    await fs.rm(profile, { recursive: true, force: true });
  }
});
