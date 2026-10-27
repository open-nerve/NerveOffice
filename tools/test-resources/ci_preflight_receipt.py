"""Bounded diagnostic receipts; collection success is not preflight success."""
from contextlib import ExitStack
import errno
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import sys

MAX_BYTES = 64 * 1024
RUN_ID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")


class Rejected(Exception):
    """Only fixed, collector-owned error codes reach the output."""


def _result(status="missing", rows=None, error=None):
    return {"version": 1, "kind": "ci-preflight", "collectionStatus": status,
            "runs": rows or [], "error": error}


def _open(stack, name, parent=None, directory=False):
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    if directory:
        flags |= os.O_DIRECTORY
    try:
        fd = os.open(name, flags, dir_fd=parent)
    except OSError as error:
        if error.errno in (errno.ELOOP, errno.ENOTDIR):
            raise Rejected("unsafe-path") from None
        raise
    stack.callback(os.close, fd)
    mode = os.fstat(fd).st_mode
    if not (stat.S_ISDIR(mode) if directory else stat.S_ISREG(mode)):
        raise Rejected("unsafe-path")
    return fd


def _directory(stack, path):
    if not path.is_absolute() or ".." in path.parts:
        raise Rejected("unsafe-path")
    parent = _open(stack, path.anchor, directory=True)
    for name in path.parts[1:]:
        parent = _open(stack, name, parent, directory=True)
    return parent


def _pairs(items):
    value = {}
    for key, item in items:
        if key in value:
            raise ValueError()
        value[key] = item
    return value


def _read(parent, name):
    with ExitStack() as stack:
        fd = _open(stack, name, parent)
        if os.fstat(fd).st_size > MAX_BYTES:
            raise Rejected("manifest-too-large")
        raw = bytearray()
        while len(raw) <= MAX_BYTES:
            block = os.read(fd, MAX_BYTES + 1 - len(raw))
            if not block:
                break
            raw.extend(block)
        if len(raw) > MAX_BYTES:
            raise Rejected("manifest-too-large")
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=_pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError, UnicodeError, RecursionError):
        raise Rejected("invalid-json") from None


def _exists(parent, name):
    try:
        value = os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return False
    if not stat.S_ISDIR(value.st_mode):
        raise Rejected("unsafe-path")
    return True


def _identity(data, identity, repo):
    if (not isinstance(data, dict) or type(data.get("version")) is not int
            or data["version"] != 1 or data.get("runId") != identity
            or data.get("repo") != str(repo) or not isinstance(data.get("kind"), str)
            or not re.fullmatch(r"[a-z0-9-]{1,64}", data["kind"])):
        raise Rejected("invalid-manifest")


def _row(data, identity, directory):
    status = data.get("status")
    if status in ("prepared", "running"):
        raise Rejected("run-not-ended")
    stage, code, group = data.get("cleanupStage"), data.get("exitCode"), data.get("childGroup")
    if (status not in ("passed", "failed", "interrupted", "cleanup-pending")
            or "childGroup" not in data
            or stage not in (None, "creation-incomplete", "reports-collected", "complete", "never-started")
            or (code is not None and (type(code) is not int or not 0 <= code <= 255))
            or (group is not None and (type(group) is not int or not 0 < group <= 2147483647))
            or (data.get("cleanupError") is not None and not isinstance(data["cleanupError"], str))):
        raise Rejected("invalid-manifest")
    scratch = _exists(directory, "scratch")
    short = None
    if "shortRoot" in data:
        expected = Path("/tmp").resolve() / ("nerve-t-" + identity)
        if data["shortRoot"] != str(expected):
            raise Rejected("invalid-run-path")
        with ExitStack() as stack:
            short = _exists(_directory(stack, expected.parent), expected.name)
    if ((stage in ("complete", "never-started") and (scratch or short))
            or (stage == "never-started" and (status != "interrupted" or group is not None))
            or (status != "cleanup-pending" and stage not in ("complete", "never-started"))
            or (status == "cleanup-pending" and stage == "complete")
            or (status == "passed" and code != 0)
            or (status == "failed" and code in (None, 0))):
        raise Rejected("inconsistent-record")
    error, truncated = None, False
    if data.get("cleanupError") is not None:
        text = "".join(c if c.isprintable() else "?" for c in data["cleanupError"])
        try:
            encoded = text.encode("utf-8")
        except UnicodeError:
            raise Rejected("invalid-manifest") from None
        error, truncated = encoded[:2048].decode("utf-8", errors="ignore"), len(encoded) > 2048
    return {"runId": identity, "kind": "ci-preflight", "status": status,
            "cleanupStage": stage, "exitCode": code, "childGroup": group,
            "scratchExists": scratch, "shortRootExists": short,
            "cleanupError": error, "cleanupErrorTruncated": truncated}


def collect(repo):
    """Read only bounded, unlocked preflight records; never authorize cleanup."""
    try:
        repo = Path(repo)
        with ExitStack() as stack:
            repository = _directory(stack, repo)
            try:
                root = _open(stack, ".test-resources", repository, directory=True)
            except FileNotFoundError:
                return _result()
            owner = _read(root, "owner.json")
            if (not isinstance(owner, dict) or type(owner.get("version")) is not int
                    or owner != {"version": 1, "purpose": "nerve-office-test-resources", "repo": str(repo)}):
                raise Rejected("invalid-owner")
            runs = _open(stack, "runs", root, directory=True)
            names = []
            with os.scandir(runs) as entries:
                for entry in entries:
                    names.append(entry.name)
                    if len(names) > 128:
                        raise Rejected("too-many-run-directories")
            rows = []
            for identity in sorted(names):
                if not RUN_ID.fullmatch(identity):
                    raise Rejected("unsafe-path")
                with ExitStack() as run_stack:
                    directory = _open(run_stack, identity, runs, directory=True)
                    data = _read(directory, "run.json")
                    _identity(data, identity, repo)
                    if data["kind"] != "ci-preflight":
                        continue
                    if len(rows) == 4:
                        raise Rejected("too-many-preflights")
                    lock = _open(run_stack, "run.lock", directory)
                    try:
                        fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
                    except BlockingIOError:
                        raise Rejected("active-run") from None
                    # The first read selects kind; only the locked reread is summarized.
                    data = _read(directory, "run.json")
                    _identity(data, identity, repo)
                    if data["kind"] != "ci-preflight":
                        raise Rejected("record-changed")
                    rows.append(_row(data, identity, directory))
            result = _result("collected", rows) if rows else _result()
            if len(json.dumps(result, ensure_ascii=False).encode("utf-8")) + 1 > MAX_BYTES:
                raise Rejected("output-too-large")
            return result
    except Rejected as error:
        return _result("rejected", error=error.args[0])
    except OSError:
        return _result("rejected", error="read-failed")
    except Exception:
        # No arbitrary exception, command, environment or unrelated run is printed.
        return _result("rejected", error="collection-failed")


def main():
    result = (_result("rejected", error="unexpected-arguments") if len(sys.argv) != 1
              else collect(Path(__file__).resolve().parents[2]))
    print(json.dumps(result, ensure_ascii=False))
    return 1 if result["collectionStatus"] == "rejected" else 0


if __name__ == "__main__":
    sys.exit(main())
