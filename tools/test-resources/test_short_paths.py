"""Managed KiB fixtures only; no browser, database, container or VM is started."""
import json
import contextlib
import io
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from lifecycle import Store, lsof_incomplete_records, open_paths
from run import evidence_snapshot


class ShortPathTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="nerve-short-test-")
        self.repo = Path(self.temp.name).resolve()
        self.store = Store(self.repo)
        self.runs = []
        self.roots = []

    def tearDown(self):
        for run in self.runs:
            run.release()
        # These exact paths were created by this fixture, including deliberate damage.
        for root in self.roots:
            if root.is_symlink():
                root.unlink()
            elif root.exists():
                shutil.rmtree(root)
        self.temp.cleanup()

    def alias(self, store=None):
        run = (store or self.store).create("vm")
        self.runs.append(run)
        target = run.scratch / "tmp"; target.mkdir()
        root = run.create_short_root(); self.roots.append(root)
        alias = root / "t"
        run.update(shortTmp={"path": str(alias), "target": str(target)})
        alias.symlink_to(target, target_is_directory=True)
        info = alias.lstat()
        run.update(shortTmpIdentity={"device": info.st_dev, "inode": info.st_ino})
        return run, root, alias

    def profile(self, run):
        profile = run.scratch / "tests/e2e/test-results/persistent-profiles/case"
        profile.mkdir(parents=True)
        (profile / "resource-owner.json").write_text(json.dumps({"version": 1, "runId": run.id, "kind": "browser-profile"}))
        (profile / "cache.bin").write_bytes(b"keep until quiescent")
        return profile

    def test_runner_uses_short_alias_but_writes_to_canonical_scratch(self):
        runner = Path(__file__).with_name("run.py")
        command = "import os,pathlib,json; p=pathlib.Path(os.environ['TMPDIR']); (p/'sample').write_text('owned'); print(json.dumps({'tmp':str(p),'resolved':str(p.resolve()),'allEqual':os.environ['TMPDIR']==os.environ['TMP']==os.environ['TEMP']}))"
        result = subprocess.run([sys.executable, "-B", str(runner), "--repo", str(self.repo), "sample", "--", sys.executable, "-c", command], capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        observed = json.loads(result.stdout)
        directory, = (self.store.root / "runs").iterdir()
        receipt = json.loads((directory / "run.json").read_text())
        expected = Path("/tmp").resolve() / ("nerve-t-" + directory.name)
        self.assertEqual(observed["tmp"], str(expected / "t"))
        self.assertEqual(observed["resolved"], str(directory / "scratch/tmp"))
        self.assertTrue(observed["allEqual"])
        self.assertEqual(receipt["shortRoot"], str(expected))
        self.assertFalse(expected.exists())
        self.assertFalse((directory / "scratch").exists())

    def test_non_vm_drops_inherited_vm_short_root(self):
        runner = Path(__file__).with_name("run.py")
        command = "import os,json; print(json.dumps(os.environ.get('NERVE_TEST_SHORT_ROOT')))"
        result = subprocess.run([sys.executable, "-B", str(runner), "--repo", str(self.repo), "sample", "--", sys.executable, "-c", command],
                                env=dict(os.environ, NERVE_TEST_SHORT_ROOT="/not-this-run"),
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIsNone(json.loads(result.stdout))

    def test_socket_blocks_compaction_before_any_profile_is_modified(self):
        run, root, alias = self.alias()
        profile = self.profile(run)
        with socket.socket(socket.AF_UNIX) as handle:
            handle.bind(str(alias / "socket"))
            result = run.finish("passed", release=False)
            self.assertEqual(result["status"], "cleanup-pending")
            self.assertTrue((profile / "cache.bin").is_file(), "active socket must prevent compaction")
            self.assertEqual((profile / "cache.bin").read_bytes(), b"keep until quiescent")
            self.assertFalse((run.directory / "reports/test-results").exists())
            self.assertTrue(root.exists())
        self.assertEqual(run.finish("passed")["status"], "passed")

    def test_socket_blocks_recovery_snapshot_before_any_copy(self):
        run, root, alias = self.alias()
        self.profile(run)
        with socket.socket(socket.AF_UNIX) as handle:
            handle.bind(str(alias / "socket"))
            with self.assertRaises(RuntimeError):
                evidence_snapshot(run)
            self.assertFalse((run.directory / "reports/recovery").exists())
            self.assertTrue(root.exists())

    def test_nested_run_alias_handle_is_visible_to_outer_scratch(self):
        outer = self.store.create("sample"); self.runs.append(outer)
        nested_repo = outer.scratch / "child"; nested_repo.mkdir()
        nested, root, alias = self.alias(Store(nested_repo))
        nested.release()
        with socket.socket(socket.AF_UNIX) as handle:
            path = str(alias / "socket")
            handle.bind(path)
            self.assertIn(path, open_paths(outer.scratch))
            self.assertEqual(outer.finish("passed", release=False)["status"], "cleanup-pending")
            self.assertTrue(nested.scratch.exists())

    def test_alias_and_marker_damage_preserves_original_resources(self):
        for damage in ("directory", "other-target", "missing-marker"):
            with self.subTest(damage=damage):
                run, root, alias = self.alias()
                profile = self.profile(run)
                other = self.repo / damage; other.mkdir(); (other / "keep").write_text("external")
                if damage == "missing-marker":
                    (root / "owner.json").unlink()
                else:
                    alias.unlink()
                    if damage == "directory":
                        alias.mkdir()
                    else:
                        alias.symlink_to(other, target_is_directory=True)
                result = run.finish("passed", release=False)
                self.assertEqual(result["status"], "cleanup-pending")
                self.assertTrue((profile / "cache.bin").is_file(), "unknown ownership must prevent compaction")
                self.assertEqual((profile / "cache.bin").read_bytes(), b"keep until quiescent")
                self.assertEqual((other / "keep").read_text(), "external")
                self.assertTrue(root.exists())

    def test_replaced_root_with_copied_marker_is_not_adopted(self):
        run, root, alias = self.alias()
        original = root.with_name(root.name + "-original")
        root.rename(original); self.roots.append(original)
        root.mkdir(mode=0o700)
        shutil.copyfile(original / "owner.json", root / "owner.json")
        (root / "t").symlink_to(run.scratch / "tmp", target_is_directory=True)
        result = run.finish("passed", release=False)
        self.assertEqual(result["status"], "cleanup-pending")
        self.assertTrue(root.exists())
        self.assertTrue(original.exists())
        self.assertTrue(run.scratch.exists())

    def test_legacy_vm_marker_remains_compatible(self):
        run = self.store.create("vm"); self.runs.append(run)
        root = run.create_short_root(); self.roots.append(root)
        del run.data["shortRootIdentity"]; run.persist()
        self.assertEqual(json.loads((root / "owner.json").read_text()),
                         {"runId": run.id, "repo": str(self.repo), "kind": "vm-short-path"})
        (root / "ssh-session").mkdir()
        self.assertEqual(run.finish("passed")["status"], "passed")
        self.assertFalse(root.exists())

    def test_interrupted_alias_creation_is_retained_then_recoverable_after_exact_repair(self):
        import run as runner
        with patch.object(sys, "argv", ["run.py", "--repo", str(self.repo), "sample", "--", sys.executable, "-c", "raise AssertionError('must not start')"]), patch.object(Path, "symlink_to", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                runner.main()
        directory, = (self.store.root / "runs").iterdir()
        receipt = json.loads((directory / "run.json").read_text())
        root = Path(receipt["shortRoot"]); self.roots.append(root)
        self.assertEqual(receipt["status"], "cleanup-pending")
        self.assertIsNone(receipt["childGroup"])
        self.assertTrue((directory / "scratch").exists())
        self.store.sweep()
        self.assertTrue(root.exists())
        # The fixture knows its interruption; production recovery must not invent this proof.
        from lifecycle import Run
        restored = Run(self.store, directory, existing=True); self.runs.append(restored)
        alias = Path(receipt["shortTmp"]["path"])
        alias.symlink_to(Path(receipt["shortTmp"]["target"]), target_is_directory=True)
        info = alias.lstat()
        restored.update(shortTmpIdentity={"device": info.st_dev, "inode": info.st_ino})
        restored.release()
        self.store.sweep(); self.store.sweep()
        self.assertFalse(root.exists())
        self.assertFalse((directory / "scratch").exists())

    def test_normal_root_rejects_unregistered_content(self):
        run = self.store.create("sample"); self.runs.append(run)
        root = run.create_short_root(); self.roots.append(root)
        (root / "unregistered").write_text("keep")
        result = run.finish("passed", release=False)
        self.assertEqual(result["status"], "cleanup-pending")
        self.assertTrue((root / "unregistered").exists())
        self.assertTrue(run.scratch.exists())

    def test_existing_short_root_is_never_adopted(self):
        run = self.store.create("sample"); self.runs.append(run)
        expected = Path("/tmp").resolve() / ("nerve-t-" + run.id)
        expected.mkdir(mode=0o700); self.roots.append(expected)
        (expected / "external").write_text("keep")
        try:
            created = run.create_short_root()
        except FileExistsError:
            pass
        else:
            self.roots.append(created)
            self.fail("An existing short root must not be adopted or bypassed")
        self.assertEqual((expected / "external").read_text(), "keep")
        self.assertFalse((expected / "owner.json").exists())

    def test_new_vm_creation_cannot_adopt_existing_directory_with_matching_legacy_marker(self):
        run = self.store.create("vm"); self.runs.append(run)
        root = Path("/tmp").resolve() / ("nerve-vm-" + run.id)
        root.mkdir(mode=0o700); self.roots.append(root)
        (root / "owner.json").write_text(json.dumps({"runId": run.id, "repo": str(self.repo), "kind": "vm-short-path"}))
        (root / "existing").write_text("do not adopt")
        with self.assertRaises(FileExistsError):
            run.create_short_root()
        self.assertEqual(run.finish("passed", release=False)["status"], "cleanup-pending")
        self.assertEqual((root / "existing").read_text(), "do not adopt")
        self.assertTrue(run.scratch.exists())

    def test_vm_alias_without_root_identity_cannot_use_legacy_exception(self):
        run, root, alias = self.alias()
        del run.data["shortRootIdentity"]; run.persist()
        self.assertEqual(run.finish("passed", release=False)["status"], "cleanup-pending")
        self.assertTrue(root.exists())
        self.assertTrue(run.scratch.exists())

    def test_repeated_root_creation_keeps_existing_creation_proof(self):
        run = self.store.create("sample"); self.runs.append(run)
        root = run.create_short_root(); self.roots.append(root)
        with self.assertRaises((OSError, ValueError)):
            run.create_short_root()
        self.assertEqual(run.finish("passed")["status"], "passed")
        self.assertFalse(root.exists())

    def test_sigterm_during_alias_creation_never_starts_command_and_cleans_roots(self):
        import run as runner
        original = Path.symlink_to
        def interrupt(path, *args, **kwargs):
            os.kill(os.getpid(), signal.SIGTERM)
            return original(path, *args, **kwargs)
        with patch.object(sys, "argv", ["run.py", "--repo", str(self.repo), "sample", "--", sys.executable, "-c", "raise AssertionError('must not start')"]), patch.object(Path, "symlink_to", interrupt):
            self.assertEqual(runner.main(), 143)
        directory, = (self.store.root / "runs").iterdir()
        receipt = json.loads((directory / "run.json").read_text())
        root = Path(receipt["shortRoot"]); self.roots.append(root)
        self.assertEqual(receipt["exitCode"], 143)
        self.assertEqual(receipt["status"], "interrupted")
        self.assertEqual(receipt["requestedStatus"], "interrupted")
        self.assertIsNone(receipt["childGroup"])
        self.assertFalse(root.exists())
        self.assertFalse((directory / "scratch").exists())

    def test_success_failure_interruption_and_repeat_cleanup_preserve_other_directory(self):
        other = self.repo / "business"; other.mkdir(); (other / "keep").write_text("external")
        for status in ("passed", "failed", "interrupted"):
            run, root, alias = self.alias()
            (alias / "sample").write_text("temporary")
            self.assertEqual(run.finish(status)["status"], status)
            self.store.sweep(); self.store.sweep()
            self.assertFalse(root.exists())
            self.assertFalse(run.scratch.exists())
            self.assertEqual((other / "keep").read_text(), "external")

    def test_setup_failure_records_pending_cleanup_and_releases_lease(self):
        import lifecycle
        import run as runner
        original = lifecycle.atomic_json
        def fail_owner(path, value):
            if path.name == "owner.json":
                raise OSError("controlled marker creation failure")
            return original(path, value)
        try:
            with patch.object(sys, "argv", ["run.py", "--repo", str(self.repo), "vm", "--", sys.executable, "-c", "raise AssertionError('must not start')"]), patch("lifecycle.atomic_json", side_effect=fail_owner):
                with self.assertRaises(OSError):
                    runner.main()
        finally:
            directory, = (self.store.root / "runs").iterdir()
            receipt = json.loads((directory / "run.json").read_text())
            self.roots.append(Path(receipt["shortRoot"]))
        self.assertEqual(receipt["status"], "cleanup-pending")
        self.assertTrue((directory / "scratch").exists())
        # A failed setup must not leave its lease locked for a later recovery process.
        from lifecycle import locked
        with locked(directory / "run.lock", blocking=False):
            pass

    def test_lsof_failure_diagnostics_are_emitted_to_runner_stderr(self):
        fake = self.repo / "lsof"
        fake.write_text("#!/bin/sh\nprintf 'controlled-lsof-warning' >&2\nexit 0\n")
        fake.chmod(0o700)
        runner = Path(__file__).with_name("run.py")
        try:
            result = subprocess.run([sys.executable, "-B", str(runner), "--repo", str(self.repo), "sample", "--", sys.executable, "-c", "pass"],
                                    env=dict(os.environ, NERVE_TEST_LSOF_MODE="direct", PATH=str(self.repo) + os.pathsep + os.environ.get("PATH", "")),
                                    capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 1)
        finally:
            directory, = (self.store.root / "runs").iterdir()
            receipt = json.loads((directory / "run.json").read_text())
            self.roots.append(Path(receipt["shortRoot"]))
        self.assertEqual(receipt["status"], "cleanup-pending")
        self.assertIn("controlled-lsof-warning", result.stderr)
        self.assertIn('"returncode": 0', result.stderr)

    def assert_failed_preflight_does_not_spawn(self, failure, expected):
        import run as runner
        marker = self.repo / "command-started"
        command = "import pathlib,sys; pathlib.Path(sys.argv[1]).write_text('started')"
        options = {"side_effect": failure} if isinstance(failure, Exception) else {"return_value": failure}
        caught = None
        try:
            with patch.object(sys, "argv", ["run.py", "--repo", str(self.repo), "sample", "--", sys.executable, "-c", command, str(marker)]), patch("lifecycle.subprocess.run", **options), contextlib.redirect_stderr(io.StringIO()):
                try:
                    runner.main()
                except RuntimeError as error:
                    caught = error
        finally:
            directory, = (self.store.root / "runs").iterdir()
            receipt = json.loads((directory / "run.json").read_text())
            root = Path(receipt["shortRoot"]); self.roots.append(root)
        self.assertFalse(marker.exists(), "failed handle preflight must prevent the marker command from starting")
        self.assertIsInstance(caught, RuntimeError)
        for diagnostic in (str(caught), receipt["cleanupError"]):
            self.assertIn(expected, diagnostic)
            self.assertIn("controlled-preflight", diagnostic)
            self.assertNotIn("GLOBAL-STDOUT-SECRET", diagnostic)
            self.assertLess(len(diagnostic.encode()), 10000)
        self.assertEqual(receipt["status"], "cleanup-pending")
        self.assertEqual(receipt["exitCode"], 1)
        self.assertIsNone(receipt["childGroup"])
        self.assertTrue(root.exists())
        self.assertTrue((directory / "scratch").exists())
        # Once the same handle check works again, the registered partial setup is recoverable.
        self.store.sweep(); self.store.sweep()
        self.assertFalse(root.exists())
        self.assertFalse((directory / "scratch").exists())
        self.assertFalse(marker.exists())

    def test_lsof_warning_preflight_prevents_command_start(self):
        warning = b"controlled-preflight-warning " + b"x" * 9000
        failure = subprocess.CompletedProcess(["lsof"], 0, b"GLOBAL-STDOUT-SECRET", warning)
        self.assert_failed_preflight_does_not_spawn(failure, '"stderrTruncated": true')

    def test_lsof_timeout_preflight_prevents_command_start(self):
        failure = subprocess.TimeoutExpired(["lsof"], 30, output=b"GLOBAL-STDOUT-SECRET", stderr=b"controlled-preflight-timeout")
        self.assert_failed_preflight_does_not_spawn(failure, '"timedOut": true')

    def test_signal_during_handle_preflight_does_not_start_command(self):
        import run as runner
        marker = self.repo / "command-started"
        original = subprocess.run
        interrupted = False
        def interrupt(*args, **kwargs):
            nonlocal interrupted
            if not interrupted:
                interrupted = True
                os.kill(os.getpid(), signal.SIGTERM)
            return original(*args, **kwargs)
        command = "import pathlib,sys; pathlib.Path(sys.argv[1]).write_text('started')"
        try:
            with patch.object(sys, "argv", ["run.py", "--repo", str(self.repo), "sample", "--", sys.executable, "-c", command, str(marker)]), patch("lifecycle.subprocess.run", side_effect=interrupt):
                code = runner.main()
        finally:
            directory, = (self.store.root / "runs").iterdir()
            receipt = json.loads((directory / "run.json").read_text())
            root = Path(receipt["shortRoot"]); self.roots.append(root)
        self.assertFalse(marker.exists(), "signal during preflight must not start the command")
        self.assertEqual(code, 143)
        self.assertEqual(receipt["exitCode"], 143)
        self.assertEqual(receipt["status"], "interrupted")
        self.assertIsNone(receipt["childGroup"])
        self.assertFalse(root.exists())
        self.assertFalse((directory / "scratch").exists())

    def test_completed_runner_closes_its_output_pipe(self):
        import run as runner
        original = subprocess.Popen
        children = []
        def spawn(*args, **kwargs):
            child = original(*args, **kwargs)
            if args[0][0] == sys.executable:
                children.append(child)
            return child
        try:
            with patch.object(sys, "argv", ["run.py", "--repo", str(self.repo), "sample", "--", sys.executable, "-c", "pass"]), patch("run.subprocess.Popen", side_effect=spawn):
                self.assertEqual(runner.main(), 0)
            self.assertEqual(len(children), 1)
            self.assertTrue(children[0].stdout.closed, "completed output pipe must be released")
        finally:
            for child in children:
                child.stdout.close()


class HandleDiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="nerve-handles-test-")
        self.repo = Path(self.temp.name).resolve()
        self.store = Store(self.repo)

    def tearDown(self):
        self.temp.cleanup()

    def assert_incomplete_query_preserves(self, output, expected):
        run = self.store.create("sample")
        marker = run.scratch / "keep"; marker.write_text("owned")
        answer = subprocess.CompletedProcess(["lsof"], 0, output, b"")
        with patch.dict(os.environ, {}, clear=True), patch("lifecycle.subprocess.run", return_value=answer):
            result = run.finish("passed")
        self.assertEqual(result["status"], "cleanup-pending")
        self.assertEqual(marker.read_text(), "owned")
        self.assertIn(expected, result["cleanupError"])
        self.assertNotIn("GLOBAL-STDOUT-SECRET", result["cleanupError"])
        self.assertLess(len(result["cleanupError"].encode()), 10000)
        return result["cleanupError"]

    def test_nofd_outside_owned_root_is_incomplete_even_with_zero_exit(self):
        self.assert_incomplete_query_preserves(
            b"p156\nfNOFD\nn/proc/156/fd (opendir: Permission denied)\n", "NOFD")

    def test_per_fd_readlink_failure_is_incomplete_without_nofd_or_stderr(self):
        self.assert_incomplete_query_preserves(
            b"p144\nf20\nn/proc/144/fd/20 (readlink: Permission denied)\n", "readlink")

    def test_proc_errors_and_exit_races_are_not_ignored(self):
        for descriptor, name, operation in [
            ("cwd", "/proc/144/cwd (readlink: Permission denied)", "readlink"),
            ("rtd", "/proc/144/task/145/root (readlink: No such file or directory)", "readlink"),
            ("20", "/other/GLOBAL-STDOUT-SECRET (stat: Permission denied)", "stat"),
            ("20", "/other/GLOBAL-STDOUT-SECRET lstat: No such file or directory)", "lstat"),
        ]:
            with self.subTest(descriptor=descriptor, operation=operation):
                self.assert_incomplete_query_preserves(
                    f"p144\nf{descriptor}\nn{name}\n".encode(), operation)

    def test_linux_io_uring_mapping_is_known_nonfilesystem_name(self):
        output = b"p145\nfmem\ntREG\nnanon_inode:[io_uring] (stat: No such file or directory)\n"
        answer = subprocess.CompletedProcess(["lsof"], 0, output, b"")
        with self.configured_query({}, answer=answer):
            self.assertEqual(lsof_incomplete_records(output.decode()), (0, []))
            self.assertEqual(open_paths(self.repo), [])

    def test_io_uring_mapping_does_not_hide_owned_paths(self):
        names = [str(self.repo / "held.txt"), str(self.repo / "held.sock") + " type=STREAM"]
        output = ("p145\nfmem\ntREG\nnanon_inode:[io_uring] (stat: No such file or directory)\n"
                  + f"f20\ntREG\nn{names[0]}\nf22\ntunix\nn{names[1]}\n").encode()
        answer = subprocess.CompletedProcess(["lsof"], 0, output, b"")
        with self.configured_query({}, answer=answer):
            self.assertEqual(lsof_incomplete_records(output.decode()), (0, []))
            self.assertEqual(open_paths(self.repo), sorted(names))

    def test_io_uring_lookalikes_and_other_contexts_remain_incomplete(self):
        exact = "anon_inode:[io_uring] (stat: No such file or directory)"
        cases = [(platform, "mem", "REG", exact) for platform in ("darwin", "freebsd")]
        cases += [("linux", fd, "REG", exact) for fd in ("20", "txt", "MEM")]
        cases += [("linux", "mem", kind, exact) for kind in ("a_inode", "DIR", "unix", "REGULAR", None)]
        cases += [("linux", "mem", "REG", name) for name in (
            "/absolute/path/" + exact, "./" + exact,
            exact.replace("[io_uring]", "[eventpoll]"), exact.replace("[io_uring]", "[io_uring_extra]"),
            exact.replace("No such file or directory", "Permission denied"),
            exact.replace("No such file or directory", "Input/output error"),
            exact.replace("stat:", "lstat:"), exact.replace("stat:", "readlink:"),
        )]
        for platform, descriptor, kind, name in cases:
            type_field = f"t{kind}\n" if kind is not None else ""
            output = f"p145\nf{descriptor}\n{type_field}n{name}\n".encode()
            with self.subTest(platform=platform, descriptor=descriptor, kind=kind, name=name), patch("sys.platform", platform):
                self.assert_incomplete_query_preserves(output, "inspection-error")

    def test_io_uring_mapping_does_not_hide_other_incomplete_records(self):
        output = (b"p145\nfmem\ntREG\nnanon_inode:[io_uring] (stat: No such file or directory)\n"
                  b"p157\nfNOFD\nn/proc/157/fd (opendir: Permission denied)\n")
        with patch("sys.platform", "linux"):
            self.assert_incomplete_query_preserves(output, "NOFD")

    def test_protocol_only_socket_fallback_preserves_resources(self):
        for protocol in ("UNIX", "UNKNOWN", "TCP"):
            with self.subTest(protocol=protocol):
                self.assert_incomplete_query_preserves(
                    f"p144\nf20\ntsock\nnprotocol: {protocol}\n".encode(), "unresolved-socket")

    def test_mapping_identity_mismatches_preserve_resources(self):
        for annotation in ("(path inode=42)", "(path dev=8,1)", "(path dev=8,1,inode=42)"):
            with self.subTest(annotation=annotation):
                self.assert_incomplete_query_preserves(
                    f"p144\nfmem\ntREG\nn/other/GLOBAL-STDOUT-SECRET {annotation}\n".encode(),
                    "mapping-identity-mismatch")

    def test_malformed_or_unresolved_records_never_mean_no_handles(self):
        for output in (b"", b"p123\nf3\n", b"p123\nn/elsewhere\n", b"pbad\nf3\nn/elsewhere\n",
                       b"p123\nf3\nn/elsewhere\nn/second\n", b"GLOBAL-STDOUT-SECRET\n",
                       b"p123\nf3\nncan't identify protocol\n"):
            with self.subTest(output=output):
                self.assert_incomplete_query_preserves(output, "incompleteRecordCount")

    def test_incomplete_record_diagnostics_are_bounded_and_normalized(self):
        output = b"".join(f"p{pid}\nf20\nn/other/GLOBAL-STDOUT-SECRET (readlink: Permission denied)\n".encode() for pid in range(100, 164))
        error = self.assert_incomplete_query_preserves(output, '"incompleteRecordCount": 64')
        details = json.loads(error.split("：", 1)[1])
        self.assertEqual(len(details["incompleteRecords"]), 16)
        self.assertTrue(details["incompleteRecordsTruncated"])
        self.assertEqual(details["incompleteRecords"][0]["pid"], 100)
        self.assertEqual(details["incompleteRecords"][0]["fd"], "20")

    def test_actual_mac_nonpath_types_may_have_empty_names(self):
        # Observed in the real macOS stream; these are not vnode or UNIX socket types.
        for kind in ("PIPE", "NPOLICY", "NEXUS"):
            answer = subprocess.CompletedProcess(["lsof"], 0, f"p123\nf3\nt{kind}\nn\n".encode(), b"")
            with self.subTest(kind=kind), self.configured_query({}, platform="darwin", answer=answer):
                self.assertEqual(open_paths(self.repo), [])

    def test_mac_nonpath_types_still_require_the_name_field(self):
        for kind in ("PIPE", "NPOLICY", "NEXUS"):
            answer = subprocess.CompletedProcess(["lsof"], 0, f"p123\nf3\nt{kind}\n".encode(), b"")
            with self.subTest(kind=kind), self.configured_query({}, platform="darwin", answer=answer):
                with self.assertRaises(RuntimeError):
                    open_paths(self.repo)

    def test_nameless_files_sockets_and_unknown_types_still_reject(self):
        for kind in ("REG", "DIR", "unix", "UNKNOWN", "", "pipe", "PIPE-extra", "xNPOLICY", "NEXUS2"):
            answer = subprocess.CompletedProcess(["lsof"], 0, f"p123\nf3\nt{kind}\nn\n".encode(), b"")
            with self.subTest(kind=kind), self.configured_query({}, platform="darwin", answer=answer):
                with self.assertRaises(RuntimeError):
                    open_paths(self.repo)

    def test_nonpath_name_rule_never_hides_errors_or_applies_to_linux(self):
        for platform, name in (("darwin", "/proc/144/fd/20 (readlink: Permission denied)"), ("linux", "")):
            answer = subprocess.CompletedProcess(["lsof"], 0, f"p144\nf20\ntPIPE\nn{name}\n".encode(), b"")
            with self.subTest(platform=platform), self.configured_query({}, platform=platform, answer=answer):
                with self.assertRaises(RuntimeError):
                    open_paths(self.repo)

    @contextlib.contextmanager
    def configured_query(self, environment, platform="linux", release=None, answer=None):
        if answer is None:
            answer = subprocess.CompletedProcess(["lsof"], 0, b"p123\nf3\nn/elsewhere\n", b"")
        options = {"side_effect": answer} if isinstance(answer, Exception) else {"return_value": answer}
        release_text = "\n".join(key + "=" + value for key, value in (release or {"ID": "ubuntu", "VERSION_ID": "24.04"}).items())
        with patch.dict(os.environ, environment, clear=True), patch("sys.platform", platform), \
                patch("lifecycle.Path.read_text", return_value=release_text), \
                patch("lifecycle.shutil.which", return_value="/local/bin/lsof"), \
                patch("lifecycle.subprocess.run", **options) as query:
            yield query

    def github_query_environment(self):
        return {"NERVE_TEST_LSOF_MODE": "github-ubuntu-sudo", "CI": "true", "GITHUB_ACTIONS": "true",
                "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux"}

    def test_explicit_github_ubuntu_mode_uses_only_fixed_noninteractive_lsof(self):
        with self.configured_query(self.github_query_environment()) as query:
            self.assertEqual(open_paths(self.repo), [])
        self.assertEqual(query.call_args.args[0], ["/usr/bin/sudo", "-n", "--", "/usr/bin/lsof", "-nP", "-F", "pfnt"])
        self.assertEqual(query.call_args.kwargs["env"]["LC_ALL"], "C")
        self.assertEqual(query.call_args.kwargs["timeout"], 30)

    def test_mac_and_ordinary_local_queries_never_automatically_elevate(self):
        for platform in ("darwin", "linux"):
            with self.subTest(platform=platform), self.configured_query({"CI": "true"}, platform=platform) as query:
                self.assertEqual(open_paths(self.repo), [])
                self.assertEqual(query.call_args.args[0], ["/local/bin/lsof", "-nP", "-F", "pfnt"])

    def test_ci_mode_misuse_and_custom_commands_are_rejected_before_spawn(self):
        eligible = self.github_query_environment()
        cases = [({**eligible, key: value}, "linux", None) for key, value in [
            ("CI", "false"), ("GITHUB_ACTIONS", "false"), ("RUNNER_ENVIRONMENT", "self-hosted"),
            ("RUNNER_OS", "macOS"), ("NERVE_TEST_LSOF_MODE", "/tmp/custom-root-command")]]
        cases += [(eligible, "darwin", None), (eligible, "linux", {"ID": "debian", "VERSION_ID": "12"}),
                  (eligible, "linux", {"ID": "ubuntu", "VERSION_ID": "22.04"})]
        for environment, platform, release in cases:
            with self.subTest(environment=environment, platform=platform, release=release), \
                    self.configured_query(environment, platform=platform, release=release) as query:
                with self.assertRaises(RuntimeError):
                    open_paths(self.repo)
                query.assert_not_called()

    def test_elevated_query_failures_and_incomplete_results_still_reject(self):
        for answer in [subprocess.CompletedProcess(["sudo"], 1, b"", b"sudo: a password is required"),
                       subprocess.CompletedProcess(["sudo"], 0, b"p144\nf20\nn/proc/144/fd/20 (readlink: Permission denied)\n", b""),
                       subprocess.TimeoutExpired(["sudo"], 30, output=b"GLOBAL-STDOUT-SECRET")]:
            with self.subTest(answer=type(answer).__name__), self.configured_query(self.github_query_environment(), answer=answer):
                with self.assertRaises(RuntimeError) as caught:
                    open_paths(self.repo)
                self.assertNotIn("GLOBAL-STDOUT-SECRET", str(caught.exception))

    def test_failures_keep_bounded_diagnostics_and_never_global_stdout(self):
        for code in (0, 1, 2, -9):
            with self.subTest(code=code):
                run = self.store.create("sample")
                (run.scratch / "keep").write_text("owned")
                warning = "warning-" + "字" * 9000
                answer = subprocess.CompletedProcess(["lsof"], code, "GLOBAL-STDOUT-SECRET", warning)
                with patch("lifecycle.subprocess.run", return_value=answer):
                    result = run.finish("passed")
                self.assertEqual(result["status"], "cleanup-pending")
                self.assertTrue(run.scratch.exists())
                self.assertIn('"returncode": ' + str(code), result["cleanupError"])
                self.assertIn("warning-", result["cleanupError"])
                self.assertIn('"stderrTruncated": true', result["cleanupError"])
                self.assertNotIn("GLOBAL-STDOUT-SECRET", result["cleanupError"])
                self.assertLess(len(result["cleanupError"].encode()), 10000)

    def test_timeout_is_recorded_as_cleanup_pending(self):
        run = self.store.create("sample")
        failure = subprocess.TimeoutExpired(["lsof"], 30, output=b"GLOBAL-STDOUT-SECRET", stderr=b"partial warning")
        with patch("lifecycle.subprocess.run", side_effect=failure):
            try:
                result = run.finish("passed")
            except subprocess.TimeoutExpired:
                self.fail("lsof timeout must be recorded as pending cleanup")
        self.assertEqual(result["status"], "cleanup-pending")
        self.assertIn('"timedOut": true', result["cleanupError"])
        self.assertIn("partial warning", result["cleanupError"])
        self.assertNotIn("GLOBAL-STDOUT-SECRET", result["cleanupError"])
        self.assertTrue(run.scratch.exists())

    def test_abnormal_exit_without_stderr_and_spawn_failure_preserve_resources(self):
        for failure in (subprocess.CompletedProcess(["lsof"], 2, b"", b""), FileNotFoundError(2, "missing lsof")):
            with self.subTest(failure=type(failure).__name__):
                run = self.store.create("sample")
                options = {"side_effect": failure} if isinstance(failure, OSError) else {"return_value": failure}
                with patch("lifecycle.subprocess.run", **options):
                    result = run.finish("passed")
                self.assertEqual(result["status"], "cleanup-pending")
                self.assertTrue(run.scratch.exists())
                self.assertIn('"errno": 2' if isinstance(failure, OSError) else '"returncode": 2', result["cleanupError"])

    def test_resolved_deleted_and_socket_suffix_matches_keep_original_text(self):
        run = self.store.create("sample")
        target = run.scratch / "tmp"; target.mkdir()
        alias = self.repo / "alias"; alias.symlink_to(target, target_is_directory=True)
        for suffix in ("", " (deleted)", " type=STREAM (CONNECTED)"):
            with self.subTest(suffix=suffix):
                original = str(alias / "gone") + suffix
                answer = subprocess.CompletedProcess(["lsof"], 0, "p123\nf3\nn" + original + "\n", "")
                with patch("lifecycle.subprocess.run", return_value=answer):
                    self.assertEqual(open_paths(run.scratch), [original])
        run.release()


if __name__ == "__main__":
    unittest.main()
