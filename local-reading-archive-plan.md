# Local reading archive and MCP plan

Status: proposed implementation plan, October 5, 2026.

## Purpose

Give ChatGPT persistent access to previously collected and read material so it can
identify repeated reporting, recycled arguments, and meaningful new information.
The LLM chooses searches, inspects evidence, and searches again when necessary.
The collector should not preselect all historical context before the LLM can
decide what it needs.

Support conversations about one source, project, or tag, as well as the entire
archive. Answers should cite original documents and allow opening their local
files.

## Existing infrastructure and decisions

- Keep the Bleve service in this repository under `lexical-search/`, adapted
  from python-programmer. Building and running requires no other checkout.
  Preserve its existing API, chunk paths and line ranges, and workspace index
  aliases; see `lexical-search/README.md` for provenance and setup.
- Start with lexical retrieval. Bleve supports vector and hybrid retrieval, but
  embeddings, FAISS setup, and semantic chunking are separate work. Add them if
  evaluation shows lexical retrieval misses important paraphrases.
- Keep content independent of the search engine. Use `~/reading-archive` as the
  proposed archive root, with rebuildable indexes beneath it.
- Store each document once. Source and project directories organize files;
  semantic tags define overlapping logical shards through metadata.
- Distinguish collected content from content marked as read. A download alone
  does not establish that the user has read it.
- Reuse existing structures and interfaces directly. Avoid new wrappers or
  duplicated configuration unless the existing structures cannot support the
  required behavior.

## 1. Prove the local MCP connection

The user's ChatGPT Plus personal account exposes the custom MCP creation dialog
and its Tunnel connection option. Platform tunnel permissions and a successful
end-to-end call remain unverified.

1. Check Platform tunnel access and associate the tunnel with the intended
   personal ChatGPT workspace.
2. Run a minimal local MCP server with a hello-world tool.
3. Run the tunnel client and connect the server in ChatGPT.
4. Successfully invoke the tool from a ChatGPT web conversation.
5. Configure the server and tunnel client to start at login and restart after
   failure using macOS `launchd`. Verify recovery after restart.

The machine must be awake and the tunnel client connected for remote calls.
Do not build the archive integration until the connection has been demonstrated.

## 2. Archive and ingest content

Proposed layout:

```text
~/reading-archive/
  sources/
    economist/
    medium/
    chatgpt-conversations/
      project-name/
  summaries/
  indexes/
```

Preserve extracted source text, existing batch files, and provenance. Index
individual articles as identifiable documents even when they arrived inside an
issue or newsletter batch. Define stable document IDs, source URLs, titles,
publication and collection dates, project membership, tags, and read status.
Avoid duplicating article text solely to support different shards.

Initially, collect into `~/Downloads/website-reader/` and have the local service
import completed files. Chrome's downloads API chooses paths relative to the
Downloads directory; it cannot silently choose an arbitrary absolute archive
path. Import existing downloaded batches once. Make repeated imports idempotent
using normalized URLs and content hashes, and preserve meaningful revisions.

Later, send extracted content from Website Reader directly to the local service,
which writes archive files. Preserve the existing download workflow while this
integration is introduced.

Conversation import is a separate ingestion path: establish an export format and
how project identity is supplied before implementing it. Derive editable semantic
tags from content; do not duplicate files into tag directories.

## 3. Retrieval and chat scopes

Expose a small MCP interface for searching documents and retrieving additional
context. Search accepts optional source, project, tag, date, and read-status
filters. No scope filter means search the whole archive.

Return ranked passages with stable document IDs, source details, file locations,
and passage positions. Allow retrieving surrounding passages or the full
document. Preserve article headings and paragraph boundaries, and conversation
message boundaries, when chunking; evaluate the existing line-based chunker
before changing it.

ChatGPT should:

1. Identify the new article's substantive claims and evidence.
2. Choose searches against prior material, using shard summaries for orientation
   when helpful.
3. Retrieve source passages and reformulate searches as needed.
4. Explain what repeats earlier material, adds evidence, changes an outcome,
   contradicts earlier claims, or supplies a substantive new argument.
5. Cite the supporting documents and distinguish uncertainty from demonstrated
   repetition. Similar subject matter alone is not grounds for skipping content.

Shard chat and whole-archive chat use the same tools with different scope filters.

Tool descriptions and server instructions should explain when to search prior
reading and how to follow up with original passages. Validate ordinary requests
such as "Does this article add anything to what I've already read?" with the
plugin enabled, without naming a tool. Explicit tool-name prompts establish
connectivity but do not establish appropriate tool selection from user intent.

## 4. Maintain summaries for logical shards

Maintain a cited overview of each source, project, or tag: topics, claims,
supporting evidence, disagreements, and unresolved questions. Summaries guide
retrieval; original documents remain the evidence for answers.

On successful ingestion or a relevant document change:

1. Index the document and mark affected summaries as needing an update.
2. Queue an LLM worker to process new or changed material with relevant existing
   evidence.
3. Save the revised summary with document references and the versions it covers.
4. Show when a summary is stale or an update failed, and retry failed work.

Periodically reconstruct summaries from source documents to reduce distortion
from repeatedly summarizing summaries. Deletions and membership changes must also
invalidate affected summaries.

Automatic maintenance requires an API-backed worker or a local model; MCP alone
does not provide a background LLM or scheduler. Choose the model, execution mode,
and update cadence before implementing automation. ChatGPT-driven updates through
an MCP write tool can be an initial manual alternative.

## 5. Open retrieved local resources

Provide an MCP opener tool that accepts an archive document ID, resolves its
registered local file, and opens it in the default application on the Mac running
the service. Where feasible, support revealing the matched location.

Accept document IDs rather than arbitrary paths or shell commands. Return the
resolved document identity and an explicit success or failure result. Opening a
file is a separate action from read-only retrieval.

Do not depend on `file://` links in ChatGPT web: a valid file URL does not establish
that ChatGPT renders it as a clickable link or that the browser permits navigation
from a web page. A local HTTP document viewer is optional future work; the MCP
opener is the agreed initial approach.

## Milestones and validation

1. **Connection:** ChatGPT invokes a local hello-world tool; startup and restart
   behavior work.
2. **Retrieval:** Import a small archive, search it through ChatGPT, retrieve a
   passage, and open its original archived file through MCP.
3. **Collection:** Ingest Website Reader output without duplicate imports or lost
   provenance, and support source/project/tag scopes.
4. **Novelty assessment:** Evaluate known exact repeats, paraphrased repeats,
   same-topic articles with new evidence, contradictions, and unrelated articles.
   Check whether relevant prior evidence is retrieved and the LLM's conclusions
   are supported.
5. **Summary maintenance:** Verify incremental updates, citations, stale-state
   reporting, failure recovery, and reconstruction from source material.

Remaining decisions: conversation
import format, final archive location, summary worker/model, and update cadence.

## References

- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Chrome downloads API](https://developer.chrome.com/docs/extensions/reference/api/downloads)
- [Bleve vector search](https://github.com/blevesearch/bleve/blob/master/docs/vectors.md)
- [Bleve hybrid score fusion](https://github.com/blevesearch/bleve/blob/master/docs/score_fusion.md)

Shared service configuration is `~/.local-mcp/config.json`, beside the separate
API key. The extension edits port and archive root through the loopback service;
changes apply after restart and do not move existing archive files.

`index_directories` selects automatic indexing roots. Startup, 10-second polling,
and recursive filesystem notifications reconcile additions, edits, renames, and
deletions. Missing roots retain their indexes until accessible again. Directory
list changes take effect after restart; removing a root does not erase its index.

Archive MCP retrieval now exposes directory corpora as a hierarchy without
separate indexes. Search filters selected directory scopes before ranking;
parents include descendants. The default is 30 passages, configurable through
`search_limit` or a per-call limit. Reads and clickable browser links locate
exact indexed passages and return bounded document sections with pagination.
