import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

test("local MCP discovers and calls hello over stdio", { timeout: 10000 }, async () => {
  const client = new Client({ name: "website-reader-smoke-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../scripts/mcp-archive.mjs", import.meta.url))],
    stderr: "pipe",
  });
  let logs = "";
  const challenge = crypto.randomUUID();
  transport.stderr.on("data", chunk => { logs += chunk; });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), ["hello", "list_articles", "list_corpora", "list_documents", "read_document", "search_archive"]);
    assert.ok(tools.every(tool => tool.annotations.readOnlyHint));
    const started = Date.now();
    const result = await client.callTool({ name: "hello", arguments: { challenge } });
    assert.ok(!result.isError);
    const response = JSON.parse(result.content[0].text);
    assert.equal(response.message, "Hello from the local Website Reader MCP server!");
    assert.equal(response.challenge, challenge);
    assert.ok(Date.parse(response.time) >= started);
    assert.ok(Date.parse(response.time) <= Date.now());
    assert.equal((await client.callTool({ name: "missing-tool", arguments: {} })).isError, true);
    await assert.rejects(client.request({ method: "missing-method" }, z.any()));
  } finally {
    await client.close();
  }
  const events = logs.trim().split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
  assert.ok(events.some(event => event.method === "initialize" && event.event === "receive"));
  assert.ok(events.some(event => event.method === "notifications/initialized" && event.initialization === "initialized_notification_received"));
  const received = events.find(event => event.event === "receive" && event.tool === "hello");
  const sent = events.find(event => event.event === "response" && event.request_id === received.request_id);
  assert.equal(sent.outcome, "ok");
  assert.ok(sent.duration_ms >= 0);
  assert.ok(events.some(event => event.outcome === "rpc_error" && typeof event.error_code === "number"));
  assert.ok(events.some(event => event.outcome === "tool_error"));
  assert.ok(!logs.includes(challenge));
});

test("archive MCP discovers corpora, forwards scopes, reads context, and reports errors", { timeout: 15000 }, async () => {
  const requests = [];
  const backend = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ url: request.url, body: body ? JSON.parse(body) : null });
    response.setHeader("Content-Type", "application/json");
    if (request.url.startsWith("/api/v1/corpora")) {
      response.end(JSON.stringify({ corpora: [{ id: "parent", parent_id: null }, { id: "child", parent_id: "parent" }] }));
    } else if (request.url.startsWith("/api/v1/documents?")) {
      response.end(JSON.stringify({ documents: [{ document_id: "doc", url: "/file/doc" }], total: 2, next_offset: 1 }));
    } else if (request.url.startsWith("/api/v1/documents/doc/articles?")) {
      response.end(JSON.stringify({ articles: [{ title: "Article", kind: "article", line_start: 7, url: "/file/doc?line=7" }], total: 1, next_offset: null }));
    } else if (request.url === "/api/v1/archive/search") {
      response.end(JSON.stringify({ results: [{ document_id: "doc", text: "matching passage", url: "/file/doc?line=7" }], semantic_status: "partial", semantic_indexed_passages: 12 }));
    } else if (request.url.startsWith("/api/v1/documents/doc?")) {
      response.end(JSON.stringify({ text: "bounded context", truncated: true, next_offset: 256, url: "/file/doc" }));
    } else {
      response.writeHead(404); response.end(JSON.stringify({ errors: [{ detail: "document is not indexed" }] }));
    }
  });
  await new Promise(resolve => backend.listen(0, "127.0.0.1", resolve));
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "archive-mcp-"));
  const config = path.join(temporary, "config.json");
  await fs.writeFile(config, JSON.stringify({ port: backend.address().port, search_limit: 7 }));
  const client = new Client({ name: "archive-test", version: "0.1.0" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL("../scripts/mcp-archive.mjs", import.meta.url))],
      env: { ...process.env, LOCAL_MCP_CONFIG: config },
    }));
    const call = async (name, args) => {
      const response = await client.callTool({ name, arguments: args });
      assert.ok(!response.isError, response.content[0].text);
      return JSON.parse(response.content[0].text);
    };
    assert.equal((await call("list_corpora", {})).corpora[1].parent_id, "parent");
    const documents = await call("list_documents", { corpus_id: "child", path_contains: "Economist", offset: 1, limit: 2 });
    assert.equal(documents.next_offset, 1);
    assert.equal(documents.documents[0].url, `http://127.0.0.1:${backend.address().port}/file/doc`);
    assert.match(requests.at(-1).url, /corpus_id=child/);
    assert.match(requests.at(-1).url, /path_contains=Economist/);
    assert.match(requests.at(-1).url, /offset=1/);
    const articles = await call("list_articles", { document_id: "doc", limit: 1 });
    assert.equal(articles.articles[0].line_start, 7);
    assert.equal(articles.articles[0].url, `http://127.0.0.1:${backend.address().port}/file/doc?line=7`);
    await call("search_archive", { query: "default count" });
    assert.equal(requests.at(-1).body.limit, 7);
    const search = await call("search_archive", { query: "repeated idea", corpus_ids: ["child"], limit: 2 });
    assert.deepEqual(requests.at(-1).body, { query: "repeated idea", corpus_ids: ["child"], limit: 2 });
    assert.equal(search.results[0].url, `http://127.0.0.1:${backend.address().port}/file/doc?line=7`);
    assert.equal(search.semantic_status, "partial");
    assert.equal(search.semantic_indexed_passages, 12);
    assert.equal((await call("read_document", { document_id: "doc", line: 7, limit: 256 })).next_offset, 256);
    assert.match(requests.at(-1).url, /line=7/);
    await call("read_document", { document_id: "doc", offset: 256, limit: 256 });
    assert.match(requests.at(-1).url, /offset=256/);
    const failed = await client.callTool({ name: "read_document", arguments: { document_id: "missing" } });
    assert.equal(failed.isError, true); assert.match(failed.content[0].text, /not indexed/);
    const before = requests.length;
    assert.equal((await client.callTool({ name: "read_document", arguments: { document_id: "doc", offset: 0, line: 1 } })).isError, true);
    assert.equal(requests.length, before);
  } finally {
    await client.close();
    await new Promise(resolve => backend.close(resolve));
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("MCP stress: 1000 concurrent reads, repeated initialization, and overlapping IDs", { timeout: 60000 }, async t => {
  let active = 0;
  let peak = 0;
  const backend = http.createServer((request, response) => {
    active++;
    peak = Math.max(peak, active);
    const document = decodeURIComponent(new URL(request.url, "http://localhost").pathname.split("/").at(-1));
    // Variable latency makes response order differ from request order.
    setTimeout(() => {
      active--;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ text: document }));
    }, 100 + (Number(document.split("-").at(-1)) % 7) * 10);
  });
  await new Promise(resolve => backend.listen(0, "127.0.0.1", resolve));
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "archive-mcp-stress-"));
  const config = path.join(temporary, "config.json");
  await fs.writeFile(config, JSON.stringify({ port: backend.address().port }));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL("../scripts/mcp-archive.mjs", import.meta.url))],
    env: { ...process.env, LOCAL_MCP_CONFIG: config }, stderr: "pipe",
  });
  let logs = "";
  transport.stderr.on("data", chunk => { logs += chunk; });
  const responses = [];
  let complete;
  let reject;
  transport.onmessage = message => {
    responses.push(message);
    complete?.();
  };
  transport.onerror = error => reject?.(error);
  const initialize = id => ({ jsonrpc: "2.0", id, method: "initialize", params: {
    protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "stress-test", version: "1" },
  } });
  const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
  const wave = async (messages, expected) => {
    responses.length = 0;
    let timer;
    const finished = new Promise((resolve, fail) => {
      reject = fail;
      complete = () => { if (responses.length === expected) resolve(); };
      timer = setTimeout(() => fail(new Error(`Received ${responses.length}/${expected} responses`)), 20000);
    });
    try {
      await Promise.all(messages.map(message => transport.send(message)));
      await finished;
    } finally {
      clearTimeout(timer);
      complete = undefined;
    }
    assert.ok(responses.every(message => !message.error && !message.result?.isError));
  };
  try {
    await transport.start();
    await wave([initialize(0)], 1);
    await transport.send(initialized);
    await wave(Array.from({ length: 1000 }, (_, index) => ({ jsonrpc: "2.0", id: index + 1,
      method: "tools/call", params: { name: "read_document", arguments: { document_id: `unique-${index}` } },
    })), 1000);
    for (const response of responses) {
      assert.equal(JSON.parse(response.result.content[0].text).text, `unique-${response.id - 1}`);
    }
    assert.ok(peak >= 100, `Expected at least 100 overlapping backend requests, observed ${peak}`);
    // Deliberately model sessions multiplexed without request-ID remapping.
    // This is an adversarial input, not a valid single-session ID strategy.
    const messages = Array.from({ length: 100 }, (_, index) => [initialize(0), initialized,
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_document", arguments: { document_id: `duplicate-${index}` } } },
    ]).flat();
    await wave(messages, 200);
    const documents = responses.filter(response => response.result?.content).map(response => JSON.parse(response.result.content[0].text).text);
    assert.equal(new Set(documents).size, 100);
    assert.deepEqual(documents.sort(), Array.from({ length: 100 }, (_, index) => `duplicate-${index}`).sort());
    await wave([{ jsonrpc: "2.0", id: 2000, method: "tools/call", params: { name: "hello", arguments: {} } }], 1);
  } finally {
    await transport.close();
    await new Promise(resolve => backend.close(resolve));
    await fs.rm(temporary, { recursive: true, force: true });
  }
  const events = logs.trim().split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
  const reads = events.filter(event => event.event === "receive" && event.tool === "read_document");
  const replies = events.filter(event => event.event === "response" && event.tool === "read_document");
  assert.equal(reads.length, 1100);
  assert.equal(replies.length, reads.length, "Every concurrent read must have a response log");
  const byCall = new Map(replies.map(event => [event.call_id, event]));
  assert.equal(byCall.size, reads.length);
  for (const received of reads) {
    const response = byCall.get(received.call_id);
    assert.equal(response.request_id, received.request_id);
    assert.equal(response.outcome, "ok");
    assert.ok(response.duration_ms >= 0);
  }
  const backendReplies = events.filter(event => event.event === "archive_response");
  assert.equal(backendReplies.length, reads.length);
  assert.ok(backendReplies.every(event => byCall.has(event.call_id) && event.status === 200));
  t.diagnostic(`1100 reads verified; peak overlapping backend requests: ${peak}`);
});
