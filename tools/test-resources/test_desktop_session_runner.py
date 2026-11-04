"""Use tiny Python children and an injected read-only session observer; no browsers."""
import contextlib
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import unittest
from unittest.mock import Mock, patch

import run as runner
import lifecycle
from lifecycle import Store
from fixture_retention import ManagedFixture


class ObservedSession:
    def __init__(self, healthy):
        self.healthy = healthy
        self.forced = 0
        self.failed = False

    def check(self, force=False):
        self.forced += int(force)
        self.failed = self.failed or not self.healthy(self)
        return not self.failed

    def record(self):
        return {"version": 1, "status": "stopped" if self.failed else "monitoring",
                "reason": "session-changed" if self.failed else None}


class DesktopSessionRunnerTests(unittest.TestCase):
    def setUp(self):
        self.fixture = ManagedFixture()
        self.addCleanup(self.fixture.close)
        self.repo = self.fixture.path
        self.ready = self.repo / "sample-ready"

    def invoke(self, observer, code):
        args = ["run.py", "--repo", str(self.repo), "e2e", "--", sys.executable, "-c", code, str(self.ready)]
        with patch.object(sys, "argv", args), patch.object(runner, "SessionGuard", return_value=observer, create=True):
            result = runner.main()
        self.fixture.capture()
        records = list((self.repo / ".test-resources/runs").glob("*/run.json"))
        self.assertEqual(len(records), 1)
        data = json.loads(records[0].read_text())
        self.assertEqual(data.get("cleanupStage"), "complete",
                         json.dumps({key: data.get(key) for key in ('status', 'cleanupStage', 'cleanupError')}, ensure_ascii=False))
        self.assertFalse((records[0].parent / "scratch").exists())
        self.assertFalse(Path(data["shortRoot"]).exists())
        return result, data

    def sample(self, seconds=1.0, exit_code=0):
        return (
            "import os,pathlib,signal,sys,time; "
            "signal.signal(signal.SIGTERM,lambda *_:sys.exit(0)); "
            "pathlib.Path(sys.argv[1]).write_text('ready'); "
            "pathlib.Path(os.environ['NERVE_TEST_OUTPUT_DIR'],'results.json').write_text('{\"stats\":{},\"errors\":[]}'); "
            f"time.sleep({seconds}); sys.exit({exit_code})"
        )

    def test_desktop_change_interrupts_owned_child_even_when_signal_handler_exits_zero(self):
        observer = ObservedSession(lambda _: not self.ready.exists())
        result, data = self.invoke(observer, self.sample())
        self.assertEqual(result, 143)
        self.assertEqual(data["commandExitCode"], 0)
        self.assertEqual(data["status"], "interrupted")
        self.assertEqual(data["stopReason"], "desktop-session")
        self.assertEqual(data["desktopSession"]["status"], "stopped")

    def test_unavailable_preflight_never_executes_test_command(self):
        result, data = self.invoke(ObservedSession(lambda _: False), self.sample(0))
        self.assertEqual(result, 143)
        self.assertFalse(self.ready.exists())
        self.assertIsNone(data["childGroup"])
        self.assertEqual(data["status"], "interrupted")

    def test_change_at_start_barrier_never_releases_test_command(self):
        observer = ObservedSession(lambda s: s.forced < 2)
        result, data = self.invoke(observer, self.sample(0))
        self.assertEqual(result, 143)
        self.assertFalse(self.ready.exists())
        self.assertEqual(data["status"], "interrupted")

    def test_zero_exit_is_not_accepted_when_final_forced_read_changes(self):
        observer = ObservedSession(lambda s: s.forced < 3)
        result, data = self.invoke(observer, self.sample(0))
        self.assertTrue(self.ready.exists())
        self.assertEqual(data["commandExitCode"], 0)
        self.assertEqual(result, 143)
        self.assertEqual(data["status"], "interrupted")

    def test_healthy_session_preserves_success(self):
        result, data = self.invoke(ObservedSession(lambda _: True), self.sample(0))
        self.assertEqual(result, 0)
        self.assertEqual(data["status"], "passed")
        self.assertEqual(data.get("desktopSession", {}).get("status"), "monitoring")

    def test_healthy_session_preserves_product_failure(self):
        result, data = self.invoke(ObservedSession(lambda _: True), self.sample(0, 3))
        self.assertEqual(result, 3)
        self.assertEqual(data["status"], "failed")

    def exercise_barrier_exit_race(self, mode):
        waited = []
        sent = []
        child = Mock(pid=12345, stdout=io.BytesIO())
        child.poll.side_effect = lambda: 0 if waited and waited[-1] == "done" else None
        def wait(**kwargs):
            if mode != "term-gone" and not waited:
                waited.append("done" if mode == "ended-before-kill" else "timeout")
                raise subprocess.TimeoutExpired("synthetic-owned-child", 5)
            waited.append("done")
            return 0
        child.wait.side_effect = wait
        def send(pid, signum):
            self.assertEqual(pid, child.pid)
            sent.append(signum)
            if (mode == "term-gone" and len(sent) == 2) or (mode == "kill-gone" and signum == signal.SIGKILL):
                raise ProcessLookupError()
        popen = subprocess.Popen
        def start(args, *a, **kw):
            return child if len(args) > 2 and args[2] == runner.BOOTSTRAP else popen(args, *a, **kw)
        with patch.object(runner.subprocess, "Popen", side_effect=start), \
                patch.object(runner.os, "killpg", side_effect=send), \
                patch.object(runner, "group_alive", return_value=False), \
                patch.object(lifecycle, "group_alive", return_value=False):
            result, data = self.invoke(ObservedSession(lambda s: s.forced < 2), self.sample(0))
        self.assertEqual(result, 143)
        self.assertEqual(data["status"], "interrupted")
        self.assertFalse(self.ready.exists())
        if mode == "ended-before-kill":
            self.assertNotIn(signal.SIGKILL, sent)

    def test_barrier_finally_tolerates_group_gone_before_term(self):
        self.exercise_barrier_exit_race("term-gone")

    def test_barrier_finally_tolerates_group_gone_before_kill(self):
        self.exercise_barrier_exit_race("kill-gone")

    def test_barrier_finally_does_not_kill_after_leader_already_exited(self):
        self.exercise_barrier_exit_race("ended-before-kill")

    def exercise_pending_cleanup(self, kind, late_interrupt=False):
        args = ["run.py", "--repo", str(self.repo), "e2e", "--", sys.executable, "-c", self.sample(0), str(self.ready)]
        observer = ObservedSession(lambda s: late_interrupt or s.forced < 3)
        children = []
        popen = subprocess.Popen
        def start(argv, *a, **kw):
            child = popen(argv, *a, **kw)
            if len(argv) > 2 and argv[2] == runner.BOOTSTRAP:
                children.append(child)
            return child
        try:
            with contextlib.ExitStack() as stack:
                stack.enter_context(patch.object(sys, "argv", args))
                stack.enter_context(patch.object(runner, "SessionGuard", return_value=observer))
                stack.enter_context(patch.object(runner.subprocess, "Popen", side_effect=start))
                if kind == "group":
                    stack.enter_context(patch.object(runner, "group_alive", return_value=True))
                else:
                    writer = Mock()
                    writer.is_alive.return_value = True
                    stack.enter_context(patch.object(runner.threading, "Thread", return_value=writer))
                if late_interrupt:
                    delivered = []
                    def check_group(_):
                        if not delivered:
                            delivered.append(True)
                            signal.getsignal(signal.SIGTERM)(signal.SIGTERM, None)
                        return kind == "group"
                    stack.enter_context(patch.object(runner, "group_alive", side_effect=check_group))
                result = runner.main()
            record, = (self.repo / ".test-resources/runs").glob("*/run.json")
            data = json.loads(record.read_text())
            self.assertEqual(data["status"], "cleanup-pending")
            self.assertTrue((record.parent / "scratch").exists())
            self.assertTrue(Path(data["shortRoot"]).exists())
            self.assertIsNot(data.get("producerQuiescent"), True)
            self.assertEqual(data.get("commandExitCode"), 0)
            self.assertEqual(data.get("exitCode"), 143)
            self.assertTrue(data.get("interrupted"))
            self.assertEqual(result, 143)
        finally:
            # Only simulated pending state remains; close our real sample pipe and
            # let the normal ownership/handle checks recover its registered root.
            for child in children:
                if child.poll() is None:
                    child.terminate(); child.wait(timeout=5)
                child.stdout.close()
            Store(self.repo).sweep()
            self.fixture.capture()
            for record in (self.repo / ".test-resources/runs").glob("*/run.json"):
                data = json.loads(record.read_text())
                self.assertEqual(data["cleanupStage"], "complete")
                self.assertFalse(Path(data["shortRoot"]).exists())

    def test_known_interruption_survives_pending_group_cleanup(self):
        self.exercise_pending_cleanup("group")

    def test_known_interruption_survives_pending_output_cleanup(self):
        self.exercise_pending_cleanup("writer")

    def test_late_interrupt_during_pending_output_cleanup_is_recorded(self):
        self.exercise_pending_cleanup("writer", late_interrupt=True)

    def test_late_interrupt_after_zero_exit_still_returns_interrupted(self):
        delivered = []
        def check_group(_):
            if not delivered:
                delivered.append(True)
                signal.getsignal(signal.SIGTERM)(signal.SIGTERM, None)
            return False
        with patch.object(runner, "group_alive", side_effect=check_group):
            result, data = self.invoke(ObservedSession(lambda _: True), self.sample(0))
        self.assertEqual(data["commandExitCode"], 0)
        self.assertEqual(data["status"], "interrupted")
        self.assertEqual(data["exitCode"], 143)
        self.assertEqual(result, 143)

    def test_session_stop_does_not_signal_other_group_or_remove_other_resources(self):
        other_fixture = ManagedFixture()
        self.addCleanup(other_fixture.close)
        other_store = Store(other_fixture.path)
        other = other_store.create("sample")
        preserved = other.scratch / "keep"
        preserved.write_bytes(b"x" * 1024)
        child = subprocess.Popen([sys.executable, "-c", "import sys,time; sys.stdin.buffer.read(1); time.sleep(30)"],
                                 stdin=subprocess.PIPE, start_new_session=True)
        try:
            other.update(childGroup=child.pid)
            child.stdin.write(b"1"); child.stdin.flush()
            result, data = self.invoke(ObservedSession(lambda _: not self.ready.exists()), self.sample())
            self.assertEqual(result, 143)
            self.assertEqual(data["status"], "interrupted")
            self.assertIsNone(child.poll())
            self.assertEqual(preserved.read_bytes(), b"x" * 1024)
        finally:
            if child.poll() is None:
                child.terminate()
            child.wait(timeout=5)
            child.stdin.close()
            other.update(producerQuiescent=True)
            state = other.finish("passed")
            self.assertEqual(state.get("cleanupStage"), "complete", state.get("cleanupError"))


if __name__ == "__main__":
    unittest.main()
