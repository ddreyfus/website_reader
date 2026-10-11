# Import a ChatGPT export

Build/restart the local archive service after installing this change. Then run:

```sh
python3 scripts/import-chatgpt.py /path/to/unzipped-export --scope personal --dry-run
python3 scripts/import-chatgpt.py /path/to/unzipped-export --scope personal
```

Use the same account/workspace label as the browser backup. The tool reads the
configured local service port; `--port` overrides it. It supports both
`conversations.json` and sharded exports with `export_manifest.json`.

Each conversation updates the existing SQLite backup row and its stable archive
directory under `~/sources/ChatGPT/<scope>/conversations/<id>/`. Existing project
assignments are preserved. A busy browser backup is skipped and reported; rerun
after it finishes. Repeated imports are safe, and unchanged files are not rewritten.

`conversation.md` contains the selected branch. `branches.md` contains alternate
user/assistant messages once each, with message and parent IDs. `export.json`
retains the latest imported tree, including tool messages and attachment references.
JSON is source material, not
an additional searchable transcript. Images and attachment files are not copied.

An older export never replaces a newer browser transcript. If the browser backup
has no remote timestamp, its transcript is preserved conservatively. The export
can still supply alternate branches. An older export also cannot replace a newer
import's branch file. Later browser syncs can refresh the main transcript without
removing the export tree or its alternate messages.

Add `~/sources/ChatGPT` to the archive's directories to index. The normal watcher
indexes the Markdown files and updates search automatically. The import does not
mark browser inventory discovery complete or delete conversations absent from
the export. Each conversation commits separately; rerun after any interruption.
