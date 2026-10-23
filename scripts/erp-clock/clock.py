#!/usr/bin/env python3
"""Model-free HTTPS wakeups; business scheduling and ownership stay in ERP."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import fcntl
import json
import os
import re
import signal
import subprocess
import threading
import time

WORKERS = ("erp-ugc-direct", "erp-ugc-payouts")
# Cloudflare scheduled handlers have a 15-minute wall-time budget. Keep the
# foreground HTTP request alive for that budget; never use fire-and-forget.
REQUEST_SECONDS = 15 * 60


def log(event, **fields):
    print(json.dumps({"event": event, **fields}, separators=(",", ":")), flush=True)


def validate_secret(secret):
    if any(c in secret for c in '\r\n"\\') or not secret:
        raise ValueError("Invalid credential encoding")


def post_slot(worker, slot, secret):
    # Curl config arrives on stdin: no credential in argv, logs or response body.
    # Reject characters that could inject a second config/header directive.
    validate_secret(secret)
    command = [
        "curl", "-q", "--config", "-", "--silent", "--show-error",
        "--proto", "=https", "--tlsv1.2", "--connect-timeout", "20",
        "--max-time", str(REQUEST_SECONDS), "--retry", "0",
        "--write-out", "\n%{http_code}",
        "--request", "POST", "--header", "Content-Type: application/json",
        "--data-binary", json.dumps({"scheduledTime": slot}),
        f"https://{worker}.dasexperten.workers.dev/scheduled",
    ]
    # Never follow redirects or log stderr (it may reflect server content).
    config = f'header = "Authorization: Bearer {secret}"\n'
    started = time.monotonic()
    try:
        result = subprocess.run(command, input=config, text=True, encoding="utf-8", errors="replace", capture_output=True,
                                timeout=REQUEST_SECONDS + 5, check=False)
        body, _, code = result.stdout.rpartition("\n")
        status = int(code) if code.isdecimal() else 0
        try:
            payload = json.loads(body) if len(body) <= 65536 else None
        except ValueError:
            payload = None
        valid = (isinstance(payload, dict) and payload.get("scheduledTime") == slot
                 and payload.get("triggerSource") == "external_clock"
                 and bool(re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}",
                                       str(payload.get("runKey", "")))))
        outcome = "failed"
        if result.returncode == 0 and valid:
            if status == 200 and payload.get("ok") is True:
                outcome = "complete"
            elif status == 409 and payload.get("apiPending") is True:
                outcome = "already_running"
        log(outcome, worker=worker, scheduledTime=slot, http=status,
            transportCode=result.returncode, seconds=round(time.monotonic() - started, 3))
    except subprocess.TimeoutExpired:
        log("deadline", worker=worker, scheduledTime=slot)
    except OSError:
        log("transport_error", worker=worker, scheduledTime=slot)
    # No local retry: the journal/API owns ambiguous work. The next natural
    # minute probes ERP's existing cadence and durable outbox.


class Clock:
    def __init__(self, submit, transport, secret="", dry=False):
        self.submit = submit
        self.transport = transport
        self.secret = secret
        self.dry = dry
        self.last_slot = -1
        self.active = {}

    def tick(self, now):
        slot = int(now // 60) * 60_000
        if slot <= self.last_slot:
            return
        self.last_slot = slot
        for worker in WORKERS:
            previous = self.active.get(worker)
            if previous is not None and not previous.done():
                log("in_flight", worker=worker, scheduledTime=slot)
                continue
            if previous is not None and previous.exception() is not None:
                log("transport_error", worker=worker, scheduledTime=slot)
            if self.dry:
                log("dry", worker=worker, scheduledTime=slot)
            else:
                log("dispatch", worker=worker, scheduledTime=slot)
                self.active[worker] = self.submit(self.transport, worker, slot, self.secret)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    secret = os.environ.get("ERP_RUN_SECRET", "")
    if not args.dry_run and not secret:
        raise SystemExit("ERP_RUN_SECRET missing")
    if not args.dry_run:
        validate_secret(secret)
    # systemd starts one process; flock also prevents accidental second instances.
    lock_path = os.environ.get("ERP_CLOCK_LOCK", "/run/dasoperator-erp-clock/clock.lock")
    with open(lock_path, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        stopped = threading.Event()
        for sig in (signal.SIGTERM, signal.SIGINT):
            signal.signal(sig, lambda *_: stopped.set())
        with ThreadPoolExecutor(max_workers=len(WORKERS)) as pool:
            clock = Clock(pool.submit, post_slot, secret, args.dry_run)
            while not stopped.is_set():
                clock.tick(time.time())
                if args.once:
                    break
                # Wake at the next minute; a wall-clock jump never replays a backlog.
                stopped.wait(max(0.05, 60 - time.time() % 60))


if __name__ == "__main__":
    main()
