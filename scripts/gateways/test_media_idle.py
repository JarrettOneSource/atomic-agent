import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest


SCRIPT = Path(__file__).with_name("media-idle.py")
spec = importlib.util.spec_from_file_location("media_idle", SCRIPT)
media_idle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(media_idle)

CHILD = """
import http.server, json, os, pathlib, sys
state, pid, port = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), int(sys.argv[3])
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = state.read_bytes()
        self.send_response(200)
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args): pass
server = http.server.HTTPServer(('127.0.0.1', port), Handler)
pid.write_text(str(os.getpid()))
server.serve_forever()
"""


class MediaIdleTests(unittest.TestCase):
    def start_adapter(self, jobs, poll_seconds="0.02"):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        state = Path(directory.name) / "jobs.json"
        pid = Path(directory.name) / "child.pid"
        state.write_text(json.dumps({"jobs": jobs}))
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        adapter = subprocess.Popen([
            sys.executable, str(SCRIPT), "--base-url", f"http://127.0.0.1:{port}",
            "--idle-seconds", "0.3", "--poll-seconds", poll_seconds, "--",
            sys.executable, "-c", CHILD, str(state), str(pid), str(port),
        ])
        def cleanup():
            if adapter.poll() is None:
                adapter.terminate()
            adapter.wait(timeout=8)
        self.addCleanup(cleanup)
        deadline = time.monotonic() + 4
        while not pid.exists():
            if adapter.poll() is not None or time.monotonic() >= deadline:
                self.fail("media worker did not start")
            time.sleep(.01)
        return adapter, state, int(pid.read_text())

    def test_idle_server_exits_and_reaps_its_worker(self):
        adapter, _, child = self.start_adapter([])
        self.assertEqual(adapter.wait(timeout=4), 0)
        with self.assertRaises(ProcessLookupError):
            os.kill(child, 0)

    def test_generation_outlives_the_idle_timeout_then_unloads_after_finishing(self):
        adapter, state, _ = self.start_adapter([{"id": "job-1", "status": "generating"}])
        time.sleep(.6)
        self.assertIsNone(adapter.poll())
        state.write_text(json.dumps({"jobs": [{"id": "job-1", "status": "completed"}]}))
        self.assertEqual(adapter.wait(timeout=4), 0)

    def test_explicit_stop_terminates_an_active_generation(self):
        adapter, _, child = self.start_adapter([{"id": "job-1", "status": "generating"}], "2")
        adapter.terminate()
        self.assertEqual(adapter.wait(timeout=1), 0)
        with self.assertRaises(ProcessLookupError):
            os.kill(child, 0)

    def test_finished_jobs_do_not_count_as_activity(self):
        active, _ = media_idle.queue_activity({"jobs": [
            {"id": "a", "status": "completed"}, {"id": "b", "status": "cancelled"},
        ]})
        self.assertFalse(active)
        self.assertTrue(media_idle.queue_activity({"jobs": [{"id": "c", "status": "queued"}]})[0])


if __name__ == "__main__":
    unittest.main()
