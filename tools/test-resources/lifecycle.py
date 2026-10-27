"""Owned test resources. Never discover ownership from a filename or an age alone."""
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import tempfile
import uuid

VERSION = 1
MIB = 1024 ** 2
GIB = 1024 ** 3
FAILURE_DAYS = 7
REPORT_DAYS = 14
RUN_ID = re.compile(r"^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$")


def atomic_bytes(path, data):
    path = Path(path)
    if path.parent.resolve() != path.parent.absolute() or path.is_symlink():
        raise ValueError("回执或诊断路径不得经过链接")
    fd, name = tempfile.mkstemp(prefix="." + path.name + "-", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
        if path.is_symlink():
            raise ValueError("回执目的已变成链接")
        temporary.replace(path)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if temporary.exists():
            temporary.unlink()


def atomic_json(path, value):
    atomic_bytes(path, (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode())


def read_json(path):
    return json.loads(path.read_text())


def contained(path, root):
    path = Path(path).absolute()
    root = Path(root).resolve()
    if path == root or not path.is_relative_to(root):
        raise ValueError("拒绝管理根以外的路径")
    parent = path.parent
    while parent != root:
        if parent.is_symlink():
            raise ValueError("拒绝符号链接父目录")
        parent = parent.parent
    return path


def remove(path, root):
    path = contained(path, root)
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.exists():
        shutil.rmtree(path)


def byte_size(path):
    if path.is_symlink():
        return 0
    if path.is_file():
        return path.stat().st_size
    total = 0
    for directory, dirs, files in os.walk(path, followlinks=False):
        dirs[:] = [d for d in dirs if not (Path(directory) / d).is_symlink()]
        total += sum((Path(directory) / f).stat().st_size for f in files
                     if not (Path(directory) / f).is_symlink())
    return total


@contextlib.contextmanager
def locked(path, blocking=True):
    if path.is_symlink():
        raise ValueError("拒绝符号链接锁")
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        yield fd
    finally:
        os.close(fd)


def group_alive(group):
    if not group:
        return False
    try:
        os.killpg(group, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def open_paths(root):
    executable = shutil.which("lsof") or "/usr/sbin/lsof"
    result = subprocess.run([executable, "-nP", "-F", "n"], capture_output=True,
                            text=True, timeout=30)
    if result.returncode not in (0, 1) or result.stderr:
        raise RuntimeError("无法完整核对打开文件；保留资源")
    prefix = str(root.resolve()) + "/"
    return sorted({line[1:] for line in result.stdout.splitlines()
                   if line.startswith("n") and
                   (line[1:] == str(root.resolve()) or line[1:].startswith(prefix))})


def check_opfs(profile):
    archive = profile / "opfs-archive"
    if not archive.exists():
        return
    if archive.is_symlink():
        raise ValueError("OPFS 归档不能是链接")
    manifest = read_json(archive / "manifest.json")
    cleanup = read_json(archive / "cleanup.json")
    if cleanup.get("removed") is not True or cleanup.get("namespace") != manifest.get("namespace"):
        raise ValueError("OPFS 清理证明缺失；保留原资料")
    for entry in manifest["files"]:
        parts = entry["path"]
        if not parts or any(not p or p in (".", "..") or "/" in p or "\\" in p for p in parts):
            raise ValueError("OPFS 文件路径无效")
        path = contained(archive.joinpath("files", *parts), archive)
        if path.is_symlink() or not path.is_file() or path.stat().st_size != entry["bytes"]:
            raise ValueError("OPFS 字节证据缺失")
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(MIB), b""):
                digest.update(block)
        if digest.hexdigest() != entry["sha256"]:
            raise ValueError("OPFS 摘要不符")


def failed_profile_names(results):
    if not results.is_file():
        return None
    report = read_json(results)
    failed, uncertain = set(), False
    def visit(suite):
        nonlocal uncertain
        for spec in suite.get("specs", []):
            for test in spec.get("tests", []):
                attempts = test.get("results", [])
                for attempt in attempts:
                    if attempt.get("status") in ("passed", "skipped"):
                        continue
                    annotations = attempt.get("annotations")
                    if annotations is None:
                        if len(attempts) != 1:
                            uncertain = True
                            continue
                        annotations = test.get("annotations", [])
                    for annotation in annotations:
                        if annotation.get("type") == "persistent-profile":
                            failed.add(Path(annotation["description"]).name)
        for nested in suite.get("suites", []):
            visit(nested)
    for suite in report.get("suites", []):
        visit(suite)
    return None if uncertain else failed


def export_diagnostics(profile, target, destination, remaining):
    """Portable small diagnostics; full raw profiles remain local, bounded and expiring."""
    contained(destination, profile.parent.parent)
    if destination.is_symlink():
        raise ValueError("诊断目录不得是链接")
    destination.mkdir(parents=True, exist_ok=True)
    owner = destination / "diagnostic-owner.json"
    expected = {"runId": read_json(profile / "resource-owner.json")["runId"], "profile": profile.name}
    if owner.exists():
        if owner.is_symlink() or read_json(owner) != expected:
            raise ValueError("诊断目录归属不符")
    elif any(destination.iterdir()):
        raise ValueError("拒绝覆盖已有未知诊断目录")
    else:
        atomic_json(owner, expected)
    entries, omitted, total = [], 0, 0
    # 16 MiB/case, 4 MiB/file, 64 MiB/run. Never follow browser lock/socket links.
    cap = min(16 * MIB, remaining)
    seen = set()
    for root in (profile, target):
        if not root.exists():
            continue
        for directory, dirs, files in os.walk(root, followlinks=False):
            dirs[:] = sorted(d for d in dirs if not (Path(directory) / d).is_symlink()
                             and d not in ("opfs-archive", "Cache", "Code Cache", "GPUCache"))
            for name in sorted(files):
                source = Path(directory) / name
                relative = source.relative_to(root)
                if str(relative) in seen or source.is_symlink():
                    continue
                seen.add(str(relative))
                if source.suffix.lower() not in (".log", ".json", ".txt", ".ips", ".dmp"):
                    continue
                size = source.stat().st_size
                if size > 4 * MIB or total + size > cap or len(entries) >= 1000:
                    omitted += 1
                    continue
                output = contained(destination / relative, destination)
                if output.is_symlink():
                    raise ValueError("诊断文件不得是链接")
                output.parent.mkdir(parents=True, exist_ok=True)
                atomic_bytes(output, source.read_bytes())
                entries.append({"path": str(relative), "bytes": size,
                                "sha256": hashlib.sha256(output.read_bytes()).hexdigest()})
                total += size
    atomic_json(destination / "diagnostic-manifest.json", {
        "profile": profile.name, "files": entries, "bytes": total, "omitted": omitted,
        "policy": "4 MiB/file; 16 MiB/case; 64 MiB/run; logs/config/crash reports only",
        "fullRawProfile": "local .test-resources/failures only, max 7 days; 256 MiB/run; 2 GiB total",
    })
    return total


def compact_profiles(profiles, run_id, failure_root, failed, limit):
    """Keep OPFS proof; journal each raw transfer before moving its first byte."""
    result = {"retainedProfileBytes": 0, "diagnosticBytes": 0,
              "profileOmissions": [], "compactedProfiles": 0}
    if not profiles.exists():
        return result
    if profiles.is_symlink() or failure_root.is_symlink():
        raise ValueError("资料根是链接")
    entries = sorted(profiles.iterdir())
    for path in entries:
        if path.is_symlink() or not path.is_dir():
            raise ValueError("未知资料节点，保留")
        marker = path / "resource-owner.json"
        if marker.is_symlink() or not marker.is_file():
            raise ValueError("资料没有本轮归属记录")
        value = read_json(marker)
        if value != {"version": VERSION, "runId": run_id, "kind": "browser-profile"}:
            raise ValueError("资料归属不符")
        check_opfs(path)
    protected = {"opfs-archive", "resource-owner.json", "retention.json", "raw-transfer.json"}
    for profile in entries:
        target = contained(failure_root / profile.name, failure_root.parent)
        if target.is_symlink():
            raise ValueError("失败资料归档不能是链接")
        journal = profile / "raw-transfer.json"
        if journal.exists():
            if journal.is_symlink():
                raise ValueError("转移记录不能是链接")
            transfer = read_json(journal)
            if transfer.get("runId") != run_id or transfer.get("profile") != profile.name:
                raise ValueError("转移记录归属不符")
        else:
            if target.exists():
                raise ValueError("拒绝接管没有转移记录的失败资料")
            disposable = sorted(p for p in profile.iterdir() if p.name not in protected)
            inventory = [{"name": p.name, "bytes": byte_size(p), "symlink": p.is_symlink()}
                         for p in disposable]
            size = sum(entry["bytes"] for entry in inventory)
            retain = failed is None or profile.name in failed
            selected = retain and size > 0 and size + byte_size(failure_root) + 256 <= limit
            transfer = {"version": VERSION, "runId": run_id, "profile": profile.name,
                        "retain": retain, "selected": selected, "inventory": inventory}
            atomic_json(journal, transfer)
        selected = transfer["selected"]
        inventory = transfer["inventory"]
        if selected:
            target.mkdir(parents=True, exist_ok=True)
            marker = target / "resource-owner.json"
            expected = {"version": VERSION, "runId": run_id, "profile": profile.name}
            if marker.exists():
                if marker.is_symlink() or read_json(marker) != expected:
                    raise ValueError("失败资料转移目标归属不符")
            elif any(target.iterdir()):
                raise ValueError("拒绝接管非空转移目标")
            else:
                atomic_json(marker, expected)
        if transfer["retain"]:
            result["diagnosticBytes"] += export_diagnostics(
                profile, target, profiles.parent / "failure-diagnostics" / profile.name,
                max(0, 64 * MIB - result["diagnosticBytes"]))
        for entry in inventory:
            name = entry["name"]
            if Path(name).name != name or name in protected or name in (".", ".."):
                raise ValueError("转移条目不得越界")
            source, moved = profile / name, target / name
            if selected:
                if source.exists() or source.is_symlink():
                    if moved.exists() or moved.is_symlink():
                        raise ValueError("资料转移存在冲突；保留")
                    source.rename(moved)
                elif not (moved.exists() or moved.is_symlink()):
                    raise ValueError("转移资料缺失；保留")
            else:
                remove(source, profiles)
        size = sum(entry["bytes"] for entry in inventory)
        if transfer["retain"] and size and not selected:
            result["profileOmissions"].append({"profile": profile.name, "bytes": size, "reason": "per-run-cap"})
        atomic_json(profile / "retention.json", {
            "version": VERSION, "runId": run_id, "at": time.time(),
            "rawRetained": selected, "rawExpiresAfterDays": FAILURE_DAYS if selected else None,
            "inventory": inventory, "opfsEvidencePreserved": (profile / "opfs-archive").exists(),
        })
        result["compactedProfiles"] += 1
    result["retainedProfileBytes"] = byte_size(failure_root)
    return result


class Store:
    def __init__(self, repo, failure_bytes=2 * GIB, failure_run_bytes=256 * MIB, report_bytes=5 * GIB):
        self.repo = Path(repo).resolve()
        self.root = self.repo / ".test-resources"
        self.failure_bytes = failure_bytes
        self.failure_run_bytes = failure_run_bytes
        self.report_bytes = report_bytes
        if self.root.is_symlink():
            raise ValueError("管理根不能是链接")
        self.root.mkdir(mode=0o700, exist_ok=True)
        with locked(self.root / "init.lock"):
            marker = self.root / "owner.json"
            expected = {"version": VERSION, "purpose": "nerve-office-test-resources", "repo": str(self.repo)}
            if marker.exists():
                if marker.is_symlink() or read_json(marker) != expected:
                    raise ValueError("管理根归属不符")
            else:
                if set(p.name for p in self.root.iterdir()) - {"init.lock"}:
                    raise ValueError("不认领已有未知目录")
                atomic_json(marker, expected)
            for name in ("runs", "failures"):
                path = self.root / name
                if path.is_symlink():
                    raise ValueError("管理子目录不能是链接")
                path.mkdir(mode=0o700, exist_ok=True)

    def create(self, kind):
        if not re.fullmatch("[a-z0-9-]+", kind):
            raise ValueError("运行类型无效")
        identity = str(uuid.uuid4())
        directory = self.root / "runs" / identity
        directory.mkdir(mode=0o700)
        run = Run(self, directory)
        # Manifest is durable before the scratch directory or any child exists.
        run.data = {"version": VERSION, "runId": identity, "repo": str(self.repo),
                    "kind": kind, "ownerPid": os.getpid(), "childGroup": None,
                    "startedAt": time.time(), "status": "prepared"}
        run.persist()
        run.scratch.mkdir(mode=0o700)
        return run

    def sweep(self, now=None):
        now = time.time() if now is None else now
        report = {"active": [], "recovered": [], "unknown": [], "pruned": []}
        for directory in sorted((self.root / "runs").iterdir()):
            if directory.is_symlink() or not directory.is_dir() or not RUN_ID.fullmatch(directory.name):
                report["unknown"].append(directory.name)
                continue
            try:
                run = Run(self, directory, existing=True)
            except BlockingIOError:
                report["active"].append(directory.name)
                continue
            except (ValueError, OSError, KeyError, json.JSONDecodeError):
                report["unknown"].append(directory.name)
                continue
            try:
                if run.scratch.exists() or run.data.get("cleanupStage") == "reports-collected" or run.data.get("status") == "prepared":
                    if group_alive(run.data.get("childGroup")):
                        report["active"].append(run.id)
                    else:
                        value = run.finish("interrupted")
                        report["recovered" if value["status"] != "cleanup-pending" else "active"].append(run.id)
            finally:
                run.release()
        with locked(self.root / "gc.lock"):
            report["pruned"] = self.prune(now)
        return report

    def prune(self, now):
        removed = []
        for category, ttl, cap in (("failures", FAILURE_DAYS, self.failure_bytes),
                                   ("reports", REPORT_DAYS, self.report_bytes)):
            candidates = []
            for directory in (self.root / "runs").iterdir():
                if directory.is_symlink() or not RUN_ID.fullmatch(directory.name):
                    continue
                try:
                    value = read_json(directory / "run.json")
                    if value["runId"] != directory.name or value["repo"] != str(self.repo):
                        continue
                except (OSError, ValueError, KeyError):
                    continue
                paths = [(self.root / "failures" / directory.name, False)] if category == "failures" else [(directory / "reports", False)]
                if category == "reports":
                    for name in value.get("published", []):
                        allowed = {base + "/" + leaf for base in ("tests/e2e", "tests/e2e/measure", "tests/e2e/safari-results")
                                   for leaf in ("test-results", "playwright-report")}
                        if name not in allowed:
                            continue
                        try:
                            published = contained(self.repo / name, self.repo)
                            marker = published / "resource-run.json"
                            if published.is_symlink() or marker.is_symlink() or read_json(marker).get("runId") != directory.name:
                                continue
                            paths.append((published, True))
                        except (OSError, ValueError):
                            continue
                for path, published in paths:
                    if path.exists() and not path.is_symlink():
                        candidates.append((value.get("endedAt", value["startedAt"]), directory, path, byte_size(path), published))
            total = sum(item[3] for item in candidates)
            for ended, directory, path, size, published in sorted(candidates):
                if now - ended <= ttl * 86400 and total <= cap:
                    continue
                try:
                    with contextlib.ExitStack() as locks:
                        locks.enter_context(locked(directory / "run.lock", blocking=False))
                        if published:
                            locks.enter_context(locked(self.root / "publication.lock", blocking=False))
                        value = read_json(directory / "run.json")
                        if value.get("status") not in ("passed", "failed", "interrupted") or group_alive(value.get("childGroup")) or open_paths(path):
                            continue
                        remove(path, self.repo if published else self.root)
                        if published:
                            value["published"].remove(str(path.relative_to(self.repo)))
                        event = {"category": category, "runId": directory.name, "bytes": size,
                                 "reason": "expired" if now - ended > ttl * 86400 else "total-cap", "at": now}
                        value.setdefault("retired", []).append(event)
                        atomic_json(directory / "run.json", value)
                        removed.append(event); total -= size
                except BlockingIOError:
                    continue
        return removed


class Run:
    def __init__(self, store, directory, existing=False):
        self.store, self.directory, self.id = store, directory, directory.name
        self.scratch = directory / "scratch"
        self.lock = locked(directory / "run.lock", blocking=False)
        self.lock.__enter__()
        self.released = False
        self.data = {}
        if existing:
            try:
                self.data = read_json(directory / "run.json")
                if self.data["version"] != VERSION or self.data["runId"] != self.id or self.data["repo"] != str(store.repo):
                    raise ValueError("运行归属不符")
                if self.scratch.is_symlink():
                    raise ValueError("scratch 不能是链接")
            except BaseException:
                self.release()
                raise

    def persist(self):
        atomic_json(self.directory / "run.json", self.data)

    def update(self, **values):
        self.data.update(values); self.persist()

    def release(self):
        if not self.released:
            self.lock.__exit__(None, None, None)
            self.released = True

    def create_short_root(self):
        root = Path("/tmp").resolve() / ("nerve-vm-" + self.id)
        # Precise ownership is durable before creation; an existing directory is never adopted.
        self.update(shortRoot=str(root))
        root.mkdir(mode=0o700)
        atomic_json(root / "owner.json", {"runId": self.id, "repo": str(self.store.repo), "kind": "vm-short-path"})
        return root

    def retire_short_root(self):
        if not self.data.get("shortRoot"):
            return
        expected = Path("/tmp").resolve() / ("nerve-vm-" + self.id)
        if self.data["shortRoot"] != str(expected) or expected.is_symlink():
            raise ValueError("VM 短路径归属不符")
        if not expected.exists():
            return
        marker = expected / "owner.json"
        if marker.is_symlink() or read_json(marker) != {"runId": self.id, "repo": str(self.store.repo), "kind": "vm-short-path"}:
            raise ValueError("VM 短路径没有完整创建证明，保留")
        if group_alive(self.data.get("childGroup")) or open_paths(expected):
            raise RuntimeError("VM 短路径仍有使用者，保留")
        remove(expected, expected.parent)

    def finish(self, status, release=True):
        if status not in ("passed", "failed", "interrupted"):
            raise ValueError("终态无效")
        if not self.scratch.exists():
            if self.data.get("cleanupStage") == "reports-collected":
                self.retire_short_root()
                self.update(status=self.data["requestedStatus"], endedAt=time.time(), cleanupStage="complete")
            elif self.data.get("status") == "prepared":
                self.retire_short_root()
                self.update(status="interrupted", endedAt=time.time(), cleanupStage="never-started")
            if release:
                self.release()
            return self.data
        try:
            contained(self.scratch, self.store.root)
            if self.scratch.is_symlink():
                raise ValueError("scratch 不能是链接")
            if group_alive(self.data.get("childGroup")) or open_paths(self.scratch):
                raise RuntimeError("资源仍有活动进程或打开句柄")
            if self.data.get("cleanupStage") == "reports-collected":
                self.retire_short_root()
                remove(self.scratch, self.store.root)
                self.update(status=self.data["requestedStatus"], endedAt=time.time(), cleanupStage="complete")
                return self.data
            with locked(self.store.root / "gc.lock"):
                results = contained(self.scratch / "tests/e2e/test-results", self.scratch)
                html = contained(self.scratch / "tests/e2e/playwright-report", self.scratch)
                if results.is_symlink() or html.is_symlink():
                    raise ValueError("报告路径不能是链接")
                failed = set() if status == "passed" else failed_profile_names(results / "results.json")
                compact = compact_profiles(results / "persistent-profiles", self.id,
                                           self.store.root / "failures" / self.id,
                                           failed, self.store.failure_run_bytes)
                self.update(**compact)
                report = contained(self.directory / "reports", self.store.root)
                if report.is_symlink():
                    raise ValueError("报告归档不能是链接")
                report.mkdir(exist_ok=True)
                for source, name in [(results, "test-results"),
                                     (html, "playwright-report")]:
                    if source.exists():
                        if source.is_symlink() or (report / name).exists():
                            raise ValueError("报告路径不合法或已经存在")
                        source.rename(report / name)
                log = self.directory / "command.log"
                if log.exists():
                    self.data["outputTail"] = log.read_bytes()[-8192:].decode("utf-8", errors="replace")
                    log.rename(report / "command.log")
                inventory = []
                for directory, dirs, files in os.walk(self.scratch, followlinks=False):
                    for name in files:
                        path = Path(directory) / name
                        if not path.is_symlink() and len(inventory) < 10000:
                            inventory.append({"path": str(path.relative_to(self.scratch)), "bytes": path.stat().st_size})
                atomic_json(report / "temporary-inventory.json", {"entries": inventory, "limit": 10000})
                self.update(cleanupStage="reports-collected", requestedStatus=status)
                self.retire_short_root()
                remove(self.scratch, self.store.root)
                self.update(status=status, endedAt=time.time(), cleanupStage="complete", **compact)
        except (OSError, ValueError, RuntimeError, KeyError) as error:
            self.update(status="cleanup-pending", requestedStatus=self.data.get("requestedStatus", status), cleanupError=str(error))
        finally:
            if release:
                self.release()
        with locked(self.store.root / "gc.lock"):
            self.store.prune(time.time())
        return self.data
