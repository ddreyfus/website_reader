# Local article summarization: follow-up work

Recorded 2026-10-09. This is a shortlist and implementation direction, not a measured model ranking.

## Relationship to semantic search

The project's `embeddinggemma:300m` model produces vectors for retrieval; it cannot generate summaries. Summarization requires a separate text-generation model, which can use the existing project-local Ollama service at `127.0.0.1:11435`. A second service is not inherently required.

Embedding and summarization requests would share memory and compute. Search's bounded embedding wait and lexical fallback help preserve search availability during contention, but summarization concurrency and context size still need sensible limits. See [SEMANTIC_SEARCH.md](SEMANTIC_SEARCH.md) for the existing retrieval setup.

## Model shortlist

Start with **Qwen3.5 9B**, and compare it with **Gemma4 12B**. Neither has been tested on this archive, and no summarization model has been installed as part of this discussion.

| Model | Approximate download size | Reason to consider |
| --- | --- | --- |
| Qwen3.5 4B | 3.3–4 GB | Smaller candidate when speed and memory matter most |
| Qwen3.5 9B | 6.6–7.6 GB | Initial candidate for everyday article summaries |
| Gemma4 12B | 7.7–8 GB | Primary comparison candidate |
| Ministral 3 14B | 9.1 GB | Additional candidate for document work |
| Qwen3.5 27B / Gemma4 26B–31B | 16–20 GB | Larger alternatives if smaller models miss important details |
| GPT-OSS 20B | 14 GB | Candidate for summaries requiring more involved synthesis |

Sizes reflect the Ollama listings checked on the recorded date and vary by variant/quantization. They are file sizes, not total memory requirements. Context length, concurrent requests, and the embedding model add memory overhead. Verify available tags and compatibility with the installed Ollama version before downloading.

Sources: [Qwen3.5](https://ollama.com/library/qwen3.5), [Gemma4](https://ollama.com/library/gemma4), [Ministral 3](https://ollama.com/library/ministral-3), [GPT-OSS](https://ollama.com/library/gpt-oss), [EmbeddingGemma model card](https://ai.google.dev/gemma/docs/embeddinggemma/model_card).

## How to choose

General reasoning, coding, and knowledge benchmarks do not establish a summarization ranking for our archive. Compare actual summaries of IEEE, Economist, and Medium articles using the same source text, prompt, output-length target, and comparable runtime settings.

Prioritize:

1. **Faithfulness:** preserve claims, numbers, attribution, and uncertainty; do not invent facts or conclusions.
2. **Coverage:** capture the central argument and important qualifications.
3. **Conciseness:** follow the requested length without filler.
4. **Practical cost:** measure latency and memory, including the effect on simultaneous search requests.

Use complete article text where it fits. For longer documents, explicitly account for truncation or chunking rather than silently dropping material. Record exact model tags, quantization, context settings, prompt, and cold/warm timings so comparisons are reproducible.

## Next implementation steps

- Check available memory and the installed Ollama version; select a compatible model variant.
- Install the initial candidate in the existing project-local model store and try representative article summaries.
- Compare the second candidate only as needed to resolve quality or performance concerns; avoid turning this into a broad benchmark project.
- Reuse the existing Ollama service and configuration structures. Keep model choice explicit per operation, and keep summarization outside the search response path unless a later feature explicitly requires it.
- Bound summarization concurrency and request duration, report failures clearly, and verify that concurrent summarization leaves search usable.

This note does not enable semantic indexing, install models, or add a summarization endpoint.

## Archive chat in the extension (separate follow-up)

Recorded 2026-10-09. Keep this work separate from the ChatGPT backup branch; leave this note out of that branch's commit.

Add an Archive Chat tab for fast local search, summaries, and follow-up questions. Reuse the archive HTTP search/read endpoints and the project-local Ollama service. The existing `scripts/mcp-archive.mjs` exposes those same endpoints through stdio MCP; a browser extension would need a bridge for that transport. A shared HTTP MCP interface remains an option if interoperability becomes useful.

MCP provides tool discovery and invocation transport; the application still supplies tools to the model and executes its requests. Natural search behavior depends on model instructions, tool definitions, and application routing, whether retrieval uses MCP or direct HTTP. See [Ollama tool calling](https://docs.ollama.com/capabilities/tool-calling).

Start with retrieval by default for new archive questions: the user should not need to say "search." Show matches immediately, then stream a cited answer from a bounded set of relevant passages. Reuse already retrieved passages for requests such as "make that shorter"; retrieve again for a new topic or a question the existing passages cannot support. Explicitly distinguish missing evidence from a supported answer.

If adaptive retrieval is needed, provide a tool-capable generation model with the existing `search_archive` and `read_document` operations, concise usage instructions, and a bounded tool loop. The local service validates and executes calls and returns source metadata. Benchmark this against default retrieval for latency, missed searches, unnecessary searches, and unsupported answers before choosing the routing policy. Tool calling support and reliable search decisions must be tested for the exact installed model.

Keep context and concurrency bounded, preserve citations in follow-ups, and treat retrieved text as source material rather than instructions. This is a design note; no chat UI, model installation, or tool loop is implemented here.


## Implementation on `codex/local-archive-chat`

### Remaining archive chat TODOs

- Before the initial archive search, give the LLM the user's prompt and recent conversation (if any) so it can determine the evidence needed and formulate one or more targeted search queries. This applies to the first prompt as well as follow-ups; users should not have to phrase their requests as search queries. Bound query planning and any subsequent search/read tool loop, and evaluate retrieval quality, latency, and memory use.
- Summarize complete long documents through chunking and synthesis rather than only their beginning.
- Stream answers as they are generated.
- Evaluate a smaller generation model and explicit model-unload controls for memory-constrained use.
- Evaluate answer faithfulness, citation support, and coverage on representative archive questions and articles.

The extension now has a local archive chat preview using the existing search/read
endpoints, a bounded Ollama generation endpoint, stable source labels, local draft
persistence, document summaries (explicitly partial above 6000 bytes), and an
explicit transcript/evidence handoff to ChatGPT. It uses default retrieval on each
question; adaptive tool calling and multi-part long-document summaries remain
future work. Draft chats are not automatically archived. See README for limits.

Live smoke check on 2026-10-09: installed `qwen3.5:9b` in the existing project
Ollama store. The running vector-enabled archive service discovered it as a
completion model. A real archive search for solar power supplied three excerpts
from `CACM Sept 2026.pdf`; the model returned a cited answer in 38.0 seconds and
a cited follow-up in 6.9 seconds. Neither reached the output cap. A concurrent
search returned three results in 0.146 seconds with partial semantic coverage.
These checks verify integration, not factual accuracy or a model ranking.

Validation: 56 existing extension tests plus the new archive-chat browser test
passed. The new test covers draft restore, follow-up evidence reuse, safe text
rendering, failure preservation, partial document summaries, exact handoff
payloads, and clearing a draft from another panel during inference. All ordinary
and vector-enabled Go packages and 13 semantic Python tests passed. Corrected a
pre-existing LaunchAgent test expectation for the log supervisor. Reviewed state,
source labels, partial coverage, context bounds, and explicit handoff behavior;
no outstanding implementation findings. Live ChatGPT upload was not repeated
with real archive content; the existing handoff regression tests passed.

UX/context follow-up: question controls now precede the conversation; Search/Ask
and Copy/Continue use paired responsive rows. Search results and references use
native disclosures. Search opens its results; Ask leaves them collapsed. Clear
search removes the input/results while retaining the conversation. New answers
scroll into view without resetting the scroll position on unrelated actions.
The model receives up to two recent exchanges and selected evidence within the
existing 10,000-byte budget, with current retrieval prioritized. Full draft and
source excerpts remain stored/exportable. Explicit validated source labels keep
citations stable for nonconsecutive selections; reduced context is disclosed.
Focused browser and Go tests passed, including a 24-message/27-source draft,
search clearing, paired button positions at 420px, and exact source-label reuse.
A live request with only source S17 returned an answer citing S17. Rebuilt and
restarted the service with semantic opt-in preserved, reloaded the extension,
and verified the revised controls in the installed Chrome panel.

Pop-out follow-up: Pop out chat opens a resizable chat-only extension window;
Return to side panel reopens the original browser's side panel and closes the
pop-out. Completed draft/evidence, selected model, unsent composer text, and
archive connection are preserved. Repeated pop-out requests focus the existing
window. The ChatGPT handoff accepts the same trusted extension page with its
pop-out query parameters. Browser tests cover pop-out/return, reuse, composer
preservation, and an actual mocked ChatGPT attachment from the pop-out; eight
handoff regressions pass. No model-residency policy was changed: generation still
uses keep_alive=2m, and UI closure/docking does not explicitly unload a model.
The running Ollama process inspection showed Qwen unloaded and only the roughly
680 MB embedding model resident.
