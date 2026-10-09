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
    child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, bufsize=0)
    append_log(path, f'{datetime.datetime.now(datetime.timezone.utc).isoformat()} supervisor started child_pid={child.pid} executable={command[0]}\n'.encode())
    def forward(signum, _frame):
        if child.poll() is None:
            child.send_signal(signum)
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, forward)
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ)
    try:
        while True:
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
            child.terminate()
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()
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
