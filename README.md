# Website Reader

Website Reader is a Chrome/Chromium extension that collects an entire Economist weekly edition into one Markdown document. It uses the active Economist browser session, preserves the issue's article order, checkpoints progress, and can copy the finished issue together with a detailed digest prompt for pasting into an AI chat.

## Capabilities

- Finds the article links in an Economist weekly-edition page and removes duplicate links.
- Fetches subscriber-accessible articles through the current signed-in browser session.
- Extracts article headings and readable text into Markdown.
- Produces one `economist-YYYY-MM-DD.md` file with issue metadata, a linked table of contents, article anchors, and separators.
- Identifies interactive or suspiciously short articles that cannot be extracted reliably and includes them as clearly marked unsupported entries with links to the originals.
- Spaces requests by 1–2 seconds and retries failures with exponential backoff, including server-provided `Retry-After` delays.
- Saves the article queue, completed content, current position, status, and detailed log in local extension storage so closing the popup does not discard progress.
- Pauses instead of producing a partial issue when an ordinary article cannot be collected or a CAPTCHA/browser challenge is encountered.
- Resumes a paused collection from its saved position after the problem is resolved.
- Downloads and displays the latest detailed collection log.
- Tracks completed and interrupted extension downloads; it cleans up partial files and removes failed downloads from Chrome's history when possible.
- Copies a completed issue followed by the bundled Economist digest prompt, ready to paste into an AI chat interface.

Website Reader currently supports weekly-edition pages under `https://www.economist.com/weeklyedition/`.

## Install locally

1. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose this `website_reader` directory.
5. After pulling or editing the extension files, use **Reload** on the extension card before testing the changes.

## Collect an edition

1. Sign in to `economist.com` with an account that can access the articles you want to collect.
2. Open the desired Economist weekly-edition page.
3. Open the **Website Reader** extension popup.
4. Select **Collect edition**.
5. Leave the edition tab open while collection runs. The popup may be closed and reopened without losing saved progress.
6. When collection finishes, choose where to save the generated `economist-YYYY-MM-DD.md` file.

The popup reports the current article, its position in the issue, the current attempt, and any retry delay. A download begins only after all ordinary articles have been collected; recognized unsupported interactive articles do not prevent completion.

## Resume an interrupted collection

Collection pauses if an article still fails after all retries, a browser challenge is detected, or the collection tab is closed or navigated away.

1. Read the status message in the popup.
2. If an **Open challenge** link appears, open it and complete the challenge yourself.
3. Return to the same weekly-edition page used to start the collection.
4. Open Website Reader and select **Continue collection**.

A saved collection is tied to its original edition URL and cannot be resumed from a different issue. If the completed issue's download fails, **Continue collection** retries the download without recollecting successful articles.

## Copy an issue for AI analysis

After an issue has completed, select **Copy issue and digest prompt**. The clipboard receives:

1. The complete generated issue Markdown.
2. A blank-line separator.
3. The instructions from [`economist-digest-prompt.md`](economist-digest-prompt.md).

Paste the result into an AI chat interface. The prompt asks the AI to process the issue sequentially, summarize each article using only that article as evidence, distinguish claims from evidence, and identify articles worth closer reading.

The Copy button also supports completed issues saved by an earlier extension version, provided their article Markdown remains in extension storage.

## View or download the log

- Expand **Latest detailed log** in the popup to inspect collection activity.
- Select **Download latest log** to save the current log as `website-reader.log`.

The log records cataloging, request timing, response status, extraction results, retries, pauses, downloads, and cleanup errors. Only the latest collection log is retained.

## Output and extraction limits

- Subscriber-only content is available only when the active Economist session has access to it.
- Extraction keeps headings, paragraphs, block quotes, and list items. Navigation, forms, scripts, styles, figures, buttons, footers, and hidden elements are omitted.
- Interactive pages are not reconstructed. They are represented by an unsupported notice and a link to the original article.
- Very short extractions are treated as unsupported because they are unlikely to contain a reliable full article.
- The extension does not bypass CAPTCHAs, browser challenges, subscriptions, or paywalls.

## Local data and permissions

Website Reader does not send collected content to an external service. Article content, progress, and logs remain in Chrome's local extension storage until replaced or removed through browser extension-data controls. Generated issues and logs are written through Chrome's download system; issue-and-prompt text is written to the clipboard only when **Copy issue and digest prompt** is selected.

The extension requests:

- `https://www.economist.com/*` to read weekly-edition pages and fetch their articles.
- `tabs` and `scripting` to verify the active edition tab and run collection in that tab.
- `storage` to checkpoint resumable progress and retain the latest log and completed issue.
- `downloads` to save Markdown and log files and clean up interrupted extension downloads.
- `clipboardWrite` to copy the completed issue and digest prompt on request.

## Troubleshooting

- **Collect edition is unavailable or reports the wrong page:** Open a URL under `https://www.economist.com/weeklyedition/`, then reopen the popup.
- **An article cannot be accessed:** Confirm that the Economist tab is signed in and that the account has access to the article.
- **Collection pauses on a challenge:** Use **Open challenge**, complete it, return to the same edition page, and select **Continue collection**.
- **Collection pauses after retries:** Try the original article in the browser, resolve any access or network problem, and then select **Continue collection**.
- **Copy is disabled:** Collection must be completed and its assembled Markdown—or the article Markdown from an earlier version—must still exist in extension storage.
- **Recent code changes do not appear:** Reload the unpacked extension from `chrome://extensions`, then reopen its popup.
