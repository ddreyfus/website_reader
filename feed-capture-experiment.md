# Feed capture experiment

## Status: incomplete, parked (2026-10-08)

The `codex/feed-capture-integration` branch preserves the recorder and the
in-progress page/article capture improvements. They are not ready to merge into
main. The Facebook investigation is paused; no Facebook post parser has been
implemented.

A signed-in Facebook recording produced a matching WebM and JSON event log and
stopped cleanly. The JSON contains message blocks, accessibility labels, image
descriptions, and DOM mutations as posts load and disappear. Some longer text
appears in separate attachment descriptions; this is not proof that expanded
post bodies are available without activating See more. Post boundary detection,
shared-post handling, complete-message extraction, and deduplication remain
unvalidated. Accessibility labels help identify authors and controls but did not
provide complete versions of the truncated messages examined.

The toolbar now uses an explicit action click to grant recording access. The
targeted article-tab and feed-capture regressions passed (15 tests); the native
video fixture uses a capture allowlist and does not validate the real toolbar
permission flow. The live recording predates this written status and is evidence
of capture, not parser correctness. Private recordings remain outside Git.

UI cleanup should proceed on a separate branch from main, without bringing these
experimental controls or extraction changes with it.

The first task is to preserve evidence before attempting to identify posts. This branch adds recording only; it does not parse, summarize, or automatically scroll Facebook or LinkedIn.

## Try a session

1. Reload Website Reader at `chrome://extensions` after switching to this branch. The experiment adds `activeTab` and `tabCapture` permissions.
2. Open the signed-in feed and click Website Reader's toolbar icon on that tab. This invocation grants the temporary tab-capture access.
3. Select **Record scrolling feed** in the panel. This integration branch exposes it directly beside **Capture current page**.
4. Select **Start recording** in the separate window. Grant access to the source site if Chrome asks. Return to the source tab, scroll slowly, pause on posts, and try **See more**.
5. Select **Stop recording** in the recorder. Save both the video and page/event log before closing that window. Downloads are explicit, separate links.

Keep the source visible and the recorder open. Recording ends after two minutes, when the page log exceeds approximately 50 MB, or when the source tab navigates, closes, or disconnects. It targets 30 fps at 12 Mbps; these are requests, not guarantees. Actual video cadence and legibility need measurement on the live feed. No audio or keyboard event listeners are installed. Rendered edits can still appear in DOM records.

## Saved evidence

The matching filenames identify one session:

- `feed-capture-<timestamp>.webm`: tab video, playable in the recorder after stopping.
- `feed-capture-<timestamp>.json`: source metadata, requested frame rate, reported video track settings, recording timestamps, stop reason, and ordered page records.

Page records include initial full HTML and node identity map; mutation batches with added/removed HTML, previous text/attribute values, sibling identities, and added-subtree identity maps; click coordinates; nested and document scroll positions; resize, visibility, and navigation events; and viewport text snapshots with text-node IDs and client rectangles. Text/layout snapshots are throttled to at most approximately two per second. Mutation batches are recorded independently of that throttle, so removed posts are not deliberately discarded while waiting for a snapshot.

Record timestamps use epoch milliseconds derived from each context's `performance.timeOrigin + performance.now()`. Recorder receipt timestamps help assess delivery delay. `videoStartRequestedAt` and `videoStartedAt` provide approximate anchors for video playback time. Each DOM snapshot includes its start and end timestamps. This is approximate synchronization, not atomic capture. MutationObserver batches also describe states at callback time, not every intermediate rendering state.

The recorder operates on the top-frame light DOM. Iframe DOM, closed/open shadow-root contents, canvas text, and accessibility-tree extraction are not implemented. Text rectangles are viewport candidates; clipping/occlusion by overlays or scroll containers is not fully resolved. The raw HTML and mutations intentionally include more than just visible content. The log is evidence for inspection, not a guaranteed replay format. Navigation stops a session rather than attaching to a new document.

Video and page data stay in memory until saved. Closing/crashing the recorder or browser loses unsaved data. The session cap bounds ordinary experimentation, but one huge DOM or mutation batch can exceed the size threshold before recording stops. The files may contain private feed content and page metadata; nothing is automatically uploaded or added to the reading archive.

## Validation

Run `node --test tests/feed-capture.test.mjs` or the full `npm run test:extension` suite. The feed fixture exercises expansion, nested scrolling, removal/replacement, initial and final capture, downloadable JSON, playable native tab-capture WebM, failed capture access, and invalidation of a source that navigates before starting. The isolated test browser uses a generated extension key and Chromium's test capture allowlist flag to grant that extension capture access instead of a toolbar invocation; production does not use that flag. Stream acquisition, frame-rate constraints, recording, messaging, and downloads are real. Toolbar permission flow and achieved frame rate/text readability on a signed-in social feed remain live validation steps. Native tab video uses Chrome's [tabCapture API](https://developer.chrome.com/docs/extensions/reference/api/tabCapture).

The next milestone is a short live feed recording: select a readable frame, find the same words in the initial HTML/mutations/snapshots, and determine whether author/body/permalink boundaries are present. If the visible words are absent, preserve that example to investigate accessibility or OCR before building a parser.
