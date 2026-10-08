const tabId = Number(new URLSearchParams(location.search).get("tabId"));
const startButton = document.querySelector("#start");
const stopButton = document.querySelector("#stop");
const statusOutput = document.querySelector("#recording-status");
let recorder;
let stream;
let capturePort;
let events = [];
let chunks = [];
let logBytes = 0;
let timer;
let startedAt;
let stopping = false;
let sourceTab;
let sourceInvalidated = false;
let session;
let captureStopped;
const urls = [];
const timestamp = () => performance.timeOrigin + performance.now();

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== "feed-capture" || port.sender?.tab?.id !== tabId || port.sender?.frameId !== 0 || !recorder || stopping || capturePort) return;
  capturePort = port;
  port.onMessage.addListener(event => {
    events.push({ ...event, receivedAt: timestamp() });
    if (event.type === "capture-end") captureStopped?.();
    logBytes += new Blob([JSON.stringify(event)]).size;
    if (logBytes > 50 * 1024 * 1024) stop("Page log reached the 50 MB experiment limit.");
  });
  port.onDisconnect.addListener(() => { capturePort = undefined; stop("Page capture disconnected."); });
});

function downloadLink(selector, blob, name) {
  const url = URL.createObjectURL(blob);
  urls.push(url);
  const link = document.querySelector(selector);
  link.href = url;
  link.download = name;
  link.hidden = false;
  return url;
}

async function stop(reason = "Stopped by user.") {
  if (!recorder || stopping) return;
  stopping = true;
  clearTimeout(timer);
  stopButton.disabled = true;
  statusOutput.textContent = "Finishing recording…";
  if (!capturePort && events.at(-1)?.type !== "capture-end") session.pageStopUnconfirmed = true;
  if (capturePort) {
    await new Promise(resolve => {
      const timeout = setTimeout(() => {
        session.pageStopUnconfirmed = true;
        resolve();
      }, 1500);
      captureStopped = () => { clearTimeout(timeout); resolve(); };
      try { capturePort.postMessage({ type: "stop" }); }
      catch { captureStopped(); session.pageStopUnconfirmed = true; }
    });
  }
  session.stopRequestedAt = timestamp();
  session.stopReason = reason;
  if (recorder.state !== "inactive") recorder.stop();
  else finish();
}

function finish() {
  stream?.getTracks().forEach(track => track.stop());
  const endedAt = timestamp();
  const basename = `feed-capture-${new Date(startedAt).toISOString().replace(/[:.]/g, "-")}`;
  const video = new Blob(chunks, { type: recorder.mimeType || "video/webm" });
  const url = downloadLink("#video-download", video, `${basename}.webm`);
  downloadLink("#events-download", new Blob([JSON.stringify({ ...session, endedAt, videoBytes: video.size, events })], { type: "application/json" }), `${basename}.json`);
  const preview = document.querySelector("#preview");
  preview.src = url;
  preview.hidden = false;
  statusOutput.textContent = `${session.stopReason || "Recording ended."} ${events.length} records; ${(video.size / 1048576).toFixed(1)} MB video. Save both files before closing this window.`;
}

startButton.addEventListener("click", async () => {
  startButton.disabled = true;
  try {
    const origin = `${new URL(sourceTab.url).origin}/*`;
    if (!await chrome.permissions.request({ origins: [origin] })) throw new Error("Page access was declined.");
    if (sourceInvalidated || (await chrome.tabs.get(tabId)).url !== sourceTab.url) throw new Error("Source changed. Reopen the recorder on the intended feed.");
    if ((await chrome.tabCapture.getCapturedTabs()).some(tab => tab.tabId === tabId && ["active", "pending"].includes(tab.status))) throw new Error("This tab is already being recorded.");
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId, maxFrameRate: 30 } } });
    await stream.getVideoTracks()[0].applyConstraints({ frameRate: { ideal: 30, max: 30 } });
    if (sourceInvalidated || (await chrome.tabs.get(tabId)).url !== sourceTab.url) throw new Error("Source changed while starting. Reopen the recorder.");
    const mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error("WebM recording is unavailable.");
    recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 12000000 });
    session = { version: "feed-capture.v1", source: { tabId, url: sourceTab.url, title: sourceTab.title }, requestedFrameRate: 30, trackSettings: stream.getVideoTracks()[0].getSettings(), clock: "Unix epoch milliseconds using performance.timeOrigin + performance.now(); DOM and video are approximate, not atomic", scope: "top-frame DOM; no closed shadow roots or iframe DOM; no audio or keyboard listeners" };
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = finish;
    recorder.onerror = event => stop(`Video error: ${event.error?.message || "unknown"}`);
    stream.getVideoTracks()[0].addEventListener("ended", () => stop("Tab video ended."));
    recorder.start(1000);
    startedAt = timestamp();
    session.videoStartRequestedAt = startedAt;
    recorder.addEventListener("start", () => { session.videoStartedAt = timestamp(); });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["feed-capture.js"] });
    if (!capturePort) throw new Error("Page event recorder did not connect.");
    timer = setTimeout(() => stop("Two-minute experiment limit reached."), 120000);
    stopButton.disabled = false;
    statusOutput.textContent = "Recording, targeting 30 fps. Scroll the source tab; stop here when finished. Keep this window open.";
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(sourceTab.windowId, { focused: true });
  } catch (error) {
    if (recorder) await stop(`Capture failed: ${error.message}`);
    else {
      stream?.getTracks().forEach(track => track.stop());
      statusOutput.textContent = `Could not start: ${error.message}. Open the toolbar extension on the source tab and try again.`;
      startButton.disabled = sourceInvalidated;
    }
  }
});
stopButton.addEventListener("click", () => stop());
function invalidateSource(reason) {
  sourceInvalidated = true;
  startButton.disabled = true;
  if (recorder) stop(reason);
  else statusOutput.textContent = `${reason} Reopen the recorder on the intended feed.`;
}
chrome.tabs.onRemoved.addListener(id => { if (id === tabId) invalidateSource("Source tab closed."); });
chrome.tabs.onUpdated.addListener((id, change) => {
  if (id === tabId && (change.status === "loading" || (change.url && sourceTab && change.url !== sourceTab.url))) invalidateSource("Source tab navigated.");
});
window.addEventListener("beforeunload", event => {
  if (!recorder) return;
  event.preventDefault();
  event.returnValue = "";
});
window.addEventListener("pagehide", () => { capturePort?.disconnect(); stream?.getTracks().forEach(track => track.stop()); urls.forEach(url => URL.revokeObjectURL(url)); });
(async () => {
  try {
    sourceTab = await chrome.tabs.get(tabId);
    if (!/^https?:/.test(sourceTab.url || "")) throw new Error("Choose an HTTP or HTTPS source tab.");
    document.querySelector("#source").textContent = `${sourceTab.title || "Source"}: ${sourceTab.url}`;
    statusOutput.textContent = "Ready. Start grants access to the source site and records only this tab.";
    startButton.disabled = sourceInvalidated;
  } catch (error) { statusOutput.textContent = error.message; }
})();
