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
# 托管 Mac 第 5 轮 WebKit 片的台账（run 42816768144）里基线的两个进程
RUN5 = f"154 88 Tue Nov 10 12:32:20 2026 {WS}\n157 501 Tue Nov 10 12:32:21 2026 {LOGIN}\n"


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

    def test_only_loginwindow_is_the_console_users_even_while_temporarily_root(self):
        # loginwindow 以 root 启动（真实、保存用户号为 0）、平时降为当前用户运行，可以临时切回 root：
        # 只有一个时就是控制台用户的那个（控制台属于当前用户已另行核对），不按有效用户号挑选
        self.assertEqual(desktop.parse_snapshot(RUN5.replace("157 501", "157 0"), 501, 501)["loginwindow"]["pid"], 157)

    def test_several_loginwindows_are_told_apart_by_the_current_user(self):
        # 多个登录会话（快速切换用户）时才按有效用户号认出当前用户的那个；认不出就失败关闭
        other = f"301 502 Tue Nov 10 13:00:00 2026 {LOGIN}\n"
        self.assertEqual(desktop.parse_snapshot(RUN5 + other, 501, 501)["loginwindow"]["pid"], 157)
        for value in [RUN5.replace("157 501", "157 0") + other, RUN5 + f"301 501 Tue Nov 10 13:00:00 2026 {LOGIN}\n"]:
            with self.subTest(value=value[-60:]), self.assertRaises(desktop.SessionReadError):
                desktop.parse_snapshot(value, 501, 501)

    def test_fixed_query_is_bounded_and_does_not_read_argv_or_inherit_secrets(self):
        completed = subprocess.CompletedProcess([], 0, TABLE.encode(), b"")
        with patch.object(desktop.subprocess, "run", return_value=completed) as command, \
                patch.object(desktop.os, "stat", return_value=Mock(st_uid=501)), \
                patch.object(desktop.os, "getuid", return_value=501), \
                patch.dict(os.environ, {"EXAMPLE_SECRET": "must-not-copy"}):
            self.assertEqual(desktop.read_snapshot()["windowServer"]["pid"], 29055)
        args, kwargs = command.call_args
        self.assertEqual(args[0], ["/bin/ps", "-ww", "-axo", "pid=,uid=,lstart=,comm="])
        # M5-P8：托管 Mac 负载下这条 ps 超过原 2 秒，需求方批准放宽到 10 秒；超时仍按失败关闭
        self.assertEqual(desktop.PS_TIMEOUT, 10)
        self.assertEqual(kwargs["timeout"], desktop.PS_TIMEOUT)
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
                                  ("windowServer", "startedAt", "Mon Nov 2 06:59:19 2026"),
                                  ("loginwindow", "startedAt", "Mon Nov 2 06:59:19 2026"),
                                  ("windowServer", "executable", sorted(desktop.WINDOW_SERVERS - {WS})[0])]:
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

    def test_same_process_switching_its_effective_uid_is_not_a_session_change(self):
        # 第 5 轮 WebKit 片被停的那一次：WindowServer 的 pid、启动时间与可执行文件都没变，只有 ps 读到的有效用户号由 88 变成 0，
        # 被判成会话变化（误判）。WindowServer 与 loginwindow 都以 root 启动、平时降为普通用户号运行，可以临时切回 root
        baseline = desktop.parse_snapshot(RUN5, 501, 501)
        for switched in (RUN5.replace("154 88", "154 0"), RUN5.replace("157 501", "157 0")):
            observed = desktop.parse_snapshot(switched, 501, 501)
            with self.subTest(switched=switched.splitlines()[0 if "154 0" in switched else 1][:12]), \
                    patch.object(desktop.sys, "platform", "darwin"), \
                    patch.object(desktop, "read_snapshot", side_effect=[baseline, observed, baseline]) as probe:
                guard = desktop.SessionGuard("e2e")
                for _ in range(3):
                    self.assertTrue(guard.check(force=True))
                self.assertEqual(guard.record()["status"], "monitoring")
                self.assertEqual(guard.record()["baseline"], baseline)
                self.assertEqual(probe.call_count, 3)

    def test_read_failure_stops_without_leaking_message_or_rebasing(self):
        with patch.object(desktop.sys, "platform", "darwin"), \
                patch.object(desktop, "read_snapshot", side_effect=[self.baseline(), desktop.SessionReadError("ps-timeout")]):
            guard = desktop.SessionGuard("e2e")
            self.assertTrue(guard.check(force=True))
            self.assertFalse(guard.check(force=True))
            self.assertEqual(guard.record()["reason"], "session-unavailable")
            self.assertEqual(guard.record()["readError"], "ps-timeout")

    def test_sampling_is_throttled_but_forced_finish_read_is_not(self):
        clock = Clock()
        with patch.object(desktop.sys, "platform", "darwin"), \
                patch.object(desktop.time, "monotonic", clock), \
                patch.object(desktop, "read_snapshot", return_value=self.baseline()) as probe:
            guard = desktop.SessionGuard("e2e")
            for now in (0, .1, 1.9, 2.0):
                clock.now = now
                self.assertTrue(guard.check())
            self.assertEqual(probe.call_count, 2)
            clock.now = 2.1
            self.assertTrue(guard.check(force=True))
            self.assertEqual(probe.call_count, 3)

    def test_interval_counts_from_the_end_of_the_previous_read(self):
        # 负载下一次读取要几秒：从读完起算间隔，不让 ps 首尾相接地连续运行
        clock = Clock()

        def slow_read():
            clock.now += 3.0
            return self.baseline()
        with patch.object(desktop.sys, "platform", "darwin"), \
                patch.object(desktop.time, "monotonic", clock), \
                patch.object(desktop, "read_snapshot", side_effect=slow_read) as probe:
            guard = desktop.SessionGuard("e2e")
            self.assertTrue(guard.check())
            clock.now = 4.9
            self.assertTrue(guard.check())
            self.assertEqual(probe.call_count, 1)
            clock.now = 5.0
            self.assertTrue(guard.check())
            self.assertEqual(probe.call_count, 2)

    def test_records_read_count_and_slowest_read_including_the_failed_one(self):
        clock = Clock()
        durations = iter((0.4, 3.25, 10.0))

        def read(outcome):
            clock.now += next(durations)
            if isinstance(outcome, Exception):
                raise outcome
            return outcome
        outcomes = [self.baseline(), self.baseline(), desktop.SessionReadError("ps-timeout")]
        with patch.object(desktop.sys, "platform", "darwin"), \
                patch.object(desktop.time, "monotonic", clock), \
                patch.object(desktop, "read_snapshot", side_effect=lambda: read(outcomes.pop(0))):
            guard = desktop.SessionGuard("e2e")
            self.assertTrue(guard.check(force=True))
            self.assertEqual((guard.record()["readCount"], guard.record()["maxReadSeconds"]), (1, 0.4))
            self.assertTrue(guard.check(force=True))
            self.assertEqual((guard.record()["readCount"], guard.record()["maxReadSeconds"]), (2, 3.25))
            self.assertFalse(guard.check(force=True))
            record = guard.record()
        self.assertEqual((record["readCount"], record["maxReadSeconds"]), (3, 10.0))
        self.assertEqual((record["status"], record["reason"], record["readError"]), ("stopped", "session-unavailable", "ps-timeout"))


class Clock:
    """可控的 time.monotonic：测试直接设定或推进 now。"""
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


if __name__ == "__main__":
    unittest.main()
