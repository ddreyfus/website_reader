import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");

test("MCP commands use launchd, distinguish readiness, and respect deliberate stops", { skip: process.platform !== "darwin" }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "reader-tunnel-test-"));
  let ready = true;
  let probes = 0;
  const server = http.createServer((request, response) => {
    probes++;
    response.writeHead(request.url === "/readyz" && !ready ? 503 : 200);
    response.end("ok");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    for (const dir of ["scripts", "bin", ".local-mcp/bin", "Library/LaunchAgents"]) await fs.mkdir(path.join(temp, dir), { recursive: true });
    await fs.copyFile(path.join(root, "scripts/mcp-runtime.mjs"), path.join(temp, "scripts/mcp-runtime.mjs"));
    await fs.symlink(path.join(root, "node_modules"), path.join(temp, "node_modules"), "dir");
    await fs.writeFile(path.join(temp, "Library/LaunchAgents/com.website-reader.tunnel.plist"), "fixture");
    await fs.writeFile(path.join(temp, ".local-mcp/tunnel-health.url"), `http://127.0.0.1:${server.address().port}`);
    await fs.writeFile(path.join(temp, ".local-mcp/bin/tunnel-client"), "#!/bin/sh\necho detached-runtime\n", { mode: 0o755 });
    await fs.writeFile(path.join(temp, "bin/launchctl"), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(process.env.HOME, 'running');
const action = process.argv[2];
fs.appendFileSync(path.join(process.env.HOME, 'calls'), action + '\\n');
if (action === 'print') {
  if (!fs.existsSync(file)) process.exit(1);
  console.log('fixture = {\\n state = running\\n pid = 1234\\n}');
} else if (action === 'bootstrap') fs.writeFileSync(file, 'running');
else if (action === 'bootout') fs.unlinkSync(file);
`, { mode: 0o755 });
    const env = { ...process.env, HOME: temp, PATH: `${path.join(temp, "bin")}:${process.env.PATH}` };
    const run = async action => (await exec(process.execPath, [path.join(temp, "scripts/mcp-runtime.mjs"), action], { env })).stdout.trim();
    assert.deepEqual(JSON.parse(await run("status")), { supervisor: "launchd", state: "stopped", pid: null, healthy: false, ready: false });
    assert.equal(probes, 0);
    assert.deepEqual(JSON.parse(await run("start")), { supervisor: "launchd", state: "running", pid: 1234, healthy: true, ready: true });
    ready = false;
    assert.equal(JSON.parse(await run("status")).ready, false);
    assert.equal(JSON.parse(await run("status")).healthy, true);
    await run("start");
    assert.equal((await fs.readFile(path.join(temp, "calls"), "utf8")).split("\n").filter(line => line === "bootstrap").length, 1);
    assert.match(await run("stop"), /stopped until/);
    const previousProbes = probes;
    assert.equal(JSON.parse(await run("status")).state, "stopped");
    assert.equal(probes, previousProbes);
    await fs.unlink(path.join(temp, "Library/LaunchAgents/com.website-reader.tunnel.plist"));
    assert.equal(await run("status"), "detached-runtime");
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(temp, { recursive: true, force: true });
  }
});
