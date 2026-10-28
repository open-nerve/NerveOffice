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


class Entries:
    """Keep real DirEntry objects while controlling one fixture's deletion time."""
    def __init__(self, values, after=None):
        self.values, self.after = iter(values), after
    def __enter__(self): return self
    def __iter__(self): return self
    def __next__(self): return next(self.values)
    def __exit__(self, *unused):
        if self.after:
            self.after()


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

    @contextlib.contextmanager
    def disappearing_child(self, root, stage):
        """Every attempted scan loses a real child, while keep.bin stays intact."""
        real_scan, real_open = os.scandir, os.open
        victim = root / 'vanishes'
        scans = []
        def remove_open_child():
            (victim / 'counted.bin').unlink()
            victim.rmdir()
        def scan(path):
            if self.scans_directory(path, root):
                scans.append(True)
                if len(scans) > 16:
                    raise AssertionError('live sampling retried without a useful bound')
                if stage == 'entry-stat':
                    victim.write_bytes(b'v' * 32)
                else:
                    victim.mkdir()
                    if stage == 'child-recheck':
                        (victim / 'counted.bin').write_bytes(b'c' * 128)
                with real_scan(path) as stream:
                    values = sorted(stream, key=lambda entry: entry.name != victim.name)
                if stage == 'entry-stat':
                    victim.unlink()
                return Entries(values)
            if stage == 'child-recheck' and victim.exists() and self.scans_directory(path, victim):
                with real_scan(path) as stream:
                    values = list(stream)
                return Entries(values, remove_open_child)
            return real_scan(path)
        def opening(path, flags, *args, **kwargs):
            if (stage == 'child-open' and os.fspath(path) == victim.name and kwargs.get('dir_fd') is not None
                    and self.scans_directory(kwargs['dir_fd'], root)):
                victim.rmdir()
            return real_open(path, flags, *args, **kwargs)
        with patch.object(self.module.os, 'scandir', scan), patch.object(self.module.os, 'open', opening):
            yield scans

    def live_sample(self, stage, *, limit=1024):
        root = self.repo / 'scratch'
        root.mkdir()
        (root / 'keep.bin').write_bytes(b'k' * 512)
        with self.disappearing_child(root, stage):
            observed = self.module.measure([root], limit_bytes=limit)
        self.assertEqual((root / 'keep.bin').read_bytes(), b'k' * 512)
        return observed

    def test_each_scan_can_lose_one_file_without_losing_its_stable_sibling(self):
        self.assertEqual(self.live_sample('entry-stat'), {'bytes': 512, 'files': 1})

    def test_each_scan_can_lose_a_child_before_open_without_losing_its_sibling(self):
        self.assertEqual(self.live_sample('child-open'), {'bytes': 512, 'files': 1})

    def test_open_child_disappearance_preserves_already_counted_bytes(self):
        self.assertEqual(self.live_sample('child-recheck'), {'bytes': 640, 'files': 2})

    def test_live_child_disappearance_does_not_hide_a_stable_over_budget_sibling(self):
        for stage in ('entry-stat', 'child-open', 'child-recheck'):
            with self.subTest(stage=stage):
                root = self.repo / stage
                root.mkdir()
                (root / 'keep.bin').write_bytes(b'k' * 512)
                with self.disappearing_child(root, stage), self.assertRaisesRegex(RuntimeError, '容量阈值'):
                    self.module.measure([root], limit_bytes=256)
                self.assertEqual((root / 'keep.bin').read_bytes(), b'k' * 512)

    def test_previously_present_root_cannot_become_an_absent_zero_on_retry(self):
        root = self.repo / 'scratch'
        root.mkdir()
        real_scan = os.scandir
        removed = []
        def scan(path):
            if not removed and self.scans_directory(path, root):
                with real_scan(path) as stream:
                    values = list(stream)
                root.rmdir()
                removed.append(True)
                return Entries(values)
            return real_scan(path)
        with patch.object(self.module.os, 'scandir', scan), self.assertRaises(RuntimeError):
            self.module.measure([root], limit_bytes=1024)
        self.assertTrue(removed)

    def test_root_disappearing_immediately_after_path_validation_is_not_initially_absent(self):
        root = self.repo / 'scratch'
        root.mkdir()
        real_lstat = Path.lstat
        removed = []
        def inspected(path, *args, **kwargs):
            info = real_lstat(path, *args, **kwargs)
            if path == root and not removed:
                root.rmdir()
                removed.append(True)
            return info
        with patch.object(Path, 'lstat', inspected), self.assertRaises(RuntimeError):
            self.module.measure([root], limit_bytes=1024)
        self.assertTrue(removed)

    def test_initially_absent_root_created_after_validation_is_not_adopted_in_that_sample(self):
        root = self.repo / 'scratch'
        real_lstat = Path.lstat
        created = []
        def inspected(path, *args, **kwargs):
            try:
                return real_lstat(path, *args, **kwargs)
            except FileNotFoundError:
                if path == root and not created:
                    root.mkdir()
                    (root / 'later.bin').write_bytes(b'l' * 512)
                    created.append(True)
                raise
        with patch.object(Path, 'lstat', inspected):
            self.assertEqual(self.module.measure([root, root], limit_bytes=1024), {'bytes': 0, 'files': 0})
        self.assertTrue(created)
        self.assertEqual((root / 'later.bin').read_bytes(), b'l' * 512)

    def test_real_replacement_root_cannot_be_adopted_on_a_later_attempt(self):
        root, preserved = self.repo / 'scratch', self.repo / 'original'
        root.mkdir()
        (root / 'keep.bin').write_bytes(b'k' * 512)
        real_scan = os.scandir
        swapped, replacement_scans = [], []
        def scan(path):
            if self.scans_directory(path, root):
                if swapped:
                    replacement_scans.append(True)
                else:
                    root.rename(preserved)
                    root.mkdir()
                    (root / 'replacement.bin').write_bytes(b'r' * 16)
                    swapped.append(True)
            return real_scan(path)
        with patch.object(self.module.os, 'scandir', scan), self.assertRaises(RuntimeError):
            self.module.measure([root], limit_bytes=1024)
        self.assertEqual(replacement_scans, [])
        self.assertEqual((preserved / 'keep.bin').read_bytes(), b'k' * 512)
        self.assertEqual((root / 'replacement.bin').read_bytes(), b'r' * 16)

    def test_persistent_root_scan_failure_has_bounded_operation_errno_diagnostics(self):
        root = self.repo / 'scratch'
        root.mkdir()
        real_scan = os.scandir
        attempts = []
        def scan(path):
            if self.scans_directory(path, root):
                attempts.append(True)
                if len(attempts) > 16:
                    raise AssertionError('root scan retry is unbounded')
                raise FileNotFoundError(errno.ENOENT, 'PRIVATE-ERROR', str(root))
            return real_scan(path)
        with patch.object(self.module.os, 'scandir', scan), self.assertRaises(RuntimeError) as caught:
            self.module.measure([root], limit_bytes=1024)
        self.assertEqual(len(attempts), 3)
        self.assertIn('operation=root-scandir', str(caught.exception))
        self.assertIn('errno=2', str(caught.exception))
        self.assertIn('attempts=3', str(caught.exception))
        self.assertNotIn('PRIVATE', str(caught.exception))
        self.assertNotIn(str(root), str(caught.exception))
        self.assertLess(len(str(caught.exception).encode()), 512)

    def test_child_open_permission_and_unknown_io_errors_are_not_disappearance(self):
        root = self.repo / 'scratch'
        child = root / 'child'
        child.mkdir(parents=True)
        (child / 'keep.bin').write_bytes(b'k' * 128)
        real_open = os.open
        for number in (errno.EACCES, errno.EPERM, errno.EIO):
            def opening(path, flags, *args, **kwargs):
                if os.fspath(path) == 'child' and kwargs.get('dir_fd') is not None:
                    raise OSError(number, 'PRIVATE-ERROR', str(child))
                return real_open(path, flags, *args, **kwargs)
            with self.subTest(errno=number), patch.object(self.module.os, 'open', opening), self.assertRaises(RuntimeError) as caught:
                self.module.measure([root], limit_bytes=1024)
            self.assertIn('operation=child-open', str(caught.exception))
            self.assertIn('errno=' + str(number), str(caught.exception))
            self.assertNotIn('PRIVATE', str(caught.exception))
            self.assertEqual((child / 'keep.bin').read_bytes(), b'k' * 128)

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
