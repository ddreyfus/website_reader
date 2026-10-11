// Authenticated reads stay in the owned ChatGPT page. Tokens never leave it.
async function chatGPTRead(kind, id = "", cursor = "", project = "", interval = 0, lastRequestAt = 0) {
  const requests = [];
  const sessionKey = Symbol.for("website-reader.chatgpt-backup.session");
  try {
    if (location.origin !== "https://chatgpt.com") throw new Error("Waiting for the owned ChatGPT tab to load.");
    const get = async (path, headers = {}) => {
      const category = path === "/api/auth/session" || path.startsWith("/backend-api/accounts/") ? "authentication" : kind === "conversation" ? "download" : "inventory";
      let response;
      const wait = lastRequestAt + interval - Date.now();
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      lastRequestAt = Date.now();
      try {
        response = await fetch(path, { headers, credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(20000) });
      } catch (error) {
        requests.push([category, "network-error"]);
        throw error;
      }
      requests.push([category, response.status ?? 200]);
      if (!response.ok) {
        const error = new Error(`ChatGPT ${kind} returned HTTP ${response.status}${response.status === 401 || response.status === 403 ? "; check sign-in and workspace access" : ""}.`);
        error.status = response.status;
        const retryAfter = response.headers.get("Retry-After");
        const retrySeconds = Number(retryAfter) || (Date.parse(retryAfter) - Date.now()) / 1000;
        error.retrySeconds = Math.max(60, Number.isFinite(retrySeconds) ? Math.ceil(retrySeconds) : 60);
        const clean = value => {
          let text = String(value);
          if (headers.Authorization) text = text.replaceAll(headers.Authorization.replace(/^Bearer /, ""), "[redacted]");
          return text.replace(/Bearer\s+[^\s"',;]+/gi, "Bearer [redacted]")
            .replace(/\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){1,2}\b/g, "[redacted]")
            .replace(/((?:access[_-]?token|refresh[_-]?token|authorization|cookie|password|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, "$1[redacted]")
            .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted email]")
            .replace(/[\r\n\t]+/g, " ").slice(0, 220);
        };
        error.message += ` Endpoint: ${path.split("?")[0]}`;
        if (kind === "list" && (id === "recent" || id === "archived")) error.message += `; list=${id}; offset=${Number(cursor)}`;
        else if (cursor) error.message += "; continuation=yes";
        for (const name of ["Retry-After", "Content-Type", "x-request-id", "cf-ray"]) {
          const value = response.headers.get(name);
          if (value) error.message += `; ${name}=${clean(value).slice(0, 100)}`;
        }
        // Inspect at most 4 KiB; never log arbitrary HTML, session data, or
        // conversation payloads. Only explicit JSON error fields are eligible.
        try {
          const reader = response.body?.getReader();
          if (reader) {
            const bytes = new Uint8Array(4096);
            let size = 0;
            try {
              while (size < bytes.length) {
                const { value, done } = await reader.read();
                if (done) break;
                const chunk = value.subarray(0, bytes.length - size);
                bytes.set(chunk, size);
                size += chunk.length;
              }
            } finally { await reader.cancel(); }
            const body = JSON.parse(new TextDecoder().decode(bytes.subarray(0, size)));
            const detail = body.error ?? body.detail;
            const fields = typeof detail === "string" ? [detail]
              : [detail?.code, detail?.type, detail?.message];
            const description = fields.filter(value => typeof value === "string").map(clean).join("; ").slice(0, 300);
            if (description) error.message += `; error=${description}`;
            else error.message += "; body omitted (no supported error fields)";
          }
        } catch { error.message += "; body omitted (unreadable, non-JSON, or over 4 KiB)"; }
        throw error;
      }
      return response.json();
    };
    let workspace = decodeURIComponent(document.cookie.match(/(?:^|;\s*)_account=([^;]*)/)?.[1] || "");
    if (workspace.startsWith('"')) { const value = JSON.parse(workspace); if (typeof value === "string") workspace = value; }
    // The owned tab is recreated for every batch. Reuse its session object;
    // credentials never enter extension storage or cross the injection boundary.
    let session = globalThis[sessionKey];
    if (!session || session.backupWorkspace !== workspace || session.backupExpiresAt <= Date.now()) {
      delete globalThis[sessionKey];
      session = await get("/api/auth/session");
      if (!session.accessToken || !session.user?.id) throw new Error("ChatGPT session unavailable; sign in before resuming backup.");
      if (workspace) {
        const accounts = await get("/backend-api/accounts/check/v4-2023-04-27", { Authorization: `Bearer ${session.accessToken}` });
        const available = Object.values(accounts.accounts || {}).map(entry => entry.account).filter(Boolean);
        const account = accounts.accounts?.[workspace]?.account || available.find(entry => entry.account_id === workspace)
          || (workspace === "personal" && accounts.accounts?.default?.account?.structure === "personal" ? accounts.accounts.default.account : null);
        if (!account || (!account.account_id && account.structure !== "personal")) {
          throw new Error(`Cannot verify the selected ChatGPT workspace (matching entry: ${Boolean(account)}; type: ${account?.structure || "unknown"}; accounts: ${available.length}; selector: ${workspace === "personal" || workspace === "default" ? workspace : /^[0-9a-f-]{36}$/i.test(workspace) ? "UUID" : `other(${workspace.length})`}; types: ${available.map(entry => entry.structure).join(",")}).`);
        }
        session.backupAccountId = account.account_id;
      }
      session.backupWorkspace = workspace;
      session.backupExpiresAt = Math.min(Date.parse(session.expires) || Infinity, Date.now() + 5 * 60 * 1000);
      globalThis[sessionKey] = session;
    }
    const headers = { Authorization: `Bearer ${session.accessToken}` };
    if (session.backupAccountId) headers["Chatgpt-Account-Id"] = session.backupAccountId;
    const identity = `${session.user.id}:${workspace || "personal"}`;
    if (kind === "identity") return { identity, requests, lastRequestAt };
    let path;
    if (kind === "projects") {
      path = `/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=0${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    } else if (kind === "list") {
      if (id === "recent" || id === "archived") {
        if (!/^\d*$/.test(cursor)) throw new Error("Invalid inventory offset.");
        path = `/backend-api/conversations?offset=${Number(cursor)}&limit=50&order=updated&is_archived=${id === "archived"}`;
      }
    } else if (kind === "conversation" && /^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      if (project) headers["Chatgpt-Project-Id"] = project;
      path = cursor
        ? `/backend-api/conversations/${id}/messages?before=${encodeURIComponent(cursor)}&num_turns=10&include_has_versions=true`
        : `/backend-api/conversations/${id}?num_turns=10&include_has_versions=true`;
    }
    if (!path) throw new Error("Unsupported ChatGPT read request.");
    return { identity, data: await get(path, headers), requests, lastRequestAt };
  } catch (error) {
    if (error.status === 401 || error.status === 403) delete globalThis[sessionKey];
    return { error: error.message || String(error), status: error.status, retrySeconds: error.retrySeconds, requests, lastRequestAt };
  }
}

async function chatGPTReadPage(tabId, identity, kind, id = "", cursor = "", project = "") {
  const settings = await chrome.storage.local.get(["chatGPTRequestInterval", "chatGPTLastRequestAt", "chatGPTBackupRetryAt", "chatGPTRateLimitCount"]);
  if (settings.chatGPTBackupRetryAt > Date.now()) throw Object.assign(new Error(`Rate limit cooldown; next retry at ${new Date(settings.chatGPTBackupRetryAt).toLocaleString()}.`), { status: 429, cooldown: true });
  const interval = Math.max(0.5, Math.min(30, Number(settings.chatGPTRequestInterval) || 2)) * 1000;
  // Reserve before injection so a terminated worker cannot immediately burst again.
  await chrome.storage.local.set({ chatGPTLastRequestAt: Math.max(Date.now(), (settings.chatGPTLastRequestAt || 0) + interval) });
  const [injection] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: chatGPTRead, args: [kind, id, cursor, project, interval, settings.chatGPTLastRequestAt || 0] });
  const result = injection?.result;
  if (Number.isFinite(result?.lastRequestAt)) await chrome.storage.local.set({ chatGPTLastRequestAt: result.lastRequestAt });
  if (!result?.error && result?.requests?.some(([category, status]) => category !== "authentication" && status === 200)
      && settings.chatGPTRateLimitCount && Date.now() - settings.chatGPTBackupRetryAt >= 5 * 60 * 1000) {
    await chrome.storage.local.set({ chatGPTRateLimitCount: 0 });
  }
  if (result?.requests?.length) {
    const counts = ["inventory", "download", "authentication"].map(category => `${category}=${result.requests.filter(([name]) => name === category).length}`).join(" · ");
    const outcomes = result.requests.map(([category, status]) => `${category}:${status}`).join(", ");
    await chatGPTBackupProgress(`ChatGPT requests: ${counts} · outcomes=${outcomes}`);
  }
  if (result?.error) throw Object.assign(new Error(result.error), { status: result.status, retrySeconds: result.retrySeconds });
  if (!result?.identity) throw new Error("ChatGPT page returned no authenticated identity.");
  if (identity && identity !== result.identity) throw new Error("ChatGPT account/workspace changed. Use its own backup label.");
  return result;
}

// Shared by inventory, authentication, and downloads; survives worker/browser restarts.
async function chatGPTBackupRateLimit(error) {
  if (error.cooldown) return;
  const settings = await chrome.storage.local.get(["chatGPTMaxBackoffMinutes", "chatGPTRateLimitCount", "chatGPTBackupRetryAt"]);
  const count = Math.min(16, (settings.chatGPTRateLimitCount || 0) + 1);
  const maximum = Math.max(1, Math.min(60, Number(settings.chatGPTMaxBackoffMinutes) || 15)) * 60;
  const backoff = Math.min(maximum, 60 * 2 ** (count - 1) * (1 + Math.random() * 0.1));
  error.retrySeconds = Math.ceil(Math.max(backoff, error.retrySeconds || 60));
  const until = Math.max(settings.chatGPTBackupRetryAt || 0, Date.now() + error.retrySeconds * 1000);
  await chrome.storage.local.set({ chatGPTBackupRetryAt: until, chatGPTRateLimitCount: count });
  error.message += ` Shared cooldown: retry after ${error.retrySeconds} seconds, at ${new Date(until).toLocaleString()}.`;
}

// Each continuation is committed in the same SQLite transaction as its rows.
async function chatGPTInventory(tabId, scope, checkpoint, projects = {}) {
  const starting = !checkpoint || checkpoint.complete;
  const { identity } = await chatGPTReadPage(tabId, checkpoint?.identity, "identity");
  if (!checkpoint) checkpoint = { identity, complete: false, completedAt: 0, lists: [] };
  if (checkpoint.complete) {
    for (const list of checkpoint.lists.filter(item => item.id !== "projects")) Object.assign(list, { cursor: "", done: false, max: 0, previous: null, ordered: true, count: 0 });
    checkpoint.complete = false;
  }
  if (!checkpoint.lists.length) checkpoint.lists = [
    { id: "projects", title: "Projects", cursor: "", done: true },
    ...["recent", "archived"].map(id => ({ id, title: id, cursor: "", done: false, baseline: false, watermark: 0, max: 0, previous: null, ordered: true, count: 0 }))
  ];
  // Legacy project-list cursors are no longer conversation discovery work.
  checkpoint.lists = checkpoint.lists.filter(list => !list.id.startsWith("g-p-"));
  // Keep the boundary at scan start: edits made during pagination must still
  // qualify for the next scan. Preserve it across suspension and retries.
  if (starting || !checkpoint.startedAt) checkpoint.startedAt = Date.now();
  for (let step = 0; step < 20; step++) {
    if (!await chatGPTBackupActive(scope)) return false;
    const list = checkpoint.lists.find(item => !item.done);
    if (!list) {
      checkpoint.complete = true;
      checkpoint.completedAt = Date.now();
      await chatGPTArchive("discover", { scope, conversations: [], checkpoint });
      await chatGPTArchive("recheck", { scope });
      await chatGPTBackupCounts(scope);
      await chatGPTBackupProgress("Inventory complete for accessible recent and archived lists. Starting sequential conversation downloads.");
      return true;
    }
    let data;
    try {
      ({ data } = await chatGPTReadPage(tabId, identity, list.id === "projects" ? "projects" : "list", list.id, list.cursor));
    } catch (error) {
      if (error.status === 400 && list.cursor) {
        Object.assign(list, { cursor: "", done: false, baseline: false, max: 0, previous: null, ordered: true, count: 0 });
        await chatGPTArchive("discover", { scope, conversations: [], checkpoint });
      }
      throw error;
    }
    if (!Array.isArray(data?.items)) throw new Error(`Unsupported ${list.title} inventory response; scan checkpoint retained.`);
    if (data.has_missing_conversations === true) throw new Error(`ChatGPT reports missing conversations in ${list.title}; baseline not complete.`);
    let conversations = [];
    let next = null;
    if (list.id === "projects") {
      for (const item of data.items) {
        const project = item.gizmo?.gizmo;
        if (!/^g-p-[A-Za-z0-9_-]+$/.test(project?.id || "") || typeof project.display?.name !== "string") throw new Error("Unsupported project inventory entry.");
        projects[project.id] = project.display.name;
      }
      if (!("cursor" in data)) throw new Error("Project inventory lacks an explicit continuation cursor.");
      next = data.cursor;
    } else {
      if (data.items.some(item => /^g-p-/.test(item.gizmo_id || "") && !projects[item.gizmo_id])) {
        let refresh = checkpoint.lists.find(item => item.id === "projects");
        if (!refresh) { refresh = { id: "projects", title: "Projects", cursor: "", done: true }; checkpoint.lists.unshift(refresh); }
        if (refresh.refreshedAt !== checkpoint.startedAt) {
          Object.assign(refresh, { cursor: "", done: false, refreshedAt: checkpoint.startedAt });
          await chatGPTArchive("discover", { scope, conversations: [], checkpoint });
          continue; // Replay this conversation page after project pagination finishes.
        }
      }
      let last = null;
      for (const item of data.items) {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(item.id || "") || typeof item.title !== "string") throw new Error("Unsupported conversation inventory entry.");
        const updated = typeof item.update_time === "number" ? item.update_time * 1000 : Date.parse(item.update_time);
        const valid = Number.isFinite(updated) && updated > 0;
        if (!valid) list.ordered = false;
        if (!item.is_starred && !item.pinned_time && valid) {
          if (list.previous != null && updated > list.previous) list.ordered = false;
          list.previous = updated;
          last = updated;
        }
        if (valid) list.max = Math.max(list.max || 0, updated);
        const project = /^g-p-/.test(item.gizmo_id || "") ? item.gizmo_id : "";
        conversations.push({ id: item.id, title: item.title, project_id: project, project_title: projects[project] || "", updated_at: valid ? new Date(updated).toISOString() : "" });
      }
      list.count = (list.count || 0) + data.items.length;
      if (!Number.isInteger(data.total) || data.total < 0 || data.offset !== Number(list.cursor)) throw new Error("Conversation list lacks a reliable total/offset.");
      const offset = Number(list.cursor) + data.items.length;
      if (offset < data.total) {
        if (!data.items.length) throw new Error("Conversation inventory stopped before its reported total.");
        next = String(offset);
      }
      // Early stop is enabled only after a full, update-ordered baseline for
      // this list. Pinned rows do not establish the stopping boundary.
      const stop = list.baseline && list.orderVerified && list.ordered && last != null && last < list.watermark - 120000;
      if (stop) next = null;
      if (next == null) {
        if (!stop) { list.baseline = true; list.orderVerified = list.ordered; }
        list.watermark = Math.max(list.watermark || 0, Math.min(list.max || 0, checkpoint.startedAt));
      }
    }
    if (next != null && (String(next) === String(list.cursor) || !data.items.length)) throw new Error(`Pagination did not advance for ${list.title}.`);
    list.done = next == null;
    list.cursor = next == null ? "" : String(next);
    await chatGPTArchive("discover", { scope, conversations, checkpoint, projects: list.id === "projects" ? projects : undefined });
    await chatGPTBackupProgress(`Inventory: ${list.title} · ${list.count || data.items.length} entries checked · ${list.done ? "list finished" : "page saved; more pages queued"}. Discovered conversations remain eligible for download.`);
  }
  await chatGPTBackupCounts(scope);
  await chatGPTBackupProgress("Inventory checkpoint saved. Next inventory batch resumes its next page.");
  return false;
}

async function chatGPTBackupRun(discover = false) {
  await navigator.locks.request("chatgpt-backup", { ifAvailable: true }, async lock => {
    if (!lock) return;
    const settings = await chrome.storage.local.get(["chatGPTBackupScope", "chatGPTBackupEnabled", "chatGPTBackupRequestedAt", "chatGPTBackupDiscoveredAt", "chatGPTBackupRetryAt", "chatGPTInventoryRetryAt"]);
    const scope = settings.chatGPTBackupScope;
    if (!settings.chatGPTBackupEnabled || !/^[A-Za-z0-9_-]{1,128}$/.test(scope || "")) return;
    if (settings.chatGPTBackupRetryAt > Date.now()) {
      await chatGPTBackupProgress(`Rate limit cooldown: inventory and downloads paused. Next retry at ${new Date(settings.chatGPTBackupRetryAt).toLocaleString()}.`);
      return;
    }
    if (!await chrome.permissions.contains({ origins: ["https://chatgpt.com/*"] })) return;
    const { chatGPTBackupTabId: orphan } = await chrome.storage.session.get("chatGPTBackupTabId");
    const sessions = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
    if (!sessions.some(tab => tab.id !== orphan)) { await chatGPTBackupProgress("Waiting: open ChatGPT in your signed-in browser."); return; }
    let tab;
    try {
      let { checkpoint, projects } = await chatGPTArchive(`checkpoint?scope=${encodeURIComponent(scope)}`);
      // Non-rate-limit inventory failures retain their independent retry schedule.
      const inventoryDue = !checkpoint?.complete || discover || (settings.chatGPTBackupRequestedAt || 0) > (settings.chatGPTBackupDiscoveredAt || 0);
      if (Number.isInteger(orphan)) {
        try { const previous = await chrome.tabs.get(orphan); if (previous.url?.startsWith("https://chatgpt.com/")) await chrome.tabs.remove(orphan); } catch { /* Already gone. */ }
      }
      tab = await chrome.tabs.create({ url: "https://chatgpt.com/", active: false });
      await chrome.storage.session.set({ chatGPTBackupTabId: tab.id });
      // A fresh tab can still be about:blank when the first injection runs.
      let ready = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        if (!await chatGPTBackupActive(scope)) return;
        const current = await chrome.tabs.get(tab.id);
        if (current.status === "complete" && current.url?.startsWith("https://chatgpt.com/")) { ready = true; break; }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (!ready) throw new Error("Owned ChatGPT tab did not finish loading; retrying later.");
      if (inventoryDue && !(settings.chatGPTInventoryRetryAt > Date.now())) {
        try {
          if (await chatGPTInventory(tab.id, scope, checkpoint, projects)) {
            await chrome.storage.local.set({ chatGPTBackupDiscoveredAt: settings.chatGPTBackupRequestedAt || Date.now(), chatGPTInventoryRetryAt: 0 });
          }
        } catch (error) {
          if (error.status === 429 || error.status === 401 || error.status === 403) throw error;
          await chrome.storage.local.set({ chatGPTInventoryRetryAt: Date.now() + (error.retrySeconds || 60) * 1000 });
          await chatGPTBackupProgress(`Inventory refresh deferred: ${error.message} Previously queued downloads remain eligible.`);
        }
        ({ checkpoint } = await chatGPTArchive(`checkpoint?scope=${encodeURIComponent(scope)}`));
      }
      if (!checkpoint?.identity) return;
      if (settings.chatGPTBackupRetryAt > Date.now() || !await chatGPTBackupActive(scope)) return;
      await chatGPTReadPage(tab.id, checkpoint.identity, "identity");
      // Reuse the owned tab and authenticated session across sequential jobs.
      // Bound each batch so alarms can recover suspension and inventory can run.
      const deadline = Date.now() + 60000;
      for (let conversation = 0; conversation < 10 && Date.now() < deadline; conversation++) {
        if (!await chatGPTBackupActive(scope)) break;
        const { job } = await chatGPTArchive("claim", { scope });
        if (!job) { await chatGPTBackupCounts(scope); await chatGPTBackupProgress("Idle: inventory finished; no conversation download is ready. Retries remain scheduled."); return; }
        let progress;
        try {
          progress = await chatGPTArchive("pages", { scope, ...job });
          if (progress.pages > 0) {
            const { data } = await chatGPTReadPage(tab.id, checkpoint.identity, "conversation", job.id, "", job.project_id);
            const { matches } = await chatGPTArchive("verify", { scope, ...job, page: data });
            if (!matches) throw Object.assign(new Error("Conversation changed since its saved first page; starting a new version."), { restart: true });
          }
          for (let page = 0; !progress.complete && page < 10 && Date.now() < deadline; page++) {
            if (!await chatGPTBackupActive(scope)) throw new Error("Backup paused; downloaded pages retained.");
            await chatGPTBackupProgress(`Downloading ${job.title}: ${progress.pages} pages already saved. Fetching the next page…`);
            const { data } = await chatGPTReadPage(tab.id, checkpoint.identity, "conversation", job.id, progress.cursor, job.project_id);
            await chatGPTArchive("page", { scope, ...job, cursor: progress.cursor, page: data });
            progress = await chatGPTArchive("pages", { scope, ...job });
          }
          if (progress.complete) {
            await chatGPTArchive("complete", { scope, ...job });
            await chrome.storage.local.set({ chatGPTBackupSavedAt: Date.now() });
            await chatGPTBackupProgress(`Saved ${job.title}: ${progress.pages} pages assembled. Continuing with the next queued conversation.`);
          } else {
            await chatGPTArchive("yield", { scope, ...job });
            await chatGPTBackupProgress(`Checkpoint saved for ${job.title}: ${progress.pages} pages retained; next batch resumes its next page.`);
            break;
          }
        } catch (error) {
          if (error.status === 429) await chatGPTBackupRateLimit(error);
          await chatGPTArchive(error.restart || (error.status === 400 && progress?.cursor) ? "restart" : "fail", { scope, ...job, error: error.message || String(error), retry_seconds: error.retrySeconds });
          await chatGPTBackupProgress(`Waiting to retry ${job.title}: ${error.message || String(error)} Downloaded pages retained.`);
          if (error.status === 429 || error.status === 401 || error.status === 403) break;
        }
      }
      await chatGPTBackupCounts(scope);
    } catch (error) {
      if (error.status === 429) await chatGPTBackupRateLimit(error);
      await chatGPTBackupProgress(`Backup access paused: ${error.message || String(error)}`);
    } finally {
      if (tab) { await chrome.storage.session.remove("chatGPTBackupTabId"); try { await chrome.tabs.remove(tab.id); } catch { /* Already closed. */ } }
    }
  });
}

async function chatGPTArchive(action, body) {
  const { archiveConnectionPort = 8766 } = await chrome.storage.local.get("archiveConnectionPort");
  if (!Number.isInteger(archiveConnectionPort) || archiveConnectionPort < 1 || archiveConnectionPort > 65535) throw new Error("Invalid local archive port.");
  const response = await fetch(`http://127.0.0.1:${archiveConnectionPort}/api/v1/chatgpt/${action}`, {
    ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000), cache: "no-store"
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result?.error || `Archive returned ${response.status}`);
  if (!result || typeof result !== "object") throw new Error("Local archive returned an empty or invalid response.");
  return result;
}

async function chatGPTBackupProgress(message) {
  const { chatGPTBackupLog = "", chatGPTBackupScope } = await chrome.storage.local.get(["chatGPTBackupLog", "chatGPTBackupScope"]);
  const line = `${new Date().toISOString()} ${message}`;
  await chrome.storage.local.set({ chatGPTBackupProgress: message, chatGPTBackupUpdatedAt: Date.now(), chatGPTBackupLog: [...chatGPTBackupLog.split("\n"), line].slice(-200).join("\n") });
  if (chatGPTBackupScope) {
    try { await chatGPTArchive("event", { scope: chatGPTBackupScope, error: message }); } catch { /* Local diagnostic history remains available if the service is down. */ }
  }
}

async function chatGPTBackupCounts(scope) {
  const status = await chatGPTArchive(`status?scope=${encodeURIComponent(scope)}`);
  const saved = status.conversations.filter(item => item.saved_at).length;
  let first = 0, refresh = 0, fetching = 0, retry = 0;
  for (const item of status.conversations) {
    if (item.generation <= item.saved_generation) continue;
    if (item.lease_until > Date.now() / 1000) fetching++;
    else if (item.error) retry++;
    else if (item.saved_at) refresh++;
    else first++;
  }
  const unsuccessful = status.conversations.filter(item => item.error);
  const errors = unsuccessful.slice(0, 3).map(item => `${item.title}: ${item.error}`).join("\n");
  await chrome.storage.local.set({ chatGPTBackupSummary: `${status.conversations.length} known · ${saved} have backups · ${status.conversations.length - saved} have no backup.\nQueue: ${first} first backups · ${refresh} refreshes · ${fetching} fetching · ${retry} awaiting retry.\nInventory: ${status.inventory_complete ? "reported lists complete" : status.inventory_completed_at > 0 ? "refresh pending; existing queue continues" : "incomplete; discovered conversations can download"}. Destination: ${status.root}${errors ? `\nLast unsuccessful attempts:\n${errors}${unsuccessful.length > 3 ? `\nAnd ${unsuccessful.length - 3} more.` : ""}` : ""}` });
}

async function chatGPTBackupActive(scope) {
  const settings = await chrome.storage.local.get(["chatGPTBackupEnabled", "chatGPTBackupScope"]);
  return settings.chatGPTBackupEnabled && settings.chatGPTBackupScope === scope;
}

function handleChatGPTBackup(message, sender, sendResponse) {
  if (sender.url !== chrome.runtime.getURL("popup.html")) { sendResponse({ ok: false, error: "Use the backup controls." }); return; }
  (async () => {
    if (message.action === "pause") {
      await chrome.storage.local.set({ chatGPTBackupEnabled: false });
      await chrome.alarms.clear("chatgpt-backup");
      await chatGPTBackupProgress("Paused. Saved snapshots and queued conversations are retained.");
    } else {
      if (message.action !== "sync") throw new Error("Unknown backup action.");
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(message.scope || "")) throw new Error("Enter an account/workspace label using letters, numbers, hyphens, or underscores.");
      const current = await chrome.storage.local.get(["chatGPTBackupScope", "chatGPTBackupEnabled"]);
      if (current.chatGPTBackupEnabled && current.chatGPTBackupScope !== message.scope) throw new Error("Pause backup before changing the account/workspace label.");
      if (current.chatGPTBackupScope !== message.scope) await chrome.storage.local.set({ chatGPTBackupSummary: "", chatGPTBackupSavedAt: null, chatGPTBackupFullDiscoveryAt: null, chatGPTInventoryRetryAt: 0 });
      await chrome.storage.local.set({ chatGPTBackupScope: message.scope, chatGPTBackupEnabled: true, chatGPTBackupRequestedAt: Date.now() });
      await chrome.alarms.create("chatgpt-backup", { periodInMinutes: 0.5 });
      // The work continues after returning to the panel or switching tabs.
      chatGPTBackupRun(true).catch(error => chatGPTBackupProgress(error.message || String(error)));
    }
    sendResponse({ ok: true });
  })().catch(error => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
}
async function chatGPTBackupAutoRequest(tab) {
  const settings = await chrome.storage.local.get(["chatGPTBackupEnabled", "chatGPTBackupRequestedAt", "chatGPTBackupDiscoveredAt"]);
  if (!settings.chatGPTBackupEnabled) return false;
  const { chatGPTBackupTabId } = await chrome.storage.session.get("chatGPTBackupTabId");
  const tabs = tab ? [tab] : await chrome.tabs.query({ url: "https://chatgpt.com/*" });
  if (!tabs.some(item => item.id !== chatGPTBackupTabId && item.url?.startsWith("https://chatgpt.com/"))) return false;
  // Persist the request before attempting the lock so a busy/suspended worker
  // leaves it for the next alarm. Coalesce navigation and periodic checks.
  if (Date.now() - Math.max(settings.chatGPTBackupRequestedAt || 0, settings.chatGPTBackupDiscoveredAt || 0) < 5 * 60 * 1000) return false;
  await chrome.storage.local.set({ chatGPTBackupRequestedAt: Date.now() });
  return true;
}

chrome.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  if (!change.url && change.status !== "complete") return;
  try {
    if (await chatGPTBackupAutoRequest(tab)) await chatGPTBackupRun();
  } catch (error) { await chatGPTBackupProgress(`Backup paused/retrying: ${error.message || String(error)}`); }
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== "chatgpt-backup") return;
  try {
    await chatGPTBackupAutoRequest();
    await chatGPTBackupRun();
  } catch (error) { await chatGPTBackupProgress(`Backup paused/retrying: ${error.message || String(error)}`); }
});
