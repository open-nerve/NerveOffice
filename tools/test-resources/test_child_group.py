"""向本轮自己启动的子进程组发信号（M5-P8，托管 Mac #7）。只用本测试启动的极小 Python 子进程，不向其他进程发信号。"""
import os
import signal
import subprocess
import sys
import time
import unittest
from unittest.mock import patch

from child_group import signal_child_group

# 组长自己不理会 SIGTERM，只等同组的孙进程退出，再以“孙进程的退出码 + 10”退出：
# 只有整组都收到 SIGTERM，孙进程才会以 4 退出、组长才会以 14 退出。
GROUP_SCRIPT = r'''
import signal, subprocess, sys
signal.signal(signal.SIGTERM, lambda *_: None)
grand = subprocess.Popen([sys.executable, "-c",
    "import signal,sys,time; signal.signal(signal.SIGTERM, lambda *_: sys.exit(4)); print('ready', flush=True); time.sleep(30)"],
    stdout=subprocess.PIPE)
if grand.stdout.readline() != b"ready\n":
    sys.exit(2)
print("ready", flush=True)
sys.exit(10 + grand.wait())
'''


def wait_until_unreaped_exit(child, timeout=5.0):
    """只读进程表、不回收：子进程已经退出、等着父进程回收时，ps 的状态以 Z 开头。"""
    deadline = time.monotonic() + timeout
    state = ""
    while time.monotonic() < deadline:
        state = subprocess.run(["ps", "-o", "stat=", "-p", str(child.pid)],
                               capture_output=True, text=True, timeout=5).stdout.strip()
        if state.startswith("Z"):
            return
        time.sleep(.02)
    raise AssertionError("子进程没有在时限内进入已退出、待回收的状态：" + repr(state))


class ChildGroupSignalTests(unittest.TestCase):
    def start(self, code, stdout=subprocess.DEVNULL):
        child = subprocess.Popen([sys.executable, "-c", code], stdin=subprocess.DEVNULL, stdout=stdout,
                                 stderr=subprocess.DEVNULL, start_new_session=True)

        def close():
            # 只结束本测试自己启动的组，并回收组长；组长已回收就不再按组号发信号
            if child.poll() is None:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass  # 组长恰在此时退出：下面照样回收
            child.wait(timeout=5)
            if child.stdout is not None:
                child.stdout.close()
        self.addCleanup(close)
        return child

    @unittest.skipUnless(sys.platform == "darwin", "只记录 macOS 的系统行为；Linux 对这样的组照常发送成功")
    def test_macos_denies_group_signal_while_exited_leader_is_unreaped(self):
        # 本模块依赖的系统行为（托管 Mac #7 的失败即由此而来）：组里只剩已退出、尚未回收的组长时报 EPERM，回收之后才报 ESRCH
        child = self.start("import sys; sys.exit(7)")
        wait_until_unreaped_exit(child)
        with self.assertRaises(PermissionError):
            os.killpg(child.pid, signal.SIGTERM)
        self.assertEqual(child.wait(timeout=5), 7)
        with self.assertRaises(ProcessLookupError):
            os.killpg(child.pid, 0)

    def test_child_that_exits_right_after_the_liveness_check_is_not_an_error(self):
        # 收尾时刚看到子进程还在运行，它紧接着退出、尚未回收：不能因此报错，也不能丢掉它的退出码
        child = self.start("import sys; sys.exit(7)")
        wait_until_unreaped_exit(child)
        with patch.object(child, "poll", return_value=None):
            signal_child_group(child, signal.SIGTERM)
        self.assertEqual(child.wait(timeout=5), 7)

    def test_denied_signal_while_child_still_runs_fails_closed(self):
        # 子进程确实还在运行却发不出信号：照旧报错，不当作已经停下
        child = self.start("import time; time.sleep(30)")
        with patch.object(os, "killpg", side_effect=PermissionError(1, "Operation not permitted")):
            with self.assertRaises(PermissionError):
                signal_child_group(child, signal.SIGTERM, settle=.2)
        self.assertIsNone(child.poll())

    def test_running_child_group_receives_the_signal(self):
        child = self.start(GROUP_SCRIPT, stdout=subprocess.PIPE)
        self.assertEqual(child.stdout.readline(), b"ready\n")
        signal_child_group(child, signal.SIGTERM)
        self.assertEqual(child.wait(timeout=5), 14)

    def test_reaped_child_group_number_is_never_signalled(self):
        # 回收之后，这个组号可能已经属于别的进程：不再发信号
        child = self.start("import sys; sys.exit(5)")
        wait_until_unreaped_exit(child)
        with patch.object(os, "killpg", side_effect=AssertionError("已回收子进程的组号不得再发信号")):
            signal_child_group(child, signal.SIGTERM)
        self.assertEqual(child.returncode, 5)


if __name__ == "__main__":
    unittest.main()
