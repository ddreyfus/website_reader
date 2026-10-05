import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("local MCP discovers and calls hello over stdio", { timeout: 10000 }, async () => {
  const client = new Client({ name: "website-reader-smoke-test", version: "0.1.0" });
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../scripts/mcp-hello.mjs", import.meta.url))],
    }));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name), ["hello"]);
    assert.equal(tools[0].annotations.readOnlyHint, true);
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
