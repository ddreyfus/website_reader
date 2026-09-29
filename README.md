# Website Reader

Website Reader is a Chrome/Chromium extension that collects an entire publication issue into one Markdown document. It uses the active browser session, preserves the issue's article order, checkpoints progress, and can copy a publication-targeted digest prompt after the issue is uploaded to an AI chat.

## Capabilities

- Finds article links on supported issue pages and removes duplicate links.
- Fetches subscriber-accessible articles through the current signed-in browser session.
- Extracts article headings and readable text into Markdown.
- Produces one publication-named Markdown file with issue metadata, a linked table of contents, article anchors, and separators.
- Identifies interactive or suspiciously short articles that cannot be extracted reliably and includes them as clearly marked unsupported entries with links to the originals.
- Spaces requests by 1–2 seconds and retries failures with exponential backoff, including server-provided `Retry-After` delays.
- Saves the article queue, completed content, current position, status, and detailed log in local extension storage so closing the popup does not discard progress.
- Pauses instead of producing a partial issue when an ordinary article cannot be collected or a CAPTCHA/browser challenge is encountered.
- Resumes a paused collection from its saved position after the problem is resolved.
- Downloads and displays the latest detailed collection log.
- Tracks completed and interrupted extension downloads; it cleans up partial files and removes failed downloads from Chrome's history when possible.
- Copies the bundled issue digest prompt, targeted to the publication in the active tab and ready to paste into an AI chat after manually uploading the issue.

Website Reader supports all issue pages under:

- `https://www.economist.com/weeklyedition/`
- `https://alumni.berkeley.edu/issue/`
- `https://cacm.acm.org/issue/`

## Install locally

1. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose this `website_reader` directory.
5. After pulling or editing the extension files, use **Reload** on the extension card before testing the changes.

## Test

Install the test dependency and Chromium once:

```sh
npm install
npx playwright install chromium
```

Then run:

```sh
npm test
```

The integration test loads the unpacked extension in a temporary Chromium profile and exercises the popup, active-tab detection, article discovery, ordered collection state, publication filenames, and copied Economist prompt. Publication pages and articles are supplied as deterministic browser fixtures, so the test does not crawl live issues.

## Collect an issue

1. Sign in to the publication if its articles require an account.
2. Open a supported issue page.
3. Open the **Website Reader** extension popup.
4. Select **Collect issue**.
5. Leave the issue tab open while collection runs. The popup may be closed and reopened without losing saved progress.
6. When collection finishes, choose where to save the generated Markdown file.

The popup reports the current article, its position in the issue, the current attempt, and any retry delay. A download begins only after all ordinary articles have been collected; recognized unsupported interactive articles do not prevent completion.

## Resume an interrupted collection

Collection pauses if an article still fails after all retries, a browser challenge is detected, or the collection tab is closed or navigated away.

1. Read the status message in the popup.
2. If an **Open challenge** link appears, open it and complete the challenge yourself.
3. Return to the same issue page used to start the collection.
4. Open Website Reader and select **Continue collection**.

A saved collection is tied to its original issue URL and cannot be resumed from a different issue. If the completed issue's download fails, **Continue collection** retries the download without recollecting successful articles.

## Analyze an issue with AI

After collection finishes:

1. Upload the generated issue Markdown file to the AI chat interface.
2. Select **Copy digest prompt** in Website Reader.
3. Paste the prompt into the chat and submit it with the uploaded Markdown.

The Copy button places only the instructions from [`issue-digest-prompt.md`](issue-digest-prompt.md) on the clipboard; it does not copy the issue or create another file. Its publication name follows the active site. Economist-specific instructions for The World This Week and Leaders are retained; other publications receive equivalent generic guidance. The prompt asks the AI to process the uploaded issue sequentially, summarize each article using only that article as evidence, distinguish claims from evidence, and identify articles worth closer reading.

## View or download the log

- Expand **Latest detailed log** in the popup to inspect collection activity.
- Select **Download latest log** to save the current log as `website-reader.log`.

The log records cataloging, request timing, response status, extraction results, retries, pauses, downloads, and cleanup errors. Only the latest collection log is retained.

## Output and extraction limits

- Subscriber-only content is available only when the active publication session has access to it.
- Extraction keeps headings, paragraphs, block quotes, and list items. Navigation, forms, scripts, styles, figures, buttons, footers, and hidden elements are omitted.
- Interactive pages are not reconstructed. They are represented by an unsupported notice and a link to the original article.
- Very short extractions are treated as unsupported because they are unlikely to contain a reliable full article.
- The extension does not bypass CAPTCHAs, browser challenges, subscriptions, or paywalls.

## Local data and permissions

Website Reader does not send collected content to an external service. Article content, progress, and logs remain in Chrome's local extension storage until replaced or removed through browser extension-data controls. Generated issues and logs are written through Chrome's download system; only the digest prompt is written to the clipboard when **Copy digest prompt** is selected.

The extension requests:

- Access to `www.economist.com`, `alumni.berkeley.edu`, and `cacm.acm.org` to read issue pages and fetch their articles.
- `tabs` and `scripting` to verify the active issue tab and run collection in that tab.
- `storage` to checkpoint resumable progress and retain the latest log and completed issue.
- `downloads` to save Markdown and log files and clean up interrupted extension downloads.
- `clipboardWrite` to copy the digest prompt on request.

## Troubleshooting

- **Collect issue is unavailable or reports the wrong page:** Open a supported issue URL listed above, then reopen the popup.
- **An article cannot be accessed:** Confirm that the publication tab is signed in when required and that the account has access to the article.
- **Collection pauses on a challenge:** Use **Open challenge**, complete it, return to the same issue page, and select **Continue collection**.
- **Collection pauses after retries:** Try the original article in the browser, resolve any access or network problem, and then select **Continue collection**.
- **The copied text does not include the issue:** This is intentional. Upload the downloaded Markdown to the AI chat separately, then paste the copied digest prompt.
- **Recent code changes do not appear:** Reload the unpacked extension from `chrome://extensions`, then reopen its popup.
