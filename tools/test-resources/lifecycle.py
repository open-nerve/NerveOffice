"""Owned test resources. Never discover ownership from a filename or an age alone."""
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import time
import tempfile
import uuid

import service_scope
import container_resources
import hosted
import stable_reports

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


def read_run_manifest(path):
    # Check the opened object, without following links or blocking on a FIFO.
    # This does not grant a lease; callers still hold run.lock for authorization.
    path = Path(path)
    if path.parent.resolve() != path.parent.absolute():
        raise ValueError("运行台账父目录不能经过链接")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError("运行台账必须是普通文件")
        return json.load(stream)


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


def lsof_query_command():
    mode = os.environ.get("NERVE_TEST_LSOF_MODE", "direct")
    if mode == "direct":
        return [shutil.which("lsof") or "/usr/sbin/lsof", "-nP", "-F", "pfnt"]
    if mode != "github-ubuntu-sudo":
        raise ValueError("unsupported-lsof-mode")
    required = {"CI": "true", "GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux"}
    if sys.platform != "linux" or any(os.environ.get(key) != value for key, value in required.items()):
        raise ValueError("ineligible-lsof-sudo-context")
    release = Path("/etc/os-release").read_text(encoding="utf-8")
    if not re.search(r'^ID=(?:ubuntu|"ubuntu")$', release, re.M) or not re.search(r'^VERSION_ID=(?:24\.04|"24\.04")$', release, re.M):
        raise ValueError("ineligible-lsof-sudo-os")
    # Only this read-only system binary is elevated, never the runner or a PATH-selected command.
    return ["/usr/bin/sudo", "-n", "--", "/usr/bin/lsof", "-nP", "-F", "pfnt"]


def lsof_incomplete_records(output, service_pids=(), *, allow_unresolved=False):
    """Validate p/f/t/n before filtering; names may contain lsof errors, not paths."""
    pid = descriptor = name = file_type = None
    process_has_file = False
    count, samples = 0, []
    sample_identities = {}
    def problem(reason, operation=None):
        nonlocal count
        if allow_unresolved and reason in {"NOFD", "inspection-error", "unresolved-socket", "mapping-identity-mismatch"}:
            return
        count += 1
        # Task blocks can repeat a file. Keep the failure count and full identity;
        # only the bounded diagnostic samples are aggregated.
        identity = (pid, descriptor, reason, operation, file_type, name)
        if identity in sample_identities:
            sample_identities[identity]["multiplicity"] += 1
            return
        if len(samples) >= 16:
            return
        raw_name = os.fsencode(name) if name is not None else None
        shown_name = name
        redacted = name is not None and name.startswith("/")
        if redacted:
            # Filenames can themselves contain annotation-like text. Render only
            # fixed C-locale errno spellings or a complete numeric identity tail.
            errno_text = {"ENOENT": "No such file or directory", "EACCES": "Permission denied",
                          "EPERM": "Operation not permitted", "ESTALE": "Stale file handle"}
            error_tail = (r' \(?(?:readlink|opendir|stat|lstat): (?:'
                          + '|'.join(re.escape(text) for text in errno_text.values()) + r')\)')
            numeric_tail = r' \(path (?:dev=[0-9]+,[0-9]+(?:,[ \t]*inode=[0-9]+)?|inode=[0-9]+)\)'
            annotation = re.search('(?:' + error_tail + '|' + numeric_tail + r')\Z', name)
            prefix = name[:annotation.start()].rstrip() if annotation else name
            marker = next((suffix for suffix in (" (deleted)", " (revoked)") if prefix.endswith(suffix)), "")
            shown_name = "/memfd:<redacted>" if name.startswith("/memfd:") else "<absolute-path>"
            shown_name += marker + (" " + annotation[0].lstrip() if annotation else "")
        shown_bytes = os.fsencode(shown_name) if shown_name is not None else None
        raw_type = os.fsencode(file_type) if file_type is not None else None
        sample = {"pid": pid, "fd": descriptor, "reason": reason, "operation": operation,
                  "type": os.fsdecode(raw_type[:16]) if raw_type is not None else None,
                  "typeBytes": len(raw_type) if raw_type is not None else None,
                  "typeTruncated": raw_type is not None and len(raw_type) > 16,
                  "name": os.fsdecode(shown_bytes[:512]) if shown_bytes is not None else None,
                  "nameBytes": len(raw_name) if raw_name is not None else None,
                  "nameSha256": hashlib.sha256(raw_name).hexdigest() if raw_name is not None else None,
                  "nameTruncated": raw_name is not None and (len(raw_name) > 512 or len(shown_bytes) > 512),
                  "nameRedacted": redacted, "multiplicity": 1}
        samples.append(sample)
        sample_identities[identity] = sample
    def finish_file():
        if descriptor is None:
            return
        if allow_unresolved and descriptor != "NOFD" and file_type is None:
            problem("missing-type-field")
        if descriptor == "NOFD":
            problem("NOFD", "opendir")
        elif name is None:
            problem("missing-name-field")
        elif name == "":
            # Actual Darwin records for these non-vnode objects have empty names.
            # Never apply this rule to filesystem files, UNIX sockets or unknown types.
            if sys.platform != "darwin" or file_type not in ("PIPE", "NPOLICY", "NEXUS"):
                problem("missing-name")
        else:
            service_map = pid in service_pids and descriptor == "mem" and file_type == "REG" and name.startswith("/")
            error = re.search(r'(?:\(|\s)(readlink|opendir|stat|lstat):[^\n]*\)$', name)
            if error:
                # lsof 4.95 stats this Linux pseudo name as a pathname. It is
                # an io_uring anonymous mapping, not an unresolved filesystem path.
                known_anonymous_map = (sys.platform == "linux" and descriptor == "mem" and file_type == "REG"
                                       and name == "anon_inode:[io_uring] (stat: No such file or directory)")
                if not known_anonymous_map and not (service_map and name.endswith(" (stat: No such file or directory)")):
                    problem("inspection-error", error[1])
            elif name.startswith(("can't identify protocol", "socket:[", "protocol:")):
                if not (pid in service_pids and descriptor.isdigit() and file_type == "sock"
                        and name in ("protocol: UNIX", "protocol: UNIX-STREAM", "protocol: TCP", "protocol: UDP",
                                     "protocol: TCPv6", "protocol: UDPv6")):
                    problem("unresolved-socket")
            elif re.search(r" \(path (?:dev|inode)=[^\n]*\)$", name):
                if not (service_map and re.search(r" \(path (?:dev=[0-9]+,[0-9]+(?:,\s*inode=[0-9]+)?|inode=[0-9]+)\)$", name)):
                    problem("mapping-identity-mismatch", "stat")
    for line in output.splitlines():
        field, value = line[:1], line[1:]
        if field == "p":
            finish_file()
            if pid is not None and not process_has_file:
                problem("process-without-file")
            pid = int(value) if re.fullmatch(r"[0-9]{1,10}", value) else None
            descriptor = name = file_type = None
            process_has_file = False
            if pid is None:
                problem("invalid-pid")
        elif field == "f":
            finish_file()
            descriptor = value if re.fullmatch(r"(?:[0-9]{1,10}|[A-Za-z][A-Za-z0-9_-]{0,31})", value) else None
            name = file_type = None
            process_has_file = True
            if pid is None or descriptor is None:
                problem("invalid-file-context")
        elif field == "t":
            if pid is None or descriptor is None or file_type is not None or not re.fullmatch(r"[A-Za-z0-9_-]{1,16}", value):
                problem("invalid-type-context")
            file_type = value
        elif field == "n":
            if pid is None or descriptor is None or name is not None or "\0" in value:
                problem("invalid-name-context")
            name = value
        else:
            problem("unexpected-field")
    finish_file()
    if pid is None or not process_has_file:
        problem("incomplete-process-set")
    return count, samples


def open_paths(root, owner=None, *, export_only=False):
    command = []
    started = time.monotonic()
    def incomplete(returncode=None, stderr=b"", timed_out=False, error_number=None, reason=None, records=(0, ())):
        raw = stderr.encode("utf-8", errors="replace") if isinstance(stderr, str) else (stderr or b"")
        details = {"operation": "lsof-open-paths", "root": str(root), "argv": command,
                   "returncode": returncode, "timedOut": timed_out, "errno": error_number,
                   "reason": reason, "incompleteRecordCount": records[0], "incompleteRecords": records[1],
                   "incompleteRecordsTruncated": records[0] > sum(sample.get("multiplicity", 1) for sample in records[1]),
                   "durationMs": round((time.monotonic() - started) * 1000),
                   "stderr": raw[:4096].decode("utf-8", errors="replace"),
                   "stderrBytes": len(raw), "stderrTruncated": len(raw) > 4096}
        return RuntimeError("无法完整核对打开文件；保留资源：" + json.dumps(details, ensure_ascii=True))
    try:
        command = lsof_query_command()
        if export_only and (not isinstance(owner, Run) or owner.hosted_proof(root) is None):
            raise ValueError("非破坏导出缺少托管归属证明")
        proof = owner.service_proof(root) if isinstance(owner, Run) else None
        if not os.environ.get(service_scope.SERVICE_ID):
            proof = None
        query = lambda timeout: subprocess.run(command, capture_output=True, timeout=timeout, env=dict(os.environ, LC_ALL="C"))
        if proof is None:
            result, service_pids = query(30), ()
        else:
            result, service_pids = service_scope.observe(proof, query)
    except ValueError as error:
        raise incomplete(reason=str(error)) from None
    except subprocess.TimeoutExpired as error:
        raise incomplete(stderr=error.stderr, timed_out=True) from None
    except OSError as error:
        raise incomplete(error_number=error.errno) from None
    if result.returncode not in (0, 1) or result.stderr:
        raise incomplete(result.returncode, result.stderr)
    output = os.fsdecode(result.stdout)
    records = lsof_incomplete_records(output, service_pids=service_pids)
    structural = lsof_incomplete_records(output, allow_unresolved=True) if export_only else records
    if structural[0]:
        raise incomplete(result.returncode, result.stderr, records=structural)
    if records[0] and not export_only:
        raise incomplete(result.returncode, result.stderr, records=records)
    # Ownership and the inspected root itself must remain fully resolvable. Only
    # foreign candidates from an already validated lsof stream may be unknown.
    canonical = str(root.resolve())
    def inside(name):
        return name == canonical or name.startswith(canonical + "/")
    count, samples = records[0], list(records[1])
    alias_samples = {}
    def alias_problem(name, error):
        nonlocal count
        count += 1
        raw_name = os.fsencode(name)
        identity = (pid, descriptor, file_type, name, type(error).__name__, getattr(error, 'errno', None))
        if identity in alias_samples:
            alias_samples[identity]['multiplicity'] += 1
        elif len(samples) < 16:
            sample = {'pid': pid, 'fd': descriptor, 'reason': 'alias-resolution-error', 'operation': 'resolve',
                      'type': file_type, 'typeBytes': len(os.fsencode(file_type)) if file_type is not None else None,
                      'typeTruncated': False,
                      'name': '<absolute-path>', 'nameBytes': len(raw_name),
                      'nameSha256': hashlib.sha256(raw_name).hexdigest(),
                      'nameTruncated': len(raw_name) > 512, 'nameRedacted': True, 'multiplicity': 1,
                      'exceptionType': type(error).__name__, 'errno': getattr(error, 'errno', None)}
            # Never serialize the exception text: it can contain private paths.
            samples.append(sample)
            alias_samples[identity] = sample
    def path_records():
        # The preceding validator accepts either t/n ordering. Wait for the
        # complete file record, including NOFD records with no type at all.
        pid = descriptor = file_type = name = None
        for line in output.splitlines():
            field, value = line[:1], line[1:]
            if field in ('p', 'f'):
                if name is not None and name.startswith('/'):
                    yield pid, descriptor, file_type, name
                file_type = name = None
            if field == 'p':
                pid, descriptor = int(value), None
            elif field == 'f':
                descriptor = value
            elif field == 't':
                file_type = value
            elif field == 'n':
                name = value
        if name is not None and name.startswith('/'):
            yield pid, descriptor, file_type, name
    found = set()
    for pid, descriptor, file_type, name in path_records():
        if inside(name):
            found.add(name)
            continue
        # UNIX sockets may retain the path used at bind(), including a nested
        # run's alias. Resolve only absolute pathname candidates; retain lsof's
        # original text as evidence. Missing/deleted leaves still resolve parents.
        plain = re.split(r" type=(?:STREAM|DGRAM|SEQPACKET)(?: |$)", name, maxsplit=1)[0]
        # A semantic lookup failure still contains positive path information.
        # Strip only the known lsof annotation syntax for conservative matching;
        # an ambiguous filename may block export, never authorize removal.
        plain = re.sub(r" \((?:readlink|opendir|stat|lstat):[^\n]*\)$", "", plain)
        plain = re.sub(r" \(path (?:dev|inode)=[^\n]*\)$", "", plain)
        plain = re.sub(r" \((?:deleted|revoked)\)$", "", plain)
        # Check all positive lexical evidence before a foreign lookup can fail.
        # Candidate order is deterministic; one unknown cannot hide the other.
        candidates = tuple(dict.fromkeys((plain, name)))
        if any(inside(candidate) for candidate in candidates):
            found.add(name)
            continue
        first_error = None
        for candidate in candidates:
            path = Path(candidate)
            try:
                if inside(str(path.resolve())):
                    found.add(name)
            except (OSError, RuntimeError) as error:
                first_error = first_error or error
                if not export_only:
                    alias_problem(name, error)
                    raise incomplete(result.returncode, records=(count, samples), reason='alias-resolution-error') from None
                # An external alias can already enter our root before an
                # inaccessible or looping descendant. Such a known prefix must
                # still block export; failure to resolve it proves no absence.
                for parent in path.parents:
                    try:
                        if inside(str(parent.resolve())):
                            found.add(name)
                            break
                    except (OSError, RuntimeError):
                        continue
        if first_error is not None:
            alias_problem(name, first_error)
    if export_only:
        owner.update(referenceObservation={"operation": "non-destructive-export", "root": str(root),
                     "incompleteRecordCount": count, "incompleteRecords": samples,
                     "incompleteRecordsTruncated": count > sum(s.get("multiplicity", 1) for s in samples),
                     "absenceProven": False, "rawDeletionAuthorized": False})
    return sorted(found)


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
                    "startedAt": time.time(), "status": "prepared", "serviceScope": None, "hostedScope": None}
        run.persist()
        try:
            context = hosted.context(self.repo)
            proof = None if context is not None else service_scope.register(identity, self.repo, run.scope_roots())
            host_proof = hosted.register(context, identity, run.scope_roots()) if context is not None else None
            run.update(serviceScope=proof, hostedScope=host_proof, scopePaths={}, scopeMoves=[])
            run.scratch.mkdir(mode=0o700)
            run.remember_scope_path(run.scratch)
            if kind == 'container':
                run.update(containerResources=container_resources.MARKER)
                container_resources.register(run.directory, run.id, self.repo, run.scratch)
            return run
        except BaseException as error:
            run.update(status="cleanup-pending", cleanupStage="creation-incomplete", cleanupError=str(error))
            run.release()
            raise

    def hosted_budget(self):
        context = hosted.context(self.repo)
        if context is None:
            return None
        roots = []
        for directory in sorted((self.root / "runs").iterdir()):
            if directory.is_symlink() or not RUN_ID.fullmatch(directory.name):
                raise ValueError("托管任务存在未知运行目录，拒绝继续堆积")
            value = read_run_manifest(directory / "run.json")
            proof = value.get("hostedScope")
            if proof is None or proof.get("context") != context:
                raise ValueError("托管任务存在未绑定或跨宿主台账，保留并停止")
            scratch = directory / "scratch"
            roots_map = {"scratch": str(scratch), "short": str(Path('/tmp').resolve() / ('nerve-t-' + directory.name)),
                         "reports": str(directory / 'reports'), "failures": str(self.root / 'failures' / directory.name)}
            hosted.validate(proof, context, directory.name, roots_map)
            if scratch.exists():
                info = scratch.lstat()
                if value.get('scopePaths', {}).get(str(scratch)) != {"device": info.st_dev, "inode": info.st_ino}:
                    raise ValueError("托管容量核验遇到被替换的根")
            roots.append(scratch)
        result = hosted.check_budget(self.repo, roots)
        # Export copies count separately; they are not exempted by leaving raw disposal to the VM.
        report_roots = [p / 'reports' for p in (self.root / 'runs').iterdir()]
        report_roots += [self.repo / 'tests/e2e' / leaf for leaf in ('test-results', 'playwright-report')]
        result['reportBytes'] = hosted.measure(report_roots, limit_bytes=self.report_bytes)['bytes']
        return result

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
                if run.data.get("hostedScope") is not None and run.data.get("cleanupStage") == "host-disposal-pending":
                    if 'containerResources' in run.data:
                        try:
                            run.assert_container_closed()
                        except (OSError, ValueError, RuntimeError, TypeError) as error:
                            run.update(status='cleanup-pending', cleanupError=str(error))
                            report['active'].append(run.id)
                            continue
                    run.validate_hosted_completion()
                    run.verify_export()
                    continue
                if run.scratch.exists() or run.data.get("cleanupStage") == "reports-collected" or run.data.get("status") in ("prepared", "cleanup-pending"):
                    if group_alive(run.data.get("childGroup")):
                        report["active"].append(run.id)
                    else:
                        value = run.finish("interrupted")
                        if value.get("cleanupStage") != "host-disposal-pending":
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
                    value = read_run_manifest(directory / "run.json")
                    if value["runId"] != directory.name or value["repo"] != str(self.repo):
                        continue
                    if value.get("hostedScope") is not None:
                        continue  # Only the disposable VM owns final disposal, including old snapshots.
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
                        owner = Run(self, directory, existing=True)
                        locks.callback(owner.release)
                        if published:
                            locks.enter_context(locked(self.root / "publication.lock", blocking=False))
                        value = owner.data
                        if published and (path.is_symlink() or read_json(path / "resource-run.json").get("runId") != owner.id
                                          or str(path.relative_to(self.repo)) not in value.get("published", [])):
                            continue
                        if value.get("status") not in ("passed", "failed", "interrupted") or group_alive(value.get("childGroup")) or open_paths(path, owner=owner):
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
        if (directory.parent != store.root / "runs" or not RUN_ID.fullmatch(directory.name)
                or directory.is_symlink()):
            raise ValueError("运行目录归属不符")
        self.store, self.directory, self.id = store, directory, directory.name
        self.scratch = directory / "scratch"
        self.lock = locked(directory / "run.lock", blocking=False)
        self.lock.__enter__()
        self.released = False
        self.data = {}
        if existing:
            try:
                self.data = read_run_manifest(directory / "run.json")
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

    def scope_roots(self):
        short = Path("/tmp").resolve() / (("nerve-vm-" if self.data["kind"] == "vm" else "nerve-t-") + self.id)
        return {"scratch": str(self.scratch), "short": str(short), "reports": str(self.directory / "reports"),
                "failures": str(self.store.root / "failures" / self.id)}

    def remember_scope_path(self, path):
        if self.has_scope():
            path = Path(path)
            if str(path) not in self.scope_roots().values():
                raise ValueError("服务 scope 只登记本轮固定根")
            info = path.lstat()
            if not stat.S_ISDIR(info.st_mode):
                raise ValueError("服务 scope 根不是独占目录")
            paths = dict(self.data["scopePaths"])
            paths[str(path)] = {"device": info.st_dev, "inode": info.st_ino}
            self.update(scopePaths=paths)

    def scope_directory(self, path):
        path = Path(path)
        if not self.has_scope():
            path.mkdir(parents=True, exist_ok=True)
        elif path.exists() or path.is_symlink():
            if str(path) not in self.data.get("scopePaths", {}):
                raise ValueError("服务 scope 不接管已有目录")
            self.scope_proof(path)
        else:
            if str(path) in self.data.get("scopePaths", {}):
                raise ValueError("已登记的服务 scope 根消失，保留原归属")
            path.mkdir(mode=0o700)
            self.remember_scope_path(path)

    def has_scope(self):
        return self.data.get('serviceScope') is not None or self.data.get('hostedScope') is not None

    def scope_proof(self, path):
        return self.hosted_proof(path) if self.data.get('hostedScope') is not None else self.service_proof(path)

    def hosted_proof(self, root):
        if self.released or read_run_manifest(self.directory / 'run.json') != self.data:
            raise ValueError('托管运行租约或台账归属不符')
        proof = self.data.get('hostedScope')
        if proof is None:
            raise ValueError('托管导出缺少创建前登记')
        hosted.validate(proof, hosted.context(self.store.repo), self.id, self.scope_roots())
        root = Path(root).absolute()
        if str(root) != self.scope_roots()['short']:
            contained(root, self.store.repo)
        expected = self.data.get('scopePaths', {}).get(str(root))
        if str(root) not in self.scope_roots().values():
            relative = str(root.relative_to(self.store.repo))
            if relative not in self.data.get('published', []):
                raise ValueError('托管导出根没有发布归属')
            marker = root / 'resource-run.json'
            if marker.is_symlink() or read_run_manifest(marker).get('runId') != self.id:
                raise ValueError('托管报告发布标记不符')
            moves = [m for m in self.data.get('scopeMoves', []) if m['destination'] == str(root)]
            expected = moves[-1]['identity'] if moves else None
        if expected is None or not root.exists():
            raise ValueError('托管根缺少创建或搬迁身份证明')
        info = root.lstat()
        if not stat.S_ISDIR(info.st_mode) or expected != {'device': info.st_dev, 'inode': info.st_ino}:
            raise ValueError('托管根身份已变化')
        if str(root) == self.scope_roots()['short']:
            self.short_root()
        return proof

    def assert_exportable(self):
        """Unknown global references allow a bounded copy, never deletion of the original."""
        if group_alive(self.data.get('childGroup')):
            raise RuntimeError('本轮生产者仍活动，拒绝导出')
        roots = [self.scratch]
        short = self.short_root()
        if short is not None:
            roots.append(short)
        for root in roots:
            self.hosted_proof(root)
            if open_paths(root, owner=self, export_only=True):
                raise RuntimeError('托管资源仍有已知打开句柄，保留：' + str(root))

    def validate_hosted_completion(self):
        if 'containerResources' in self.data:
            self.assert_container_closed()
        self.hosted_proof(self.scratch)
        if self.data.get('shortRoot'):
            self.hosted_proof(self.short_root())
        status, code = self.data.get('status'), self.data.get('exitCode')
        if (self.data.get('producerQuiescent') is not True or group_alive(self.data.get('childGroup'))
                or status not in ('passed', 'failed', 'interrupted') or type(code) is not int
                or (status == 'passed' and (code != 0 or self.data.get('interrupted') is not False))
                or (status != 'passed' and code == 0)
                or self.data.get('cleanupStage') != 'host-disposal-pending'
                or self.data.get('cleanupComplete') is not False):
            raise ValueError('托管结果、生产者退出或处置状态不完整')
        self.export_receipt()

    def export_receipt(self):
        receipt = self.data.get('stableExport')
        if (type(receipt) is not dict or set(receipt) != {'manifest', 'sha256', 'files', 'bytes', 'complete'}
                or receipt.get('manifest') != 'test-results/stable-export.json' or receipt.get('complete') is not True
                or type(receipt.get('sha256')) is not str or not re.fullmatch('[0-9a-f]{64}', receipt['sha256'])
                or any(type(receipt.get(key)) is not int or receipt[key] < 0 for key in ('files', 'bytes'))):
            raise ValueError('托管完成态缺少持久化的稳定导出回执')
        return receipt

    def verify_export(self):
        self.hosted_proof(self.scratch)
        root = self.directory / 'reports/portable'
        if self.data.get('published'):
            roots = {str((self.store.repo / p).parent) for p in self.data['published']}
            if len(roots) != 1:
                raise ValueError('托管报告发布位置不一致')
            root = Path(next(iter(roots)))
            for relative in self.data['published']:
                self.hosted_proof(self.store.repo / relative)
        else:
            self.hosted_proof(root.parent)
        return stable_reports.verify_snapshot(root, self.id, self.export_receipt())

    def finish_hosted(self, status):
        self.assert_exportable()
        if self.data.get('producerQuiescent') is not True:
            raise RuntimeError('尚无本轮生产者及输出线程退出证明')
        code = self.data.get('exitCode')
        if type(code) is not int or (status == 'passed' and (code != 0 or self.data.get('interrupted') is not False)) or (status != 'passed' and code == 0):
            raise ValueError('测试结果与退出状态不一致')
        before = self.store.hosted_budget()
        report = self.directory / 'reports'
        self.scope_directory(report)
        results = self.scratch / 'tests/e2e/test-results'
        failed = set() if status == 'passed' else failed_profile_names(results / 'results.json')
        log = self.directory / 'command.log'
        self.update(exportDirectory='reports/portable')
        receipt = stable_reports.snapshot_reports(self.scratch, report / 'portable', self.id, failed,
                    command_log=log if log.exists() else None, report_limit=self.store.report_bytes)
        self.assert_exportable()
        self.update(stableExport=receipt, resourceBudget=self.store.hosted_budget(),
                    resourceBudgetBeforeExport=before, status=status, endedAt=time.time(),
                    cleanupStage='host-disposal-pending', cleanupComplete=False,
                    disposalOwner='GitHub job VM lifecycle; final deletion not observed')
        self.validate_hosted_completion()
        self.verify_export()
        return self.data

    def service_proof(self, root):
        if self.released or read_run_manifest(self.directory / "run.json") != self.data:
            raise ValueError("运行租约或台账归属不符")
        proof = self.data.get("serviceScope")
        if proof is None:
            return None
        if (proof.get("version") != 1 or proof.get("runId") != self.id or proof.get("repo") != str(self.store.repo)
                or proof.get("roots") != self.scope_roots()):
            raise ValueError("服务 scope 运行归属或创建证明不符")
        root = Path(root).absolute()
        if str(root) != self.scope_roots()["short"]:
            contained(root, self.store.repo)
        expected = self.data.get("scopePaths", {}).get(str(root))
        if str(root) not in self.scope_roots().values():
            relative = str(root.relative_to(self.store.repo)) if root.is_relative_to(self.store.repo) else None
            if relative not in self.data.get("published", []):
                return None
            marker = root / "resource-run.json"
            if marker.is_symlink() or read_json(marker).get("runId") != self.id:
                raise ValueError("服务 scope 报告标记不符")
            moves = [m for m in self.data.get("scopeMoves", []) if m["destination"] == str(root)]
            if not moves:
                return None
            expected = moves[-1]["identity"]
        if expected is None:
            return None
        if root.exists() or root.is_symlink():
            info = root.lstat()
            if not stat.S_ISDIR(info.st_mode) or expected != {"device": info.st_dev, "inode": info.st_ino}:
                raise ValueError("服务 scope 根身份已变化")
        if str(root) == self.scope_roots()["short"]:
            self.short_root()
        return proof

    def scope_move(self, source, destination):
        if not self.has_scope():
            return
        source, destination = Path(source), Path(destination)
        roots = [Path(p) for p in self.scope_roots().values()]
        published = {self.store.repo / base / leaf for base in ("tests/e2e", "tests/e2e/measure", "tests/e2e/safari-results")
                     for leaf in ("test-results", "playwright-report")}
        origin = next((p for p in roots if source.is_relative_to(p)), source if source in published else None)
        if origin is None or self.scope_proof(origin) is None or not (any(destination.is_relative_to(p) for p in roots) or destination in published):
            raise ValueError("报告 scope 缺少本轮创建及搬迁链")
        if source.is_symlink() or destination.exists() or destination.is_symlink():
            raise ValueError("报告 scope 搬迁路径已存在或被替换")
        info = source.lstat()
        if not stat.S_ISDIR(info.st_mode):
            raise ValueError("报告 scope 只搬迁目录")
        moves = [*self.data.get("scopeMoves", []), {"source": str(source), "destination": str(destination),
                  "identity": {"device": info.st_dev, "inode": info.st_ino}}]
        if len(moves) > 32:
            raise ValueError("报告 scope 搬迁次数超过界限")
        self.update(scopeMoves=moves)

    def create_short_root(self):
        if "shortRoot" in self.data:
            raise ValueError("短目录已经登记，拒绝重复创建")
        vm = self.data["kind"] == "vm"
        root = Path("/tmp").resolve() / (("nerve-vm-" if vm else "nerve-t-") + self.id)
        # Precise ownership is durable before creation; an existing directory is never adopted.
        # Explicitly distinguish a new interrupted creation from legacy VM manifests.
        self.update(shortRoot=str(root), shortRootIdentity=None)
        root.mkdir(mode=0o700)
        info = root.lstat()
        self.update(shortRootIdentity={"device": info.st_dev, "inode": info.st_ino})
        self.remember_scope_path(root)
        atomic_json(root / "owner.json", {"runId": self.id, "repo": str(self.store.repo),
                    "kind": "vm-short-path" if vm else "test-short-path"})
        return root

    def create_short_tmp(self):
        target = contained(self.scratch / "tmp", self.store.root)
        target.mkdir(mode=0o700)
        root = self.create_short_root()
        alias = root / "t"
        # Record the sole permitted alias before creating it. Partial creation
        # without its exact identity is retained for ownership investigation.
        self.update(shortTmp={"path": str(alias), "target": str(target)})
        alias.symlink_to(target, target_is_directory=True)
        info = alias.lstat()
        self.update(shortTmpIdentity={"device": info.st_dev, "inode": info.st_ino})
        self.short_root()
        return alias

    def short_root(self):
        if not self.data.get("shortRoot"):
            return None
        vm = self.data["kind"] == "vm"
        expected = Path("/tmp").resolve() / (("nerve-vm-" if vm else "nerve-t-") + self.id)
        if self.data["shortRoot"] != str(expected):
            raise ValueError("短路径归属不符")
        try:
            info = expected.lstat()
        except FileNotFoundError:
            # It may not have been created yet, or a completed removal was interrupted.
            # Still return the lexical root so any remaining open socket is checked.
            return expected
        identity = {"device": info.st_dev, "inode": info.st_ino}
        if (not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o700
                or info.st_uid != os.getuid()
                or (self.data.get("shortRootIdentity") != identity
                    and not (vm and all(key not in self.data for key in
                                        ("shortRootIdentity", "shortTmp", "shortTmpIdentity"))))):
            raise ValueError("短目录已被替换或没有完整创建证明，保留")
        marker = expected / "owner.json"
        if (not stat.S_ISREG(marker.lstat().st_mode)
                or read_json(marker) != {"runId": self.id, "repo": str(self.store.repo),
                                        "kind": "vm-short-path" if vm else "test-short-path"}):
            raise ValueError("短路径没有完整创建证明，保留")
        registered = self.data.get("shortTmp")
        if registered is not None:
            target = contained(self.scratch / "tmp", self.store.root)
            alias = expected / "t"
            alias_info = alias.lstat()
            if (registered != {"path": str(alias), "target": str(target)}
                    or not stat.S_ISLNK(alias_info.st_mode)
                    or self.data.get("shortTmpIdentity") != {"device": alias_info.st_dev, "inode": alias_info.st_ino}
                    or os.readlink(alias) != str(target)
                    or target.resolve() != target):
                raise ValueError("短路径别名已被替换或未完整登记，保留")
        if not vm and set(path.name for path in expected.iterdir()) != ({"owner.json", "t"} if registered is not None else {"owner.json"}):
            raise ValueError("短目录含有未登记内容，保留")
        return expected

    def assert_quiescent(self):
        contained(self.scratch, self.store.root)
        if self.scratch.is_symlink():
            raise ValueError("scratch 不能是链接")
        short = self.short_root()
        if group_alive(self.data.get("childGroup")):
            raise RuntimeError("资源仍有活动进程，保留")
        # Both roots are checked before any compaction, move or evidence copy.
        for root in [self.scratch, *([short] if short is not None else [])]:
            if open_paths(root, owner=self):
                raise RuntimeError("资源仍有打开句柄，保留：" + str(root))

    def retire_short_root(self):
        expected = self.short_root()
        if expected is not None:
            if group_alive(self.data.get("childGroup")) or open_paths(expected, owner=self):
                raise RuntimeError("短路径仍有使用者，保留")
            if expected.exists():
                remove(expected, expected.parent)

    def assert_container_closed(self):
        if (self.data.get('kind') == 'container' and 'containerResources' not in self.data
                and self.data.get('hostedScope') is None
                and self.scratch.exists() and (self.data.get('childGroup') is not None
                or self.data.get('command') is not None or self.data.get('status') == 'running')):
            raise ValueError('legacy-container-ownership-unverified：旧 Docker 归属未知，保留环境，不补签')
        if 'containerResources' in self.data:
            if self.data['containerResources'] != container_resources.MARKER:
                raise ValueError('容器协议标记无效')
            return container_resources.assert_closed(self.directory, self.id, self.store.repo, self.scratch)

    def finish(self, status, release=True):
        if status not in ("passed", "failed", "interrupted"):
            raise ValueError("终态无效")
        try:
            container_snapshot = self.assert_container_closed()
            if 'containerResources' in self.data:
                if self.scratch.exists() and self.data.get('cleanupStage') != 'reports-collected':
                    if self.data.get('hostedScope') is not None:
                        self.assert_exportable()
                    else:
                        self.assert_quiescent()
                    results = contained(self.scratch / 'tests/e2e/test-results', self.scratch)
                    if results.is_symlink():
                        raise ValueError('容器回执目标不得是链接')
                    results.mkdir(parents=True, exist_ok=True)
                    container_resources.export(self.directory, results, self.id, self.store.repo, self.scratch,
                                               snapshot=container_snapshot, require_closed=True)
            if self.data.get('hostedScope') is not None:
                return self.finish_hosted(status)
            self.assert_quiescent()
            if not self.scratch.exists():
                if self.data.get("cleanupStage") == "reports-collected":
                    self.retire_short_root()
                    self.update(status=self.data["requestedStatus"], endedAt=time.time(), cleanupStage="complete")
                elif self.data.get("status") in ("prepared", "cleanup-pending") and self.data.get("childGroup") is None:
                    self.retire_short_root()
                    self.update(status="interrupted", endedAt=time.time(), cleanupStage="never-started")
                return self.data
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
                if self.data.get("serviceScope") is not None:
                    self.scope_directory(self.store.root / "failures" / self.id)
                compact = compact_profiles(results / "persistent-profiles", self.id,
                                           self.store.root / "failures" / self.id,
                                           failed, self.store.failure_run_bytes)
                self.update(**compact)
                report = contained(self.directory / "reports", self.store.root)
                if report.is_symlink():
                    raise ValueError("报告归档不能是链接")
                self.scope_directory(report)
                for source, name in [(results, "test-results"),
                                     (html, "playwright-report")]:
                    if source.exists():
                        if source.is_symlink() or (report / name).exists():
                            raise ValueError("报告路径不合法或已经存在")
                        self.scope_move(source, report / name)
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
