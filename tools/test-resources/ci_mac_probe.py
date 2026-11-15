"""托管 Mac 的环境探测（M5-P8 S3 起）：mac.yml 的每个 job 开始与结束时记环境事实，只作观测。

不运行产品测试、不经测试资源运行器、不读写台账，结果不作任何验收证据。每个命令都有时限，输出只留退出码、字节数与
有界的错误尾部；环境变量只取固定的几个非敏感键。每一段在日志里打印完整 JSON，并写一条 notice 注解（公开接口可读）。
system 段会执行 sudo -n，所以只在 GitHub 托管的 Mac 上运行（HOSTED），其他环境一段也不执行。S3 探测用过的
postgres、docker、browsers、safari 段在改用 Apple 芯片版之后不再调用，已删除（S7 独立审查 M-1）。

用法：ci_mac_probe.py <system|final>
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

SECTIONS = ("system", "final")
# 只在这三个变量都是这些值时运行：GitHub 托管的 macOS 运行器（第 3 轮 run 42407334017 的 system 段原件记下后两者）
HOSTED = {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "macOS"}
TAIL_BYTES = 600
TEXT_BYTES = 64 * 1024
NOTICE_CHARS = 3800
ENV_KEYS = ("ImageOS", "ImageVersion", "RUNNER_OS", "RUNNER_ARCH", "RUNNER_ENVIRONMENT")
LSOF = ("/usr/sbin/lsof", "-nP", "-F", "pfnt")
POSTGRES_FORMULA = "postgresql@18"
GIB = 1024 ** 3
# 与 desktop_session.read_snapshot 同一条命令与环境（会话保护两次读取间隔 2 秒，读取时限 PS_TIMEOUT 10 秒）：记它在托管 Mac 上的耗时
PS = ("/bin/ps", "-ww", "-axo", "pid=,uid=,lstart=,comm=")
PS_ENV = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LC_ALL": "C", "LANG": "C"}
# 门禁用到的工具链（S4 独立审查 M-3）：原件据此绑定环境版本；Homebrew 的公式随托管镜像的快照。
# 托管的 Apple 芯片 Mac 不起 Docker，数据库是 mac.yml 用 Homebrew 装的 PostgreSQL（开始时还没装，记为 None）
TOOLS = (("node", ("node", "--version")), ("pnpm", ("pnpm", "--version")), ("brew", ("brew", "--version")),
         ("postgresql", ("brew", "list", "--versions", POSTGRES_FORMULA)))
VERSION_CHARS = 200


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


def ps_samples(count=3, timeout=30):
    return [{key: sample[key] for key in ("returncode", "stdoutBytes", "stderrBytes", "durationMs", "timedOut", "error") if key in sample}
            for sample in (run(PS, timeout, env=PS_ENV) for _ in range(count))]


def toolchain():
    """各工具 --version 的第一行（有界），找不到或失败时为 None；python3 记探测自身的解释器（门禁同一个 python3）。"""
    def first_line(argv):
        text = stdout_of(list(argv), timeout=30)
        return text.splitlines()[0][:VERSION_CHARS] if text else None
    return {"probePython": sys.version.split()[0], **{name: first_line(argv) for name, argv in TOOLS}}


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
        "ps": ps_samples(),
        "toolchain": toolchain(),
    }


def final():
    # 门禁跑完之后再采一次 lsof（Q-10 的观测，与运行器直接模式同一条命令）与 ps 的耗时
    return {"diskFreeGiB": disks(), "memory": memory(), "toolchain": toolchain(), "ps": ps_samples(), "lsofUser": lsof_samples()}


def hosted_mac():
    return all(os.environ.get(key) == value for key, value in HOSTED.items())


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
    if not hosted_mac():
        print("只在 GitHub 托管的 Mac 上运行（要求 " + "、".join(key + "=" + value for key, value in HOSTED.items()) + "），本次一段也不执行",
              file=sys.stderr)
        return 3
    section = argv[1]
    payload = globals()[section]()
    print(json.dumps(payload, ensure_ascii=False, indent=1))
    print(notice(section, payload))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
