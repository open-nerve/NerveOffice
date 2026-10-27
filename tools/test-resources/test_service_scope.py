"""Fixed GitHub PostgreSQL service proof; only mocked KiB command/proc data."""
import inspect
import contextlib
import copy
import importlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from lifecycle import Run, Store, atomic_json, lsof_incomplete_records, open_paths, read_json
from run import publish, rotate_reports

CID = "a" * 64
NETWORK = "b" * 64
NETWORK_NAME = "github_network_" + "c" * 32
VOLUME = "d" * 64
IMAGE = "postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873"
IDENTITY = "12345678-1234-1234-1234-123456789abc"
ENV = {"CI": "true", "GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux",
       "NERVE_TEST_LSOF_MODE": "github-ubuntu-sudo", "NERVE_TEST_CI_POSTGRES_SERVICE_ID": CID,
       "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1", "GITHUB_JOB": "e2e"}


def container_data():
    return {"id": CID, "image": IMAGE, "imageId": "sha256:" + "e" * 64, "running": True,
            "startedAt": "2026-10-28T00:00:00.000000000Z", "pid": 123, "path": "docker-entrypoint.sh",
            "args": ["postgres"], "entrypoint": ["docker-entrypoint.sh"], "cmd": ["postgres"],
            "privileged": False, "capAdd": None, "devices": [], "deviceRequests": None, "deviceRules": None,
            "volumesFrom": None, "binds": None, "mountSpecs": None, "tmpfs": None,
            "pidMode": "", "ipcMode": "private", "networkMode": NETWORK_NAME,
            "openStdin": False, "attachStdin": False, "tty": False, "runtime": "runc",
            "mounts": [{"Type": "volume", "Name": VOLUME, "Source": "/var/lib/docker/volumes/" + VOLUME + "/_data",
                        "Destination": "/var/lib/postgresql", "Driver": "local", "RW": True, "Propagation": ""}],
            "networks": {NETWORK_NAME: {"NetworkID": NETWORK}},
            "ports": {"5432/tcp": [{"HostIp": "0.0.0.0", "HostPort": "5432"}]},
            "exposedPorts": {"5432/tcp": {}}}


class ServiceScopeContractTests(unittest.TestCase):
    def test_verified_service_records_have_an_explicit_record_scope(self):
        self.assertIn("service_pids", inspect.signature(lsof_incomplete_records).parameters)
        output = ("p123\nfmem\ntREG\nn/usr/lib/libc.so (stat: No such file or directory)\n"
                  "fmem\ntREG\nn/usr/lib/libc.so (path inode=456)\n"
                  "f9\ntsock\nnprotocol: UNIX\n")
        self.assertEqual(lsof_incomplete_records(output, service_pids={123}), (0, []))
        self.assertEqual(lsof_incomplete_records(output)[0], 3)

    def test_unowned_queries_remain_the_default(self):
        self.assertIn("owner", inspect.signature(open_paths).parameters)
        self.assertIsNone(inspect.signature(open_paths).parameters["owner"].default)

    def test_service_records_do_not_excuse_other_errors_or_protocol_shapes(self):
        self.assertIn("service_pids", inspect.signature(lsof_incomplete_records).parameters)
        for fd, kind, name in [("NOFD", "REG", "/proc/123/fd (opendir: Permission denied)"),
                               ("9", "REG", "/proc/123/fd/9 (readlink: Permission denied)"),
                               ("mem", "REG", "/lib/libc.so (stat: Permission denied)"),
                               ("mem", "REG", "/lib/libc.so (lstat: No such file or directory)"),
                               ("9", "sock", "protocol: SCTP"), ("9", "sock", "protocol: UNIX extra"),
                               ("mem", "sock", "protocol: UNIX"), ("9", "unix", "protocol: UNIX")]:
            with self.subTest(fd=fd, kind=kind, name=name):
                output = f"p123\nf{fd}\nt{kind}\nn{name}\n"
                self.assertGreater(lsof_incomplete_records(output, service_pids={123})[0], 0)
        self.assertGreater(lsof_incomplete_records("p123\nf9\ntsock\nnprotocol: UNIX\nnprotocol: UNIX\n", service_pids={123})[0], 0)

    def test_observed_cross_namespace_protocols_require_service_scope(self):
        for protocol in ("UNIX-STREAM", "TCP", "UDP", "TCPv6", "UDPv6"):
            with self.subTest(protocol=protocol):
                output = f"p123\nf9\ntsock\nnprotocol: {protocol}\n"
                self.assertEqual(lsof_incomplete_records(output, service_pids={123}), (0, []))
                self.assertGreater(lsof_incomplete_records(output)[0], 0)

    def test_observed_protocol_lookalikes_and_wrong_identity_stay_incomplete(self):
        for protocol in ("UNIX", "UNIX-STREAM", "TCP", "UDP", "TCPv6", "UDPv6"):
            for pid, fd, kind, name in [(124, "9", "sock", "protocol: " + protocol),
                                        (123, "mem", "sock", "protocol: " + protocol),
                                        (123, "9", "unix", "protocol: " + protocol),
                                        (123, "9", "REG", "protocol: " + protocol),
                                        (123, "9", "sock", "protocol: " + protocol + " extra"),
                                        (123, "9", "sock", "protocol: " + protocol + " "),
                                        (123, "9", "sock", "protocol: " + protocol.lower())]:
                with self.subTest(protocol=protocol, pid=pid, fd=fd, kind=kind, name=name):
                    output = f"p{pid}\nf{fd}\nt{kind}\nn{name}\n"
                    self.assertGreater(lsof_incomplete_records(output, service_pids={123})[0], 0)


class ServiceProofTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(importlib.util.find_spec("service_scope"), "fixed service proof module is required")
        self.module = importlib.import_module("service_scope")
        self.temp = tempfile.TemporaryDirectory(prefix="nerve-service-scope-")
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name).resolve()
        self.roots = {"scratch": str(self.repo / "scratch"), "reports": str(self.repo / "reports"),
                      "failures": str(self.repo / "failures"), "short": str(self.repo / "short")}
        self.container = container_data()
        self.network = {"id": NETWORK, "name": NETWORK_NAME, "driver": "bridge", "scope": "local",
                        "options": {}, "containers": {CID: {}}, "internal": False}
        self.volume = {"name": VOLUME, "driver": "local", "scope": "local", "options": None,
                       "mountpoint": self.container["mounts"][0]["Source"]}

    def command(self, operation, arguments, deadline):
        data = {"container-inspect": self.container, "network-inspect": self.network, "volume-inspect": self.volume}
        # Docker --format returns only requested fields, including absence of an
        # unrequested Runtime field; an unsafe daemon value must not pass unseen.
        return json.dumps({key: value for key, value in data[operation].items()
                           if '"' + key + '":' in arguments[-1]}).encode()

    @contextlib.contextmanager
    def configured(self):
        with patch.dict(os.environ, ENV, clear=True), patch("sys.platform", "linux"), \
                patch("service_scope._read_small", return_value=b'ID=ubuntu\nVERSION_ID="24.04"\n'), \
                patch("service_scope._capture", return_value=(self.volume["mountpoint"] + "\n").encode()), \
                patch("service_scope._command", side_effect=self.command) as command:
            yield command

    def proof(self):
        return self.module.register(IDENTITY, self.repo, self.roots)

    def test_standard_service_proof_selects_only_fixed_readonly_fields(self):
        with self.configured() as command:
            proof = self.proof()
        self.assertEqual(proof["runId"], IDENTITY)
        self.assertEqual(proof["roots"], self.roots)
        self.assertEqual(proof["service"]["id"], CID)
        for call in command.call_args_list:
            self.assertNotIn("Config.Env", str(call))
        self.assertEqual(len(command.call_args_list), 3)

    def test_no_service_id_does_not_inspect_or_retroactively_register(self):
        with self.configured() as command, patch.dict(os.environ, {"NERVE_TEST_CI_POSTGRES_SERVICE_ID": ""}):
            self.assertIsNone(self.proof())
            command.assert_not_called()

    def test_nonstandard_or_missing_runtime_cannot_authorize_scope(self):
        for runtime in ("", None, False, 0, [], {}, "runsc", "io.containerd.runc.v2", "missing"):
            with self.subTest(runtime=runtime):
                self.container = container_data()
                if runtime == "missing":
                    del self.container["runtime"]
                else:
                    self.container["runtime"] = runtime
                with self.configured(), self.assertRaises(RuntimeError): self.proof()
        self.container = container_data()
        with self.configured() as command: self.proof()
        self.assertIn("HostConfig.Runtime", str(command.call_args_list[0]))

    def test_ineligible_context_or_wrong_service_id_is_rejected(self):
        for key, value in (("NERVE_TEST_CI_POSTGRES_SERVICE_ID", "short"), ("GITHUB_RUN_ID", ""),
                           ("GITHUB_RUN_ATTEMPT", "0"), ("GITHUB_JOB", "container"),
                           ("RUNNER_ENVIRONMENT", "self-hosted"), ("NERVE_TEST_LSOF_MODE", "direct")):
            with self.subTest(key=key), self.configured() as command, patch.dict(os.environ, {key: value}):
                with self.assertRaises(RuntimeError): self.proof()
                command.assert_not_called()

    def test_wrong_identity_image_startup_or_unsafe_topology_is_rejected(self):
        changes = [("id", "f" * 64), ("image", "postgres:latest"), ("running", False),
                   ("path", "/tmp/custom"), ("args", ["postgres", "-c", "anything"]),
                   ("privileged", True), ("capAdd", ["SYS_ADMIN"]), ("devices", [{}]),
                   ("deviceRequests", [{}]), ("deviceRules", ["a *:* rwm"]), ("volumesFrom", ["other"]),
                   ("binds", ["/tmp:/tmp"]), ("mountSpecs", [{}]), ("tmpfs", {"/tmp": ""}),
                   ("pidMode", "host"), ("ipcMode", "container:other"), ("networkMode", "host"),
                   ("openStdin", True), ("attachStdin", True), ("tty", True)]
        for key, value in changes:
            with self.subTest(key=key):
                self.container = container_data(); self.container[key] = value
                with self.configured(), self.assertRaises(RuntimeError): self.proof()

    def test_false_like_wrong_schema_types_are_not_safety_evidence(self):
        fields = ["privileged", "openStdin", "attachStdin", "tty", "capAdd", "devices", "deviceRequests",
                  "deviceRules", "volumesFrom", "binds", "mountSpecs", "tmpfs"]
        for key in fields:
            invalid = (0, None, "", []) if key in ("privileged", "openStdin", "attachStdin", "tty") else (0, False, "", [] if key == "tmpfs" else {})
            for bad in invalid:
                with self.subTest(key=key, bad=bad):
                    self.container = container_data(); self.container[key] = bad
                    with self.configured(), self.assertRaises(RuntimeError): self.proof()
        self.container = container_data()
        for target in (self.network, self.volume):
            for bad in (0, False, "", []):
                with self.subTest(target="options", bad=bad):
                    target["options"] = bad
                    with self.configured(), self.assertRaises(RuntimeError): self.proof()
            target["options"] = None

    def test_process_membership_and_namespace_identity_are_checked_without_command_lines(self):
        rows = b"PID\n123\n124\n"
        names = b"mnt:[100]\nnet:[101]\npid:[102]\n" * 2
        def read(path, limit):
            if str(path).endswith("/stat"):
                pid = str(path).split("/")[2]
                return (pid + " (postgres worker) S " + "0 " * 18 + "100\n").encode()
            return ("0::/system.slice/docker-" + CID + ".scope\n").encode()
        with patch("service_scope._command", return_value=rows), patch("service_scope._capture", return_value=names) as capture, \
                patch("service_scope._read_small", side_effect=read), patch("service_scope.os.readlink", return_value="host:[1]"):
            result = self.module._members(CID, 123, time.monotonic() + 30)
            self.assertEqual(set(result), {123, 124})
            argv = capture.call_args.args[1]
            self.assertEqual(argv[:5], ["/usr/bin/sudo", "-n", "--", "/usr/bin/readlink", "--"])
            self.assertEqual(len(argv), 11)
            self.assertNotIn("cmdline", str(result))
            for bad in (b"PID\n123\n123\n", b"truncated\n123\n", b"PID\n124\n"):
                with patch("service_scope._command", return_value=bad), self.assertRaises(RuntimeError):
                    self.module._members(CID, 123, time.monotonic() + 30)
            with patch("service_scope._read_small", side_effect=FileNotFoundError(2, "private")):
                with self.assertRaises(self.module.SnapshotChanged): self.module._members(CID, 123, time.monotonic() + 30)
            with patch("service_scope._read_small", side_effect=PermissionError(13, "PRIVATE")):
                with self.assertRaises(RuntimeError) as caught: self.module._members(CID, 123, time.monotonic() + 30)
                self.assertNotIsInstance(caught.exception, self.module.SnapshotChanged)
                self.assertNotIn("PRIVATE", str(caught.exception))
            with patch("service_scope._start_time", side_effect=[100, 100, 101]):
                with self.assertRaises(self.module.SnapshotChanged): self.module._members(CID, 123, time.monotonic() + 30)
            with patch("service_scope._capture", return_value=names.replace(b"mnt:[100]", b"mnt:[999]", 1)):
                with self.assertRaises(RuntimeError): self.module._members(CID, 123, time.monotonic() + 30)
            with patch("service_scope.os.readlink", side_effect=["mnt:[100]", "net:[101]", "pid:[102]"]):
                with self.assertRaises(RuntimeError): self.module._members(CID, 123, time.monotonic() + 30)

    def test_readonly_docker_command_has_fixed_socket_and_binary(self):
        with patch("service_scope._capture", return_value=b"PID\n123\n") as capture:
            self.module._command("container-top", ["top", CID, "-eo", "pid"], time.monotonic() + 30)
        self.assertEqual(capture.call_args.args[1], ["/usr/bin/docker", "--host", "unix:///var/run/docker.sock", "top", CID, "-eo", "pid"])

    def test_shared_network_volume_options_bind_and_root_overlap_are_rejected(self):
        for kind in ("network", "options", "driver", "bind", "overlap"):
            with self.subTest(kind=kind):
                self.setUp()
                if kind == "network": self.network["containers"]["f" * 64] = {}
                if kind == "options": self.volume["options"] = {"type": "none", "o": "bind", "device": "/tmp"}
                if kind == "driver": self.volume["driver"] = "remote"
                if kind == "bind": self.container["mounts"][0]["Type"] = "bind"
                if kind == "overlap": self.roots["scratch"] = self.volume["mountpoint"] + "/child"
                with self.configured(), self.assertRaises(RuntimeError): self.proof()

    def test_preexisting_resource_root_cannot_be_signed(self):
        Path(self.roots["scratch"]).mkdir()
        with self.configured(), self.assertRaises(RuntimeError): self.proof()

    def test_volume_canonicalization_does_not_trust_unprivileged_resolve(self):
        source = self.volume["mountpoint"]
        original = Path.resolve
        def resolve(path, *args, **kwargs):
            if str(path) == source:
                raise PermissionError(13, "PRIVATE")
            return original(path, *args, **kwargs)
        with self.configured(), patch("service_scope.Path.resolve", new=resolve), \
                patch("service_scope._capture", return_value=b"/resolved/docker-volume\n") as canonical:
            try:
                proof = self.proof()
            except RuntimeError:
                self.fail("Protected volume must be resolved by the fixed privileged metadata query")
            self.assertEqual(proof["service"]["volume"]["source"], "/resolved/docker-volume")
            self.assertEqual(canonical.call_args.args[1], ["/usr/bin/sudo", "-n", "--", "/usr/bin/readlink", "-e", "--", source])

    def test_failed_or_malformed_privileged_canonicalization_preserves(self):
        for output in (b"", b"relative\n", b"/one\n/two\n", b"/a/../b\n", b"/a\0b\n", b"\xff"):
            with self.subTest(output=output), self.configured(), patch("service_scope._capture", return_value=output):
                with self.assertRaises(RuntimeError): self.proof()
        for reason in ("command-failed", "timeout", "output-limit"):
            with self.subTest(reason=reason), self.configured(), \
                    patch("service_scope._capture", side_effect=self.module.fail("volume-canonical", reason, 1)):
                with self.assertRaises(RuntimeError): self.proof()

    def test_canonical_volume_overlap_rejects_both_directions(self):
        for path in (self.roots["scratch"], self.roots["scratch"] + "/child", str(self.repo)):
            with self.subTest(path=path), self.configured(), patch("service_scope._capture", return_value=(path + "\n").encode()):
                with self.assertRaises(RuntimeError): self.proof()

    def test_observation_requires_same_epoch_and_member_identity_before_and_after(self):
        with self.configured(): proof = self.proof()
        first = {"service": proof["service"], "members": {123: {"start": 1, "cgroup": "a", "namespaces": [1, 2, 3]}}}
        variants = []
        for kind in ("epoch", "start", "member", "namespace"):
            changed = copy.deepcopy(first)
            if kind == "epoch": changed["service"]["startedAt"] = "changed"
            if kind == "start": changed["members"][123]["start"] = 2
            if kind == "member": changed["members"][124] = changed["members"][123]
            if kind == "namespace": changed["members"][123]["namespaces"][0] = 9
            variants.append(changed)
        for changed in variants:
            with self.subTest(changed=changed), patch("service_scope.snapshot", side_effect=[first, changed] * 3) as snapshot:
                query = unittest.mock.Mock(return_value=b"full stream")
                with self.assertRaises(RuntimeError): self.module.observe(proof, query)
                self.assertEqual(query.call_count, 3)
                self.assertEqual(snapshot.call_count, 6)

    def test_stable_observation_returns_only_snapshot_members_and_full_stream(self):
        with self.configured(): proof = self.proof()
        value = {"service": proof["service"], "members": {123: {"start": 1}}}
        with patch("service_scope.snapshot", return_value=value):
            output, members = self.module.observe(proof, lambda timeout: b"full stream")
        self.assertEqual(output, b"full stream")
        self.assertEqual(members, {123})

    def test_confirmed_mid_snapshot_exit_retries_but_permission_failure_does_not(self):
        self.assertTrue(hasattr(self.module, "SnapshotChanged"))
        with self.configured(): proof = self.proof()
        value = {"service": proof["service"], "members": {123: {"start": 1}}}
        with patch("service_scope.snapshot", side_effect=[self.module.SnapshotChanged("proc-stat"), value, value]) as snapshot:
            query = unittest.mock.Mock(return_value=b"full stream")
            self.assertEqual(self.module.observe(proof, query)[1], {123})
            self.assertEqual(snapshot.call_count, 3)
            query.assert_called_once()
        with patch("service_scope.snapshot", side_effect=self.module.fail("proc-stat", "permission", error_number=13)) as snapshot:
            with self.assertRaises(RuntimeError): self.module.observe(proof, lambda timeout: b"unused")
            self.assertEqual(snapshot.call_count, 1)
        with patch("service_scope.snapshot", side_effect=self.module.SnapshotChanged("proc-stat")) as snapshot:
            with self.assertRaises(RuntimeError): self.module.observe(proof, lambda timeout: b"unused")
            self.assertEqual(snapshot.call_count, 3)

    def test_cross_attempt_and_restart_cannot_use_old_proof(self):
        with self.configured(): proof = self.proof()
        with self.configured() as command, patch.dict(os.environ, {"GITHUB_RUN_ATTEMPT": "2"}):
            with self.assertRaises(RuntimeError): self.module.snapshot(proof, time.monotonic() + 30)
            command.assert_not_called()
        self.container["startedAt"] = "2026-10-28T00:01:00.000000000Z"
        with self.configured(), self.assertRaises(RuntimeError): self.module.snapshot(proof, time.monotonic() + 30)

    def test_malformed_inspect_and_total_deadline_remain_bounded(self):
        for output in (b"{}", b"truncated {", b"[]", b'"PRIVATE"'):
            with self.subTest(output=output), self.configured(), patch("service_scope._command", return_value=output):
                with self.assertRaises(RuntimeError) as caught: self.proof()
                self.assertNotIn("PRIVATE", str(caught.exception))
        with self.configured(): proof = self.proof()
        value = {"service": proof["service"], "members": {123: {"start": 1}}}
        with patch("service_scope.snapshot", return_value=value), patch("service_scope.time.monotonic", side_effect=[0, 1, 31]):
            with self.assertRaises(RuntimeError): self.module.observe(proof, lambda timeout: b"full stream")

    def test_bounded_commands_stop_on_timeout_or_output_limit_without_echoing_data(self):
        for script, deadline, limit in [("import time; time.sleep(2)", time.monotonic() + .05, 1024),
                                        ("print('PRIVATE' * 10000)", time.monotonic() + 2, 1024)]:
            with self.subTest(script=script), self.assertRaises(RuntimeError) as caught:
                self.module._capture("test", [sys.executable, "-c", script], deadline, limit)
            self.assertNotIn("PRIVATE", str(caught.exception))


class OwnerScopeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="nerve-service-owner-")
        self.repo = Path(self.temp.name).resolve()
        self.store = Store(self.repo)
        self.runs = []
        self.answer = subprocess.CompletedProcess(["lsof"], 0, b"p123\nf1\ntREG\nn/elsewhere\n", b"")

    def tearDown(self):
        with patch("lifecycle.subprocess.run", return_value=self.answer), \
                patch("service_scope.observe", return_value=(self.answer, {123})):
            for run in self.runs:
                if run.released:
                    run = Run(self.store, run.directory, existing=True)
                run.finish("interrupted")
        self.temp.cleanup()

    def make_run(self):
        def register(run_id, repo, roots):
            self.assertFalse(any(Path(p).exists() or Path(p).is_symlink() for p in roots.values()))
            manifest = read_json(self.store.root / "runs" / run_id / "run.json")
            self.assertIsNone(manifest["serviceScope"])
            return {"version": 1, "runId": run_id, "repo": str(repo), "roots": roots,
                    "github": {"run": "123", "attempt": "1", "job": "e2e"}, "service": {"id": CID}}
        with patch("service_scope.register", side_effect=register):
            run = self.store.create("e2e")
        self.runs.append(run)
        return run

    @contextlib.contextmanager
    def linked_manifest(self, run):
        manifest = run.directory / "run.json"
        original = run.directory / "original-run.json"
        manifest.rename(original)
        manifest.symlink_to(original)
        try:
            yield
        finally:
            manifest.unlink()
            original.rename(manifest)

    def make_published_run(self, release=True):
        run = self.make_run()
        results = run.scratch / "tests/e2e/test-results"
        results.mkdir(parents=True)
        (results / "result.txt").write_text("owned")
        with patch("lifecycle.subprocess.run", return_value=self.answer):
            run.finish("passed", release=False)
        publish(run, "e2e")
        if release: run.release()
        return run, self.repo / "tests/e2e/test-results"

    def test_manifest_link_cannot_authorize_pruning_published_reports(self):
        run, target = self.make_published_run()
        # Make the published report the only retirement candidate; otherwise an
        # earlier empty failure/report root could stop the unsafe old prune first.
        (self.store.root / "failures" / run.id).rmdir()
        (run.directory / "reports/temporary-inventory.json").unlink()
        (run.directory / "reports").rmdir()
        with self.linked_manifest(run), patch("lifecycle.open_paths", return_value=[]) as query:
            try:
                self.store.prune(time.time() + 15 * 86400)
            except (OSError, ValueError):
                pass
            self.assertTrue((target / "result.txt").is_file(), "published report was removed before manifest rejection")
            query.assert_not_called()

    def test_manifest_link_cannot_authorize_rotation_of_published_reports(self):
        run, target = self.make_published_run()
        with self.linked_manifest(run), patch("run.open_paths", return_value=[]) as query:
            with self.assertRaises((OSError, ValueError)):
                rotate_reports(self.store, "e2e")
            self.assertEqual((target / "result.txt").read_text(), "owned")
            query.assert_not_called()

    def test_manifest_replaced_by_link_cannot_authorize_live_run_query(self):
        for scoped in (True, False):
            run = self.make_run()
            if not scoped: run.update(serviceScope=None)
            with self.subTest(scoped=scoped), self.linked_manifest(run), \
                    patch.dict(os.environ, {"NERVE_TEST_CI_POSTGRES_SERVICE_ID": CID}), \
                    patch("service_scope.observe", return_value=(self.answer, {123})) as query, \
                    patch("lifecycle.subprocess.run", return_value=self.answer) as direct_query:
                with self.assertRaises((OSError, ValueError, RuntimeError)):
                    open_paths(run.scratch, owner=run)
                self.assertTrue(run.scratch.is_dir())
                query.assert_not_called(); direct_query.assert_not_called()

    def test_nonregular_manifest_is_rejected_without_blocking_on_fifo(self):
        run = self.make_run(); run.release()
        manifest = run.directory / "run.json"
        original = run.directory / "original-run.json"
        manifest.rename(original); os.mkfifo(manifest)
        script = ("import sys,time;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from lifecycle import Store,Run\n"
                  "try:\n store=Store(sys.argv[2]);store.prune(time.time()+15*86400);Run(store,Path(sys.argv[3]),existing=True)\n"
                  "except (OSError,ValueError): sys.exit(0)\n"
                  "sys.exit(1)\n")
        try:
            result = subprocess.run([sys.executable, "-B", "-c", script, str(Path(__file__).parent),
                                     str(self.repo), str(run.directory)], capture_output=True, timeout=2)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
        finally:
            manifest.unlink(); original.rename(manifest)

    def test_manifest_parent_link_cannot_authorize_live_published_report_query(self):
        run, target = self.make_published_run(release=False)
        original = run.directory.with_name(run.id + "-original")
        for scoped in (True, False):
            if not scoped: run.update(serviceScope=None)
            run.directory.rename(original)
            run.directory.symlink_to(original, target_is_directory=True)
            try:
                with self.subTest(scoped=scoped), patch.dict(os.environ, {"NERVE_TEST_CI_POSTGRES_SERVICE_ID": CID}), \
                        patch("service_scope.observe", return_value=(self.answer, {123})) as query, \
                        patch("lifecycle.subprocess.run", return_value=self.answer) as direct_query:
                    with self.assertRaises((OSError, ValueError, RuntimeError)):
                        open_paths(target, owner=run)
                    self.assertTrue((target / "result.txt").is_file())
                    query.assert_not_called(); direct_query.assert_not_called()
            finally:
                run.directory.unlink(); original.rename(run.directory)

    def test_creation_proof_precedes_scratch_and_binds_actual_identity(self):
        run = self.make_run()
        self.assertIsNotNone(run.service_proof(run.scratch))
        moved = run.directory / "original-scratch"
        run.scratch.rename(moved); run.scratch.mkdir()
        try:
            with self.assertRaises(ValueError): run.service_proof(run.scratch)
        finally:
            run.scratch.rmdir(); moved.rename(run.scratch)

    def test_missing_previously_registered_report_root_cannot_be_recreated(self):
        run = self.make_run(); report = run.directory / "reports"
        run.scope_directory(report)
        moved = run.directory / "original-report"; report.rename(moved)
        try:
            with self.assertRaises(ValueError): run.scope_directory(report)
        finally:
            if report.exists(): report.rmdir()
            moved.rename(report)

    def test_registration_interrupt_has_no_scratch_or_child_and_releases_lease(self):
        with patch("service_scope.register", side_effect=RuntimeError("fixed-registration-error")):
            with self.assertRaises(RuntimeError): self.store.create("sample")
        directories = list((self.store.root / "runs").iterdir())
        self.assertEqual(len(directories), 1)
        run = Run(self.store, directories[0], existing=True); self.runs.append(run)
        self.assertEqual(run.data["status"], "cleanup-pending")
        self.assertIsNone(run.data["childGroup"])
        self.assertFalse(run.scratch.exists())

    def test_no_owner_legacy_run_unknown_root_or_no_service_id_stays_strict(self):
        run = self.make_run()
        answer = subprocess.CompletedProcess(["lsof"], 0, b"p123\nf9\ntsock\nnprotocol: UNIX\n", b"")
        for case in ("no-owner", "unknown-root", "no-id", "legacy"):
            saved = copy.deepcopy(run.data)
            if case == "legacy": run.update(serviceScope=None)
            root = self.repo / "unowned" if case == "unknown-root" else run.scratch
            with self.subTest(case=case), patch.dict(os.environ, {"NERVE_TEST_CI_POSTGRES_SERVICE_ID": "" if case == "no-id" else CID}), \
                    patch("lifecycle.subprocess.run", return_value=answer), patch("service_scope.observe") as observe:
                with self.assertRaises(RuntimeError): open_paths(root, owner=None if case == "no-owner" else run)
                observe.assert_not_called()
            run.data = saved; run.persist()

    def test_scope_cannot_hide_owned_file_alias_socket_or_deleted_path(self):
        run = self.make_run(); alias = run.create_short_tmp()
        paths = [str(run.scratch / "held.txt"), str(alias / "held.sock") + " type=STREAM",
                 str(alias / "deleted.txt") + " (deleted)", str(alias / "error.txt") + " (stat: No such file or directory)"]
        for name in paths:
            output = f"p123\nfmem\ntREG\nn{name}\nf9\ntsock\nnprotocol: UNIX\n".encode()
            answer = subprocess.CompletedProcess(["lsof"], 0, output, b"")
            with self.subTest(name=name), patch.dict(os.environ, {"NERVE_TEST_CI_POSTGRES_SERVICE_ID": CID}), \
                    patch("service_scope.observe", return_value=(answer, {123})):
                self.assertIn(name, open_paths(run.scratch, owner=run))

    def test_published_reports_need_creation_move_chain_and_original_lease(self):
        run = self.make_run()
        results = run.scratch / "tests/e2e/test-results"; results.mkdir(parents=True)
        (results / "result.txt").write_text("owned")
        with patch("lifecycle.subprocess.run", return_value=self.answer): run.finish("passed", release=False)
        publish(run, "e2e")
        target = self.repo / "tests/e2e/test-results"
        self.assertIsNotNone(run.service_proof(target))
        saved = run.data["scopeMoves"]; run.update(scopeMoves=[])
        self.assertIsNone(run.service_proof(target))
        run.update(scopeMoves=saved)
        run.release()
        with self.assertRaises(ValueError): run.service_proof(target)
        with patch("run.open_paths", return_value=[]) as query:
            rotate_reports(self.store, "e2e")
        queried_owner = query.call_args.kwargs["owner"]
        self.assertEqual(queried_owner.id, run.id)
        self.assertTrue(queried_owner.released)

    def test_archive_does_not_supply_an_owner_scope(self):
        import archive
        self.assertNotIn("owner=", inspect.getsource(archive.Archives.prune))


if __name__ == "__main__":
    unittest.main()
