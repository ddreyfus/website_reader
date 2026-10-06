import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("local MCP discovers and calls hello over stdio", { timeout: 10000 }, async () => {
  const client = new Client({ name: "website-reader-smoke-test", version: "0.1.0" });
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../scripts/mcp-hello.mjs", import.meta.url))],
    }));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), ["hello", "list_corpora", "read_document", "search_archive"]);
    assert.ok(tools.every(tool => tool.annotations.readOnlyHint));
    const challenge = crypto.randomUUID();
    const started = Date.now();
    const result = await client.callTool({ name: "hello", arguments: { challenge } });
    assert.ok(!result.isError);
    const response = JSON.parse(result.content[0].text);
    assert.equal(response.message, "Hello from the local Website Reader MCP server!");
    assert.equal(response.challenge, challenge);
    assert.ok(Date.parse(response.time) >= started);
    assert.ok(Date.parse(response.time) <= Date.now());
  } finally {
    await client.close();
  }
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
    } else if (request.url === "/api/v1/archive/search") {
      response.end(JSON.stringify({ results: [{ document_id: "doc", text: "matching passage", url: "/file/doc?line=7" }] }));
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
      args: [fileURLToPath(new URL("../scripts/mcp-hello.mjs", import.meta.url))],
      env: { ...process.env, LOCAL_MCP_CONFIG: config },
    }));
    const call = async (name, args) => {
      const response = await client.callTool({ name, arguments: args });
      assert.ok(!response.isError, response.content[0].text);
      return JSON.parse(response.content[0].text);
    };
    assert.equal((await call("list_corpora", {})).corpora[1].parent_id, "parent");
    await call("search_archive", { query: "default count" });
    assert.equal(requests.at(-1).body.limit, 7);
    const search = await call("search_archive", { query: "repeated idea", corpus_ids: ["child"], limit: 2 });
    assert.deepEqual(requests.at(-1).body, { query: "repeated idea", corpus_ids: ["child"], limit: 2 });
    assert.equal(search.results[0].url, `http://127.0.0.1:${backend.address().port}/file/doc?line=7`);
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
