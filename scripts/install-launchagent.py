"""Install a Website Reader service as a macOS user LaunchAgent."""

import os
from pathlib import Path
import plistlib
import subprocess
import sys

if sys.platform != "darwin":
    raise SystemExit("This installer requires macOS.")

root = Path(__file__).resolve().parent.parent
service = sys.argv[1] if len(sys.argv) == 2 else "bleve"
if service not in {"bleve", "tunnel"} or len(sys.argv) > 2:
    raise SystemExit("Usage: install-launchagent.py [bleve|tunnel]")
binary = root / ".local-mcp/bin" / ("tunnel-client" if service == "tunnel" else "lexical-search")
if not binary.is_file() or not os.access(binary, os.X_OK):
    raise SystemExit("Install the tunnel client first; see local-mcp-setup.md." if service == "tunnel" else "Build the service first: npm run bleve:build")

arguments = [str(binary)]
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
        "EnvironmentVariables": {
            "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        },
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
subprocess.run(["launchctl", "bootstrap", domain, str(plist)], check=True)
print(f"Installed {plist}\nStatus: launchctl print {target}")
