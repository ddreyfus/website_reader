import { access, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../", import.meta.url));
const binary = `${root}.local-mcp/bin/tunnel-client`;
const profileDir = `${root}.local-mcp/profiles`;
const alias = "website-reader-hello";
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
