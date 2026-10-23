import contextlib
from concurrent.futures import Future
import io
import json
from datetime import datetime, timezone
import subprocess
import unittest
from unittest.mock import patch
import clock


class ClockTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.futures = []
        self.schedules = {worker: {"crons": ["* * * * *"]}
                          for worker in ["erp-ugc-direct", "erp-ugc-payouts"]}

    def submit(self, fn, *args):
        self.calls.append(args)
        future = Future()
        self.futures.append(future)
        return future

    def test_current_minute_only_and_no_catchup_after_jump(self):
        c = clock.Clock(self.submit, lambda *_: None, schedules=self.schedules)
        with contextlib.redirect_stdout(io.StringIO()):
            c.tick(1_800_000_001)
            c.tick(1_800_000_059)
            self.assertEqual(len(self.calls), 2)
            for future in self.futures:
                future.set_result(None)
            c.tick(1_800_000_601)
            c.tick(1_800_000_060)  # backward time never replays an old slot
        self.assertEqual(len(self.calls), 4)
        self.assertEqual(self.calls[-1][1], 1_800_000_600_000)

    def test_long_direct_does_not_block_payout_or_queue_old_ticks(self):
        c = clock.Clock(self.submit, lambda *_: None, schedules=self.schedules)
        with contextlib.redirect_stdout(io.StringIO()):
            c.tick(1_800_000_001)
            self.futures[1].set_result(None)
            c.tick(1_800_000_061)
        self.assertEqual(len(self.calls), 3)
        self.assertEqual(self.calls[-1][0], "erp-ugc-payouts")

    def test_dry_run_never_calls_transport(self):
        with contextlib.redirect_stdout(io.StringIO()):
            clock.Clock(self.submit, lambda *_: None, dry=True, schedules=self.schedules).tick(123)
        self.assertEqual(self.calls, [])

    def test_secret_stays_off_argv_and_logs_and_no_retries(self):
        fake = "synthetic-test-secret"
        for status, outcome in [("200", "complete"), ("409", "already_running"), ("503", "failed")]:
            with self.subTest(status=status), patch("clock.subprocess.run") as run:
                body = {"ok": status == "200", "apiPending": status == "409", "cron": "* * * * *",
                        "scheduledTime": 1800000000000, "triggerSource": "external_clock",
                        "runKey": "00000000-0000-8000-8000-000000000000"}
                run.return_value = subprocess.CompletedProcess([], 0, json.dumps(body) + "\n" + status, fake)
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    clock.post_slot("erp-ugc-direct", 1800000000000, fake)
                command = run.call_args.args[0]
                self.assertNotIn(fake, " ".join(command))
                self.assertNotIn(fake, output.getvalue())
                self.assertIn(outcome, output.getvalue())
                self.assertEqual(run.call_count, 1)
                self.assertNotIn("--location", command)
                self.assertEqual(command[command.index("--retry") + 1], "0")

    def test_deadline_does_not_retry_unknown_effect(self):
        with patch("clock.subprocess.run", side_effect=subprocess.TimeoutExpired("curl", 905)) as run:
            with contextlib.redirect_stdout(io.StringIO()):
                clock.post_slot("erp-ugc-direct", 1800000000000, "synthetic")
            self.assertEqual(run.call_count, 1)

    def test_proxy_200_is_not_success(self):
        with patch("clock.subprocess.run") as run:
            run.return_value = subprocess.CompletedProcess([], 0, "<html>proxy</html>\n200", "")
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                clock.post_slot("erp-ugc-direct", 1800000000000, "synthetic")
            self.assertIn('"event":"failed"', output.getvalue())

    def test_local_claim_is_an_expected_pending_response(self):
        payload = {"ok": False, "localPending": True, "scheduledTime": 1800000000000, "cron": "0 0 * * *",
                   "triggerSource": "external_clock", "runKey": "00000000-0000-8000-8000-000000000000"}
        with patch("clock.subprocess.run") as run:
            run.return_value = subprocess.CompletedProcess([], 0, json.dumps(payload) + "\n409", "")
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                clock.post_slot("erp-fx-rates", 1800000000000, "synthetic", "0 0 * * *")
            self.assertIn("already_running", output.getvalue())

    def test_missing_curl_is_visible_without_error_content(self):
        with patch("clock.subprocess.run", side_effect=OSError("sensitive diagnostic")):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                clock.post_slot("erp-ugc-direct", 1800000000000, "synthetic")
            self.assertIn("transport_error", output.getvalue())
            self.assertNotIn("sensitive", output.getvalue())

    def test_cloudflare_weekday_and_first_wednesday_gate(self):
        first_wed = datetime(2026, 11, 4, 4, tzinfo=timezone.utc)
        thursday = datetime(2026, 11, 5, 4, tzinfo=timezone.utc)
        second_wed = datetime(2026, 11, 11, 4, tzinfo=timezone.utc)
        self.assertTrue(clock.cron_matches("0 4 * * 5", thursday))
        self.assertFalse(clock.cron_matches("0 4 * * 5", first_wed))
        config = {"crons": ["0 4 * * 4"], "gate": "first_wednesday"}
        self.assertEqual(clock.due_crons(config, first_wed.timestamp() * 1000), ["0 4 * * 4"])
        self.assertEqual(clock.due_crons(config, second_wed.timestamp() * 1000), [])

    def test_hourly_job_keeps_configured_minute(self):
        schedules = {"erp-blogger-id": {"crons": ["0 * * * *"]}}
        c = clock.Clock(self.submit, lambda *_: None, schedules=schedules)
        with contextlib.redirect_stdout(io.StringIO()):
            c.tick(datetime(2026, 10, 24, 0, 1, tzinfo=timezone.utc).timestamp())
            self.assertEqual(self.calls, [])
            c.tick(datetime(2026, 10, 24, 1, 0, tzinfo=timezone.utc).timestamp())
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0][-1], "0 * * * *")

    def test_steps_ranges_lists_and_day_or(self):
        stamp = datetime(2026, 11, 4, 6, 5, tzinfo=timezone.utc)
        self.assertTrue(clock.cron_matches("5,12 */6 * * *", stamp))
        self.assertTrue(clock.cron_matches("0-10/5 6 1 * 4", stamp))
        self.assertFalse(clock.cron_matches("12 */6 * * *", stamp))


if __name__ == "__main__":
    unittest.main()
