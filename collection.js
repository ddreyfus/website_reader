function markdownFromHtml(html, url, minimumArticleCharacters = 400) {
  const page = new DOMParser().parseFromString(html, "text/html");
  const title = page.querySelector("h1")?.textContent.trim()
    || page.querySelector('meta[property="og:title"]')?.content.trim()
    || page.title.trim();
  const unsupportedMarkdown = (reason = "This interactive article cannot yet be extracted reliably.") => `## ${title}\n\n[Original article](${url})\n\n> **Unsupported:** ${reason}`;
  const interactive = new URL(url).pathname.includes("/interactive/")
    || page.querySelector('iframe[src*="infographics.economist.com"], [data-component*="interactive" i]');
  if (title && interactive) return { markdown: unsupportedMarkdown(), unsupported: true };
  page.querySelectorAll("script, style, nav, aside, footer, form, figure, button, [hidden], [aria-hidden='true'], [role=navigation], [itemprop=author], .author-bio, .author-description, .related-articles, .related-stories, .comments, #comments")
    .forEach((element) => element.remove());
  const score = element => {
    const paragraphs = (element.matches("p, blockquote, pre") ? [element] : [...element.querySelectorAll("p, blockquote, pre")])
      .filter(paragraph => !paragraph.parentElement.closest("p, blockquote, pre"));
    const prose = paragraphs.reduce((total, paragraph) => total + paragraph.textContent.trim().length
      - [...paragraph.querySelectorAll("a")].reduce((length, link) => length + link.textContent.length, 0), 0);
    return prose * prose / Math.max(prose, element.textContent.trim().length, 1);
  };
  const bodies = [...page.querySelectorAll('[itemprop="articleBody"], .body-description')];
  const candidates = bodies.length ? bodies : [...page.querySelectorAll("article, main, [role=main], section, div, body")];
  const source = candidates.sort((a, b) => score(b) - score(a) || a.textContent.length - b.textContent.length)[0];
  if (!title || !source || !source.querySelector("h2, h3, p, blockquote, li, pre") && !source.matches("p, blockquote, li, pre")) return null;
  // Explicit body sections may be siblings, rather than one enclosing article.
  const sources = bodies.length ? bodies.filter(body => body === source || body.parentElement === source.parentElement) : [source];
  const lines = [`## ${title}`, "", `[Original article](${url})`, ""];
  sources.flatMap(source => source.matches("p, blockquote, li, pre") ? [source] : [...source.querySelectorAll("h2, h3, p, blockquote, li, pre")]).forEach((element) => {
    if (element.parentElement.closest("p, blockquote, li, pre")) return;
    const text = element.textContent.replace(/\s+/g, " ").trim();
    if (!text || text === title) return;
    if (element.matches("h2, h3")) lines.push(`${element.tagName === "H2" ? "###" : "####"} ${text}`, "");
    else if (element.matches("blockquote")) lines.push(`> ${text}`, "");
    else if (element.matches("li")) lines.push(`- ${text}`);
    else lines.push(text, "");
  });
  const markdown = lines.join("\n").trim();
  const bodyCharacters = sources.reduce((total, source) => total + score(source), 0);
  return bodyCharacters < minimumArticleCharacters
    ? { markdown: unsupportedMarkdown("Incomplete extraction: too little substantive body text was identified. The cause of the missing text is unknown."), unsupported: true }
    : { markdown, unsupported: false };
}

function captureCurrentPage() {
  const source = document.querySelector("main, [role=main]") || document.body;
  const text = source?.innerText.trim();
  if (!text) return { error: "No readable text was found on this page." };
  const escape = value => value.replace(/[\\`*_[\]<>]/g, "\\$&");
  const title = document.title.trim() || location.hostname;
  const capturedAt = new Date().toISOString();
  const anchors = [...source.querySelectorAll("a[href]")]
    .filter(anchor => /^https?:/.test(anchor.href) && anchor.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      && !anchor.closest("nav, footer, aside, [role=navigation]")
      && (!anchor.closest("header") || anchor.closest("article, main, [role=main], section")));
  const links = [...new Map(anchors.map(anchor => [anchor.href, `- [${escape(anchor.innerText.replace(/\s+/g, " ").trim() || anchor.href)}](<${anchor.href}>)`])).values()];
  return {
    title, url: location.href,
    articles: [...new Set(anchors.map(anchor => { const url = new URL(anchor.href); url.hash = ""; return url.href; }))]
      .filter(url => {
        const destination = new URL(url);
        return url !== location.href.split("#")[0]
          && !/\.(?:jpg|jpeg|png|gif|svg|webp|pdf|zip|mp4|mp3)$/i.test(destination.pathname)
          && !/(?:^|\/)(?:unsubscribe|subscribe|login|signin|account|logout|signout|topic|category|tag|type)(?:\/|$)/i.test(destination.pathname)
          && !/\/(?:magazine|archive)\/\d{4}\/(?:\w+\/?)?$/.test(destination.pathname)
          && !/[?&](?:unsubscribe|logout|signout)(?:=|&|$)/i.test(destination.search);
      }),
    filename: `page-${location.hostname.replace(/[^a-z0-9.-]/gi, "-")}-${capturedAt.replace(/[:.]/g, "-")}.md`,
    content: `# ${escape(title)}\n\nSource: <${location.href}>\n\nCaptured: ${capturedAt}\n\n> Snapshot of loaded, rendered page text. More content may appear after scrolling or expanding sections.\n\n${text}\n${links.length ? `\n## Page links\n\n${links.join("\n")}\n` : ""}`
  };
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
      if (!email) state.tabId = tabId;
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
        heading: email ? email.subject || "Newsletter" : document.querySelector("h1")?.textContent.trim() || `${publication} — ${issue}`,
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
        let extraction;
        try {
          note(`Fetching ${article.url} (attempt ${attempt + 1}/${retryDelaysMs.length + 1})`);
          await saveState(`Collecting ${index + 1} of ${state.articles.length}: ${article.title} — attempt ${attempt + 1} of ${retryDelaysMs.length + 1}`);
          if (email) {
            const fetched = await fetchEmailArticle(index, markdownFromHtml);
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
            extraction = fetched.extraction;
            response = new Response("", { status: fetched.status, statusText: fetched.statusText });
          } else {
            response = await fetch(article.url, { credentials: "include", signal: AbortSignal.timeout(articleTimeoutMs) });
          }
          note(email ? `Read rendered article page ${article.sourceUrl}` : `Response ${response.status} ${response.statusText || ""}`.trim());
          if (response.status === 404) throw new Error("HTTP 404");
          const html = await response.text();
          if (!email && isChallengePage(html)) {
            const error = new Error("CAPTCHA or browser challenge detected");
            error.challenge = true;
            throw error;
          }
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          if (!email) extraction = markdownFromHtml(html, article.sourceUrl || article.url, minimumArticleCharacters);
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
    const downloadResponse = email
      ? await downloadCollection({ filename: state.filename, mimeType: "text/markdown" })
      : await chrome.runtime.sendMessage({ type: "download", filename: state.filename, mimeType: "text/markdown" });
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
