import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { chromium } from "playwright";

const background = await fs.readFile(new URL("../background.js", import.meta.url), "utf8");
const collection = await fs.readFile(new URL("../collection.js", import.meta.url), "utf8");
const attachCode = background.slice(background.indexOf("async function attachBatch("), background.indexOf("function collectionMarkdown("));
const readCode = background.slice(background.indexOf("async function readArticleTab("), background.indexOf("async function downloadCollection("));

for (const origin of ["http://chatgpt.com", "https://chatgpt.com.evil.test", "https://evilchatgpt.com", "https://sub.chatgpt.com", "https://chatgpt.com:8443", "https://www.economist.com", "null"]) {
  test(`attachment rejects ${origin} before accessing the page`, async () => {
    const attach = vm.runInNewContext(`(${attachCode})`, {
      location: { origin },
      get document() { throw new Error("Attachment accessed a non-ChatGPT page"); }
    });
    const result = await attach("Collected text", "reading.md");
    assert.equal(result.ok, false);
    assert.match(result.error, /only.*https:\/\/chatgpt\.com/i);
  });
}

test("capture readers do not mutate live pages or interact with their controls", async () => {
  const readArticleTab = vm.runInNewContext(`(${readCode})`);
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  try {
    const page = await browser.newPage();
    await page.route("https://publication.test/**", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><title>Article evidence</title><main><article><h1>Article evidence</h1><p>${"Distinct article evidence. ".repeat(80)}</p><p hidden>Hidden evidence</p><p style="display:none">Invisible evidence</p><a href="/linked">Linked article</a><form><input value="Original value"><input type="checkbox" checked><input type="file"><textarea>Original draft</textarea><button>Submit</button></form></article></main>` }));
    await page.goto("https://publication.test/article");
    await page.addScriptTag({ content: collection });
    await page.evaluate(() => {
      window.captureEvents = [];
      for (const type of ["click", "input", "change", "submit"]) {
        document.addEventListener(type, () => window.captureEvents.push(type), true);
      }
      window.captureMutations = [];
      window.captureObserver = new MutationObserver(records => window.captureMutations.push(...records.map(record => record.type)));
      window.captureObserver.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    });
    const snapshot = () => page.evaluate(() => ({
      html: document.documentElement.outerHTML,
      controls: [...document.querySelectorAll("input, textarea")].map(element => ({ value: element.value, checked: element.checked, files: element.files?.length }))
    }));
    const before = await snapshot();
    const captured = await page.evaluate(() => captureCurrentPage());
    assert.match(captured.content, /Distinct article evidence/);
    assert.deepEqual(await snapshot(), before);
    const rendered = await page.evaluate(readArticleTab);
    assert.equal(rendered.error, undefined);
    assert.doesNotMatch(rendered.html, /Hidden evidence|Invisible evidence/);
    assert.deepEqual(await snapshot(), before);
    const markdown = await page.evaluate(({ html, url }) => markdownFromHtml(html, url), rendered);
    assert.match(markdown.markdown, /Distinct article evidence/);
    assert.deepEqual(await snapshot(), before);
    const audit = await page.evaluate(() => ({
      events: window.captureEvents,
      mutations: [...window.captureMutations, ...window.captureObserver.takeRecords().map(record => record.type)]
    }));
    assert.deepEqual(audit, { events: [], mutations: [] });
  } finally {
    await browser.close();
  }
});
