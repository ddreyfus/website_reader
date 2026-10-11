# Chrome Web Store Listing — Website Reader

UI cleanup: the ChatGPT action names the file it will attach and whether it is a chosen file or the latest completed collection. Refresh the panel screenshots before submission.

Last updated: 2026-10-11. Local development draft; no submission requested.

Free Press digests collect only Free Press articles. External email links and externally redirected sources are excluded from article extraction.

Newsletter filtering excludes Substack profiles, app actions, decorative links, and podcast utilities. Redirect destinations that are homepages, navigation, or media are discarded; linked pages never expand the email's article queue.

Medium newsletter site-access requests cover medium.com and its subdomains together. Separate publication domains still require their own access grant. Website Reader opens in a persistent side panel with a Close button; Chrome 141 or later is required. Store screenshots need refreshing for the side panel. Maps, addresses, and footer utility links are excluded from article collection.

## Store listing

Name: Website Reader

Short description: Collect publication issues or a Gmail newsletter and its linked articles into Markdown.

Detailed description: Save a publication issue or an expanded Gmail newsletter with its linked articles as one reading document. Preserve email commentary, article links, and source information, with newsletter filenames based on the sending domain. Copy a digest prompt or attach a completed batch or chosen Markdown/text file to a new ChatGPT draft. Import an unzipped ChatGPT export into your local conversation archive, including alternate branches. Missing articles are logged so collection can finish. Article access depends on your existing subscriptions and the site's availability.

Category: Productivity. Primary language: English.

Single purpose: Collect a reading batch for source-aware analysis.

## Graphics and assets

Store icon and screenshots are not prepared. Before publishing, capture the Gmail message selector, collection progress, and ChatGPT handoff. No icons are referenced by the manifest.

## Permissions justification

| Permission | Purpose |
|---|---|
| alarms | Resume saved email collection and queued ChatGPT snapshot backups after worker suspension. |
| clipboardWrite | Copy the selected digest prompt or local archive chat and its references on request. |
| downloads | Save reading documents and logs, clean up interrupted downloads. |
| scripting | Read the selected email or issue and attach the batch to ChatGPT when requested. |
| storage | Keep the current batch, progress, collection log, and a local archive chat draft with source excerpts. |
| sidePanel | Keep Website Reader visible beside article tabs and permission prompts until the user closes it. |
| tabs | Identify the current reading page, detect navigation, and open ChatGPT. |
| www.economist.com, alumni.berkeley.edu, cacm.acm.org, www.nytimes.com | Read supported issue pages and retrieve their linked articles. |
| mail.google.com | Capture the selected expanded email, including sender, date, body, and links. |
| Optional HTTP/HTTPS sites | Read article tabs linked by the selected email; request linked hosts and ask for redirected hosts on Continue. |
| Optional chatgpt.com | Attach selected reading content to a draft, or read authenticated conversation pages in inactive tabs after the user starts the backup preview. |

## Privacy and data use

The extension handles selected website content and personal communications, including sender addresses and any personal information present in the chosen email. The latest batch, source URLs, progress, and logs stay in local extension storage until replaced or removed. Downloaded files remain until the user deletes them.

Article requests use the browser session; destination sites receive normal requests, and tracking links may register clicks. Email text is not sent to linked sites. Chosen files are read only when Open in ChatGPT is selected and are not saved in extension storage. Open in ChatGPT sends the selected file or completed document to ChatGPT; submission of the chat remains under user control. There is no developer telemetry or developer-operated collection server.

The opt-in ChatGPT backup preview reads project/conversation lists and structured message pages using the signed-in browser session and sends them to the local archive service on this computer. Authentication credentials remain in the page and are not stored in the archive. It retains conversation content, titles, source URLs, project membership, an account/workspace identity, and resumable progress locally. Snapshots, page checkpoints, and prior JSON revisions remain until the user removes them; pausing or uninstalling does not delete backups. Accessible-list completion is tracked separately from backup completion. Alternate branches and attachment files are not backed up. Refresh screenshots to include the preview controls.

Local archive chat sends selected archive excerpts and conversation history only to the project-local Ollama service. Completed exchanges and evidence remain in extension local storage until cleared or replaced, and are not automatically ingested into the archive. Copy exports the transcript and evidence to the clipboard; Continue in ChatGPT explicitly uploads them as a Markdown attachment. Archive search queries follow the existing local service logging policy.

Data is not sold, used for unrelated purposes, or used for lending decisions. Users can remove optional site access in Chrome and remove extension data by uninstalling the extension. ChatGPT uploads are governed by that service's data controls.

## Privacy policy

The collapsed **Import from export** control reads conversation JSON from a folder
selected by the user and sends it only to the local archive service. It preserves
exported branches. Images and attachment files are skipped. The selected folder
is not added to indexed directories. Refresh panel screenshots for these controls.

The README's Local data and permissions section describes current behavior. A public privacy policy URL and contact details must be supplied before any store submission.

## Distribution and developer information

Local unpacked installation only. Publisher, public contact, support URL, distribution regions, and store visibility are unset.

## Version history

| Version | Date | Changes | Status |
|---|---|---|---|
| 0.1.0 | 2026-10-11 | Separate backup and export import into collapsed sections, with folder selection, processing progress, and retryable local imports. Move backup pacing and retry controls into Local archive settings. | Local draft |
| 0.1.0 | 2026-10-09 | ChatGPT structured-page backup preview with resumable local inventory and background queue. Inventory finishes before sequential conversation downloads. Verified update ordering enables incremental early stopping after a full baseline; full reconciliation runs daily. Shows backup coverage separately from queued work and retry reasons. Failed conversations do not stop other backups. Incomplete coverage is disclosed. | Local draft |
| 0.1.0 | 2026-10-08 | Explicit next ChatGPT file and source; accurate file-clearing control and current-page status. | Local draft |
| 0.1.0 | 2026-10-06 | Digest archive comparisons use a bounded NEW/ADDS/REPEAT familiarity test. | Local draft |
| 0.1.0 | 2026-10-06 | Existing Markdown/text attachment selection, explicit paused-batch replacement, and Economist weekly-edition navigation. Refresh control screenshots. | Local draft |
| 0.1.0 | 2026-10-05 | Recognize the current ChatGPT composer without relying on its former element ID. | Local draft |
| 0.1.0 | 2026-10-04 | ChatGPT handoff waits for the composer to become ready and distinguishes sign-in, upload, and attachment-confirmation failures. | Local draft |
| 0.1.0 | 2026-09-30 | Gmail newsletter collection, provenance-aware digest prompt, and optional ChatGPT handoff. Readable articles no longer pause merely because a background security script is present. | Local draft |

## Review notes

Gmail and ChatGPT page changes can break extraction or attachment. Clipped emails and short article previews are labeled. Some linked sites require rendered pages or reject requests. Link filtering is heuristic. Medium author, publication, and app-store links are excluded from article retrieval. Newsletter articles use rendered tabs; login, browser challenges, and missing site access pause collection until the user continues or skips. Managed article tabs close after reading or skipping. Automatic attachment uses the saved collection independently of download history. No store submissions or rejections recorded.
