"""KiB 级真实文件验证；由已提交的外层 run.py 提供 TMPDIR。"""
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

try:
    import stable_reports
except ModuleNotFoundError as error:
    if error.name != "stable_reports":
        raise
    stable_reports = None


RUN_ID = "b16c9326-9ac3-4cf7-bbd0-5cfd84203210"
OTHER_RUN = "cbf0586f-5e4b-4a09-8b01-77a36b10ec35"


class StableReportsTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(stable_reports, "缺少非破坏稳定报告导出实现")
        self.temporary = tempfile.TemporaryDirectory(prefix="nerve-stable-report-")
        self.root = Path(self.temporary.name).resolve()
        self.run = self.root / "run"
        self.scratch = self.run / "scratch"
        self.results = self.scratch / "tests/e2e/test-results"
        self.html = self.scratch / "tests/e2e/playwright-report"
        self.results.mkdir(parents=True)
        self.html.mkdir(parents=True)
        self.destination = self.run / "reports"
        (self.results / "results.json").write_text('{"suites":[],"errors":[],"stats":{"expected":1}}')
        (self.html / "index.html").write_text("<html>completed report</html>")

    def tearDown(self):
        self.temporary.cleanup()

    def profile(self, name="case", run_id=RUN_ID):
        profile = self.results / "persistent-profiles" / name
        profile.mkdir(parents=True)
        (profile / "resource-owner.json").write_text(json.dumps({
            "version": 1, "runId": run_id, "kind": "browser-profile",
        }))
        (profile / "cache.bin").write_bytes(b"original browser bytes")
        (profile / "database.sqlite").write_bytes(b"original database bytes")
        return profile

    def opfs(self, profile):
        archive = profile / "opfs-archive"
        data = archive / "files/store/entry"
        data.parent.mkdir(parents=True)
        payload = b"verified OPFS proof"
        data.write_bytes(payload)
        (archive / "manifest.json").write_text(json.dumps({
            "namespace": "test-namespace", "files": [{
                "path": ["store", "entry"], "bytes": len(payload),
                "sha256": hashlib.sha256(payload).hexdigest(),
            }],
        }))
        (archive / "cleanup.json").write_text(json.dumps({
            "namespace": "test-namespace", "removed": True,
        }))
        return archive

    def export(self, **kwargs):
        return stable_reports.snapshot_reports(
            self.scratch, self.destination, RUN_ID, kwargs.pop("failed_profiles", set()), **kwargs)

    def manifest(self):
        return json.loads((self.destination / "test-results/stable-export.json").read_text())

    def inventory(self, root):
        value = {}
        for path in sorted(root.rglob("*")):
            relative = str(path.relative_to(root))
            mode = path.lstat().st_mode
            if stat.S_ISLNK(mode):
                value[relative] = ("link", os.readlink(path))
            elif stat.S_ISREG(mode):
                value[relative] = ("file", path.read_bytes())
            elif stat.S_ISDIR(mode):
                value[relative] = ("directory",)
            else:
                value[relative] = ("special", stat.S_IFMT(mode))
        return value

    def test_exports_reports_owner_and_opfs_without_mutating_original_environment(self):
        profile = self.profile()
        self.opfs(profile)
        (self.scratch / "full-vm.img").write_bytes(b"keep this original VM")
        (self.results / "trace.zip").write_bytes(b"trace attachment")
        before = self.inventory(self.scratch)
        receipt = self.export()
        self.assertEqual(self.inventory(self.scratch), before)
        self.assertEqual((self.destination / "test-results/results.json").read_bytes(),
                         (self.results / "results.json").read_bytes())
        self.assertEqual((self.destination / "playwright-report/index.html").read_text(),
                         "<html>completed report</html>")
        exported = self.destination / "test-results/persistent-profiles/case"
        self.assertTrue((exported / "resource-owner.json").is_file())
        self.assertEqual((exported / "opfs-archive/files/store/entry").read_bytes(), b"verified OPFS proof")
        self.assertFalse((exported / "cache.bin").exists())
        self.assertFalse((exported / "database.sqlite").exists())
        self.assertFalse((self.destination / "full-vm.img").exists())
        retention = json.loads((exported / "retention.json").read_text())
        self.assertEqual(retention["rawDisposition"], "host-disposal-pending")
        manifest = self.manifest()
        self.assertEqual(manifest["version"], 1)
        self.assertEqual(manifest["runId"], RUN_ID)
        self.assertIs(manifest["complete"], True)
        self.assertEqual(manifest["rawDisposition"], "host-disposal-pending")
        self.assertEqual(receipt["manifest"], "test-results/stable-export.json")
        self.assertEqual(receipt["sha256"], hashlib.sha256(
            (self.destination / receipt["manifest"]).read_bytes()).hexdigest())
        self.assertEqual(receipt["files"], len(manifest["entries"]))
        self.assertEqual(receipt["bytes"], sum(item["bytes"] for item in manifest["entries"]))
        self.assertEqual(stable_reports.verify_snapshot(self.destination, RUN_ID, receipt), receipt)

    def test_profile_without_opfs_still_has_portable_annotation_directory(self):
        self.profile()
        self.export()
        exported = self.destination / "test-results/persistent-profiles/case"
        self.assertEqual({p.name for p in exported.iterdir()}, {"resource-owner.json", "retention.json"})

    def test_snapshot_owner_travels_inside_the_test_results_leaf(self):
        self.export()
        owner = self.destination / "test-results/snapshot-owner.json"
        self.assertTrue(owner.is_file(), "the publication must carry its snapshot owner")
        self.assertEqual(json.loads(owner.read_text())["runId"], RUN_ID)
        self.assertFalse((self.destination / "snapshot-owner.json").exists())

    def test_moving_report_leaves_preserves_verification_beside_source_files(self):
        receipt = self.export()
        published = self.root / "workspace/tests/e2e"
        (published / "specs").mkdir(parents=True)
        (published / "playwright.config.ts").write_text("export default {};\n")
        (published / "specs/story.spec.ts").write_text("// retained source\n")
        for leaf in ("test-results", "playwright-report"):
            (self.destination / leaf).rename(published / leaf)
        self.assertEqual(stable_reports.verify_snapshot(published, RUN_ID, receipt), receipt)
        self.assertEqual((published / "playwright.config.ts").read_text(), "export default {};\n")
        self.assertEqual((published / "specs/story.spec.ts").read_text(), "// retained source\n")

    def test_empty_preflight_exports_only_its_bounded_command_log(self):
        (self.results / "results.json").unlink()
        (self.html / "index.html").unlink()
        self.html.rmdir()
        log = self.run / "command.log"
        log.write_text("preflight finished\n")
        self.export(command_log=log)
        self.assertEqual((self.destination / "test-results/command.log").read_text(), "preflight finished\n")
        self.assertEqual(log.read_text(), "preflight finished\n")

    def test_external_command_log_is_not_adopted(self):
        log = self.root / "other-command.log"
        log.write_text("another task")
        with self.assertRaises((ValueError, RuntimeError, OSError)):
            self.export(command_log=log)
        self.assertEqual(log.read_text(), "another task")

    def test_failed_profile_diagnostics_obey_file_case_and_run_caps(self):
        for name in ("a", "b", "c"):
            profile = self.profile(name)
            (profile / "a.log").write_bytes(b"1234")
            (profile / "b.log").write_bytes(b"5678")
            (profile / "oversize.log").write_bytes(b"12345")
        with patch.multiple(stable_reports, DIAGNOSTIC_FILE_LIMIT=4,
                            DIAGNOSTIC_CASE_LIMIT=6, DIAGNOSTIC_RUN_LIMIT=10):
            self.export(failed_profiles={"a", "b", "c"})
        diagnostics = self.destination / "test-results/failure-diagnostics"
        copied = {str(p.relative_to(diagnostics)): p.read_bytes() for p in diagnostics.rglob("*.log")}
        self.assertEqual(copied, {"a/a.log": b"1234", "b/a.log": b"1234"})
        self.assertEqual(self.manifest()["diagnosticBytes"], 8)
        self.assertTrue(self.manifest()["omissions"])
        self.assertEqual((self.results / "persistent-profiles/c/a.log").read_bytes(), b"1234")

    def test_successful_profiles_do_not_export_unneeded_diagnostics(self):
        profile = self.profile()
        (profile / "debug.log").write_text("not needed on success")
        self.export()
        self.assertFalse((self.destination / "test-results/failure-diagnostics/case/debug.log").exists())

    def test_uncertain_failed_profile_selection_exports_bounded_diagnostics(self):
        profile = self.profile()
        (profile / "debug.log").write_text("needed diagnosis")
        self.export(failed_profiles=None)
        self.assertEqual((self.destination / "test-results/failure-diagnostics/case/debug.log").read_text(),
                         "needed diagnosis")

    def test_raw_profile_links_and_special_nodes_are_not_followed(self):
        profile = self.profile()
        other = self.root / "other-task.log"
        other.write_text("private other task")
        (profile / "SingletonSocket").symlink_to(other)
        (profile / "linked.log").symlink_to(other)
        os.mkfifo(profile / "raw-pipe")
        before = self.inventory(self.scratch)
        self.export(failed_profiles={"case"})
        self.assertEqual(self.inventory(self.scratch), before)
        self.assertEqual(other.read_text(), "private other task")
        self.assertFalse(any(p.is_symlink() for p in self.destination.rglob("*")))
        self.assertFalse(any(p.name in ("SingletonSocket", "linked.log", "raw-pipe")
                             for p in self.destination.rglob("*")))

    def test_wrong_profile_owner_is_rejected_without_source_change(self):
        self.profile(run_id=OTHER_RUN)
        before = self.inventory(self.scratch)
        with self.assertRaises((ValueError, RuntimeError)):
            self.export()
        self.assertEqual(self.inventory(self.scratch), before)

    def test_invalid_opfs_hash_is_rejected(self):
        archive = self.opfs(self.profile())
        (archive / "files/store/entry").write_bytes(b"bad OPFS")
        with self.assertRaises((ValueError, RuntimeError)):
            self.export()
        self.assertEqual((archive / "files/store/entry").read_bytes(), b"bad OPFS")

    def test_missing_opfs_cleanup_proof_is_rejected(self):
        archive = self.opfs(self.profile())
        (archive / "cleanup.json").unlink()
        with self.assertRaises((ValueError, RuntimeError, OSError)):
            self.export()

    def test_empty_opfs_archive_from_absent_namespace_needs_no_files_directory(self):
        archive = self.profile() / "opfs-archive"
        archive.mkdir()
        (archive / "manifest.json").write_text(json.dumps({
            "namespace": "absent-test-namespace", "origin": "http://127.0.0.1:8080",
            "directories": [], "files": [],
        }))
        (archive / "cleanup.json").write_text(json.dumps({
            "namespace": "absent-test-namespace", "removed": True,
        }))
        before = self.inventory(self.scratch)
        receipt = self.export()
        exported = self.destination / "test-results/persistent-profiles/case/opfs-archive"
        self.assertEqual({path.name for path in exported.iterdir()}, {"manifest.json", "cleanup.json"})
        self.assertEqual(self.inventory(self.scratch), before)
        self.assertEqual(stable_reports.verify_snapshot(self.destination, RUN_ID, receipt), receipt)

    def test_opfs_manifest_authorizes_proof_content_with_database_suffix(self):
        archive = self.opfs(self.profile())
        (archive / "files/store/entry").rename(archive / "files/store/entry.sqlite")
        value = json.loads((archive / "manifest.json").read_text())
        value["files"][0]["path"] = ["store", "entry.sqlite"]
        (archive / "manifest.json").write_text(json.dumps(value))
        self.export()
        self.assertEqual((self.destination / "test-results/persistent-profiles/case/opfs-archive/files/store/entry.sqlite").read_bytes(),
                         b"verified OPFS proof")

    def test_opfs_content_link_is_not_followed(self):
        archive = self.opfs(self.profile())
        content = archive / "files/store/entry"
        external = self.root / "external-proof"
        external.write_bytes(b"verified OPFS proof")
        content.unlink()
        content.symlink_to(external)
        with self.assertRaises((ValueError, RuntimeError, OSError)):
            self.export()
        self.assertEqual(external.read_bytes(), b"verified OPFS proof")

    def test_opfs_path_traversal_is_rejected(self):
        archive = self.opfs(self.profile())
        value = json.loads((archive / "manifest.json").read_text())
        value["files"][0]["path"] = ["..", "outside"]
        (archive / "manifest.json").write_text(json.dumps(value))
        with self.assertRaises((ValueError, RuntimeError)):
            self.export()

    def test_opfs_unlisted_payload_is_not_exported(self):
        archive = self.opfs(self.profile())
        (archive / "unlisted.db").write_bytes(b"not an OPFS proof")
        try:
            self.export()
        except (ValueError, RuntimeError):
            pass  # Conservatively refusing an unexpected archive member is also safe.
        self.assertFalse((self.destination / "test-results/persistent-profiles/case/opfs-archive/unlisted.db").exists())
        self.assertEqual((archive / "unlisted.db").read_bytes(), b"not an OPFS proof")

    def test_selected_report_symlink_is_rejected_without_reading_target(self):
        other = self.root / "business.json"
        other.write_text("private data")
        (self.results / "linked.json").symlink_to(other)
        with self.assertRaises((ValueError, RuntimeError, OSError)):
            self.export()
        self.assertEqual(other.read_text(), "private data")

    def test_selected_report_fifo_is_rejected_without_blocking(self):
        os.mkfifo(self.results / "pipe.log")
        with self.assertRaises((ValueError, RuntimeError, OSError)):
            self.export()

    def test_source_ancestor_symlink_is_rejected(self):
        actual = self.scratch / "real-e2e"
        (self.scratch / "tests/e2e").rename(actual)
        (self.scratch / "tests/e2e").symlink_to(actual, target_is_directory=True)
        with self.assertRaises((ValueError, RuntimeError, OSError)):
            self.export()

    def test_destination_inside_source_or_link_is_rejected(self):
        self.destination = self.scratch / "nested-export"
        with self.assertRaises((ValueError, RuntimeError, OSError)):
            self.export()
        self.destination = self.run / "reports"
        other = self.root / "unrelated"
        other.mkdir()
        (other / "keep").write_text("keep")
        self.destination.symlink_to(other, target_is_directory=True)
        with self.assertRaises((ValueError, RuntimeError, OSError)):
            self.export()
        self.assertEqual((other / "keep").read_text(), "keep")

    def test_existing_unknown_destination_is_not_overwritten(self):
        self.destination.mkdir()
        (self.destination / "existing.json").write_text("other run")
        with self.assertRaises((ValueError, RuntimeError, OSError)):
            self.export()
        self.assertEqual((self.destination / "existing.json").read_text(), "other run")

    def test_destination_replaced_after_open_is_not_used_for_final_manifest(self):
        original = self.run / "original-created-reports"
        real_open = os.open
        injected = []
        unknown = {}

        def replace_after_open(path, flags, *args, **kwargs):
            descriptor = real_open(path, flags, *args, **kwargs)
            if os.fspath(path) == self.destination.name and not injected:
                injected.append(True)
                self.destination.rename(original)
                (self.destination / "test-results").mkdir(parents=True)
                (self.destination / "keep.txt").write_text("another task's directory")
                unknown.update(self.inventory(self.destination))
            return descriptor

        before = self.inventory(self.scratch)
        with patch.object(os, "open", side_effect=replace_after_open):
            with self.assertRaises((ValueError, RuntimeError, OSError)):
                self.export()
        self.assertTrue(injected, "fixture must replace the directory after its FD was opened")
        self.assertEqual(self.inventory(self.destination), unknown,
                         "a changed path must not receive snapshot metadata")
        self.assertEqual(self.inventory(self.scratch), before)

    def test_complete_snapshot_can_be_repeated_without_mutation(self):
        self.profile()
        first = self.export()
        before = self.inventory(self.destination)
        second = self.export()
        self.assertEqual(first, second)
        self.assertEqual(self.inventory(self.destination), before)

    def test_repeat_after_source_change_cannot_reuse_old_complete_receipt(self):
        self.export()
        (self.results / "results.json").write_text("changed report")
        with self.assertRaises((ValueError, RuntimeError, OSError)):
            self.export()

    def test_report_size_limit_does_not_silently_drop_necessary_evidence(self):
        (self.results / "attachment.txt").write_bytes(b"x" * 1024)
        with self.assertRaises((ValueError, RuntimeError)):
            self.export(report_limit=512)
        with self.assertRaises((ValueError, RuntimeError, OSError)):
            stable_reports.verify_snapshot(self.destination, RUN_ID)

    def test_zero_byte_report_entries_cannot_bypass_the_inventory_budget(self):
        for index in range(8):
            (self.results / ("empty-" + str(index) + ".txt")).touch()
        with patch.object(stable_reports, "REPORT_ENTRY_LIMIT", 8, create=True):
            with self.assertRaises((ValueError, RuntimeError)):
                self.export()
        self.assertFalse((self.destination / "test-results/results.json").exists(),
                         "inventory bounds must be checked before copying ordinary reports")
        self.assertEqual(len(list(self.results.glob("empty-*.txt"))), 8)

    def test_manifest_metadata_budget_is_checked_before_copying_report_payload(self):
        with patch.object(stable_reports, "JSON_LIMIT", 512):
            with self.assertRaises((ValueError, RuntimeError)):
                self.export()
        self.assertFalse((self.destination / "test-results/results.json").exists(),
                         "oversized manifest metadata must stop export before payload copying")
        self.assertTrue((self.results / "results.json").is_file())

    def test_database_or_vm_payload_in_ordinary_report_tree_is_refused(self):
        (self.results / "unexpected.sqlite").write_bytes(b"whole database")
        with self.assertRaises((ValueError, RuntimeError)):
            self.export()
        self.assertFalse((self.destination / "test-results/unexpected.sqlite").exists())

    def test_source_change_during_stream_copy_refuses_complete_export(self):
        source = self.results / "payload.txt"
        source.write_bytes(b"original")
        identity = source.stat()
        real_read = os.read
        changed = []
        def read_then_change(fd, size):
            data = real_read(fd, size)
            info = os.fstat(fd)
            if data and not changed and (info.st_dev, info.st_ino) == (identity.st_dev, identity.st_ino):
                changed.append(True)
                source.write_bytes(b"modified")
            return data
        with patch.object(os, "read", side_effect=read_then_change):
            with self.assertRaises((ValueError, RuntimeError, OSError)):
                self.export()
        self.assertTrue(changed, "fixture must change the actual source while it is read")
        with self.assertRaises((ValueError, RuntimeError, OSError)):
            stable_reports.verify_snapshot(self.destination, RUN_ID)

    def test_interrupted_copy_has_no_complete_receipt_and_keeps_source(self):
        source = self.results / "payload.txt"
        source.write_bytes(b"original")
        identity = source.stat()
        real_read = os.read
        def interrupted(fd, size):
            info = os.fstat(fd)
            if (info.st_dev, info.st_ino) == (identity.st_dev, identity.st_ino):
                raise OSError("simulated read interruption")
            return real_read(fd, size)
        with patch.object(os, "read", side_effect=interrupted):
            with self.assertRaises((ValueError, RuntimeError, OSError)):
                self.export()
        self.assertEqual(source.read_bytes(), b"original")
        with self.assertRaises((ValueError, RuntimeError, OSError)):
            stable_reports.verify_snapshot(self.destination, RUN_ID)

    def test_verification_rejects_changed_bytes_and_unknown_extra_files(self):
        receipt = self.export()
        result = self.destination / "test-results/results.json"
        original = result.read_bytes()
        result.write_bytes(b"tampered")
        with self.assertRaises((ValueError, RuntimeError)):
            stable_reports.verify_snapshot(self.destination, RUN_ID, receipt)
        result.write_bytes(original)
        (self.destination / "test-results/extra.bin").write_bytes(b"unlisted")
        with self.assertRaises((ValueError, RuntimeError)):
            stable_reports.verify_snapshot(self.destination, RUN_ID, receipt)

    def test_verification_rejects_manifest_rewrite_against_original_receipt(self):
        receipt = self.export()
        path = self.destination / receipt["manifest"]
        value = json.loads(path.read_text())
        value["diagnosticBytes"] = 999
        path.write_text(json.dumps(value))
        with self.assertRaises((ValueError, RuntimeError)):
            stable_reports.verify_snapshot(self.destination, RUN_ID, receipt)

    def test_verification_accepts_only_fixed_same_run_publication_metadata(self):
        receipt = self.export()
        for relative in ("test-results/resource-run.json", "test-results/cleanup-receipt.json",
                         "playwright-report/resource-run.json"):
            path = self.destination / relative
            path.write_text(json.dumps({"runId": RUN_ID, "status": "passed"}))
        self.assertEqual(stable_reports.verify_snapshot(self.destination, RUN_ID, receipt), receipt)
        (self.destination / "test-results/resource-run.json").write_text(json.dumps({"runId": OTHER_RUN}))
        with self.assertRaises((ValueError, RuntimeError)):
            stable_reports.verify_snapshot(self.destination, RUN_ID, receipt)

    def test_verification_rejects_other_run_and_exported_symlinks(self):
        receipt = self.export()
        with self.assertRaises((ValueError, RuntimeError)):
            stable_reports.verify_snapshot(self.destination, OTHER_RUN, receipt)
        path = self.destination / "test-results/results.json"
        path.unlink()
        path.symlink_to(self.results / "results.json")
        with self.assertRaises((ValueError, RuntimeError, OSError)):
            stable_reports.verify_snapshot(self.destination, RUN_ID, receipt)


if __name__ == "__main__":
    unittest.main()
