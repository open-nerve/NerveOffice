"""Synthetic process snapshots only; never capture a screen or alter a session."""
import copy
import os
import subprocess
import unittest
from unittest.mock import Mock, patch

import desktop_session as desktop

WS = "/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer"
LOGIN = "/System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow"
TABLE = f"29055 88 Mon Nov  2 06:58:19 2026 {WS}\n29059 501 Mon Nov  2 06:58:19 2026 {LOGIN}\n1 0 Sun Oct 25 17:23:38 2026 /sbin/launchd\n"


class SnapshotTests(unittest.TestCase):
    def test_extracts_only_system_session_identity(self):
        value = desktop.parse_snapshot(TABLE, 501, 501)
        self.assertEqual(value["consoleUid"], 501)
        self.assertEqual(value["windowServer"]["pid"], 29055)
        self.assertEqual(value["loginwindow"]["startedAt"], "Mon Nov 2 06:58:19 2026")
        self.assertNotIn("launchd", str(value))

    def test_refuses_unavailable_ambiguous_or_malformed_identity(self):
        cases = ["", TABLE.replace(WS, "/tmp/WindowServer"), TABLE.replace(LOGIN, "/tmp/loginwindow"),
                 TABLE + f"29056 88 Mon Nov 2 06:58:19 2026 {WS}\n", TABLE + TABLE,
                 TABLE.replace("29055 88", "bad-pid 88"), TABLE.replace("06:58:19", "99:58:19"),
                 TABLE.replace("Mon Nov", "bad Nov"), TABLE + "truncated\n"]
        for value in cases:
            with self.subTest(value=value[:50]), self.assertRaises(desktop.SessionReadError):
                desktop.parse_snapshot(value, 501, 501)

    def test_console_and_login_identity_must_belong_to_current_user(self):
        for console, current in [(0, 501), (502, 501), (0, 0), (501, 502)]:
            with self.subTest(console=console, current=current), self.assertRaises(desktop.SessionReadError):
                desktop.parse_snapshot(TABLE, console, current)

    def test_fixed_query_is_bounded_and_does_not_read_argv_or_inherit_secrets(self):
        completed = subprocess.CompletedProcess([], 0, TABLE.encode(), b"")
        with patch.object(desktop.subprocess, "run", return_value=completed) as command, \
                patch.object(desktop.os, "stat", return_value=Mock(st_uid=501)), \
                patch.object(desktop.os, "getuid", return_value=501), \
                patch.dict(os.environ, {"EXAMPLE_SECRET": "must-not-copy"}):
            self.assertEqual(desktop.read_snapshot()["windowServer"]["pid"], 29055)
        args, kwargs = command.call_args
        self.assertEqual(args[0], ["/bin/ps", "-ww", "-axo", "pid=,uid=,lstart=,comm="])
        self.assertEqual(kwargs["timeout"], 2)
        self.assertEqual(kwargs["env"]["LC_ALL"], "C")
        self.assertNotIn("EXAMPLE_SECRET", kwargs["env"])

    def test_query_errors_are_sanitized_and_never_return_partial_identity(self):
        errors = [subprocess.TimeoutExpired("not-for-record", 2), OSError("secret error"),
                  subprocess.CompletedProcess([], 1, TABLE.encode(), b""),
                  subprocess.CompletedProcess([], 0, TABLE.encode(), b"secret warning"),
                  subprocess.CompletedProcess([], 0, b"x" * (desktop.MAX_PS_BYTES + 1), b""),
                  subprocess.CompletedProcess([], 0, b"\xff", b"")]
        for value in errors:
            with self.subTest(value=type(value).__name__), \
                    patch.object(desktop.subprocess, "run", side_effect=value if isinstance(value, Exception) else None,
                                 return_value=None if isinstance(value, Exception) else value), \
                    patch.object(desktop.os, "stat", return_value=Mock(st_uid=501)), \
                    patch.object(desktop.os, "getuid", return_value=501):
                with self.assertRaises(desktop.SessionReadError) as raised:
                    desktop.read_snapshot()
                self.assertNotIn("secret", str(raised.exception))

    def test_console_change_during_read_fails_closed(self):
        with patch.object(desktop.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, TABLE.encode(), b"")), \
                patch.object(desktop.os, "stat", side_effect=[Mock(st_uid=501), Mock(st_uid=502)]), \
                patch.object(desktop.os, "getuid", return_value=501):
            with self.assertRaises(desktop.SessionReadError):
                desktop.read_snapshot()


class GuardTests(unittest.TestCase):
    def baseline(self):
        return desktop.parse_snapshot(TABLE, 501, 501)

    def test_all_browser_entry_kinds_guard_on_macos(self):
        for kind in ("e2e", "container", "measure", "template", "native", "vm", "gate"):
            with self.subTest(kind=kind), patch.object(desktop.sys, "platform", "darwin"), \
                    patch.object(desktop, "read_snapshot", return_value=self.baseline()) as probe:
                guard = desktop.SessionGuard(kind)
                self.assertTrue(guard.check(force=True))
                self.assertEqual(guard.record()["status"], "monitoring")
                self.assertEqual(probe.call_count, 1)

    def test_nonmac_and_nonbrowser_runs_do_not_query_session(self):
        for platform, kind in [("linux", "e2e"), ("darwin", "unit"), ("darwin", "integration")]:
            with self.subTest(platform=platform, kind=kind), patch.object(desktop.sys, "platform", platform), \
                    patch.object(desktop, "read_snapshot") as probe:
                guard = desktop.SessionGuard(kind)
                self.assertTrue(guard.check(force=True))
                self.assertEqual(guard.record()["status"], "not-applicable")
                probe.assert_not_called()

    def test_identity_changes_including_same_pid_reuse_are_sticky(self):
        for actor, key, value in [("windowServer", "pid", 29056), ("loginwindow", "pid", 29060),
                                  ("windowServer", "startedAt", "Mon Nov 2 06:59:19 2026")]:
            baseline = self.baseline(); changed = copy.deepcopy(baseline); changed[actor][key] = value
            with self.subTest(actor=actor, key=key), patch.object(desktop.sys, "platform", "darwin"), \
                    patch.object(desktop, "read_snapshot", side_effect=[baseline, changed, baseline]) as probe:
                guard = desktop.SessionGuard("e2e")
                self.assertTrue(guard.check(force=True))
                self.assertFalse(guard.check(force=True))
                self.assertFalse(guard.check(force=True))
                self.assertEqual(guard.record()["reason"], "session-changed")
                self.assertEqual(guard.record()["baseline"], baseline)
                self.assertEqual(probe.call_count, 2)

    def test_read_failure_stops_without_leaking_message_or_rebasing(self):
        with patch.object(desktop.sys, "platform", "darwin"), \
                patch.object(desktop, "read_snapshot", side_effect=[self.baseline(), desktop.SessionReadError("ps-timeout")]):
            guard = desktop.SessionGuard("e2e")
            self.assertTrue(guard.check(force=True))
            self.assertFalse(guard.check(force=True))
            self.assertEqual(guard.record()["reason"], "session-unavailable")
            self.assertEqual(guard.record()["readError"], "ps-timeout")

    def test_sampling_is_throttled_but_forced_finish_read_is_not(self):
        with patch.object(desktop.sys, "platform", "darwin"), \
                patch.object(desktop.time, "monotonic", side_effect=[0, .1, 1.9, 2.0, 2.1]), \
                patch.object(desktop, "read_snapshot", return_value=self.baseline()) as probe:
            guard = desktop.SessionGuard("e2e")
            for _ in range(4):
                self.assertTrue(guard.check())
            self.assertEqual(probe.call_count, 2)
            self.assertTrue(guard.check(force=True))
            self.assertEqual(probe.call_count, 3)


if __name__ == "__main__":
    unittest.main()
