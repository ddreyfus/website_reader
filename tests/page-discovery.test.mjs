import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { chromium } from "playwright";

const collection = await fs.readFile(new URL("../collection.js", import.meta.url), "utf8");
const popup = await fs.readFile(new URL("../popup.js", import.meta.url), "utf8");

test("Spectrum issue discovers all sibling article cards without a main element", async () => {
  // Structure and article URLs observed on the October 2026 issue page.
  const slugs = ["delhi-electricity-loss", "alternatives-to-animal-testing", "inference-hardware-revolution", "rivian-self-driving", "chips-act-impact-semiconductor-manufacturing", "canadian-rockets", "augmental-mouthpad-assistive-tongue-interface", "ai-designed-virus", "mexico-olinia-car-electric-vehicle", "space-debris-atmosphere-burn-up", "electricity-theft", "bloomberg-terminal", "poetry-user-interface-design", "asteroid-shadow", "sustainability-robotics-barbara-mazzolai", "hermes-shortwave-radio-digital-data"];
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  try {
    const page = await browser.newPage();
    await page.route("https://spectrum.ieee.org/**", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><title>October 2026 - IEEE Spectrum</title><nav><a href="/">Home</a></nav><h1>October 2026 Issue</h1>${slugs.map(slug => `<article class="image-article"><a href="/${slug}"><img alt="${slug}"></a><a href="/topic/energy/">Energy</a><a href="/type/feature/">Feature</a><h2><a href="/${slug}">${slug}</a></h2><h3>Article teaser</h3><a href="/${slug}#comments">Comments</a><a href="javascript:;">Save post</a></article>`).join("")}<article hidden><h2><a href="/hidden-article">Hidden article</a></h2></article><a href="/magazine/2026/september">Explore more issues</a><a href="/files/issue.pdf">Download PDF</a>` }));
    await page.goto("https://spectrum.ieee.org/magazine/2026/october/");
    await page.addScriptTag({ content: collection });
    const result = await page.evaluate(() => captureCurrentPage());
    assert.deepEqual(result.articles, slugs.map(slug => `https://spectrum.ieee.org/${slug}`));
    assert.match(result.content, /October 2026 Issue/);
    assert.match(result.content, /hermes-shortwave-radio-digital-data/);
    // A card's own header is content, not the site's navigation header.
    await page.locator("article h2").evaluateAll(headings => headings.forEach(heading => {
      const header = document.createElement("header");
      heading.replaceWith(header);
      header.append(heading);
    }));
    assert.deepEqual((await page.evaluate(() => captureCurrentPage())).articles, result.articles);
  } finally {
    await browser.close();
  }
});

test("digest prompts distinguish Gmail newsletters, website collections, and publication issues", async () => {
  const context = vm.createContext({
    URL,
    chrome: { runtime: { getURL: name => name } },
    async fetch(name) { return { ok: true, text: () => fs.readFile(new URL(`../${name}`, import.meta.url), "utf8") }; }
  });
  vm.runInContext(popup.slice(popup.indexOf("function isGmailUrl("), popup.indexOf("function captureEmails(")), context);
  vm.runInContext(popup.slice(popup.indexOf("function isIssueUrl("), popup.indexOf("function editionUrl(")), context);
  vm.runInContext(popup.slice(popup.indexOf("async function digestPrompt("), popup.indexOf('copyButton.addEventListener("click"')), context);
  const website = await context.digestPrompt("https://spectrum.ieee.org/magazine/2026/october/");
  assert.match(website, /^Read the uploaded IEEE Spectrum website article collection/);
  assert.match(website, /listing as an index/);
  assert.match(website, /each distinct article URL separately/);
  assert.doesNotMatch(website, /Read the uploaded newsletter/);
  const email = await context.digestPrompt("https://mail.google.com/mail/u/0/#inbox/selected");
  assert.match(email, /^Read the uploaded newsletter reading batch/);
  assert.match(email, /Email commentary/);
  assert.doesNotMatch(email, /listing as an index/);
  const issue = await context.digestPrompt("https://www.economist.com/weeklyedition/2026-10-03");
  assert.match(issue, /^Read the uploaded Economist issue/);
  assert.doesNotMatch(issue, /website article collection/);
});


test("discovery retains heading and paragraph links outside article cards", async () => {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  try {
    const page = await browser.newPage();
    await page.route("https://publication.test/**", route => route.fulfill({ contentType: "text/html", body: `<title>Collection</title><nav><a href="/navigation">Navigation</a></nav><article><h2><a href="/one">One</a></h2></article><article><h2><a href="/two">Two</a></h2></article><section><header><h2><a href="/three">Three</a></h2></header><p>Read <a href="https://other.test/four">this investigation</a>.</p></section>` }));
    await page.goto("https://publication.test/collection");
    await page.addScriptTag({ content: collection });
    assert.deepEqual((await page.evaluate(() => captureCurrentPage())).articles, ["https://publication.test/one", "https://publication.test/two", "https://publication.test/three", "https://other.test/four"]);
  } finally { await browser.close(); }
});

test("extraction finds split bodies and rejects introductory false successes", async () => {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  try {
    const page = await browser.newPage();
    await page.goto("about:blank");
    await page.addScriptTag({ content: collection });
    const extract = html => page.evaluate(html => markdownFromHtml(html, "https://publication.test/story"), html);
    const opening = "Opening substantive evidence. ".repeat(30);
    const ending = "Closing substantive argument. ".repeat(30);
    const intro = `<article><h1>Story title</h1><h2>${"Introductory deck. ".repeat(40)}</h2><div class="author-bio"><p>${"Biography only. ".repeat(90)}</p></div></article>`;
    const result = await extract(`${intro}<article><div class="body-description"><p>${opening}</p></div><div class="body-description"><p>${ending}</p></div></article><aside><p>Unrelated recommendation</p></aside>`);
    assert.equal(result.unsupported, false);
    assert.match(result.markdown, /Opening substantive evidence/);
    assert.match(result.markdown, /Closing substantive argument/);
    assert.doesNotMatch(result.markdown, /Biography only|Unrelated recommendation|Introductory deck/);
    assert.ok(result.markdown.indexOf("Opening substantive evidence") < result.markdown.indexOf("Closing substantive argument"));
    const generic = await extract(`${intro}<section><div><p>${opening}</p></div><div><p>${ending}</p></div></section>`);
    assert.equal(generic.unsupported, false);
    assert.match(generic.markdown, /Opening substantive evidence/);
    assert.match(generic.markdown, /Closing substantive argument/);
    const siblings = await extract(`${intro}<article><p>${opening}</p></article><article><p>${ending}</p></article>`);
    assert.equal(siblings.unsupported, false);
    assert.match(siblings.markdown, /Opening substantive evidence/);
    assert.match(siblings.markdown, /Closing substantive argument/);
    const missing = await extract(intro);
    assert.equal(missing.unsupported, true);
    assert.match(missing.markdown, /Incomplete extraction/);
    assert.doesNotMatch(missing.markdown, /paywall|preview/);
    const poem = await extract(`${intro}<article><div class="body-description"><p>${"A line of the poem.<br>".repeat(35)}</p></div></article>`);
    assert.equal(poem.unsupported, false);
  } finally { await browser.close(); }
});
