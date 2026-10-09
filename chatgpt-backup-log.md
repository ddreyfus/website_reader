# ChatGPT conversation backup work log

Plan: [chatgpt-backup-plan.md](chatgpt-backup-plan.md).
Branch: `codex/chatgpt-conversation-backup`.

## October 9, 2026 — Planning

- User confirmed one-way backup from ChatGPT into the local source archive.
- Created the feature branch from clean `main`.
- Added the implementation plan covering browser discovery, persistent inventory,
  local saves, resumable incremental sync, optional automatic sync, and validation.
- Proposed `~/sources/ChatGPT/projects/` and `~/sources/ChatGPT/conversations/`,
  with stable IDs, original JSON, searchable Markdown, and tracked attachments.
- Confirmed from repository inspection that the local service already watches
  configured directories recursively. Plan to reuse that indexing path.
- Website project enumeration, full conversation retrieval, remote freshness
  markers, branches, and attachment access remain unverified.
- No implementation, live account inspection, archive writes, or sync has run.
- Validation for this planning change: whitespace/diff checks only; no runtime
  changes requiring tests.

Next: read-only discovery of the logged-in ChatGPT website and sanitized fixtures.
Record evidence and limits here before implementing synchronization.

For subsequent entries, record changes, validation results, verified limitations,
and the next step. Keep credentials and private conversation content out of this log.

## October 9, 2026 — Initial logged-in website discovery

- User clarified that normal operation uses an already logged-in ChatGPT session.
  Made that assumption explicit in the plan; no separate authentication system is
  proposed. Expired sessions still need a resumable pause.
- Inspected the existing Chrome ChatGPT tab read-only. The site was signed in.
  Navigated from settings to the application, expanded one project, used its
  Show more control once, and opened one existing project conversation. No
  messages were submitted and no conversations were modified.
- Verified project conversation URLs expose both project and conversation IDs:
  `/g/g-p-<project-id>/c/<conversation-id>`. Standalone conversation links use
  `/c/<conversation-id>`.
- Verified the initially expanded project displayed five conversations and
  Show more exposed five additional conversation links. Navigation retained
  those additional entries. This proves incremental UI loading, not complete
  enumeration of all projects or conversations.
- Verified project conversations also occur in Recents. Inventory must deduplicate
  by conversation ID rather than title, URL occurrence, or sidebar section.
- The rendered conversation exposed Copy message and More actions controls and
  one machine-readable `time[datetime]`. Its timestamp semantics are unverified;
  it must not be used as proof that a backup matches the latest remote revision.
- Initial DOM inspection did not find the older `[data-message-author-role]` or
  `main article` message selectors. A collector must be based on the current
  observed structure rather than assumed historical ChatGPT markup.
- No authentication tokens, private message text, or real account/project IDs
  were saved into repository files. No full conversation JSON, attachments,
  network schemas, archived history, or account/workspace identity were retrieved.
- No implementation or backup ran. Existing user tab remains open at the inspected
  conversation; only navigation and project expansion changed.

Next: verify complete structured conversation retrieval and paginated inventory
interfaces, with sanitized schemas and fixtures, before implementing the writer.
Do not equate visible sidebar discovery with a complete or current backup.

## October 9, 2026 — Durable inventory and independent fetch queue

- User specified that project/conversation discovery syncs into SQLite, after
  which conversation fetching is an idempotent background task. Active-tab changes
  during processing must be supported.
- Updated the plan to make the local service's SQLite inventory and queue the
  source of truth. Discovery upserts stable identities; a separate worker consumes
  persisted jobs and writes backups through the local service.
- Added transactional claims, recoverable leases, duplicate-delivery handling,
  revision changes during fetch, and recovery after saving files but before
  acknowledging a job.
- Kept authenticated remote reads in the browser session. The exact mechanism
  remains to be verified; queued targets must never follow the currently active
  tab, and any required page context should use an inactive ChatGPT tab.
- Added Show more, infinite scroll, virtualization, stalled-discovery detection,
  tab-switching, and queue recovery to the validation plan. Infinite scroll itself
  has not yet been verified on the live site.
- Documentation only; no runtime implementation or backup ran.

## October 9, 2026 — Three intended outcomes

- User confirmed the feature is intended to provide backup, better conversation
  search, and conversational RAG.
- Made all three explicit in the plan. Local backups are the durable source;
  existing archive search and MCP retrieval are the downstream search/RAG path.
- Added validation for conversation identification and original URLs, speaker
  attribution, surrounding exchanges, refreshed search results, and end-to-end
  retrieval into a new conversation. Saved, indexed, fresh, and complete are
  separate properties and must not be conflated in status reporting.
- RAG retrieves selected prior exchanges; it does not imply automatic injection
  of all history or treat earlier assistant output as verified fact.
- Documentation only; implementation and end-to-end verification remain pending.


## October 9, 2026 — Rendered-snapshot preview implementation

- Added SQLite project/conversation inventory and a durable leased fetch queue to
  the existing local service, using its existing SQLite driver and database.
- Added idempotent discovery, explicit content rechecks, atomic claims, expired
  lease recovery, retry delays, and generation-aware saves. Content saved before
  a crash can be retried without duplicate JSON revisions or unnecessary rewrites.
- Added generated, validated source paths under `~/sources/ChatGPT`, symlink
  rejection, private file permissions, content-addressed JSON history, and latest
  Markdown with speaker labels and original conversation URLs.
- Added extension Sync/Pause controls and progress restoration. Discovery and
  fetching use an inactive owned tab; SQLite keeps the queue independently of
  panel visibility and active-tab changes. Alarms process bounded batches.
- Live DOM inspection verified Chat history, role-button project expanders,
  project links, rendered turn IDs, completed-response markers, and the conversation
  scroll region. Real ChatGPT data was not saved into the repository or archive.
- The adapter follows Show more and scrolls sidebar lists; capture scrolls rendered
  turns and deduplicates message keys. It preserves paragraph/code/link structure
  and rejects unsupported empty or unfinished conversations.
- Scope is deliberately labeled preview: rendered messages only; no complete raw
  conversation graph, alternate branches, attachment download, archived-history
  discovery, verified account/workspace identity, or verified remote revision
  timestamps. Exhaustive sidebar/virtualization coverage remains unproven.
- Stable ID-only source paths replace the proposed project-name folders for now;
  project grouping lives in SQLite. The user supplies a distinct account/workspace
  label and verifies the signed-in account. Indexing requires adding the source
  root to existing watched directories; no new search UI or RAG tool is added.
- Automatic discovery now follows ChatGPT navigation and five-minute periodic
  rechecks while a user ChatGPT tab is open, after first enabling with Sync.
  Requests persist through busy workers; owned backup tabs cannot trigger sync.
  Pause disables automatic work. Response-completion detection remains pending.
- Automatic-discovery regression tests passed for navigation, periodic checks,
  persistent requests, throttling, owned-tab exclusion, and paused backup.
  Full extension regression suite passed: 53/53 tests after this change.
- Fixed null injected discovery results during navigation/loading: validate the
  returned inventory before reading it, retry readiness for about 30 seconds,
  and preserve the pending request on failure. Missing history no longer counts
  as a successful scan. Snapshot and service responses also reject empty results
  with actionable errors. All four targeted backup tests pass, including recovery
  from transient null results and retained requests after persistent failure.
- Added persisted progress timestamps and last successful-save time, SQLite
  inventory/saved/pending/failed counts, discovery scan counts and sidebar passes,
  current conversation/batch/message/scroll progress, write activity, and elapsed
  retry waits. Empty queues now explain periodic checks. Switching account labels
  clears the previous label's displayed totals and successful-save time.
  Four targeted tests pass, including live panel updates, restored totals after
  reload, unchanged scope input while progress updates, and phase/count reporting.
  Inspected the rendered panel screenshot.
- Fixed the scroll-budget failure: use instant scrolling to avoid site smooth-scroll
  behavior, allow up to 160 passes for longer conversations, and require stable
  bottom content before saving. Failure diagnostics include conversation ID,
  collected-message count, and scroll position. The panel now retains the last
  200 timestamped backup progress events in a separate diagnostic disclosure.
  Tested smooth-scroll override and a conversation requiring more than 60 passes.
- Added daily (UTC day boundary)/25 MiB service log rotation with gzip compression,
  14-day retention and a 56-file cap per service. A shared Python supervisor
  captures stdout/stderr and forwards service shutdown signals; existing
  LaunchAgent configuration stays authoritative. Retained the legacy archive log
  as a compressed file, rebuilt/restarted the archive service, and reinstalled
  Ollama/tunnel LaunchAgents with the supervisor. Archive and Ollama endpoints
  return HTTP 200; MCP tunnel reports healthy/ready.
- Added backup service metadata logs for discovery, claims, saves, failures,
  generations, counts, duration, and retry timing. Snapshot bodies and lease
  tokens are excluded. Added Download backup log to the panel's independent,
  bounded diagnostic history. Rotation/supervisor tests (3), targeted extension
  and MCP runtime tests (5), and all Go package tests passed.
- Targeted Go queue/writer tests passed. Adapter and worker tests passed for
  discovery deduplication, Show more, simulated infinite scroll, code/link rendering,
  unfinished-response rejection, and ID-bound background fetching.
- Validation completed: all Go packages passed; all 52 extension regression tests
  passed. After the final state-review fixes, all Go packages and the three
  focused backup/browser-panel tests passed again. Whitespace checks passed.
- A save/index/search/read integration test demonstrated that snapshot Markdown
  is retrievable through existing archive APIs with role labels and source URL.
  This verifies the retrieval path, not a live model-generated RAG answer.
- State review tightened durable Sync requests made during another run, cancellation
  on account-label changes, unchanged-save behavior, and symlink-file rejection.
  No further findings beyond the documented preview limits.
- Live bulk backup and model-level conversational RAG validation have not run.
  The running local service and installed extension have not been replaced/reloaded.
  Rebuild/restart the service and reload the extension to use the preview.
- Panel preview captured at `/private/tmp/chatgpt-backup-preview.png` in an isolated
  test profile. No real user conversations were archived by the tests.

## 2026-10-09: direct retrieval investigation

- Observed successful signed-in website GET requests to
  `/backend-api/conversations/<id>?num_turns=10&include_has_versions=true`
  and `/backend-api/conversations/<id>/messages?before=<cursor>&num_turns=10&include_has_versions=true`.
  Response fields include `messages`, `current_node`, and `page_info` with
  `start_cursor`, `end_cursor`, `has_previous_page`, and `has_next_page`.
  The initial response had older pages; it must not be treated as a full backup.
- Direct fetching remains unimplemented: session authentication, complete-page
  assembly, branches, and failure handling still need validation. No sharing links
  were created; credentials and conversation bodies were not written to this log.
- Live DOM inspection found `column-reverse` and negative `scrollTop` offsets.
  Fixed oldest-message positioning and bottom detection for that layout, and
  wait at the oldest boundary while the older-message loading indicator exists.
  Added browser regression coverage for reverse scrolling and pending older pages.
- All four focused backup tests passed after this change; whitespace checks passed.
  State review found no additional issues in this patch. Real bulk completeness,
  direct authenticated requests, and alternate conversation branches remain unverified.
- Live attempt at 14:09:13 failed with the generic injected-result error; another
  job was claimed at 14:09:27. Page-side exceptions were being discarded by the
  worker. Added explicit error results from the injected adapter so progress and
  failed-job service logs retain the real reason. Four focused tests passed,
  including browser coverage for propagation of the older-page loading error.
- Added a persisted full-discovery checkpoint. After a settled full scan,
  automatic five-minute checks collect loaded sidebar entries without expanding
  Show more or scrolling through history; explicit Sync and daily reconciliation
  still traverse history. Account-label changes clear the checkpoint, and failed
  scans do not advance it. Unchanged inventory batches are not resubmitted.
- Saved snapshots are requeued only once locally 24 hours old, instead of on
  every scan. New IDs and changed titles/project membership still queue promptly.
  Existing-content edits without metadata changes may wait for the daily check.
  Remote updated-time ordering and per-project watermarks remain unverified;
  the sidebar does not expose timestamps to the current DOM adapter.
- Validation: four focused extension tests and the Go routes suite passed,
  including daily age eligibility and reuse of the full-scan checkpoint.
  Rebuilt the service with the existing vector-enabled build and restarted it.
- Clarified status: durable backup coverage is separate from mutually exclusive
  queue states (first backup, refresh, fetching, awaiting retry). Show up to three
  recorded failure reasons and explicitly retain unverified inventory coverage.
  Discovery reports whether it settled or hit its limit before content fetching;
  an incomplete discovery no longer schedules blanket saved-content rechecks.
- A failed conversation now records its retry and lets the batch continue with
  other conversations. Five focused extension tests passed, including a broken
  job followed by a successful job and mixed-state counter coverage.
- Revised the target design per user direction: two independent, sequential
  activities on one owned temporary tab. Inventory must establish a verified
  full baseline before update-ordered incremental early stopping; only then does
  the tab consume conversation jobs one at a time. Conversation pages and their
  continuation state must be durable before assembly. This is a plan correction,
  not a claim that the rendered preview now implements the design.

## 2026-10-09: structured sequential sync

- Replaced DOM scrolling with authenticated structured list and message-page reads on one inactive owned tab. Credentials stay page-local; local checkpoints bind the archive scope to the observed account/workspace identity.
- Inventory cursors, per-list baselines, verified descending update ordering, two-minute watermark overlap, and daily full reconciliation precede all job claims. Rejected inventory continuation cursors restart their list. First-page revalidation detects list changes during pagination.
- SQLite stores immutable conversation pages by generation and cursor. Lease-checked retries resume partial pages, verify the latest page, and assemble readable output only after the page chain completes. Rate limits create a shared cooldown; failures retain the last good backup.
- Progress events now reach service logs as well as the popup. Branches and attachment files remain excluded; authenticated endpoint compatibility needs live verification. Direct browser diagnostic navigation returned ERR_BLOCKED_BY_CLIENT, which does not establish a ChatGPT access rejection.
- Seven focused extension tests and route tests cover inventory gating, ordering, checkpoint resume, page replay/conflicts, generation restart, stale leases, and popup status. Full extension regression run is being checked separately.

- Follow-up: workspace verification incorrectly rejected an authenticated personal account whose `account_id` is null. Accept that explicit personal-account response without a workspace header; continue rejecting missing entries or workspace accounts without IDs. Added personal/null, valid workspace, and missing-workspace adapter regressions, with credential-free failure diagnostics. Reloaded the extension. The full extension regression suite passed all 56 tests before this small adapter follow-up.
- Live follow-up showed the selected cookie did not match an account-map key. Added quoted-string decoding, matching by explicit account ID, and the personal selector alias to an explicitly personal `default` entry; unknown selectors still pause. Added regressions for each supported selector. Credentials and account IDs remain excluded from diagnostics.
- Live verification at 14:58 EDT: workspace resolution succeeded and the projects list finished (two entries in this response). The subsequent conversation list returned HTTP 429; the shared cooldown retained the inventory checkpoint and blocked premature conversation claims. Added the retry delay to future rate-limit diagnostics.
