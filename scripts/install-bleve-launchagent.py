"""Install the built Bleve service as a macOS user LaunchAgent."""

import os
from pathlib import Path
import plistlib
import subprocess
import sys

if sys.platform != "darwin":
    raise SystemExit("This installer requires macOS.")

root = Path(__file__).resolve().parent.parent
binary = root / ".local-mcp/bin/lexical-search"
if not binary.is_file() or not os.access(binary, os.X_OK):
    raise SystemExit("Build the service first: npm run bleve:build")

label = "com.website-reader.bleve"
domain = f"gui/{os.getuid()}"
target = f"{domain}/{label}"
plist = Path.home() / "Library/LaunchAgents" / f"{label}.plist"
log = root / ".local-mcp/bleve.log"
plist.parent.mkdir(parents=True, exist_ok=True)
with plist.open("wb") as output:
    plistlib.dump({
        "Label": label,
        "ProgramArguments": [str(binary)],
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
