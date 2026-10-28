"""Read-only identity and budget checks for an explicitly selected hosted VM.

The runner environment is an execution contract, not cryptographic attestation.
No function here deletes a resource or claims that the host has been disposed.
The caller still owns the lease, resource inode checks and producer shutdown.
"""
import copy
import errno
import os
from pathlib import Path
import re
import shlex
import shutil
import stat
import sys
import uuid


POLICY = "github-hosted-vm"
RAW_LIMIT = 16 * 1024 ** 3
DISK_RESERVE = 12 * 1024 ** 3
CONTEXT_KEYS = {"version", "policy", "repo", "repository", "sha", "runId", "attempt",
                "job", "runner", "bootId"}
SCOPE_KEYS = {"version", "policy", "context", "runId", "roots"}
ROOT_KEYS = {"scratch", "short", "reports", "failures"}
JOBS = {"verify", "e2e", "container"}
SCAN_ATTEMPTS = 3


def _text(value, limit=512):
    return (type(value) is str and 0 < len(value) <= limit
            and all(ord(character) >= 32 and ord(character) != 127 for character in value))


def _uuid(value):
    if type(value) is not str:
        return False
    try:
        parsed = uuid.UUID(value)
        return str(parsed) == value and parsed.version == 4
    except ValueError:
        return False


def _directory(path, *, required=False, with_identity=False):
    """Require an absolute canonical directory path, allowing uncreated tails."""
    if not isinstance(path, (str, Path)) or not _text(str(path), 4096):
        raise ValueError("托管资源路径无效")
    name = str(path)
    value = Path(name)
    if not value.is_absolute() or name.startswith("//") or os.path.normpath(name) != name:
        raise ValueError("托管资源路径必须规范且绝对")
    leaf_info = None
    try:
        for candidate in [*reversed(value.parents), value]:
            try:
                info = candidate.lstat()
            except FileNotFoundError:
                if required:
                    raise ValueError("托管工作目录不存在") from None
                break
            if not stat.S_ISDIR(info.st_mode):
                raise ValueError("托管资源路径含链接或非目录")
            if candidate == value:
                leaf_info = info
    except OSError as error:
        raise ValueError("托管资源路径无法核验：errno=" + str(error.errno)) from None
    return (value, leaf_info) if with_identity else value


def _metadata(path, limit):
    try:
        with Path(path).open("rb") as stream:
            data = stream.read(limit + 1)
        if len(data) > limit:
            raise ValueError("托管系统元数据超限")
        return data.decode("utf-8")
    except (OSError, UnicodeError):
        raise ValueError("托管系统元数据不可用") from None


def _validate_context(value):
    if (type(value) is not dict or set(value) != CONTEXT_KEYS
            or type(value.get("version")) is not int or value["version"] != 1
            or value.get("policy") != POLICY):
        raise ValueError("托管上下文格式无效")
    if (not _text(value["repository"], 201)
            or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", value["repository"])
            or not _text(value["sha"], 40) or not re.fullmatch(r"[0-9a-f]{40}", value["sha"])
            or not _text(value["runId"], 20) or not re.fullmatch(r"[1-9][0-9]*", value["runId"])
            or not _text(value["attempt"], 10) or not re.fullmatch(r"[1-9][0-9]*", value["attempt"])
            or not _text(value["job"], 32) or value["job"] not in JOBS
            or not _text(value["runner"], 128) or not _uuid(value["bootId"])
            or type(value["repo"]) is not str):
        raise ValueError("托管上下文身份无效")
    _directory(value["repo"], required=True)


def context(repo):
    """Return the fixed CI identity, or None for the default strict policy."""
    mode = os.environ.get("NERVE_TEST_RESOURCE_POLICY", "strict")
    if mode == "strict":
        return None
    if mode != POLICY:
        raise ValueError("未知测试资源策略")
    required = {"CI": "true", "GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted",
                "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64", "ImageOS": "ubuntu24"}
    if sys.platform != "linux" or any(os.environ.get(key) != value for key, value in required.items()):
        raise ValueError("托管策略只适用于固定 GitHub Ubuntu 24.04 VM")
    release = {}
    for line in _metadata("/etc/os-release", 4096).splitlines():
        if not line or line.startswith("#"):
            continue
        key, separator, raw = line.partition("=")
        if not separator or key in release or not re.fullmatch(r"[A-Z0-9_]+", key):
            raise ValueError("托管系统版本格式无效")
        try:
            words = shlex.split(raw)
        except ValueError:
            raise ValueError("托管系统版本格式无效") from None
        if len(words) != 1:
            raise ValueError("托管系统版本格式无效")
        release[key] = words[0]
    if release.get("ID") != "ubuntu" or release.get("VERSION_ID") != "24.04":
        raise ValueError("托管系统版本不匹配")
    repository = os.environ.get("GITHUB_REPOSITORY", "")
    root = _directory(repo, required=True)
    workspace = _directory(os.environ.get("GITHUB_WORKSPACE", ""), required=True)
    if (root != workspace or os.environ.get("GITHUB_WORKFLOW_REF")
            != repository + "/.github/workflows/ci.yml@refs/heads/main"):
        raise ValueError("托管工作目录或工作流不匹配")
    value = {"version": 1, "policy": POLICY, "repo": str(root), "repository": repository,
             "sha": os.environ.get("GITHUB_SHA", ""), "runId": os.environ.get("GITHUB_RUN_ID", ""),
             "attempt": os.environ.get("GITHUB_RUN_ATTEMPT", ""), "job": os.environ.get("GITHUB_JOB", ""),
             "runner": os.environ.get("RUNNER_NAME", ""),
             "bootId": _metadata("/proc/sys/kernel/random/boot_id", 128).rstrip("\n")}
    _validate_context(value)
    return value


def _roots(identity, run_id, roots):
    _validate_context(identity)
    if not _uuid(run_id) or type(roots) is not dict or set(roots) != ROOT_KEYS:
        raise ValueError("托管资源登记格式无效")
    repo = Path(identity["repo"])
    run = repo / ".test-resources/runs" / run_id
    expected = {"scratch": str(run / "scratch"),
                "short": str(Path("/tmp").resolve() / ("nerve-t-" + run_id)),
                "reports": str(run / "reports"),
                "failures": str(repo / ".test-resources/failures" / run_id)}
    if roots != expected or any(type(value) is not str for value in roots.values()):
        raise ValueError("托管资源根不属于本轮")
    for value in roots.values():
        _directory(value)


def register(identity, run_id, roots):
    """Bind only the not-yet-created roots; never adopt an existing environment."""
    _roots(identity, run_id, roots)
    if any(Path(value).exists() for value in roots.values()):
        raise ValueError("托管资源必须先登记再创建")
    return {"version": 1, "policy": POLICY, "context": copy.deepcopy(identity),
            "runId": run_id, "roots": copy.deepcopy(roots)}


def validate(proof, identity, run_id, roots):
    """Validate a previously bound proof against the caller's fresh identity."""
    _roots(identity, run_id, roots)
    if (type(proof) is not dict or set(proof) != SCOPE_KEYS
            or type(proof.get("version")) is not int or proof["version"] != 1
            or proof.get("policy") != POLICY or proof.get("runId") != run_id):
        raise ValueError("托管资源证明格式无效")
    _validate_context(proof["context"])
    if proof["context"] != identity or proof["roots"] != roots:
        raise ValueError("托管资源证明与本轮身份不匹配")


class _Changed(Exception):
    def __init__(self, operation, error_number=None):
        self.operation, self.errno = operation, error_number
        super().__init__(operation)


def _identity(info):
    return info.st_dev, info.st_ino


def _open_root(path, flags):
    """Open every ancestor without following links, including the initial root."""
    descriptor = os.open(path.anchor, flags)
    try:
        for component in path.parts[1:]:
            child = os.open(component, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _measure_once(roots, limit_bytes):
    seen = set()
    total = {"bytes": 0, "files": 0}

    def missing_child(name, parent):
        # Confirm only this name through the still-open parent. A recreated
        # name or any other lookup error is not evidence of disappearance.
        try:
            os.stat(name, dir_fd=parent, follow_symlinks=False)
        except OSError as error:
            if error.errno == errno.ENOENT:
                return True
            raise
        return False

    def walk(name, expected, parent=None):
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
        descriptor = -1
        operation = "root-open" if parent is None else "child-open"
        try:
            try:
                descriptor = (_open_root(Path(name), flags) if parent is None
                              else os.open(name, flags, dir_fd=parent))
            except OSError as error:
                if parent is not None and error.errno == errno.ENOENT:
                    operation = "child-confirm"
                    if missing_child(name, parent):
                        return
                raise _Changed("root-open" if parent is None else "child-open", error.errno) from None
            operation = "root-fstat" if parent is None else "child-fstat"
            opened = os.fstat(descriptor)
            if _identity(opened) != _identity(expected):
                raise _Changed("root-identity" if parent is None else "child-identity")
            key = _identity(opened)
            if key in seen:
                return
            seen.add(key)
            operation = "root-scandir" if parent is None else "child-scandir"
            with os.scandir(descriptor) as entries:
                while True:
                    operation = "root-scandir" if parent is None else "child-scandir"
                    try:
                        entry = next(entries)
                    except StopIteration:
                        break
                    operation = "entry-stat"
                    try:
                        info = entry.stat(follow_symlinks=False)
                    except OSError as error:
                        if error.errno == errno.ENOENT:
                            operation = "entry-confirm"
                            if missing_child(entry.name, descriptor):
                                continue
                        raise _Changed("entry-stat", error.errno) from None
                    if stat.S_ISDIR(info.st_mode):
                        walk(entry.name, info, descriptor)
                    elif stat.S_ISREG(info.st_mode) and _identity(info) not in seen:
                        seen.add(_identity(info))
                        total["bytes"] += info.st_size
                        total["files"] += 1
                        if total["bytes"] > limit_bytes:
                            raise RuntimeError("同 job 受管原始资源已超过容量阈值")
                    # Links and special files have no regular-file payload to count.
                    # The separate free-space reserve covers other disk consumers.
            if parent is None:
                operation = "root-recheck"
                current = _open_root(Path(name), flags)
                try:
                    after = os.fstat(current)
                finally:
                    os.close(current)
            else:
                operation = "child-recheck"
                try:
                    after = os.stat(name, dir_fd=parent, follow_symlinks=False)
                except OSError as error:
                    if error.errno == errno.ENOENT:
                        # Bytes already counted through this opened directory
                        # stay in the sample; only its vanished name is retired.
                        return
                    raise
            if not stat.S_ISDIR(after.st_mode) or _identity(after) != _identity(opened):
                raise _Changed("root-identity" if parent is None else "child-identity")
        except OSError as error:
            raise _Changed(operation, error.errno) from None
        finally:
            if descriptor >= 0:
                os.close(descriptor)

    for root, info in roots:
        if info is None:
            continue
        walk(root, info)
    return total


def measure(roots, limit_bytes=RAW_LIMIT):
    """Sample apparent regular-file bytes, with bounded retries for name races.

    Files may grow after sampling. This threshold is not a filesystem quota.
    Directory descriptors prevent a swapped child link from being traversed.
    Confirmed child disappearance retires only that name, not the stable siblings
    or bytes already observed. Root identities stay fixed across this sample's
    retries; an existing root cannot become an absent or replacement root.
    """
    if type(limit_bytes) is not int or limit_bytes < 0:
        raise ValueError("资源容量阈值无效")
    captured = {}
    for root in roots:
        # Use the same stat that validated the path. A second lookup would
        # reopen a gap in which a present/absent root could be reinterpreted.
        path, info = _directory(root, with_identity=True)
        if path not in captured:
            captured[path] = info
    for attempt in range(SCAN_ATTEMPTS):
        try:
            return _measure_once(captured.items(), limit_bytes)
        except _Changed as error:
            details = "operation=" + error.operation + ",errno=" + str(error.errno) + ",attempts=" + str(attempt + 1)
            if error.errno != errno.ENOENT:
                raise RuntimeError("资源计量失败：" + details) from None
            if attempt + 1 == SCAN_ATTEMPTS:
                raise RuntimeError("资源目录持续变化，无法完成有界计量：" + details) from None


def check_budget(repo, roots, limit_bytes=RAW_LIMIT, reserve_bytes=DISK_RESERVE):
    """Require both the job's sampled raw budget and the independent disk reserve."""
    if type(reserve_bytes) is not int or reserve_bytes < 0:
        raise ValueError("磁盘余量阈值无效")
    root = _directory(repo, required=True)
    value = measure(roots, limit_bytes=limit_bytes)
    try:
        free = shutil.disk_usage(root).free
    except OSError as error:
        raise RuntimeError("磁盘余量无法核验：errno=" + str(error.errno)) from None
    if free < reserve_bytes:
        raise RuntimeError("磁盘可用空间低于保留阈值")
    return dict(value, freeBytes=free, limitBytes=limit_bytes, reserveBytes=reserve_bytes)
