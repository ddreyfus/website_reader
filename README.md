# Website Reader

A Chrome/Chromium extension for collecting a publication issue into a single Markdown file.

The initial target is an Economist weekly edition page. The extension catalogs the article links in the current issue, fetches each link using the current browser session, extracts its content, and downloads the complete edition as one Markdown file.

Generated editions begin with a linked table of contents for every collected or explicitly unsupported article.

## Install locally

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this `website_reader` directory.

## Collect an edition

1. Sign in to `economist.com` and open a URL under `https://www.economist.com/weeklyedition/`.
2. Click **Website Reader**, then **Collect edition**.
3. Find the generated `economist-YYYY-MM-DD.md` file in your downloads.

Article requests are spaced by 1–2 seconds. Failed requests are retried with exponential backoff, including `Retry-After` handling for rate limits. The extension does not download an edition while any ordinary article is still missing after retries. Recognized interactive pages and suspiciously short extractions are included as clearly marked unsupported links.

The popup shows the current article title, position, attempt, and retry delay while collection runs. Progress is checkpointed in extension storage with the edition URL, article queue, completed Markdown, and current position, so closing the popup does not discard the run.

If a CAPTCHA or browser challenge is detected, collection pauses without downloading a partial edition and provides a link to open the challenged article. Complete the challenge, return to the same edition page, and choose **Continue collection**. Failed articles and interrupted downloads can be continued the same way. The saved edition URL prevents a checkpoint from being resumed against a different issue.

Access to subscriber-only articles depends on the active Economist session.

The popup keeps the latest detailed collection log in local extension storage. Expand **Latest detailed log** to inspect it, or choose **Download latest log** to save `website-reader.log`.

Completed and interrupted download events are added to the log. Interrupted Website Reader downloads are removed from Chrome's download history after any partial file is cleaned up.
