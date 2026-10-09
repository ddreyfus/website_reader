"""Install a Website Reader service as a macOS user LaunchAgent."""

import os
from pathlib import Path
import plistlib
import subprocess
import sys
import time

if sys.platform != "darwin":
    raise SystemExit("This installer requires macOS.")

root = Path(__file__).resolve().parent.parent
semantic = "--semantic" in sys.argv[1:]
args = [arg for arg in sys.argv[1:] if arg != "--semantic"]
service = args[0] if len(args) == 1 else "bleve"
if service not in {"bleve", "tunnel", "ollama"} or len(args) > 1 or (semantic and service != "bleve"):
    raise SystemExit("Usage: install-launchagent.py [bleve [--semantic]|tunnel|ollama]")
binary = root / (".local-mcp/ollama/ollama" if service == "ollama" else
                 ".local-mcp/bin/tunnel-client" if service == "tunnel" else ".local-mcp/bin/lexical-search")
if not binary.is_file() or not os.access(binary, os.X_OK):
    raise SystemExit("Install the tunnel client first; see local-mcp-setup.md." if service == "tunnel" else "Install Ollama first: npm run semantic:deps" if service == "ollama" else "Build the service first: npm run bleve:build")

environment = {"PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"}
arguments = [str(binary)]
if service == "ollama":
    arguments += ["serve"]
    environment.update(OLLAMA_HOST="127.0.0.1:11435", OLLAMA_MODELS=str(root / ".local-mcp/ollama/models"), OLLAMA_NO_CLOUD="1")
elif service == "bleve":
    environment["OMP_NUM_THREADS"] = "1"
    # Opt-in is explicit and persisted, independent of the installer shell.
    environment["ARCHIVE_EMBEDDINGS"] = "1" if semantic else "0"
    for name in ("LOCAL_MCP_CONFIG", "READING_ARCHIVE_DIR", "PORT"):
        if name in os.environ:
            environment[name] = os.environ[name]

if service == "tunnel":
    profile_dir = root / ".local-mcp/profiles"
    if not (profile_dir / "website-reader-archive.yaml").is_file():
        raise SystemExit("Configure the tunnel profile first; see local-mcp-setup.md.")
    # Stop the old detached runtime before launchd becomes the sole supervisor.
    subprocess.run([str(binary), "runtimes", "stop", "website-reader-archive"], check=True)
    arguments += ["run", "--profile", "website-reader-archive", "--profile-dir", str(profile_dir),
                  "--health.listen-addr", "127.0.0.1:0", "--health.url-file", str(root / ".local-mcp/tunnel-health.url")]

label = f"com.website-reader.{service}"
domain = f"gui/{os.getuid()}"
target = f"{domain}/{label}"
plist = Path.home() / "Library/LaunchAgents" / f"{label}.plist"
log = root / f".local-mcp/{service}.log"
plist.parent.mkdir(parents=True, exist_ok=True)
with plist.open("wb") as output:
    plistlib.dump({
        "Label": label,
        "ProgramArguments": arguments,
        "WorkingDirectory": str(root),
        "EnvironmentVariables": environment,
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 10,
        "StandardOutPath": str(log),
        "StandardErrorPath": str(log),
    }, output)
plist.chmod(0o644)

if subprocess.run(["launchctl", "print", target], capture_output=True).returncode == 0:
    subprocess.run(["launchctl", "bootout", target], check=True)
subprocess.run(["launchctl", "enable", target], check=True)
# bootout can return before launchd has finished removing the old job.
for attempt in range(25):
    try:
        subprocess.run(["launchctl", "bootstrap", domain, str(plist)], check=True)
        break
    except subprocess.CalledProcessError as error:
        if error.returncode != 5 or attempt == 24:
            raise
        time.sleep(0.2)
print(f"Installed {plist}\nStatus: launchctl print {target}")
