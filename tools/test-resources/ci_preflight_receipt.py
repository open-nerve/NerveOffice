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


def _hosted_row(data, identity):
    """Summarize declared hosted evidence, without reading raw resources or authorizing disposal."""
    def require(condition):
        if not condition:
            raise Rejected("invalid-hosted-record")

    def text(value, limit):
        return (type(value) is str and 0 < len(value) <= limit
                and all(ord(character) >= 32 and ord(character) != 127 for character in value))

    def integer(value):
        return type(value) is int and 0 <= value <= 2 ** 63 - 1

    scope = data.get("hostedScope")
    require(type(scope) is dict and set(scope) == {"version", "policy", "context", "runId", "roots"})
    require(type(scope["version"]) is int and scope["version"] == 1
            and scope["policy"] == "github-hosted-vm" and scope["runId"] == identity)
    context = scope["context"]
    keys = {"version", "policy", "repo", "repository", "sha", "runId", "attempt", "job", "runner", "bootId"}
    require(type(context) is dict and set(context) == keys)
    require(type(context["version"]) is int and context["version"] == 1
            and context["policy"] == "github-hosted-vm" and context["repo"] == data["repo"])
    for key, limit, pattern in (("repository", 201, r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+"),
                                ("sha", 40, r"[0-9a-f]{40}"), ("runId", 20, r"[1-9][0-9]*"),
                                ("attempt", 10, r"[1-9][0-9]*"),
                                ("bootId", 36, r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")):
        require(text(context[key], limit) and re.fullmatch(pattern, context[key]) is not None)
    require(text(context["job"], 32) and context["job"] in ("verify", "e2e", "container")
            and text(context["runner"], 128))
    repo = Path(data["repo"])
    run = repo / ".test-resources/runs" / identity
    require(scope["roots"] == {"scratch": str(run / "scratch"),
                               "short": str(Path("/tmp").resolve() / ("nerve-t-" + identity)),
                               "reports": str(run / "reports"),
                               "failures": str(repo / ".test-resources/failures" / identity)})
    require(data.get("cleanupComplete") is False and data.get("producerQuiescent") is True)

    export = data.get("stableExport")
    require(type(export) is dict and set(export) == {"manifest", "sha256", "files", "bytes", "complete"})
    require(export["manifest"] == "test-results/stable-export.json" and export["complete"] is True
            and text(export["sha256"], 64) and re.fullmatch(r"[0-9a-f]{64}", export["sha256"]) is not None
            and integer(export["files"]) and integer(export["bytes"]))
    budget = data.get("resourceBudget")
    require(type(budget) is dict and set(budget) == {"bytes", "files", "freeBytes", "limitBytes", "reserveBytes", "reportBytes"})
    require(all(integer(value) for value in budget.values())
            and budget["bytes"] <= budget["limitBytes"] and budget["freeBytes"] >= budget["reserveBytes"])
    observation = data.get("referenceObservation")
    require(type(observation) is dict and integer(observation.get("incompleteRecordCount"))
            and observation.get("absenceProven") is False and observation.get("rawDeletionAuthorized") is False)
    # These are declared facts only: the full checker separately validates the live host,
    # producer identities, stable hashes and limits. No resource content is read here.
    return {"cleanupComplete": False, "producerQuiescent": True, "validation": "diagnostic-only",
            "hostedContext": {key: value for key, value in context.items() if key != "repo"},
            "stableExport": export, "resourceBudget": budget,
            "referenceObservation": {key: observation[key] for key in
                                     ("incompleteRecordCount", "absenceProven", "rawDeletionAuthorized")}}


def _row(data, identity, directory):
    status = data.get("status")
    if status in ("prepared", "running"):
        raise Rejected("run-not-ended")
    stage, code, group = data.get("cleanupStage"), data.get("exitCode"), data.get("childGroup")
    if (status not in ("passed", "failed", "interrupted", "cleanup-pending")
            or "childGroup" not in data
            or stage not in (None, "creation-incomplete", "reports-collected", "complete", "never-started", "host-disposal-pending")
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
    hosted_pending = stage == "host-disposal-pending"
    if ((stage in ("complete", "never-started") and (scratch or short))
            or (stage == "never-started" and (status != "interrupted" or group is not None))
            or (status != "cleanup-pending" and stage not in ("complete", "never-started") and not hosted_pending)
            or (status == "cleanup-pending" and stage == "complete")
            or (status == "passed" and code != 0)
            or (status == "failed" and code in (None, 0))
            or (hosted_pending and (status not in ("passed", "failed", "interrupted") or code is None
                                   or (status != "passed" and code == 0)
                                   or (status == "passed" and data.get("interrupted") is not False)))):
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
            "cleanupError": error, "cleanupErrorTruncated": truncated,
            **(_hosted_row(data, identity) if hosted_pending else {})}


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
