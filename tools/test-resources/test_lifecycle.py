"""只使用 KiB 级样本和自建子进程，不启动浏览器、数据库或 VM。"""
import contextlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from lifecycle import Store, compact_profiles, failed_profile_names

class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="nerve-residue-test-")
        self.repo = Path(self.temp.name).resolve()
        self.store = Store(self.repo, failure_bytes=4096, failure_run_bytes=2048, report_bytes=16384)

    def tearDown(self):
        self.temp.cleanup()

    def profile(self, run, name="case", size=1024):
        path = run.scratch / "tests/e2e/test-results/persistent-profiles" / name
        path.mkdir(parents=True)
        (path / "resource-owner.json").write_text(json.dumps({"version": 1, "runId": run.id, "kind": "browser-profile"}))
        (path / "cache.bin").write_bytes(b"x" * size)
        return path

    def test_success_removes_scratch_and_preserves_report_and_opfs(self):
        run = self.store.create("e2e")
        p = self.profile(run)
        archive = p / "opfs-archive"
        archive.mkdir()
        (archive / "manifest.json").write_text('{"files": []}')
        (archive / "cleanup.json").write_text('{"removed": true}')
        (run.scratch / "tests/e2e/test-results/results.json").write_text('{"stats":{"expected":1},"errors":[]}')
        (run.scratch / "discard.tmp").write_bytes(b"x" * 1024)
        receipt = run.finish("passed")
        self.assertEqual(receipt["status"], "passed")
        self.assertFalse(run.scratch.exists())
        kept = run.directory / "reports/test-results"
        self.assertTrue((kept / "results.json").is_file())
        self.assertTrue((kept / "persistent-profiles/case/opfs-archive/manifest.json").is_file())
        self.assertFalse((kept / "persistent-profiles/case/cache.bin").exists())

    def test_failure_keeps_bounded_profile_but_not_full_large_environment(self):
        run = self.store.create("e2e")
        self.profile(run, "small", 512)
        self.profile(run, "large", 8192)
        (run.scratch / "vm.img").write_bytes(b"v" * 16384)
        result = run.finish("failed")
        self.assertFalse(run.scratch.exists())
        self.assertLessEqual(result["retainedProfileBytes"], 2048)
        self.assertTrue(list((self.store.root / "failures" / run.id).rglob("cache.bin")))
        self.assertTrue(any(x["reason"] == "per-run-cap" for x in result["profileOmissions"]))

    def test_repeat_cleanup_is_safe_and_other_directory_survives(self):
        other = self.repo / "other-test"
        other.mkdir(); (other / "data").write_text("keep")
        run = self.store.create("sample")
        (run.scratch / "junk").write_text("discard")
        run.finish("passed")
        self.store.sweep(); self.store.sweep()
        self.assertEqual((other / "data").read_text(), "keep")

    def test_active_run_is_never_reaped(self):
        run = self.store.create("sample")
        (run.scratch / "active").write_text("keep")
        report = self.store.sweep()
        self.assertIn(run.id, report["active"])
        self.assertTrue((run.scratch / "active").exists())
        run.finish("passed")

    def test_open_file_and_live_group_preserve_resources(self):
        run = self.store.create("sample")
        target = run.scratch / "active"
        target.write_text("keep")
        child = subprocess.Popen([sys.executable, "-c", "import sys,time; f=open(sys.argv[1]); print('ready',flush=True); time.sleep(30)", str(target)], stdout=subprocess.PIPE, start_new_session=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), b"ready")
            run.update(childGroup=child.pid)
            result = run.finish("interrupted")
            self.assertEqual(result["status"], "cleanup-pending")
            self.assertTrue(target.exists())
        finally:
            os.killpg(child.pid, signal.SIGTERM); child.wait(timeout=5); child.stdout.close()
        self.store.sweep()
        self.assertFalse(run.scratch.exists())

    def test_crashed_owner_is_recovered_on_next_start(self):
        run = self.store.create("sample")
        (run.scratch / "junk").write_text("discard")
        run.release()
        self.store.sweep()
        self.assertFalse(run.scratch.exists())
        self.assertEqual(json.loads((run.directory / "run.json").read_text())["status"], "interrupted")

    def test_symlink_root_is_refused_and_external_target_untouched(self):
        other = self.repo / "business"
        other.mkdir(); (other / "data").write_text("keep")
        nested = self.repo / "nested"; nested.mkdir()
        (nested / ".test-resources").symlink_to(other)
        with self.assertRaises(ValueError): Store(nested)
        self.assertEqual((other / "data").read_text(), "keep")

    def test_symlink_inside_scratch_does_not_follow_target(self):
        other = self.repo / "business"; other.mkdir(); (other / "data").write_text("keep")
        run = self.store.create("sample")
        (run.scratch / "external").symlink_to(other)
        run.finish("passed")
        self.assertEqual((other / "data").read_text(), "keep")

    def test_replaced_scratch_symlink_is_not_followed(self):
        other = self.repo / "business"; other.mkdir(); (other / "data").write_text("keep")
        run = self.store.create("sample")
        run.scratch.rmdir(); run.scratch.symlink_to(other)
        result = run.finish("failed")
        self.assertEqual(result["status"], "cleanup-pending")
        self.assertEqual((other / "data").read_text(), "keep")

    def test_report_parent_symlink_cannot_move_external_results(self):
        other = self.repo / "business"; (other / "test-results").mkdir(parents=True)
        (other / "test-results/data").write_text("keep")
        run = self.store.create("sample")
        (run.scratch / "tests").mkdir()
        (run.scratch / "tests/e2e").symlink_to(other)
        result = run.finish("failed")
        self.assertEqual(result["status"], "cleanup-pending")
        self.assertEqual((other / "test-results/data").read_text(), "keep")

    def test_reports_remain_locked_until_publication_finishes(self):
        run = self.store.create("sample")
        results = run.scratch / "tests/e2e/test-results"
        results.mkdir(parents=True); (results / "results.json").write_text("proof")
        run.finish("passed", release=False)
        self.assertIn(run.id, self.store.sweep(now=time.time() + 20 * 86400)["active"])
        self.assertTrue((run.directory / "reports/test-results/results.json").exists())
        run.release()
        self.store.sweep(now=time.time() + 20 * 86400)
        self.assertFalse((run.directory / "reports").exists())

    def test_unknown_directory_is_not_adopted(self):
        unknown = self.store.root / "runs/unknown"
        unknown.mkdir(); (unknown / "keep").write_text("keep")
        self.store.sweep()
        self.assertTrue((unknown / "keep").exists())

    def test_failure_ttl_and_total_cap_are_enforced(self):
        ids = []
        for _ in range(4):
            run = self.store.create("e2e"); ids.append(run.id)
            self.profile(run, size=1500); run.finish("failed")
        self.assertLessEqual(sum(p.stat().st_size for p in (self.store.root / "failures").rglob("*") if p.is_file()), 4096)
        self.store.sweep(now=time.time() + 8 * 86400)
        self.assertFalse(any((self.store.root / "failures").iterdir()))
        self.assertTrue(all((self.store.root / "runs" / i / "run.json").exists() for i in ids))

    def test_unregistered_profile_is_retained_and_reported(self):
        run = self.store.create("e2e")
        p = run.scratch / "tests/e2e/test-results/persistent-profiles/unknown"
        p.mkdir(parents=True); (p / "data").write_text("unknown")
        result = run.finish("failed")
        self.assertEqual(result["status"], "cleanup-pending")
        self.assertTrue((p / "data").exists())

    def test_failure_is_associated_with_its_retry_not_last_test_annotations(self):
        path = self.repo / "results.json"
        annotation = lambda name: [{"type": "persistent-profile", "description": "/profiles/" + name}]
        test = {"annotations": annotation("retry1"), "results": [
            {"status": "failed", "annotations": annotation("retry0")},
            {"status": "passed", "annotations": annotation("retry1")}]}
        path.write_text(json.dumps({"suites": [{"specs": [{"tests": [test]}]}]}))
        self.assertEqual(failed_profile_names(path), {"retry0"})
        del test["results"][0]["annotations"]
        path.write_text(json.dumps({"suites": [{"specs": [{"tests": [test]}]}]}))
        self.assertIsNone(failed_profile_names(path))

    def test_partial_raw_profile_transfer_resumes_idempotently(self):
        run = self.store.create("e2e")
        profile = self.profile(run, size=512)
        (profile / "diagnosis.log").write_text("keep this crash diagnosis")
        original = Path.rename
        moved = []
        def interrupted(path, target):
            result = original(path, target)
            if path.name == "cache.bin" and not moved:
                moved.append(True)
                raise OSError("simulated crash after moving first entry")
            return result
        with patch.object(Path, "rename", interrupted):
            self.assertEqual(run.finish("failed")["status"], "cleanup-pending")
        self.store.sweep(); self.store.sweep()
        self.assertFalse(run.scratch.exists())
        self.assertEqual((self.store.root / "failures" / run.id / "case/diagnosis.log").read_text(), "keep this crash diagnosis")
        self.assertEqual((run.directory / "reports/test-results/failure-diagnostics/case/diagnosis.log").read_text(), "keep this crash diagnosis")

    def test_open_file_without_child_group_still_blocks_deletion(self):
        run = self.store.create("sample")
        target = run.scratch / "open"; target.write_text("keep")
        with target.open():
            self.assertEqual(run.finish("passed")["status"], "cleanup-pending")
            self.assertTrue(target.exists())
        self.store.sweep()
        self.assertFalse(run.scratch.exists())

    def test_published_reports_expire_only_with_matching_run_marker(self):
        from run import publish
        run = self.store.create("e2e")
        self.profile(run)
        run.finish("passed", release=False)
        publish(run, "e2e"); run.release()
        reports = self.repo / "tests/e2e/test-results"
        self.assertTrue((reports / "cleanup-receipt.json").is_file())
        self.store.sweep(now=time.time() + 15 * 86400)
        self.assertFalse(reports.exists())


    def test_crash_after_scratch_removal_before_terminal_record_is_recovered(self):
        import lifecycle
        run = self.store.create("sample")
        results = run.scratch / "tests/e2e/test-results"
        results.mkdir(parents=True); (results / "results.json").write_text("proof")
        original = lifecycle.remove
        class PowerLoss(BaseException): pass
        def lost_power(path, root):
            original(path, root)
            if path == run.scratch:
                raise PowerLoss()
        with patch.object(lifecycle, "remove", lost_power):
            with self.assertRaises(PowerLoss): run.finish("passed")
        self.assertFalse(run.scratch.exists())
        self.store.sweep()
        record = json.loads((run.directory / "run.json").read_text())
        self.assertEqual(record["status"], "passed")
        self.store.sweep(now=time.time() + 15 * 86400)
        self.assertFalse((run.directory / "reports").exists())


    def test_diagnostic_parent_symlink_does_not_write_external_files(self):
        run = self.store.create("sample")
        profile = self.profile(run, size=128)
        (profile / "crash.log").write_text("diagnostic")
        external = self.repo / "business"; external.mkdir()
        (profile.parent.parent / "failure-diagnostics").symlink_to(external)
        self.assertEqual(run.finish("failed")["status"], "cleanup-pending")
        self.assertEqual(list(external.iterdir()), [])

    def test_diagnostic_leaf_symlink_does_not_overwrite_external_file(self):
        run = self.store.create("sample")
        profile = self.profile(run, size=128)
        (profile / "crash.log").write_text("diagnostic")
        external = self.repo / "business.txt"; external.write_text("keep")
        destination = profile.parent.parent / "failure-diagnostics/case"; destination.mkdir(parents=True)
        (destination / "crash.log").symlink_to(external)
        self.assertEqual(run.finish("failed")["status"], "cleanup-pending")
        self.assertEqual(external.read_text(), "keep")

    def test_atomic_record_never_follows_predictable_temporary_link(self):
        from lifecycle import atomic_json
        external = self.repo / "business.txt"; external.write_text("keep")
        directory = self.repo / "own"; directory.mkdir()
        (directory / "receipt.json.tmp").symlink_to(external)
        atomic_json(directory / "receipt.json", {"saved": True})
        self.assertEqual(external.read_text(), "keep")


    def test_vm_short_socket_directory_is_registered_and_recovered(self):
        import shutil
        run = self.store.create("vm")
        root = run.create_short_root()
        try:
            self.assertLess(len(str(root / "ssh-123456/control")), 100)
            (root / "socket-sample").write_text("owned")
            self.assertEqual(json.loads((run.directory / "run.json").read_text())["shortRoot"], str(root))
            run.release()
            self.store.sweep(); self.store.sweep()
            self.assertFalse(root.exists())
        finally:
            if root.exists(): shutil.rmtree(root)


class RunnerTests(unittest.TestCase):
    def test_e2e_then_container_publication_rotates_without_overwrite(self):
        runner = Path(__file__).with_name("run.py")
        with tempfile.TemporaryDirectory(prefix="nerve-publish-test-") as temp:
            repo = Path(temp)
            for kind in ("e2e", "container", "container"):
                result = subprocess.run([sys.executable, str(runner), "--repo", str(repo), kind, "--",
                    sys.executable, "-c",
                    "import os,pathlib; p=pathlib.Path(os.environ['NERVE_TEST_OUTPUT_DIR']); (p/'results.json').write_text('{'+chr(34)+'stats'+chr(34)+': {}}')"],
                    capture_output=True,text=True,timeout=15)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue((repo / "tests/e2e/test-results/results.json").exists())
            self.assertEqual(len(list((repo / ".test-resources/runs").glob("*/reports/test-results/results.json"))), 2)

    def test_ci_settle_recovers_only_its_owner_and_publishes_after_forced_exit(self):
        runner = Path(__file__).with_name("run.py")
        with tempfile.TemporaryDirectory() as temp:
            repo = Path(temp).resolve(); store = Store(repo)
            state = repo / "ci-state"; state.mkdir()
            token = "11111111-1111-4111-8111-111111111111"
            (state / "owner.json").write_text(json.dumps({"token": token, "root": str(repo)}))
            (state / "quiescence.json").write_text('{"quiescent":true}')
            other = store.create("e2e"); (other.scratch / "keep").write_text("other active task")
            try:
                for partial in (False, True):
                    run = store.create("e2e")
                    run.update(status="running", ciOwner=token, ciState=str(state))
                    results = run.scratch / "tests/e2e/test-results"; results.mkdir(parents=True)
                    (results / "results.json").write_text('{"stats":{}}')
                    if partial:
                        profile = results / "persistent-profiles/case"; profile.mkdir(parents=True)
                        (profile / "resource-owner.json").write_text(json.dumps({"version":1,"runId":run.id,"kind":"browser-profile"}))
                        (profile / "cache.bin").write_bytes(b'x'*100)
                        archive = profile / "opfs-archive"; archive.mkdir()
                        (archive / "manifest.json").write_text('{"files":[]}')
                    run.release()
                    recovered = subprocess.run([sys.executable, str(runner), "--repo", str(repo), "--ci-state", str(state), "recover-ci"], capture_output=True,text=True,timeout=15)
                    self.assertEqual(recovered.returncode, 0, recovered.stderr)
                    published = repo / "tests/e2e/test-results"
                    self.assertTrue((published / "results.json").exists())
                    self.assertTrue((published / "cleanup-receipt.json").exists())
                    self.assertEqual((other.scratch / "keep").read_text(), "other active task")
                    if partial:
                        self.assertTrue((published / "persistent-profiles/case/opfs-archive/manifest.json").exists())
                        self.assertFalse((published / "persistent-profiles/case/cache.bin").exists())
                    # A real CI owner is single use; give the second fixture another owner.
                    token = "22222222-2222-4222-8222-222222222222"
                    (state / "owner.json").write_text(json.dumps({"token": token, "root": str(repo)}))
            finally: other.release()

    def test_ci_resumes_publication_after_first_directory_rename(self):
        from run import publish
        runner = Path(__file__).with_name("run.py")
        for timing in ("before", "after"):
            with tempfile.TemporaryDirectory() as temp:
                repo=Path(temp).resolve();store=Store(repo)
                state=repo/"ci-state";state.mkdir()
                token="11111111-1111-4111-8111-111111111111"
                (state/"owner.json").write_text(json.dumps({"token":token,"root":str(repo)}))
                (state/"quiescence.json").write_text('{"quiescent":true}')
                run=store.create("e2e");run.update(ciOwner=token,ciState=str(state))
                results=run.scratch/"tests/e2e/test-results";results.mkdir(parents=True)
                (results/"results.json").write_text('{"stats":{}}')
                proof=results/"persistent-profiles/case/opfs-archive";proof.mkdir(parents=True)
                (proof.parent/"resource-owner.json").write_text(json.dumps({"version":1,"runId":run.id,"kind":"browser-profile"}))
                (proof/"manifest.json").write_text('{"files":[]}');(proof/"cleanup.json").write_text('{"removed":true}')
                html=run.scratch/"tests/e2e/playwright-report";html.mkdir();(html/"index.html").write_text('report')
                run.finish("failed",release=False)
                original=Path.rename
                class PowerLoss(BaseException):pass
                def interrupted(path,target):
                    if path.name=="test-results" and timing=="before":raise PowerLoss()
                    result=original(path,target)
                    if path.name=="test-results" and timing=="after":raise PowerLoss()
                    return result
                try:
                    with patch.object(Path,"rename",interrupted):
                        with self.assertRaises(PowerLoss):publish(run,"e2e")
                finally:run.release()
                for _ in range(2):
                    result=subprocess.run([sys.executable,str(runner),"--repo",str(repo),"--ci-state",str(state),"recover-ci"],capture_output=True,text=True,timeout=15)
                    self.assertEqual(result.returncode,0,result.stderr)
                self.assertTrue((repo/"tests/e2e/test-results/results.json").is_file())
                self.assertTrue((repo/"tests/e2e/test-results/persistent-profiles/case/opfs-archive/manifest.json").is_file())
                self.assertEqual((repo/"tests/e2e/playwright-report/index.html").read_text(),'report')
                record=json.loads((run.directory/"run.json").read_text())
                self.assertEqual(len(record["published"]),2)
                self.assertEqual(len(set(record["published"])),2)

    def test_success_failure_and_interrupt_use_real_small_child(self):
        runner = Path(__file__).with_name("run.py")
        with tempfile.TemporaryDirectory(prefix="nerve-runner-test-") as temp:
            repo = Path(temp)
            for code in (0, 3):
                command = [sys.executable, str(runner), "--repo", str(repo), "sample", "--", sys.executable, "-c", "import os,pathlib,sys; pathlib.Path(os.environ['NERVE_TEST_SCRATCH'],'junk').write_text('temporary'); print('evidence'); sys.exit(int(sys.argv[1]))", str(code)]
                result = subprocess.run(command, capture_output=True, text=True, timeout=15)
                self.assertEqual(result.returncode, code, result.stderr)
                self.assertIn("evidence", result.stdout)
            command = [sys.executable, str(runner), "--repo", str(repo), "sample", "--", sys.executable, "-c", "import os,pathlib,time; pathlib.Path(os.environ['NERVE_TEST_SCRATCH'],'ready').write_text('yes'); time.sleep(60)"]
            proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                deadline = time.time() + 8
                while not list((repo / '.test-resources/runs').glob('*/scratch/ready')) and time.time() < deadline:time.sleep(.05)
                self.assertTrue(list((repo / '.test-resources/runs').glob('*/scratch/ready')))
                proc.send_signal(signal.SIGTERM)
                proc.communicate(timeout=15)
                self.assertEqual(proc.returncode, 143)
            finally:
                if proc.poll() is None:proc.kill();proc.wait()
            runs = list((repo / '.test-resources/runs').iterdir())
            self.assertEqual(len(runs), 3)
            self.assertTrue(all(not (p / 'scratch').exists() for p in runs))

if __name__ == "__main__": unittest.main()
