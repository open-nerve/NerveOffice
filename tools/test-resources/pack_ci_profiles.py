"""Manifest-bound transport of portable profile evidence, never raw environments."""
from contextlib import ExitStack
import copy
import hashlib
import json
import os
from pathlib import Path
import selectors
import signal
import stat
import subprocess
import sys
import tarfile
import time

import check_ci_resources
import hosted
from lifecycle import Store, Run, locked, open_paths, read_run_manifest
import stable_reports


PREFIX = "persistent-profiles"
ARCHIVE = "persistent-profiles.tar.zst"
RECEIPT = "packed-profiles-receipt.json"
DIRECTORY = "reports/transport"
CHUNK = 64 * 1024
METADATA_LIMIT = 64 * 1024
SECONDS = 600
TAR = "/usr/bin/tar"
ZSTD = "/usr/bin/zstd"
ZERO_MEMBERS = {"entries": 0, "files": 0, "directories": 0, "bytes": 0, "streamBytes": 0}


def _path(name, directory=False):
    if type(name) is not str or not name or "\\" in name or "\0" in name:
        raise ValueError("invalid packed member path")
    if directory and name.endswith("/"):
        name = name[:-1]
    parts = name.split("/")
    if parts[0] != PREFIX or any(part in ("", ".", "..") for part in parts):
        raise ValueError("packed member is outside the profile tree")
    return name


def _pax(data):
    values, offset = {}, 0
    while offset < len(data):
        space = data.find(b" ", offset, offset + 24)
        if space < 0 or not data[offset:space].isdigit():
            raise ValueError("invalid PAX record length")
        size = int(data[offset:space])
        if size <= space - offset + 2 or offset + size > len(data):
            raise ValueError("invalid PAX record boundary")
        record = data[space + 1:offset + size]
        if not record.endswith(b"\n") or b"=" not in record:
            raise ValueError("invalid PAX record")
        key, value = record[:-1].split(b"=", 1)
        key, value = key.decode("utf-8"), value.decode("utf-8")
        if key not in {"path", "mtime", "atime", "ctime", "uid", "gid", "uname", "gname"} or key in values:
            raise ValueError("unsupported, sparse or duplicate PAX metadata")
        values[key] = value
        offset += size
    return values


def verify_tar(stream, expected_files, expected_dirs, *, expanded_limit, entry_limit):
    """Verify raw tar incrementally; never extract or trust tar's automatic PAX reader."""
    if type(expanded_limit) is not int or expanded_limit < 0 or type(entry_limit) is not int or entry_limit < 0:
        raise ValueError("invalid packed stream limit")
    if type(expected_files) is not dict:
        raise ValueError("invalid expected packed files")
    expected_dirs = set(expected_dirs)
    for name in expected_dirs:
        _path(name)
    for name, value in expected_files.items():
        _path(name)
        if (type(value) is not dict or set(value) != {"bytes", "sha256"}
                or type(value["bytes"]) is not int or value["bytes"] < 0
                or not stable_reports._is_sha(value["sha256"])):
            raise ValueError("invalid expected packed file")
    if (set(expected_files) & expected_dirs or PREFIX not in expected_dirs
            or len(expected_files) + len(expected_dirs) > entry_limit):
        raise ValueError("invalid expected packed inventory")
    for name in set(expected_files) | expected_dirs:
        if name != PREFIX and name.rsplit("/", 1)[0] not in expected_dirs:
            raise ValueError("expected packed member has no parent")
    total = dict(ZERO_MEMBERS)
    seen, pending_pax, metadata_count = set(), None, 0

    def read(size, *, exact=True):
        chunks, remaining = [], size
        while remaining:
            data = stream.read(min(remaining, CHUNK))
            if not data:
                if exact:
                    raise ValueError("truncated packed tar stream")
                break
            total["streamBytes"] += len(data)
            if total["streamBytes"] > expanded_limit:
                raise ValueError("packed expanded stream exceeds limit")
            chunks.append(data)
            remaining -= len(data)
        return b"".join(chunks)

    while True:
        block = read(512)
        if block == b"\0" * 512:
            if pending_pax is not None or read(512) != b"\0" * 512:
                raise ValueError("invalid packed tar terminator")
            while True:
                tail = read(CHUNK, exact=False)
                if not tail:
                    break
                if any(tail):
                    raise ValueError("nonzero data follows packed tar terminator")
            break
        try:
            member = tarfile.TarInfo.frombuf(block, "utf-8", "strict")
        except (tarfile.HeaderError, UnicodeError, ValueError):
            raise ValueError("invalid packed tar header") from None
        if member.size < 0:
            raise ValueError("negative packed member size")
        if member.type == tarfile.XHDTYPE:
            metadata_count += 1
            if pending_pax is not None or member.size > METADATA_LIMIT or metadata_count > entry_limit:
                raise ValueError("packed PAX metadata exceeds limit")
            pending_pax = _pax(read(member.size))
            padding = read((-member.size) % 512)
            if any(padding):
                raise ValueError("nonzero PAX padding")
            continue
        if member.type not in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE):
            raise ValueError("links, sparse and special packed members are forbidden")
        directory = member.type == tarfile.DIRTYPE
        name = _path((pending_pax or {}).get("path", member.name), directory)
        pending_pax = None
        if name in seen:
            raise ValueError("duplicate packed member")
        seen.add(name)
        total["entries"] += 1
        if total["entries"] > entry_limit:
            raise ValueError("packed entry limit exceeded")
        if directory:
            if member.size or name not in expected_dirs:
                raise ValueError("unexpected packed directory")
            total["directories"] += 1
            continue
        expected = expected_files.get(name)
        if expected is None or member.size != expected["bytes"]:
            raise ValueError("packed file is missing from or differs from stable inventory")
        digest, remaining = hashlib.sha256(), member.size
        while remaining:
            data = read(min(remaining, CHUNK))
            digest.update(data)
            remaining -= len(data)
        if digest.hexdigest() != expected["sha256"]:
            raise ValueError("packed file digest differs from stable inventory")
        if any(read((-member.size) % 512)):
            raise ValueError("nonzero packed file padding")
        total["files"] += 1
        total["bytes"] += member.size
    if seen != set(expected_files) | expected_dirs:
        raise ValueError("packed archive omits stable inventory members")
    return total


def _identity(info):
    return {"device": info.st_dev, "inode": info.st_ino}


def _same_file(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def _read_file(parent, name, limit, *, collect=False):
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > limit:
            raise ValueError("invalid or oversized transport file")
        digest, count, pieces = hashlib.sha256(), 0, []
        while True:
            block = os.read(descriptor, CHUNK)
            if not block:
                break
            count += len(block)
            if count > limit or count > before.st_size:
                raise ValueError("transport file grew while read")
            digest.update(block)
            if collect:
                pieces.append(block)
        current = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if count != before.st_size or _same_file(before) != _same_file(os.fstat(descriptor)) \
                or _same_file(before) != _same_file(current) or current.st_nlink != 1:
            raise ValueError("transport file changed while read")
        return {"bytes": count, "sha256": digest.hexdigest()}, b"".join(pieces), _identity(before)
    finally:
        os.close(descriptor)


def _transport_fd(run, plan):
    run.hosted_proof(run.directory / "reports")
    if plan.get("directory") != DIRECTORY or plan.get("version") != 1:
        raise ValueError("invalid transport directory registration")
    path = run.directory / DIRECTORY
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    if _identity(os.fstat(descriptor)) != plan.get("identity"):
        os.close(descriptor)
        raise ValueError("transport directory identity changed")
    return descriptor


def _expected(run):
    context = hosted.context(run.store.repo)
    if context is None or context["job"] != "e2e" or run.data.get("kind") != "e2e":
        raise ValueError("profile transport requires the hosted e2e primary run")
    run.validate_hosted_completion()
    receipt = run.verify_export()
    root = run.store.repo / "tests/e2e/test-results"
    descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        record, data, unused = _read_file(descriptor, "stable-export.json", stable_reports.JSON_LIMIT, collect=True)
    finally:
        os.close(descriptor)
    if record["sha256"] != receipt["sha256"]:
        raise ValueError("stable export changed before packing")
    manifest = json.loads(data)
    prefix = "test-results/" + PREFIX
    files = {item["path"][len("test-results/"):]: {"bytes": item["bytes"], "sha256": item["sha256"]}
             for item in manifest["entries"] if item["path"].startswith(prefix + "/")}
    directories = {name[len("test-results/"):] for name in manifest["directories"]
                   if name == prefix or name.startswith(prefix + "/")}
    return root, receipt["sha256"], files, directories


def _stop(children):
    for child in children:
        if child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    for child in children:
        try:
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=2)
        for stream in (child.stdin, child.stdout, child.stderr):
            if stream is not None:
                stream.close()


def _output(children, output, repo):
    deadline, diagnostics = time.monotonic() + SECONDS, 0
    with selectors.DefaultSelector() as selector:
        selector.register(output, selectors.EVENT_READ, "output")
        for child in children:
            if child.stderr is not None:
                selector.register(child.stderr, selectors.EVENT_READ, "error")
        while selector.get_map():
            if time.monotonic() >= deadline:
                raise RuntimeError("profile transport command timed out")
            if hosted.shutil.disk_usage(repo).free < hosted.DISK_RESERVE:
                raise RuntimeError("profile transport lost the disk reserve")
            for key, unused in selector.select(.2):
                data = os.read(key.fileobj.fileno(), CHUNK)
                if not data:
                    selector.unregister(key.fileobj)
                elif key.data == "output":
                    yield data
                else:
                    diagnostics += len(data)
                    if diagnostics > METADATA_LIMIT:
                        raise RuntimeError("profile transport diagnostic output exceeds limit")
        for child in children:
            if child.wait(timeout=max(.01, deadline - time.monotonic())) != 0:
                raise RuntimeError("profile transport command failed")


class _Stream:
    def __init__(self, chunks):
        self.chunks, self.buffer = iter(chunks), b""

    def read(self, size):
        if not 0 <= size <= CHUNK:
            raise ValueError("unbounded transport read")
        while len(self.buffer) < size:
            try:
                self.buffer += next(self.chunks)
            except StopIteration:
                break
        result, self.buffer = self.buffer[:size], self.buffer[size:]
        return result


def _archive_members(parent, name, files, directories, run, expected_identity=None):
    # A path can change after the first hash. Opening a replacement FIFO must
    # not block before the decoder's deadline has even started.
    source = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    children, chunks = [], None
    try:
        before = os.fstat(source)
        if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1
                or before.st_size > run.store.report_bytes
                or (expected_identity is not None and _identity(before) != expected_identity)):
            raise ValueError("archive decoder requires the registered regular file")
        child = subprocess.Popen([ZSTD, "-q", "-d", "-c"], stdin=source,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        children.append(child)
        chunks = _output(children, child.stdout, run.store.repo)
        result = verify_tar(_Stream(chunks), files, directories,
                            expanded_limit=run.store.report_bytes, entry_limit=stable_reports.REPORT_ENTRY_LIMIT)
        current = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if (_same_file(before) != _same_file(os.fstat(source))
                or _same_file(before) != _same_file(current) or current.st_nlink != 1):
            raise ValueError("archive identity changed during decoding")
        return result
    finally:
        if chunks is not None:
            chunks.close()
        _stop(children)
        os.close(source)


def _assert_reports_idle(run):
    # Call while holding the run lease, but without our own report FDs open.
    # Never hide the whole PID: another FD in this process may be a writer.
    reports = run.directory / "reports"
    run.hosted_proof(reports)
    if open_paths(reports, owner=run, export_only=True):
        raise ValueError("profile transport reports still have known users")


def verify_packaged(run):
    """Read-only validation for an already leased run; never calls check or pack."""
    root, stable_sha, files, directories = _expected(run)
    plan = run.data.get("packagedProfiles")
    if type(plan) is not dict or plan.get("stage") != "complete" or plan.get("children") != [] \
            or plan.get("sourceStableExportSha256") != stable_sha:
        raise ValueError("profile transport is incomplete or belongs to another source")
    _assert_reports_idle(run)
    descriptor = _transport_fd(run, plan)
    try:
        directory_before = os.fstat(descriptor)
        hashed, data, identity = _read_file(descriptor, RECEIPT, METADATA_LIMIT, collect=True)
        if hashed["sha256"] != plan.get("receiptSha256") or identity != plan.get("receiptIdentity"):
            raise ValueError("profile transport receipt is not the registered original")
        receipt = json.loads(data)
        if (receipt.get("version") != 1 or type(receipt.get("version")) is not int
                or receipt.get("runId") != run.id or receipt.get("sourceStableExportSha256") != stable_sha):
            raise ValueError("profile transport receipt binding differs")
        expected_names = {RECEIPT}
        if not directories and not files:
            if receipt.get("archive") is not None or receipt.get("reason") != "no-profile-evidence" \
                    or receipt.get("members") != ZERO_MEMBERS:
                raise ValueError("invalid empty profile transport")
        else:
            expected_names.add(ARCHIVE)
            archive, unused, identity = _read_file(descriptor, ARCHIVE, run.store.report_bytes)
            if receipt.get("archive") != dict(archive, path=ARCHIVE) or identity != plan.get("archiveIdentity"):
                raise ValueError("packed profile archive differs from receipt")
            if _archive_members(descriptor, ARCHIVE, files, directories, run, identity) != receipt.get("members"):
                raise ValueError("packed profile members differ from receipt")
            after, unused, after_identity = _read_file(descriptor, ARCHIVE, run.store.report_bytes)
            if after != archive or after_identity != identity:
                raise ValueError("packed archive changed during verification")
        names = []
        with os.scandir(descriptor) as entries:
            for entry in entries:
                names.append(entry.name)
                if len(names) > 2:
                    raise ValueError("unknown transport member")
        if set(names) != expected_names:
            raise ValueError("unknown or missing transport member")
        budget = receipt.get("budget", {})
        if (budget.get("limitBytes") != hosted.RAW_LIMIT or budget.get("reserveBytes") != hosted.DISK_RESERVE
                or any(type(budget.get(key)) is not int or budget[key] < 0
                       for key in ("bytes", "files", "reportBytes", "freeBytes"))
                or budget["bytes"] > hosted.RAW_LIMIT or budget["reportBytes"] > run.store.report_bytes
                or budget["freeBytes"] < hosted.DISK_RESERVE):
            raise ValueError("invalid profile transport budget evidence")
        run.store.hosted_budget()
        final_receipt, unused, final_receipt_identity = _read_file(descriptor, RECEIPT, METADATA_LIMIT)
        if (final_receipt != hashed or final_receipt_identity != plan.get("receiptIdentity")):
            raise ValueError("transport receipt changed during archive verification")
        current = os.open(run.directory / DIRECTORY, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            if (_same_file(os.fstat(current)) != _same_file(directory_before)
                    or _same_file(os.fstat(descriptor)) != _same_file(directory_before)):
                raise ValueError("transport directory changed during verification")
        finally:
            os.close(current)
    finally:
        os.close(descriptor)
    _assert_reports_idle(run)
    return receipt


def _write(descriptor, data):
    remaining = memoryview(data)
    while remaining:
        count = os.write(descriptor, remaining)
        if count <= 0:
            raise OSError("short transport write")
        remaining = remaining[count:]


def _publish(parent, partial, final):
    # link() is no-replace; rename() would overwrite a concurrently created name.
    os.link(partial, final, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
    os.unlink(partial, dir_fd=parent)


def _pack_run(run):
    root, stable_sha, files, directories = _expected(run)
    if "packagedProfiles" in run.data:
        return verify_packaged(run)
    path = run.directory / DIRECTORY
    if path.exists() or path.is_symlink():
        raise ValueError("unknown transport directory will not be adopted")
    _assert_reports_idle(run)
    plan = {"version": 1, "stage": "planned", "directory": DIRECTORY,
            "sourceStableExportSha256": stable_sha, "children": []}
    run.update(packagedProfiles=copy.deepcopy(plan))
    descriptor, children, partials = None, [], {}
    try:
        path.mkdir(mode=0o700)
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode):
            raise ValueError("transport directory is not a directory")
        plan.update(stage="writing", identity=_identity(info))
        run.update(packagedProfiles=copy.deepcopy(plan))
        descriptor = _transport_fd(run, plan)

        def create(name):
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=descriptor)
            try:
                partials[name] = _identity(os.fstat(fd))
                plan["partials"] = copy.deepcopy(partials)
                run.update(packagedProfiles=copy.deepcopy(plan))
                return fd
            except BaseException:
                os.close(fd)
                raise

        archive = None
        members = dict(ZERO_MEMBERS)
        if directories or files:
            partial = ARCHIVE + ".partial"
            output = create(partial)
            try:
                initial = run.store.hosted_budget()
                producer = subprocess.Popen([TAR, "--format=pax", "--pax-option=delete=atime,delete=ctime",
                    "-C", str(root), "-cf", "-", PREFIX], stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
                children.append(producer)
                plan["children"] = [producer.pid]
                run.update(packagedProfiles=copy.deepcopy(plan))
                compressor = subprocess.Popen([ZSTD, "-q", "-T1", "-c"], stdin=producer.stdout,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
                children.append(compressor)
                producer.stdout.close()
                plan["children"] = [child.pid for child in children]
                run.update(packagedProfiles=copy.deepcopy(plan))
                count = 0
                for block in _output(children, compressor.stdout, run.store.repo):
                    count += len(block)
                    if initial["reportBytes"] + count > run.store.report_bytes:
                        raise RuntimeError("packed archive exceeds remaining report budget")
                    _write(output, block)
                os.fsync(output)
            finally:
                _stop(children)
                os.close(output)
            plan["children"] = []
            run.update(packagedProfiles=copy.deepcopy(plan))
            members = _archive_members(descriptor, partial, files, directories, run, partials[partial])
            hashed, unused, identity = _read_file(descriptor, partial, run.store.report_bytes)
            if identity != partials[partial]:
                raise ValueError("archive partial was replaced after decoding")
            archive = dict(hashed, path=ARCHIVE)
            plan["archiveIdentity"] = identity
        run.verify_export()
        budget = run.store.hosted_budget()
        receipt = {"version": 1, "runId": run.id, "sourceStableExportSha256": stable_sha,
                   "archive": archive, "members": members, "budget": budget}
        if archive is None:
            receipt["reason"] = "no-profile-evidence"
        data = (json.dumps(receipt, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()
        if len(data) > METADATA_LIMIT or budget["reportBytes"] + len(data) > run.store.report_bytes:
            raise RuntimeError("profile receipt exceeds remaining report budget")
        receipt_partial = RECEIPT + ".partial"
        output = create(receipt_partial)
        try:
            _write(output, data)
            os.fsync(output)
        finally:
            os.close(output)
        if archive is not None:
            _publish(descriptor, ARCHIVE + ".partial", ARCHIVE)
        _publish(descriptor, receipt_partial, RECEIPT)
        os.fsync(descriptor)
        plan.update(stage="complete", children=[], partials={},
                    receiptIdentity=partials[receipt_partial], receiptSha256=hashlib.sha256(data).hexdigest())
        run.update(packagedProfiles=copy.deepcopy(plan))
        os.close(descriptor)
        descriptor = None
        return verify_packaged(run)
    except BaseException as error:
        _stop(children)
        if descriptor is not None:
            for name, identity in partials.items():
                try:
                    info = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
                    if stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and _identity(info) == identity:
                        os.unlink(name, dir_fd=descriptor)
                except FileNotFoundError:
                    pass
        plan.update(stage="failed", children=[], error=type(error).__name__, errorDetail=str(error)[:2048])
        run.update(packagedProfiles=copy.deepcopy(plan))
        raise
    finally:
        if descriptor is not None:
            os.close(descriptor)


def pack(repo):
    repo = Path(repo).absolute()
    previous = signal.getsignal(signal.SIGTERM)
    def interrupted(unused_signal, unused_frame):
        raise KeyboardInterrupt("profile transport received SIGTERM")
    signal.signal(signal.SIGTERM, interrupted)
    try:
        checked = check_ci_resources.check(repo)
        store = Store(repo)
        with ExitStack() as stack:
            stack.enter_context(locked(store.root / "publication.lock", blocking=False))
            run = Run(store, store.root / "runs" / checked["runId"], existing=True)
            stack.callback(run.release)
            receipt = _pack_run(run)
        # The final contract includes transport ownership and all newly written bytes.
        check_ci_resources.check(repo)
        return receipt
    finally:
        signal.signal(signal.SIGTERM, previous)


def main():
    if len(sys.argv) != 1:
        raise ValueError("profile transport accepts no extra CLI arguments")
    print(json.dumps(pack(Path(__file__).resolve().parents[2]), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, KeyError) as error:
        print("Profile transport refused: " + str(error), file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("Profile transport interrupted; owned producers stopped.", file=sys.stderr)
        sys.exit(130)
