#!/usr/bin/env python3
"""Import an unzipped ChatGPT export through the local archive service."""
import argparse
import collections
import json
from pathlib import Path
import sys
import urllib.error
import urllib.request


def conversation_files(directory):
    manifest = directory / 'export_manifest.json'
    if manifest.exists():
        logical = json.loads(manifest.read_text())['logical_files']
        names = logical['conversations.json']['files']
        files = [directory / name for name in names]
        if any(not f.resolve().is_relative_to(directory.resolve()) for f in files):
            raise ValueError('Manifest conversation path escapes export directory')
        return files
    single = directory / 'conversations.json'
    return [single] if single.exists() else sorted(directory.glob('conversations-*.json'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--scope', required=True, help='Existing account/workspace backup label')
    parser.add_argument('--port', type=int, help='Local archive port; defaults to archive config')
    parser.add_argument('--dry-run', action='store_true', help='Validate and report without writing')
    args = parser.parse_args()
    port = args.port
    if port is None:
        import os
        config = Path(os.environ.get('LOCAL_MCP_CONFIG', str(Path.home() / '.local-mcp/config.json')))
        port = json.loads(config.read_text())['port']
    files = conversation_files(args.directory.expanduser())
    if not files:
        parser.error('No conversation JSON files found')
    counts = collections.Counter()
    seen = set()
    # Validate every shard before making changes. Load only one shard at a time.
    for file in files:
        conversations = json.loads(file.read_text())
        if not isinstance(conversations, list):
            raise ValueError(f'{file.name}: expected a JSON array')
        for conversation in conversations:
            key = conversation.get('id') or conversation.get('conversation_id')
            if not key or key in seen:
                raise ValueError(f'{file.name}: missing or duplicate conversation ID')
            seen.add(key)
    print(f'{len(seen)} conversations in {len(files)} files; scope={args.scope}; dry_run={args.dry_run}', flush=True)
    for file in files:
        for conversation in json.loads(file.read_text()):
            payload = json.dumps({'scope': args.scope, 'conversation': conversation, 'dry_run': args.dry_run}).encode()
            request = urllib.request.Request(f'http://127.0.0.1:{port}/api/v1/chatgpt/import', data=payload, headers={'Content-Type': 'application/json'})
            try:
                with urllib.request.urlopen(request, timeout=120) as response:
                    result = json.load(response)['result']
            except urllib.error.HTTPError as error:
                raise RuntimeError(f"{conversation.get('id')}: HTTP {error.code}: {error.read().decode()}") from error
            counts[result] += 1
        print(f'{file.name}: {dict(counts)}', flush=True)
    if counts['busy']:
        print('Some conversations are being backed up. Rerun after those jobs finish.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, KeyError, OSError, RuntimeError) as error:
        print(f'Import failed: {error}', file=sys.stderr)
        sys.exit(1)
