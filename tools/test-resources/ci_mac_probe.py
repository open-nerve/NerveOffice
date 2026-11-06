"""托管 Mac 的环境探测（M5-P8 S3）：只收集环境事实，供决定能否在 GitHub 托管 Mac 上跑 Mac 原完整门禁。

不运行产品测试、不经测试资源运行器、不读写台账，结果不作任何验收证据。每个命令都有时限，输出只留退出码、字节数与
有界的错误尾部；环境变量只取固定的几个非敏感键。每一段在日志里打印完整 JSON，并写一条 notice 注解（公开接口可读）。

用法：ci_mac_probe.py <system|postgres|docker|browsers|safari|final>
"""
import json
import os
from pathlib import Path
import re
import resource
import shutil
import subprocess
import sys
import time

SECTIONS = ("system", "postgres", "docker", "browsers", "safari", "final")
TAIL_BYTES = 600
JSON_BYTES = 4 * 1024 * 1024
TEXT_BYTES = 64 * 1024
NOTICE_CHARS = 3800
BREW_ENV = {"HOMEBREW_NO_AUTO_UPDATE": "1", "HOMEBREW_NO_INSTALL_CLEANUP": "1"}
ENV_KEYS = ("ImageOS", "ImageVersion", "RUNNER_OS", "RUNNER_ARCH", "RUNNER_ENVIRONMENT")
LSOF = ("/usr/sbin/lsof", "-nP", "-F", "pfnt")
# 与 ci.yml 的 PostgreSQL service、deploy/dev/compose.yaml 同一个镜像（18.6-alpine 的多架构索引摘要）
POSTGRES_IMAGE = "postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873"
POSTGRES_FORMULA = "postgresql@18"
# 与 ci.yml 的 POSTGRES_INITDB_ARGS 相同
INITDB_ARGS = ("--encoding=UTF8", "--locale-provider=builtin", "--builtin-locale=C.UTF-8")
BROWSERS = (("chromium", None), ("webkit", None), ("chromium", "chrome"))
GIB = 1024 ** 3


def tail(data, limit=TAIL_BYTES):
    raw = data if isinstance(data, bytes) else (data or "").encode("utf-8", errors="replace")
    return raw[-limit:].decode("utf-8", errors="replace")


def run(argv, timeout, *, cwd=None, env=None, keep_stdout=False, stdout_limit=TAIL_BYTES):
    """有界地执行一个命令：只返回退出码、耗时、字节数与错误尾部（要求时另留 stdout 的最后 stdout_limit 字节）；
    超时与找不到程序都作为结果记下，不抛出。"""
    started = time.monotonic()
    result = {"argv": list(argv)}
    try:
        done = subprocess.run(list(argv), capture_output=True, timeout=timeout, cwd=cwd,
                              env=None if env is None else dict(os.environ, **env))
    except subprocess.TimeoutExpired as error:
        result.update(timedOut=True, stderrTail=tail(error.stderr))
    except OSError as error:
        result.update(error=type(error).__name__, errno=error.errno)
    else:
        result.update(returncode=done.returncode, stdoutBytes=len(done.stdout), stderrBytes=len(done.stderr))
        if done.stderr:
            result["stderrTail"] = tail(done.stderr)
        if keep_stdout:
            result["stdout"] = tail(done.stdout, stdout_limit).strip()
    result["durationMs"] = round((time.monotonic() - started) * 1000)
    return result


def stdout_of(argv, timeout=20, limit=TAIL_BYTES):
    value = run(argv, timeout, keep_stdout=True, stdout_limit=limit)
    return value.get("stdout") if value.get("returncode") == 0 else None


def json_of(argv, timeout, env=None):
    """命令成功且输出是不超过 JSON_BYTES 的 JSON 时返回解析结果，否则返回 None。"""
    try:
        done = subprocess.run(list(argv), capture_output=True, timeout=timeout,
                              env=None if env is None else dict(os.environ, **env))
    except (OSError, subprocess.SubprocessError):
        return None
    if done.returncode != 0 or len(done.stdout) > JSON_BYTES:
        return None
    try:
        return json.loads(done.stdout)
    except ValueError:
        return None


def free_gib(path):
    if not path or not Path(path).is_dir():
        return None
    return round(shutil.disk_usage(path).free / GIB, 1)


def disks():
    return {name: free_gib(path) for name, path in (
        ("root", "/"), ("home", os.environ.get("HOME")), ("runnerTemp", os.environ.get("RUNNER_TEMP")),
        ("workspace", os.environ.get("GITHUB_WORKSPACE")))}


def memory():
    """vm_stat 的空闲与可回收页（GiB），以及 memory_pressure 报告的系统空闲百分比。"""
    value = {}
    text = stdout_of(["/usr/bin/vm_stat"], limit=TEXT_BYTES)
    if text:
        size = re.search(r"page size of (\d+) bytes", text)
        pages = dict((key, int(number)) for key, number in re.findall(r"^Pages (free|inactive|speculative|purgeable):\s+(\d+)\.", text, re.M))
        if size:
            value["freeGiB"] = round(sum(pages.values()) * int(size.group(1)) / GIB, 1)
    pressure = stdout_of(["/usr/bin/memory_pressure", "-Q"])
    match = re.search(r"free percentage:\s*(\d+)", pressure or "")
    if match:
        value["freePercent"] = int(match.group(1))
    return value


def lsof_samples(prefix=(), count=3, timeout=60):
    return [{key: sample[key] for key in ("returncode", "stderrBytes", "durationMs", "timedOut", "error") if key in sample}
            for sample in (run([*prefix, *LSOF], timeout, env={"LC_ALL": "C"}) for _ in range(count))]


def system():
    total = stdout_of(["/usr/sbin/sysctl", "-n", "hw.memsize"])
    default_keychain = (stdout_of(["/usr/bin/security", "default-keychain", "-d", "user"]) or "").strip().strip('"')
    keychain = run(["/usr/bin/security", "show-keychain-info", default_keychain], 20) if default_keychain else None
    return {
        "env": {key: os.environ.get(key) for key in ENV_KEYS},
        "macos": stdout_of(["/usr/bin/sw_vers", "-productVersion"]),
        "build": stdout_of(["/usr/bin/sw_vers", "-buildVersion"]),
        "machine": stdout_of(["/usr/bin/uname", "-m"]),
        "cpu": stdout_of(["/usr/sbin/sysctl", "-n", "machdep.cpu.brand_string"]),
        "cpus": stdout_of(["/usr/sbin/sysctl", "-n", "hw.ncpu"]),
        "memoryGiB": round(int(total) / GIB, 1) if total and total.isdigit() else None,
        "memory": memory(),
        "diskFreeGiB": disks(),
        "session": {
            "user": stdout_of(["/usr/bin/id", "-un"]),
            "consoleUser": stdout_of(["/usr/bin/stat", "-f", "%Su", "/dev/console"]),
            "windowServer": run(["/usr/bin/pgrep", "-x", "WindowServer"], 10).get("returncode") == 0,
            "loginwindow": run(["/usr/bin/pgrep", "-x", "loginwindow"], 10).get("returncode") == 0,
            "manager": stdout_of(["/bin/launchctl", "managername"]),
        },
        "keychain": None if keychain is None else {
            "default": default_keychain, "infoReturncode": keychain.get("returncode"),
            "infoStderrTail": keychain.get("stderrTail")},
        "sudo": run(["/usr/bin/sudo", "-n", "/usr/bin/true"], 20).get("returncode"),
        "openFilesLimit": resource.getrlimit(resource.RLIMIT_NOFILE)[0],
        "lsofUser": lsof_samples(),
        "lsofSudo": lsof_samples(("/usr/bin/sudo", "-n", "--")),
    }


def brew_executable():
    return shutil.which("brew") or "/opt/homebrew/bin/brew"


def brew(*arguments, timeout=900):
    return run([brew_executable(), *arguments], timeout, env=BREW_ENV, keep_stdout=True)


def formula_stable(name):
    info = json_of([brew_executable(), "info", "--json=v2", name], 120, env=BREW_ENV)
    try:
        return info["formulae"][0]["versions"]["stable"]
    except (TypeError, KeyError, IndexError):
        return None


def postgres():
    value = {"brew": (brew("--version", timeout=60).get("stdout") or "").splitlines()[:1],
             "formulaStable": formula_stable(POSTGRES_FORMULA)}
    install = brew("install", POSTGRES_FORMULA)
    value["install"] = {key: install.get(key) for key in ("returncode", "durationMs", "timedOut", "stderrTail")}
    prefix = (brew("--prefix", POSTGRES_FORMULA, timeout=60).get("stdout") or "").strip()
    binary = Path(prefix) / "bin"
    data = Path(os.environ.get("RUNNER_TEMP") or "/tmp") / "nerve-probe-pgdata"
    steps = [
        ("initdb", [str(binary / "initdb"), "-D", str(data), "-U", "nerve", "--auth=trust", *INITDB_ARGS], 120),
        ("start", [str(binary / "pg_ctl"), "-D", str(data), "-l", str(data) + ".log", "-w", "-t", "60",
                   "-o", "-p 5432 -c listen_addresses=127.0.0.1", "start"], 90),
        ("createdb", [str(binary / "createdb"), "-h", "127.0.0.1", "-U", "nerve", "nerve_office"], 30),
        ("version", [str(binary / "psql"), "-h", "127.0.0.1", "-U", "nerve", "-d", "nerve_office", "-At", "-c", "show server_version"], 30),
        ("stop", [str(binary / "pg_ctl"), "-D", str(data), "-m", "fast", "-w", "stop"], 60),
    ]
    value["steps"] = {}
    for name, argv, timeout in steps:
        outcome = run(argv, timeout, keep_stdout=name == "version")
        value["steps"][name] = {key: outcome.get(key) for key in ("returncode", "durationMs", "timedOut", "error", "stderrTail", "stdout") if key in outcome}
    return value


def docker():
    value = {"preinstalled": shutil.which("docker") is not None}
    if not value["preinstalled"]:
        install = brew("install", "colima", "docker", timeout=900)
        value["install"] = {key: install.get(key) for key in ("returncode", "durationMs", "timedOut", "stderrTail")}
    colima = shutil.which("colima")
    if colima:
        # 先用默认虚拟化方式，失败再试 Apple 的 Virtualization.framework；两次都记下
        value["colimaStart"] = []
        for extra in ((), ("--vm-type", "vz")):
            start = run([colima, "start", "--cpu", "2", "--memory", "4", "--disk", "20", *extra], 600)
            value["colimaStart"].append({key: start.get(key) for key in ("argv", "returncode", "durationMs", "timedOut", "stderrTail") if key in start})
            if start.get("returncode") == 0:
                break
            run([colima, "delete", "--force"], 120)
    engine = shutil.which("docker")
    if engine:
        server = run([engine, "info", "--format", "{{.ServerVersion}}"], 60, keep_stdout=True)
        value["server"] = {key: server.get(key) for key in ("returncode", "stdout", "stderrTail") if key in server}
        if server.get("returncode") == 0:
            pulled = run([engine, "run", "--rm", POSTGRES_IMAGE, "postgres", "--version"], 600, keep_stdout=True)
            value["postgresImage"] = {key: pulled.get(key) for key in ("returncode", "durationMs", "stdout", "stderrTail") if key in pulled}
    if colima:
        run([colima, "stop"], 180)
    return value


def browsers():
    output = Path(os.environ.get("RUNNER_TEMP") or "/tmp")
    value = {}
    for browser, channel in BROWSERS:
        name = channel or browser
        target = output / ("nerve-probe-" + name + ".png")
        argv = ["pnpm", "--filter", "@nerve-office/e2e", "exec", "playwright", "screenshot", "--browser", browser]
        if channel:
            argv += ["--channel", channel]
        outcome = run([*argv, "about:blank", str(target)], 180)
        value[name] = {key: outcome.get(key) for key in ("returncode", "durationMs", "timedOut", "error", "stderrTail") if key in outcome}
        value[name]["screenshotBytes"] = target.stat().st_size if target.is_file() else 0
    cache = Path.home() / "Library/Caches/ms-playwright"
    value["playwrightCacheGiB"] = round(sum(item.stat().st_size for item in cache.rglob("*") if item.is_file() and not item.is_symlink()) / GIB, 2) if cache.is_dir() else None
    return value


def safari():
    enable = run(["/usr/bin/sudo", "-n", "/usr/bin/safaridriver", "--enable"], 60)
    return {
        "safari": stdout_of(["/usr/bin/defaults", "read", "/Applications/Safari.app/Contents/Info", "CFBundleShortVersionString"]),
        "safaridriver": stdout_of(["/usr/bin/safaridriver", "--version"]),
        "enable": {key: enable.get(key) for key in ("returncode", "stderrTail", "error") if key in enable},
    }


def final():
    return {"diskFreeGiB": disks(), "memory": memory()}


def notice(title, payload):
    """一行 notice 注解：按工作流命令的规则转义 %、CR、LF，超长截断并标明。"""
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    if len(text) > NOTICE_CHARS:
        text = text[:NOTICE_CHARS] + "…（截断，完整内容见日志）"
    escaped = text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
    return "::notice title=托管 Mac 探测（" + title + "）::" + escaped


def main(argv):
    if len(argv) != 2 or argv[1] not in SECTIONS:
        print("用法：ci_mac_probe.py <" + "|".join(SECTIONS) + ">", file=sys.stderr)
        return 2
    section = argv[1]
    payload = globals()[section]()
    print(json.dumps(payload, ensure_ascii=False, indent=1))
    print(notice(section, payload))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
