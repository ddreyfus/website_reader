chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(async error => {
  await appendLog(`Could not enable Website Reader panel: ${error.message || String(error)}`);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "handoff") {
    (async () => {
      if (sender.url !== chrome.runtime.getURL("popup.html")) throw new Error("Use Website Reader's ChatGPT button.");
      const { collectionState: state } = await chrome.storage.local.get("collectionState");
      const selectedFile = typeof message.content === "string" && typeof message.filename === "string";
      if (!selectedFile && state?.status !== "completed") throw new Error("Complete a collection or choose a file first.");
      const content = selectedFile ? message.content : collectionMarkdown(state);
      const filename = selectedFile ? message.filename : state.filename;
      if (!content.trim()) throw new Error("The attachment is empty.");
      const granted = await chrome.permissions.contains({ origins: ["https://chatgpt.com/*"] });
      // Finish in the worker so opening a tab may close the popup safely.
      const tab = await chrome.tabs.create({ url: "https://chatgpt.com/", active: true });
      if (!granted) {
        sendResponse({ ok: false, error: `ChatGPT opened. Attach ${filename} manually; site access was declined.` });
        return;
      }
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpdated); reject(new Error("ChatGPT took too long to load. Attach the Markdown manually; the prompt is copied.")); }, 20000);
        function onUpdated(tabId, change) {
          if (tabId === tab.id && change.status === "complete") {
            clearTimeout(timeout);
            chrome.tabs.onUpdated.removeListener(onUpdated);
            resolve();
          }
        }
        chrome.tabs.onUpdated.addListener(onUpdated);
        async function checkLoaded() {
          try {
            const current = await chrome.tabs.get(tab.id);
            if (current.status === "complete") onUpdated(tab.id, { status: "complete" });
          } catch (error) {
            clearTimeout(timeout);
            chrome.tabs.onUpdated.removeListener(onUpdated);
            reject(error);
          }
        }
        checkLoaded();
      });
      const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: attachBatch, args: [content, filename] });
      if (!result?.ok) await appendLog(`ChatGPT handoff failed: ${result?.error || "No attachment result returned."}`);
      sendResponse(result || { ok: false, error: "ChatGPT returned no attachment result. Attach the Markdown manually; the prompt is copied." });
    })().catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
  if (message.type === "fetchArticle") {
    (async () => {
      const { collectionState: state } = await chrome.storage.local.get("collectionState");
      if (!state?.emailId || state.status !== "running" || sender.tab?.id !== state.tabId
        // Gmail can retain the isolated world's original URL after opening a message.
        || (sender.tab?.url || sender.url) !== state.sourceUrl
        || new URL(sender.url).origin !== new URL(state.sourceUrl).origin
        || (sender.frameId != null && sender.frameId !== 0) || !Number.isInteger(message.index)
        || message.index !== state.currentIndex) throw new Error("No active email article request.");
      const article = state.articles[message.index];
      if (!article) throw new Error("Unknown email article.");
      const url = new URL(article.url);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("Unsupported article URL.");
      let tab;
      if (Number.isInteger(state.articleTabId)) {
        try { tab = await chrome.tabs.get(state.articleTabId); } catch { /* Closed by the user. */ }
      }
      if (tab && article.sourceUrl && tab.url !== article.sourceUrl && tab.url !== article.url) {
        tab = await chrome.tabs.update(tab.id, { url: article.url });
      }
      tab ||= await chrome.tabs.create({ url: article.url, active: false });
      state.articleTabId = tab.id;
      await chrome.storage.local.set({ collectionState: state });
      try {
        await waitForTab(tab.id);
        tab = await chrome.tabs.get(tab.id);
        const destination = new URL(tab.url);
        if (!/^https?:$/.test(destination.protocol)) throw new Error("The article did not load as a web page.");
        if (/^From: The Free Press\s*</im.test(state.emailMarkdown || "")
          && (!(destination.hostname === "thefp.com" || destination.hostname === "www.thefp.com")
            || !destination.pathname.startsWith("/p/"))) {
          await chrome.tabs.remove(tab.id);
          sendResponse({ ignored: true, reason: "Free Press digests collect only Free Press articles", articleTabId: null });
          return;
        }
        if (destination.pathname === "/" || /^\/(?:about|archive|profile|app-link|subscribe|account|login|signin|feed|search)(?:\/|$)/i.test(destination.pathname)
          || /\.(?:jpg|jpeg|png|gif|svg|webp|pdf|zip|mp4|mp3|xml|rss)\/?$/i.test(destination.pathname)
          || /(?:^|\.)(?:substackcdn\.com|spotify\.com|podcasts\.apple\.com|maps\.google\.com|maps\.apple\.com)$/.test(destination.hostname)) {
          await chrome.tabs.remove(tab.id);
          sendResponse({ ignored: true, reason: "Redirect destination is navigation, a profile, or media rather than an article", articleTabId: null });
          return;
        }
        if (!await chrome.permissions.contains({ origins: [`${destination.protocol}//${destination.hostname}/*`] })) {
          await chrome.tabs.update(tab.id, { active: true });
          sendResponse({ error: `Site access required for ${destination.origin}. Return to Gmail and click Continue collection to grant access.`, needsUser: true, articleTabId: tab.id, url: tab.url });
          return;
        }
        const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readArticleTab });
        if (result.needsUser) {
          await chrome.tabs.update(tab.id, { active: true });
          sendResponse({ ...result, articleTabId: tab.id });
          return;
        }
        await chrome.tabs.remove(tab.id);
        sendResponse({ ...result, articleTabId: null });
      } catch (error) {
        // Leave interrupted or unreadable pages available for the user.
        try { await chrome.tabs.update(tab.id, { active: true }); } catch { /* Tab already closed. */ }
        sendResponse({ error: error.message || String(error), needsUser: true, articleTabId: tab.id, url: tab.url });
      }
    })().catch((error) => sendResponse({ error: error.message || String(error), nonRetryable: true }));
    return true;
  }
  if (message.type !== "download") return undefined;

  (async () => {
    const content = message.content ?? collectionMarkdown((await chrome.storage.local.get("collectionState")).collectionState);
    const url = `data:${message.mimeType};charset=utf-8,${encodeURIComponent(content)}`;
    const downloadId = await chrome.downloads.download({
      url,
      filename: message.filename,
      saveAs: true
    });
    sendResponse({ ok: true, downloadId, contentLength: content.length });
  })().catch((error) => {
    sendResponse({ ok: false, error: error.message || String(error) });
  });

  return true;
});

async function appendLog(message) {
  const { latestLog = "" } = await chrome.storage.local.get("latestLog");
  const line = `${new Date().toISOString()}  ${message}`;
  await chrome.storage.local.set({ latestLog: latestLog ? `${latestLog}\n${line}` : line });
}

chrome.runtime.onStartup.addListener(async () => {
  try {
    const { collectionState: state } = await chrome.storage.local.get("collectionState");
    if (!state) return;
    // Tab IDs from the previous browser session must never be reused.
    delete state.articleTabId;
    if (state.status === "running") {
      state.status = "paused";
      state.statusMessage = "Browser restarted. Return to the saved Gmail message or issue and continue collection.";
    }
    await chrome.storage.local.set({ collectionState: state });
  } catch (error) {
    await appendLog(`Could not checkpoint browser restart: ${error.message || String(error)}`);
  }
});

async function pauseCollectionForTab(tabId, newUrl = "") {
  const { collectionState } = await chrome.storage.local.get("collectionState");
  if (collectionState?.status !== "running" || collectionState.tabId !== tabId) return;
  if (newUrl) {
    const url = new URL(newUrl);
    if (collectionState.emailId ? newUrl === collectionState.sourceUrl : `${url.origin}${url.pathname}` === collectionState.editionUrl) return;
  }

  const message = "Collection tab closed or navigated away. Return to the saved edition and continue collection.";
  const line = `${new Date().toISOString()}  PAUSED: ${message}`;
  collectionState.status = "paused";
  collectionState.statusMessage = message;
  collectionState.updatedAt = new Date().toISOString();
  collectionState.log.push(line);
  await chrome.storage.local.set({
    collectionState,
    latestLog: collectionState.log.join("\n")
  });
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    await pauseCollectionForTab(tabId);
  } catch (error) {
    await appendLog(`Could not checkpoint closed collection tab ${tabId}: ${error.message || String(error)}`);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url && changeInfo.status !== "loading") return;
  try {
    await pauseCollectionForTab(tabId, changeInfo.status === "loading" ? "" : changeInfo.url);
  } catch (error) {
    await appendLog(`Could not checkpoint navigated collection tab ${tabId}: ${error.message || String(error)}`);
  }
});

async function handleDownloadChange(delta) {
  if (!delta.state?.current) return;

  const [item] = await chrome.downloads.search({ id: delta.id });
  if (!item || item.byExtensionId !== chrome.runtime.id) return;

  if (delta.state.current === "complete") {
    await appendLog(`Download ${delta.id} completed: ${item.filename}`);
    return;
  }

  if (delta.state.current !== "interrupted") return;
  const reason = delta.error?.current || item.error || "unknown reason";
  await appendLog(`Download ${delta.id} failed: ${reason}`);

  try {
    await chrome.downloads.removeFile(delta.id);
    await appendLog(`Removed partial file for download ${delta.id}.`);
  } catch (error) {
    await appendLog(`No partial file removed for download ${delta.id}: ${error.message || String(error)}`);
  }

  await chrome.downloads.erase({ id: delta.id });
  await appendLog(`Cleared failed download ${delta.id} from Chrome history.`);
}

chrome.downloads.onChanged.addListener(async (delta) => {
  try {
    await handleDownloadChange(delta);
  } catch (error) {
    await appendLog(`Download cleanup error: ${error.message || String(error)}`);
  }
});

// ChatGPT's observed general file input is distinct from its photo inputs.
// This is a UI integration, so fail visibly if the composer changes or requires login.
async function attachBatch(content, filename) {
  function notice(text) {
    const element = document.createElement("div");
    element.setAttribute("role", "status");
    element.textContent = text;
    Object.assign(element.style, { position: "fixed", bottom: "16px", right: "16px", maxWidth: "360px", padding: "12px", background: "#175d3a", color: "white", borderRadius: "8px", zIndex: "2147483647", font: "14px system-ui" });
    document.body.append(element);
    setTimeout(() => element.remove(), 20000);
  }
  const visible = element => element.getClientRects().length && getComputedStyle(element).visibility !== "hidden";
  const needsLogin = () => [...document.querySelectorAll('button, a')].some(element => visible(element)
    && /^(?:log in|sign in)$/i.test(element.textContent.trim()));
  const composerSelector = '[data-composer-markdown][role="textbox"][contenteditable="true"], #prompt-textarea[contenteditable="true"], textarea#prompt-textarea, textarea[name="prompt-textarea"]';
  async function waitFor(find, failure) {
    const existing = find();
    if (existing) return existing;
    return await new Promise((resolve, reject) => {
      const observer = new MutationObserver(() => {
        try {
          const found = find();
          if (found) { clearTimeout(timeout); observer.disconnect(); resolve(found); }
        } catch (error) { clearTimeout(timeout); observer.disconnect(); reject(error); }
      });
      const timeout = setTimeout(() => { observer.disconnect(); reject(new Error(failure())); }, 30000);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    });
  }
  try {
    const input = await waitFor(() => {
      const composer = document.querySelector(composerSelector);
      if (!composer || !visible(composer) || composer.disabled || composer.readOnly || composer.getAttribute("aria-disabled") === "true") return;
      return document.querySelector('input[type="file"][aria-label="Attach files"]:not(:disabled)')
        || [...document.querySelectorAll('input[type="file"]')].find(element => !element.accept && !element.disabled);
    }, () => needsLogin() ? "ChatGPT is showing a sign-in control. Sign in, then retry Open in ChatGPT."
      : "ChatGPT's composer or attachment control did not become ready within 30 seconds. Retry Open in ChatGPT or attach the Markdown manually.");
    const files = new DataTransfer();
    files.items.add(new File([content], filename, { type: /\.txt$/i.test(filename) ? "text/plain" : "text/markdown" }));
    input.files = files.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => {
      const uploadError = [...document.querySelectorAll('[role="alert"]')].find(element => visible(element)
        && (element.textContent.includes(filename) || /upload|file|attach/i.test(element.textContent)));
      if (uploadError) throw new Error(`ChatGPT reported: ${uploadError.textContent.trim()}`);
      const attachments = document.querySelector('[data-composer-attachments]') || document.querySelector(composerSelector)?.closest('form');
      return attachments?.textContent.includes(filename) || [...(attachments?.querySelectorAll('[title], [aria-label]') || [])]
        .some(element => element.getAttribute('title') === filename || element.getAttribute('aria-label') === filename);
    }, () => "The file was handed to ChatGPT, but its attachment could not be confirmed within 30 seconds. Check the draft before retrying or attaching manually.");
    notice("Reading batch attached. Paste the copied digest prompt and send when ready.");
    return { ok: true };
  } catch (error) {
    const message = `Automatic attachment unavailable. ${error.message || String(error)} File: ${filename}. The digest prompt is copied.`;
    notice(message);
    return { ok: false, error: message };
  }
}

function collectionMarkdown(state) {
  const contents = state.articles
    .map((article, index) => `- [${article.title.replace(/[\\[\]]/g, "\\$&")}](#article-${index + 1})`)
    .join("\n");
  const articleMarkdown = state.articles
    .map((article, index) => `<a id="article-${index + 1}"></a>\n\n${article.markdown}`)
    .join("\n\n---\n\n");
  const markdown = `# ${state.heading}\n\nSource: ${state.sourceUrl}\n\n## Contents\n\n${state.emailMarkdown ? "- [Original email](#original-email)\n" : ""}${contents}\n\n---\n\n${state.emailMarkdown ? `<a id="original-email"></a>\n\n${state.emailMarkdown}\n\n---\n\n` : ""}${articleMarkdown}\n`;
  return markdown;
}

async function waitForTab(tabId) {
  if ((await chrome.tabs.get(tabId)).status === "complete") return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("Article loading timed out. Check the open tab, then continue collection.")), 20000);
    function finish(error) {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      error ? reject(error) : resolve();
    }
    function onUpdated(id, change) { if (id === tabId && change.status === "complete") finish(); }
    function onRemoved(id) { if (id === tabId) finish(new Error("The article tab was closed. Continue collection to reopen it.")); }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    (async () => { try { if ((await chrome.tabs.get(tabId)).status === "complete") finish(); } catch (error) { finish(error); } })();
  });
}

async function readArticleTab() {
  const visible = selector => [...document.querySelectorAll(selector)].some(element => element.getClientRects().length && getComputedStyle(element).visibility !== "hidden");
  // Allow client-rendered article text to appear and settle before snapshotting.
  await new Promise(resolve => {
    let quiet;
    const observer = new MutationObserver(check);
    const timeout = setTimeout(done, 10000);
    function done() { clearTimeout(timeout); clearTimeout(quiet); observer.disconnect(); resolve(); }
    function check() {
      clearTimeout(quiet);
      if (visible('input[type="password"], #challenge-form')
        || /\b404\b|page not found|just a moment/i.test(document.title)
        || document.querySelector("h1") && document.querySelector("article, main")?.innerText.trim().length >= 400) quiet = setTimeout(done, 500);
    }
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    check();
  });
  const heading = `${document.title} ${document.querySelector("h1")?.innerText || ""}`;
  const text = (document.querySelector("article, main") || document.body).innerText;
  const challenge = /verify (?:that )?you are human|unusual traffic|just a moment|attention required|access denied/i.test(heading)
    || visible('#challenge-form, form[action*="captcha" i], iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i]');
  const login = visible('input[type="password"]')
    || text.length < 1500 && /sign in to|log in to|sign in|subscribe to (?:read|continue)|member.only|members.only/i.test(text);
  if (challenge || login) return { needsUser: true, error: challenge ? "Browser challenge detected. Complete it in the open article tab, then return to Gmail and continue collection." : "Login or subscription required. Sign in in the open article tab, then return to Gmail and continue collection.", url: location.href };
  if (/\b404\b|page not found|article not found/i.test(heading)) return { error: "Article page not found", nonRetryable: true };
  const copy = document.documentElement.cloneNode(true);
  const original = [...document.documentElement.querySelectorAll("*")];
  const cloned = [...copy.querySelectorAll("*")];
  original.forEach((element, index) => {
    if (document.body.contains(element)
      && (getComputedStyle(element).display === "none" || getComputedStyle(element).visibility === "hidden")) cloned[index].remove();
  });
  return { html: copy.outerHTML, url: location.href, status: 200, statusText: "Rendered page", headers: {} };
}
