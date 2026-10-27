"""Narrow proof for the workflow's pre-existing PostgreSQL service, never Docker GC."""
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import signal
import subprocess
import sys
import time

IMAGE = "postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873"
SERVICE_ID = "NERVE_TEST_CI_POSTGRES_SERVICE_ID"
DOCKER = ["/usr/bin/docker", "--host", "unix:///var/run/docker.sock"]
HEX_ID = re.compile(r"[0-9a-f]{64}")
MAX_SECONDS = 30
MAX_OUTPUT = 64 * 1024
MAX_PIDS = 128


class ScopeError(RuntimeError):
    def __init__(self, operation, reason, returncode=None, error_number=None):
        self.operation, self.reason, self.returncode, self.error_number = operation, reason, returncode, error_number
        super().__init__("CI 服务查询证明不完整：" + json.dumps({"operation": operation, "reason": reason,
                         "returncode": returncode, "errno": error_number}, ensure_ascii=False))


class SnapshotChanged(ScopeError):
    def __init__(self, operation):
        super().__init__(operation, "snapshot-changed")


def fail(operation, reason, returncode=None, error_number=None):
    return ScopeError(operation, reason, returncode, error_number)


def _read_small(path, limit):
    with Path(path).open("rb") as stream:
        value = stream.read(limit + 1)
    if len(value) > limit:
        raise fail("proc-read", "output-limit")
    return value


def context():
    required = {"CI": "true", "GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted",
                "RUNNER_OS": "Linux", "NERVE_TEST_LSOF_MODE": "github-ubuntu-sudo"}
    if sys.platform != "linux" or any(os.environ.get(k) != v for k, v in required.items()):
        raise fail("context", "ineligible-ci")
    try:
        release = _read_small("/etc/os-release", 4096).decode("utf-8")
    except OSError as error:
        raise fail("context", "os-unavailable", error_number=error.errno) from None
    except UnicodeError:
        raise fail("context", "invalid-os-release") from None
    if not re.search(r'^ID=(?:ubuntu|"ubuntu")$', release, re.M) or not re.search(r'^VERSION_ID=(?:24\.04|"24\.04")$', release, re.M):
        raise fail("context", "ineligible-os")
    identity = {"run": os.environ.get("GITHUB_RUN_ID", ""), "attempt": os.environ.get("GITHUB_RUN_ATTEMPT", ""),
                "job": os.environ.get("GITHUB_JOB", "")}
    if (not all(re.fullmatch(r"[1-9][0-9]{0,19}", identity[k]) for k in ("run", "attempt"))
            or identity["job"] not in ("verify", "e2e")
            or not HEX_ID.fullmatch(os.environ.get(SERVICE_ID, ""))):
        raise fail("context", "invalid-job-or-service")
    return identity


def _capture(operation, argv, deadline, limit=MAX_OUTPUT):
    """Kill our own read-only command on either byte or time bound; never echo output."""
    child = None
    buffers = {"out": bytearray(), "err": bytearray()}
    expires = min(deadline, time.monotonic() + 5)
    try:
        if expires <= time.monotonic():
            raise fail(operation, "deadline")
        child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 env={"LC_ALL": "C", "PATH": "/usr/bin:/bin"}, start_new_session=True)
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ, "out")
            selector.register(child.stderr, selectors.EVENT_READ, "err")
            while selector.get_map():
                remaining = expires - time.monotonic()
                if remaining <= 0:
                    raise fail(operation, "timeout")
                for key, _ in selector.select(remaining):
                    chunk = os.read(key.fileobj.fileno(), 4096)
                    if not chunk:
                        selector.unregister(key.fileobj)
                    else:
                        buffers[key.data].extend(chunk)
                        if sum(len(v) for v in buffers.values()) > limit:
                            raise fail(operation, "output-limit")
            code = child.wait(timeout=max(.001, expires - time.monotonic()))
        if code or buffers["err"]:
            raise fail(operation, "command-failed", code)
        return bytes(buffers["out"])
    except subprocess.TimeoutExpired:
        raise fail(operation, "timeout") from None
    except OSError as error:
        raise fail(operation, "os-error", error_number=error.errno) from None
    finally:
        if child is not None:
            if child.poll() is None:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                child.wait(timeout=1)
            child.stdout.close(); child.stderr.close()


def _command(operation, arguments, deadline):
    return _capture(operation, [*DOCKER, *arguments], deadline)


def _format(fields):
    return "{" + ",".join('"' + key + '":{{json .' + value + '}}' for key, value in fields.items()) + "}"


def _empty(value, kind):
    return value is None or (type(value) is kind and not value)


def _unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError()
        result[key] = value
    return result


CONTAINER_FIELDS = {"id": "ID", "image": "Config.Image", "imageId": "Image", "running": "State.Running",
    "startedAt": "State.StartedAt", "pid": "State.Pid", "path": "Path", "args": "Args",
    "entrypoint": "Config.Entrypoint", "cmd": "Config.Cmd", "privileged": "HostConfig.Privileged",
    "capAdd": "HostConfig.CapAdd", "devices": "HostConfig.Devices", "deviceRequests": "HostConfig.DeviceRequests",
    "deviceRules": "HostConfig.DeviceCgroupRules", "volumesFrom": "HostConfig.VolumesFrom", "binds": "HostConfig.Binds",
    "mountSpecs": "HostConfig.Mounts", "tmpfs": "HostConfig.Tmpfs", "pidMode": "HostConfig.PidMode",
    "ipcMode": "HostConfig.IpcMode", "networkMode": "HostConfig.NetworkMode", "openStdin": "Config.OpenStdin",
    "attachStdin": "Config.AttachStdin", "tty": "Config.Tty", "runtime": "HostConfig.Runtime", "mounts": "Mounts",
    "networks": "NetworkSettings.Networks", "ports": "NetworkSettings.Ports", "exposedPorts": "Config.ExposedPorts"}
NETWORK_FIELDS = {"id": "ID", "name": "Name", "driver": "Driver", "scope": "Scope", "options": "Options",
                  "containers": "Containers", "internal": "Internal"}
VOLUME_FIELDS = {"name": "Name", "driver": "Driver", "scope": "Scope", "options": "Options", "mountpoint": "Mountpoint"}


def _json_command(operation, arguments, fields, deadline):
    try:
        value = json.loads(_command(operation, [*arguments, "--format", _format(fields)], deadline), object_pairs_hook=_unique_pairs)
        if not isinstance(value, dict) or set(value) != set(fields):
            raise ValueError()
        return value
    except (ValueError, TypeError, UnicodeError):
        raise fail(operation, "invalid-output") from None


def _canonical_volume(source, deadline):
    if type(source) is not str or not source.startswith("/") or any(c in source for c in ("\0", "\n", "\r")):
        raise fail("volume-canonical", "invalid-source")
    raw = _capture("volume-canonical", ["/usr/bin/sudo", "-n", "--", "/usr/bin/readlink", "-e", "--", source], deadline)
    try:
        name = raw.decode("utf-8")
        if raw.count(b"\n") != 1 or not raw.endswith(b"\n") or any(c in name for c in ("\0", "\r")):
            raise ValueError()
        name = name[:-1]
        if not name.startswith("/") or name.startswith("//") or os.path.normpath(name) != name:
            raise ValueError()
        return Path(name)
    except (ValueError, UnicodeError):
        raise fail("volume-canonical", "invalid-output") from None


def _service(cid, roots, deadline):
    try:
        value = _json_command("container-inspect", ["inspect", "--type", "container", cid], CONTAINER_FIELDS, deadline)
        if (value["id"] != cid or value["image"] != IMAGE or not re.fullmatch(r"sha256:[0-9a-f]{64}", value["imageId"])
                or value["running"] is not True or type(value["pid"]) is not int or value["pid"] <= 0
                or not re.fullmatch(r"[0-9]{4}-[0-9T:.+-]+Z", value["startedAt"])
                or value["path"] != "docker-entrypoint.sh" or value["args"] != ["postgres"]
                or value["entrypoint"] != ["docker-entrypoint.sh"] or value["cmd"] != ["postgres"]
                or value["runtime"] != "runc"):
            raise fail("container-inspect", "identity-or-startup")
        if (any(value[k] is not False for k in ("privileged", "openStdin", "attachStdin", "tty"))
                or any(not _empty(value[k], list) for k in ("capAdd", "devices", "deviceRequests", "deviceRules",
                                                           "volumesFrom", "binds", "mountSpecs"))
                or not _empty(value["tmpfs"], dict)
                or value["pidMode"] not in ("", "private") or value["ipcMode"] != "private"):
            raise fail("container-inspect", "unsafe-topology")
        name = value["networkMode"]
        if (not re.fullmatch(r"github_network_[0-9a-f]{32}", name) or set(value["networks"]) != {name}
                or not HEX_ID.fullmatch(value["networks"][name]["NetworkID"])):
            raise fail("container-inspect", "network-topology")
        network_id = value["networks"][name]["NetworkID"]
        network = _json_command("network-inspect", ["inspect", "--type", "network", network_id], NETWORK_FIELDS, deadline)
        if (network["id"] != network_id or network["name"] != name or network["driver"] != "bridge"
                or network["scope"] != "local" or network["internal"] is not False or not _empty(network["options"], dict)
                or type(network["containers"]) is not dict or set(network["containers"]) != {cid}
                or type(network["containers"][cid]) is not dict):
            raise fail("network-inspect", "not-exclusive-job-bridge")
        ports = value["ports"]
        if (set(ports) != {"5432/tcp"} or set(value["exposedPorts"]) != {"5432/tcp"}
                or not isinstance(ports["5432/tcp"], list) or not 1 <= len(ports["5432/tcp"]) <= 2
                or any(p.get("HostPort") != "5432" or p.get("HostIp") not in ("0.0.0.0", "::") for p in ports["5432/tcp"])):
            raise fail("container-inspect", "nonstandard-port")
        if not isinstance(value["mounts"], list) or len(value["mounts"]) != 1:
            raise fail("container-inspect", "nonstandard-mount")
        mount = value["mounts"][0]
        if (mount["Type"] != "volume" or mount["Driver"] != "local" or not HEX_ID.fullmatch(mount["Name"])
                or mount["Destination"] != "/var/lib/postgresql" or mount["RW"] is not True or mount["Propagation"] != ""):
            raise fail("container-inspect", "nonstandard-mount")
        volume = _json_command("volume-inspect", ["volume", "inspect", mount["Name"]], VOLUME_FIELDS, deadline)
        if (volume["name"] != mount["Name"] or volume["driver"] != "local" or volume["scope"] != "local"
                or not _empty(volume["options"], dict) or volume["mountpoint"] != mount["Source"] or not Path(mount["Source"]).is_absolute()):
            raise fail("volume-inspect", "nonlocal-or-optioned-volume")
        # Ordinary runner users may not traverse Docker's private volume tree.
        # Only fixed readlink -e on this inspected service volume proves canonicality.
        source = _canonical_volume(mount["Source"], deadline)
        root_views = {view for root in roots.values() for view in (Path(root), Path(root).resolve())}
        if any(candidate == root or candidate in root.parents or root in candidate.parents
               for candidate in (source, Path(mount["Source"])) for root in root_views):
            raise fail("volume-inspect", "resource-overlap")
        return {"id": cid, "imageId": value["imageId"], "startedAt": value["startedAt"], "pid": value["pid"],
                "network": {"id": network_id, "name": name},
                "volume": {"name": volume["name"], "source": str(source), "reportedSource": mount["Source"]}}
    except (KeyError, TypeError, ValueError, AttributeError):
        raise fail("service-inspect", "invalid-output") from None
    except OSError as error:
        raise fail("service-inspect", "path-unavailable", error_number=error.errno) from None


def register(run_id, repo, roots):
    if not os.environ.get(SERVICE_ID):
        return None
    identity = context()
    if any(Path(p).exists() or Path(p).is_symlink() for p in roots.values()):
        raise fail("registration", "resource-already-exists")
    service = _service(os.environ[SERVICE_ID], roots, time.monotonic() + MAX_SECONDS)
    return {"version": 1, "runId": run_id, "repo": str(repo), "github": identity, "roots": roots, "service": service}


def _start_time(pid):
    try:
        text = _read_small(f"/proc/{pid}/stat", 8192).decode("utf-8")
    except FileNotFoundError:
        raise SnapshotChanged("proc-stat") from None
    end = text.rfind(") ")
    fields = text[end + 2:].split()
    if (not text.startswith(str(pid) + " (") or end < 0 or len(fields) < 20
            or not re.fullmatch(r"[A-Zt]", fields[0]) or not fields[19].isdigit()):
        raise fail("proc-stat", "invalid-output")
    return int(fields[19])


def _members(cid, init_pid, deadline):
    try:
        rows = _command("container-top", ["top", cid, "-eo", "pid"], deadline).decode("ascii").splitlines()
        if not rows or rows[0].strip() != "PID" or not 1 <= len(rows) - 1 <= MAX_PIDS:
            raise ValueError()
        pids = [int(row) for row in rows[1:] if re.fullmatch(r"\s*[1-9][0-9]{0,9}\s*", row)]
        if len(pids) != len(rows) - 1 or len(set(pids)) != len(pids) or init_pid not in pids:
            raise ValueError()
        before = {pid: _start_time(pid) for pid in pids}
        paths = [f"/proc/{pid}/ns/{kind}" for pid in pids for kind in ("mnt", "net", "pid")]
        try:
            names = _capture("proc-namespaces", ["/usr/bin/sudo", "-n", "--", "/usr/bin/readlink", "--", *paths], deadline).decode("ascii").splitlines()
        except ScopeError as error:
            if error.reason == "command-failed" and error.returncode == 1:
                # Confirm disappearance/reuse from structured proc reads; never inspect stderr text.
                if any(_start_time(pid) != before[pid] for pid in pids):
                    raise SnapshotChanged("proc-stat") from None
            raise
        if len(names) != len(paths):
            raise ValueError()
        host = [os.readlink(f"/proc/self/ns/{kind}") for kind in ("mnt", "net", "pid")]
        result = {}
        for i, pid in enumerate(pids):
            if time.monotonic() >= deadline:
                raise fail("service-members", "deadline")
            namespace = names[i * 3:i * 3 + 3]
            if any(not re.fullmatch(kind + r":\[[0-9]+\]", name) or name == own
                   for kind, name, own in zip(("mnt", "net", "pid"), namespace, host)):
                raise ValueError()
            try:
                cgroup = _read_small(f"/proc/{pid}/cgroup", 8192)
            except FileNotFoundError:
                raise SnapshotChanged("proc-cgroup") from None
            paths = [line.split(":", 2)[2] for line in cgroup.decode("ascii").splitlines()]
            if not paths or any(not any(part in (cid, "docker-" + cid + ".scope") for part in path.split("/")) for path in paths):
                raise ValueError()
            after = _start_time(pid)
            if before[pid] != after:
                raise SnapshotChanged("proc-stat")
            result[pid] = {"start": after, "cgroup": hashlib.sha256(cgroup).hexdigest(), "namespaces": namespace}
        if any(v["namespaces"] != result[init_pid]["namespaces"] for v in result.values()):
            raise ValueError()
        return result
    except (ValueError, KeyError, IndexError, UnicodeError):
        raise fail("service-members", "invalid-or-shared-identity") from None
    except OSError as error:
        raise fail("service-members", "proc-unavailable", error_number=error.errno) from None


def snapshot(proof, deadline):
    if proof["github"] != context() or proof["service"]["id"] != os.environ[SERVICE_ID]:
        raise fail("snapshot", "different-ci-owner")
    current = _service(proof["service"]["id"], proof["roots"], deadline)
    if current != proof["service"]:
        raise fail("snapshot", "service-epoch-changed")
    return {"service": current, "members": _members(current["id"], current["pid"], deadline)}


def observe(proof, query):
    deadline = time.monotonic() + MAX_SECONDS
    for _ in range(3):
        try:
            before = snapshot(proof, deadline)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise fail("observation", "deadline")
            output = query(remaining)
            after = snapshot(proof, deadline)
            if time.monotonic() >= deadline:
                raise fail("observation", "deadline")
            if before == after:
                return output, set(before["members"])
        except SnapshotChanged:
            if time.monotonic() >= deadline:
                raise fail("observation", "deadline") from None
    raise fail("observation", "service-members-changed")
