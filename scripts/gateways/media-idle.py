#!/usr/bin/env python3
"""Run an sd.cpp server and unload it after its job queue has been idle.

Generation is asynchronous: an HTTP submission finishing does not mean the GPU
job finished. Browser queue polling is not user activity either. Keep that policy
with this runtime adapter while llama-swap owns the process group.
"""
import argparse
import json
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.request


TERMINAL_STATES = {"completed", "failed", "cancelled"}


def queue_activity(payload):
    jobs = payload["jobs"]
    if not isinstance(jobs, list):
        raise ValueError("Invalid sd.cpp job list")
    signature = tuple(sorted((str(job["id"]), str(job["status"])) for job in jobs))
    return any(status not in TERMINAL_STATES for _, status in signature), signature


def run(command, base_url, idle_seconds, poll_seconds):
    child = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    stopping = threading.Event()

    def stop(_signum, _frame):
        stopping.set()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    last_activity = time.monotonic()
    previous = None
    try:
        while child.poll() is None and not stopping.is_set():
            now = time.monotonic()
            try:
                with urllib.request.urlopen(base_url.rstrip("/") + "/sdcpp/v1/jobs", timeout=3) as response:
                    active, signature = queue_activity(json.load(response))
                if active or signature != previous:
                    last_activity = now
                previous = signature
                if not active and now - last_activity >= idle_seconds:
                    break
            except (OSError, ValueError, KeyError, TypeError):
                # An unavailable queue cannot establish that generation is idle.
                last_activity = now
            stopping.wait(poll_seconds)
    finally:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
        child.wait()
    return 0 if stopping.is_set() or child.returncode in (0, -signal.SIGTERM) else child.returncode


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--idle-seconds", type=float, default=600)
    parser.add_argument("--poll-seconds", type=float, default=5)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command or args.idle_seconds <= 0 or args.poll_seconds <= 0:
        parser.error("a command and positive idle/poll intervals are required")
    return run(command, args.base_url, args.idle_seconds, args.poll_seconds)


if __name__ == "__main__":
    raise SystemExit(main())
