chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "download") return undefined;

  (async () => {
    const url = `data:${message.mimeType};charset=utf-8,${encodeURIComponent(message.content)}`;
    const downloadId = await chrome.downloads.download({
      url,
      filename: message.filename,
      saveAs: true
    });
    sendResponse({ ok: true, downloadId });
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

async function pauseCollectionForTab(tabId, newUrl = "") {
  const { collectionState } = await chrome.storage.local.get("collectionState");
  if (collectionState?.status !== "running" || collectionState.tabId !== tabId) return;
  if (newUrl) {
    const url = new URL(newUrl);
    if (`${url.origin}${url.pathname}` === collectionState.editionUrl) return;
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
  if (!changeInfo.url) return;
  try {
    await pauseCollectionForTab(tabId, changeInfo.url);
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
