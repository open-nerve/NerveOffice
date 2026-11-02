"""Use tiny Python children and an injected read-only session observer; no browsers."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import run as runner
from lifecycle import Store


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
        self.temp = tempfile.TemporaryDirectory(prefix="session-runner-")
        self.repo = Path(self.temp.name).resolve()
        self.ready = self.repo / "sample-ready"

    def tearDown(self):
        self.temp.cleanup()

    def invoke(self, observer, code):
        args = ["run.py", "--repo", str(self.repo), "e2e", "--", sys.executable, "-c", code, str(self.ready)]
        with patch.object(sys, "argv", args), patch.object(runner, "SessionGuard", return_value=observer, create=True):
            result = runner.main()
        records = list((self.repo / ".test-resources/runs").glob("*/run.json"))
        self.assertEqual(len(records), 1)
        data = json.loads(records[0].read_text())
        self.assertEqual(data["cleanupStage"], "complete")
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

    def test_session_stop_does_not_signal_other_group_or_remove_other_resources(self):
        (self.repo / "other-project").mkdir()
        other_store = Store(self.repo / "other-project")
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
            other.finish("passed")


if __name__ == "__main__":
    unittest.main()
