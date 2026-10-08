(() => {
  if (globalThis.websiteReaderFeedCapture) throw new Error("Feed capture is already active.");
  const port = chrome.runtime.connect({ name: "feed-capture" });
  let sequence = 0;
  let lastSnapshot = 0;
  let snapshotTimer;
  let stopped = false;
  const listeners = [];
  const timestamp = () => performance.timeOrigin + performance.now();
  function send(type, data = {}) {
    if (!stopped) {
      try { port.postMessage({ sequence: sequence++, time: timestamp(), type, url: location.href, ...data }); }
      catch { /* Recorder window closed; disconnect listener performs cleanup. */ }
    }
  }
  const ids = new WeakMap();
  let nextId = 1;
  function id(node) {
    if (!ids.has(node)) ids.set(node, nextId++);
    return ids.get(node);
  }
  function serialize(node) {
    if (node.nodeType === Node.ELEMENT_NODE) return { id: id(node), html: node.outerHTML, nodes: nodeMap(node) };
    return { id: id(node), nodeType: node.nodeType, text: node.textContent };
  }
  function nodeMap(root) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
    let node = root;
    do {
      nodes.push({ id: id(node), parentId: node.parentNode ? id(node.parentNode) : null, nodeType: node.nodeType, childIndex: node.parentNode ? Array.prototype.indexOf.call(node.parentNode.childNodes, node) : 0 });
    } while ((node = walker.nextNode()));
    return nodes;
  }
  function snapshot(reason) {
    clearTimeout(snapshotTimer);
    snapshotTimer = undefined;
    lastSnapshot = performance.now();
    const startedAt = timestamp();
    const text = [];
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent.trim() || node.parentElement?.closest("script,style,noscript")) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth);
      if (!rects.length || !node.parentElement.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      text.push({ id: id(node), parentId: id(node.parentNode), text: node.textContent, rects: rects.map(r => ({ x: r.x, y: r.y, width: r.width, height: r.height })) });
    }
    send("snapshot", { reason, startedAt, viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY, devicePixelRatio }, text });
  }
  function scheduleSnapshot(reason) {
    if (snapshotTimer === undefined) snapshotTimer = setTimeout(() => snapshot(reason), Math.max(0, 500 - (performance.now() - lastSnapshot)));
  }
  function listen(target, type, listener) {
    target.addEventListener(type, listener, { capture: true, passive: true });
    listeners.push(() => target.removeEventListener(type, listener, true));
  }
  const observer = new MutationObserver(records => {
    send("mutations", { records: records.map(record => ({
      type: record.type, target: id(record.target), parentId: record.target.parentNode ? id(record.target.parentNode) : null,
      attributeName: record.attributeName, oldValue: record.oldValue,
      previousSibling: record.previousSibling ? id(record.previousSibling) : null, nextSibling: record.nextSibling ? id(record.nextSibling) : null,
      value: record.type === "attributes" ? record.target.getAttribute(record.attributeName) : record.type === "characterData" ? record.target.textContent : undefined,
      added: Array.from(record.addedNodes, serialize), removed: Array.from(record.removedNodes, serialize)
    })) });
    scheduleSnapshot("mutation");
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, characterDataOldValue: true, attributes: true, attributeOldValue: true });
  listen(document, "scroll", event => {
    const target = event.target === document ? document.scrollingElement : event.target;
    send("scroll", { target: target ? id(target) : null, x: target?.scrollLeft || 0, y: target?.scrollTop || 0 });
    scheduleSnapshot("scroll");
  });
  listen(window, "resize", () => { send("resize", { width: innerWidth, height: innerHeight }); scheduleSnapshot("resize"); });
  listen(document, "click", event => {
    send("click", { target: id(event.target), x: event.clientX, y: event.clientY, tag: event.target.tagName });
    scheduleSnapshot("click");
  });
  listen(document, "visibilitychange", () => send("visibility", { state: document.visibilityState }));
  listen(window, "pagehide", () => { send("pagehide"); stop(); });
  listen(window, "popstate", () => { send("navigation"); scheduleSnapshot("navigation"); });
  listen(window, "hashchange", () => { send("navigation"); scheduleSnapshot("navigation"); });
  function stop() {
    if (stopped) return;
    const remaining = observer.takeRecords();
    if (remaining.length) send("final-dom", { html: document.documentElement.outerHTML });
    snapshot("stop");
    send("capture-end");
    stopped = true;
    observer.disconnect();
    clearTimeout(snapshotTimer);
    listeners.forEach(remove => remove());
    delete globalThis.websiteReaderFeedCapture;
    port.disconnect();
  }
  globalThis.websiteReaderFeedCapture = { stop };
  port.onDisconnect.addListener(stop);
  port.onMessage.addListener(message => { if (message.type === "stop") stop(); });
  send("initial-dom", { html: document.documentElement.outerHTML, title: document.title, baseURI: document.baseURI, nodes: nodeMap(document.documentElement) });
  snapshot("start");
})();
