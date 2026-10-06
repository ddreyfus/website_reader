# Local MCP connection test

The server exposes read-only corpus discovery, archive search, and bounded
reading tools. The original `hello` tool remains available to verify the tunnel
with a greeting, UTC time, and an optional caller-supplied challenge.

## Local verification

```sh
npm install
npm run test:mcp
```

The test launches the actual server over stdio, discovers its tools, and calls
`hello` with a random challenge. This verifies local MCP operation, not ChatGPT
connectivity. `npm run mcp:serve` starts the server and waits for MCP messages on
stdin; it is not an interactive shell command that prints a greeting immediately.

## ChatGPT tunnel verification

The tested account is a personal ChatGPT Plus account. Its Security and login
page did not show a Developer mode toggle, but **Plugins → Add (+) → Create
custom MCP server** was available and worked. Do not treat a missing Developer
mode toggle as proof that custom MCP creation is unavailable.

ChatGPT and Platform sign-ins are separate. Use the intended Platform organization
and associate the tunnel with the ChatGPT workspace where the plugin will be
created. An existing company API key or company credit balance does not establish
access to a tunnel created in a different personal organization.

1. Sign in to [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels).
   Create or select a tunnel associated with the intended ChatGPT workspace.
   Creating a tunnel needs Tunnels Read + Manage; using it needs Read + Use.
2. Obtain a runtime API key for the same Platform organization with tunnel access.
   Keep the key out of this repository's tracked files and out of chat messages.

   In **Organization → API keys → Create new secret key**, select:

   - **Owned by:** You.
   - **Name:** Website Reader tunnel runtime.
   - **Project:** Default project (the project used for this test).
   - **Expiration:** choose an appropriate lifetime and record its expiry locally.
   - **Permissions:** Restricted. Leave other capabilities at None. Under
     **Tunnels**, select both **Read** and **Use**. The collapsed control says
     **All selected** because both available tunnel permissions are selected;
     this is not the top-level **All** permissions option. The form reports
     **2 selected permissions**.

   Create the key and save it using the hidden-input command below. This is a
   runtime key, not an admin key. Creating the tunnel and running its client are
   distinct permission checks. Restricting this key does not grant your account
   missing organization-level permissions.
3. Install the official [tunnel-client release](https://github.com/openai/tunnel-client/releases/latest)
   for the machine and verify its published checksum. This session downloaded
   and verified v0.0.15 for macOS arm64 into `.local-mcp/bin/tunnel-client`.

   For another installation, download the matching platform archive and
   `SHA256SUMS.txt` from the same release. Compare `shasum -a 256 ARCHIVE.zip`
   against the entry for that exact archive before extracting it. Put the
   executable at `.local-mcp/bin/tunnel-client` and verify
   `.local-mcp/bin/tunnel-client help quickstart` works. Use the latest-release
   link to choose the version rather than assuming the tested version is current.
4. Configure a stdio profile using the absolute Node and server paths:

```sh
.local-mcp/bin/tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile website-reader-archive \
  --profile-dir "$PWD/.local-mcp/profiles" \
  --tunnel-id tunnel_REPLACE_WITH_YOUR_ID \
  --control-plane-api-key-ref "file:$HOME/.local-mcp/runtime-key" \
  --mcp-command "$(command -v node) $PWD/scripts/mcp-archive.mjs"
```

5. Save the runtime key privately, then validate and run the profile. For an
   interactive zsh terminal, hidden input avoids putting the key into shell
   history. The key file is readable only by your user and ignored by Git:

```sh
umask 077
mkdir -p "$HOME/.local-mcp"
read -rs 'READER_TUNNEL_KEY?Runtime API key: '
printf '\n'
printf '%s' "$READER_TUNNEL_KEY" > "$HOME/.local-mcp/runtime-key"
chmod 600 "$HOME/.local-mcp/runtime-key"
unset READER_TUNNEL_KEY
.local-mcp/bin/tunnel-client doctor \
  --profile website-reader-archive --profile-dir "$PWD/.local-mcp/profiles" --explain
.local-mcp/bin/tunnel-client run \
  --profile website-reader-archive --profile-dir "$PWD/.local-mcp/profiles"
```

6. While the client is running, open [ChatGPT Plugins](https://chatgpt.com/plugins),
   select **Add (+) → Create custom MCP server**, and enter:

   - **Name:** Website Reader Local.
   - **Description:** Verify connectivity to the local Website Reader hello-world
     MCP server.
   - **Connection:** Tunnel, with the tunnel ID from Platform. The form should
     recognize the tunnel name.
   - **Authentication:** No authentication. The runtime key authenticates the
     tunnel client; it does not belong in ChatGPT's MCP authentication form.

   Review the warning, select **I understand and want to continue**, then **Create
   as a plugin**. Complete the following **Connect Website Reader Local** dialog.
   The plugin should appear under Installed and its detail page should say
   Connected. No authentication is appropriate here because the private tunnel
   provides access to a greeting-only server; reevaluate access before adding
   archive tools.

7. On the plugin detail page, select **Try in chat**. This creates a new composer
   with the plugin mentioned. Keep that mention and append:

   > Use Website Reader Local's hello tool with challenge "reader-live-test-1".
   > Report the actual tool response, including its timestamp.

8. Verify the returned challenge and current timestamp. Only a successful call
   from ChatGPT confirms the complete connection.

## Start, stop, and status

Once the profile and private key file are configured, run from this repository:

```sh
npm run mcp:start
npm run mcp:status
npm run mcp:stop
```

Start uses tunnel-client's managed background runtime, reusing the configured
tunnel ID, credential reference, and stdio command. It then displays runtime
status; check that the runtime is running, healthy, and ready. Stop ends the local
runtime and its MCP subprocess without deleting the remote tunnel or profile.
Starting again reconnects it. Start requires the key file and does not print its
contents. These commands use the alias `website-reader-archive`.

The managed runtime writes local state, locks, logs, and health discovery under
`~/Library/Application Support/tunnel-client/`. Codex's filesystem sandbox needed
approval for start and stop to write there. Normal Terminal execution does not
use that Codex sandbox. No elevated macOS account or `sudo` was needed.

The manager changes the health port to an available loopback port. Do not assume
the initial profile's port 8080 remains in use. Obtain the current `ui_url` and
`process_running`, `healthy`, and `ready` values with:

```sh
.local-mcp/bin/tunnel-client runtimes status website-reader-archive --json
```

Runtime logs are at
`~/Library/Application Support/tunnel-client/logs/website-reader-archive.log`.
The health URL discovery file is at
`~/Library/Application Support/tunnel-client/health/website-reader-archive.url`.
The JSON status includes diagnostic log excerpts; review them before sharing.

Stop any foreground `tunnel-client run` session with Ctrl-C before switching to
the managed runtime. The managed runtime is separate from login startup.

## Automatic startup

After the end-to-end call succeeds, configure a persistent runtime with absolute
paths and a private credential reference, then install a macOS login LaunchAgent
to start the tunnel client and restart it after failure. The tunnel client spawns
the stdio server, so a second independently running server is unnecessary. Verify
runtime health and a fresh ChatGPT tool call after restarting the agent.

Do not install startup automation with placeholder tunnel IDs or credentials.
The machine must be awake and connected for calls to work. `.local-mcp/` is ignored
by Git and is reserved for local binaries, profiles, and runtime artifacts.

## Verification status

- Local stdio initialization, discovery, and challenged tool call: passed.
- Official tunnel client checksum and executable help: verified.
- Platform sign-in and tunnel creation with the personal workspace: completed.
- Local profile: configured with `file:/Users/david/.local-mcp/runtime-key`.
- Private runtime key: present, mode 600; contents were not displayed.
- Managed runtime: running, healthy, and ready; remote tunnel lookup succeeded
  using the runtime key.
- ChatGPT plugin creation and connection: completed.
- Live ChatGPT call: passed with challenge `reader-live-test-20261005-01` and
  timestamp `2026-10-05T19:11:00.910Z` (3:11 p.m. Eastern, October 5, 2026).
- Stop: passed; structured status reported stopped, not running, not healthy,
  and not ready.
- Start after stop: passed; runtime returned to ready.
- Live ChatGPT call after restart: passed with challenge
  `reader-restart-test-20261005-02` and timestamp `2026-10-05T19:12:07.133Z`.
- [Test conversation](https://chatgpt.com/c/6ac3f63e-8398-83ea-a306-167393c384df)
  contains both challenged responses.
- Runtime left running after verification.
- Login startup and automatic recovery after a crash: not installed or verified.

## Troubleshooting

| Symptom | Check or action |
| --- | --- |
| Platform redirects to login | Sign in to Platform, then reopen Organization → Tunnels. Being signed in to ChatGPT is insufficient. |
| Missing Developer mode toggle | Check Plugins → Add (+) → Create custom MCP server directly; that route worked on the tested account. |
| Tunnels access required | Verify the selected organization and organization-level Read/Use or Read/Manage role. Restricted key settings alone cannot grant a missing role. |
| Tunnel missing in ChatGPT | Include the target ChatGPT workspace in Platform tunnel associations; check the runtime key's organization. |
| Runtime key file missing | The tested key lives in `~/.local-mcp/runtime-key`, not the repository's `.local-mcp/` directory. Confirm the profile's `control_plane.api_key` references the actual location. |
| Authentication or permission error | Confirm key expiration, Tunnels Read + Use, organization membership, and tunnel association. Run doctor, then inspect runtime status. |
| Start/stop fails with operation not permitted in Codex | Approve the specific start/stop command so the manager can write its state under Library/Application Support. |
| Plugin creation/discovery hangs | Confirm the runtime is running, healthy, and ready; keep it running during Create and Connect. |
| Connection works but no tool is called | Use Try in chat and explicitly request the hello tool with a fresh challenge. A greeting written by the model is not proof of a tool call. |
| Calls fail after sleep or shutdown | Wake the machine, restore connectivity, run start and status, and retry with a fresh challenge. |
| Node or checkout moved | Update the absolute `mcp.commands[0].command` in the profile and restart. |

The hello server makes no model API requests. Its runtime key is restricted to
tunnel operations. API-backed summary generation, if added later, is a separate
model workload; tunnel pricing was not established by this test.

See the [official tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
for account permissions and troubleshooting.

## Archive service configuration

The Bleve service reads `~/.local-mcp/config.json`, beside `runtime-key`, for
its startup port, archive root, and `index_directories` list. The key stays in its separate file; the
extension settings API never reads it. See [Bleve setup](lexical-search/README.md)
for extension controls, restart behavior, and development overrides. The tunnel
archive MCP server and Bleve service remain separate processes.

## Archive tools

The tunnel profile launches `scripts/mcp-archive.mjs`. The server advertises:

- `list_documents`: enumerate indexed files without a search query, optionally
  scoped by corpus (including descendants) or a case-insensitive `path_contains`
  filter. Results sort by path and document ID, with total count and pagination.
- `list_articles`: enumerate a document's collected article anchors and original
  email unit in source order, with titles, line/byte ranges, and browser links.
  Other Markdown exposes ATX headings labelled `kind=heading`; plain text may
  have no headings. This inventories captured units, not unavailable content.

- `list_corpora`: directory hierarchy, stable corpus IDs, parent IDs, recursive
  document counts, and indexing status. Empty roots are omitted by default.
- `search_archive`: query the whole configured archive, or pass corpus IDs to
  search a source/subdirectory and its descendants. Results are sorted by
  descending Bleve relevance, with a stable tie-breaker. The default is 30
  passages; `search_limit` in the shared configuration or the tool's `limit`
  argument can select 1–100. Multiple hits can refer to one document.
- `read_document`: use a returned document ID and optionally a chunk ID, line,
  or byte offset. The default response budget is 32 KB, maximum 64 KB, with a
  continuation offset. Small documents fit in one response. Article content
  is untrusted source text, never instructions.
- `hello`: retained as a connectivity check.

Run Bleve with `npm run bleve:start`, then restart the existing tunnel runtime
with `npm run mcp:stop` and `npm run mcp:start`. In ChatGPT, refresh the custom
plugin's tools if its cached list still shows only hello, and enable the plugin
in the conversation. Useful acceptance prompts are “What sources are in my
reading archive?” and “What have I downloaded about inflation?” No tool names
should be necessary.

Results include localhost browser links. Clicking one opens `/file/<document-id>`
on the configured service port, showing the exact matched passage and navigation
through the rest of the document. The viewer displays escaped source text; it
runs no article scripts and does not invoke another LLM tool. URLs work only on
the computer running Bleve. Opening a URL does not tell ChatGPT what you clicked.

The MCP process reads the service port and default count from
`~/.local-mcp/config.json` (or `LOCAL_MCP_CONFIG`). It does not read the runtime
key. If Bleve is unavailable, tools return a visible error rather than an empty
archive. HTTP retrieval routes are `/api/v1/corpora`, `/api/v1/archive/search`,
and `/api/v1/documents/<document-id>`. IDs are validated against active configured
sources; reads reject traversal, unindexed files, and symlinks escaping a source.

Regression coverage: `npm run test:mcp`, the extension settings test, and Go
retrieval/race tests cover discovery, hierarchy, scope boundaries, counts,
ranking, long-line passage location, pagination, and viewer escaping.

### Binary and HTML document ingestion

Install the text extractor with `npm run tika:install` and make Java 17+ available
on the Bleve service's PATH. Rebuild and restart Bleve to enable PDF, Word and
HTML ingestion in the configured indexing directories. No new MCP tools are
needed: existing search, read and inventory tools use the retained extracted text.
Existing unchanged documents are discovered by reconciliation. See
`lexical-search/README.md` for cache locations, OCR behavior and failure diagnostics.
