import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('chatgpt_import', Path(__file__).parents[1] / 'scripts/import-chatgpt.py')
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)


class ChatGPTImportTests(unittest.TestCase):
    def test_sharded_cli_sends_full_mapping_and_dry_run(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            conversation = {'id': 'chat', 'mapping': {'branch': {'parent': 'root'}}}
            (directory / 'part.json').write_text(json.dumps([conversation]))
            (directory / 'export_manifest.json').write_text(json.dumps({
                'logical_files': {'conversations.json': {'files': ['part.json']}}}))
            response = io.BytesIO(b'{"result":"imported"}')
            with patch('sys.argv', ['import-chatgpt.py', temp, '--scope', 'personal', '--port', '8766', '--dry-run']), \
                    patch.object(importer.urllib.request, 'urlopen', return_value=response) as send, \
                    patch('sys.stdout', new_callable=io.StringIO):
                self.assertEqual(importer.main(), 0)
            request = send.call_args.args[0]
            self.assertEqual(request.full_url, 'http://127.0.0.1:8766/api/v1/chatgpt/import')
            self.assertEqual(json.loads(request.data), {'scope': 'personal', 'conversation': conversation, 'dry_run': True})

    def test_manifest_cannot_escape_export_directory(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            (directory / 'export_manifest.json').write_text(json.dumps({
                'logical_files': {'conversations.json': {'files': ['../outside.json']}}}))
            with self.assertRaisesRegex(ValueError, 'escapes'):
                importer.conversation_files(directory)


if __name__ == '__main__':
    unittest.main()
