"""Hosted-VM identity and budget contracts, using only managed KiB fixtures."""
import contextlib
import copy
import errno
import importlib.util
import io
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch


RUN = "11111111-2222-4333-8444-555555555555"
BOOT = "66666666-7777-4888-8999-aaaaaaaaaaaa"
OTHER_BOOT = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"
SHA = "a" * 40
POLICY = "github-hosted-vm"


class HostedPolicyTests(unittest.TestCase):
    def setUp(self):
        temporary_root = os.environ.get("NERVE_TEST_SCRATCH") or os.environ["TMPDIR"]
        self.temporary = tempfile.TemporaryDirectory(prefix="hosted-policy-", dir=temporary_root)
        self.addCleanup(self.temporary.cleanup)
        self.repo = Path(self.temporary.name).resolve()
        spec = importlib.util.find_spec("hosted")
        self.assertIsNotNone(spec, "hosted VM policy module is missing")
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)

    def environment(self):
        return {
            "NERVE_TEST_RESOURCE_POLICY": POLICY,
            "CI": "true", "GITHUB_ACTIONS": "true",
            "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux",
            "RUNNER_ARCH": "X64", "ImageOS": "ubuntu24",
            "GITHUB_REPOSITORY": "open-nerve/NerveOffice",
            "GITHUB_WORKSPACE": str(self.repo),
            "GITHUB_WORKFLOW_REF": "open-nerve/NerveOffice/.github/workflows/ci.yml@refs/heads/main",
            "GITHUB_RUN_ID": "40600596503", "GITHUB_RUN_ATTEMPT": "2",
            "GITHUB_JOB": "e2e", "GITHUB_SHA": SHA,
            "RUNNER_NAME": "GitHub Actions 1000006096",
        }

    @contextlib.contextmanager
    def configured(self, *, overrides=None, platform="linux", release=None, boot=None):
        environment = self.environment()
        environment.update(overrides or {})
        environment = {key: value for key, value in environment.items() if value is not None}
        release = 'ID=ubuntu\nVERSION_ID="24.04"\n' if release is None else release
        boot = BOOT + "\n" if boot is None else boot
        real_open = Path.open

        def open_metadata(path, mode="r", *args, **kwargs):
            values = {"/etc/os-release": release, "/proc/sys/kernel/random/boot_id": boot}
            if str(path) not in values:
                return real_open(path, mode, *args, **kwargs)
            value = values[str(path)]
            if isinstance(value, OSError):
                raise value
            if isinstance(value, str):
                value = value.encode("utf-8")
            return io.BytesIO(value) if "b" in mode else io.StringIO(value.decode("utf-8"))

        with patch.dict(os.environ, environment, clear=True), \
                patch.object(self.module.sys, "platform", platform), \
                patch.object(Path, "open", open_metadata):
            yield

    def roots(self, run_id=RUN):
        directory = self.repo / ".test-resources/runs" / run_id
        return {"scratch": str(directory / "scratch"),
                "short": str(Path("/tmp").resolve() / ("nerve-t-" + run_id)),
                "reports": str(directory / "reports"),
                "failures": str(self.repo / ".test-resources/failures" / run_id)}

    @staticmethod
    def scans_directory(path, directory):
        if isinstance(path, int):
            actual, expected = os.fstat(path), directory.stat()
            return (actual.st_dev, actual.st_ino) == (expected.st_dev, expected.st_ino)
        return Path(path) == directory

    def test_default_and_explicit_strict_never_enable_host_disposal(self):
        for mode in (None, "strict"):
            with self.subTest(mode=mode), self.configured(
                    overrides={"NERVE_TEST_RESOURCE_POLICY": mode}, platform="darwin"):
                self.assertIsNone(self.module.context(self.repo))
        self.assertEqual(list(self.repo.iterdir()), [])

    def test_explicit_mode_rejects_unknown_or_ineligible_environment(self):
        cases = [
            {"NERVE_TEST_RESOURCE_POLICY": "automatic"},
            {"CI": "false"}, {"GITHUB_ACTIONS": "false"},
            {"RUNNER_ENVIRONMENT": "self-hosted"}, {"RUNNER_OS": "macOS"},
            {"ImageOS": "ubuntu22"}, {"GITHUB_JOB": "other-job"},
            {"GITHUB_RUN_ID": "0"}, {"GITHUB_RUN_ID": "123/../456"},
            {"GITHUB_RUN_ATTEMPT": "0"}, {"GITHUB_SHA": "a" * 39},
            {"RUNNER_NAME": ""}, {"GITHUB_REPOSITORY": "bad-repository"},
            {"GITHUB_WORKFLOW_REF": "open-nerve/NerveOffice/.github/workflows/other.yml@refs/heads/main"},
            {"GITHUB_WORKFLOW_REF": "open-nerve/NerveOffice/.github/workflows/ci.yml@refs/heads/other"},
        ]
        for values in cases:
            with self.subTest(values=values), self.configured(overrides=values):
                with self.assertRaises(ValueError):
                    self.module.context(self.repo)
        self.assertEqual(list(self.repo.iterdir()), [])

    def test_platform_os_and_boot_metadata_must_be_available_and_exact(self):
        for changes in [
            {"platform": "darwin"}, {"platform": "win32"},
            {"release": 'ID=debian\nVERSION_ID="24.04"\n'},
            {"release": 'ID=ubuntu\nVERSION_ID="22.04"\n'},
            {"release": "x" * 4097},
            {"release": OSError(errno.EACCES, "denied")},
            {"boot": ""}, {"boot": "not-a-boot-id\n"},
            {"boot": OSError(errno.EACCES, "denied")},
        ]:
            with self.subTest(changes=changes), self.configured(**changes):
                with self.assertRaises(ValueError):
                    self.module.context(self.repo)

    def test_context_binds_each_supported_job_to_the_actual_workspace(self):
        for job in ("verify", "e2e", "container"):
            with self.subTest(job=job), self.configured(overrides={"GITHUB_JOB": job}):
                value = self.module.context(self.repo)
            self.assertEqual(value, {
                "version": 1, "policy": POLICY, "repo": str(self.repo),
                "repository": "open-nerve/NerveOffice", "sha": SHA,
                "runId": "40600596503", "attempt": "2", "job": job,
                "runner": "GitHub Actions 1000006096", "bootId": BOOT,
            })

    def test_workspace_mismatch_and_workspace_alias_are_rejected(self):
        other = self.repo / "other"
        other.mkdir()
        alias = self.repo / "workspace-alias"
        alias.symlink_to(other, target_is_directory=True)
        for workspace in (str(other), str(alias)):
            with self.subTest(workspace=workspace), self.configured(
                    overrides={"GITHUB_WORKSPACE": workspace}):
                with self.assertRaises(ValueError):
                    self.module.context(self.repo)

    def test_registration_is_bound_before_any_resource_is_created(self):
        with self.configured():
            context = self.module.context(self.repo)
            proof = self.module.register(context, RUN, self.roots())
            self.assertIsNone(self.module.validate(proof, context, RUN, self.roots()))
        self.assertEqual(proof, {"version": 1, "policy": POLICY,
                                 "context": context, "runId": RUN, "roots": self.roots()})
        self.assertEqual(list(self.repo.iterdir()), [])

    def test_proof_does_not_change_when_callers_mutate_their_inputs(self):
        with self.configured():
            context = self.module.context(self.repo)
            roots = self.roots()
            proof = self.module.register(context, RUN, roots)
            context["attempt"] = "3"
            roots["scratch"] = str(self.repo / "other")
            current = self.module.context(self.repo)
            self.assertIsNone(self.module.validate(proof, current, RUN, self.roots()))
            with self.assertRaises(ValueError):
                self.module.validate(proof, context, RUN, self.roots())

    def test_cross_context_cannot_reuse_registered_scope(self):
        with self.configured():
            original = self.module.context(self.repo)
            proof = self.module.register(original, RUN, self.roots())
        changes = [
            ("repo", str(self.repo / "another")), ("repository", "other/NerveOffice"),
            ("runId", "40600596504"), ("attempt", "3"), ("job", "container"),
            ("runner", "GitHub Actions 1000006101"), ("bootId", OTHER_BOOT),
            ("sha", "b" * 40), ("policy", "strict"), ("version", True),
        ]
        for key, value in changes:
            current = dict(original, **{key: value})
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.module.validate(proof, current, RUN, self.roots())

    def test_old_malformed_or_tampered_proof_cannot_gain_hosted_authority(self):
        with self.configured():
            context = self.module.context(self.repo)
            original = self.module.register(context, RUN, self.roots())
        cases = [None, {}, {"version": 1}, dict(original, version=True),
                 dict(original, policy="strict"), dict(original, runId="../other")]
        changed = copy.deepcopy(original)
        changed["context"]["attempt"] = "3"
        cases.append(changed)
        changed = copy.deepcopy(original)
        changed["roots"]["scratch"] = str(self.repo / "business")
        cases.append(changed)
        for proof in cases:
            with self.subTest(proof=proof), self.assertRaises(ValueError):
                self.module.validate(proof, context, RUN, self.roots())

    def test_registration_rejects_non_uuid_and_non_owned_root_layout(self):
        with self.configured():
            context = self.module.context(self.repo)
        for identity in ("123", "../other", BOOT.upper(), "0" * 36):
            with self.subTest(identity=identity), self.assertRaises(ValueError):
                self.module.register(context, identity, self.roots(identity))
        for key in ("scratch", "short", "reports", "failures"):
            roots = self.roots()
            roots[key] = str(self.repo / "business")
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.module.register(context, RUN, roots)
        for roots in ({}, dict(self.roots(), extra=str(self.repo))):
            with self.subTest(roots=roots), self.assertRaises(ValueError):
                self.module.register(context, RUN, roots)

    def test_replaced_parent_link_does_not_validate_as_owned_roots(self):
        with self.configured():
            context = self.module.context(self.repo)
            proof = self.module.register(context, RUN, self.roots())
        external = self.repo / "business"
        external.mkdir()
        (external / "keep.txt").write_text("keep", encoding="utf-8")
        (self.repo / ".test-resources").symlink_to(external, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.module.validate(proof, context, RUN, self.roots())
        self.assertEqual((external / "keep.txt").read_text(), "keep")

    def test_measure_accumulates_all_runs_and_deduplicates_links_and_roots(self):
        first, second, short = [self.repo / name for name in ("first", "second", "short")]
        for root in (first, second, short):
            root.mkdir()
        (first / "one.bin").write_bytes(b"a" * 1024)
        (second / "two.bin").write_bytes(b"b" * 512)
        os.link(first / "one.bin", second / "one-link.bin")
        (short / "t").symlink_to(first, target_is_directory=True)
        observed = self.module.measure([first, second, short, first], limit_bytes=2048)
        self.assertEqual(observed, {"bytes": 1536, "files": 2})
        self.assertEqual((first / "one.bin").stat().st_size, 1024)
        self.assertEqual((second / "two.bin").stat().st_size, 512)

    def test_measure_does_not_follow_foreign_links_or_read_special_files(self):
        root, outside = self.repo / "scratch", self.repo / "business"
        root.mkdir(); outside.mkdir()
        (root / "own.bin").write_bytes(b"o" * 128)
        (outside / "private.bin").write_bytes(b"p" * 4096)
        (root / "foreign").symlink_to(outside, target_is_directory=True)
        os.mkfifo(root / "pipe")
        self.assertEqual(self.module.measure([root], limit_bytes=256), {"bytes": 128, "files": 1})
        self.assertEqual((outside / "private.bin").stat().st_size, 4096)

    def test_measure_rejects_link_root_instead_of_adopting_its_target(self):
        target = self.repo / "business"
        target.mkdir()
        (target / "keep").write_bytes(b"keep")
        alias = self.repo / "alias"
        alias.symlink_to(target, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.module.measure([alias], limit_bytes=1024)
        self.assertEqual((target / "keep").read_bytes(), b"keep")

    def test_ancestor_replaced_after_validation_never_scans_the_foreign_tree(self):
        ancestor = self.repo / "owned-parent"
        root = ancestor / "scratch"
        root.mkdir(parents=True)
        (root / "own.bin").write_bytes(b"o" * 128)
        foreign = self.repo / "business"
        foreign_root = foreign / "scratch"
        foreign_root.mkdir(parents=True)
        (foreign_root / "private.bin").write_bytes(b"p" * 512)
        preserved = self.repo / "original-parent"
        real_open, real_scan = os.open, os.scandir
        attempts, injected, foreign_scans = [], [], []

        def swapping_open(path, flags, *args, **kwargs):
            # Exercise both a full-path open and a component-at-a-time open.
            if os.fspath(path) in (str(root), ancestor.name):
                attempts.append(True)
                if len(attempts) > 16:
                    raise AssertionError("changed root retried without a useful bound")
                if not injected:
                    ancestor.rename(preserved)
                    ancestor.symlink_to(foreign, target_is_directory=True)
                    injected.append(True)
            return real_open(path, flags, *args, **kwargs)

        def observe_scan(path):
            if self.scans_directory(path, foreign_root):
                foreign_scans.append(True)
            return real_scan(path)

        failure = None
        with patch.object(self.module.os, "open", swapping_open), \
                patch.object(self.module.os, "scandir", observe_scan):
            try:
                self.module.measure([root], limit_bytes=1024)
            except (ValueError, RuntimeError) as error:
                failure = error
        self.assertTrue(injected)
        self.assertEqual(foreign_scans, [], "a replaced ancestor must not expose another tree")
        self.assertIsNotNone(failure, "changed root identity must fail within bounded attempts")
        self.assertEqual((preserved / "scratch/own.bin").read_bytes(), b"o" * 128)
        self.assertEqual((foreign_root / "private.bin").read_bytes(), b"p" * 512)

    def test_absent_precreation_or_retired_root_contributes_zero(self):
        self.assertEqual(self.module.measure([self.repo / "absent"], limit_bytes=1024),
                         {"bytes": 0, "files": 0})

    def test_raw_limit_is_cumulative_and_failure_does_not_delete_files(self):
        roots = [self.repo / "previous-deferred", self.repo / "current"]
        for root in roots:
            root.mkdir()
            (root / "raw.bin").write_bytes(b"r" * 700)
        with self.assertRaises(RuntimeError):
            self.module.measure(roots, limit_bytes=1024)
        for root in roots:
            self.assertEqual((root / "raw.bin").stat().st_size, 700)
        self.assertEqual(self.module.measure(roots, limit_bytes=1400), {"bytes": 1400, "files": 2})

    def test_permission_failure_is_not_an_empty_usage_measurement(self):
        root = self.repo / "scratch"
        root.mkdir()
        real_scan = os.scandir

        def denied(path):
            if self.scans_directory(path, root):
                raise PermissionError(errno.EACCES, "denied", str(root))
            return real_scan(path)

        with patch.object(self.module.os, "scandir", denied), self.assertRaises(RuntimeError):
            self.module.measure([root], limit_bytes=1024)

    def test_disappearing_file_is_rescanned_without_adopting_another_directory(self):
        root = self.repo / "scratch"
        root.mkdir()
        victim = root / "vanishes"
        victim.write_bytes(b"v" * 128)
        real_scan = os.scandir
        injected = []

        class Entries:
            def __init__(self, values): self.values = iter(values)
            def __enter__(self): return self
            def __exit__(self, *args): self.close()
            def __iter__(self): return self
            def __next__(self): return next(self.values)
            def close(self): pass

        def racing_scan(path):
            if self.scans_directory(path, root) and not injected:
                with real_scan(path) as stream:
                    entries = list(stream)
                victim.unlink()
                injected.append(True)
                return Entries(entries)
            return real_scan(path)

        with patch.object(self.module.os, "scandir", racing_scan):
            self.assertEqual(self.module.measure([root], limit_bytes=1024), {"bytes": 0, "files": 0})
        self.assertTrue(injected)
        self.assertEqual(list(root.iterdir()), [])

    def test_persistent_scan_race_stops_after_a_bounded_number_of_attempts(self):
        root = self.repo / "scratch"
        root.mkdir()
        (root / "keep.bin").write_bytes(b"k" * 128)
        real_scan = os.scandir
        attempts = []

        def racing_scan(path):
            if self.scans_directory(path, root):
                attempts.append(True)
                if len(attempts) > 16:
                    raise AssertionError("budget traversal retried without a useful bound")
                raise FileNotFoundError(errno.ENOENT, "changed during scan", str(root))
            return real_scan(path)

        with patch.object(self.module.os, "scandir", racing_scan), self.assertRaises(RuntimeError):
            self.module.measure([root], limit_bytes=1024)
        self.assertGreaterEqual(len(attempts), 2)
        self.assertEqual((root / "keep.bin").read_bytes(), b"k" * 128)

    def test_budget_reports_raw_and_free_bytes_without_changing_resources(self):
        root = self.repo / "scratch"
        root.mkdir()
        (root / "raw.bin").write_bytes(b"r" * 128)
        disk = shutil._ntuple_diskusage(total=8192, used=4096, free=4096)
        with patch.object(self.module.shutil, "disk_usage", return_value=disk):
            value = self.module.check_budget(self.repo, [root], limit_bytes=1024, reserve_bytes=2048)
        self.assertEqual(value, {"bytes": 128, "files": 1, "freeBytes": 4096,
                                 "limitBytes": 1024, "reserveBytes": 2048})
        self.assertEqual((root / "raw.bin").read_bytes(), b"r" * 128)

    def test_disk_reserve_rejects_even_when_registered_raw_usage_is_small(self):
        root = self.repo / "scratch"
        root.mkdir()
        (root / "raw.bin").write_bytes(b"r" * 32)
        disk = shutil._ntuple_diskusage(total=8192, used=7169, free=1023)
        with patch.object(self.module.shutil, "disk_usage", return_value=disk), \
                self.assertRaises(RuntimeError):
            self.module.check_budget(self.repo, [root], limit_bytes=2048, reserve_bytes=1024)
        self.assertEqual((root / "raw.bin").stat().st_size, 32)

    def test_raw_threshold_still_rejects_when_the_disk_has_space(self):
        root = self.repo / "scratch"
        root.mkdir()
        (root / "raw.bin").write_bytes(b"r" * 1025)
        disk = shutil._ntuple_diskusage(total=8192, used=1024, free=7168)
        with patch.object(self.module.shutil, "disk_usage", return_value=disk), \
                self.assertRaises(RuntimeError):
            self.module.check_budget(self.repo, [root], limit_bytes=1024, reserve_bytes=2048)
        self.assertEqual((root / "raw.bin").stat().st_size, 1025)


if __name__ == "__main__":
    unittest.main()
