const collectButton = document.querySelector("#collect");
const continueButton = document.querySelector("#continue");
const skipButton = document.querySelector("#skip");
const handoffButton = document.querySelector("#handoff");
const attachmentFile = document.querySelector("#attachment-file");
const attachmentStatus = document.querySelector("#attachment-status");
const useBatchButton = document.querySelector("#use-batch");
let handoffRunning = false;
let economistLanding = false;
const copyButton = document.querySelector("#copy");
const downloadLogButton = document.querySelector("#download-log");
const status = document.querySelector("#status");
const logOutput = document.querySelector("#log");

const archiveConnectionPort = document.querySelector("#archive-connection-port");
const archivePort = document.querySelector("#archive-port");
const archiveRoot = document.querySelector("#archive-root");
const archiveDirectories = document.querySelector("#archive-directories");
const archiveSearchLimit = document.querySelector("#archive-search-limit");
const archiveConfigStatus = document.querySelector("#archive-config-status");
const archiveConfigFields = document.querySelector("#archive-config-fields");
const archiveConnectButton = document.querySelector("#archive-connect");
let connectedArchivePort;

async function archiveConfigRequest(port, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/config`, {
    ...options, signal: AbortSignal.timeout(5000), cache: "no-store"
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Service returned ${response.status}`);
  return result;
}

archiveConnectButton.addEventListener("click", async () => {
  if (!archiveConnectionPort.reportValidity()) return;
  archiveConnectButton.disabled = true;
  archiveConfigFields.disabled = true;
  connectedArchivePort = undefined;
  try {
    const port = archiveConnectionPort.valueAsNumber;
    const result = await archiveConfigRequest(port);
    await chrome.storage.local.set({ archiveConnectionPort: port });
    connectedArchivePort = port;
    archivePort.value = result.port;
    archiveRoot.value = result.archive_root;
    archiveDirectories.value = (result.index_directories || []).join("\n");
    archiveSearchLimit.value = result.search_limit ?? 30;
    archiveConfigFields.disabled = false;
    archiveConfigStatus.textContent = `Connected on port ${result.active_port}. Active archive: ${result.active_archive_root}.`;
  } catch (error) {
    archiveConfigStatus.textContent = `Could not connect: ${error.message}. Check the port and start the service.`;
  } finally {
    archiveConnectButton.disabled = false;
  }
});

document.querySelector("#archive-config-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!connectedArchivePort) return;
  archiveConnectButton.disabled = true;
  archiveConfigFields.disabled = true;
  try {
    const result = await archiveConfigRequest(connectedArchivePort, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        port: archivePort.valueAsNumber, archive_root: archiveRoot.value.trim(),
        index_directories: archiveDirectories.value.split(/\r?\n/).map(path => path.trim()).filter(Boolean),
        search_limit: archiveSearchLimit.valueAsNumber
      })
    });
    archiveConfigStatus.textContent = `Settings saved. Restart the service, then load settings on port ${result.port}. Existing files remain in their current folder.`;
    archiveConnectionPort.value = result.port;
  } catch (error) {
    archiveConfigStatus.textContent = `Could not save settings: ${error.message}`;
  } finally {
    archiveConfigFields.disabled = false;
    archiveConnectButton.disabled = false;
  }
});

async function restoreArchiveConnectionPort() {
  try {
    const saved = await chrome.storage.local.get("archiveConnectionPort");
    if (Number.isInteger(saved.archiveConnectionPort) && saved.archiveConnectionPort > 0 && saved.archiveConnectionPort <= 65535) {
      archiveConnectionPort.value = saved.archiveConnectionPort;
    }
  } catch (error) { archiveConfigStatus.textContent = `Could not restore connection port: ${error.message}`; }
}
restoreArchiveConnectionPort();

const emailSelect = document.querySelector("#email-message");
const emailLabel = document.querySelector("#email-label");
let emails = [];
let activeEditionUrl = "";
let activeSourceUrl = "";

document.querySelector("#close").addEventListener("click", async () => {
  try {
    const window = await chrome.windows.getCurrent();
    await chrome.sidePanel.close({ windowId: window.id });
  } catch (error) { setStatus(`Could not close Website Reader: ${error.message || String(error)}`); }
});

async function readingBatchTab(resume = false) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const { collectionState: state } = await chrome.storage.local.get("collectionState");
  if ((resume || (Number.isInteger(state?.articleTabId) && tab?.id === state.articleTabId)) && ["running", "paused"].includes(state?.status) && Number.isInteger(state.tabId)) {
    try {
      const source = await chrome.tabs.get(state.tabId);
      if (source.windowId === tab?.windowId) return source;
    } catch { /* The saved email source can be closed. */ }
  }
  return tab;
}

function isGmailUrl(url) {
  try { return new URL(url).origin === "https://mail.google.com"; }
  catch { return false; }
}

// Executed in Gmail's isolated content-script world; never read the inbox or
// collapsed messages. The selected message is snapshotted before collection.
function captureEmails() {
  if (location.origin !== "https://mail.google.com") return [];
  const main = document.querySelector('[role="main"]');
  if (!main) return [];
  const escape = (text) => text.replace(/[\\`*_[\]<>]/g, "\\$&");
  function linkUrl(anchor) {
    try {
      let url = new URL(anchor.getAttribute("href"), location.href);
      if (url.hostname === "www.google.com" && url.pathname === "/url") {
        const destination = url.searchParams.get("q") || url.searchParams.get("url");
        if (destination) url = new URL(destination);
      }
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) return "";
      return url.href;
    } catch { return ""; }
  }
  function markdown(node) {
    if (node.nodeType === Node.TEXT_NODE) return escape(node.textContent.replace(/\s+/g, " "));
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    if (node.matches("script,style,button,form,[hidden],[aria-hidden='true']") || getComputedStyle(node).display === "none") return "";
    if (node.tagName === "BR") return "\n";
    const text = [...node.childNodes].map(markdown).join("");
    if (node.tagName === "A") {
      const url = linkUrl(node);
      return url ? `[${text.trim() || escape(url)}](<${url}>)` : text;
    }
    if (/^H[1-6]$/.test(node.tagName)) return `\n\n### ${text.trim()}\n\n`;
    if (node.tagName === "LI") return `\n- ${text.trim()}\n`;
    if (/^(P|DIV|TR|TABLE|UL|OL|BLOCKQUOTE)$/.test(node.tagName)) return `\n${text}\n`;
    if (/^(TD|TH)$/.test(node.tagName)) return `${text} `;
    return text;
  }
  return [...main.querySelectorAll(".a3s")]
    .filter((body) => body.getClientRects().length && getComputedStyle(body).visibility !== "hidden")
    .map((body) => {
      const message = body.closest(".adn") || body.parentElement;
      const identity = message.closest("[data-legacy-message-id], [data-message-id]")
        || message.querySelector("[data-legacy-message-id], [data-message-id]");
      const id = identity?.getAttribute("data-legacy-message-id") || identity?.getAttribute("data-message-id") || body.id;
      if (!id) return null;
      const subject = main.querySelector("h2.hP, h2")?.textContent.trim() || "Newsletter";
      const sender = message.querySelector(".gD[email]");
      const from = sender ? `${sender.textContent.trim()} <${sender.getAttribute("email")}>` : message.querySelector(".gD")?.textContent.trim() || "Unknown sender";
      const freePress = /^The Free Press\s*</i.test(from);
      const dateElement = message.querySelector(".g3");
      const date = dateElement?.getAttribute("title") || dateElement?.textContent.trim() || "Unknown date";
      const links = [...body.querySelectorAll("a[href]")]
        .filter((anchor) => anchor.getClientRects().length && getComputedStyle(anchor).visibility !== "hidden"
          && (anchor.textContent.trim() || anchor.querySelector("img")?.alt?.trim())
          && !anchor.closest("footer, [role='contentinfo']"))
        .map((anchor) => ({
        url: linkUrl(anchor), title: anchor.textContent.replace(/\s+/g, " ").trim() || anchor.querySelector("img")?.alt || "Linked article"
      })).filter(({ url, title }) => {
        if (!url) return false;
        const parsed = new URL(url);
        if (freePress && !((parsed.hostname === "thefp.com" || parsed.hostname === "www.thefp.com")
          && parsed.pathname.startsWith("/p/") || parsed.hostname === "substack.com" && parsed.pathname.startsWith("/redirect/"))) return false;
        // Keep these links in the email text, but do not visit control links.
        return parsed.hostname !== "mail.google.com"
          && !["maps.google.com", "maps.app.goo.gl", "maps.apple.com"].includes(parsed.hostname)
          && !(parsed.hostname === "goo.gl" && parsed.pathname.startsWith("/maps"))
          && !((parsed.hostname === "google.com" || parsed.hostname === "www.google.com") && parsed.pathname.startsWith("/maps"))
          && !["itunes.apple.com", "apps.apple.com"].includes(parsed.hostname)
          && !(parsed.hostname === "play.google.com" && parsed.pathname.startsWith("/store/"))
          && !(parsed.hostname === "substack.com" && /^\/(?:profile|app-link)(?:\/|$)/i.test(parsed.pathname))
          && (!(parsed.hostname === "medium.com" || parsed.hostname.endsWith(".medium.com"))
            || /\/(?:p\/[a-f0-9]{12}|[^/]+-[a-f0-9]{12})\/?$/i.test(parsed.pathname))
          && !/(?:^|\.)(?:facebook\.com|twitter\.com|x\.com|linkedin\.com|instagram\.com)$/.test(parsed.hostname)
          && !/^(?:unsubscribe|opt.?out|(?:manage|update|change|email) (?:your )?(?:preferences|subscription|account)|subscribe(?: now)?|sign.?in|log.?in|share(?: this| on)?|advertisement|sponsored|privacy policy|terms of|careers|help center|contact us|view (?:this )?(?:email )?in (?:your )?(?:browser|app)|get (?:the |our )?app|download (?:as a pdf|on the app store)|spotify$|apple podcasts$|rss$)(?:\b|$)/i.test(title)
          && !/(?:^|[\/?&=])(?:unsubscribe|opt.?out|preferences|subscribe|signin|login|share|privacy|terms)(?:[\/?&=]|$)/i.test(`${parsed.pathname}${parsed.search}`)
          && !/\.(?:jpg|jpeg|png|gif|svg|webp|pdf|zip|mp4|mp3)$/i.test(parsed.pathname)
          && parsed.pathname !== "/";
      });
      links.forEach((link) => {
        const url = new URL(link.url);
        url.hash = "";
        for (const key of [...url.searchParams.keys()]) {
          if (/^(?:utm_|mc_cid$|mc_eid$)/i.test(key)
            || key === "source" && (url.hostname === "medium.com" || url.hostname.endsWith(".medium.com"))) url.searchParams.delete(key);
        }
        link.url = url.href;
      });
      const articles = [...new Map(links.map((link) => [link.url, link])).values()];
      return {
        id, subject, from, date, sourceUrl: location.href,
        editionUrl: `${location.href}::${id}`,
        markdown: `## Original email\n\nSubject: ${escape(subject)}\n\nFrom: ${escape(from)}\n\nDate: ${escape(date)}\n\nProvenance: Email commentary and excerpts; not the linked articles' full text.\n\n${message.querySelector(".ajR") ? "> **Partial email:** Gmail has clipped this message. Expand or view the entire message to read omitted content.\n\n" : ""}${markdown(body).replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim()}`,
        articles
      };
    }).filter(Boolean);
}

function isIssueUrl(url) {
  try {
    const parsed = new URL(url);
    return (parsed.hostname === "www.economist.com" && /^\/weeklyedition\/[^/]+\/?$/.test(parsed.pathname))
      || (parsed.hostname === "alumni.berkeley.edu" && /^\/issue\/[^/]+\/?$/.test(parsed.pathname))
      || (parsed.hostname === "cacm.acm.org" && /^\/issue\/[^/]+\/?$/.test(parsed.pathname))
      || (parsed.hostname === "www.nytimes.com" && parsed.pathname === "/");
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
    if (hostname === "nytimes.com") return "The New York Times";
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
  link.textContent = "Open article";
  status.append(document.createElement("br"), link);
}

function renderState(state, showStatus = true) {
  const file = attachmentFile.files[0];
  const promptUrl = state?.sourceUrl || activeSourceUrl;
  const publication = isGmailUrl(promptUrl) ? "email" : publicationName(promptUrl);
  copyButton.textContent = file ? "Digest prompt unavailable for chosen file" : `Copy ${publication} digest prompt`;
  copyButton.disabled = Boolean(file);
  attachmentFile.disabled = handoffRunning;
  useBatchButton.disabled = handoffRunning;
  handoffButton.disabled = handoffRunning || (!file && state?.status !== "completed");
  attachmentStatus.textContent = file ? `File to open in ChatGPT: ${file.name}\nSource: chosen file.`
    : state?.status === "completed" ? `File to open in ChatGPT: ${state.filename}\nSource: latest completed collection.`
      : "No file ready for ChatGPT. Choose a file or complete a collection.";
  useBatchButton.hidden = !file;
  useBatchButton.textContent = state?.status === "completed" ? "Use saved collection instead" : "Clear chosen file";
  const sameEdition = state?.editionUrl === activeEditionUrl;
  const active = ["running", "paused"].includes(state?.status);
  const resumable = state?.status === "paused";
  skipButton.hidden = !(resumable && Number.isInteger(state.articleTabId));
  skipButton.disabled = skipButton.hidden;
  collectButton.disabled = (!activeEditionUrl && !economistLanding) || state?.status === "running";
  collectButton.textContent = economistLanding ? "Open Economist weekly edition"
    : resumable ? "Replace paused batch with current page"
    : emails.length ? "Collect email and articles" : `Collect ${publicationName(activeEditionUrl)} issue`;
  continueButton.disabled = !resumable;
  continueButton.hidden = !resumable;
  if (state?.log?.length) {
    logOutput.textContent = state.log.join("\n");
    downloadLogButton.disabled = false;
  }
  if (!showStatus) return;
  if (sameEdition && state.statusMessage) setStatus(state.statusMessage, state.challengeUrl);
  else if (active) setStatus(`A collection is ${state.status} for ${state.editionUrl}. ${resumable ? "Continue it or replace it with the current page." : "Wait for it to finish before starting another."}`, state.challengeUrl);
}

async function download(content, filename, mimeType) {
  const response = await chrome.runtime.sendMessage({ type: "download", content, filename, mimeType });
  if (!response?.ok) throw new Error(response?.error || "Chrome did not start the download.");
  return response.downloadId;
}

async function runCollection(resume, permissionRequest = null) {
  collectButton.disabled = true;
  continueButton.disabled = true;
  setStatus(resume ? "Continuing saved collection…" : "Cataloging links and starting collection…");
  let errorMessage = "";
  try {
    if (permissionRequest) await permissionRequest;
    const { collectionState: saved } = await chrome.storage.local.get("collectionState");
    if (resume && saved?.emailId) {
      const result = await chrome.runtime.sendMessage({ type: "collectEmail", resume: true });
      if (result?.error) throw new Error(result.error);
      return;
    }
    const tab = await readingBatchTab(resume);
    if (!tab?.id) throw new Error("Chrome did not return an active tab.");
    let email = null;
    if (isGmailUrl(tab.url)) {
      const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: captureEmails });
      email = result?.find((message) => message.id === emailSelect.value);
      if (!email) throw new Error("Select one expanded email. Reopen Website Reader if the message has changed.");
    }
    if (!resume && economistLanding) {
      const [{ result: issueUrl }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
        return [...document.querySelectorAll('a[href]')].map(a => a.href)
          .filter(url => /^https:\/\/www\.economist\.com\/weeklyedition\/\d{4}-\d{2}-\d{2}\/?$/.test(url)).sort().at(-1)
          || "https://www.economist.com/weeklyedition";
      } });
      await chrome.tabs.update(tab.id, { url: issueUrl });
      return;
    }
    const currentEdition = email?.editionUrl || (isIssueUrl(tab.url) ? editionUrl(tab.url) : "");
    if (!currentEdition) throw new Error("Open a supported publication issue page first.");
    const { collectionState } = await chrome.storage.local.get("collectionState");
    if (!resume && collectionState?.status === "running") {
      throw new Error(`A collection is ${collectionState.status} for ${collectionState.editionUrl}. Open that reading batch before starting another one.`);
    }
    if (!resume && Number.isInteger(collectionState?.articleTabId)) {
      try { await chrome.tabs.remove(collectionState.articleTabId); } catch { /* Already closed. */ }
    }
    const result = email
      ? await chrome.runtime.sendMessage({ type: "collectEmail", email, tabId: tab.id })
      : (await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: collectEdition, args: [resume, tab.id] }))[0].result;
    if (result?.error) throw new Error(result.error);
  } catch (error) {
    errorMessage = error.message || "The reading batch could not be collected.";
  } finally {
    await loadState();
    if (errorMessage) setStatus(errorMessage);
  }
}

async function collectFromClick(resume) {
  try {
    const email = resume ? null : emails.find((message) => message.id === emailSelect.value);
    const articleUrl = resume ? status.querySelector("a")?.href : "";
    const links = [...(email?.articles.map(({ url }) => url) || []), ...(articleUrl ? [articleUrl] : [])];
    const origins = [...new Set(links.map(url => {
      const { protocol, hostname } = new URL(url);
      return protocol === "https:" && (hostname === "medium.com" || hostname.endsWith(".medium.com"))
        ? "https://*.medium.com/*" : `${protocol}//${hostname}/*`;
    }))];
    // Start the permission request during the click, before any awaited operation.
    const permissionRequest = origins.length ? chrome.permissions.request({ origins }) : null;
    await runCollection(resume, permissionRequest);
  } catch (error) { setStatus(error.message || "Could not request article-site access."); }
}
collectButton.addEventListener("click", async () => await collectFromClick(false));
continueButton.addEventListener("click", async () => await collectFromClick(true));
skipButton.addEventListener("click", async () => {
  skipButton.disabled = true;
  try {
    const { collectionState: state } = await chrome.storage.local.get("collectionState");
    if (state?.status !== "paused" || !Number.isInteger(state.articleTabId)) throw new Error("There is no paused article to skip.");
    const article = state.articles[state.currentIndex];
    article.unsupported = true;
    article.markdown = `## ${article.title}\n\n[Email link](<${article.url}>)\n\n> **Unavailable:** Skipped by the user after: ${state.statusMessage}. See the original email for any excerpt.`;
    try { await chrome.tabs.remove(state.articleTabId); } catch { /* Already closed. */ }
    delete state.articleTabId;
    state.currentIndex += 1;
    state.challengeUrl = "";
    state.log.push(`${new Date().toISOString()}  SKIPPED ${article.url}: requested by the user.`);
    await chrome.storage.local.set({ collectionState: state, latestLog: state.log.join("\n") });
    await runCollection(true);
  } catch (error) { setStatus(error.message || "Could not skip the article."); skipButton.disabled = false; }
});
emailSelect.addEventListener("change", async () => {
  activeEditionUrl = emails.find((message) => message.id === emailSelect.value)?.editionUrl || "";
  setStatus(activeEditionUrl ? "Ready to collect the selected email and its linked articles." : "Select one expanded email.");
  const { collectionState } = await chrome.storage.local.get("collectionState");
  renderState(collectionState);
});

async function digestPrompt(url) {
  const publication = isGmailUrl(url) ? "email" : publicationName(url);
  const newsGuidance = publication === "The Economist"
    ? "- **The World This Week:** Treat Politics and Business as collections of discrete news items. Summarize each item in one sentence unless a second sentence is necessary."
    : "- **News roundups:** Treat each roundup as a collection of discrete news items. Summarize each item in one sentence unless a second sentence is necessary.";
  const opinionGuidance = publication === "The Economist"
    ? "- **Leaders, columns and opinion:** Up to five sentences. Clearly distinguish the article's claim from the evidence offered for it. Identify significant assumptions, missing evidence, acknowledged counterevidence, or material gaps between evidence and conclusion."
    : "- **Editorials, columns and opinion:** Up to five sentences. Clearly distinguish the article's claim from the evidence offered for it. Identify significant assumptions, missing evidence, acknowledged counterevidence, or material gaps between evidence and conclusion.";
  const response = await fetch(chrome.runtime.getURL(publication === "email" ? "email-digest-prompt.md" : "issue-digest-prompt.md"));
  if (!response.ok) throw new Error("The digest prompt could not be loaded.");
  const prompt = (await response.text())
    .replaceAll("{{publication}}", publication === "The Economist" ? "Economist" : publication)
    .replace("{{publicationSpecificNewsGuidance}}", newsGuidance)
    .replace("{{publicationSpecificOpinionGuidance}}", opinionGuidance);
  return `${prompt.trim()}\n`;
}

copyButton.addEventListener("click", async () => {
  try {
    if (attachmentFile.files[0]) throw new Error("The chosen file has no publication metadata. Use the saved collection to copy its digest prompt.");
    const { collectionState } = await chrome.storage.local.get("collectionState");
    const url = collectionState?.sourceUrl || activeSourceUrl;
    await navigator.clipboard.writeText(await digestPrompt(url));
    const publication = isGmailUrl(url) ? "email" : publicationName(url);
    setStatus(`Copied the ${publication} digest prompt. Upload the collected Markdown separately.`);
  } catch (error) { setStatus(error.message || "The digest prompt could not be copied."); }
});

handoffButton.addEventListener("click", async () => {
  handoffRunning = true;
  handoffButton.disabled = true;
  attachmentFile.disabled = true;
  useBatchButton.disabled = true;
  try {
    const permissionRequest = chrome.permissions.request({ origins: ["https://chatgpt.com/*"] });
    await permissionRequest;
    const { collectionState } = await chrome.storage.local.get("collectionState");
    const file = attachmentFile.files[0];
    if (!file && collectionState?.status !== "completed") throw new Error("Complete a collection or choose a file first.");
    if (file && !/\.(?:md|markdown|txt)$/i.test(file.name)) throw new Error("Choose a Markdown or text file.");
    const content = file ? await file.text() : undefined;
    if (file && !content.trim()) throw new Error("The selected file is empty.");
    if (!file) await navigator.clipboard.writeText(await digestPrompt(collectionState.sourceUrl));
    setStatus(`Opening ChatGPT with ${file ? file.name : collectionState.filename}.${file ? "" : " The matching digest prompt is copied."}`);
    const result = await chrome.runtime.sendMessage({ type: "handoff", ...(file ? { content, filename: file.name } : {}) });
    if (!result?.ok) throw new Error(result?.error || "The ChatGPT handoff failed.");
  } catch (error) { setStatus(error.message || "The ChatGPT handoff failed."); }
  finally { handoffRunning = false; const { collectionState } = await chrome.storage.local.get("collectionState"); renderState(collectionState, false); }
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

attachmentFile.addEventListener("change", async () => {
  const { collectionState } = await chrome.storage.local.get("collectionState");
  renderState(collectionState);
});
useBatchButton.addEventListener("click", async () => {
  attachmentFile.value = "";
  const { collectionState } = await chrome.storage.local.get("collectionState");
  renderState(collectionState);
});

async function loadState() {
  try {
    const { collectionState, latestLog = "" } = await chrome.storage.local.get(["collectionState", "latestLog"]);
    const tab = await readingBatchTab();
    activeSourceUrl = tab?.url || "";
    economistLanding = /^https:\/\/www\.economist\.com(?:\/|$)/.test(tab?.url || "") && !isIssueUrl(tab?.url);
    activeEditionUrl = isIssueUrl(tab?.url) ? editionUrl(tab.url) : "";
    const publication = isGmailUrl(tab?.url) ? "email" : publicationName(tab?.url || "");
    const gmail = isGmailUrl(tab?.url);
    const selectedId = emailSelect.value || collectionState?.emailId;
    emailLabel.hidden = !gmail;
    emails = [];
    if (gmail) {
      const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: captureEmails });
      emails = result || [];
      emailSelect.replaceChildren(new Option("Select one expanded email…", ""), ...emails.map((email) => new Option(`${email.from} — ${email.date}`, email.id)));
      emailSelect.value = emails.some((email) => email.id === selectedId) ? selectedId : emails.length === 1 ? emails[0].id : "";
      activeEditionUrl = emails.find((email) => email.id === emailSelect.value)?.editionUrl || "";
      setStatus(emails.length ? activeEditionUrl ? "Ready to collect the email and its linked articles." : "Select one expanded email." : "Open an email in Gmail and expand its message body, then reopen Website Reader.");
    }
    collectButton.textContent = gmail ? "Collect email and articles" : `Collect ${publication} issue`;
    collectButton.disabled = !activeEditionUrl;
    if (!activeEditionUrl && !gmail) {
      setStatus(`Copy an issue digest prompt for ${publication}. To collect an issue, open its issue page on The Economist, California Magazine, Communications of the ACM, or The New York Times homepage.`);
    }
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

chrome.tabs.onActivated.addListener(async () => await loadState());
chrome.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  if (tab.active && change.status === "complete") await loadState();
});

loadState();


const chatGPTBackupScope = document.querySelector("#chatgpt-backup-scope");
const chatGPTBackupStatus = document.querySelector("#chatgpt-backup-status");
const chatGPTExportScope = document.querySelector("#chatgpt-export-scope");
const chatGPTExportFolder = document.querySelector("#chatgpt-export-folder");
const chatGPTExportProcess = document.querySelector("#chatgpt-export-process");
const chatGPTExportStatus = document.querySelector("#chatgpt-export-status");
chatGPTExportFolder.addEventListener("change", () => {
  chatGPTExportProcess.disabled = !chatGPTExportFolder.files.length;
  chatGPTExportStatus.textContent = chatGPTExportFolder.files.length ? "Folder selected. Select Process to import." : "";
});
chatGPTExportProcess.addEventListener("click", async () => {
  if (!chatGPTExportScope.reportValidity() || !archiveConnectionPort.reportValidity()) return;
  const scope = chatGPTExportScope.value;
  const counts = {};
  let processed = 0;
  chatGPTExportProcess.disabled = chatGPTExportFolder.disabled = chatGPTExportScope.disabled = true;
  try {
    chatGPTExportStatus.textContent = "Checking export files…";
    const files = new Map(Array.from(chatGPTExportFolder.files, file => [file.webkitRelativePath.split("/").slice(1).join("/"), file]));
    let names;
    if (files.has("export_manifest.json")) {
      const manifest = JSON.parse(await files.get("export_manifest.json").text());
      names = manifest.logical_files?.["conversations.json"]?.files;
    } else {
      names = files.has("conversations.json") ? ["conversations.json"] : [...files.keys()].filter(name => /^conversations-\d+\.json$/.test(name)).sort();
    }
    if (!Array.isArray(names) || !names.length || new Set(names).size !== names.length || names.some(name => !files.has(name))) {
      throw new Error("Select the folder containing all conversation JSON files from the unzipped export.");
    }
    const seen = new Set();
    for (const name of names) {
      const conversations = JSON.parse(await files.get(name).text());
      if (!Array.isArray(conversations)) throw new Error(`${name}: expected a conversation list.`);
      for (const conversation of conversations) {
        const id = conversation?.id || conversation?.conversation_id;
        if (!id || seen.has(id)) throw new Error(`${name}: missing or duplicate conversation ID.`);
        seen.add(id);
      }
    }
    if (!seen.size) throw new Error("No conversations found in this export.");
    for (const name of names) {
      for (const conversation of JSON.parse(await files.get(name).text())) {
        const { result } = await archiveChatRequest("/api/v1/chatgpt/import", { scope, conversation });
        counts[result] = (counts[result] || 0) + 1;
        processed++;
        chatGPTExportStatus.textContent = `Processed ${processed} of ${seen.size} conversations for ${scope}.`;
      }
    }
    chatGPTExportStatus.textContent = `Processed ${processed} conversations for ${scope}. ${Object.entries(counts).map(([result, count]) => `${count} ${result.replaceAll("-", " ")}`).join("; ")}.${counts.busy ? " Some conversations are being backed up; process again when those jobs finish." : ""}`;
  } catch (error) {
    chatGPTExportStatus.textContent = `Import stopped after ${processed} conversations: ${error.message || String(error)}. Select Process to retry.`;
  } finally {
    chatGPTExportProcess.disabled = !chatGPTExportFolder.files.length;
    chatGPTExportFolder.disabled = chatGPTExportScope.disabled = false;
  }
});
const chatGPTRequestInterval = document.querySelector("#chatgpt-request-interval");
const chatGPTMaxBackoff = document.querySelector("#chatgpt-max-backoff");
document.querySelector("#chatgpt-rate-settings").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    await chrome.storage.local.set({ chatGPTRequestInterval: chatGPTRequestInterval.valueAsNumber, chatGPTMaxBackoffMinutes: chatGPTMaxBackoff.valueAsNumber });
    document.querySelector("#chatgpt-rate-settings-status").textContent = "Backup settings saved. Active cooldowns are retained.";
  } catch (error) { document.querySelector("#chatgpt-rate-settings-status").textContent = error.message; }
});
document.querySelector("#chatgpt-backup-download-log").addEventListener("click", async () => {
  try {
    const { chatGPTBackupLog = "" } = await chrome.storage.local.get("chatGPTBackupLog");
    if (!chatGPTBackupLog) throw new Error("No backup log is available yet.");
    await download(`${chatGPTBackupLog}\n`, "chatgpt-backup.log", "text/plain");
  } catch (error) { chatGPTBackupStatus.textContent = error.message || String(error); }
});
async function restoreChatGPTBackup(restoreScope = true) {
  const saved = await chrome.storage.local.get(["chatGPTBackupScope", "chatGPTBackupProgress", "chatGPTBackupSummary", "chatGPTBackupUpdatedAt", "chatGPTBackupSavedAt", "chatGPTBackupLog", "chatGPTRequestInterval", "chatGPTMaxBackoffMinutes", "chatGPTBackupRetryAt", "chatGPTBackupEnabled"]);
  if (restoreScope) {
    if (saved.chatGPTBackupScope) {
      chatGPTBackupScope.value = saved.chatGPTBackupScope;
      chatGPTExportScope.value = saved.chatGPTBackupScope;
    }
    chatGPTRequestInterval.value = saved.chatGPTRequestInterval ?? 2;
    chatGPTMaxBackoff.value = saved.chatGPTMaxBackoffMinutes ?? 15;
  }
  document.querySelector("#chatgpt-backup-cooldown").textContent = saved.chatGPTBackupRetryAt > Date.now()
    ? `Rate limit cooldown: next retry no earlier than ${new Date(saved.chatGPTBackupRetryAt).toLocaleString()}.${saved.chatGPTBackupEnabled ? "" : " Backup is paused; Sync resumes it after cooldown."}` : "";
  if (saved.chatGPTBackupProgress) chatGPTBackupStatus.textContent = saved.chatGPTBackupProgress;
  document.querySelector("#chatgpt-backup-log").textContent = saved.chatGPTBackupLog || "No backup diagnostic events recorded yet.";
  document.querySelector("#chatgpt-backup-summary").textContent = saved.chatGPTBackupSummary || "No backup inventory loaded yet.";
  document.querySelector("#chatgpt-backup-updated").textContent = [
    saved.chatGPTBackupUpdatedAt ? `Last update: ${new Date(saved.chatGPTBackupUpdatedAt).toLocaleString()}.` : "",
    saved.chatGPTBackupSavedAt ? `Last successful save: ${new Date(saved.chatGPTBackupSavedAt).toLocaleString()}.` : "No successful saves recorded yet."
  ].filter(Boolean).join(" ");
}
restoreChatGPTBackup().catch(error => { chatGPTBackupStatus.textContent = error.message; });
for (const action of ["sync", "pause"]) {
  document.querySelector(`#chatgpt-backup-${action}`).addEventListener("click", async () => {
    try {
      if (action === "sync" && !chatGPTBackupScope.reportValidity()) return;
      if (action === "sync" && !await chrome.permissions.request({ origins: ["https://chatgpt.com/*"] })) throw new Error("ChatGPT site access was declined.");
      const result = await chrome.runtime.sendMessage({ type: "chatGPTBackup", action, scope: chatGPTBackupScope.value });
      if (!result?.ok) throw new Error(result?.error || "Backup could not start.");
      if (action === "sync") await restoreChatGPTBackup(false);
    } catch (error) { chatGPTBackupStatus.textContent = error.message || String(error); }
  });
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && ["chatGPTBackupProgress", "chatGPTBackupSummary", "chatGPTBackupUpdatedAt", "chatGPTBackupSavedAt", "chatGPTBackupRetryAt", "chatGPTBackupEnabled"].some(key => key in changes)) {
    restoreChatGPTBackup(false).catch(error => { chatGPTBackupStatus.textContent = error.message; });
  }
});

// A local draft only: never submitted to the archive's ingestion/backup APIs.
const archiveChatPanel = document.querySelector("#archive-chat");
const archiveChatStatus = document.querySelector("#archive-chat-status");
const archiveChatQuestion = document.querySelector("#archive-chat-question");
const archiveChatModel = document.querySelector("#archive-chat-model");
let archiveChat = { messages: [], sources: [], model: "" };
let archiveChatBusy = false;
let archiveChatReady;
const archiveChatWindow = new URLSearchParams(location.search).get("archiveChatWindow") === "1";
const archiveChatDockWindow = Number(new URLSearchParams(location.search).get("dockWindow"));
if (archiveChatWindow) {
  document.body.classList.add("archive-chat-window");
  document.title = "Local archive chat";
  archiveChatPanel.open = true;
  document.querySelector("#archive-chat-window").textContent = "Return to side panel";
}


function archiveChatBase() {
  if (!archiveConnectionPort.reportValidity()) throw new Error("Enter a valid archive connection port.");
  return `http://127.0.0.1:${archiveConnectionPort.valueAsNumber}`;
}

async function archiveChatRequest(path, body) {
  const response = await fetch(`${archiveChatBase()}${path}`, {
    method: body === undefined ? "GET" : "POST", cache: "no-store",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(125000), targetAddressSpace: "loopback"
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || result.errors?.[0]?.detail || `Service returned ${response.status}`);
  return result;
}

function archiveChatRender() {
  const transcript = document.querySelector("#archive-chat-transcript");
  const previousCount = transcript.querySelectorAll("article").length;
  const previousScroll = transcript.scrollTop;
  const referencesOpen = transcript.querySelector("details")?.open || false;
  transcript.replaceChildren();
  for (const message of archiveChat.messages) {
    const article = document.createElement("article");
    const label = document.createElement("strong");
    label.textContent = message.role === "user" ? "You" : `Local assistant (${message.model || archiveChat.model})`;
    const text = document.createElement("p");
    text.textContent = message.content;
    article.append(label, text);
    transcript.append(article);
  }
  if (archiveChat.sources.length) {
    const list = document.createElement("ul");
    archiveChat.sources.forEach((source, index) => {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.textContent = `[S${index + 1}] ${source.title}`;
      link.href = source.archive_url;
      link.target = "_blank"; link.rel = "noopener noreferrer";
      item.append(link); list.append(item);
    });
    const references = document.createElement("details");
    references.open = referencesOpen;
    const heading = document.createElement("summary");
    heading.textContent = `References (${archiveChat.sources.length})`;
    references.append(heading, list);
    transcript.append(references);
  }
  transcript.scrollTop = previousCount === archiveChat.messages.length ? previousScroll : transcript.scrollHeight;
  for (const control of archiveChatPanel.querySelectorAll("button, textarea, select")) control.disabled = archiveChatBusy;
}

async function archiveChatSave() {
  await chrome.storage.local.set({ archiveChatDraft: archiveChat });
}

function archiveChatExport() {
  return `# Local archive conversation\n\nLocal model answers are unverified. Source excerpts may be partial.\n\n${archiveChat.messages.map(message => `## ${message.role === "user" ? "User" : `Assistant (${message.model || archiveChat.model})`}\n\n${message.content}`).join("\n\n")}\n\n# References and supplied evidence\n\n${archiveChat.sources.map((source, index) => `## [S${index + 1}] ${source.title}\n\nArchive ID: ${source.document_id}\nLocal archive: ${source.archive_url}\n${source.original_url ? `Original URL: ${source.original_url}\n` : ""}Coverage: ${source.coverage}\n\n${source.text}`).join("\n\n")}\n`;
}

async function archiveChatSearch(expand = true) {
  const query = archiveChatQuestion.value.trim();
  if (!query) throw new Error("Enter a question or search terms.");
  const result = await archiveChatRequest("/api/v1/archive/search", { query, limit: 5 });
  const output = document.querySelector("#archive-chat-results");
  output.replaceChildren();
  for (const hit of result.results) {
    const item = document.createElement("div");
    const link = document.createElement("a");
    link.textContent = hit.title;
    link.href = `${archiveChatBase()}${hit.url}`;
    link.target = "_blank"; link.rel = "noopener noreferrer";
    const text = document.createElement("p"); text.textContent = String(hit.text || "").slice(0, 500);
    const summarize = document.createElement("button");
    summarize.disabled = archiveChatBusy;
    summarize.type = "button"; summarize.textContent = "Summarize this document";
    summarize.addEventListener("click", () => archiveChatRun(async () => {
      const doc = await archiveChatRequest(`/api/v1/documents/${encodeURIComponent(hit.document_id)}?limit=6000`);
      await archiveChatAnswer(`Summarize ${hit.title}. ${doc.truncated ? "Only the beginning is supplied; label this a partial summary." : ""}`, [{
        ...hit, text: doc.text, chunk_id: "document-start", url: doc.url,
        coverage: doc.truncated ? "First 6000 bytes only; document is longer" : "Complete document text at time of retrieval"
      }]);
    }));
    item.append(link, text, summarize); output.append(item);
  }
  document.querySelector("#archive-chat-search-results").open = expand;
  document.querySelector("#archive-chat-results-summary").textContent = `Search results (${result.results.length} passage${result.results.length === 1 ? "" : "s"})`;
  archiveChatStatus.textContent = `${result.results.length} passages found. Open a result to read it, or choose Summarize this document.`;
  return result.results;
}

async function archiveChatAnswer(question, hits) {
  if (!archiveChatModel.value) throw new Error("Load and choose an installed text-generation model first.");
  const previous = archiveChat;
  const originalQuestion = archiveChatQuestion.value;
  const sources = previous.sources.slice();
  for (const hit of hits) {
    // Keep earlier evidence and labels stable across follow-up questions.
    const key = `${hit.document_id}:${hit.chunk_id}`;
    if (sources.some(source => source.key === key)) continue;
    const text = hit.coverage ? hit.text : String(hit.text || "").slice(0, 1200);
    if (!text) continue;
    const original = text.match(/^(?:Source(?: URL)?|URL):\s*(https?:\/\/[^\s<>]+)/im);
    sources.push({ key, document_id: hit.document_id, title: hit.title, text,
      archive_url: `${archiveChatBase()}${hit.url}`, original_url: original?.[1] || "",
      coverage: hit.coverage || "Retrieved passage, possibly shortened to 1200 characters" });
  }
  archiveChatStatus.textContent = "Generating a local answer…";
  // Keep the complete draft and evidence for export. Bound only model input.
  const bytes = text => new TextEncoder().encode(text).length;
  const messages = [...previous.messages.slice(-4).map(({ role, content }) => ({ role, content })), { role: "user", content: question }];
  const messageBytes = () => messages.reduce((total, message) => total + bytes(message.content), 0);
  while (messages.length > 1 && messageBytes() > 3500) messages.splice(0, 2);
  const preferred = new Set();
  for (const hit of hits) {
    const index = sources.findIndex(source => source.key === `${hit.document_id}:${hit.chunk_id}`);
    if (index >= 0) preferred.add(index);
  }
  for (const message of messages) {
    for (const match of message.content.matchAll(/\[S(\d+)\]/g)) {
      const index = Number(match[1]) - 1;
      if (index >= 0 && index < sources.length) preferred.add(index);
    }
  }
  for (let index = sources.length - 1; index >= 0; index--) preferred.add(index);
  const evidenceBytes = index => bytes(`\n[S${index + 1}] ${sources[index].title} (archive ID: ${sources[index].document_id})\n${sources[index].text}\n`);
  const first = preferred.values().next().value;
  while (first !== undefined && messages.length > 1 && messageBytes() + evidenceBytes(first) > 10000) messages.splice(0, 2);
  let used = messageBytes();
  const contextSources = [];
  for (const index of preferred) {
    const size = evidenceBytes(index);
    if (contextSources.length < 20 && used + size <= 10000) {
      contextSources.push({ ...sources[index], label: String(index + 1) });
      used += size;
    }
  }
  if (used > 10000 || (first !== undefined && !contextSources.length)) throw new Error("The question and selected excerpt are too large together. Shorten the question or start a new chat.");
  const reduced = messages.length < previous.messages.length + 1 || contextSources.length < sources.length;
  const answer = await archiveChatRequest("/api/v1/archive/chat", { model: archiveChatModel.value, messages, sources: contextSources });
  if (archiveChat !== previous) throw new Error("The draft changed in another panel. Review it before asking again.");
  archiveChat = { model: archiveChatModel.value, sources, messages: [
    ...archiveChat.messages, { role: "user", content: question },
    { role: "assistant", model: answer.model, content: answer.content + (answer.truncated ? "\n\n[Answer reached the output limit.]" : "") }
  ] };
  await archiveChatSave();
  if (archiveChatQuestion.value === originalQuestion) {
    archiveChatQuestion.value = "";
    await chrome.storage.session.set({ archiveChatQuestion: "" });
  }
  archiveChatStatus.textContent = "Answer saved as a local draft. Check its claims against the supplied sources." + (reduced ? ` Using ${Math.floor(messages.length / 2)} recent exchange${messages.length === 3 ? "" : "s"} and ${contextSources.length} of ${sources.length} source excerpts; older context was omitted. The full draft is retained for copying or ChatGPT.` : "");
}

async function archiveChatRun(action) {
  if (archiveChatBusy) return;
  archiveChatBusy = true; archiveChatRender();
  try { await archiveChatReady; await action(); }
  catch (error) { archiveChatStatus.textContent = error.message || String(error); }
  finally { archiveChatBusy = false; archiveChatRender(); }
}

archiveChatReady = (async () => {
  const { archiveChatDraft } = await chrome.storage.local.get("archiveChatDraft");
  if (archiveChatDraft) archiveChat = archiveChatDraft;
  const composer = await chrome.storage.session.get(["archiveChatQuestion", "archiveChatSelectedModel", "archiveChatDockWindowId"]);
  archiveChatQuestion.value = composer.archiveChatQuestion || "";
  const selectedModel = composer.archiveChatSelectedModel || archiveChat.model;
  if (selectedModel) {
    archiveChatModel.replaceChildren(new Option(selectedModel, selectedModel));
    archiveChatStatus.textContent = `Selected model: ${selectedModel}. Ask a question or load models to choose another.`;
  }
  if (!archiveChatWindow && composer.archiveChatDockWindowId === (await chrome.windows.getCurrent()).id) archiveChatPanel.open = true;

  archiveChatRender();
})().catch(error => { archiveChatStatus.textContent = `Could not restore draft: ${error.message}`; });

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === "session") {
    if (changes.archiveChatQuestion && archiveChatQuestion.value !== (changes.archiveChatQuestion.newValue || "")) archiveChatQuestion.value = changes.archiveChatQuestion.newValue || "";
    if (changes.archiveChatSelectedModel?.newValue) {
      const name = changes.archiveChatSelectedModel.newValue;
      if (![...archiveChatModel.options].some(option => option.value === name)) archiveChatModel.append(new Option(name, name));
      archiveChatModel.value = name;
    }
    if (!archiveChatWindow && changes.archiveChatDockWindowId?.newValue) {
      try {
        const current = await chrome.windows.getCurrent();
        if (current.id === changes.archiveChatDockWindowId.newValue) archiveChatPanel.open = true;
      } catch (error) { archiveChatStatus.textContent = error.message; }
    }
  }
  if (area === "local" && changes.archiveChatDraft) {
    archiveChat = changes.archiveChatDraft.newValue || { messages: [], sources: [], model: "" };
    archiveChatRender();
  }
});

archiveChatQuestion.addEventListener("input", async () => {
  try { await chrome.storage.session.set({ archiveChatQuestion: archiveChatQuestion.value }); }
  catch (error) { archiveChatStatus.textContent = error.message; }
});
archiveChatModel.addEventListener("change", async () => {
  try { await chrome.storage.session.set({ archiveChatSelectedModel: archiveChatModel.value }); }
  catch (error) { archiveChatStatus.textContent = error.message; }
});

document.querySelector("#archive-chat-window").addEventListener("click", () => {
  // Opening a side panel requires the original click gesture.
  const docking = archiveChatWindow && Number.isInteger(archiveChatDockWindow) && archiveChatDockWindow > 0
    ? chrome.sidePanel.open({ windowId: archiveChatDockWindow }) : null;
  archiveChatRun(async () => {
    await chrome.storage.session.set({ archiveChatQuestion: archiveChatQuestion.value, archiveChatSelectedModel: archiveChatModel.value });
    if (archiveChatWindow) {
      if (!docking) throw new Error("The original browser window is unavailable. Open Website Reader from a browser window; the draft is retained.");
      await docking;
      await chrome.windows.update(archiveChatDockWindow, { focused: true });
      await chrome.storage.session.set({ archiveChatDockWindowId: archiveChatDockWindow });
      const current = await chrome.windows.getCurrent();
      await chrome.windows.remove(current.id);
      return;
    }
    if (archiveConnectionPort.checkValidity()) await chrome.storage.local.set({ archiveConnectionPort: archiveConnectionPort.valueAsNumber });
    await chrome.storage.session.remove("archiveChatDockWindowId");
    const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["popup"] });
    const base = chrome.runtime.getURL("popup.html?archiveChatWindow=1");
    const existing = windows.find(window => window.tabs?.some(tab => tab.url?.startsWith(base + "&")));
    if (existing) await chrome.windows.update(existing.id, { focused: true });
    else {
      const current = await chrome.windows.getCurrent();
      await chrome.windows.create({ url: `${base}&dockWindow=${current.id}`, type: "popup", width: 640, height: 850, focused: true });
    }
    archiveChatPanel.open = false;
  });
});

document.querySelector("#archive-chat-models").addEventListener("click", () => archiveChatRun(async () => {
  const result = await archiveChatRequest("/api/v1/archive/models");
  archiveChatModel.replaceChildren();
  for (const name of result.models) {
    const option = document.createElement("option"); option.value = name; option.textContent = name;
    archiveChatModel.append(option);
  }
  if (result.models.includes(archiveChat.model)) archiveChatModel.value = archiveChat.model;
  archiveChatStatus.textContent = result.models.length ? "Choose a model, then ask a question." : "No text-generation model is installed in the project Ollama service. Install one, then load models again.";
}));
document.querySelector("#archive-chat-search").addEventListener("click", () => archiveChatRun(() => archiveChatSearch()));
document.querySelector("#archive-chat-form").addEventListener("submit", event => {
  event.preventDefault();
  archiveChatRun(async () => {
    const question = archiveChatQuestion.value.trim();
    await archiveChatAnswer(question, await archiveChatSearch(false));
  });
});
document.querySelector("#archive-chat-clear-search").addEventListener("click", () => archiveChatRun(async () => {
  document.querySelector("#archive-chat-results").replaceChildren();
  document.querySelector("#archive-chat-results-summary").textContent = "Search results";
  document.querySelector("#archive-chat-search-results").open = false;
  archiveChatQuestion.value = "";
  await chrome.storage.session.set({ archiveChatQuestion: "" });
  archiveChatStatus.textContent = "Search cleared. Conversation and references retained.";
}));
document.querySelector("#archive-chat-clear").addEventListener("click", () => archiveChatRun(async () => {
  archiveChat = { messages: [], sources: [], model: archiveChatModel.value };
  await chrome.storage.local.remove("archiveChatDraft");
  archiveChatQuestion.value = "";
  await chrome.storage.session.set({ archiveChatQuestion: "" });
  document.querySelector("#archive-chat-results").replaceChildren();
  document.querySelector("#archive-chat-results-summary").textContent = "Search results";
  document.querySelector("#archive-chat-search-results").open = false;
  archiveChatStatus.textContent = "Draft cleared. Ready for a new chat.";
}));
document.querySelector("#archive-chat-copy").addEventListener("click", () => archiveChatRun(async () => {
  if (!archiveChat.messages.length) throw new Error("Start a conversation first.");
  await navigator.clipboard.writeText(archiveChatExport());
  archiveChatStatus.textContent = "Copied the conversation and source excerpts.";
}));
document.querySelector("#archive-chat-handoff").addEventListener("click", () => {
  // Request access directly in the click gesture, before any storage/network await.
  const permission = chrome.permissions.request({ origins: ["https://chatgpt.com/*"] });
  archiveChatRun(async () => {
    if (!archiveChat.messages.length) throw new Error("Start a conversation first.");
    if (!await permission) throw new Error("ChatGPT site access was declined. Use Copy chat and references instead.");
    const result = await chrome.runtime.sendMessage({ type: "handoff", filename: "archive-conversation.md", content: archiveChatExport() });
    if (!result?.ok) throw new Error(result?.error || "ChatGPT handoff failed. Use Copy chat and references instead.");
    archiveChatStatus.textContent = "Conversation and evidence attached in ChatGPT. Add your next question and send when ready.";
  });
});
