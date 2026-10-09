"""Test native setup orchestration without downloads, compilers, or system writes."""

from contextlib import ExitStack, redirect_stdout
import io
from pathlib import Path
import runpy
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch

SOURCE = Path(__file__).resolve().parents[1] / "scripts/semantic-search.py"
PINNED_FAISS = "b747c55a93a9627039c34d44b081f375dca94e57"
PINNED_OLLAMA_HASH = "66e1587711f3a06315b23782ba74897001da6c8b8edf6c0371f7533015a076dd"


class SemanticSetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="semantic-setup-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.script = self.root / "scripts/semantic-search.py"
        self.script.parent.mkdir()
        self.script.write_text(SOURCE.read_text())
        self.local = self.root / ".local-mcp"
        self.local.mkdir()
        self.calls = []
        selector = self.local / "go-faiss/selector.go"
        selector.parent.mkdir()
        selector.write_text("var sel *C.FaissIDSelectorBatch\n(*C.idx_t)(&indices[0]),\n")
        payload = io.BytesIO()
        with tarfile.open(fileobj=payload, mode="w:gz") as archive:
            info = tarfile.TarInfo("ollama")
            info.size = 6
            archive.addfile(info, io.BytesIO(b"binary"))
        self.payload = payload.getvalue()

    def fake_run(self, args, **kwargs):
        self.calls.append((args, kwargs))
        if args[:2] == ["git", "clone"]:
            Path(args[-1]).mkdir(parents=True)
        if args[:2] == ["cmake", "--install"]:
            self.native_library()
        if args[0] == "curl":
            Path(args[args.index("--output") + 1]).write_bytes(self.payload)
        return subprocess.CompletedProcess(args, 0)

    def native_library(self):
        library = self.local / "faiss/lib/libfaiss_c.dylib"
        library.parent.mkdir(parents=True, exist_ok=True)
        library.write_bytes(b"fake native library")

    def execute(self, command, args=(), system="Darwin", machine="arm64",
                running=False, trust_fixture=False, run=None):
        with ExitStack() as stack:
            stack.enter_context(patch.object(sys, "argv", [str(self.script), command, *args]))
            stack.enter_context(patch("platform.system", return_value=system))
            stack.enter_context(patch("platform.machine", return_value=machine))
            stack.enter_context(patch("socket.create_connection",
                return_value=Mock(__enter__=Mock(), __exit__=Mock(return_value=False))) if running else
                patch("socket.create_connection", side_effect=ConnectionRefusedError))
            stack.enter_context(patch("subprocess.check_output", side_effect=lambda args, **kw: __import__("json").dumps({"Dir": str(self.local / "go-faiss")}) if "download" in args else "/opt/homebrew/opt/libomp\n"))
            stack.enter_context(patch("subprocess.run", side_effect=run or self.fake_run))
            if trust_fixture:
                # Success orchestration uses a small synthetic archive, not the
                # 167 MB release. Failure cases below use the real SHA-256 code.
                stack.enter_context(patch("hashlib.file_digest", return_value=Mock(hexdigest=lambda: PINNED_OLLAMA_HASH)))
            stack.enter_context(redirect_stdout(io.StringIO()))
            return runpy.run_path(str(self.script), run_name="__main__")

    def test_unsupported_platform_and_command_fail_before_actions(self):
        for command, system, machine in [("install", "Linux", "arm64"),
                                         ("build", "Darwin", "x86_64"),
                                         ("unknown", "Darwin", "arm64")]:
            with self.subTest(command=command, system=system, machine=machine):
                with self.assertRaises(SystemExit):
                    self.execute(command, system=system, machine=machine)
                self.assertEqual(self.calls, [])

    def test_running_server_blocks_install_before_any_mutation(self):
        with self.assertRaisesRegex(SystemExit, "Stop the test Ollama server"):
            self.execute("install", running=True)
        self.assertEqual(self.calls, [])
        self.assertEqual(list(self.local.iterdir()), [self.local / "go-faiss"])

    def test_native_install_uses_matching_pins_and_local_prefix(self):
        self.execute("install", trust_fixture=True)
        commands = [args for args, _ in self.calls]
        checkout = next(args for args in commands if "checkout" in args)
        self.assertEqual(checkout[-1], PINNED_FAISS)
        configure = next(args for args in commands if args[:2] == ["cmake", "-S"])
        for flag in ["-DFAISS_ENABLE_GPU=OFF", "-DFAISS_ENABLE_C_API=ON",
                     "-DFAISS_ENABLE_PYTHON=OFF", "-DBUILD_SHARED_LIBS=ON",
                     "-DCMAKE_POLICY_VERSION_MINIMUM=3.5",
                     f"-DCMAKE_INSTALL_PREFIX={self.local / 'faiss'}"]:
            self.assertIn(flag, configure)
        download = next(args for args in commands if args[0] == "curl")
        self.assertIn("/v0.40.1/ollama-darwin.tgz", download[-1])
        self.assertIn("--fail", download)
        self.assertEqual((self.local / "ollama/ollama").read_bytes(), b"binary")
        self.assertFalse((self.local / "ollama-0.40.1-darwin.part").exists())
        self.assertTrue((self.local / "ollama-0.40.1-darwin.tgz").exists())
        self.calls.clear()
        self.execute("install", trust_fixture=True)
        self.assertFalse(any(args[0] == "curl" or args[:2] == ["git", "clone"] for args, _ in self.calls))

    def test_bad_cached_checksum_is_never_extracted(self):
        (self.local / "ollama-0.40.1-darwin.tgz").write_bytes(self.payload)
        with self.assertRaisesRegex(SystemExit, "Checksum mismatch"):
            self.execute("install")
        self.assertFalse((self.local / "ollama").exists())

    def test_bad_download_is_not_promoted_or_extracted(self):
        with self.assertRaisesRegex(SystemExit, "Checksum mismatch"):
            self.execute("install")
        self.assertFalse((self.local / "ollama-0.40.1-darwin.tgz").exists())
        self.assertFalse((self.local / "ollama").exists())

    def test_failed_download_is_retryable(self):
        def failure(args, **kwargs):
            if args[0] == "curl":
                Path(args[args.index("--output") + 1]).write_bytes(b"interrupted download")
                raise subprocess.CalledProcessError(22, args)
            return self.fake_run(args, **kwargs)
        with self.assertRaises(subprocess.CalledProcessError):
            self.execute("install", run=failure)
        self.assertFalse((self.local / "ollama-0.40.1-darwin.tgz").exists())
        self.execute("install", trust_fixture=True)
        self.assertEqual((self.local / "ollama/ollama").read_bytes(), b"binary")

    def test_archive_cannot_escape_install_directory(self):
        payload = io.BytesIO()
        with tarfile.open(fileobj=payload, mode="w:gz") as archive:
            info = tarfile.TarInfo("../outside")
            info.size = 6
            archive.addfile(info, io.BytesIO(b"escape"))
        self.payload = payload.getvalue()
        with self.assertRaises(tarfile.FilterError):
            self.execute("install", trust_fixture=True)
        self.assertFalse((self.local / "outside").exists())

    def test_build_and_tests_require_native_libraries(self):
        for command in ["build", "test"]:
            with self.subTest(command=command):
                with self.assertRaisesRegex(SystemExit, "semantic:deps"):
                    self.execute(command)
        self.assertEqual(self.calls, [])

    def test_build_flags_linkage_and_test_isolation(self):
        self.native_library()
        self.execute("build")
        args, options = self.calls[-2]
        self.assertEqual(self.calls[-1][0][:4], ["codesign", "--force", "--sign", "-"])
        self.assertIn("build", args)
        self.assertIn("-tags=vectors", args)
        self.assertIn(f"-overlay={self.local / 'go-faiss-overlay.json'}", args)
        self.assertIn("-ldflags=-linkmode=external", args)
        self.assertEqual(args[args.index("-o") + 1], str(self.local / "bin/lexical-search"))
        env = options["env"]
        self.assertEqual(env["CGO_ENABLED"], "1")
        self.assertEqual(env["CGO_CPPFLAGS"], f"-I{self.local / 'faiss/include'}")
        self.assertIn(f"-Wl,-rpath,{self.local / 'faiss/lib'}", env["CGO_LDFLAGS"])
        with patch.dict("os.environ", {"ARCHIVE_EMBEDDINGS": "1", "SEMANTIC_LIVE_TEST": "1"}):
            self.execute("test", args=["-race", "-count=1"])
        ordinary, ordinary_options = self.calls[-2]
        self.assertIn("test", ordinary)
        self.assertNotIn("-tags=vectors", ordinary)
        self.assertNotIn("ARCHIVE_EMBEDDINGS", ordinary_options["env"])
        args, options = self.calls[-1]
        self.assertIn("-race", args)
        self.assertIn("-count=1", args)
        self.assertEqual(args[-1], "./...")
        self.assertNotIn("ARCHIVE_EMBEDDINGS", options["env"])
        self.assertEqual(options["env"]["SEMANTIC_LIVE_TEST"], "1")

    def test_whitespace_native_path_is_rejected(self):
        original = self.root
        self.root = original / "with space"
        self.script = self.root / "scripts/semantic-search.py"
        self.script.parent.mkdir(parents=True)
        self.script.write_text(SOURCE.read_text())
        self.local = self.root / ".local-mcp"
        self.native_library()
        with self.assertRaisesRegex(SystemExit, "without whitespace"):
            self.execute("build")
        self.assertEqual(self.calls, [])

    def test_serve_and_pull_are_local_and_cloud_disabled(self):
        for command in ["serve", "pull"]:
            with self.subTest(command=command):
                self.execute(command)
                args, options = self.calls[-1]
                self.assertEqual(args[0], str(self.local / "ollama/ollama"))
                self.assertEqual(args[1:], ["serve"] if command == "serve" else ["pull", "embeddinggemma:300m"])
                self.assertEqual(options["env"]["OLLAMA_HOST"], "127.0.0.1:11435")
                self.assertEqual(options["env"]["OLLAMA_NO_CLOUD"], "1")
                self.assertEqual(options["env"]["OLLAMA_MODELS"], str(self.local / "ollama/models"))

    def test_interrupted_and_failed_commands_do_not_report_success(self):
        with self.assertRaises(SystemExit) as interrupted:
            self.execute("serve", run=Mock(side_effect=KeyboardInterrupt))
        self.assertEqual(interrupted.exception.code, 130)
        self.native_library()
        with self.assertRaises(subprocess.CalledProcessError):
            self.execute("build", run=Mock(side_effect=subprocess.CalledProcessError(1, "go")))


if __name__ == "__main__":
    unittest.main()
