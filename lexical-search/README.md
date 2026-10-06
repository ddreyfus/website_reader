# Local Bleve search service

This directory contains the service itself. No python-programmer checkout is
needed. Requirements: Go 1.21.3 or newer and Git on PATH.

From the repository root:

```sh
npm run bleve:build
npm run bleve:start
```

The server listens only on `127.0.0.1`. Stop it with Ctrl-C or SIGTERM. Without
PORT it reads `~/.local-mcp/config.json`, defaulting to port 8766. The file is
created with mode 0600 on first startup, beside the separate `runtime-key`.

```json
{
  "port": 8766,
  "archive_root": "~/reading-archive",
  "index_directories": ["~/reading-archive/sources", "~/Downloads"],
  "search_limit": 30
}
```

In the extension, expand **Local archive settings**, enter the current port,
and choose **Load settings**. Edit the startup port, archive folder, and directories to index (one per line), then
choose **Save settings**. Restart the service and load settings on the new port.
The running service keeps its current settings until restart. Changing the
archive folder does not move documents or indexes. If the service is unavailable,
edit the file directly and restart. Reload the extension after installing these
changes to enable its localhost permission.

`GET /api/v1/config` reports saved and active settings; `PUT /api/v1/config`
validates and atomically saves them. Neither endpoint reads the API key.
`LOCAL_MCP_CONFIG` overrides the configuration file path; `PORT` and
`READING_ARCHIVE_DIR` override active settings for development (they do not
change the saved file). `PORT=0` selects an ephemeral port. Invalid configuration
stops startup with an error. Indexes, SQLite metadata, and Git snapshots live
under `<archive_root>/indexes`. Source folders are indexed in place. The service
does not import Downloads or move files into the archive.

## Automatic indexing

On startup the service reconciles every configured directory. It repeats every
10 seconds and after filesystem events, coalesced over 250 milliseconds.
Subdirectories are watched recursively; new subdirectories receive watches on
the next reconciliation. The timer repairs missed events or unavailable watches.
Additions and edits are indexed; renamed files replace old paths; removed files
are deleted from both chunk metadata and Bleve. Empty directories are supported.
Updates and searches share workspace locks, so searches may wait during indexing.

The list defaults to empty for new installations. An empty list disables automatic
indexing. Changes to the list take effect on restart. Removing a directory from
the list stops its automatic updates but retains its existing index. An unavailable
root is retried while retaining its index, to avoid discarding results when a disk
is disconnected. File deletions inside accessible roots are reconciled normally.
Configured roots must be distinct, non-overlapping, and separate from index
storage; symlinked root paths are resolved, while traversal does not follow
symlinked subdirectories. Automatic indexing selects regular `.txt` and `.md` files, case-insensitively,
and validates their UTF-8 content. Empty files are known to the snapshot but
produce no searchable chunks. Symlinked files are excluded. This does not yet
add other encodings, PDF extraction, or bounded-memory indexing for huge files.

Filesystem events are provided by [fsnotify](https://github.com/fsnotify/fsnotify).
Signal-based shutdown cancels ongoing Git scans and stops the watcher.

Example (replace the source path with an existing directory):

```sh
curl -s http://127.0.0.1:8766/api/v1/health
curl -s http://127.0.0.1:8766/api/v1/workspaces \
  -H 'Content-Type: application/json' \
  -d '{"name":"economist","workTree":"/absolute/path/to/articles"}'
# Use the returned workspace UUID below.
curl -N -X GET 'http://127.0.0.1:8766/api/v1/updates?id=WORKSPACE_UUID' \
  -H 'Content-Type: application/json' -d '[]'
curl -s http://127.0.0.1:8766/api/v1/search \
  -H 'Content-Type: application/json' \
  -d '{"id":"WORKSPACE_UUID","databases":[],"query":"inflation","limit":10}'
```

Updates stream SSE and index changed files. Search returns matching text, paths,
line ranges, and scores. Additional source folders can be passed in `databases`
using the existing API schema in `openapi/`. Workspace IDs are UUIDs (the inherited
schema's 64-hex description is inaccurate). Run `npm run test:bleve` to verify
indexing, updates, and search using temporary fixtures.

On macOS with an older Go toolchain, a `missing LC_UUID` error requires
the external linker (and Xcode Command Line Tools). Re-sign the resulting
binary locally if macOS terminates it at startup:

```sh
GOFLAGS="-ldflags=-linkmode=external" npm run bleve:build
codesign --force --sign - .local-mcp/bin/lexical-search
GOFLAGS="-ldflags=-linkmode=external" npm run test:bleve
```

Queries and indexed content use the same lowercase character trigrams (three-character n-grams). A passage qualifies when any query trigram matches (OR). Results sort by Bleve relevance score; more matching trigrams contribute to the score, alongside term rarity, frequency and passage length. Corpus scope is enforced independently. Partial-word matches are intentional; very short queries with fewer than three characters produce no trigrams. Existing indexes need no rebuild for this query change.

This is lexical retrieval using the existing trigram analyzer and overlapping
chunks bounded by 32 lines or 4096 bytes, with up to 256 bytes of overlap. It is not semantic chunking or vector
search. Long paragraphs are split rather than skipped; chunk limits are in `config/config.go`.
Git snapshots contain indexed source history; deleting indexes also deletes
those snapshots. Protect the archive as you would the source documents.

The MCP process remains separate and calls the local retrieval endpoints. See
[archive tools and tunnel setup](../local-mcp-setup.md#archive-tools). Directory
corpora share the existing indexes, parent scopes include descendants, and
search results are ordered by relevance. `search_limit` sets the default passage
count (30; range 1–100), configurable in the extension. The browser viewer and
bounded document reads are available; automatic importing, summaries, and login
startup are subsequent steps.

## Provenance

Adapted from `python-programmer/lexical-search` at source repository commit
`2d6eb650e53b7ce6df118f885a7f72508e126773`. Runtime Go source, generated API types,
analyzers, module dependencies, and API schemas were copied; machine-specific
tests were replaced. Local changes select this project's archive directory,
bind to loopback, and use signal-based shutdown for standalone operation.
Existing API names, including MontyDatabase, are retained for compatibility.

No license file covering the original service was present in the source checkout.
This provenance note does not grant a new license. Dependencies retain their own
licenses through the Go module references.
# Search logging

Every archive search emits a JSON `archive_search` event to the service log, including its UTC timestamp, query, corpus IDs, requested limit, total matching passages, returned count, ordered document/chunk IDs and scores, elapsed milliseconds, HTTP status, and error when applicable. Passage text is omitted. Invalid requests are logged too; malformed JSON may leave the query empty. Total matches count passages, not distinct documents. Normal service startup captures these events in `.local-mcp/bleve.log`; searches made through MCP and directly through HTTP use the same logging path.

## Document and article inventories

`GET /api/v1/documents` lists indexed documents without a query. Optional `corpus_id` includes descendants; `path_contains` selects case-insensitive relative-path substrings, such as `economist`. Distinct files appear once regardless of their chunk count. Results sort by path and document ID.

`GET /api/v1/documents/:id/articles` streams the source file to list collected article anchors and original-email units in source order, excluding the table of contents and body subheadings. Entries include `kind`, title, anchor, heading level, line range, byte range, document ID, and browser URL. `inventory_mode=article_anchors` identifies our collection format. Other files return ATX Markdown headings with `kind=heading` and `inventory_mode=headings`; these are not verified article boundaries. Fenced-code headings are ignored. Scanning uses bounded line buffers; a heading exceeding 8192 bytes returns an explicit error instead of silently producing an incomplete inventory. Unstructured plain text can have no entries.

Both endpoints accept `offset` (entry count, not bytes) and `limit` (default 30, range 1–100). Follow `next_offset` until null to enumerate all entries; `total` refers to the selected inventory. This limit is independent of `search_limit`. Document lists reflect the current index; article inventories reflect the current source file, whose modification time and size are returned. Restart enumeration if files change between pages. Empty and unindexable files are absent from document lists. Inventories expose captured units, including unavailable article placeholders, not proof that all original publication content was collected. Read content before classifying topics.
