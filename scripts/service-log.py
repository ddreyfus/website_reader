"""Run a service with bounded, daily rotated stdout/stderr logs."""
import datetime
import gzip
import os
from pathlib import Path
import selectors
import shutil
import signal
import subprocess
import sys
import time
import traceback
import urllib.request
import urllib.parse


def check_tunnel(url_file):
    base = Path(url_file).read_text().strip()
    url = urllib.parse.urlsplit(base)
    if url.scheme != 'http' or url.hostname != '127.0.0.1':
        raise ValueError('Expected loopback tunnel health URL')
    for endpoint in ('/healthz', '/readyz'):
        with urllib.request.urlopen(base.rstrip('/') + endpoint, timeout=3) as response:
            if response.status != 200:
                raise RuntimeError(f'{endpoint}: HTTP {response.status}')


def rotate_log(path, now, max_bytes=25 * 1024 * 1024, keep_days=14, max_files=56):
    path = Path(path)
    if path.exists() and path.stat().st_size:
        stat = path.stat()
        day = lambda stamp: datetime.datetime.fromtimestamp(stamp, datetime.timezone.utc).date()
        if stat.st_size >= max_bytes or day(stat.st_mtime) != day(now):
            stamp = datetime.datetime.fromtimestamp(now, datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
            archived = path.with_name(f'{path.name}.{stamp}.{time.time_ns()}')
            path.rename(archived)
            # Keep the uncompressed file if compression is interrupted or fails.
            temporary = Path(str(archived) + '.gz.tmp')
            with archived.open('rb') as source, temporary.open('xb') as output:
                with gzip.GzipFile(fileobj=output, mode='wb') as compressed:
                    shutil.copyfileobj(source, compressed)
            os.replace(temporary, str(archived) + '.gz')
            os.chmod(str(archived) + '.gz', 0o600)
            os.utime(str(archived) + '.gz', (now, now))
            archived.unlink()
    archives = sorted(path.parent.glob(path.name + '.*.gz'), key=lambda item: item.stat().st_mtime, reverse=True)
    for index, item in enumerate(archives):
        if index >= max_files or item.stat().st_mtime < now - keep_days * 86400:
            item.unlink()


def append_log(path, data):
    rotate_log(path, time.time())
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(descriptor, 'ab') as output:
        output.write(data)


def run(path, command):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        path.chmod(0o600)
    rotate_log(path, time.time())
    health_file = command[command.index('--health.url-file') + 1] if '--health.url-file' in command else None
    child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, bufsize=0, start_new_session=True)
    next_check = time.monotonic() + 90
    failures = 0
    append_log(path, f'{datetime.datetime.now(datetime.timezone.utc).isoformat()} supervisor started child_pid={child.pid} executable={command[0]}\n'.encode())
    def forward(signum, _frame):
        if child.poll() is None:
            os.killpg(child.pid, signum)
    stopping = False
    def stop(signum, frame):
        nonlocal stopping
        stopping = True
        forward(signum, frame)
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, stop)
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ)
    try:
        while True:
            if stopping:
                break
            if health_file and time.monotonic() >= next_check:
                try:
                    check_tunnel(health_file)
                    if failures:
                        append_log(path, b'watchdog: tunnel health and readiness recovered\n')
                    failures = 0
                except Exception as error:
                    failures += 1
                    append_log(path, f'{datetime.datetime.now(datetime.timezone.utc).isoformat()} watchdog: probe failed {failures}/3: {error}\n'.encode())
                    if failures >= 3:
                        append_log(path, b'watchdog: sustained tunnel failure; terminating process group for launchd restart\n')
                        break
                next_check = time.monotonic() + 30
            # Check before each write and during idle periods. Open per chunk so
            # no service-owned descriptor continues writing into a rotated file.
            if not selector.select(timeout=1):
                rotate_log(path, time.time())
                continue
            data = os.read(child.stdout.fileno(), 65536)
            if not data:
                break
            append_log(path, data)
    finally:
        selector.close()
        child.stdout.close()
        if child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
        append_log(path, f'{datetime.datetime.now(datetime.timezone.utc).isoformat()} supervisor stopped child_pid={child.pid} exit_code={child.returncode}\n'.encode())
    return child.returncode


if __name__ == '__main__':
    if len(sys.argv) < 3:
        raise SystemExit('Usage: service-log.py LOG COMMAND [ARG ...]')
    try:
        raise SystemExit(run(sys.argv[1], sys.argv[2:]))
    except Exception:
        with open(sys.argv[1], 'a') as output:
            traceback.print_exc(file=output)
        raise SystemExit(1)
