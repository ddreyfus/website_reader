import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chromium } from "playwright";

test("feed experiment preserves removed posts, nested scrolling, video, and cleanup", async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "feed-capture-test-"));
  const extension = path.join(profile, "extension");
  await fs.mkdir(extension);
  const root = path.resolve(import.meta.dirname, "..");
  for (const name of ["manifest.json", "background.js", "collection.js", "popup.html", "popup.css", "popup.js", "feed-recorder.html", "feed-recorder.js", "feed-capture.js"]) {
    await fs.copyFile(path.join(root, name), path.join(extension, name));
  }
  const publicKey = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ type: "spki", format: "der" });
  const captureExtensionId = Array.from(createHash("sha256").update(publicKey).digest().subarray(0, 16), byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join("");
  const manifest = JSON.parse(await fs.readFile(path.join(extension, "manifest.json"), "utf8"));
  manifest.key = publicKey.toString("base64");
  await fs.writeFile(path.join(extension, "manifest.json"), JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium", headless: true, acceptDownloads: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, `--allowlisted-extension-id=${captureExtensionId}`]
  });
  try {
    let [worker] = context.serviceWorkers();
    worker ||= await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    await context.route("http://127.0.0.1/feed-test*", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><title>Feed fixture</title><div id="scroll" style="height:300px;overflow:auto"><article id="post"><h2>Fixture author</h2><p>Original post visible before recycling</p><button id="expand">See more</button></article><div style="height:1500px">Lower feed</div></div><script>document.querySelector('#expand').onclick=()=>document.querySelector('#post p').textContent='Expanded post with additional evidence';</script>` }));
    const feed = await context.newPage();
    await feed.goto("http://127.0.0.1/feed-test");
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: "http://127.0.0.1/feed-test" }))[0].id);
    const recording = await context.newPage();
    await recording.setViewportSize({ width: 540, height: 600 });
    const errors = [];
    recording.on("pageerror", error => errors.push(error.message));
    await recording.goto(`chrome-extension://${extensionId}/feed-recorder.html?tabId=${tabId}`);
    await recording.waitForFunction(() => !document.querySelector("#start").disabled);
    // The isolated test browser grants capture access to this generated extension
    // ID instead of a toolbar invocation. Stream acquisition and video are native.
    await recording.click("#start");
    await recording.waitForFunction(() => !document.querySelector("#stop").disabled);
    await feed.click("#expand");
    await feed.evaluate(() => { document.querySelector("#scroll").scrollTop = 400; });
    await feed.waitForTimeout(150);
    await feed.evaluate(() => {
      document.querySelector("#post").remove();
      const post = document.createElement("article");
      post.textContent = "Replacement post from virtualized feed";
      document.querySelector("#scroll").prepend(post);
      document.querySelector("#scroll").scrollTop = 0;
    });
    await recording.waitForTimeout(1200);
    await recording.click("#stop");
    await recording.waitForFunction(() => !document.querySelector("#events-download").hidden);
    const log = await recording.evaluate(async () => (await fetch(document.querySelector("#events-download").href)).json());
    assert.equal(log.version, "feed-capture.v1");
    assert.equal(log.requestedFrameRate, 30);
    assert.ok(log.videoBytes > 1000);
    assert.ok(log.events.some(e => e.type === "initial-dom" && e.html.includes("Original post visible")));
    assert.ok(log.events.some(e => e.type === "snapshot" && e.text.some(t => t.text.includes("Original post visible"))));
    assert.ok(log.events.some(e => e.type === "click"));
    assert.ok(log.events.some(e => e.type === "scroll" && e.y === 400));
    assert.ok(log.events.some(e => e.type === "mutations" && e.records.some(r => r.removed.some(n => n.html?.includes("Expanded post with additional evidence")))));
    assert.ok(log.events.some(e => e.type === "snapshot" && e.text.some(t => t.text.includes("Replacement post"))));
    assert.equal(log.events.at(-1).type, "capture-end");
    assert.ok(log.events.every((event, index) => event.sequence === index && event.receivedAt >= event.time - 10));
    assert.ok(log.events[0].time >= log.videoStartRequestedAt);
    const [{ result: stillActive }] = await worker.evaluate(async tabId => chrome.scripting.executeScript({ target: { tabId }, func: () => !!globalThis.websiteReaderFeedCapture }), tabId);
    assert.equal(stillActive, false);
    const downloadPromise = recording.waitForEvent("download");
    await recording.click("#events-download");
    const download = await downloadPromise;
    assert.match(download.suggestedFilename(), /^feed-capture-.*\.json$/);
    assert.equal(await download.failure(), null);
    await recording.waitForFunction(() => Number.isFinite(document.querySelector("#preview").duration));
    assert.ok(await recording.locator("#preview").evaluate(video => video.duration > 0));
    await recording.screenshot({ path: path.join(os.tmpdir(), "website-reader-feed-recorder.png"), fullPage: true });
    assert.deepEqual(errors, []);
    const failedRecording = await context.newPage();
    await failedRecording.goto(`chrome-extension://${extensionId}/feed-recorder.html?tabId=${tabId}`);
    await failedRecording.waitForFunction(() => !document.querySelector("#start").disabled);
    await failedRecording.evaluate(() => { chrome.tabCapture.getMediaStreamId = async () => { throw new Error("Fixture capture access denied"); }; });
    await failedRecording.click("#start");
    await failedRecording.waitForFunction(() => document.querySelector("#recording-status").textContent.includes("Fixture capture access denied"));
    assert.equal(await failedRecording.locator("#start").isEnabled(), true);
    assert.equal(await failedRecording.locator("#stop").isEnabled(), false);
    await feed.goto("http://127.0.0.1/feed-test?changed");
    await failedRecording.waitForFunction(() => document.querySelector("#start").disabled);
    assert.match(await failedRecording.locator("#recording-status").textContent(), /Source tab navigated/);
    const navigatingRecording = await context.newPage();
    await navigatingRecording.goto(`chrome-extension://${extensionId}/feed-recorder.html?tabId=${tabId}`);
    await navigatingRecording.waitForFunction(() => !document.querySelector("#start").disabled);
    await navigatingRecording.click("#start");
    await navigatingRecording.waitForFunction(() => !document.querySelector("#stop").disabled);
    await feed.goto("http://127.0.0.1/feed-test?next");
    await navigatingRecording.waitForFunction(() => !document.querySelector("#events-download").hidden);
    const navigationLog = await navigatingRecording.evaluate(async () => (await fetch(document.querySelector("#events-download").href)).json());
    assert.match(navigationLog.stopReason, /navigated|disconnected/);
    assert.equal(await navigatingRecording.locator("#stop").isEnabled(), false);
    assert.equal(await navigatingRecording.locator("#start").isEnabled(), false);
  } finally {
    await context.close();
    await fs.rm(profile, { recursive: true, force: true });
  }
});
