# Website Reader

For **The Free Press** emails, only Free Press article pages (`thefp.com/p/…`) are collected. Direct external links are excluded; Substack tracking redirects are checked and discarded if they lead outside Free Press. External citations remain in the original email text.

Newsletter collection follows only the selected email's article candidates. It never adds links discovered on opened pages. Author profiles, app actions, empty decorative-image links, and podcast utility links are excluded. Redirects that land on homepages, navigation, or media are discarded before extraction or a site-access request.

Website Reader opens beside the page in Chrome's side panel and stays open across article tabs and site-access prompts. Use **Close** to dismiss it and the extension icon to reopen it. Chrome 141 or later is required. **Continue collection** and **Skip article** act on the saved source batch even while its article tab is selected. Maps, address links, and footer utility links remain in the original email text but are not opened as articles.

Website Reader is a Chrome/Chromium extension that collects an entire publication issue into one Markdown document. It uses the active browser session, preserves the issue's article order, checkpoints progress, and can copy a publication-targeted digest prompt after the issue is uploaded to an AI chat.

## Capabilities

The `codex/feed-capture-integration` branch combines the separately preserved
`codex/feed-capture-experiment` and `codex/tunnel-recovery` branches. It includes
current-page capture and an opt-in [feed recording experiment](feed-capture-experiment.md)
for investigating scrolling feeds before writing a post parser. Reload the
unpacked extension after switching branches so Chrome uses the checked-out code.

- Finds article links on supported issue pages and removes duplicate links.
- Fetches subscriber-accessible articles through the current signed-in browser session.
- Extracts article headings and readable text into Markdown.
- Produces one publication-named Markdown file with issue metadata, a linked table of contents, article anchors, and separators.
- Identifies interactive or suspiciously short articles that cannot be extracted reliably and includes them as clearly marked unsupported entries with links to the originals.
- Spaces requests by 1–2 seconds and retries failures with exponential backoff, including server-provided `Retry-After` delays.
- Saves the article queue, completed content, current position, status, and detailed log in local extension storage so closing the popup does not discard progress.
- Logs and skips unreadable articles without blocking the issue: permanent HTTP errors and browser challenges are skipped immediately; temporary failures are skipped after retries. Skipped articles are removed from the count and output.
- Resumes a paused collection from its saved position after the problem is resolved.
- Downloads and displays the latest detailed collection log.
- Tracks completed and interrupted extension downloads; it cleans up partial files and removes failed downloads from Chrome's history when possible.
- Copies the bundled issue digest prompt, targeted to the publication in the active tab and ready to paste into an AI chat after manually uploading the issue.

Website Reader supports all issue pages under:

- `https://www.economist.com/weeklyedition/`
- `https://alumni.berkeley.edu/issue/`
- `https://cacm.acm.org/issue/`
- `https://www.nytimes.com/` (homepage article links, using your signed-in session)
- `https://mail.google.com/` (an expanded email and its linked articles)

## Install locally

1. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose this `website_reader` directory.
5. After pulling or editing the extension files, use **Reload** on the extension card before testing the changes.

## Local archive service

The local MCP hello-world experiment has separate
[tunnel setup and troubleshooting instructions](local-mcp-setup.md), including
`npm run mcp:start`, `npm run mcp:stop`, and `npm run mcp:status`. Its archive design
is recorded in [the local reading archive plan](local-reading-archive-plan.md).

For persistent archive access on macOS, configure the tunnel profile and private
runtime key using those instructions, then run `npm run mcp:install` once. This
installs a user LaunchAgent that starts the tunnel at login and restarts it after
process exits, with a ten-second restart throttle. `npm run mcp:status` reports
the supervised process state plus separate health and readiness checks.
`npm run mcp:stop` deliberately unloads the tunnel until `npm run mcp:start` or
the next login. Bleve is supervised separately using `npm run bleve:install`;
a healthy Bleve endpoint alone does not prove that ChatGPT can reach the archive.

The tunnel client retries network interruptions while running. Sleep, logout,
lost internet, expired/revoked credentials, and upstream service errors can still
make archive tools unavailable. The LaunchAgent cannot keep a sleeping/offline
Mac reachable or repair credentials. A fresh Website Reader Local `hello` and
archive search verify the complete connection after recovery. Detailed client
logs are in `~/Library/Application Support/tunnel-client/logs/website-reader-archive.log`;
LaunchAgent output is in `.local-mcp/tunnel.log`.

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

## Capture a current page or scrolling feed

Open any HTTP/HTTPS page and open Website Reader from its toolbar icon. The panel
shows **Capture current page** and **Record scrolling feed** directly, including
on sites outside the publication issue list. Unsupported pages do not show a
disabled issue-collection button. A completed email batch's status is shown only
when viewing that batch; its saved attachment remains available separately.

**Capture current page** requests HTTP/HTTPS site access so it can read linked
articles across publishers. It captures the source page's loaded rendered text,
discovers article links across the listing (including sibling article cards),
reads them in background tabs, and saves the page and extracted
article bodies together in one Markdown file selected for **Open in ChatGPT**.
It reuses the article collector's rendered-page reader and Markdown extraction.
Unreadable or unextractable linked pages are marked unavailable. It follows only
the source page's links, without recursion. Article-card headings
are preferred over topic/navigation links. The panel shows an article progress
bar and the current URL, then reports collected and unavailable counts.
Captured website files copy a website-collection digest prompt during ChatGPT
handoff; Gmail newsletters retain their email-specific provenance prompt.
The saved publication/email batch is preserved. Content that requires scrolling,
expansion, login, or browser verification may remain incomplete. The selected
attachment stays in the panel until it closes; the downloaded Markdown remains
available afterward.

**Record scrolling feed** opens the experiment recorder in a separate window.
Select **Start recording**, scroll normally, stop, and save both its WebM video
and JSON event/page log. The recorder targets 30 fps and stops after two minutes;
it records raw evidence for parser investigation, not a reconstructed feed digest.
See the [recording instructions and limitations](feed-capture-experiment.md).

## Collect an issue

1. Sign in to the publication if its articles require an account.
2. Open a supported issue page or the NYT homepage.
3. Open the **Website Reader** extension popup.
4. Select **Collect issue**.
5. Leave the issue tab open while collection runs. The popup may be closed and reopened without losing saved progress.
6. When collection finishes, choose where to save the generated Markdown file.

The popup reports the current article, its position in the issue, the current attempt, and any retry delay. A download begins after every candidate has been collected, marked unsupported, or logged and skipped. Unreadable articles never prevent completion.

For The New York Times, the collector snapshots the dated article links currently present on the homepage, removes duplicate and tracking links, and names the file `nyt-YYYY-MM-DD.md` using the collection date in New York. Section navigation and games are excluded. Sign in before collecting; the collector uses that browser session.

## Collect a newsletter in Gmail

1. Open the email in Gmail and expand its message body.
2. Open Website Reader. If several messages are expanded, select one in **Expanded email**.
3. Select **Collect email and articles**. Chrome asks for access to the linked sites. Articles open one at a time in background tabs and are read after their text renders.
4. If a redirect needs site access or a page needs login or a challenge, collection pauses and leaves the article tab open. Complete login in that tab, return to the original Gmail message, and select **Continue collection**. Chrome requests access to a redirected site at that point. Medium access includes its subdomains so author-hosted stories do not each require a separate grant. If the article remains inaccessible, select **Skip article**.
5. Successful article tabs close automatically. Skipping also closes the article tab.
6. Leave the Gmail tab on that conversation while collection runs. You can close the popup.
7. Save the Markdown, upload it to your AI chat, and use **Copy email digest prompt**.

Gmail filenames use `newsletter-<sending-domain>-<message-id>.md`. The file preserves the email's subject, sender, displayed date, commentary, excerpts, and HTTP/HTTPS links. Linked articles follow in email order, with duplicate links removed. Routine subscription, account, sharing, advertising, navigation, and non-HTML file links are kept in the email text but excluded from article fetching. Link classification is heuristic. Medium links must identify a story; author profiles and publication landing pages remain in the email but are not fetched. Medium tracking parameters are removed to avoid collecting the same story repeatedly. A failed page load pauses collection with its article tab available for inspection; Continue retries, while Skip preserves an unavailable entry and moves on. Failed articles retain an unavailable entry and their email link. Emails without article links also work.

The email prompt uses question → claim → evidence → open questions → why this might be interesting, with a position-and-reasoning summary for opinion. It distinguishes the newsletter's claims from the linked article's evidence and permits an empty reading shortlist.

Only visible, expanded message bodies are captured, not the inbox or collapsed messages. Gmail's DOM can change. Clipped emails are labeled partial; hidden content is not captured. Articles use normal browser navigation with your signed-in session and are read from the rendered page. Redirect destinations require extension access before their text can be read. Login and challenge detection is heuristic; short extractions are labeled incomplete without assuming a paywall. Article bodies are identified across content containers rather than assuming the first article element contains the story. Collection does not bypass access restrictions. After collection starts, the email text and article queue are saved. You can close, reload, or navigate away from Gmail and close Website Reader while collection continues in the background. Reopen Website Reader on any tab to continue or skip a paused article. A background alarm resumes saved progress if Chrome suspends the extension worker; restarting Chrome pauses collection until you continue it.

## Resume an interrupted collection

Publication issue collection pauses if its source tab is closed or navigated away. Email collection continues from its saved snapshot; login, site-access prompts, or browser restart can pause it. Individual unreadable articles are logged and skipped.

1. Read the status message in the popup.
2. For a publication issue, return to the same issue page. For an email batch, any tab works.
3. Open Website Reader and select **Continue collection**.

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

The log records cataloging, request timing, response status, extraction results, retries, skipped articles, pauses, downloads, and cleanup errors. Only the latest collection log is retained.

The panel follows the active page, except article tabs opened for a saved collection. **Continue collection** resumes the saved paused batch. **Replace paused batch with current page** starts over using the current page. A running batch must finish or pause before another starts. On Economist pages outside a dated weekly edition, **Open Economist weekly edition** opens the newest dated issue linked on the page, or the weekly edition index; then select a dated issue and collect it.

Collection transitions use the existing saved state:

| Saved state | Available actions | Next state |
|---|---|---|
| None or completed | Collect current issue/email | Running |
| Running | Wait; another collection is blocked | Paused on interruption, completed on success |
| Paused | Continue or skip the blocked article | Running |
| Paused | Replace with current issue/email | Running with a new batch |

Choosing a file changes only the ChatGPT attachment. Opening ChatGPT leaves collection progress unchanged. During handoff, attachment selection is disabled until the operation finishes. Selected files remain available while the panel stays open.

## Open a collected batch in ChatGPT

After a collection finishes, select **Open in ChatGPT**. **File to open in ChatGPT** names the file that button will attach and identifies its source: the chosen file, or otherwise the latest completed collection. This is the next attachment, not a history of files previously sent. You can choose an existing Markdown or text file; it takes precedence without changing the saved collection, even if another collection finishes. Use **Use saved collection instead** to switch back, or **Clear chosen file** when no completed collection is available. Without a chosen file or completed collection, Open in ChatGPT is disabled. A chosen file does not automatically copy a publication-specific prompt. Chrome asks for optional access to `chatgpt.com` so Website Reader can attach the file.

When using the saved collection, the action copies the prompt for that batch's source, opens a new ChatGPT web chat, and attaches the exact generated Markdown. It waits up to 30 seconds for an editable composer and enabled attachment control. Startup, sign-in, upload, and unconfirmed-attachment failures are reported in the panel; attachment failures are also saved in the log. If confirmation times out, check the draft before retrying to avoid duplicate attachments. Paste the prompt and submit when ready. It does not submit a message automatically. The original download remains available.

This targets the ChatGPT website. The official ChatGPT browser extension's side chat has no cross-extension upload listener in the inspected version (1.26.901.11451), so Website Reader cannot directly attach a file inside that separate panel. If ChatGPT requires sign-in, its attachment UI changes, or access is declined, attach the downloaded file manually; the prompt is still copied. The automatic attachment rebuilds the document from the saved collection, so clearing download history does not prevent handoff.

## Output and extraction limits

- Subscriber-only content is available only when the active publication session has access to it.
- Extraction keeps headings, paragraphs, block quotes, and list items. Navigation, forms, scripts, styles, figures, buttons, footers, and hidden elements are omitted.
- Interactive pages are not reconstructed. They are represented by an unsupported notice and a link to the original article.
- Very short extractions are treated as unsupported because they are unlikely to contain a reliable full article.
- The extension does not bypass CAPTCHAs, browser challenges, subscriptions, or paywalls.

## Future improvements

- Evaluate limited parallel article collection within a single batch, including batches from one publisher such as The New York Times, The Free Press, or The Economist. Start by comparing one versus two concurrent articles with staggered starts and the current pacing; measure completion time, throttling, browser challenges, and laptop resource use before increasing concurrency. Associate each article with its Chrome tab ID, preserve the original article order in the output, and support independent login/access pauses, closed tabs, and recovery after worker restart.

## Local data and permissions

Collection stores content locally; selecting **Open in ChatGPT** uploads the completed batch to ChatGPT. Article content, progress, and logs remain in Chrome's local extension storage until replaced or removed through browser extension-data controls. Generated issues and logs are written through Chrome's download system; only the digest prompt is written to the clipboard when **Copy digest prompt** is selected.

The extension requests:

- Access to `www.economist.com`, `alumni.berkeley.edu`, `cacm.acm.org`, and `www.nytimes.com` to read issue pages and fetch their articles.
- Access to `mail.google.com` to capture the expanded email selected in the popup. Email text is stored locally with collection progress and included in your downloaded file.
- Optional HTTP/HTTPS host access, requested only for sites linked by the selected email, to read rendered article tabs across publications. Previously granted site access remains until removed in Chrome's extension settings. The email body is not sent to linked sites; fetching a newsletter tracking link may register a click with its sender.
- Optional access to `chatgpt.com`, requested when you select **Open in ChatGPT**, to attach the completed batch to your ChatGPT draft. This action sends the collected content, including email content when present, to ChatGPT. Collection alone does not send it there.
- `tabs` and `scripting` to verify the active issue tab and run collection in that tab.
- `storage` to checkpoint resumable progress and retain the latest log and completed issue.
- `downloads` to save Markdown and log files and clean up interrupted extension downloads.
- `clipboardWrite` to copy the digest prompt on request.

## Troubleshooting

- **Collect issue is unavailable or reports the wrong page:** Open a supported issue URL listed above, then reopen the popup.
- **An article cannot be accessed:** Confirm that the publication tab is signed in when required and that the account has access to the article.
- **An article was skipped:** Check the log for its URL and failure reason. Collection continues automatically with the remaining articles.
- **The copied text does not include the issue:** This is intentional. Upload the downloaded Markdown to the AI chat separately, then paste the copied digest prompt.
- **Recent code changes do not appear:** Reload the unpacked extension from `chrome://extensions`, then reopen its popup.

The self-contained [Bleve search service](lexical-search/README.md) provides local chunk indexing and search for the archive.
