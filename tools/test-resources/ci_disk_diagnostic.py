"""Bounded read-only verify disk observations; never resource or product acceptance."""
from contextlib import contextmanager
import datetime
import errno
import json
import os
from pathlib import Path
import signal
import stat
import sys
import time

import hosted

PHASES = {"before-install", "after-install", "after-verify"}
QUERY_SECONDS = 5
TOTAL_SECONDS = 45
MAX_ENTRIES = 200_000
TOTAL_ENTRIES = 500_000
MAX_DEPTH = 64
MAX_ANCESTORS = 64
MAX_OUTPUT = 32 * 1024
FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC


class Rejected(Exception):
    """Only constant reason codes created here may reach the log."""


@contextmanager
def deadline(seconds):
    if signal.getitimer(signal.ITIMER_REAL) != (0.0, 0.0):
        raise Rejected("timer-in-use")
    previous = signal.getsignal(signal.SIGALRM)

    def expired(_signum, _frame):
        raise Rejected("query-timeout")

    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


@contextmanager
def directory(path):
    """Anchor every component by fd; never follow an ancestor or leaf link."""
    path = Path(path)
    if (not path.is_absolute() or str(path) != os.path.normpath(str(path))
            or len(str(path)) > 4096 or len(path.parts) > MAX_ANCESTORS):
        raise Rejected("unsafe-path")
    fd = os.open(path.anchor, FLAGS)
    try:
        for name in path.parts[1:]:
            child = os.open(name, FLAGS, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


def identity(info):
    return info.st_dev, info.st_ino


def empty_row():
    return {"status": "partial", "error": None, "errno": None,
            "owner": None, "filesystem": None, "entries": 0, "files": 0,
            "directories": 0, "symlinks": 0, "specialFiles": 0,
            "hardlinkDuplicates": 0, "logicalFileBytes": 0, "allocatedBytes": 0}


def measure(path, budget, *, seconds=None):
    """Independent per-root totals: regular logical bytes, unique-inode allocation.

    Link targets and special-file content are never opened. Overlapping rows
    must not be summed. Partial totals are lower bounds, not completed sizes.
    """
    row = empty_row()
    seen = set()

    def count(info):
        if row["entries"] >= MAX_ENTRIES:
            raise Rejected("entry-limit")
        if budget["remaining"] <= 0:
            raise Rejected("total-entry-limit")
        row["entries"] += 1
        budget["remaining"] -= 1
        if identity(info) in seen:
            row["hardlinkDuplicates"] += 1
            return False
        seen.add(identity(info))
        row["allocatedBytes"] += info.st_blocks * 512
        if stat.S_ISREG(info.st_mode):
            row["files"] += 1
            row["logicalFileBytes"] += info.st_size
        elif stat.S_ISDIR(info.st_mode):
            row["directories"] += 1
        elif stat.S_ISLNK(info.st_mode):
            row["symlinks"] += 1
        else:
            row["specialFiles"] += 1
        return True

    def walk(fd, device, depth):
        if depth > MAX_DEPTH:
            raise Rejected("depth-limit")
        with os.scandir(fd) as entries:
            for entry in entries:
                info = os.stat(entry.name, dir_fd=fd, follow_symlinks=False)
                if info.st_dev != device:
                    raise Rejected("mount-boundary")
                if count(info) and stat.S_ISDIR(info.st_mode):
                    child = os.open(entry.name, FLAGS, dir_fd=fd)
                    try:
                        if identity(os.fstat(child)) != identity(info):
                            raise Rejected("directory-changed")
                        walk(child, device, depth + 1)
                        after = os.stat(entry.name, dir_fd=fd, follow_symlinks=False)
                        if identity(after) != identity(info):
                            raise Rejected("directory-changed")
                    finally:
                        os.close(child)

    try:
        with deadline(QUERY_SECONDS if seconds is None else seconds):
            with directory(path) as fd:
                info = os.fstat(fd)
                row["owner"] = {"uid": info.st_uid, "gid": info.st_gid,
                                "device": info.st_dev, "inode": info.st_ino}
                capacity = os.fstatvfs(fd)
                row["filesystem"] = {"totalBytes": capacity.f_blocks * capacity.f_frsize,
                                     "freeBytes": capacity.f_bfree * capacity.f_frsize,
                                     "availableBytes": capacity.f_bavail * capacity.f_frsize}
                count(info)
                walk(fd, info.st_dev, 0)
                with directory(path) as final:
                    if identity(os.fstat(final)) != identity(info):
                        raise Rejected("directory-changed")
        row["status"] = "collected"
    except Rejected as error:
        row["error"] = error.args[0]
    except FileNotFoundError:
        if row["owner"] is None:
            row["status"] = "missing"
        else:
            row["error"] = "entry-disappeared"
    except OSError as error:
        row["error"] = "unsafe-path" if error.errno in (errno.ELOOP, errno.ENOTDIR) else "read-failed"
        row["errno"] = error.errno
    except Exception:
        row["error"] = "query-failed"
    return row


def result(phase=None, error=None):
    return {"version": 1, "kind": "ci-disk-diagnostic", "phase": phase,
            "diagnosticOnly": True, "cleanupAuthorized": False,
            "collectionStatus": "rejected", "error": error, "context": None,
            "snapshot": "best-effort-metadata; independent overlapping roots; no link targets",
            "directories": []}


def collect(repo, phase):
    value = result(phase if phase in PHASES else None)
    started = time.monotonic()
    if phase not in PHASES:
        value["error"] = "unexpected-phase"
        return value
    try:
        with deadline(min(QUERY_SECONDS, TOTAL_SECONDS)):
            context = hosted.context(repo)
            repo = Path(repo)
            if (context is None or context["repository"] != "open-nerve/NerveOffice"
                    or context["job"] != "verify" or context["repo"] != str(repo)
                    or repo.name != "NerveOffice" or repo.parent.name != "NerveOffice"):
                raise Rejected("identity-mismatch")
            temporary = repo.parents[1] / "_temp"
            if os.environ.get("RUNNER_TEMP") != str(temporary):
                raise Rejected("temp-scope-mismatch")
            # These roots are fixed by the runner/workspace layout, not CLI paths.
            roots = [("workspace", repo), ("git", repo / ".git"),
                     ("dependencies", repo / "node_modules"), ("apps", repo / "apps"),
                     ("packages", repo / "packages"), ("test-resources", repo / ".test-resources"),
                     ("runner-temp", temporary),
                     # Locked pnpm/action-setup layout, observed in CI95's original log.
                     ("pnpm-store", repo.parents[2] / "setup-pnpm/node_modules/.bin/store")]
    except Rejected as error:
        value["error"] = error.args[0]
        return value
    except Exception:
        value["error"] = "identity-unavailable"
        return value
    value["context"] = context
    value["at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    budget = {"remaining": TOTAL_ENTRIES}
    for label, path in roots:
        remaining = TOTAL_SECONDS - (time.monotonic() - started)
        if remaining <= 0:
            row = {**empty_row(), "error": "total-timeout"}
        else:
            row = measure(path, budget, seconds=min(QUERY_SECONDS, remaining))
        if label in ("workspace", "runner-temp") and row["status"] == "missing":
            row.update(status="partial", error="required-root-missing")
        value["directories"].append({"label": label, **row})
    value["collectionStatus"] = ("collected" if all(row["status"] in ("collected", "missing")
                                                for row in value["directories"]) else "partial")
    value["elapsedMs"] = round((time.monotonic() - started) * 1000)
    return value


def main():
    value = (collect(Path(__file__).resolve().parents[2], sys.argv[1]) if len(sys.argv) == 2
             else result(error="unexpected-arguments"))
    encoded = json.dumps(value, ensure_ascii=True)
    if len(encoded.encode("utf-8")) + 1 > MAX_OUTPUT:
        value = result(error="output-limit")
        encoded = json.dumps(value)
    print(encoded)
    return 0 if value["collectionStatus"] == "collected" else 1


if __name__ == "__main__":
    sys.exit(main())
