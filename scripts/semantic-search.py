"""Reproducible macOS ARM64 setup/build for local semantic search. See SEMANTIC_SEARCH.md."""

import hashlib
import json
import os
from pathlib import Path
import platform
import socket
import subprocess
import sys
import tarfile

root = Path(__file__).resolve().parent.parent
local = root / ".local-mcp"
faiss_commit = "b747c55a93a9627039c34d44b081f375dca94e57"  # Bleve 2.4.4
ollama_version = "0.40.1"
ollama_sha256 = "66e1587711f3a06315b23782ba74897001da6c8b8edf6c0371f7533015a076dd"
command = sys.argv[1] if len(sys.argv) > 1 else ""
if command not in {"install", "build", "test", "serve", "pull"}:
    raise SystemExit("Usage: python3 scripts/semantic-search.py install|build|test|serve|pull [test arguments]")
if platform.system() != "Darwin" or platform.machine() != "arm64":
    raise SystemExit("This setup currently supports macOS ARM64 only; see SEMANTIC_SEARCH.md.")


def run(args, **kwargs):
    try:
        subprocess.run([str(arg) for arg in args], check=True, cwd=root, **kwargs)
    except KeyboardInterrupt:
        raise SystemExit(130) from None


if command == "install":
    try:
        with socket.create_connection(("127.0.0.1", 11435), timeout=1):
            raise SystemExit("Stop the test Ollama server before reinstalling its executable/libraries.")
    except OSError:
        pass
    source = local / "faiss-src"
    prefix = local / "faiss"
    if not source.exists():
        run(["git", "clone", "https://github.com/blevesearch/faiss.git", source])
    run(["git", "-C", source, "checkout", "--detach", faiss_commit])
    omp = subprocess.check_output(["brew", "--prefix", "libomp"], text=True).strip()
    run(["cmake", "-S", source, "-B", source / "build",
         "-DCMAKE_POLICY_VERSION_MINIMUM=3.5", "-DCMAKE_BUILD_TYPE=Release",
         "-DFAISS_ENABLE_GPU=OFF", "-DFAISS_ENABLE_C_API=ON", "-DFAISS_ENABLE_PYTHON=OFF",
         "-DBUILD_SHARED_LIBS=ON", "-DBUILD_TESTING=OFF", f"-DCMAKE_INSTALL_PREFIX={prefix}",
         f"-DOpenMP_CXX_FLAGS=-Xpreprocessor -fopenmp -I{omp}/include",
         "-DOpenMP_CXX_LIB_NAMES=omp", f"-DOpenMP_omp_LIBRARY={omp}/lib/libomp.dylib"])
    run(["cmake", "--build", source / "build", "--parallel", "4"])
    run(["cmake", "--install", source / "build"])
    archive = local / f"ollama-{ollama_version}-darwin.tgz"
    if not archive.exists():
        partial = archive.with_suffix(".part")
        run(["curl", "--fail", "--location", "--retry", "3", "--output", partial,
             f"https://github.com/ollama/ollama/releases/download/v{ollama_version}/ollama-darwin.tgz"])
        with partial.open("rb") as downloaded:
            if hashlib.file_digest(downloaded, "sha256").hexdigest() != ollama_sha256:
                raise SystemExit(f"Checksum mismatch: {partial}; remove the failed download and retry.")
        partial.replace(archive)
    with archive.open("rb") as downloaded:
        if hashlib.file_digest(downloaded, "sha256").hexdigest() != ollama_sha256:
            raise SystemExit(f"Checksum mismatch: {archive}; remove the failed download and retry.")
    destination = local / "ollama"
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive) as downloaded:
        downloaded.extractall(destination, filter="data")
    print(f"Installed pinned native dependencies and Ollama {ollama_version} under {local}")
elif command in {"serve", "pull"}:
    env = dict(os.environ, OLLAMA_HOST="127.0.0.1:11435",
               OLLAMA_MODELS=str(local / "ollama/models"), OLLAMA_NO_CLOUD="1")
    run([local / "ollama/ollama", *(["serve"] if command == "serve" else ["pull", "embeddinggemma:300m"])], env=env)
else:
    prefix = local / "faiss"
    if not (prefix / "lib/libfaiss_c.dylib").exists():
        raise SystemExit("First run: npm run semantic:deps")
    # Embed rpath so launchd does not need DYLD_LIBRARY_PATH.
    # Go 1.21's CGO linker directives do not reliably accept quoted paths.
    if any(char.isspace() for char in str(prefix)):
        raise SystemExit("The native build requires a checkout path without whitespace.")
    env = dict(os.environ, CGO_ENABLED="1",
               CGO_CPPFLAGS=f'-I{prefix}/include',
               CGO_LDFLAGS=f'-L{prefix}/lib -Wl,-rpath,{prefix}/lib',
               OMP_NUM_THREADS="1")
    # The pinned binding indexes indices[0] even for an empty exclusion set.
    # Apply a compiler overlay rather than modifying the shared Go module cache.
    module = json.loads(subprocess.check_output(
        ["go", "-C", str(root / "lexical-search"), "mod", "download", "-json",
         "github.com/blevesearch/go-faiss@v1.0.24"], text=True))
    selector = Path(module["Dir"]) / "selector.go"
    original = selector.read_text()
    old = "(*C.idx_t)(&indices[0])"
    if original.count(old) != 1:
        raise SystemExit("Unexpected pinned FAISS selector source; cannot apply safety fix")
    patched = local / "go-faiss-selector.go"
    patched.write_text(original.replace("var sel *C.FaissIDSelectorBatch", "var sel *C.FaissIDSelectorBatch\n var values *C.idx_t\n if len(indices) > 0 { values = (*C.idx_t)(&indices[0]) }").replace(old + ",", "values,"))
    overlay = local / "go-faiss-overlay.json"
    overlay.write_text(json.dumps({"Replace": {str(selector): str(patched)}}))
    if command == "build":
        (local / "bin").mkdir(parents=True, exist_ok=True)
        run(["go", "-C", root / "lexical-search", "build", f"-overlay={overlay}", "-tags=vectors",
             "-ldflags=-linkmode=external", "-o", local / "bin/lexical-search", "."], env=env)
        run(["codesign", "--force", "--sign", "-", local / "bin/lexical-search"])
    else:
        # Never enable live backfill implicitly in the regression suite.
        env.pop("ARCHIVE_EMBEDDINGS", None)
        run(["go", "-C", root / "lexical-search", "test",
             "-ldflags=-linkmode=external", *sys.argv[2:], "./..."], env=env)
        run(["go", "-C", root / "lexical-search", "test", f"-overlay={overlay}", "-tags=vectors",
             "-ldflags=-linkmode=external", *sys.argv[2:], "./..."], env=env)
