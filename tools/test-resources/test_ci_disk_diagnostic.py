"""KiB-only filesystem observations, never a real hosted VM or browser."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch


class DiskDiagnosticTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(dir=os.environ["NERVE_TEST_SCRATCH"])
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.repo = self.base / "home/runner/work/NerveOffice/NerveOffice"
        self.repo.mkdir(parents=True)
        self.runner_temp = self.repo.parents[1] / "_temp"
        self.runner_temp.mkdir()
        spec = importlib.util.find_spec("ci_disk_diagnostic")
        self.assertIsNotNone(spec, "bounded disk diagnostic entry point is missing")
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.identity = {"version": 1, "policy": "github-hosted-vm", "repo": str(self.repo),
                         "repository": "open-nerve/NerveOffice", "sha": "a" * 40,
                         "runId": "41852824658", "attempt": "1", "job": "verify",
                         "runner": "GitHub Actions test", "bootId": "66666666-7777-4888-8999-aaaaaaaaaaaa"}
        self.addCleanup(patch.stopall)
        patch.object(self.module.hosted, "context", return_value=self.identity).start()
        patch.dict(os.environ, {"RUNNER_TEMP": str(self.runner_temp), "PRIVATE_SECRET": "ENV-SECRET"}).start()

    def collect(self, phase="before-install"):
        return self.module.collect(self.repo, phase)

    def row(self, result, name="workspace"):
        return next(row for row in result["directories"] if row["label"] == name)

    def test_unique_inode_sizes_are_read_only_and_filesystem_capacity_is_explicit(self):
        first = self.repo / "first"
        first.write_bytes(b"abc")
        (self.repo / "second").write_bytes(b"12345")
        os.link(first, self.repo / "hardlink")
        before = {p.name: p.read_bytes() for p in self.repo.iterdir()}
        result = self.collect()
        row = self.row(result)
        self.assertEqual(result["collectionStatus"], "collected")
        self.assertIs(result["diagnosticOnly"], True)
        self.assertIs(result["cleanupAuthorized"], False)
        self.assertEqual(row["status"], "collected")
        self.assertEqual(row["logicalFileBytes"], 8)
        self.assertEqual(row["files"], 2)
        self.assertEqual(row["hardlinkDuplicates"], 1)
        self.assertGreaterEqual(row["allocatedBytes"], first.stat().st_blocks * 512)
        self.assertEqual(row["owner"]["uid"], os.getuid())
        self.assertEqual(row["owner"]["inode"], self.repo.stat().st_ino)
        capacity = row["filesystem"]
        self.assertGreater(capacity["totalBytes"], capacity["availableBytes"])
        self.assertGreaterEqual(capacity["freeBytes"], capacity["availableBytes"])
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.repo.iterdir()})
        self.assertNotIn("SECRET", json.dumps(result))
        self.assertEqual(self.row(result, "dependencies")["status"], "missing")

    def test_symlink_targets_and_special_files_are_not_read_or_named(self):
        outside = self.base / "EXTERNAL-SECRET"
        outside.write_bytes(b"x" * 2048)
        (self.repo / "LINK-SECRET").symlink_to(outside)
        os.mkfifo(self.repo / "FIFO-SECRET")
        row = self.row(self.collect())
        self.assertEqual(row["status"], "collected")
        self.assertEqual(row["logicalFileBytes"], 0)
        self.assertEqual(row["symlinks"], 1)
        self.assertEqual(row["specialFiles"], 1)
        self.assertNotIn("SECRET", json.dumps(row))
        self.assertEqual(outside.stat().st_size, 2048)

    def test_sparse_size_is_distinct_from_allocated_blocks(self):
        path = self.repo / "sparse"
        with path.open("wb") as stream:
            stream.truncate(8192)
        row = self.row(self.collect())
        self.assertEqual(row["logicalFileBytes"], 8192)
        self.assertEqual(row["files"], 1)
        self.assertEqual(row["allocatedBytes"], (self.repo.stat().st_blocks + path.stat().st_blocks) * 512)

    def test_pnpm_store_matches_the_pinned_action_observed_in_real_ci(self):
        # CI95 original verify log: setup action/store path, lines 303, 310-311, 334.
        store = self.repo.parents[2] / "setup-pnpm/node_modules/.bin/store/v11"
        store.mkdir(parents=True)
        (store / "CACHE-SECRET").write_bytes(b"cache bytes")
        unrelated = self.base / "UNRELATED-SECRET"
        unrelated.mkdir()
        (unrelated / "private").write_bytes(b"x" * 1024)
        with patch.dict(os.environ, {"PNPM_HOME": str(unrelated)}):
            result = self.collect("after-install")
        row = self.row(result, "pnpm-store")
        self.assertEqual(row["status"], "collected")
        self.assertEqual(row["files"], 1)
        self.assertEqual(row["logicalFileBytes"], 11)
        self.assertNotIn("SECRET", json.dumps(result))

    def test_required_temp_directory_disappearance_is_not_a_complete_diagnostic(self):
        self.runner_temp.rmdir()
        result = self.collect()
        self.assertEqual(result["collectionStatus"], "partial")
        row = self.row(result, "runner-temp")
        self.assertEqual(row["status"], "partial")
        self.assertEqual(row["error"], "required-root-missing")

    def test_filesystem_measurement_failure_is_unknown_not_zero_capacity(self):
        with patch.object(self.module.os, "fstatvfs", side_effect=OSError(5, "FS-SECRET")):
            row = self.module.measure(self.repo, {"remaining": 100})
        self.assertEqual(row["status"], "partial")
        self.assertIsNone(row["filesystem"])
        self.assertEqual(row["error"], "read-failed")
        self.assertNotIn("SECRET", json.dumps(row))

    def test_query_root_link_and_ancestor_link_are_rejected(self):
        outside = self.base / "outside"
        outside.mkdir()
        (outside / "private").write_bytes(b"secret")
        (self.repo / "node_modules").symlink_to(outside, target_is_directory=True)
        result = self.collect()
        self.assertEqual(result["collectionStatus"], "partial")
        self.assertEqual(self.row(result, "dependencies")["error"], "unsafe-path")
        alias = self.base / "alias"
        alias.symlink_to(self.repo.parent, target_is_directory=True)
        row = self.module.measure(alias / "NerveOffice", {"remaining": 100})
        self.assertEqual(row["error"], "unsafe-path")

    def test_identity_or_temp_scope_cannot_select_other_directories(self):
        for key, value in (("job", "e2e"), ("repository", "other/project"), ("repo", str(self.base))):
            with self.subTest(key=key), patch.dict(self.identity, {key: value}):
                result = self.collect()
                self.assertEqual(result["collectionStatus"], "rejected")
                self.assertEqual(result["directories"], [])
        with patch.dict(os.environ, {"RUNNER_TEMP": str(self.base)}):
            result = self.collect()
            self.assertEqual(result["collectionStatus"], "rejected")
            self.assertEqual(result["directories"], [])

    def test_identity_exception_and_arbitrary_arguments_never_echo_values(self):
        with patch.object(self.module.hosted, "context", side_effect=ValueError("TOKEN-SECRET")):
            result = self.collect()
        self.assertEqual(result["collectionStatus"], "rejected")
        self.assertNotIn("SECRET", json.dumps(result))
        self.assertEqual(self.collect("INVALID-SECRET")["directories"], [])
        output = io.StringIO()
        with patch.object(sys, "argv", ["diagnostic", "INVALID-SECRET"]), contextlib.redirect_stdout(output):
            code = self.module.main()
        self.assertNotEqual(code, 0)
        self.assertNotIn("SECRET", output.getvalue())

    def test_read_failure_keeps_capacity_but_marks_sizes_incomplete_without_error_text(self):
        with patch.object(self.module.os, "scandir", side_effect=PermissionError(13, "READ-SECRET")):
            row = self.module.measure(self.repo, {"remaining": 100})
        self.assertEqual(row["status"], "partial")
        self.assertEqual(row["error"], "read-failed")
        self.assertEqual(row["errno"], 13)
        self.assertGreater(row["filesystem"]["totalBytes"], 0)
        self.assertNotIn("SECRET", json.dumps(row))

    def test_entry_and_depth_limits_are_explicit_partial_observations(self):
        for number in range(5):
            (self.repo / str(number)).write_bytes(b"x")
        with patch.object(self.module, "MAX_ENTRIES", 2):
            row = self.module.measure(self.repo, {"remaining": 100})
        self.assertEqual(row["status"], "partial")
        self.assertEqual(row["error"], "entry-limit")
        self.assertLessEqual(row["entries"], 2)
        (self.repo / "nested/deeper").mkdir(parents=True)
        with patch.object(self.module, "MAX_DEPTH", 1):
            row = self.module.measure(self.repo, {"remaining": 100})
        self.assertEqual(row["error"], "depth-limit")
        result = self.module.measure(self.repo, {"remaining": 0})
        self.assertEqual(result["error"], "total-entry-limit")

    def test_timeout_interrupts_query_and_batch_never_claims_complete(self):
        original = self.module.os.scandir

        def slow(fd):
            time.sleep(1)
            return original(fd)

        started = time.monotonic()
        with patch.object(self.module.os, "scandir", side_effect=slow), \
                patch.object(self.module, "QUERY_SECONDS", 0.03), \
                patch.object(self.module, "TOTAL_SECONDS", 0.05):
            result = self.collect()
        self.assertLess(time.monotonic() - started, 0.5)
        self.assertEqual(result["collectionStatus"], "partial")
        self.assertIn("query-timeout", {r["error"] for r in result["directories"]})
        self.assertIn("total-timeout", {r["error"] for r in result["directories"]})

    def test_directory_replaced_by_symlink_during_walk_is_not_followed(self):
        nested = self.repo / "changing"
        nested.mkdir()
        outside = self.base / "outside"
        outside.mkdir()
        (outside / "SECRET").write_bytes(b"x" * 2048)
        original = self.module.os.open
        changed = False

        def replace(name, flags, *args, **kwargs):
            nonlocal changed
            if name == "changing" and kwargs.get("dir_fd") is not None and not changed:
                changed = True
                nested.rename(self.repo / "original")
                nested.symlink_to(outside, target_is_directory=True)
            return original(name, flags, *args, **kwargs)

        with patch.object(self.module.os, "open", side_effect=replace):
            row = self.module.measure(self.repo, {"remaining": 100})
        self.assertTrue(changed)
        self.assertEqual(row["status"], "partial")
        self.assertEqual(row["logicalFileBytes"], 0)
        self.assertNotIn("SECRET", json.dumps(row))

    def test_real_cli_outside_hosted_context_refuses_without_scanning_or_env_dump(self):
        command = [sys.executable, "-B", self.module.__file__, "after-verify"]
        result = subprocess.run(command, capture_output=True, timeout=3, check=False,
                                env={**os.environ, "NERVE_TEST_RESOURCE_POLICY": "strict"})
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, b"")
        value = json.loads(result.stdout)
        self.assertEqual(value["collectionStatus"], "rejected")
        self.assertEqual(value["directories"], [])
        self.assertNotIn(b"SECRET", result.stdout)

    def test_cli_limits_output_and_keeps_unknown_a_failure(self):
        for result in ({"collectionStatus": "partial", "detail": "bounded"},
                       {"collectionStatus": "collected", "detail": "SECRET" * 10000}):
            with self.subTest(result=result["collectionStatus"]):
                output = io.StringIO()
                with patch.object(self.module, "collect", return_value=result), \
                        patch.object(sys, "argv", ["diagnostic", "after-verify"]), \
                        contextlib.redirect_stdout(output):
                    code = self.module.main()
                self.assertEqual(code, 1)
                self.assertLessEqual(len(output.getvalue().encode()), 32768)
                self.assertNotIn("SECRET", output.getvalue())


if __name__ == "__main__":
    unittest.main()
