"""Bounded tar and real KiB producer contracts, run only by the managed runner."""
import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import shutil
import subprocess
import sys
import tarfile
import unittest
from unittest.mock import patch

import lifecycle
import run as runner
import test_hosted_lifecycle as hosted_fixture


PREFIX = "persistent-profiles"


def tar_bytes(records, *, format=tarfile.PAX_FORMAT):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w", format=format) as archive:
        for name, kind, payload in records:
            entry = tarfile.TarInfo(name)
            entry.mode = 0o700 if kind == tarfile.DIRTYPE else 0o600
            entry.type = kind
            if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                entry.linkname = payload
                data = None
            elif kind == tarfile.REGTYPE:
                entry.size = len(payload)
                data = io.BytesIO(payload)
            else:
                data = None
            archive.addfile(entry, data)
    return output.getvalue()


def load_module(test):
    spec = importlib.util.find_spec("pack_ci_profiles")
    test.assertIsNotNone(spec, "the manifest-bound profile transport helper is missing")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PackedTarTests(unittest.TestCase):
    def setUp(self):
        self.module = load_module(self)
        self.content = b"portable owner evidence"
        self.path = PREFIX + "/case/resource-owner.json"
        self.files = {self.path: {"bytes": len(self.content),
                                 "sha256": hashlib.sha256(self.content).hexdigest()}}
        self.directories = {PREFIX, PREFIX + "/case"}
        self.records = [(PREFIX, tarfile.DIRTYPE, b""),
                        (PREFIX + "/case", tarfile.DIRTYPE, b""),
                        (self.path, tarfile.REGTYPE, self.content)]

    def verify(self, data, **changes):
        arguments = {"expanded_limit": 64 * 1024, "entry_limit": 32}
        arguments.update(changes)
        return self.module.verify_tar(io.BytesIO(data), self.files, self.directories, **arguments)

    def test_exact_members_sizes_and_hashes_are_verified_to_stream_end(self):
        data = tar_bytes(self.records)
        self.assertEqual(self.verify(data), {"entries": 3, "files": 1, "directories": 2,
                                           "bytes": len(self.content), "streamBytes": len(data)})

    def test_duplicate_or_unlisted_members_are_rejected(self):
        for extra in (self.records[-1], (PREFIX + "/case/raw.db", tarfile.REGTYPE, b"raw")):
            with self.subTest(extra=extra[0]), self.assertRaises((ValueError, RuntimeError)):
                self.verify(tar_bytes(self.records + [extra]))

    def test_missing_file_or_parent_directory_is_rejected(self):
        for records in (self.records[:-1], [self.records[0], self.records[2]]):
            with self.subTest(records=len(records)), self.assertRaises((ValueError, RuntimeError)):
                self.verify(tar_bytes(records))

    def test_absolute_parent_and_foreign_prefix_paths_are_rejected(self):
        for name in ("/persistent-profiles/escaped", "../escaped", "persistent-profiles/../escaped",
                     "another-tree/escaped", "persistent-profiles\\escaped"):
            with self.subTest(name=name), self.assertRaises((ValueError, RuntimeError)):
                self.verify(tar_bytes(self.records + [(name, tarfile.REGTYPE, b"x")]))

    def test_links_sparse_devices_and_fifo_are_rejected(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.GNUTYPE_SPARSE,
                     tarfile.CHRTYPE, tarfile.BLKTYPE, tarfile.FIFOTYPE):
            payload = self.path if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE) else b""
            with self.subTest(kind=kind), self.assertRaises((ValueError, RuntimeError)):
                self.verify(tar_bytes(self.records + [(PREFIX + "/case/extra", kind, payload)]))

    def test_wrong_size_or_hash_cannot_match_the_stable_manifest(self):
        for payload in (b"wrong", b"x" * len(self.content)):
            records = self.records[:-1] + [(self.path, tarfile.REGTYPE, payload)]
            with self.subTest(payload=payload), self.assertRaises((ValueError, RuntimeError)):
                self.verify(tar_bytes(records))

    def test_entry_limit_applies_to_directories_and_files(self):
        with self.assertRaises((ValueError, RuntimeError)):
            self.verify(tar_bytes(self.records), entry_limit=2)

    def test_expanded_limit_includes_headers_and_zero_padding(self):
        data = tar_bytes(self.records)
        with self.assertRaises((ValueError, RuntimeError)):
            self.verify(data, expanded_limit=len(data) - 1)

    def test_truncated_content_and_nonzero_trailing_data_are_rejected(self):
        data = tar_bytes(self.records)
        for malformed in (data[:3 * 512 + 3], data + b"unlisted trailing payload"):
            with self.subTest(bytes=len(malformed)), self.assertRaises((ValueError, RuntimeError)):
                self.verify(malformed)

    def test_oversized_pax_metadata_is_rejected_before_reading_its_payload(self):
        header = tarfile.TarInfo("PaxHeaders/oversize")
        header.type = tarfile.XHDTYPE
        header.size = 1024 * 1024

        class BoundedHeader(io.BytesIO):
            def read(self, size=-1):
                if size < 0 or size > 1024 or self.tell() >= 512:
                    raise AssertionError("oversized metadata was read before checking its declared size")
                return super().read(size)

        stream = BoundedHeader(header.tobuf(format=tarfile.USTAR_FORMAT))
        with self.assertRaises((ValueError, RuntimeError)):
            self.module.verify_tar(stream, self.files, self.directories,
                                   expanded_limit=2 * 1024 * 1024, entry_limit=32)

    def test_bounded_pax_long_path_is_bound_to_the_expected_member(self):
        path = PREFIX + "/case/" + "long-" * 30 + ".json"
        records = self.records[:-1] + [(path, tarfile.REGTYPE, self.content)]
        files = {path: self.files[self.path]}
        data = tar_bytes(records)
        result = self.module.verify_tar(io.BytesIO(data), files, self.directories,
                                        expanded_limit=64 * 1024, entry_limit=32)
        self.assertEqual(result["files"], 1)
        self.assertEqual(result["bytes"], len(self.content))
        self.assertEqual(result["streamBytes"], len(data))


class PackedProfileLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.module = load_module(self)
        self.fixture = hosted_fixture.HostedLifecycleTests(methodName="runTest")
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.repo = self.fixture.repo
        self.children = []
        self.commands = []
        self.addCleanup(self.stop_children)
        self.real_popen = subprocess.Popen

    def stop_children(self):
        for child in self.children:
            if child.poll() is None:
                if os.getpgid(child.pid) == child.pid:
                    os.killpg(child.pid, signal.SIGKILL)
                else:
                    child.kill()
            child.wait(timeout=3)

    def prepare(self, *, profile=True):
        preflight = self.fixture.create("ci-preflight")
        self.assertEqual(preflight.finish("passed")["status"], "passed")
        value = self.fixture.create()
        if profile:
            path = value.scratch / "tests/e2e/test-results/persistent-profiles/case"
            path.mkdir(parents=True)
            (path / "resource-owner.json").write_text(json.dumps({
                "version": 1, "runId": value.id, "kind": "browser-profile",
            }))
            (path / "raw-profile.db").write_bytes(b"raw must remain at source")
        self.assertEqual(value.finish("passed", release=False)["status"], "passed")
        runner.publish(value, "e2e")
        value.release()
        self.value = value
        self.results = self.repo / "tests/e2e/test-results"
        self.transport = value.directory / "reports/transport"
        self.fixture.checker().check(self.repo)
        self.stable_bytes = (self.results / "stable-export.json").read_bytes()
        manifest = json.loads(self.stable_bytes)
        selected = [item for item in manifest["entries"]
                    if item["path"].startswith("test-results/persistent-profiles/")]
        dirs = [name for name in manifest["directories"]
                if name == "test-results/persistent-profiles" or name.startswith("test-results/persistent-profiles/")]
        self.expected_files = {item["path"][len("test-results/"):]: {"bytes": item["bytes"], "sha256": item["sha256"]}
                               for item in selected}
        self.expected_dirs = {name[len("test-results/"):] for name in dirs}
        records = [(name, tarfile.DIRTYPE, b"") for name in sorted(self.expected_dirs)]
        records += [(name, tarfile.REGTYPE, (self.results / name).read_bytes())
                    for name in sorted(self.expected_files)]
        self.tar = tar_bytes(records)
        return value

    def source_unchanged(self):
        self.assertEqual((self.results / "stable-export.json").read_bytes(), self.stable_bytes)
        self.assertEqual((self.value.scratch / "raw.db").read_bytes(), b"keep-raw")
        for name, expected in self.expected_files.items():
            self.assertEqual(hashlib.sha256((self.results / name).read_bytes()).hexdigest(), expected["sha256"])

    def spawn(self, arguments, *args, **kwargs):
        command = list(arguments)
        self.commands.append(command)
        name = Path(command[0]).name
        if name == "tar":
            script = "import base64,sys;sys.stdout.buffer.write(base64.b64decode(sys.argv[1]))"
            replacement = [sys.executable, "-c", script, base64.b64encode(self.tar).decode()]
        elif name == "zstd":
            filename = next((part for part in command[1:] if isinstance(part, str)
                             and part.endswith((".tar.zst", ".partial")) and Path(part).is_file()), None)
            script = ("import shutil,sys;src=open(sys.argv[1],'rb') if len(sys.argv)>1 else sys.stdin.buffer;"
                      "shutil.copyfileobj(src,sys.stdout.buffer,1024)")
            replacement = [sys.executable, "-c", script] + ([filename] if filename else [])
        else:
            raise AssertionError("packing may invoke only fixed tar and zstd commands")
        child = self.real_popen(replacement, *args, **kwargs)
        self.children.append(child)
        return child

    def test_pack_keeps_source_and_binds_archive_manifest_and_budget(self):
        self.prepare()
        with patch.object(self.module.subprocess, "Popen", side_effect=self.spawn):
            receipt = self.module.pack(self.repo)
        self.assertEqual(receipt["version"], 1)
        self.assertEqual(receipt["runId"], self.value.id)
        self.assertEqual(receipt["sourceStableExportSha256"], hashlib.sha256(self.stable_bytes).hexdigest())
        archive = self.transport / "persistent-profiles.tar.zst"
        self.assertEqual(receipt["archive"], {"path": archive.name, "bytes": archive.stat().st_size,
                                              "sha256": hashlib.sha256(archive.read_bytes()).hexdigest()})
        self.assertEqual(receipt["members"]["files"], len(self.expected_files))
        self.assertGreaterEqual(receipt["budget"]["reportBytes"], archive.stat().st_size)
        self.assertEqual(json.loads((self.transport / "packed-profiles-receipt.json").read_text()), receipt)
        ledger = json.loads((self.value.directory / "run.json").read_text())["packagedProfiles"]
        self.assertEqual(ledger["stage"], "complete")
        self.source_unchanged()

    def test_transport_plan_precedes_creation_and_inode_precedes_producer(self):
        self.prepare()
        real_mkdir = Path.mkdir
        observed = []

        def creating(path, *args, **kwargs):
            if path == self.transport:
                self.assertFalse(path.exists(), "observe the registration before the real mkdir")
                plan = json.loads((self.value.directory / "run.json").read_text())["packagedProfiles"]
                self.assertEqual(plan["stage"], "planned")
                self.assertEqual(plan["sourceStableExportSha256"], hashlib.sha256(self.stable_bytes).hexdigest())
                observed.append("planned")
            return real_mkdir(path, *args, **kwargs)

        def producing(*args, **kwargs):
            plan = json.loads((self.value.directory / "run.json").read_text())["packagedProfiles"]
            info = self.transport.stat()
            self.assertEqual(plan["identity"], {"device": info.st_dev, "inode": info.st_ino})
            observed.append("registered")
            return self.spawn(*args, **kwargs)

        # Python 3.9 pathlib caches os.mkdir in _NormalAccessor at import time;
        # observe the actual public boundary used by production on every runtime.
        with patch.object(Path, "mkdir", creating), patch.object(self.module.subprocess, "Popen", side_effect=producing):
            self.module.pack(self.repo)
        self.assertTrue(observed and observed[0] == "planned", observed)
        self.assertEqual(observed.count("planned"), 1)
        self.assertIn("registered", observed)

    def test_no_profile_manifest_uses_explicit_receipt_without_fake_archive(self):
        self.prepare(profile=False)
        with patch.object(self.module.subprocess, "Popen", side_effect=AssertionError("no archive producer is needed")):
            receipt = self.module.pack(self.repo)
        self.assertIsNone(receipt["archive"])
        self.assertEqual(receipt["reason"], "no-profile-evidence")
        self.assertEqual(receipt["members"], {"entries": 0, "files": 0, "directories": 0, "bytes": 0, "streamBytes": 0})
        self.assertEqual(receipt["sourceStableExportSha256"], hashlib.sha256(self.stable_bytes).hexdigest())
        self.assertFalse((self.transport / "persistent-profiles.tar.zst").exists())
        self.source_unchanged()

    def test_complete_repeat_rechecks_members_without_replacing_the_archive(self):
        self.prepare()
        with patch.object(self.module.subprocess, "Popen", side_effect=self.spawn):
            first = self.module.pack(self.repo)
            archive = self.transport / "persistent-profiles.tar.zst"
            identity = archive.stat().st_ino
            second = self.module.pack(self.repo)
        self.assertEqual(first, second)
        self.assertEqual(archive.stat().st_ino, identity)
        self.assertEqual(sum(Path(command[0]).name == "tar" for command in self.commands), 1)
        self.source_unchanged()

    def test_unknown_transport_directory_is_preserved_without_starting_producers(self):
        self.prepare()
        self.transport.mkdir()
        keep = self.transport / "unknown.txt"
        keep.write_text("another task")
        with patch.object(self.module.subprocess, "Popen", side_effect=AssertionError("unknown target must not be used")):
            with self.assertRaises((ValueError, RuntimeError)):
                self.module.pack(self.repo)
        self.assertEqual(keep.read_text(), "another task")
        self.assertEqual({path.name for path in self.transport.iterdir()}, {"unknown.txt"})

    def test_tampered_complete_archive_is_not_overwritten_or_treated_as_idempotent(self):
        self.prepare()
        with patch.object(self.module.subprocess, "Popen", side_effect=self.spawn):
            self.module.pack(self.repo)
        archive = self.transport / "persistent-profiles.tar.zst"
        archive.write_bytes(b"tampered")
        with patch.object(self.module.subprocess, "Popen", side_effect=self.spawn):
            with self.assertRaises((ValueError, RuntimeError)):
                self.module.pack(self.repo)
        self.assertEqual(archive.read_bytes(), b"tampered")
        self.source_unchanged()

    def test_same_bytes_on_a_replaced_archive_inode_are_not_accepted(self):
        self.prepare()
        with patch.object(self.module.subprocess, "Popen", side_effect=self.spawn):
            self.module.pack(self.repo)
        archive = self.transport / "persistent-profiles.tar.zst"
        original_identity = (archive.stat().st_dev, archive.stat().st_ino)
        real_decode = self.module._archive_members
        replaced = []

        def replace_before_decode(parent, name, *args, **kwargs):
            if name == archive.name and not replaced:
                replacement = self.transport / "same-bytes-replacement"
                replacement.write_bytes(archive.read_bytes())
                replacement.replace(archive)
                replaced.append((archive.stat().st_dev, archive.stat().st_ino))
            return real_decode(parent, name, *args, **kwargs)

        value = lifecycle.Run(self.fixture.store, self.value.directory, existing=True)
        try:
            with patch.object(self.module.subprocess, "Popen", side_effect=self.spawn), \
                    patch.object(self.module, "_archive_members", side_effect=replace_before_decode):
                with self.assertRaises((ValueError, RuntimeError)):
                    self.module.verify_packaged(value)
        finally:
            value.release()
        self.assertEqual(len(replaced), 1, "replace after the registered archive's first hash")
        self.assertNotEqual(replaced[0], original_identity)
        self.source_unchanged()

    def test_receipt_changed_after_its_first_hash_is_rejected(self):
        self.prepare()
        with patch.object(self.module.subprocess, "Popen", side_effect=self.spawn):
            self.module.pack(self.repo)
        receipt_path = self.transport / "packed-profiles-receipt.json"
        original_inode = receipt_path.stat().st_ino
        real_decode = self.module._archive_members
        changed = []

        def change_receipt_before_decode(*args, **kwargs):
            if not changed:
                receipt = json.loads(receipt_path.read_text())
                receipt['runId'] = '00000000-0000-4000-8000-000000000001'
                # Keep the same file inode and directory entries: a directory-only
                # guard cannot replace the final metadata content check.
                receipt_path.write_text(json.dumps(receipt))
                changed.append(True)
            return real_decode(*args, **kwargs)

        value = lifecycle.Run(self.fixture.store, self.value.directory, existing=True)
        try:
            with patch.object(self.module.subprocess, "Popen", side_effect=self.spawn), \
                    patch.object(self.module, "_archive_members", side_effect=change_receipt_before_decode):
                with self.assertRaises((ValueError, RuntimeError)):
                    self.module.verify_packaged(value)
        finally:
            value.release()
        self.assertTrue(changed, "rewrite receipt after its first authenticated read")
        self.assertEqual(receipt_path.stat().st_ino, original_inode)
        self.assertEqual(json.loads(receipt_path.read_text())['runId'], '00000000-0000-4000-8000-000000000001')
        self.source_unchanged()

    def test_unknown_transport_member_added_during_budget_check_is_rejected(self):
        self.prepare()
        with patch.object(self.module.subprocess, "Popen", side_effect=self.spawn):
            self.module.pack(self.repo)
        extra = self.transport / "unexpected.db"
        real_budget = lifecycle.Store.hosted_budget
        introduced = []

        def add_during_budget(store):
            if not introduced:
                extra.write_bytes(b"unregistered transport payload")
                introduced.append(True)
            return real_budget(store)

        value = lifecycle.Run(self.fixture.store, self.value.directory, existing=True)
        try:
            with patch.object(self.module.subprocess, "Popen", side_effect=self.spawn), \
                    patch.object(lifecycle.Store, "hosted_budget", add_during_budget):
                with self.assertRaises((ValueError, RuntimeError)):
                    self.module.verify_packaged(value)
        finally:
            value.release()
        self.assertTrue(introduced, "insert a real extra member at the post-inventory budget check")
        self.assertEqual(extra.read_bytes(), b"unregistered transport payload")
        self.source_unchanged()

    def test_active_primary_lease_blocks_pack(self):
        self.prepare()
        value = lifecycle.Run(self.fixture.store, self.value.directory, existing=True)
        try:
            with self.assertRaises(BlockingIOError):
                self.module.pack(self.repo)
        finally:
            value.release()
        self.assertFalse(self.transport.exists())

    def test_known_transport_writer_blocks_the_ci_resource_checker(self):
        self.prepare()
        with patch.object(self.module.subprocess, "Popen", side_effect=self.spawn):
            self.module.pack(self.repo)
        archive = self.transport / "persistent-profiles.tar.zst"
        # Hold a genuine writable descriptor without changing any bytes: hashes
        # alone cannot prove that the transport no longer has an active writer.
        with archive.open("r+b") as writer:
            observation = hosted_fixture.UNKNOWN + (
                "p" + str(os.getpid()) + "\nf" + str(writer.fileno()) + "\ntREG\nn" + str(archive) + "\n"
            ).encode()
            query = subprocess.CompletedProcess([], 0, observation, b"")
            with patch.object(lifecycle.subprocess, "run", return_value=query), \
                    patch.object(self.module.subprocess, "Popen", side_effect=self.spawn):
                with self.assertRaises((ValueError, RuntimeError)):
                    self.fixture.checker().check(self.repo)
        self.source_unchanged()

    def test_low_disk_reserve_stops_before_creating_transport_or_producers(self):
        self.prepare()
        free = lifecycle.hosted.DISK_RESERVE - 1
        disk = shutil._ntuple_diskusage(total=free + 1024, used=1024, free=free)
        with patch.object(lifecycle.hosted.shutil, "disk_usage", return_value=disk), \
                patch.object(self.module.subprocess, "Popen", side_effect=AssertionError("disk reserve is mandatory")):
            with self.assertRaises((ValueError, RuntimeError)):
                self.module.pack(self.repo)
        self.assertFalse(self.transport.exists())
        self.source_unchanged()

    def test_streamed_archive_cannot_exceed_the_remaining_report_budget(self):
        self.prepare()
        remaining_limit = self.fixture.store.hosted_budget()["reportBytes"] + 2048
        real_init = lifecycle.Store.__init__

        def limited(store, repo, *args, **kwargs):
            kwargs["report_bytes"] = remaining_limit
            real_init(store, repo, *args, **kwargs)

        with patch.object(lifecycle.Store, "__init__", limited), \
                patch.object(self.module.subprocess, "Popen", side_effect=self.spawn):
            with self.assertRaises((ValueError, RuntimeError)):
                self.module.pack(self.repo)
        self.assertTrue(any(Path(command[0]).name == "tar" for command in self.commands))
        self.assertFalse((self.transport / "persistent-profiles.tar.zst").exists())
        self.assertFalse(any(self.transport.glob("*.partial")))
        self.source_unchanged()

    def test_capture_interrupt_stops_its_started_child_and_removes_only_partial(self):
        self.prepare()
        started = []

        def interrupted(arguments, *args, **kwargs):
            if started:
                raise KeyboardInterrupt("injected after the first owned producer started")
            self.assertTrue(kwargs.get("start_new_session"), "producer must own its process group")
            child = self.real_popen([sys.executable, "-c", "import time;time.sleep(30)"], *args, **kwargs)
            self.children.append(child)
            started.append(child)
            return child

        with patch.object(self.module.subprocess, "Popen", side_effect=interrupted):
            with self.assertRaises((KeyboardInterrupt, ValueError, RuntimeError)):
                self.module.pack(self.repo)
        self.assertEqual(len(started), 1)
        self.assertIsNotNone(started[0].poll(), "the helper must stop its own producer on interruption")
        self.assertFalse((self.transport / "persistent-profiles.tar.zst").exists())
        self.assertFalse(any(self.transport.glob("*.partial")))
        self.source_unchanged()

    def test_compressor_output_with_extra_raw_member_cannot_be_promoted(self):
        self.prepare()
        with tarfile.open(fileobj=io.BytesIO(self.tar), mode="r:") as existing:
            records = [(entry.name.rstrip("/"), entry.type,
                        existing.extractfile(entry).read() if entry.isfile() else b"") for entry in existing]
        self.tar = tar_bytes(records + [(PREFIX + "/case/raw.db", tarfile.REGTYPE, b"not portable")])
        with patch.object(self.module.subprocess, "Popen", side_effect=self.spawn):
            with self.assertRaises((ValueError, RuntimeError)):
                self.module.pack(self.repo)
        self.assertFalse((self.transport / "persistent-profiles.tar.zst").exists())
        self.assertFalse(any(self.transport.glob("*.partial")))
        self.source_unchanged()


class PackedTransportOpenRaceTests(unittest.TestCase):
    def test_fifo_replacement_is_rejected_before_a_blocking_open_or_decoder(self):
        # Isolate the regression: the broken implementation blocks inside open(),
        # before its decoder timeout exists. Only this test's own process group
        # is terminated if the short outer deadline expires.
        module = load_module(self)
        import tempfile
        with tempfile.TemporaryDirectory(prefix="packed-fifo-", dir=os.environ["TMPDIR"]) as temporary:
            root = Path(temporary).resolve()
            script = r'''
import os, sys
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0, sys.argv[1])
import pack_ci_profiles as packed
root = Path(sys.argv[2])
name = "archive.partial"
path = root / name
path.write_bytes(b"owned regular archive")
parent = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
try:
    packed._read_file(parent, name, 65536)
    path.unlink()
    os.mkfifo(path)
    print("FIFO_READY", flush=True)
    run = SimpleNamespace(store=SimpleNamespace(repo=root, report_bytes=65536))
    try:
        packed._archive_members(parent, name, {}, set(), run)
    except (ValueError, RuntimeError):
        print("FIFO_REJECTED", flush=True)
    else:
        raise AssertionError("FIFO reached decoder verification")
finally:
    os.close(parent)
'''
            child = subprocess.Popen([sys.executable, "-c", script,
                                      str(Path(module.__file__).parent), str(root)],
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
            expired = False
            try:
                try:
                    output, errors = child.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    expired = True
                    os.killpg(child.pid, signal.SIGKILL)
                    output, errors = child.communicate(timeout=3)
            finally:
                if child.poll() is None:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait(timeout=3)
                for stream in (child.stdout, child.stderr):
                    if stream is not None:
                        stream.close()
            self.assertIn(b"FIFO_READY", output, errors.decode(errors="replace"))
            self.assertFalse(expired, "FIFO replacement blocked before the helper's own timeout")
            self.assertEqual(child.returncode, 0, errors.decode(errors="replace"))
            self.assertIn(b"FIFO_REJECTED", output)


if __name__ == "__main__":
    unittest.main()
