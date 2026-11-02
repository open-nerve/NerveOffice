"""Read-only macOS desktop identity guard. It never signals or owns system processes."""
import copy
from datetime import datetime, timezone
import os
import re
import subprocess
import sys
import time

CHECK_INTERVAL = 2.0
MAX_PS_BYTES = 1024 * 1024
GUARDED_KINDS = frozenset(("e2e", "container", "measure", "template", "native", "vm", "gate"))
WINDOW_SERVERS = frozenset((
    "/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer",
    "/System/Library/PrivateFrameworks/SkyLight.framework/Versions/A/Resources/WindowServer",
))
LOGINWINDOW = "/System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow"
ROW = re.compile(r"\s*(\d+)\s+(\d+)\s+([A-Za-z]{3})\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s+(.+)")
MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()
WEEKDAYS = "Mon Tue Wed Thu Fri Sat Sun".split()
READ_ERRORS = frozenset(("ps-timeout", "ps-query-failed", "ps-output-invalid", "ps-row-invalid",
                         "console-read-failed", "console-changed-during-read", "console-user-mismatch",
                         "session-identity-ambiguous", "probe-invalid"))


class SessionReadError(ValueError):
    def __init__(self, reason):
        self.reason = reason if reason in READ_ERRORS else "probe-invalid"
        super().__init__(self.reason)


def parse_snapshot(text, console_uid, current_uid):
    if current_uid <= 0 or console_uid != current_uid:
        raise SessionReadError("console-user-mismatch")
    processes = {}
    for line in text.splitlines():
        if not line.strip():
            continue
        match = ROW.fullmatch(line)
        if match is None:
            raise SessionReadError("ps-row-invalid")
        pid, uid, weekday, month, day, hour, minute, second, year, executable = match.groups()
        try:
            started = datetime(int(year), MONTHS.index(month) + 1, int(day), int(hour), int(minute), int(second))
            if WEEKDAYS[started.weekday()] != weekday or int(pid) in processes:
                raise ValueError()
        except ValueError:
            raise SessionReadError("ps-row-invalid") from None
        processes[int(pid)] = {"pid": int(pid), "uid": int(uid), "startedAt":
                              f"{weekday} {month} {int(day)} {hour}:{minute}:{second} {year}",
                              "executable": executable}
    servers = [p for p in processes.values() if p["executable"] in WINDOW_SERVERS]
    logins = [p for p in processes.values() if p["executable"] == LOGINWINDOW and p["uid"] == current_uid]
    if len(servers) != 1 or len(logins) != 1:
        raise SessionReadError("session-identity-ambiguous")
    return {"consoleUid": console_uid, "windowServer": servers[0], "loginwindow": logins[0]}


def read_snapshot():
    try:
        before = os.stat("/dev/console").st_uid
        current = os.getuid()
    except OSError:
        raise SessionReadError("console-read-failed") from None
    try:
        result = subprocess.run(["/bin/ps", "-ww", "-axo", "pid=,uid=,lstart=,comm="],
                                capture_output=True, timeout=2,
                                env={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LC_ALL": "C", "LANG": "C"})
    except subprocess.TimeoutExpired:
        raise SessionReadError("ps-timeout") from None
    except OSError:
        raise SessionReadError("ps-query-failed") from None
    if result.returncode != 0 or result.stderr:
        raise SessionReadError("ps-query-failed")
    if not result.stdout or len(result.stdout) > MAX_PS_BYTES:
        raise SessionReadError("ps-output-invalid")
    try:
        text = result.stdout.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        raise SessionReadError("ps-output-invalid") from None
    try:
        after = os.stat("/dev/console").st_uid
    except OSError:
        raise SessionReadError("console-read-failed") from None
    if before != after:
        raise SessionReadError("console-changed-during-read")
    return parse_snapshot(text, after, current)


class SessionGuard:
    def __init__(self, kind):
        self.enabled = sys.platform == "darwin" and kind in GUARDED_KINDS
        self._last_check = None
        self._record = {"version": 1, "status": "pending" if self.enabled else "not-applicable"}
        if not self.enabled:
            self._record["reason"] = "non-darwin" if sys.platform != "darwin" else "non-browser-kind"

    def record(self):
        return copy.deepcopy(self._record)

    def check(self, force=False):
        if not self.enabled:
            return True
        if self._record["status"] == "stopped":
            return False
        now = time.monotonic()
        if not force and self._last_check is not None and now - self._last_check < CHECK_INTERVAL:
            return True
        self._last_check = now
        self._record["checkedAt"] = datetime.now(timezone.utc).isoformat()
        try:
            observed = read_snapshot()
        except SessionReadError as error:
            self._record.update(status="stopped", reason="session-unavailable", readError=error.reason)
            return False
        if "baseline" not in self._record:
            self._record.update(status="monitoring", baseline=observed)
        elif observed != self._record["baseline"]:
            self._record.update(status="stopped", reason="session-changed", observed=observed)
            return False
        return True
