// Authenticated reads stay in the owned ChatGPT page. Tokens never leave it.
async function chatGPTRead(kind, id = "", cursor = "", project = "") {
  try {
    if (location.origin !== "https://chatgpt.com") throw new Error("Waiting for the owned ChatGPT tab to load.");
    const get = async (path, headers = {}) => {
      const response = await fetch(path, { headers, credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(20000) });
      if (!response.ok) {
        const error = new Error(`ChatGPT ${kind} returned HTTP ${response.status}${response.status === 401 || response.status === 403 ? "; check sign-in and workspace access" : ""}.`);
        error.status = response.status;
        error.retrySeconds = Math.min(3600, Math.max(60, Number(response.headers.get("Retry-After")) || 60));
        if (response.status === 429) error.message += ` Rate limited; automatic retry after ${error.retrySeconds} seconds.`;
        throw error;
      }
      return response.json();
    };
    const session = await get("/api/auth/session");
    if (!session.accessToken || !session.user?.id) throw new Error("ChatGPT session unavailable; sign in before resuming backup.");
    const headers = { Authorization: `Bearer ${session.accessToken}` };
    let workspace = decodeURIComponent(document.cookie.match(/(?:^|;\s*)_account=([^;]*)/)?.[1] || "");
    if (workspace.startsWith('"')) { const value = JSON.parse(workspace); if (typeof value === "string") workspace = value; }
    if (workspace) {
      const accounts = await get("/backend-api/accounts/check/v4-2023-04-27", headers);
      const available = Object.values(accounts.accounts || {}).map(entry => entry.account).filter(Boolean);
      const account = accounts.accounts?.[workspace]?.account || available.find(entry => entry.account_id === workspace)
        || (workspace === "personal" && accounts.accounts?.default?.account?.structure === "personal" ? accounts.accounts.default.account : null);
      if (!account || (!account.account_id && account.structure !== "personal")) {
        throw new Error(`Cannot verify the selected ChatGPT workspace (matching entry: ${Boolean(account)}; type: ${account?.structure || "unknown"}; accounts: ${available.length}; selector: ${workspace === "personal" || workspace === "default" ? workspace : /^[0-9a-f-]{36}$/i.test(workspace) ? "UUID" : `other(${workspace.length})`}; types: ${available.map(entry => entry.structure).join(",")}).`);
      }
      if (account.account_id) headers["Chatgpt-Account-Id"] = account.account_id;
    }
    const identity = `${session.user.id}:${workspace || "personal"}`;
    if (kind === "identity") return { identity };
    let path;
    if (kind === "projects") {
      path = `/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=0${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    } else if (kind === "list") {
      if (id.startsWith("g-p-") && /^[A-Za-z0-9_-]+$/.test(id)) {
        path = `/backend-api/gizmos/${id}/conversations?limit=50&owned_only=false${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      } else if (id === "recent" || id === "archived") {
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
    return { identity, data: await get(path, headers) };
  } catch (error) {
    return { error: error.message || String(error), status: error.status, retrySeconds: error.retrySeconds };
  }
}

async function chatGPTReadPage(tabId, identity, kind, id = "", cursor = "", project = "") {
  const [injection] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: chatGPTRead, args: [kind, id, cursor, project] });
  const result = injection?.result;
  if (result?.error) throw Object.assign(new Error(result.error), { status: result.status, retrySeconds: result.retrySeconds });
  if (!result?.identity) throw new Error("ChatGPT page returned no authenticated identity.");
  if (identity && identity !== result.identity) throw new Error("ChatGPT account/workspace changed. Use its own backup label.");
  return result;
}

// Each continuation is committed in the same SQLite transaction as its rows.
async function chatGPTInventory(tabId, scope, checkpoint, full = false) {
  const starting = !checkpoint || checkpoint.complete;
  const { identity } = await chatGPTReadPage(tabId, checkpoint?.identity, "identity");
  if (!checkpoint) checkpoint = { identity, complete: false, completedAt: 0, fullAt: 0, lists: [] };
  if (checkpoint.complete) {
    full ||= Date.now() - (checkpoint.fullAt || 0) >= 86400000;
    for (const list of checkpoint.lists) Object.assign(list, { cursor: "", done: false, max: 0, previous: null, ordered: true, count: 0 });
    checkpoint.complete = false;
  }
  if (!checkpoint.lists.length) checkpoint.lists = [
    { id: "projects", title: "Projects", cursor: "", done: false },
    ...["recent", "archived"].map(id => ({ id, title: id, cursor: "", done: false, baseline: false, watermark: 0, max: 0, previous: null, ordered: true, count: 0 }))
  ];
  // Persist the scan policy so suspension cannot turn reconciliation into an
  // incremental scan halfway through a list.
  if (starting) checkpoint.full = full || !checkpoint.completedAt;
  for (let step = 0; step < 20; step++) {
    if (!await chatGPTBackupActive(scope)) return false;
    const list = checkpoint.lists.find(item => !item.done);
    if (!list) {
      checkpoint.complete = true;
      checkpoint.completedAt = Date.now();
      if (checkpoint.full) checkpoint.fullAt = checkpoint.completedAt;
      checkpoint.full = false;
      await chatGPTArchive("discover", { scope, conversations: [], checkpoint });
      await chatGPTArchive("recheck", { scope });
      await chatGPTBackupCounts(scope);
      await chatGPTBackupProgress("Inventory complete for accessible project, recent, and archived lists. Starting conversation downloads, one at a time.");
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
    const head = items => JSON.stringify(items.map(item => list.id === "projects" ? item.gizmo?.gizmo : [item.id, item.title, item.update_time]));
    if (!list.cursor) list.head = head(data.items);
    const watermarkBeforePage = list.watermark;
    let conversations = [];
    let next = null;
    if (list.id === "projects") {
      for (const item of data.items) {
        const project = item.gizmo?.gizmo;
        if (!/^g-p-[A-Za-z0-9_-]+$/.test(project?.id || "") || typeof project.display?.name !== "string") throw new Error("Unsupported project inventory entry.");
        const existing = checkpoint.lists.find(value => value.id === project.id);
        if (existing) existing.title = project.display.name;
        else checkpoint.lists.push({ id: project.id, title: project.display.name, cursor: "", done: false, baseline: false, watermark: 0, max: 0, previous: null, ordered: true, count: 0 });
      }
      if (!("cursor" in data)) throw new Error("Project inventory lacks an explicit continuation cursor.");
      next = data.cursor;
    } else {
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
        const project = list.id.startsWith("g-p-") ? list.id : /^g-p-/.test(item.gizmo_id || "") ? item.gizmo_id : "";
        conversations.push({ id: item.id, title: item.title, project_id: project, project_title: project === list.id ? list.title : "", updated_at: valid ? new Date(updated).toISOString() : "" });
      }
      list.count = (list.count || 0) + data.items.length;
      if (list.id.startsWith("g-p-")) {
        if (!("cursor" in data)) throw new Error("Project conversation list lacks a continuation cursor.");
        next = data.cursor;
      } else {
        if (!Number.isInteger(data.total) || data.total < 0 || data.offset !== Number(list.cursor)) throw new Error("Conversation list lacks a reliable total/offset.");
        const offset = Number(list.cursor) + data.items.length;
        if (offset < data.total) {
          if (!data.items.length) throw new Error("Conversation inventory stopped before its reported total.");
          next = String(offset);
        }
      }
      // Early stop is enabled only after a full, update-ordered baseline for
      // this list. Pinned rows do not establish the stopping boundary.
      const stop = !checkpoint.full && list.baseline && list.orderVerified && list.ordered && last != null && last < list.watermark - 120000;
      if (stop) next = null;
      if (next == null) {
        if (!stop) { list.baseline = true; list.orderVerified = list.ordered; }
        list.watermark = Math.max(list.watermark || 0, list.max || 0);
      }
    }
    if (next != null && (String(next) === String(list.cursor) || !data.items.length)) throw new Error(`Pagination did not advance for ${list.title}.`);
    if (next == null) {
      const { data: first } = await chatGPTReadPage(tabId, identity, list.id === "projects" ? "projects" : "list", list.id, "");
      if (!Array.isArray(first?.items) || head(first.items) !== list.head) {
        Object.assign(list, { cursor: "", done: false, previous: null, count: 0, max: 0, ordered: true, baseline: false, watermark: watermarkBeforePage || 0 });
        await chatGPTArchive("discover", { scope, conversations, checkpoint });
        throw new Error(`${list.title} changed during enumeration; restarting that list from its saved inventory.`);
      }
    }
    list.done = next == null;
    list.cursor = next == null ? "" : String(next);
    await chatGPTArchive("discover", { scope, conversations, checkpoint });
    await chatGPTBackupProgress(`Inventory: ${list.title} · ${list.count || data.items.length} entries checked · ${list.done ? "list finished" : "page saved; more pages queued"}. Conversation downloads wait until inventory finishes.`);
  }
  await chatGPTBackupCounts(scope);
  await chatGPTBackupProgress("Inventory checkpoint saved. Next batch resumes its next page; conversation downloads have not started.");
  return false;
}

async function chatGPTBackupRun(discover = false) {
  await navigator.locks.request("chatgpt-backup", { ifAvailable: true }, async lock => {
    if (!lock) return;
    const settings = await chrome.storage.local.get(["chatGPTBackupScope", "chatGPTBackupEnabled", "chatGPTBackupRequestedAt", "chatGPTBackupDiscoveredAt", "chatGPTBackupRetryAt"]);
    const scope = settings.chatGPTBackupScope;
    if (!settings.chatGPTBackupEnabled || !/^[A-Za-z0-9_-]{1,128}$/.test(scope || "")) return;
    if (settings.chatGPTBackupRetryAt > Date.now()) return;
    if (!await chrome.permissions.contains({ origins: ["https://chatgpt.com/*"] })) return;
    const { chatGPTBackupTabId: orphan } = await chrome.storage.session.get("chatGPTBackupTabId");
    const sessions = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
    if (!sessions.some(tab => tab.id !== orphan)) { await chatGPTBackupProgress("Waiting: open ChatGPT in your signed-in browser."); return; }
    let tab;
    try {
      let { checkpoint } = await chatGPTArchive(`checkpoint?scope=${encodeURIComponent(scope)}`);
      // Only this module's complete structured baseline authorizes downloads.
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
      if (inventoryDue) {
        if (!await chatGPTInventory(tab.id, scope, checkpoint, discover)) return;
        await chrome.storage.local.set({ chatGPTBackupDiscoveredAt: settings.chatGPTBackupRequestedAt || Date.now() });
        ({ checkpoint } = await chatGPTArchive(`checkpoint?scope=${encodeURIComponent(scope)}`));
      }
      await chatGPTReadPage(tab.id, checkpoint.identity, "identity");
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
        for (let page = 0; !progress.complete && page < 10; page++) {
          if (!await chatGPTBackupActive(scope)) throw new Error("Backup paused; downloaded pages retained.");
          await chatGPTBackupProgress(`Downloading ${job.title}: ${progress.pages} pages already saved. Fetching the next page…`);
          const { data } = await chatGPTReadPage(tab.id, checkpoint.identity, "conversation", job.id, progress.cursor, job.project_id);
          await chatGPTArchive("page", { scope, ...job, cursor: progress.cursor, page: data });
          progress = await chatGPTArchive("pages", { scope, ...job });
        }
        if (progress.complete) {
          await chatGPTArchive("complete", { scope, ...job });
          await chrome.storage.local.set({ chatGPTBackupSavedAt: Date.now() });
          await chatGPTBackupProgress(`Saved ${job.title}: ${progress.pages} pages assembled. Next conversation starts in the next batch.`);
        } else {
          await chatGPTArchive("yield", { scope, ...job });
          await chatGPTBackupProgress(`Checkpoint saved for ${job.title}: ${progress.pages} pages retained; next batch resumes its next page.`);
        }
      } catch (error) {
        if (error.status === 429) await chrome.storage.local.set({ chatGPTBackupRetryAt: Date.now() + (error.retrySeconds || 60) * 1000 });
        await chatGPTArchive(error.restart || (error.status === 400 && progress?.cursor) ? "restart" : "fail", { scope, ...job, error: error.message || String(error), retry_seconds: error.retrySeconds });
        await chatGPTBackupProgress(`Waiting to retry ${job.title}: ${error.message || String(error)} Downloaded pages retained.`);
      }
      await chatGPTBackupCounts(scope);
    } catch (error) {
      if (error.status === 429) await chrome.storage.local.set({ chatGPTBackupRetryAt: Date.now() + (error.retrySeconds || 60) * 1000 });
      await chatGPTBackupProgress(`Inventory/access paused: ${error.message || String(error)} No conversation downloads start before inventory completes.`);
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
  await chrome.storage.local.set({ chatGPTBackupSummary: `${status.conversations.length} known · ${saved} have backups · ${status.conversations.length - saved} have no backup.\nQueue: ${first} first backups · ${refresh} refreshes · ${fetching} fetching · ${retry} awaiting retry.\nInventory: ${status.inventory_complete ? "reported lists complete" : "incomplete; downloads wait"}. Destination: ${status.root}${errors ? `\nLast unsuccessful attempts:\n${errors}${unsuccessful.length > 3 ? `\nAnd ${unsuccessful.length - 3} more.` : ""}` : ""}` });
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
      if (current.chatGPTBackupScope !== message.scope) await chrome.storage.local.set({ chatGPTBackupSummary: "", chatGPTBackupSavedAt: null, chatGPTBackupFullDiscoveryAt: null });
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
