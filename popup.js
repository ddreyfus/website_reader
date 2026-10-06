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
    const source = await chrome.tabs.get(state.tabId);
    if (source.windowId === tab?.windowId) return source;
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
  attachmentFile.disabled = handoffRunning;
  useBatchButton.disabled = handoffRunning;
  handoffButton.disabled = handoffRunning || (!file && state?.status !== "completed");
  attachmentStatus.textContent = file ? `ChatGPT attachment: ${file.name}`
    : state?.status === "completed" ? `ChatGPT attachment: ${state.filename}` : "No completed collection or file selected.";
  useBatchButton.hidden = !file;
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

async function collectEdition(resume, tabId, email = null) {
  if (globalThis.__websiteReaderRunning) return { error: "Collection is already running in this tab." };
  globalThis.__websiteReaderRunning = true;
  let state;

  try {
    const articleTimeoutMs = 30000;
    const minimumArticleCharacters = location.hostname === "www.economist.com" ? 1500 : 400;
    const retryDelaysMs = email ? [5000] : [5000, 10000, 20000, 40000];
    const currentEditionUrl = email?.editionUrl || `${location.origin}${location.pathname}`;
    const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

    function note(message) {
      state.log.push(`${new Date().toISOString()}  ${message}`);
    }

    async function saveState(statusMessage = state.statusMessage) {
      if (email && location.href !== state.sourceUrl) throw new Error("The Gmail message changed. Return to the saved email to continue.");
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
        || page.querySelector('#challenge-form, form[action*="captcha" i], iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i]');
    }

    function markdownFromHtml(html, url) {
      const page = new DOMParser().parseFromString(html, "text/html");
      const title = page.querySelector("h1")?.textContent.trim()
        || page.querySelector('meta[property="og:title"]')?.content.trim()
        || page.title.trim();
      const unsupportedMarkdown = (reason = "This interactive article cannot yet be extracted reliably.") => `## ${title}\n\n[Original article](${url})\n\n> **Unsupported:** ${reason}`;
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
        ? { markdown: unsupportedMarkdown("Too little article text was available; this may be a preview or paywall."), unsupported: true }
        : { markdown, unsupported: false };
    }

    const nyt = location.hostname === "www.nytimes.com" && location.pathname === "/";
    const issue = nyt
      ? new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
      : location.pathname.split("/").filter(Boolean).at(-1);
    const economist = location.hostname === "www.economist.com" && location.pathname.startsWith("/weeklyedition/");
    const california = location.hostname === "alumni.berkeley.edu" && location.pathname.startsWith("/issue/");
    const cacm = location.hostname === "cacm.acm.org" && location.pathname.startsWith("/issue/");
    if (!email && (!issue || (!economist && !california && !cacm && !nyt))) {
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
      const links = email ? email.articles : [...document.querySelectorAll("main a[href]")]
        .map((anchor) => ({ url: new URL(anchor.href, location.href).href, title: anchor.textContent.trim() }))
        .filter(({ url, title }) => new URL(url).origin === location.origin && title.length > 2)
        .filter(({ url, title }) => {
          const pathname = new URL(url).pathname;
          if (nyt) return /^\/\d{4}\/\d{2}\/\d{2}\/.+\.html$/.test(pathname);
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
      if (nyt) links.forEach((article) => {
        article.url = `${location.origin}${new URL(article.url).pathname}`;
      });
      const articles = [...new Map(links.map((article) => [email ? article.url : new URL(article.url).pathname, article])).values()]
        .map((article) => ({ ...article, markdown: "", unsupported: false }));
      if (!email && !articles.length) return { error: "No article links were found on this issue page." };
      const publication = economist ? "The Economist" : california ? "California Magazine" : nyt ? "The New York Times" : "Communications of the ACM";
      const filenamePublication = economist ? "economist" : california ? "california-magazine" : nyt ? "nyt" : "cacm";
      state = {
        editionUrl: currentEditionUrl,
        filename: email ? `newsletter-${email.from.match(/@([a-z0-9.-]+)>?$/i)?.[1].toLowerCase() || "email"}-${email.id.replace(/[^a-z0-9]/gi, "").slice(-24)}.md` : `${filenamePublication}-${issue}.md`,
        heading: email?.subject || document.querySelector("h1")?.textContent.trim() || `${publication} — ${issue}`,
        ...(email ? { emailMarkdown: email.markdown, emailId: email.id } : {}),
        sourceUrl: email?.sourceUrl || location.href,
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
          if (email) {
            const fetched = await chrome.runtime.sendMessage({ type: "fetchArticle", index });
            if (fetched.ignored) {
              delete state.articleTabId;
              state.articles.splice(index, 1);
              state.currentIndex = index;
              note(`IGNORED ${article.url}: ${fetched.reason}`);
              await saveState(`Ignored a non-article link: ${article.title}`);
              index -= 1;
              break;
            }
            if (fetched.url) article.sourceUrl = fetched.url;
            if (Number.isInteger(fetched.articleTabId)) state.articleTabId = fetched.articleTabId;
            else delete state.articleTabId;
            if (fetched.error) {
              const error = new Error(fetched.error);
              error.nonRetryable = fetched.nonRetryable;
              error.needsUser = fetched.needsUser;
              error.articleUrl = fetched.url;
              throw error;
            }
            response = new Response(fetched.html, { status: fetched.status, statusText: fetched.statusText, headers: fetched.headers });
          } else {
            response = await fetch(article.url, { credentials: "include", signal: AbortSignal.timeout(articleTimeoutMs) });
          }
          note(email ? `Read rendered article page ${article.sourceUrl}` : `Response ${response.status} ${response.statusText || ""}`.trim());
          if (response.status === 404) throw new Error("HTTP 404");
          const html = await response.text();
          if (isChallengePage(html)) {
            const error = new Error("CAPTCHA or browser challenge detected");
            error.challenge = true;
            throw error;
          }
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const extraction = markdownFromHtml(html, article.sourceUrl || article.url);
          if (!extraction) {
            const error = new Error("No article title or body found");
            error.nonRetryable = !!email;
            throw error;
          }
          article.markdown = email ? `> Provenance: Linked article read from the rendered page at ${article.sourceUrl}. Listed in the original email as [${article.title.replace(/[\\[\]]/g, "\\$&")}](<${article.url}>). Retrieved text may be incomplete.\n\n${extraction.markdown}` : extraction.markdown;
          article.unsupported = extraction.unsupported;
          state.currentIndex = index + 1;
          note(extraction.unsupported ? `Marked ${article.url} unsupported.` : `Extracted ${extraction.markdown.length.toLocaleString()} Markdown characters from ${article.url}.`);
          await saveState(`Collected ${index + 1} of ${state.articles.length}: ${article.title}`);
          break;
        } catch (error) {
          const reason = error.name === "TimeoutError" ? `Timed out after ${articleTimeoutMs / 1000} seconds` : error.message || String(error);
          if (email && error.needsUser) {
            state.status = "paused";
            state.challengeUrl = error.articleUrl || article.url;
            note(`PAUSED ${article.url}: ${reason}`);
            await saveState(reason);
            return { paused: true };
          }
          const nonRetryable = error.nonRetryable || response?.status >= 400 && response.status < 500
            && ![408, 429].includes(response.status);
          if (error.challenge || nonRetryable || attempt === retryDelaysMs.length) {
            if (email) {
              article.unsupported = true;
              article.markdown = `## ${article.title}\n\n[Email link](<${article.url}>)\n\n> **Unavailable:** ${reason}. See the original email for any excerpt; the full article was not collected.`;
              state.currentIndex = index + 1;
              note(`UNAVAILABLE ${article.url}: ${reason}`);
              await saveState(`Article unavailable: ${article.title}. Keeping its email link and excerpt.`);
              break;
            }
            state.articles.splice(index, 1);
            note(`SKIPPED ${article.url}: ${reason}; ${state.articles.length} articles remain in the issue.`);
            await saveState(`Skipped unreadable article “${article.title}”: ${reason}. ${state.articles.length} articles remain in the issue.`);
            index -= 1;
            break;
          }
          const delayMs = Math.max(retryDelaysMs[attempt], response?.status === 429 ? retryAfterMs(response) : 0);
          note(`${reason}; retrying ${article.url} in ${(delayMs / 1000).toFixed(1)}s.`);
          await saveState(`Collecting ${index + 1} of ${state.articles.length}: ${article.title} — retrying in ${(delayMs / 1000).toFixed(1)}s`);
          await wait(delayMs);
        }
      }
    }

    const unsupported = state.articles.filter((article) => article.unsupported).length;
    await saveState(`Starting download for ${state.articles.length} articles${unsupported ? `; ${unsupported} unsupported or unavailable` : ""}.`);
    const downloadResponse = await chrome.runtime.sendMessage({ type: "download", filename: state.filename, mimeType: "text/markdown" });
    if (!downloadResponse?.ok) {
      state.status = "paused";
      note(`Download failed: ${downloadResponse?.error || "Chrome did not start the download."}`);
      await saveState("The issue is complete, but its download failed. Continue collection to retry the download.");
      return { paused: true };
    }
    note(`Built ${downloadResponse.contentLength.toLocaleString()} Markdown characters.`);
    state.status = "completed";
    state.downloadId = downloadResponse.downloadId;
    note(`Chrome accepted download ${downloadResponse.downloadId}.`);
    await saveState(`Downloaded ${email ? "email and " : ""}${state.articles.length} articles${unsupported ? `; ${unsupported} unsupported or unavailable` : ""}.`);
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

async function runCollection(resume, permissionRequest = null) {
  collectButton.disabled = true;
  continueButton.disabled = true;
  setStatus(resume ? "Continuing saved collection…" : "Cataloging links and starting collection…");
  let errorMessage = "";
  try {
    if (permissionRequest) await permissionRequest;
    const tab = await readingBatchTab(resume);
    if (!tab?.id) throw new Error("Chrome did not return an active tab.");
    let email = null;
    if (isGmailUrl(tab.url)) {
      const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: captureEmails });
      const { collectionState: saved } = await chrome.storage.local.get("collectionState");
      email = result?.find((message) => message.id === (resume ? saved?.emailId : emailSelect.value));
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
    if (resume && email && collectionState?.editionUrl === currentEdition) {
      const pending = collectionState.articles.slice(collectionState.currentIndex)
        .filter(article => email.articles.some(link => link.url === article.url));
      if (pending.length !== collectionState.articles.length - collectionState.currentIndex) {
        if (Number.isInteger(collectionState.articleTabId)
          && pending[0]?.url !== collectionState.articles[collectionState.currentIndex]?.url) {
          try { await chrome.tabs.remove(collectionState.articleTabId); } catch { /* Already closed. */ }
          delete collectionState.articleTabId;
        }
        collectionState.articles.splice(collectionState.currentIndex, collectionState.articles.length, ...pending);
        await chrome.storage.local.set({ collectionState });
      }
    }
    if (!resume && collectionState?.status === "running") {
      throw new Error(`A collection is ${collectionState.status} for ${collectionState.editionUrl}. Open that reading batch before starting another one.`);
    }
    if (!resume && Number.isInteger(collectionState?.articleTabId)) {
      try { await chrome.tabs.remove(collectionState.articleTabId); } catch { /* Already closed. */ }
    }
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: collectEdition, args: [resume, tab.id, email] });
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
    if (state?.status !== "paused" || !Number.isInteger(state.articleTabId)) throw new Error("Return to the saved Gmail message before skipping an article.");
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
    const tab = await readingBatchTab();
    await navigator.clipboard.writeText(await digestPrompt(tab?.url || ""));
    const publication = isGmailUrl(tab?.url) ? "email" : publicationName(tab?.url || "");
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
    setStatus(file ? `Opening ChatGPT with ${file.name}.` : "Opening ChatGPT with the collected file. The matching digest prompt is copied.");
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
    copyButton.textContent = `Copy ${publication} digest prompt`;
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
