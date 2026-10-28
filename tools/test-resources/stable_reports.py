"""Non-destructive report export after the caller has proved producer exit.

This module never decides that a process is quiescent and never deletes source
resources. The caller owns those checks; an export only proves the selected
report bytes were stable. Unknown host references do not grant deletion rights.
"""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat


REPORT_LIMIT = 5 * 1024 ** 3
# Includes files, directories and omission records; independent of payload bytes.
# A real gate has exceeded 1,100 profiles, so this permits a substantial report
# while preventing zero-byte trees from bypassing the memory/metadata budget.
REPORT_ENTRY_LIMIT = 100000
DIAGNOSTIC_FILE_LIMIT = 4 * 1024 ** 2
DIAGNOSTIC_CASE_LIMIT = 16 * 1024 ** 2
DIAGNOSTIC_RUN_LIMIT = 64 * 1024 ** 2
DIAGNOSTIC_FILE_COUNT = 1000
DIAGNOSTIC_SCAN_COUNT = 10000
JSON_LIMIT = 16 * 1024 ** 2
MARKER_LIMIT = 64 * 1024
CHUNK = 1024 * 1024
MANIFEST = "test-results/stable-export.json"
OWNER = "test-results/snapshot-owner.json"
LEAVES = ("test-results", "playwright-report")
PUBLICATION_MARKERS = {leaf + "/" + name for leaf in LEAVES
                       for name in ("resource-run.json", "cleanup-receipt.json")}
DISPOSITION = "host-disposal-pending"
DIAGNOSTIC_SUFFIXES = {".log", ".json", ".txt", ".ips", ".dmp"}
RAW_SUFFIXES = {".db", ".sqlite", ".sqlite3", ".mdb", ".img", ".qcow",
                ".qcow2", ".vmdk", ".vhd", ".vhdx", ".vdi"}
HEX_SHA = re.compile(r"[0-9a-f]{64}\Z")


def _json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True,
                       separators=(",", ":")) + "\n").encode("utf-8")


def _identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns, info.st_nlink)


def _absolute(path):
    path = Path(path).absolute()
    if ".." in path.parts:
        raise ValueError("parent traversal is not a resource path")
    return path


def _parts(path, empty=False):
    if not isinstance(path, str) or (not path and not empty):
        raise ValueError("invalid relative report path")
    if not path:
        return ()
    parts = tuple(path.split("/"))
    if any(not part or part in (".", "..") or "\\" in part or "\0" in part
           for part in parts):
        raise ValueError("unsafe relative report path")
    return parts


def _opfs_parts(value, empty=False):
    if not isinstance(value, list) or (not value and not empty):
        raise ValueError("invalid OPFS path")
    if not all(isinstance(part, str) and len(_parts(part)) == 1 for part in value):
        raise ValueError("invalid OPFS component")
    return tuple(value)


def _is_count(value):
    return type(value) is int and value >= 0


def _is_sha(value):
    return isinstance(value, str) and HEX_SHA.fullmatch(value) is not None


def _directory_flags():
    return os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def _absolute_directory(path):
    """Open every ancestor without following a link, including the root itself."""
    fd = os.open("/", _directory_flags())
    try:
        for component in path.parts[1:]:
            following = os.open(component, _directory_flags(), dir_fd=fd)
            os.close(fd)
            fd = following
        return fd
    except BaseException:
        os.close(fd)
        raise


class _Tree:
    def __init__(self, path, tag="", descriptor=None):
        self.path = _absolute(path)
        self.fd = _absolute_directory(self.path) if descriptor is None else descriptor
        self.initial = os.fstat(self.fd)
        self.tag = tag
        self.observed = {}
        self.observed_files = {}
        self.absent = set()

    def __enter__(self):
        return self

    def __exit__(self, *unused):
        os.close(self.fd)

    def directory(self, relative=""):
        fd = os.dup(self.fd)
        try:
            for part in _parts(relative, empty=True):
                following = os.open(part, _directory_flags(), dir_fd=fd)
                os.close(fd)
                fd = following
            return fd
        except BaseException:
            os.close(fd)
            raise

    def info(self, relative):
        parts = _parts(relative)
        fd = self.directory("/".join(parts[:-1]))
        try:
            return os.stat(parts[-1], dir_fd=fd, follow_symlinks=False)
        finally:
            os.close(fd)

    def exists(self, relative):
        try:
            self.info(relative)
            return True
        except FileNotFoundError:
            self.absent.add(relative)
            return False

    def observe_directory(self, relative):
        fd = self.directory(relative)
        try:
            identity = _identity(os.fstat(fd))
            if self.observed.setdefault(relative, identity) != identity:
                raise RuntimeError("report directory identity changed: " + relative)
        finally:
            os.close(fd)

    def names(self, relative, observe=False, limit=None, partial=False):
        limit = REPORT_ENTRY_LIMIT if limit is None else min(limit, REPORT_ENTRY_LIMIT)
        fd = self.directory(relative)
        try:
            before = _identity(os.fstat(fd))
            names, overflow = [], False
            with os.scandir(fd) as entries:
                for entry in entries:
                    if len(names) == limit:
                        overflow = True
                        break
                    names.append(entry.name)
            if before != _identity(os.fstat(fd)):
                raise RuntimeError("report directory changed while listed: " + relative)
            if observe:
                previous = self.observed.setdefault(relative, before)
                if previous != before:
                    raise RuntimeError("report directory identity changed: " + relative)
            if overflow and not partial:
                raise ValueError("report directory exceeds inventory entry limit: " + relative)
            names.sort()
            return (names, overflow) if partial else names
        finally:
            os.close(fd)

    def read(self, relative, sink=None, limit=None, collect=False, expected=None):
        parts = _parts(relative)
        parent = self.directory("/".join(parts[:-1]))
        fd = None
        try:
            fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                         dir_fd=parent)
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
                raise ValueError("report source must be a regular unlinked file: " + relative)
            identity = _identity(before)
            if expected is not None and identity != expected:
                raise RuntimeError("report source identity changed: " + relative)
            if limit is not None and before.st_size > limit:
                raise ValueError("report file exceeds limit: " + relative)
            digest = hashlib.sha256()
            count = 0
            pieces = [] if collect else None
            while True:
                block = os.read(fd, CHUNK)
                if not block:
                    break
                count += len(block)
                if count > before.st_size or (limit is not None and count > limit):
                    raise RuntimeError("report source grew while read: " + relative)
                digest.update(block)
                if sink is not None:
                    sink(block)
                if collect:
                    pieces.append(block)
            after = os.fstat(fd)
            current = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
            if (identity != _identity(after) or identity != _identity(current)
                    or count != before.st_size):
                raise RuntimeError("report source changed while read: " + relative)
            digest = digest.hexdigest()
            observed = (identity, digest)
            if self.observed_files.setdefault(relative, observed) != observed:
                raise RuntimeError("report source changed between reads: " + relative)
            return count, digest, identity, b"".join(pieces) if collect else None
        finally:
            if fd is not None:
                os.close(fd)
            os.close(parent)

    def json(self, relative, limit=JSON_LIMIT):
        count, digest, identity, data = self.read(relative, limit=limit, collect=True)
        value = json.loads(data)
        if not isinstance(value, dict):
            raise ValueError("report metadata must be an object: " + relative)
        return value, digest, identity

    def check(self):
        fd = _absolute_directory(self.path)
        try:
            current = os.fstat(fd)
            if (current.st_dev, current.st_ino) != (self.initial.st_dev, self.initial.st_ino):
                raise RuntimeError("report root was replaced")
        finally:
            os.close(fd)
        for relative, expected in self.observed.items():
            fd = self.directory(relative)
            try:
                if _identity(os.fstat(fd)) != expected:
                    raise RuntimeError("report directory changed: " + relative)
            finally:
                os.close(fd)
        for relative, (expected, unused_digest) in self.observed_files.items():
            if _identity(self.info(relative)) != expected:
                raise RuntimeError("report file changed after reading: " + relative)
        for relative in self.absent:
            try:
                self.info(relative)
            except FileNotFoundError:
                continue
            raise RuntimeError("report source appeared during export: " + relative)

    def mkdirs(self, relative):
        fd = os.dup(self.fd)
        try:
            for part in _parts(relative):
                try:
                    os.mkdir(part, mode=0o700, dir_fd=fd)
                except FileExistsError:
                    pass
                following = os.open(part, _directory_flags(), dir_fd=fd)
                os.close(fd)
                fd = following
        finally:
            os.close(fd)

    def create(self, relative, producer):
        parts = _parts(relative)
        parent = self.directory("/".join(parts[:-1]))
        fd = None
        try:
            fd = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=parent)
            def write(block):
                remaining = memoryview(block)
                while remaining:
                    written = os.write(fd, remaining)
                    if written <= 0:
                        raise OSError("short report write")
                    remaining = remaining[written:]
            result = producer(write)
            os.fsync(fd)
            return result
        finally:
            if fd is not None:
                os.close(fd)
            os.close(parent)


def _raw_payload(path):
    name = PurePosixPath(path).name.lower()
    if name == "persistent-profiles.tar.zst":
        return True
    for suffix in RAW_SUFFIXES:
        if name.endswith(suffix) or any(name.endswith(suffix + tail)
                                       for tail in ("-wal", "-shm", "-journal")):
            return True
    return False


class _Selection:
    def __init__(self, source, run_id, failed_profiles, limit):
        self.source = source
        self.run_id = run_id
        self.failed_profiles = failed_profiles
        self.limit = limit
        self.files = {}
        self.directories = set()
        self.omissions = []
        self.diagnostic_bytes = 0
        self.bytes = 0
        self.directory("test-results")

    def entry_budget(self):
        # Owner and final manifest are reserved before any destination is created.
        if len(self.files) + len(self.directories) + len(self.omissions) + 2 > REPORT_ENTRY_LIMIT:
            raise ValueError("stable report exceeds total inventory entry limit")

    def omit(self, path, reason):
        self.omissions.append({"path": path, "reason": reason})
        self.entry_budget()

    def directory(self, relative):
        parts = _parts(relative)
        for size in range(1, len(parts) + 1):
            self.directories.add("/".join(parts[:size]))
        self.entry_budget()

    def add(self, output, source=None, path=None, data=None, expected_sha=None):
        if output in self.files or output in self.directories:
            raise ValueError("duplicate export path: " + output)
        _parts(output)
        self.directory(str(PurePosixPath(output).parent))
        if source is not None:
            info = source.info(path)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise ValueError("selected report is not a regular unlinked file: " + path)
            size = info.st_size
            identity = _identity(info)
        else:
            size, identity = len(data), None
        self.bytes += size
        if self.bytes > self.limit:
            raise ValueError("stable report exceeds total report limit")
        self.files[output] = {"source": source, "path": path, "data": data,
                              "identity": identity, "bytes": size, "sha256": expected_sha}
        self.entry_budget()

    def ordinary(self, source_path, output):
        self.directory(output)
        for name in self.source.names(source_path, observe=True):
            _parts(name)
            path, target = source_path + "/" + name, output + "/" + name
            if output == "test-results" and name == "persistent-profiles":
                self.profiles(path, target)
                continue
            if (target in (MANIFEST, OWNER) or target in PUBLICATION_MARKERS
                    or target in ("test-results/failure-diagnostics", "test-results/command.log")):
                raise ValueError("source contains reserved export metadata: " + target)
            if _raw_payload(target):
                raise ValueError("raw environment payload in report tree: " + path)
            info = self.source.info(path)
            if stat.S_ISDIR(info.st_mode):
                self.ordinary(path, target)
            elif stat.S_ISREG(info.st_mode):
                self.add(target, self.source, path)
            else:
                raise ValueError("unsafe or raw payload in report tree: " + path)

    def profiles(self, source_path, output):
        self.directory(output)
        for name in self.source.names(source_path, observe=True):
            _parts(name)
            path, target = source_path + "/" + name, output + "/" + name
            self.source.observe_directory(path)
            owner_path = path + "/resource-owner.json"
            owner, owner_sha, unused = self.source.json(owner_path, MARKER_LIMIT)
            if type(owner.get("version")) is not int or owner["version"] != 1 or owner.get("runId") != self.run_id \
                    or owner.get("kind") != "browser-profile":
                raise ValueError("profile owner does not match this run: " + name)
            self.add(target + "/resource-owner.json", self.source, owner_path,
                     expected_sha=owner_sha)
            if self.source.exists(path + "/opfs-archive"):
                self.opfs(path + "/opfs-archive", target + "/opfs-archive")
            self.add(target + "/retention.json", data=_json_bytes({
                "version": 1, "runId": self.run_id, "profile": name,
                "rawDisposition": DISPOSITION, "rawRetainedAtSource": True,
            }))
            if self.failed_profiles is None or name in self.failed_profiles:
                self.diagnostics(path, name)

    def opfs(self, path, output):
        manifest, digest, unused = self.source.json(path + "/manifest.json")
        cleanup, cleanup_sha, unused = self.source.json(path + "/cleanup.json", MARKER_LIMIT)
        namespace = manifest.get("namespace")
        if not isinstance(namespace, str) or not namespace or cleanup.get("removed") is not True \
                or cleanup.get("namespace") != namespace:
            raise ValueError("OPFS cleanup proof does not match archive")
        files = manifest.get("files")
        directories = manifest.get("directories", [])
        if not isinstance(files, list) or not isinstance(directories, list):
            raise ValueError("invalid OPFS manifest")
        allowed_files = {"manifest.json", "cleanup.json"}
        allowed_dirs = {""}
        for directory in directories:
            parts = _opfs_parts(directory, empty=True)
            for size in range(len(parts) + 1):
                allowed_dirs.add("/".join(("files",) + parts[:size]))
        for entry in files:
            if not isinstance(entry, dict) or not _is_count(entry.get("bytes")) \
                    or not _is_sha(entry.get("sha256")):
                raise ValueError("invalid OPFS file entry")
            parts = _opfs_parts(entry.get("path"))
            relative = "/".join(("files",) + parts)
            if relative in allowed_files:
                raise ValueError("duplicate OPFS file")
            allowed_files.add(relative)
            for size in range(len(parts)):
                allowed_dirs.add("/".join(("files",) + parts[:size]))
            if self.source.info(path + "/" + relative).st_size != entry["bytes"]:
                raise ValueError("OPFS proof size does not match")
            self.add(output + "/" + relative, self.source, path + "/" + relative,
                     expected_sha=entry["sha256"])
        if allowed_files & allowed_dirs:
            raise ValueError("OPFS file/directory collision")
        for relative in sorted(allowed_dirs):
            current = path + ("/" + relative if relative else "")
            self.directory(output + ("/" + relative if relative else ""))
            for name in self.source.names(current, observe=True):
                child = relative + "/" + name if relative else name
                if child not in allowed_files and child not in allowed_dirs:
                    raise ValueError("unlisted OPFS archive member: " + child)
        self.add(output + "/manifest.json", self.source, path + "/manifest.json",
                 expected_sha=digest)
        self.add(output + "/cleanup.json", self.source, path + "/cleanup.json",
                 expected_sha=cleanup_sha)

    def diagnostics(self, profile, name):
        case_bytes = 0
        scanned = 0
        selected = 0
        pending = [(profile, "")]
        skipped_names = {"opfs-archive", "Cache", "Code Cache", "GPUCache"}
        while pending:
            directory, relative = pending.pop()
            names, overflow = self.source.names(directory, observe=True,
                limit=max(0, DIAGNOSTIC_SCAN_COUNT - scanned), partial=True)
            following = []
            for filename in names:
                scanned += 1
                if scanned > DIAGNOSTIC_SCAN_COUNT or selected >= DIAGNOSTIC_FILE_COUNT:
                    self.omit(name, "diagnostic-entry-limit")
                    return
                if filename in skipped_names or (not relative and filename in {
                        "resource-owner.json", "retention.json", "raw-transfer.json"}):
                    continue
                child = relative + "/" + filename if relative else filename
                path = profile + "/" + child
                info = self.source.info(path)
                if stat.S_ISDIR(info.st_mode):
                    following.append((path, child))
                    continue
                if PurePosixPath(filename).suffix.lower() not in DIAGNOSTIC_SUFFIXES:
                    continue
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    self.omit(name + "/" + child, "linked-or-special")
                    continue
                size = info.st_size
                reason = ("diagnostic-file-limit" if size > DIAGNOSTIC_FILE_LIMIT else
                          "diagnostic-case-limit" if case_bytes + size > DIAGNOSTIC_CASE_LIMIT else
                          "diagnostic-run-limit" if self.diagnostic_bytes + size > DIAGNOSTIC_RUN_LIMIT else None)
                if reason:
                    self.omit(name + "/" + child, reason)
                    continue
                self.add("test-results/failure-diagnostics/" + name + "/" + child,
                         self.source, path)
                case_bytes += size
                self.diagnostic_bytes += size
                selected += 1
            if overflow:
                self.omit(name, "diagnostic-entry-limit")
                return
            pending.extend(reversed(following))

    def execute(self, destination=None):
        entries, sources = [], []
        if destination is not None:
            for directory in sorted(self.directories, key=lambda path: (path.count("/"), path)):
                destination.mkdirs(directory)
        for output, spec in sorted(self.files.items()):
            def produce(sink):
                if spec["source"] is None:
                    data = spec["data"]
                    if sink is not None:
                        sink(data)
                    return len(data), hashlib.sha256(data).hexdigest(), None, None
                return spec["source"].read(spec["path"], sink=sink,
                                            expected=spec["identity"], limit=spec["bytes"])
            size, digest, identity, unused = (destination.create(output, produce)
                                            if destination else produce(None))
            if spec["sha256"] is not None and spec["sha256"] != digest:
                raise ValueError("report content does not match declared digest: " + output)
            entries.append({"path": output, "bytes": size, "sha256": digest})
            if spec["source"] is not None:
                sources.append({"source": spec["source"].tag, "path": spec["path"],
                                "identity": list(identity), "bytes": size, "sha256": digest})
        # A second complete source pass proves the bytes did not change after
        # copying an earlier file while later files were being exported.
        source_trees = {self.source.tag: self.source}
        source_trees.update({spec["source"].tag: spec["source"] for spec in self.files.values()
                             if spec["source"] is not None})
        for record in sources:
            size, digest, unused, unused_data = source_trees[record["source"]].read(
                record["path"], expected=tuple(record["identity"]), limit=record["bytes"])
            if size != record["bytes"] or digest != record["sha256"]:
                raise RuntimeError("report source changed after export")
        for tree in source_trees.values():
            tree.check()
        return entries, sources


def _select(source, run_id, failed_profiles, report_limit, command):
    selection = _Selection(source, run_id, failed_profiles, report_limit)
    for leaf in LEAVES:
        path = "tests/e2e/" + leaf
        if source.exists(path):
            selection.ordinary(path, leaf)
    if command is not None:
        selection.add("test-results/command.log", command, "command.log")
    return selection


def _validate_run_id(run_id):
    if not isinstance(run_id, str) or not run_id or len(run_id) > 128 \
            or any(character in run_id for character in ("/", "\\", "\0")):
        raise ValueError("invalid report run ID")


def _manifest(selection, run_id, owner_bytes, entries, sources):
    return {
        "version": 1, "runId": run_id, "complete": True,
        "rawDisposition": DISPOSITION, "entries": entries,
        "directories": sorted(selection.directories),
        "diagnosticBytes": selection.diagnostic_bytes, "omissions": selection.omissions,
        "ownerSha256": hashlib.sha256(owner_bytes).hexdigest(), "sources": sources,
        "sourceDirectories": [{"source": selection.source.tag, "path": path, "identity": list(identity)}
                              for path, identity in sorted(selection.source.observed.items())],
    }


def _metadata_budget(manifest, selection, owner_bytes, report_limit):
    # Count encoded chunks instead of constructing an oversized manifest string.
    size = 1  # trailing newline from _json_bytes
    encoder = json.JSONEncoder(ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    for chunk in encoder.iterencode(manifest):
        size += len(chunk.encode("utf-8"))
        if size > JSON_LIMIT or selection.bytes + len(owner_bytes) + size > report_limit:
            raise ValueError("stable report including metadata exceeds report limit")


def _preflight_metadata(selection, run_id, owner_bytes, report_limit):
    # Every final digest has this exact encoded length. Identities and sizes were
    # captured during selection and execute() rejects any subsequent change.
    entries, sources = [], []
    for output, spec in sorted(selection.files.items()):
        entries.append({"path": output, "bytes": spec["bytes"], "sha256": "0" * 64})
        if spec["source"] is not None:
            sources.append({"source": spec["source"].tag, "path": spec["path"],
                            "identity": list(spec["identity"]), "bytes": spec["bytes"], "sha256": "0" * 64})
    _metadata_budget(_manifest(selection, run_id, owner_bytes, entries, sources),
                     selection, owner_bytes, report_limit)


def snapshot_reports(scratch, destination, run_id, failed_profiles,
                     command_log=None, report_limit=REPORT_LIMIT):
    """Export only reports; caller must already hold the run's producer lease."""
    _validate_run_id(run_id)
    if not _is_count(report_limit) or report_limit == 0:
        raise ValueError("invalid report limit")
    scratch, destination = _absolute(scratch), _absolute(destination)
    if scratch == destination or scratch in destination.parents or destination in scratch.parents:
        raise ValueError("source and export roots must be disjoint")
    if command_log is not None and _absolute(command_log) != scratch.parent / "command.log":
        raise ValueError("only this run's command.log may be exported")
    command = None
    try:
        with _Tree(scratch, "scratch") as source, _Tree(destination.parent) as parent:
            if command_log is not None:
                command = _Tree(scratch.parent, "run")
            selection = _select(source, run_id, failed_profiles, report_limit, command)
            owner = {"version": 1, "kind": "stable-report-snapshot", "runId": run_id,
                     "source": str(scratch), "sourceIdentity": [source.initial.st_dev, source.initial.st_ino]}
            owner_bytes = _json_bytes(owner)
            _preflight_metadata(selection, run_id, owner_bytes, report_limit)
            existing = parent.exists(destination.name)
            if existing:
                receipt = verify_snapshot(destination, run_id)
                with _Tree(destination) as target:
                    current, unused, unused_identity = target.json(MANIFEST)
                    old_owner, unused, unused_identity = target.json(OWNER, MARKER_LIMIT)
                    if old_owner != owner:
                        raise ValueError("snapshot destination belongs to another source")
                    entries, sources = selection.execute()
                    manifest = _manifest(selection, run_id, owner_bytes, entries, sources)
                    _metadata_budget(manifest, selection, owner_bytes, report_limit)
                    if current != manifest:
                        raise ValueError("existing complete snapshot no longer matches source")
                    target.check()
                return receipt
            os.mkdir(destination.name, mode=0o700, dir_fd=parent.fd)
            descriptor = os.open(destination.name, _directory_flags(), dir_fd=parent.fd)
            with _Tree(destination, descriptor=descriptor) as target:
                # Keep the created directory FD through the final manifest; a
                # replaced path must never redirect any later writes.
                target.check()
                target.mkdirs("test-results")
                target.create(OWNER, lambda write: write(owner_bytes))
                entries, sources = selection.execute(target)
                manifest = _manifest(selection, run_id, owner_bytes, entries, sources)
                _metadata_budget(manifest, selection, owner_bytes, report_limit)
                target.check()
                target.create(MANIFEST, lambda write: write(_json_bytes(manifest)))
                target.check()
            return verify_snapshot(destination, run_id)
    finally:
        if command is not None:
            command.__exit__()


def _receipt(data, digest):
    return {"manifest": MANIFEST, "sha256": digest, "files": len(data["entries"]),
            "bytes": sum(entry["bytes"] for entry in data["entries"]), "complete": True}


def _verify_profiles(tree, expected, run_id):
    prefix = "test-results/persistent-profiles"
    if not tree.exists(prefix):
        return
    for name in tree.names(prefix):
        profile = prefix + "/" + name
        owner, unused, unused_identity = tree.json(profile + "/resource-owner.json", MARKER_LIMIT)
        retention, unused, unused_identity = tree.json(profile + "/retention.json", MARKER_LIMIT)
        if type(owner.get("version")) is not int or owner["version"] != 1 \
                or owner.get("runId") != run_id or owner.get("kind") != "browser-profile":
            raise ValueError("exported profile owner mismatch")
        if retention.get("runId") != run_id or retention.get("rawDisposition") != DISPOSITION \
                or retention.get("rawRetainedAtSource") is not True:
            raise ValueError("exported profile retention mismatch")
        allowed = {profile + "/resource-owner.json", profile + "/retention.json"}
        if tree.exists(profile + "/opfs-archive"):
            selection = _Selection(tree, run_id, set(), REPORT_LIMIT)
            selection.opfs(profile + "/opfs-archive", profile + "/opfs-archive")
            allowed.update(selection.files)
            selection.execute()
        actual = {path for path in expected if path.startswith(profile + "/")}
        if actual != allowed:
            raise ValueError("raw or incomplete profile in stable export")


def verify_snapshot(root, run_id, receipt=None):
    """Verify the two report leaves only; a published root may also hold source."""
    _validate_run_id(run_id)
    with _Tree(root) as tree:
        owner, owner_digest, owner_identity = tree.json(OWNER, MARKER_LIMIT)
        if type(owner.get("version")) is not int or owner["version"] != 1 \
                or owner.get("kind") != "stable-report-snapshot" \
                or owner.get("runId") != run_id:
            raise ValueError("snapshot owner mismatch")
        manifest, manifest_digest, manifest_identity = tree.json(MANIFEST)
        if type(manifest.get("version")) is not int or manifest["version"] != 1 or manifest.get("runId") != run_id \
                or manifest.get("complete") is not True or manifest.get("rawDisposition") != DISPOSITION \
                or manifest.get("ownerSha256") != owner_digest:
            raise ValueError("invalid stable export manifest")
        entries, directories = manifest.get("entries"), manifest.get("directories")
        if not isinstance(entries, list) or not isinstance(directories, list) \
                or not _is_count(manifest.get("diagnosticBytes")) or not isinstance(manifest.get("omissions"), list):
            raise ValueError("invalid stable export inventory")
        if len(entries) + len(directories) + len(manifest["omissions"]) + 2 > REPORT_ENTRY_LIMIT:
            raise ValueError("stable export exceeds total inventory entry limit")
        expected = {}
        diagnostic_bytes, diagnostic_cases = 0, {}
        for entry in entries:
            if not isinstance(entry, dict) or not _is_count(entry.get("bytes")) or not _is_sha(entry.get("sha256")):
                raise ValueError("invalid stable export entry")
            path = entry.get("path")
            parts = _parts(path)
            if parts[0] not in LEAVES or len(parts) < 2 or path in (MANIFEST, OWNER) \
                    or path in PUBLICATION_MARKERS or path in expected:
                raise ValueError("invalid or duplicate stable export path")
            if not path.startswith("test-results/persistent-profiles/") and _raw_payload(path):
                raise ValueError("raw environment payload in stable export")
            if path.startswith("test-results/failure-diagnostics/"):
                if len(parts) < 4 or PurePosixPath(path).suffix.lower() not in DIAGNOSTIC_SUFFIXES \
                        or entry["bytes"] > DIAGNOSTIC_FILE_LIMIT:
                    raise ValueError("invalid failure diagnostic")
                diagnostic_bytes += entry["bytes"]
                diagnostic_cases[parts[2]] = diagnostic_cases.get(parts[2], 0) + entry["bytes"]
            expected[path] = entry
        if diagnostic_bytes != manifest["diagnosticBytes"] or diagnostic_bytes > DIAGNOSTIC_RUN_LIMIT \
                or any(size > DIAGNOSTIC_CASE_LIMIT for size in diagnostic_cases.values()):
            raise ValueError("failure diagnostic budget mismatch")
        expected_dirs = set()
        for directory in directories:
            if _parts(directory)[0] not in LEAVES or directory in expected_dirs or directory in expected:
                raise ValueError("invalid stable export directory")
            expected_dirs.add(directory)
        if "test-results" not in expected_dirs:
            raise ValueError("missing stable export root")
        seen_files, seen_dirs = set(), set()
        pending = [leaf for leaf in LEAVES if tree.exists(leaf)]
        while pending:
            directory = pending.pop()
            seen_dirs.add(directory)
            for name in tree.names(directory, observe=True):
                path = directory + "/" + name
                info = tree.info(path)
                if stat.S_ISDIR(info.st_mode):
                    if path not in expected_dirs:
                        raise ValueError("unlisted stable export directory: " + path)
                    pending.append(path)
                    continue
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    raise ValueError("linked or special export member")
                if path in PUBLICATION_MARKERS:
                    marker, unused, unused_identity = tree.json(path, MARKER_LIMIT)
                    if marker.get("runId") != run_id:
                        raise ValueError("publication metadata belongs to another run")
                elif path in (MANIFEST, OWNER):
                    continue
                elif path in expected:
                    size, digest, unused, unused_data = tree.read(path, limit=expected[path]["bytes"])
                    if size != expected[path]["bytes"] or digest != expected[path]["sha256"]:
                        raise ValueError("stable report content mismatch: " + path)
                    seen_files.add(path)
                else:
                    raise ValueError("unlisted stable export file: " + path)
        if seen_files != set(expected) or seen_dirs != expected_dirs:
            raise ValueError("stable export inventory mismatch")
        _verify_profiles(tree, expected, run_id)
        tree.check()
        current = _receipt(manifest, manifest_digest)
        if current["bytes"] + owner_identity[3] + manifest_identity[3] > REPORT_LIMIT:
            raise ValueError("stable report exceeds total report limit")
        if receipt is not None and receipt != current:
            raise ValueError("stable export receipt mismatch")
        return current
