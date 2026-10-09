# ChatGPT conversation backup plan

Status: structured inventory and resumable page retrieval implemented; live authenticated compatibility verification pending.
Routine discovery reads loaded entries only after a settled full sidebar scan;
full traversal runs daily or on explicit Sync. Saved content is rechecked after
24 hours, rather than after every discovery. This is a local-age fallback:
remote update timestamps and ordering still need verification before safe
per-list watermarks and date-based early stopping can be enabled.
October 9, 2026.
Branch: `codex/chatgpt-conversation-backup`.
Work log: [chatgpt-backup-log.md](chatgpt-backup-log.md).

## Objective and scope

Back up ChatGPT projects and conversations into the local source archive, track
which conversations have been saved and which have changed, and incrementally
refresh the backup while the user has ChatGPT open in Chrome.

This feature serves three user outcomes:

1. **Backup:** recoverable local conversation content, available branches, and
   accessible attachments, with explicit freshness and completeness status.
2. **Better conversation search:** reuse the archive's lexical/hybrid search over
   saved transcripts, retaining conversation title, project, message context, and
   original ChatGPT URL so results can be identified and reopened. Backup status
   and indexing status are distinct; a saved conversation may not yet be searchable.
3. **Conversational RAG:** expose backed-up conversations through the existing
   archive MCP search and document-reading tools. The model retrieves relevant
   prior exchanges and uses them as cited context in a new conversation. Sync
   alone does not automatically inject all history into a chat or establish that
   prior assistant claims are correct. Preserve speaker attribution and treat
   retrieved messages as source material, not instructions.

Backup is the durable source; search and RAG are downstream consumers. Implement
these through the existing archive and MCP interfaces, extending metadata or
chunking only where conversation-specific validation demonstrates a need.

Sync is one-way: ChatGPT to local files. Do not send local edits back to ChatGPT,
delete remote conversations, submit messages, or mirror remote deletions into
local deletions. Keep this work separate from publication collection and ChatGPT
attachment handoff.

Use the user's existing logged-in Chrome session. Do not add a separate sign-in,
API key, or credential store for backup. Login expiry is a recoverable pause;
normal operation assumes the user is already signed in to ChatGPT.

## Existing infrastructure

- Website Reader already has a persistent side panel, Chrome storage, alarms,
  optional site access, and ChatGPT handoff in `background.js` and `popup.js`.
- The local Go service in `lexical-search/` watches configured directories
  recursively and indexes changed Markdown. Reuse it for local persistence and
  indexing rather than adding a second daemon.
- Use the existing archive connection settings. Do not introduce parallel
  configuration or flatten existing configuration into new runtime structures.
- The proposed source directory is `~/sources/ChatGPT`. It is separate from the
  rebuildable archive index directory. Add it to watched roots only when configured
  without overlapping an existing watched root.

## First implemented slice

The preview adds SQLite inventory and leased queue records, sidebar discovery,
inactive-tab rendered snapshot fetching, content-addressed JSON revisions, latest
Markdown, and panel Sync/Pause controls. Once enabled, ChatGPT navigation and
five-minute periodic checks request discovery while a user ChatGPT tab is open;
alarms also consume queued work. Explicit Sync forces a recheck. Stable source paths
currently use `<scope>/conversations/<id>` with project grouping in SQLite. The
project-name layout below remains proposed. Full remote JSON, branches, attachments,
archived history, verified account identity, reliable freshness markers, exhaustive
inventory, and direct response-completion detection remain pending. UI and saved
Markdown explicitly disclose incomplete coverage.

## Proposed storage

```text
~/sources/ChatGPT/
  projects/
    project-name--project-id/
      conversation-title--conversation-id/
        conversation.json
        conversation.md
        attachments/
  conversations/
    conversation-title--conversation-id/
      conversation.json
      conversation.md
      attachments/
```

Use stable remote IDs as identity; titles are display metadata. Finalize account
and workspace namespacing during discovery to prevent collisions and mixing
accounts. Renames and project moves must preserve identity and avoid duplicate
searchable transcripts. Validate names and containment; remote titles and IDs
must never become unchecked filesystem paths.

Preserve the available original conversation graph in JSON, including branches,
message IDs, roles, timestamps, citations, and attachment references. Generate
Markdown for reading and search, with an explicit branch policy. JSON and
Markdown are complementary backup and search representations. Preserve downloaded
attachments where accessible and record missing ones explicitly. Do not claim
complete backup when the website exposes only a partial transcript or references.

Persist the project/conversation inventory and fetch queue in SQLite in the local
service, reusing existing database infrastructure where it fits. SQLite is the
source of truth for progress; panel state and service-worker memory are not.
Record
remote ID, account/workspace, project membership, source URL, remote revision or
update time when available, saved content hash, local paths, last successful save,
last remote check, attachment completeness, and errors. Keep remote observations
distinct from successfully saved versions. Choose the smallest suitable schema
after discovery; justify any necessary new type before adding it.

## Discovery and background fetching

Discovery upserts projects and conversations into SQLite by account/workspace and
remote ID. It records observed metadata and schedules new or changed conversations.
Fetching is a separate background task consuming that persisted queue; it must
not depend on the discovered item remaining visible or the ChatGPT tab being active.
The two activities run sequentially on one owned temporary ChatGPT tab. Do not
interleave list navigation with conversation retrieval.

### Activity 1: inventory

First establish a verified full baseline for each account/workspace and each
independently paginated list (projects, project conversations, standalone chats,
and archives where accessible). Persist inventory pages and continuation state.
A safety limit, unchanged DOM, or absence of visible rows is not proof of complete
enumeration. Interrupted discovery resumes before starting conversation retrieval.

After that baseline, verify or request ordering by the latest conversation update
(latest entry only if verified to represent updates). Scan newest first, upsert
new/changed conversations, and stop once a verified descending page crosses the
previous successful watermark plus an overlap window. Handle timestamp ties,
pinned items, and independently ordered project lists explicitly. Do not use a
creation date or one global project watermark as a substitute. Commit watermarks
only after the relevant list scan completes successfully. Periodic full scans
reconcile omissions and metadata changes without deleting local backups.

### Activity 2: conversation retrieval

Once inventory finishes, consume its persisted queue one conversation at a time.
Fetch that conversation's structured pages sequentially; atomically save each
page and its continuation cursor before advancing. On interruption, resume from
the durable page checkpoint rather than restart the entire conversation. Verify
cursor reuse and revision consistency before reusing pages across refreshes.
Assemble JSON/Markdown and mark the conversation saved only after the required
pages have been retrieved and validated. A failed conversation remains queued
with its reason and retry time while other eligible conversations can proceed.

The visible phases should be inventory (baseline or incremental), conversation
retrieval, waiting/retry, and idle. Report inventory completion independently of
backup coverage. The implementation now uses this sequence; live authenticated endpoint compatibility remains to be verified.

Keep authenticated reads in the extension/browser session and local persistence,
queue ownership, and file writes in the local service. Verify the exact browser
request mechanism during discovery. If a page context is required, use an inactive
ChatGPT tab rather than navigating the user's working tab. Switching to another
browser tab must not pause or redirect a fetch. Closing the required ChatGPT context
or losing login may require reacquisition or a resumable pause; this is distinct
from merely changing the active tab.

Workers claim bounded jobs transactionally with recoverable leases. Retries and
duplicate delivery must be safe: repeated discovery creates no duplicate jobs,
repeated content saves create no duplicate files or revisions, and an expired
worker cannot acknowledge another worker's job. If a newer remote revision is
discovered during a fetch, saving the fetched version must leave the newer work
pending. Persist retry timing and failures. A file save that succeeds before a
queue acknowledgment must be safe to repeat after restart.

## 1. Verify browser access and completeness

- [x] Inspect project and conversation navigation read-only in the existing
      logged-in Chrome session. Initial findings are recorded in the work log.
- [ ] Verify how projects, project conversations, standalone conversations, and
      archived conversations are enumerated, including pagination and any actual
      nesting. Do not assume nested projects exist or that sidebar items are complete.
      Support Show more and infinite scrolling where present; persist discovered
      IDs before virtualized rows disappear, and distinguish stalled loading from
      a verified end of the list.
- [ ] Verify conversation retrieval, update markers, branch structure, attachment
      retrieval, account/workspace identity, and sign-in or access failures.
      A visible message timestamp is not a verified conversation revision marker.
- [ ] Determine whether complete retrieval can run without navigating the user's
      active conversation. Document any reliance on undocumented website interfaces.
- [ ] Capture sanitized deterministic fixtures; exclude cookies, tokens, account
      secrets, and private conversation text from repository fixtures and logs.
- [ ] Document verified capabilities and remaining limits in the work log before
      implementing bulk sync. Public OpenAI API conversations are not evidence of
      access to personal ChatGPT website history.

## 2. Implement local persistence and incremental inventory

- [ ] Add SQLite-backed project/conversation upserts and a durable fetch queue,
      with account/workspace isolation and unique remote identities. Discovery
      does not itself mark a conversation successfully backed up.
- [ ] Define a narrow local service interface for backup inventory and saves,
      following existing local-write protections. The service must not expose an
      unrestricted file-write API or accept page-origin requests as trusted writes.
- [ ] Implement ID-based, idempotent, atomic saves; retain the last good backup on
      interrupted writes, failed refreshes, or service unavailability.
- [ ] Save original JSON and readable Markdown; establish deterministic branch,
      citation, code-block, and attachment rendering.
- [ ] Track discovery separately from successful backup; advance the saved revision
      only after all required file writes succeed. Record attachment failures separately.
- [ ] Handle title changes and project moves without losing history or duplicating
      indexed content. Preserve prior meaningful revisions with an explicit policy.
- [ ] Reuse recursive indexing and existing search/MCP access for saved Markdown.

## 3. Implement resumable browser synchronization

- [ ] Enumerate every page of projects and conversations, including standalone
      conversations, traversing children only where the source actually supports them.
- [ ] Fetch new or changed conversations. Use verified remote revision markers;
      when absent or unreliable, use bounded content rechecks and hashes. Do not
      label unchecked content current.
- [ ] Consume the SQLite queue separately from list discovery, using bounded,
      transactional claims, recoverable leases, and idempotent completion. Recheck
      the queued revision before acknowledging to preserve updates found mid-fetch.
- [ ] Keep fetch targets bound to conversation IDs and authenticated contexts,
      independent of the active tab. Do not query the current tab to determine
      which queued conversation is being fetched or navigate the user's working tab.
- [ ] Persist queue progress and resume after panel closure, worker suspension,
      browser restart, or local service restart. Prevent overlapping sync runs
      across tabs; make repeated saves safe.
- [ ] Throttle requests, respect retry signals, and back off on transient failures.
      Pause on expired login or unavailable site access without discarding progress.
- [ ] Keep credentials in the browser session; do not persist them in the archive
      or pass them to the local service.
- [ ] Treat remote deletions and inaccessible conversations as observations, keeping
      local backups. Infer absence only after a complete, successful inventory scan.

## 4. Add panel controls and optional automatic sync

- [ ] Add enable/disable auto-sync, Sync now, Pause/resume, and destination display.
      Enabling automatic backup is explicit and persistent.
- [ ] Show discovered, backed-up, stale, incomplete, and failed counts, last scan,
      last successful backup, progress, and actionable errors.
- [ ] Distinguish not backed up, current as of last check, out of date, freshness
      unknown, and incomplete backup. Keep freshness and attachment completeness
      separate when both apply.
- [ ] Once enabled, opening ChatGPT triggers a throttled inventory check. Refresh
      the active conversation after a completed response, with debouncing and
      verified completion detection; never replace a good backup with a streaming fragment.
- [ ] Continue queued work independently of panel visibility while a usable ChatGPT
      session exists. State clearly when no open session is available to sync.
- [ ] Keep existing collection controls and ChatGPT handoff behavior intact.

## 5. Validate and document

- [ ] Test paginated inventory, duplicate titles, account/workspace isolation,
      project moves, renames, archived conversations, and deleted remote items.
- [ ] Test branches, code blocks, citations, attachments, partial content, and
      unsupported message types against sanitized fixtures.
- [ ] Test no-op sync, changed content, missing revision markers, retry/backoff,
      interruption, worker recovery, duplicate runs, and last-good-backup preservation.
- [ ] Test Show more, infinite scroll, virtualized rows, and stalled discovery.
- [ ] Test tab switching during discovery and fetching, panel closure, loss of
      the authenticated context, expired leases, duplicate job delivery, updates
      discovered mid-fetch, and restart between file save and queue acknowledgment.
- [ ] Test local write containment and rejection of untrusted callers.
- [ ] Verify saved Markdown becomes searchable through the existing archive.
- [ ] Validate conversation retrieval with representative exact-term and semantic
      queries across projects. Results must identify the conversation, original
      URL, speaker, and enough surrounding exchange to interpret the match. Confirm
      changed backups replace stale indexed content without duplicate results.
- [ ] Validate conversational RAG end-to-end through the existing MCP: retrieve
      a prior conversation, read surrounding context, and answer with source
      attribution. Keep user statements distinct from assistant claims and report
      unavailable, stale, or incomplete context accurately.
- [ ] Run relevant Go tests and `npm run test:extension`; perform the semantic
      refactor review of state, labels, counters, and persisted progress.
- [ ] Run a bounded live smoke test and report exact coverage and limitations.
- [ ] Update README and applicable permission/privacy documentation.

## Completion criteria

A complete inventory scan discovers every accessible conversation in the verified
scope. Each has a truthful local status and a recoverable backup or explicit failure.
A second unchanged sync avoids unnecessary content writes; an updated conversation
refreshes its files and search results. Interrupted sync resumes without losing the
last good backup. Automatic sync works after opt-in without requiring the side panel
to remain open. Switching active tabs does not interrupt queued fetching or change
its target. SQLite retains the inventory and pending work across restarts. Known
gaps are documented rather than presented as successful backup.

Search locates backed-up conversations and opens their original source; retrieval
preserves message context and attribution. An end-to-end MCP check demonstrates
that a new conversation can use relevant archived exchanges as cited evidence.
