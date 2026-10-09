# Local semantic search: build, operation, and progress

Started: 2026-10-08
Branch: `codex/local-semantic-search`

## Architecture and scope

Use **Bleve for both lexical and vector retrieval**, **SQLite for existing
workspace/ingestion metadata**, and **Ollama for local embedding inference**.
No additional archive database or vector service is introduced. SQLite/Bleve
coordination and ingestion reconciliation already exist; this work extends them.
The earlier SQLite-vector prototype proposal was superseded by this decision.

The feature is opt-in: `ARCHIVE_EMBEDDINGS=1` and a `vectors` build are required.
Ordinary builds retain lexical retrieval without FAISS. Do not deploy the ordinary
build against an archive whose mapping has been migrated to vectors: it lacks the
vector implementation. Disabling inference on the vector-enabled binary is safe.

## Versions and prerequisites

The tested setup is macOS 26.7.1, ARM64, using the existing Go 1.21 toolchain and
Apple Command Line Tools. The installer currently supports macOS ARM64 only.
Ollama identified this machine as an Apple M3 Pro with 18 GiB system memory.
Ollama requires macOS 14+. Use a checkout path without whitespace for the native
build with this Go toolchain.

| Component | Pinned version |
| --- | --- |
| Bleve | 2.4.4 (upgraded from 2.4.0 for filtered kNN) |
| Bleve's FAISS fork | `b747c55a93a9627039c34d44b081f375dca94e57` |
| Ollama macOS CLI distribution | 0.40.1 |
| Embedding model | `embeddinggemma:300m`, 768 dimensions |

Install Go, Python 3.11+, Node/npm, Git, Homebrew, and Apple Command Line Tools
before running the following commands. Native prerequisites:

```sh
xcode-select --install  # Only if Command Line Tools are absent.
HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 brew install cmake libomp
```

The tested CMake version was 4.4.4 and libomp was 23.1.3. FAISS uses Apple's
Accelerate framework for BLAS/LAPACK, Homebrew OpenMP, and CPU vector search.
Ollama can use Apple GPU acceleration for embeddings; no CUDA is required.

## Reproduce the installation and build

From the repository root:

```sh
npm run semantic:deps
npm run semantic:build
npm run semantic:test
npm run test:mcp
```

Stop the test Ollama server before rerunning `semantic:deps`; replacing a running
macOS executable can terminate it. The installer refuses if port 11435 is in use.

`scripts/semantic-search.py` is the executable source of the build procedure.
It clones and checks out the exact FAISS revision, configures a shared C API with
GPU and Python bindings disabled, builds with four jobs, and installs into
`.local-mcp/faiss`. Nothing is installed into `/usr/local/lib`. It downloads the
pinned official Ollama CLI archive, verifies SHA-256 before extracting, and keeps
the bundled runtime libraries together in `.local-mcp/ollama`.

Ollama archive SHA-256:
`66e1587711f3a06315b23782ba74897001da6c8b8edf6c0371f7533015a076dd`.

The Go build uses `-tags=vectors`, CGO, and external linking. The script supplies
FAISS include/library directories and embeds an absolute runtime library search
path, so launching the binary does not require `DYLD_LIBRARY_PATH`. Rebuild after
moving the checkout. Keep `.local-mcp/faiss` and Homebrew's libomp installed beside
the deployment. A Homebrew libomp upgrade/removal may require a native rebuild.
CMake 4 needs `CMAKE_POLICY_VERSION_MINIMUM=3.5` for this older FAISS revision;
the installer supplies it. AppleClang is sufficient; a separate LLVM install is
not required by this tested configuration.

To inspect linkage:

```sh
otool -L .local-mcp/bin/lexical-search
otool -L .local-mcp/faiss/lib/libfaiss_c.dylib
```

Duplicate-rpath linker warnings may appear with this Go toolchain; verification
must still complete successfully. If a download checksum fails, remove only that
failed `.local-mcp/ollama-0.40.1-darwin.tgz` and rerun the installer. The installer
checks out the pinned revision in its generated FAISS clone; keep personal source
changes elsewhere. Version upgrades must update the Bleve/FAISS pairing together
and rerun native tests. Do not substitute upstream FAISS or a Homebrew FAISS build.

## Start Ollama, pull the model, and verify

Terminal 1:

```sh
npm run semantic:serve
```

Terminal 2:

```sh
npm run semantic:pull
SEMANTIC_LIVE_TEST=1 npm run semantic:test -- -run TestLocalEmbeddingSmoke -v
```

The server binds only `127.0.0.1:11435`, stores models under
`.local-mcp/ollama/models`, and disables cloud features with `OLLAMA_NO_CLOUD=1`.
Ollama also creates a runtime identity under `~/.ollama`; installation is not fully
isolated from the home directory. The runtime/model download requires internet
access. Embedding requests stay on loopback; the Go client disables proxies and
redirects. No hosted fallback is provided. Stop the manually started server with
Ctrl-C. An unrelated Ollama instance on the default port 11434 is not changed.

## Enable archive search

After building the vector-enabled binary and starting Ollama:

```sh
OMP_NUM_THREADS=1 ARCHIVE_EMBEDDINGS=1 npm run bleve:start
```

Stop any other instance of this project's search service first so it is the sole
owner of the archive indexes. For an isolated test, use a temporary archive root
and config instead of the live archive. The LaunchAgent installer supports supervised Ollama and explicit persistent
semantic opt-in; see the resilience section below. Manual operation remains
available for isolated testing.
The live service was enabled on 2026-10-09 using `npm run semantic:enable`.
Backfill runs automatically alongside directory synchronization, including
previously indexed passages and newly synced or edited content; no manual
backfill command is required. Coverage remains partial until that work finishes.

The background worker adds explicit vector and model-identity fields to each
existing Bleve mapping, then reindexes existing passages in bounded batches using
the same chunk IDs. It persists the additive mapping through Bleve's `_mapping`
internal metadata because Bleve has no public mapping-update method. Regression
tests must verify close/reopen behavior when changing Bleve versions. Existing
lexical postings remain valid. Both the default document mapping and the named
`slidingChunk` mapping are extended, since generated documents use the default.

Inference happens outside workspace locks. Before publishing, the worker checks
that each chunk ID still exists with identical text/path/line fields. Deleted or
edited chunks are skipped, so in-flight inference cannot resurrect old passages.
Model digest and retrieval-format version identify compatible embeddings. New or
changed chunks are filled automatically; stale model vectors are excluded from
queries while replacement embeddings are generated. Backfill resumes by finding
missing/stale markers, without another SQLite table or duplicated passage text.

Requests disable silent truncation. A failed batch is retried per passage, and the
worker advances through remaining IDs so a bad passage does not block later ones.
Failures remain unembedded and retry on a later pass; logs identify chunk IDs.
Current line/byte-based chunks may exceed model token limits or cross article
boundaries. Chunking improvements remain a separate quality task.

Search embeds the query before acquiring archive locks, then independently
retrieves lexical and vector candidates. The vector filter includes corpus chunk
IDs and current model identity **before** nearest-neighbor selection. Candidate
lists are merged with reciprocal rank fusion (constant 60), deduplicated by chunk
ID, and sorted deterministically. Each list contributes up to `max(3*limit, 60)`
candidates. Existing passage text, source links, line ranges, and response results
remain available to MCP and the viewer.

Responses additionally include `semantic_status` (`disabled`, `unavailable`,
`partial`, or `ready`) and `semantic_indexed_passages` for the selected scope.
`ready` means all eligible passages have current embeddings, not that a result is
relevant. Query inference and vector retrieval share a 250 ms deadline; inference/index-search failures
fall back to lexical search and report unavailability. Zero coverage preserves
lexical scores. Hybrid scores are rank-fusion signals, not confidence values.
Search logs keep lexical totals separately and set `total_matches` to null for
hybrid retrieval, since vector top-K has no exhaustive semantic match count.

## Verification and progress

`npm run semantic:test` runs the 12 isolated Python installer tests, the full
ordinary Go suite, and the full vector-enabled Go suite. It needs the local FAISS
build but no running Ollama instance. Installer tests mock external commands and
use temporary directories; they do not install packages or download release files.
The real-model test is opt-in with `SEMANTIC_LIVE_TEST=1` as documented above.

For concurrency and coverage checks:

```sh
npm run semantic:test -- -race -count=1 -timeout=90s
npm run semantic:test -- -coverprofile=/tmp/semantic-coverage.out
```

The coverage profile is overwritten by the second (vector-enabled) Go run.
Coverage is a diagnostic, not a guarantee of relevance or archive-scale behavior.

| Behavior | Automated checks |
| --- | --- |
| Both retrieval paths contribute | Fixed lexical-only, semantic-only, and shared hits; expected fusion scores/order; deduplication; deterministic ties; final result limit |
| Corpus scope and coverage | Multiple workspace alias; out-of-scope vectors excluded; partial and zero coverage; source provenance and truthful search logs |
| Compatible model identity | Missing/invalid identity; stale vector exclusion; tag changes during query/backfill; successful replacement using the current model |
| Incremental backfill | Bounded batches; unchanged-chunk reuse; oversized-input rejection; batch-to-single retry; later passages still progress; restart resumes failed work |
| Concurrent ingestion | Real source edit/deletion while inference is running; stale chunks cannot be republished; edited sources can subsequently be embedded |
| Cancellation and lifecycle | Request deadline; interrupted backfill then restart; disabled worker; worker startup/completion; shutdown during inference and unavailable-runtime handling |
| Failure handling | Malformed JSON, wrong count/dimensions, null/zero/overflow vectors, response-size limit, connection refusal, HTTP errors, rejected redirects, lexical fallback on inference and native Bleve errors |
| Ordinary build | Semantic opt-in reports unsupported; lexical search works; background worker shuts down |
| Installer | Platform/architecture guard, running-server guard, pinned build arguments, local prefix/rpath, cached and downloaded checksum failures, interrupted-download retry, archive path containment, missing native libraries, whitespace paths, cloud-disabled loopback runtime, command failure/cancellation |
| MCP | Semantic availability/coverage metadata survives tool forwarding alongside source URLs |
| Actual local model | 768-dimensional embeddings and correct nearest passage through FAISS |

Tests live in `lexical-search/routes/semantic*_test.go`,
`tests/test_semantic_setup.py`, and `tests/mcp.test.mjs`.

- [x] Create feature branch and document plan.
- [x] Choose Bleve vectors with existing SQLite ingestion state.
- [x] Install native prerequisites and build the pinned FAISS fork locally.
- [x] Download/checksum-verify Ollama and run local EmbeddingGemma inference.
- [x] Implement opt-in background embedding generation and scoped hybrid search.
- [x] Finish FAISS regression suite and local-model integration verification.
- [x] Run initial isolated sample pilot with query, coverage, and latency measurements.
- [ ] Complete blinded passage relevance evaluation and archive-scale expansion.
- [ ] Decide on supervised Ollama startup and production enablement.

### 2026-10-08 measurements and checks

Initial synthetic three-input embedding request: 768 dimensions, approximately
1,010 ms total including 803 ms model load. Query/passage cosine similarity was
0.397 for pricing power versus 0.016 for an unrelated bird passage. This confirms
basic local inference, not archive-wide relevance or throughput.

The downloaded model exposed two runner variants in Ollama's model inventory;
queries/backfill use the selected tag's reported identity and check it again after
inference. Record the inventory when upgrading the runtime. No archive-wide
backfill or real-query quality evaluation has been run yet.

Ordinary Go tests passed after the Bleve upgrade. MCP regression tests passed.
The complete vector-enabled Go suite passed, including additive mapping
persistence, scoped vector retrieval, digest filtering, unchanged-chunk reuse,
concurrent deletion, hybrid search through the index alias, and lexical fallback
on inference failure. The local model-to-FAISS smoke test passed: pricing power
scored 0.397 versus 0.046 for its unrelated comparison passage, and FAISS returned
the expected nearest passage. Installer and vector build commands succeeded;
native linkage was inspected. The semantic review found no outstanding correctness
issues in the tested paths. Archive-scale relevance, migration timing, long-input
coverage, and supervised operation remain unmeasured.

### 2026-10-09 regression expansion

Added the coverage above and made the single semantic test command run the setup
tests and both build variants. A native-error regression exposed that Bleve aliases
can return a nil Go error while recording failed component indexes in the search
result. Coverage/vector searches now check that status and trigger the documented
lexical fallback rather than reporting semantic availability after a native error.
Reran the real local-model integration test successfully. All 12 installer tests,
the ordinary and vector-enabled Go suites with `-race -count=1`, and MCP tests
passed. The semantic implementation (`routes/semantic.go`) reached 204/225
statements covered (90.7%); remaining uncovered paths are mainly defensive
mapping/storage/serialization failures. This is not 100% branch coverage. The
identified retrieval, backfill, inference-failure, and lifecycle cases above have
regression tests. Archive-scale relevance/performance and deployment on other
machines remain separate validation work.

## Isolated archive pilot plan (2026-10-09)

Read-only inspection confirmed the existing branch and uncommitted implementation.
The saved configuration indexes `~/reading-archive/sources` and `~/Downloads`.
The former contains 79 files (41 PDF, 26 Markdown, four DOCX, one HTML, and seven
other files); Downloads contains 17 files, including two PDF and two DOCX.
These are filesystem counts, not successfully extracted document counts. No live
indexes were opened for writing, services restarted, or embeddings enabled during
this inspection.

Use a fresh temporary directory with `sources/`, `archive/`, `config.json`, and
`results/`. Copy source files; never reuse live SQLite/Bleve indexes or configure
the pilot to watch the original folders. Begin with 12–20 documents covering PDF,
Markdown, DOCX, HTML, short articles, long multi-article digests, and extraction
edge cases. Keep relative subdirectories for corpus-scope checks. Record the
selected paths, content hashes, sizes, and selection rationale in the pilot
results. Expand to all supported files under archive sources after the small run;
include supported Downloads documents as a separate scope.

The pilot configuration uses the existing schema: `port: 8767`, an absolute
temporary `archive_root`, one absolute copied-source `index_directories` entry,
and `search_limit: 30`. Start the existing vector binary with `LOCAL_MCP_CONFIG`
pointing to this file, `READING_ARCHIVE_DIR` explicitly pointing to the temporary
archive, and `PORT=0` to avoid port conflicts. Capture its assigned loopback port
from the startup log. Set `OMP_NUM_THREADS=1` consistently for both modes.

1. Start with embeddings disabled and wait for ingestion reconciliation to finish.
   Record successfully indexed documents/passages, extraction failures, elapsed
   ingestion time, and fresh index disk size. Inspect pilot chunk lengths and
   examples at article boundaries; byte length alone cannot establish token fit.
2. Before inspecting rankings, write 20–30 queries and expected relevant source
   passages: exact names/phrases, paraphrases with little word overlap, multi-term
   concepts, scoped searches, and several deliberately unanswerable questions.
   Use independently inspected source text to establish relevance. Save lexical
   responses from `POST /api/v1/archive/search` at limits 10 and 30.
3. Stop only the pilot search process. Start the documented local Ollama runtime
   if its port is free; if occupied, identify the instance before using it. Record
   runtime version and model digest. Restart the pilot against the same temporary
   indexes with `ARCHIVE_EMBEDDINGS=1`. Measure time to full coverage, passage
   throughput, memory use, index growth, and rejected inputs. Poll coverage with
   a fixed query and retain logs; readiness must follow completed source ingestion.
   Report partial coverage and failed chunks explicitly rather than timing out
   and calling the backfill complete.
4. Once coverage stabilizes, run the identical query set and limits. Record first
   query separately, then at least three warm repetitions per query; report
   median/p95 wall latency and errors for lexical and hybrid modes. Restart with
   embeddings disabled for the comparable lexical timing run on the same indexes.
   Review pooled top-10 results without revealing retrieval mode; report relevant
   hits at 10, first relevant rank, and per-query gains/regressions. Deduplicate by
   document when also reporting document-level results. Unanswerable queries test
   incidental retrieval; this API does not promise abstention.
5. Diagnose oversized/rejected chunks and cross-article hits before changing
   chunking. Record their fraction and source formats. Keep any chunking experiment
   in a second fresh pilot archive so the current strategy remains a baseline.
   Verify pilot restart/resume and lexical fallback when the pilot-owned Ollama
   process is stopped, then stop all pilot-owned processes.

Keep raw measurements and judgments local with the temporary pilot results;
record aggregate findings here. Rollout requires reviewed relevance regressions,
an explained coverage gap (or complete coverage), and measured latency/backfill
cost acceptable for interactive use. Pilot results should determine concrete
operating thresholds before supervised startup or live migration is implemented.
The initial sample pilot below has now run; archive-wide expansion remains pending.

### Initial pilot results (2026-10-09)

Ran against copied sources and fresh temporary indexes, using the existing native
binary, local Ollama/model, and `OMP_NUM_THREADS=1`. The live archive and service
were not changed. Raw responses, source hashes, model inventory, scripts, and logs
are retained locally under `.local-mcp/semantic-pilot-2026-10-09/`; the temporary
archive location is recorded in that directory's `location.txt`.

| Measurement | Result |
| --- | --- |
| Sample | 12 documents: five Markdown, four PDF, two DOCX, one HTML |
| Extraction | All 12 succeeded; 1,526 passages; about 73 seconds from fresh startup |
| Embedding coverage | 1,525/1,526 (99.93%); correctly reports `partial` |
| Backfill | Reached 1,525 by approximately 106 seconds; about 14.4 passages/second, including polling/query overhead |
| Warm lexical latency | Median 22.2 ms; p95 35.2 ms |
| Warm hybrid latency | Median 64.0 ms; p95 82.3 ms |
| Local archive footprint | 74.4 MB before vectors; 94.7 MB after (includes extraction caches, metadata, Git state, and indexes) |
| Scoped query | IEEE scope reports `ready`, 65 indexed passages, and only IEEE results |
| Runtime failure | Stopping pilot-owned Ollama returns lexical results and `unavailable` |

Latency measurements use 20 fixed queries, limit 10, three warm repetitions per
query per mode, on the same already migrated indexes. They exclude startup/model
load and backfill concurrency. The initial baseline was also saved before vector
migration. Interrupted diagnostic runs and restarts are recorded in the pilot
notes; the final `summary.json` measures restart/stabilization time, not fresh
ingestion or full backfill time. Use the fresh-run measurements above for those.
Peak memory and a separate cold-query latency were not measured.

The query set contains 18 topical/name/paraphrase queries and two deliberately
unanswerable questions. An exploratory expected-source check found the intended
document in the top 10 for 15/18 lexical queries and 17/18 hybrid queries; source
MRR@10 was 0.749 versus 0.813. These are document-presence proxies, not passage
precision or recall: the expected-source labels were assigned during analysis,
and this was not a blinded relevance study. Digests can contain unrelated articles.

Useful observed changes: the inference/processor-design paraphrase moved its
expected IEEE source from rank 7 to 3; tariff-retaliation and software-dependency
paraphrases gained the intended sources at ranks 7 and 6; prompt engineering moved
its expected source from rank 3 to 1. Limitations remain: unrelated passages still
precede those paraphrase hits, and the organizational-redesign query missed the
intended agentic-development paper in both top-10 lists. Its lexical top passage
directly discusses organizational changes, while hybrid promotes an accessibility
passage above it. Both modes return incidental results for unanswerable queries.

Chunk-quality findings justify a second experiment before rollout. One newsletter
chunk (Krugman, lines 31–49, ID `278e4dd0-691b-46e1-af82-26bbceff3eb9`)
is repeatedly rejected during embedding; its content is dominated by dense tracking
URLs. A direct request for the exact 4,096-byte indexed passage confirmed Ollama's
`the input length exceeds the context length` error. This demonstrates that the
4,096-byte limit does not guarantee model context
fit. Repeated retries continue after other passages finish. Also, 117 Markdown
chunks contain an article anchor inside their line range, a boundary-crossing
indicator requiring inspection rather than a count of confirmed mixed articles.
Two long DOCX documents contribute 803/1,526 passages, so this sample is skewed.

The installed native binary failed macOS signature verification and was killed
before startup. The pilot used an ad-hoc-signed temporary copy with the explicit
existing Tika JAR path; the installed binary was left untouched. Sandboxed Ollama
model loading returned HTTP 500; the approved unsandboxed pilot loaded successfully.
All pilot-owned processes were stopped after measurements.

Next: compare token-aware inputs and article boundaries in a second fresh archive,
with preassigned passage judgments and the same query set, before expanding the
sample or enabling production. The pilot does not establish production readiness.

### Expanded IEEE / Economist / Medium pilot (2026-10-09)

Historical pilot findings below; the selector crash is addressed by the subsequent
resilience work described after this section.

Copied all five Economist issues, nine Medium digests, and the IEEE capture into
a second fresh temporary archive: 15 documents and 1,768 passages (931 Economist,
772 Medium, 65 IEEE). All documents ingested successfully in about 12 seconds.
Backfill reached 1,765 passages (99.83%) and stabilized with three rejected inputs;
the run including stabilization checks took 237 seconds. No live sources, indexes,
services, or production implementation were changed. All pilot processes stopped.
Scripts, source hashes, model inventory, raw results, scores, and logs are retained
under `.local-mcp/semantic-pilot-expanded/`; `location.txt` identifies the copied
archive. Medium includes two captures of the same newsletter; query hit metrics
count a question once regardless of duplicate passages.

Prepared 12 questions, four per publisher, plus keyword rewrites and specific
answer-evidence phrases **before inspecting rankings**. All methods searched the
whole combined corpus. Compared question-only trigram search, question-only vector
search, their existing equal-weight RRF fusion, keyword-only trigram search, and
RRF using keyword lexical input plus question vector input. Each retrieval list
contributed 60 candidates; examined top 10 passages. This is a source-informed,
small exploratory evaluation, not independent user queries or a blinded study.
Keyword rewrites benefit from knowing the source vocabulary.

The fixed phrase check is reproducible but incomplete: a different paragraph or
article can answer the same question without containing the preassigned phrase.
Therefore retain its scores separately and also record supplementary reviewed
positive passages with explicit rationales. The latter includes alternate surgery,
tax, memory, and retirement explanations. These are confirmed answer hits, not an
exhaustive passage relevance labeling or precision estimate.

| Method | Fixed reference evidence in top 10 | Confirmed answer in top 5 after supplementary review | Confirmed answer in top 10 after supplementary review |
| --- | --- | --- | --- |
| Trigram, natural question | 6/12 | 7/12 | 8/12 |
| Semantic, natural question | 8/12 | 11/12 | 11/12 |
| Hybrid, same natural question | 8/12 | 11/12 | 11/12 |
| Trigram, source-informed keywords | 12/12 | 12/12 | 12/12 |
| Hybrid, separate keywords/question | 11/12 | 12/12 | 12/12 |

Confirmed top-10 answer hits by publisher (four questions each):

| Method | IEEE | Economist | Medium |
| --- | --- | --- | --- |
| Trigram, natural question | 3/4 | 3/4 | 2/4 |
| Semantic, natural question | 4/4 | 4/4 | 3/4 |
| Hybrid, same natural question | 3/4 | 4/4 | 4/4 |
| Trigram, source-informed keywords | 4/4 | 4/4 | 4/4 |
| Hybrid, separate keywords/question | 4/4 | 4/4 | 4/4 |

Concrete semantic gains over natural-question trigram retrieval:

- IEEE: putting calculation circuits above storage retrieves the memory-stacking
  explanation at semantic rank 1; lexical top 10 misses it. Same-question fusion
  also misses it, showing that fusion can bury a useful semantic candidate.
- Economist: asking why invasive treatments persist retrieves a passage about
  surgeons disbelieving evidence from placebo trials at semantic rank 1; lexical
  top 10 misses it. This alternate article was omitted by the fixed phrase check.
- Medium: the deleted-note question finds the explicit explanation that Projects
  reads the last uploaded copy at semantic rank 4; lexical top 10 misses it.
- Medium: the retirement-guideline question retrieves explanations of overly rigid
  withdrawal assumptions; lexical top 10 misses them. Shared-query hybrid places
  an explanatory paragraph first despite missing the fixed reference phrases.

The experiment supports semantic retrieval for paraphrased questions, while also
showing strong performance from well-chosen lexical terms. It does not establish
that semantic retrieval beats an LLM which reliably supplies the right keywords.
Split wording helps relative to shared-question hybrid, but did not outperform
the source-informed keyword baseline on these 12 questions. Keep both retrieval
signals available for further evaluation; do not infer that trigrams alone solve
the general retrieval problem from the first pilot.

**Operational blocker discovered:** the corrected filtered-vector evaluator
panicked inside `go-faiss.NewIDSelectorBatch`, called through
`zapx/v16.InterpretVectorIndex` when creating an exclusion selector with an empty
ID slice. This is a panic in a dependency goroutine, beyond the current returned-
error lexical fallback. The earlier native-error tests do not cover it. Production
enablement must wait for a fix and regression coverage.

The relevance results above use **unfiltered** vector retrieval as a diagnostic
workaround: this fresh whole-corpus pilot contains only current-model vectors, so
no scope or stale-model vectors need exclusion. The application still uses its
filtered path and the crash remains unresolved. No dependency was patched. An
earlier harness attempt selected the last duplicate model entry rather than the
application's first matching entry and returned zero vectors; those results were
discarded. The corrected evaluator asserts current-model coverage and nonempty
semantic candidates. Final output includes 1,765 matching current-model vectors.

Next work is to fix the native filtered-search crash, then improve fusion and
evaluate independently written user queries. These findings supersede treating
the initial document-presence metric as a reliable comparison of passage quality.

### Supervision and graceful degradation (2026-10-09)

Implemented the practical service behavior independently of further relevance
experiments. Query embedding starts alongside scope/index preparation; lexical and
vector searches overlap. Both lists retain the same scoped candidate selection
and rank-fusion rules. Semantic work has a 250 ms request deadline. Cold, slow,
unavailable, or failed inference returns lexical results without waiting for model
startup. Failed lexical retrieval can still return successful semantic candidates.
Returned native errors and recoverable panics in the calling goroutine become
semantic unavailability. Indexes and locks remain alive until the lexical goroutine
finishes; cancelled inference is joined before handler teardown.

This is a cooperative deadline: Go HTTP inference observes cancellation, but an
in-progress native FAISS call cannot be forcibly preempted safely in this process.
It is not an isolation boundary for arbitrary C crashes or dependency-goroutine
panics. The observed empty-selector panic is fixed at its source, not swallowed.
The pinned Go binding unconditionally dereferenced the first element of an empty
selector slice. Build/test commands now generate a Go compiler overlay passing a
nil C pointer when its length is zero. This leaves the shared module cache and
pinned FAISS ABI unchanged. Use `semantic:build` / `semantic:test` for vector builds
so the patch is applied. The build also ad-hoc-signs the macOS binary so launchd
can execute and restart it reliably.

Use the existing installer commands:

```sh
npm run semantic:install  # Install/start supervised loopback Ollama only.
npm run bleve:install     # Install/restart search with embeddings disabled.
# Explicit rollout, only when enabling live backfill is intended:
npm run semantic:enable   # Install/restart search with ARCHIVE_EMBEDDINGS=1.
```

Both LaunchAgents use `RunAtLoad`, `KeepAlive`, and a ten-second restart throttle.
Ollama persists the existing loopback host, project model path, and cloud-disabled
setting. Search persists one OpenMP thread and explicit semantic opt-in. Existing
config/root/port environment overrides can be saved when installing search. The
installer retries launchd's transient bootstrap error while a previous instance
finishes unloading. No startup dependency on Ollama is required: search serves
lexical results while inference is unavailable.

Initially installed supervised Ollama and updated the existing search LaunchAgent
with semantic indexing disabled. Subsequently enabled the live archive on
2026-10-09; automatic backfill started successfully. The installed search binary
includes these changes; restart testing
used a separate temporary LaunchAgent against the expanded pilot archive, then
removed that test agent.

Live activation checks returned five results per query. Two queries used hybrid
retrieval with partial coverage (133 current-model passages at that point), in
approximately 164 ms and 113 ms. A slower query returned lexical fallback in
approximately 274 ms. These are spot checks during ongoing backfill, not a
completed-coverage benchmark. The worker's first logged scan found 16,093 pending
passages in one workspace and began indexing batches of 16 automatically.

Validation: 13 Python setup/supervision tests, complete ordinary and vector Go
suites with the race detector, and MCP regressions passed. Tests cover empty native
selectors, cancellation of hanging inference with lexical results within the
request budget, recoverable vector panic, semantic results without lexical
results, limits/scopes, deterministic fusion, and persistent service settings.
The real expanded archive workload completed with filtered retrieval and current
model coverage of 1,765, without the prior crash. Warm requests in that run were
approximately 20–50 ms; cold model loading returned lexical results around 250 ms.
The supervised isolated search restarted in about seven seconds after SIGTERM;
Ollama restarted automatically, lexical results continued during model reload,
and hybrid retrieval resumed. Raw recovery results are in
`.local-mcp/semantic-pilot-expanded/recovery-results.json`.

## References

- [Bleve vector support and version-matched FAISS revisions](https://github.com/blevesearch/bleve/blob/master/docs/vectors.md)
- [Pinned Ollama release](https://github.com/ollama/ollama/releases/tag/v0.40.1)
- [Ollama macOS requirements](https://docs.ollama.com/macos)
- [Ollama environment variables](https://docs.ollama.com/faq)
- [Embedding API](https://docs.ollama.com/api/embed)
- [EmbeddingGemma model](https://ollama.com/library/embeddinggemma)
- [Google model documentation](https://ai.google.dev/gemma/docs/embeddinggemma)
