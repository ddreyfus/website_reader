# Chrome Web Store Listing — Website Reader

Last updated: 2026-10-06. Local development draft; no submission requested.

Free Press digests collect only Free Press articles. External email links and externally redirected sources are excluded from article extraction.

Newsletter filtering excludes Substack profiles, app actions, decorative links, and podcast utilities. Redirect destinations that are homepages, navigation, or media are discarded; linked pages never expand the email's article queue.

Medium newsletter site-access requests cover medium.com and its subdomains together. Separate publication domains still require their own access grant. Website Reader opens in a persistent side panel with a Close button; Chrome 141 or later is required. Store screenshots need refreshing for the side panel. Maps, addresses, and footer utility links are excluded from article collection.

## Store listing

Name: Website Reader

Short description: Collect publication issues or a Gmail newsletter and its linked articles into Markdown.

Detailed description: Save a publication issue or an expanded Gmail newsletter with its linked articles as one reading document. Preserve email commentary, article links, and source information, with newsletter filenames based on the sending domain. Copy a digest prompt or attach a completed batch or chosen Markdown/text file to a new ChatGPT draft. Missing articles are logged so collection can finish. Article access depends on your existing subscriptions and the site's availability.

Category: Productivity. Primary language: English.

Single purpose: Collect a reading batch for source-aware analysis.

## Graphics and assets

Store icon and screenshots are not prepared. Before publishing, capture the Gmail message selector, collection progress, and ChatGPT handoff. No icons are referenced by the manifest.

## Permissions justification

| Permission | Purpose |
|---|---|
| clipboardWrite | Copy the selected digest prompt on request. |
| downloads | Save reading documents and logs, clean up interrupted downloads. |
| scripting | Read the selected email or issue and attach the batch to ChatGPT when requested. |
| storage | Keep the current batch, progress, and log for resuming collection. |
| sidePanel | Keep Website Reader visible beside article tabs and permission prompts until the user closes it. |
| tabs | Identify the current reading page, detect navigation, and open ChatGPT. |
| www.economist.com, alumni.berkeley.edu, cacm.acm.org, www.nytimes.com | Read supported issue pages and retrieve their linked articles. |
| mail.google.com | Capture the selected expanded email, including sender, date, body, and links. |
| Optional HTTP/HTTPS sites | Read article tabs linked by the selected email; request linked hosts and ask for redirected hosts on Continue. |
| Optional chatgpt.com | Attach the completed batch to a ChatGPT draft when the user selects Open in ChatGPT. |

## Privacy and data use

The extension handles selected website content and personal communications, including sender addresses and any personal information present in the chosen email. The latest batch, source URLs, progress, and logs stay in local extension storage until replaced or removed. Downloaded files remain until the user deletes them.

Article requests use the browser session; destination sites receive normal requests, and tracking links may register clicks. Email text is not sent to linked sites. Chosen files are read only when Open in ChatGPT is selected and are not saved in extension storage. Open in ChatGPT sends the selected file or completed document to ChatGPT; submission of the chat remains under user control. There is no developer telemetry or developer-operated collection server.

Data is not sold, used for unrelated purposes, or used for lending decisions. Users can remove optional site access in Chrome and remove extension data by uninstalling the extension. ChatGPT uploads are governed by that service's data controls.

## Privacy policy

The README's Local data and permissions section describes current behavior. A public privacy policy URL and contact details must be supplied before any store submission.

## Distribution and developer information

Local unpacked installation only. Publisher, public contact, support URL, distribution regions, and store visibility are unset.

## Version history

| Version | Date | Changes | Status |
|---|---|---|---|
| 0.1.0 | 2026-10-06 | Digest archive comparisons use a bounded NEW/ADDS/REPEAT familiarity test. | Local draft |
| 0.1.0 | 2026-10-06 | Existing Markdown/text attachment selection, explicit paused-batch replacement, and Economist weekly-edition navigation. Refresh control screenshots. | Local draft |
| 0.1.0 | 2026-10-05 | Recognize the current ChatGPT composer without relying on its former element ID. | Local draft |
| 0.1.0 | 2026-10-04 | ChatGPT handoff waits for the composer to become ready and distinguishes sign-in, upload, and attachment-confirmation failures. | Local draft |
| 0.1.0 | 2026-09-30 | Gmail newsletter collection, provenance-aware digest prompt, and optional ChatGPT handoff. Readable articles no longer pause merely because a background security script is present. | Local draft |

## Review notes

Gmail and ChatGPT page changes can break extraction or attachment. Clipped emails and short article previews are labeled. Some linked sites require rendered pages or reject requests. Link filtering is heuristic. Medium author, publication, and app-store links are excluded from article retrieval. Newsletter articles use rendered tabs; login, browser challenges, and missing site access pause collection until the user continues or skips. Managed article tabs close after reading or skipping. Automatic attachment uses the saved collection independently of download history. No store submissions or rejections recorded.
