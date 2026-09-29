const collectButton = document.querySelector("#collect");
const continueButton = document.querySelector("#continue");
const copyButton = document.querySelector("#copy");
const downloadLogButton = document.querySelector("#download-log");
const status = document.querySelector("#status");
const logOutput = document.querySelector("#log");

let activeEditionUrl = "";

function isIssueUrl(url) {
  try {
    const parsed = new URL(url);
    return (parsed.hostname === "www.economist.com" && /^\/weeklyedition\/[^/]+\/?$/.test(parsed.pathname))
      || (parsed.hostname === "alumni.berkeley.edu" && /^\/issue\/[^/]+\/?$/.test(parsed.pathname))
      || (parsed.hostname === "cacm.acm.org" && /^\/issue\/[^/]+\/?$/.test(parsed.pathname));
  } catch {
    return false;
  }
}

function publicationName(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    if (hostname === "economist.com") return "The Economist";
    if (hostname === "alumni.berkeley.edu") return "California Magazine";
    if (hostname === "cacm.acm.org") return "Communications of the ACM";
    return hostname || "this publication";
  } catch {
    return "this publication";
  }
}

function editionUrl(url) {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

function setStatus(message, linkUrl = "") {
  status.textContent = message;
  if (!linkUrl) return;
  const link = document.createElement("a");
  link.href = linkUrl;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = "Open challenge";
  status.append(document.createElement("br"), link);
}

function renderState(state) {
  const sameEdition = state?.editionUrl === activeEditionUrl;
  const active = ["running", "paused"].includes(state?.status);
  const resumable = sameEdition && state.status === "paused";
  collectButton.disabled = !activeEditionUrl || (active && (!sameEdition || state.status === "running"));
  continueButton.disabled = !resumable;
  continueButton.hidden = !resumable;
  if (state?.log?.length) {
    logOutput.textContent = state.log.join("\n");
    downloadLogButton.disabled = false;
  }
  if (sameEdition && state.statusMessage) setStatus(state.statusMessage, state.challengeUrl);
  else if (active) setStatus(`A collection is ${state.status} for ${state.editionUrl}. Open that issue before starting another one.`);
}

async function download(content, filename, mimeType) {
  const response = await chrome.runtime.sendMessage({ type: "download", content, filename, mimeType });
  if (!response?.ok) throw new Error(response?.error || "Chrome did not start the download.");
  return response.downloadId;
}

async function collectEdition(resume, tabId) {
  if (globalThis.__websiteReaderRunning) return { error: "Collection is already running in this tab." };
  globalThis.__websiteReaderRunning = true;
  let state;

  try {
    const articleTimeoutMs = 30000;
    const minimumArticleCharacters = location.hostname === "www.economist.com" ? 1500 : 400;
    const retryDelaysMs = [5000, 10000, 20000, 40000];
    const currentEditionUrl = `${location.origin}${location.pathname}`;
    const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

    function note(message) {
      state.log.push(`${new Date().toISOString()}  ${message}`);
    }

    async function saveState(statusMessage = state.statusMessage) {
      state.statusMessage = statusMessage;
      state.updatedAt = new Date().toISOString();
      await chrome.storage.local.set({ collectionState: state, latestLog: state.log.join("\n") });
    }

    function retryAfterMs(response) {
      const value = response.headers.get("Retry-After");
      if (!value) return 0;
      const seconds = Number(value);
      if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
      const date = Date.parse(value);
      return Number.isNaN(date) ? 0 : Math.max(0, date - Date.now());
    }

    function isChallengePage(html) {
      const page = new DOMParser().parseFromString(html, "text/html");
      const heading = `${page.title} ${page.querySelector("h1")?.textContent || ""}`;
      return /(?:verify (?:that )?you are human|unusual traffic|just a moment|attention required|access denied)/i.test(heading)
        || page.querySelector('#challenge-form, form[action*="captcha" i], iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], script[src*="/cdn-cgi/challenge-platform/" i]');
    }

    function markdownFromHtml(html, url) {
      const page = new DOMParser().parseFromString(html, "text/html");
      const title = page.querySelector("h1")?.textContent.trim()
        || page.querySelector('meta[property="og:title"]')?.content.trim()
        || page.title.trim();
      const unsupportedMarkdown = () => `## ${title}\n\n[Original article](${url})\n\n> **Unsupported:** This interactive article cannot yet be extracted reliably.`;
      const interactive = new URL(url).pathname.includes("/interactive/")
        || page.querySelector('iframe[src*="infographics.economist.com"], [data-component*="interactive" i]');
      if (title && interactive) return { markdown: unsupportedMarkdown(), unsupported: true };
      const source = page.querySelector("article") || page.querySelector("main");
      if (!title || !source) return null;
      source.querySelectorAll("script, style, nav, aside, footer, form, figure, button, [hidden], [aria-hidden='true']")
        .forEach((element) => element.remove());
      const lines = [`## ${title}`, "", `[Original article](${url})`, ""];
      source.querySelectorAll("h2, h3, p, blockquote, li").forEach((element) => {
        const text = element.textContent.replace(/\s+/g, " ").trim();
        if (!text || text === title) return;
        if (element.matches("h2, h3")) lines.push(`${element.tagName === "H2" ? "###" : "####"} ${text}`, "");
        else if (element.matches("blockquote")) lines.push(`> ${text}`, "");
        else if (element.matches("li")) lines.push(`- ${text}`);
        else lines.push(text, "");
      });
      const markdown = lines.join("\n").trim();
      return markdown.length < minimumArticleCharacters
        ? { markdown: unsupportedMarkdown(), unsupported: true }
        : { markdown, unsupported: false };
    }

    const issue = location.pathname.split("/").filter(Boolean).at(-1);
    const economist = location.hostname === "www.economist.com" && location.pathname.startsWith("/weeklyedition/");
    const california = location.hostname === "alumni.berkeley.edu" && location.pathname.startsWith("/issue/");
    const cacm = location.hostname === "cacm.acm.org" && location.pathname.startsWith("/issue/");
    if (!issue || (!economist && !california && !cacm)) {
      return { error: "Open a supported publication issue page first." };
    }

    if (resume) {
      ({ collectionState: state } = await chrome.storage.local.get("collectionState"));
      if (!state || state.editionUrl !== currentEditionUrl) return { error: "There is no saved collection for this issue." };
      if (state.status === "completed") return { error: "This issue has already been collected." };
      state.status = "running";
      state.challengeUrl = "";
      state.tabId = tabId;
      note(`Continuing ${state.editionUrl} at article ${state.currentIndex + 1} of ${state.articles.length}.`);
      await saveState(`Continuing article ${state.currentIndex + 1} of ${state.articles.length}…`);
    } else {
      const links = [...document.querySelectorAll("main a[href]")]
        .map((anchor) => ({ url: new URL(anchor.href, location.href).href, title: anchor.textContent.trim() }))
        .filter(({ url, title }) => new URL(url).origin === location.origin && title.length > 2)
        .filter(({ url, title }) => {
          const pathname = new URL(url).pathname;
          if (california) return pathname.startsWith(`/california-magazine/${issue}/`) && pathname !== `/california-magazine/${issue}/`;
          if (cacm) return !/^(?:learn|read) more$/i.test(title)
            && /^\/(?:research|opinion|practice|news|research-highlights|careers)\/[^/]+\/?$/.test(pathname);
          const ignoredPaths = [
            "/weeklyedition/", "/search", "/login", "/subscribe", "/account",
            "/audio", "/podcasts", "/newsletters", "/events", "/the-world-in-brief"
          ];
          return title.length > 10 && !ignoredPaths.some((path) => pathname.startsWith(path));
        })
        .filter(({ url }) => !/\.(?:jpg|jpeg|png|gif|svg|webp|pdf)$/i.test(new URL(url).pathname));
      const articles = [...new Map(links.map((article) => [new URL(article.url).pathname, article])).values()]
        .map((article) => ({ ...article, markdown: "", unsupported: false }));
      if (!articles.length) return { error: "No article links were found on this issue page." };
      const publication = economist ? "The Economist" : california ? "California Magazine" : "Communications of the ACM";
      const filenamePublication = economist ? "economist" : california ? "california-magazine" : "cacm";
      state = {
        editionUrl: currentEditionUrl,
        filename: `${filenamePublication}-${issue}.md`,
        heading: document.querySelector("h1")?.textContent.trim() || `${publication} — ${issue}`,
        sourceUrl: location.href,
        status: "running",
        statusMessage: "",
        challengeUrl: "",
        tabId,
        currentIndex: 0,
        articles,
        log: []
      };
      note(`Started ${state.editionUrl}; cataloged ${articles.length} unique candidate article links.`);
      await saveState(`Cataloged ${articles.length} articles. Starting collection…`);
    }

    for (let index = state.currentIndex; index < state.articles.length; index += 1) {
      const article = state.articles[index];
      state.currentIndex = index;
      for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
        if (attempt === 0) {
          const throttleMs = 1000 + Math.floor(Math.random() * 1001);
          note(`Waiting ${(throttleMs / 1000).toFixed(1)}s before fetching ${article.url}`);
          await saveState(`Collecting ${index + 1} of ${state.articles.length}: ${article.title} — waiting ${(throttleMs / 1000).toFixed(1)}s`);
          await wait(throttleMs);
        }
        let response;
        try {
          note(`Fetching ${article.url} (attempt ${attempt + 1}/${retryDelaysMs.length + 1})`);
          await saveState(`Collecting ${index + 1} of ${state.articles.length}: ${article.title} — attempt ${attempt + 1} of ${retryDelaysMs.length + 1}`);
          response = await fetch(article.url, { credentials: "include", signal: AbortSignal.timeout(articleTimeoutMs) });
          note(`Response ${response.status} ${response.statusText || ""}`.trim());
          const html = await response.text();
          if (isChallengePage(html)) {
            const error = new Error("CAPTCHA or browser challenge detected");
            error.challenge = true;
            throw error;
          }
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const extraction = markdownFromHtml(html, article.url);
          if (!extraction) throw new Error("No article title or body found");
          article.markdown = extraction.markdown;
          article.unsupported = extraction.unsupported;
          state.currentIndex = index + 1;
          note(extraction.unsupported ? `Marked ${article.url} unsupported.` : `Extracted ${extraction.markdown.length.toLocaleString()} Markdown characters from ${article.url}.`);
          await saveState(`Collected ${index + 1} of ${state.articles.length}: ${article.title}`);
          break;
        } catch (error) {
          const reason = error.name === "TimeoutError" ? `Timed out after ${articleTimeoutMs / 1000} seconds` : error.message || String(error);
          if (error.challenge) {
            state.status = "paused";
            state.challengeUrl = article.url;
            note(`PAUSED ${article.url}: ${reason}`);
            await saveState(`Challenge detected for “${article.title}”. Complete it, return to this issue, then continue collection.`);
            return { paused: true };
          }
          const nonRetryable = response?.status >= 400 && response.status < 500
            && ![408, 429].includes(response.status);
          if (nonRetryable || attempt === retryDelaysMs.length) {
            state.status = "paused";
            note(`PAUSED ${article.url}${nonRetryable ? " without retry" : " after retries"}: ${reason}`);
            await saveState(`Could not collect “${article.title}”${nonRetryable ? "" : " after retries"}. Continue collection to retry it.`);
            return { paused: true };
          }
          const delayMs = Math.max(retryDelaysMs[attempt], response?.status === 429 ? retryAfterMs(response) : 0);
          note(`${reason}; retrying ${article.url} in ${(delayMs / 1000).toFixed(1)}s.`);
          await saveState(`Collecting ${index + 1} of ${state.articles.length}: ${article.title} — retrying in ${(delayMs / 1000).toFixed(1)}s`);
          await wait(delayMs);
        }
      }
    }

    const unsupported = state.articles.filter((article) => article.unsupported).length;
    const contents = state.articles
      .map((article, index) => `- [${article.title.replace(/[\\[\]]/g, "\\$&")}](#article-${index + 1})`)
      .join("\n");
    const articleMarkdown = state.articles
      .map((article, index) => `<a id="article-${index + 1}"></a>\n\n${article.markdown}`)
      .join("\n\n---\n\n");
    const markdown = `# ${state.heading}\n\nSource: ${state.sourceUrl}\n\n## Contents\n\n${contents}\n\n---\n\n${articleMarkdown}\n`;
    note(`Built ${markdown.length.toLocaleString()} Markdown characters.`);
    await saveState(`Starting download for ${state.articles.length} articles${unsupported ? `; ${unsupported} interactive unsupported` : ""}.`);
    const downloadResponse = await chrome.runtime.sendMessage({ type: "download", content: markdown, filename: state.filename, mimeType: "text/markdown" });
    if (!downloadResponse?.ok) {
      state.status = "paused";
      note(`Download failed: ${downloadResponse?.error || "Chrome did not start the download."}`);
      await saveState("The issue is complete, but its download failed. Continue collection to retry the download.");
      return { paused: true };
    }
    state.status = "completed";
    note(`Chrome accepted download ${downloadResponse.downloadId}.`);
    await saveState(`Downloaded ${state.articles.length} articles${unsupported ? `; ${unsupported} interactive unsupported` : ""}.`);
    return { completed: true };
  } catch (error) {
    if (!state) return { error: error.message || String(error) };
    state.status = "paused";
    state.statusMessage = `Collection was interrupted: ${error.message || String(error)}. Continue collection to retry.`;
    state.log.push(`${new Date().toISOString()}  PAUSED: ${error.message || String(error)}`);
    state.updatedAt = new Date().toISOString();
    await chrome.storage.local.set({ collectionState: state, latestLog: state.log.join("\n") });
    return { paused: true };
  } finally {
    globalThis.__websiteReaderRunning = false;
  }
}

async function runCollection(resume) {
  collectButton.disabled = true;
  continueButton.disabled = true;
  setStatus(resume ? "Continuing saved collection…" : "Cataloging links and starting collection…");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("Chrome did not return an active tab.");
    const currentEdition = isIssueUrl(tab.url) ? editionUrl(tab.url) : "";
    if (!currentEdition) throw new Error("Open a supported publication issue page first.");
    const { collectionState } = await chrome.storage.local.get("collectionState");
    if (!resume && ["running", "paused"].includes(collectionState?.status) && collectionState.editionUrl !== currentEdition) {
      throw new Error(`A collection is ${collectionState.status} for ${collectionState.editionUrl}. Open that issue before starting another one.`);
    }
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: collectEdition, args: [resume, tab.id] });
    if (result?.error) throw new Error(result.error);
  } catch (error) {
    setStatus(error.message || "The issue could not be collected.");
  } finally {
    await loadState();
  }
}

collectButton.addEventListener("click", async () => await runCollection(false));
continueButton.addEventListener("click", async () => await runCollection(true));

copyButton.addEventListener("click", async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const publication = publicationName(tab?.url || "");
    const newsGuidance = publication === "The Economist"
      ? "- **The World This Week:** Treat Politics and Business as collections of discrete news items. Summarize each item in one sentence unless a second sentence is necessary."
      : "- **News roundups:** Treat each roundup as a collection of discrete news items. Summarize each item in one sentence unless a second sentence is necessary.";
    const opinionGuidance = publication === "The Economist"
      ? "- **Leaders, columns and opinion:** Up to five sentences. Clearly distinguish the article's claim from the evidence offered for it. Identify significant assumptions, missing evidence, acknowledged counterevidence, or material gaps between evidence and conclusion."
      : "- **Editorials, columns and opinion:** Up to five sentences. Clearly distinguish the article's claim from the evidence offered for it. Identify significant assumptions, missing evidence, acknowledged counterevidence, or material gaps between evidence and conclusion.";
    const response = await fetch(chrome.runtime.getURL("issue-digest-prompt.md"));
    if (!response.ok) throw new Error("The digest prompt could not be loaded.");
    const prompt = (await response.text())
      .replaceAll("{{publication}}", publication === "The Economist" ? "Economist" : publication)
      .replace("{{publicationSpecificNewsGuidance}}", newsGuidance)
      .replace("{{publicationSpecificOpinionGuidance}}", opinionGuidance);
    await navigator.clipboard.writeText(`${prompt.trim()}\n`);
    setStatus(`Copied the ${publication} digest prompt. Upload the issue Markdown separately.`);
  } catch (error) {
    setStatus(error.message || "The digest prompt could not be copied.");
  }
});

downloadLogButton.addEventListener("click", async () => {
  try {
    const { latestLog = "" } = await chrome.storage.local.get("latestLog");
    if (!latestLog) throw new Error("No collection log is available yet.");
    await download(`${latestLog}\n`, "website-reader.log", "text/plain");
    setStatus("Log download started.");
  } catch (error) {
    setStatus(error.message || "The log could not be downloaded.");
  }
});

async function loadState() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeEditionUrl = isIssueUrl(tab?.url) ? editionUrl(tab.url) : "";
    const publication = publicationName(tab?.url || "");
    copyButton.textContent = `Copy ${publication} digest prompt`;
    collectButton.textContent = `Collect ${publication} issue`;
    collectButton.disabled = !activeEditionUrl;
    if (!activeEditionUrl) {
      setStatus(`Copy an issue digest prompt for ${publication}. To collect an issue, open its issue page on The Economist, California Magazine, or Communications of the ACM.`);
    }
    const { collectionState, latestLog = "" } = await chrome.storage.local.get(["collectionState", "latestLog"]);
    if (latestLog) {
      logOutput.textContent = latestLog;
      downloadLogButton.disabled = false;
    }
    renderState(collectionState);
  } catch (error) {
    setStatus(`Could not load collection state: ${error.message || String(error)}`);
  }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.collectionState) renderState(changes.collectionState.newValue);
});

loadState();
