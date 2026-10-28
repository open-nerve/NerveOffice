"""Small real filesystem fixtures; run through the managed test runner."""
import copy
import importlib.util
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid


class PreflightReceiptTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(
            prefix="preflight-receipt-", dir=os.environ["NERVE_TEST_SCRATCH"])
        self.addCleanup(self.temporary.cleanup)
        self.repo = Path(self.temporary.name).resolve()
        spec = importlib.util.find_spec("ci_preflight_receipt")
        self.assertIsNotNone(spec, "the bounded preflight receipt collector is missing")
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)

    def record(self, *, identity=None, **changes):
        identity = identity or str(uuid.uuid4())
        root = self.repo / ".test-resources"
        runs = root / "runs"
        runs.mkdir(parents=True, exist_ok=True)
        (root / "owner.json").write_text(json.dumps({
            "version": 1, "purpose": "nerve-office-test-resources", "repo": str(self.repo),
        }))
        directory = runs / identity
        directory.mkdir()
        (directory / "run.lock").touch()
        data = {"version": 1, "runId": identity, "repo": str(self.repo),
                "kind": "ci-preflight", "status": "passed", "cleanupStage": "complete",
                "exitCode": 0, "childGroup": 12345, "ownerPid": os.getpid(),
                "startedAt": 1.0, "endedAt": 2.0,
                "shortRoot": str(Path("/tmp").resolve() / ("nerve-t-" + identity)),
                "command": ["COMMAND-SECRET"], "env": {"PRIVATE": "ENV-SECRET"}}
        data.update(changes)
        (directory / "run.json").write_text(json.dumps(data))
        return directory

    def reject(self, expected):
        result = self.module.collect(self.repo)
        self.assertEqual(result["collectionStatus"], "rejected")
        self.assertEqual(result["error"], expected)
        self.assertEqual(result["runs"], [])
        self.assertNotIn("SECRET", json.dumps(result))
        return result

    def hosted_record(self, *, identity=None, status="passed", exit_code=0):
        identity = identity or str(uuid.uuid4())
        run = self.repo / ".test-resources/runs" / identity
        scope = {"version": 1, "policy": "github-hosted-vm", "runId": identity,
                 "context": {"version": 1, "policy": "github-hosted-vm", "repo": str(self.repo),
                             "repository": "open-nerve/NerveOffice", "sha": "a" * 40,
                             "runId": "40600596503", "attempt": "2", "job": "verify",
                             "runner": "GitHub Actions test",
                             "bootId": "66666666-7777-4888-8999-aaaaaaaaaaaa"},
                 "roots": {"scratch": str(run / "scratch"),
                           "short": str(Path("/tmp").resolve() / ("nerve-t-" + identity)),
                           "reports": str(run / "reports"),
                           "failures": str(self.repo / ".test-resources/failures" / identity)}}
        directory = self.record(identity=identity, status=status, exitCode=exit_code,
                                interrupted=status == "interrupted",
                                cleanupStage="host-disposal-pending", cleanupComplete=False,
                                producerQuiescent=True, hostedScope=scope,
                                stableExport={"manifest": "test-results/stable-export.json",
                                              "sha256": "b" * 64, "files": 2, "bytes": 64,
                                              "complete": True},
                                resourceBudget={"bytes": 128, "files": 4, "freeBytes": 24 * 1024 ** 3,
                                                "limitBytes": 16 * 1024 ** 3,
                                                "reserveBytes": 12 * 1024 ** 3, "reportBytes": 256},
                                referenceObservation={"operation": "non-destructive-export",
                                                      "root": str(run / "scratch"),
                                                      "incompleteRecordCount": 3,
                                                      "incompleteRecords": [{"private": "REFERENCE-SECRET"}],
                                                      "incompleteRecordsTruncated": False,
                                                      "absenceProven": False,
                                                      "rawDeletionAuthorized": False})
        (directory / "scratch").mkdir()
        return directory

    def cli(self, *arguments):
        target = self.repo / "tools/test-resources/ci_preflight_receipt.py"
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(self.module.__file__, target)
        return subprocess.run([sys.executable, "-B", str(target), *arguments],
                              cwd="/", capture_output=True, timeout=3, check=False)

    def test_missing_root_is_explicit_and_does_not_create_resources(self):
        self.assertEqual(self.module.collect(self.repo), {
            "version": 1, "kind": "ci-preflight", "collectionStatus": "missing",
            "runs": [], "error": None,
        })
        self.assertEqual(list(self.repo.iterdir()), [])

    def test_only_preflight_fields_are_collected_without_changing_files(self):
        directory = self.record()
        self.record(kind="e2e", cleanupError="OTHER-RUN-SECRET")
        before = {p: p.read_bytes() for p in self.repo.rglob("*") if p.is_file()}
        result = self.module.collect(self.repo)
        self.assertEqual(result, {
            "version": 1, "kind": "ci-preflight", "collectionStatus": "collected", "error": None,
            "runs": [{"runId": directory.name, "kind": "ci-preflight", "status": "passed",
                      "cleanupStage": "complete", "exitCode": 0, "childGroup": 12345,
                      "scratchExists": False, "shortRootExists": False,
                      "cleanupError": None, "cleanupErrorTruncated": False}],
        })
        self.assertEqual(before, {p: p.read_bytes() for p in self.repo.rglob("*") if p.is_file()})
        self.assertNotIn("SECRET", json.dumps(result))

    def test_creation_failure_keeps_missing_exit_and_short_root_unknown(self):
        directory = self.record(status="cleanup-pending", cleanupStage="creation-incomplete",
                                cleanupError="fixed failure", exitCode=None, childGroup=None)
        data = json.loads((directory / "run.json").read_text())
        del data["shortRoot"]
        del data["endedAt"]
        (directory / "run.json").write_text(json.dumps(data))
        result = self.module.collect(self.repo)
        self.assertEqual(result["collectionStatus"], "collected")
        row = result["runs"][0]
        self.assertEqual(row["status"], "cleanup-pending")
        self.assertEqual(row["cleanupStage"], "creation-incomplete")
        self.assertIsNone(row["exitCode"])
        self.assertIsNone(row["shortRootExists"])
        self.assertNotIn("cleanupComplete", row)

    def test_host_pending_is_bounded_diagnostic_only_and_leaves_resources_untouched(self):
        # The short root belongs to the outer managed run: observe it without taking ownership.
        directory = self.hosted_record(identity=os.environ["NERVE_TEST_RUN_ID"])
        os.mkfifo(directory / "scratch/must-not-read")
        before = {p: p.read_bytes() for p in self.repo.rglob("*") if p.is_file()}
        result = self.module.collect(self.repo)
        self.assertEqual(result["collectionStatus"], "collected")
        row = result["runs"][0]
        self.assertEqual(row["status"], "passed")
        self.assertEqual(row["cleanupStage"], "host-disposal-pending")
        self.assertIs(row["cleanupComplete"], False)
        self.assertIs(row["producerQuiescent"], True)
        self.assertEqual(row["validation"], "diagnostic-only")
        self.assertTrue(row["scratchExists"])
        self.assertTrue(row["shortRootExists"])
        self.assertEqual(row["hostedContext"], {
            "version": 1, "policy": "github-hosted-vm", "repository": "open-nerve/NerveOffice",
            "sha": "a" * 40, "runId": "40600596503", "attempt": "2", "job": "verify",
            "runner": "GitHub Actions test", "bootId": "66666666-7777-4888-8999-aaaaaaaaaaaa",
        })
        self.assertEqual(row["stableExport"], {"manifest": "test-results/stable-export.json",
                                              "sha256": "b" * 64, "files": 2, "bytes": 64,
                                              "complete": True})
        self.assertEqual(row["resourceBudget"], {"bytes": 128, "files": 4,
                                                "freeBytes": 24 * 1024 ** 3,
                                                "limitBytes": 16 * 1024 ** 3,
                                                "reserveBytes": 12 * 1024 ** 3, "reportBytes": 256})
        self.assertEqual(row["referenceObservation"], {"incompleteRecordCount": 3,
                                                      "absenceProven": False,
                                                      "rawDeletionAuthorized": False})
        self.assertNotIn("SECRET", json.dumps(result))
        self.assertNotIn("ciAccepted", row)
        self.assertNotIn("disposalObserved", row)
        self.assertEqual(before, {p: p.read_bytes() for p in self.repo.rglob("*") if p.is_file()})
        self.assertFalse((directory / "reports").exists(), "diagnostics must not create or verify an export")

    def test_host_pending_failed_and_interrupted_results_are_not_promoted(self):
        directory = self.hosted_record(status="failed", exit_code=7)
        path = directory / "run.json"
        for status, code in (("failed", 7), ("interrupted", 143)):
            with self.subTest(status=status):
                value = json.loads(path.read_text())
                value.update(status=status, exitCode=code, interrupted=status == "interrupted")
                path.write_text(json.dumps(value))
                command = self.cli()
                self.assertEqual(command.returncode, 0)  # Only diagnostic collection succeeds.
                row = json.loads(command.stdout)["runs"][0]
                self.assertEqual((row["status"], row["exitCode"]), (status, code))
                self.assertIs(row["cleanupComplete"], False)
                self.assertFalse(row["shortRootExists"])
                self.assertEqual(command.stderr, b"")

    def test_host_pending_requires_explicit_producer_and_disposal_records(self):
        directory = self.hosted_record()
        path = directory / "run.json"
        original = json.loads(path.read_text())
        for field in ("hostedScope", "cleanupComplete", "producerQuiescent", "stableExport",
                      "resourceBudget", "referenceObservation"):
            with self.subTest(missing=field):
                value = copy.deepcopy(original)
                del value[field]
                path.write_text(json.dumps(value))
                self.reject("invalid-hosted-record")
        for field, replacement in (("cleanupComplete", True), ("cleanupComplete", 0),
                                   ("producerQuiescent", False), ("producerQuiescent", 1)):
            with self.subTest(field=field, value=replacement):
                value = copy.deepcopy(original)
                value[field] = replacement
                path.write_text(json.dumps(value))
                self.reject("invalid-hosted-record")

    def test_host_pending_does_not_relax_product_or_local_complete_consistency(self):
        directory = self.hosted_record()
        path = directory / "run.json"
        original = json.loads(path.read_text())
        for change in ({"status": "passed", "exitCode": 7}, {"status": "failed", "exitCode": 0},
                       {"status": "interrupted", "exitCode": 0, "interrupted": True},
                       {"status": "cleanup-pending"}, {"status": "passed", "interrupted": True},
                       {"cleanupStage": "complete", "cleanupComplete": True}):
            with self.subTest(change=change):
                path.write_text(json.dumps({**original, **change}))
                self.reject("inconsistent-record")

    def test_host_pending_scope_summary_is_bound_to_manifest_and_paths(self):
        directory = self.hosted_record()
        path = directory / "run.json"
        original = json.loads(path.read_text())
        changes = (("runId", str(uuid.uuid4())), ("policy", "strict"),
                   ("context.repo", "/FOREIGN-SECRET"), ("context.version", True),
                   ("context.runner", "x" * 129), ("context.sha", "wrong"),
                   ("roots.scratch", "/FOREIGN-SECRET"), ("roots.short", "/FOREIGN-SECRET"))
        for field, replacement in changes:
            with self.subTest(field=field):
                value = copy.deepcopy(original)
                target = value["hostedScope"]
                names = field.split(".")
                for name in names[:-1]:
                    target = target[name]
                target[names[-1]] = replacement
                path.write_text(json.dumps(value))
                self.reject("invalid-hosted-record")

    def test_host_pending_export_budget_and_reference_summaries_reject_invalid_values(self):
        directory = self.hosted_record()
        path = directory / "run.json"
        original = json.loads(path.read_text())
        changes = (("stableExport", "manifest", "/MANIFEST-SECRET"),
                   ("stableExport", "sha256", "not-a-hash"), ("stableExport", "files", True),
                   ("stableExport", "bytes", -1), ("stableExport", "complete", False),
                   ("resourceBudget", "bytes", 17 * 1024 ** 3),
                   ("resourceBudget", "freeBytes", 1), ("resourceBudget", "files", False),
                   ("resourceBudget", "reportBytes", -1),
                   ("referenceObservation", "incompleteRecordCount", True),
                   ("referenceObservation", "absenceProven", True),
                   ("referenceObservation", "rawDeletionAuthorized", True))
        for record, field, replacement in changes:
            with self.subTest(record=record, field=field):
                value = copy.deepcopy(original)
                value[record][field] = replacement
                path.write_text(json.dumps(value))
                self.reject("invalid-hosted-record")

    def test_host_pending_omits_raw_reference_details_and_bounds_summary(self):
        directory = self.hosted_record()
        path = directory / "run.json"
        value = json.loads(path.read_text())
        value["referenceObservation"]["incompleteRecords"] = [{"private": "SECRET" * 5000}]
        path.write_text(json.dumps(value))
        result = self.module.collect(self.repo)
        self.assertEqual(result["collectionStatus"], "collected")
        self.assertLess(len(json.dumps(result).encode()), 4096)
        self.assertNotIn("SECRET", json.dumps(result))

    def test_pending_roots_are_observed_without_scanning_contents(self):
        # This outer runner's short root is already registered; only observe it.
        directory = self.record(identity=os.environ["NERVE_TEST_RUN_ID"],
                                status="cleanup-pending", cleanupStage=None, exitCode=1)
        scratch = directory / "scratch"
        scratch.mkdir()
        os.mkfifo(scratch / "must-not-read")
        result = self.module.collect(self.repo)
        self.assertEqual(result["collectionStatus"], "collected")
        row = result["runs"][0]
        self.assertTrue(row["scratchExists"])
        self.assertTrue(row["shortRootExists"])
        self.assertEqual(row["exitCode"], 1)

    def test_owner_mismatch_is_rejected(self):
        self.record()
        (self.repo / ".test-resources/owner.json").write_text('{"repo":"OWNER-SECRET"}')
        self.reject("invalid-owner")

    def test_symlink_components_are_not_followed(self):
        directory = self.record()
        for relative in (".test-resources", ".test-resources/runs",
                         str(directory.relative_to(self.repo)),
                         str((directory / "run.json").relative_to(self.repo)),
                         str((directory / "run.lock").relative_to(self.repo)),
                         ".test-resources/owner.json"):
            with self.subTest(relative=relative):
                path = self.repo / relative
                backup = self.repo / "saved-component"
                path.rename(backup)
                path.symlink_to(backup)
                try:
                    self.reject("unsafe-path")
                finally:
                    path.unlink()
                    backup.rename(path)

    def test_fifo_manifest_and_lock_are_rejected_without_blocking(self):
        directory = self.record()
        for name in ("run.json", "run.lock"):
            with self.subTest(name=name):
                path = directory / name
                before = path.read_bytes()
                path.unlink()
                os.mkfifo(path)
                try:
                    command = self.cli()
                    self.assertEqual(command.returncode, 1)
                    self.assertEqual(json.loads(command.stdout)["error"], "unsafe-path")
                    self.assertEqual(command.stderr, b"")
                finally:
                    path.unlink()
                    path.write_bytes(before)

    def test_missing_lock_is_rejected_without_creating_one(self):
        directory = self.record()
        (directory / "run.lock").unlink()
        self.reject("read-failed")
        self.assertFalse((directory / "run.lock").exists())

    def test_active_preflight_is_not_read_as_finished(self):
        directory = self.record()
        with (directory / "run.lock").open("rb") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.reject("active-run")

    def test_active_other_kind_is_not_reported_or_locked(self):
        directory = self.record(kind="e2e", status="running", cleanupStage=None)
        with (directory / "run.lock").open("rb") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.module.collect(self.repo)
            self.assertEqual(result["collectionStatus"], "missing")
            self.assertEqual(result["runs"], [])

    def test_unfinished_status_is_rejected_even_without_a_writer_lock(self):
        directory = self.record()
        data = json.loads((directory / "run.json").read_text())
        for status in ("prepared", "running"):
            with self.subTest(status=status):
                data["status"] = status
                (directory / "run.json").write_text(json.dumps(data))
                self.reject("run-not-ended")

    def test_schema_and_identity_mismatches_are_rejected(self):
        directory = self.record()
        original = json.loads((directory / "run.json").read_text())
        changes = [{"repo": "/REPO-SECRET"}, {"runId": str(uuid.uuid4())},
                   {"version": True}, {"status": "STATUS-SECRET"},
                   {"exitCode": True}, {"exitCode": -1}, {"childGroup": False},
                   {"childGroup": "PID-SECRET"}, {"cleanupStage": "STAGE-SECRET"},
                   {"cleanupError": {"secret": "ERROR-SECRET"}}]
        for change in changes:
            with self.subTest(change=change):
                (directory / "run.json").write_text(json.dumps({**original, **change}))
                self.reject("invalid-manifest")

    def test_unregistered_short_root_is_not_probed(self):
        self.record(shortRoot="/SHORT-SECRET")
        self.reject("invalid-run-path")

    def test_scratch_symlink_is_rejected(self):
        directory = self.record(status="cleanup-pending", cleanupStage=None, exitCode=1)
        (directory / "scratch").symlink_to(self.repo)
        self.reject("unsafe-path")

    def test_complete_with_existing_scratch_is_rejected(self):
        directory = self.record()
        (directory / "scratch").mkdir()
        self.reject("inconsistent-record")

    def test_complete_with_existing_registered_short_root_is_rejected(self):
        self.record(identity=os.environ["NERVE_TEST_RUN_ID"])
        self.reject("inconsistent-record")

    def test_missing_child_group_is_not_invented_as_no_child(self):
        directory = self.record()
        data = json.loads((directory / "run.json").read_text())
        del data["childGroup"]
        (directory / "run.json").write_text(json.dumps(data))
        self.reject("invalid-manifest")

    def test_never_started_record_cannot_claim_passed(self):
        self.record(cleanupStage="never-started", childGroup=None)
        self.reject("inconsistent-record")

    def test_manifest_limit_and_malformed_json_are_rejected(self):
        directory = self.record()
        path = directory / "run.json"
        path.write_bytes(b"x" * (65536 + 1))
        self.reject("manifest-too-large")
        for raw in (b"{JSON-SECRET", b"\xff", b'{"kind":"e2e","kind":"ci-preflight"}',
                    b"[" * 2000 + b"]" * 2000):
            with self.subTest(raw=raw[:20]):
                path.write_bytes(raw)
                self.reject("invalid-json")

    def test_four_receipts_are_bounded_and_fifth_is_rejected(self):
        for _ in range(4):
            self.record(status="cleanup-pending", cleanupStage=None, exitCode=1,
                        cleanupError="诊断\n\x00\x1b" * 1000)
        result = self.module.collect(self.repo)
        self.assertEqual(result["collectionStatus"], "collected")
        self.assertEqual(len(result["runs"]), 4)
        self.assertLessEqual(len((json.dumps(result, ensure_ascii=False) + "\n").encode()), 65536)
        for row in result["runs"]:
            self.assertTrue(row["cleanupErrorTruncated"])
            self.assertLessEqual(len(row["cleanupError"].encode()), 2048)
            self.assertNotIn("\x00", row["cleanupError"])
            self.assertNotIn("\x1b", row["cleanupError"])
        self.record()
        self.reject("too-many-preflights")

    def test_directory_enumeration_is_bounded(self):
        directory = self.record()
        for _ in range(128):
            (directory.parent / str(uuid.uuid4())).mkdir()
        self.reject("too-many-run-directories")

    def test_cli_uses_script_repo_and_refuses_arguments(self):
        directory = self.record(status="failed", exitCode=1)
        command = self.cli()
        self.assertEqual(command.returncode, 0)  # Collection success, not preflight success.
        self.assertTrue(command.stdout, "the CLI must emit its bounded JSON receipt")
        result = json.loads(command.stdout)
        self.assertEqual(result["runs"][0]["runId"], directory.name)
        self.assertEqual(result["runs"][0]["exitCode"], 1)
        self.assertEqual(command.stderr, b"")
        command = self.cli("ARGUMENT-SECRET")
        self.assertEqual(command.returncode, 1)
        self.assertEqual(json.loads(command.stdout)["error"], "unexpected-arguments")
        self.assertNotIn(b"SECRET", command.stdout + command.stderr)


if __name__ == "__main__":
    unittest.main()
