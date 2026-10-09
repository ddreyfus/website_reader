"""Verify persistent service environments without touching user LaunchAgents."""
import os
from pathlib import Path
import plistlib
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "scripts/install-launchagent.py"

class SemanticLaunchAgentTests(unittest.TestCase):
    def test_supervision_and_explicit_opt_in(self):
        for args, service in [(["ollama"], "ollama"), (["bleve"], "bleve"), (["bleve", "--semantic"], "bleve")]:
            with self.subTest(args=args), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                script = root / "scripts/install-launchagent.py"
                script.parent.mkdir()
                script.write_text(SOURCE.read_text())
                binary = root / (".local-mcp/ollama/ollama" if service == "ollama" else ".local-mcp/bin/lexical-search")
                binary.parent.mkdir(parents=True)
                binary.write_text("fixture")
                binary.chmod(0o700)
                bootstraps = []
                def command(command, **kwargs):
                    if command[1] == "bootstrap":
                        bootstraps.append(command)
                        if len(bootstraps) == 1:
                            raise subprocess.CalledProcessError(5, command)
                    return subprocess.CompletedProcess(command, 1)
                with patch("time.sleep"), patch.object(sys, "argv", [str(script), *args]), patch.object(sys, "platform", "darwin"), patch.object(Path, "home", return_value=root), patch.dict(os.environ, {"LOCAL_MCP_CONFIG": "/tmp/pilot/config.json", "ARCHIVE_EMBEDDINGS": "1"}), patch("subprocess.run", side_effect=command) as run:
                    runpy.run_path(str(script), run_name="__main__")
                plist = plistlib.loads((root / f"Library/LaunchAgents/com.website-reader.{service}.plist").read_bytes())
                self.assertTrue(plist["KeepAlive"])
                self.assertTrue(plist["RunAtLoad"])
                self.assertEqual(plist["ThrottleInterval"], 10)
                env = plist["EnvironmentVariables"]
                if service == "ollama":
                    self.assertEqual(plist["ProgramArguments"], [str(binary), "serve"])
                    self.assertEqual(env["OLLAMA_HOST"], "127.0.0.1:11435")
                    self.assertEqual(env["OLLAMA_NO_CLOUD"], "1")
                    self.assertEqual(env["OLLAMA_MODELS"], str(root / ".local-mcp/ollama/models"))
                else:
                    self.assertEqual(env["ARCHIVE_EMBEDDINGS"], "1" if "--semantic" in args else "0")
                    self.assertEqual(env["OMP_NUM_THREADS"], "1")
                    self.assertEqual(env["LOCAL_MCP_CONFIG"], "/tmp/pilot/config.json")
                self.assertEqual(len(bootstraps), 2)
                self.assertEqual(run.call_args_list[-1].args[0][:2], ["launchctl", "bootstrap"])

if __name__ == "__main__":
    unittest.main()
