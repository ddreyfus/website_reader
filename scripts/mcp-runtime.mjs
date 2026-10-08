import { access, readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import os from "node:os";

const root = fileURLToPath(new URL("../", import.meta.url));
const binary = `${root}.local-mcp/bin/tunnel-client`;
const profileDir = `${root}.local-mcp/profiles`;
const alias = "website-reader-archive";
const action = process.argv[2];

try {
  if (!["start", "stop", "status"].includes(action)) {
    throw new Error("Usage: node scripts/mcp-runtime.mjs start|stop|status");
  }
  await access(binary);
  const run = args => {
    const result = spawnSync(binary, args, { cwd: root, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  };
  const label = "com.website-reader.tunnel";
  const target = `gui/${process.getuid?.()}/${label}`;
  const plist = `${os.homedir()}/Library/LaunchAgents/${label}.plist`;
  const supervised = process.platform === "darwin" && await stat(plist).then(() => true, () => false);
  if (supervised) {
    const launchctl = args => {
      const result = spawnSync("launchctl", args, { encoding: "utf8" });
      if (result.error) throw result.error;
      return result;
    };
    let state = launchctl(["print", target]);
    if (action === "stop") {
      if (state.status === 0) {
        const result = launchctl(["bootout", target]);
        if (result.status !== 0) throw new Error(result.stderr || "Could not stop tunnel LaunchAgent.");
      }
      console.log("Tunnel stopped until mcp:start or next login.");
      process.exit(0);
    }
    if (action === "start" && state.status !== 0) {
      for (const args of [["enable", target], ["bootstrap", `gui/${process.getuid()}`, plist]]) {
        const result = launchctl(args);
        if (result.status !== 0) throw new Error(result.stderr || "Could not start tunnel LaunchAgent.");
      }
      state = launchctl(["print", target]);
    }
    let healthy = false;
    let ready = false;
    if (state.status === 0 && /\n\s*state = running\n/.test(state.stdout)) {
      try {
        const base = (await readFile(`${root}.local-mcp/tunnel-health.url`, "utf8")).trim();
        const url = new URL(base);
        if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("Expected loopback tunnel health URL.");
        const responses = await Promise.all(["/healthz", "/readyz"].map(path => fetch(new URL(path, url), { signal: AbortSignal.timeout(3000) })));
        healthy = responses[0].ok;
        ready = responses[1].ok;
      } catch { /* Startup or an unavailable health endpoint is reported below. */ }
    }
    console.log(JSON.stringify({ supervisor: "launchd", state: state.stdout?.match(/\n\s*state = (.+)\n/)?.[1] || "stopped", pid: Number(state.stdout?.match(/\n\s*pid = (\d+)/)?.[1]) || null, healthy, ready }));
    process.exit(0);
  }
  if (action === "start") {
    const profile = parse(await readFile(`${profileDir}/${alias}.yaml`, "utf8"));
    if (!profile.control_plane?.tunnel_id || !profile.mcp?.commands?.[0]?.command) {
      throw new Error("Configure the local stdio profile first; see local-mcp-setup.md.");
    }
    if (!profile.control_plane.api_key?.startsWith("file:")) {
      throw new Error("Use a private file: runtime key reference; see local-mcp-setup.md.");
    }
    try {
      await access(profile.control_plane.api_key.slice(5));
    } catch {
      throw new Error("Runtime API key file is missing. Save it privately as described in local-mcp-setup.md.");
    }
    run(["runtimes", "connect", "--alias", alias,
      "--profile", alias, "--profile-dir", profileDir,
      "--tunnel-id", profile.control_plane.tunnel_id,
      "--runtime-api-key", profile.control_plane.api_key,
      "--mcp-command", profile.mcp.commands[0].command]);
    run(["runtimes", "status", alias]);
  } else {
    run(["runtimes", action, alias]);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
