"""向本轮自己启动的直接子进程（start_new_session，组号即它的进程号）的进程组发信号。

只认这个 Popen 对象：子进程已经回收就不再按组号发信号（组号可能已属于别的进程）。macOS 上，组里只剩已退出、
尚未回收的进程时，killpg 报 EPERM 而不是 ESRCH（Linux 照常返回成功，回收之后两边都报 ESRCH）；
“看到子进程还在运行”与“发信号”之间它恰好退出时就会这样（托管 Mac #7）。此时最多等 settle 秒确认它确已退出
（由 Popen 回收，保留真实退出码），确认了就无需再发；等不到（它确实还在运行、无权发信号，或本进程别处正占着
Popen 的回收）就照旧抛出，失败关闭。
组长退出后同组还有能收信号的进程时 killpg 照常送达，不会走到这里；剩下的都无权发信号（例如换了身份的后代）时，
组长回收后即返回。整组是否都已停下不由这里判定：run.py 随后用 group_alive 核对，它把 EPERM 当作存活。"""
import os
import subprocess

SETTLE_SECONDS = 1.0


def signal_child_group(child, signum, settle=SETTLE_SECONDS):
    if child.poll() is not None:
        return
    try:
        os.killpg(child.pid, signum)
        return
    except ProcessLookupError:
        return
    except PermissionError as error:
        denied = error
    try:
        child.wait(timeout=settle)
    except subprocess.TimeoutExpired:
        raise denied from None
