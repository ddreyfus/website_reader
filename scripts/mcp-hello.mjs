import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "website-reader-local", version: "0.1.0" });

server.registerTool("hello", {
  description: "Verify the connection to the local Website Reader MCP server. Echo an optional challenge to prove this is a live tool call.",
  inputSchema: { challenge: z.string().max(200).optional() },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async ({ challenge }) => ({
  content: [{ type: "text", text: JSON.stringify({
    message: "Hello from the local Website Reader MCP server!",
    ...(challenge === undefined ? {} : { challenge }),
    time: new Date().toISOString(),
  }) }],
}));

await server.connect(new StdioServerTransport());
