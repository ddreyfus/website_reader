import gzip
import importlib.util
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import itertools

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/service-log.py'
spec = importlib.util.spec_from_file_location('service_log', SCRIPT)
service_log = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service_log)


class ServiceLogTests(unittest.TestCase):
    def test_watchdog_restarts_after_sustained_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'service.log'
            ticks = itertools.count(0, 100)
            with patch.object(service_log.time, 'monotonic', side_effect=lambda: next(ticks)), patch.object(service_log, 'check_tunnel', side_effect=RuntimeError('not ready')) as probe:
                service_log.run(path, [sys.executable, '-u', '-c', 'import time; time.sleep(60)', '--health.url-file', 'fixture'])
            self.assertEqual(probe.call_count, 3)
            self.assertIn('sustained tunnel failure', path.read_text())

    def test_probe_rejects_remote_health_url(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'health.url'
            path.write_text('http://example.com')
            with self.assertRaises(ValueError):
                service_log.check_tunnel(path)

    def test_daily_size_rotation_retention_and_continued_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'service.log'
            now = 2000000000
            path.write_bytes(b'yesterday\n')
            os.utime(path, (now - 86400, now - 86400))
            service_log.rotate_log(path, now)
            first = list(path.parent.glob('*.gz'))[0]
            self.assertEqual(gzip.decompress(first.read_bytes()), b'yesterday\n')
            path.write_bytes(b'new day\n')
            os.utime(path, (now, now))
            service_log.rotate_log(path, now, max_bytes=2)
            archives = list(path.parent.glob('*.gz'))
            self.assertEqual(len(archives), 2)
            self.assertIn(b'new day\n', [gzip.decompress(p.read_bytes()) for p in archives])
            service_log.rotate_log(path, now, max_files=1)
            self.assertEqual(len(list(path.parent.glob('*.gz'))), 1)
            service_log.rotate_log(path, now + 15 * 86400)
            self.assertEqual(list(path.parent.glob('*.gz')), [])

    def test_supervisor_captures_both_streams_and_exit_status(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'service.log'
            path.write_text('old log retained\n')
            yesterday = time.time() - 86400
            os.utime(path, (yesterday, yesterday))
            result = subprocess.run([sys.executable, str(SCRIPT), str(path), sys.executable, '-u', '-c',
                                     'import sys; print("stdout event"); print("stderr event", file=sys.stderr); sys.exit(7)'], timeout=10)
            self.assertEqual(result.returncode, 7)
            self.assertIn('stdout event', path.read_text())
            self.assertIn('stderr event', path.read_text())
            self.assertNotIn('old log retained', path.read_text())
            self.assertEqual(gzip.decompress(next(path.parent.glob('*.gz')).read_bytes()), b'old log retained\n')
            self.assertIn('exit_code=7', path.read_text())

    def test_termination_reaches_child(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'service.log'
            code = 'import signal,time,sys; signal.signal(signal.SIGTERM,lambda *_:sys.exit(0)); print("ready",flush=True); time.sleep(60)'
            process = subprocess.Popen([sys.executable, str(SCRIPT), str(path), sys.executable, '-u', '-c', code])
            try:
                deadline = time.monotonic() + 10
                while not path.exists() or 'ready' not in path.read_text():
                    if time.monotonic() > deadline:
                        self.fail('child did not start')
                    time.sleep(.02)
                process.send_signal(signal.SIGTERM)
                self.assertEqual(process.wait(timeout=10), 0)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()


if __name__ == '__main__':
    unittest.main()
