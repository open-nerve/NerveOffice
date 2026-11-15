"""托管 Mac 环境探测（M5-P8 S3）的单测：命令都有时限、输出有界、不泄露环境变量、注解按工作流命令规则转义。"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import unittest
from unittest.mock import patch

import ci_mac_probe as probe

# GitHub 托管的 Mac 上这三个变量的取值（第 3 轮 run 42407334017 的 system 段原件记下 RUNNER_ENVIRONMENT=github-hosted、RUNNER_OS=macOS）
HOSTED_ENV = {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "macOS"}


class MacProbeTests(unittest.TestCase):
    def test_run_records_returncode_bytes_and_bounded_stderr_tail_without_raising(self):
        script = "import sys; sys.stdout.write('o' * 10); sys.stderr.write('e' * 5000 + 'END'); sys.exit(3)"
        result = probe.run([sys.executable, "-c", script], 30)
        self.assertEqual(result["returncode"], 3)
        self.assertEqual((result["stdoutBytes"], result["stderrBytes"]), (10, 5003))
        self.assertEqual(len(result["stderrTail"].encode()), probe.TAIL_BYTES)
        self.assertTrue(result["stderrTail"].endswith("END"))
        self.assertNotIn("stdout", result)
        self.assertGreaterEqual(result["durationMs"], 0)

    def test_run_records_timeout_and_missing_program_as_results(self):
        slow = probe.run([sys.executable, "-c", "import time; time.sleep(5)"], 0.2)
        self.assertTrue(slow["timedOut"])
        self.assertNotIn("returncode", slow)
        missing = probe.run(["/nonexistent/nerve-probe-binary"], 5)
        self.assertEqual(missing["error"], "FileNotFoundError")
        self.assertNotIn("returncode", missing)

    def test_run_keeps_only_a_bounded_stdout_tail_when_asked(self):
        result = probe.run([sys.executable, "-c", "print('x' * 2000 + 'tail')"], 30, keep_stdout=True)
        self.assertTrue(result["stdout"].endswith("tail"))
        self.assertLessEqual(len(result["stdout"].encode()), probe.TAIL_BYTES)

    def test_notice_escapes_workflow_command_characters_and_bounds_length(self):
        line = probe.notice("system", {"text": "100%\r\nnext"})
        self.assertTrue(line.startswith("::notice title=托管 Mac 探测（system）::"))
        self.assertNotIn("\n", line)
        self.assertIn("100%25", line)
        payload = line.split("::", 2)[2]
        self.assertEqual(json.loads(payload.replace("%0D", "\r").replace("%0A", "\n").replace("%25", "%")), {"text": "100%\r\nnext"})
        long_line = probe.notice("final", {"text": "y" * 10_000})
        self.assertIn("截断", long_line)
        self.assertLess(len(long_line), probe.NOTICE_CHARS + 200)

    def test_main_rejects_unknown_sections_and_prints_details_and_one_notice(self):
        self.assertEqual(probe.main(["ci_mac_probe.py"]), 2)
        self.assertEqual(probe.main(["ci_mac_probe.py", "unknown"]), 2)
        with patch.dict(os.environ, HOSTED_ENV), patch.object(probe, "final", return_value={"diskFreeGiB": {"root": 1.5}}), \
                patch("builtins.print") as printed:
            self.assertEqual(probe.main(["ci_mac_probe.py", "final"]), 0)
        lines = [call.args[0] for call in printed.call_args_list]
        self.assertEqual(json.loads(lines[0]), {"diskFreeGiB": {"root": 1.5}})
        self.assertEqual(sum(line.startswith("::notice") for line in lines), 1)

    def test_main_runs_no_section_outside_a_github_hosted_mac(self):
        # S7 独立审查 M-1：system 段会执行 sudo -n；在开发机或其他环境上手动运行时，任何一段都不执行
        refused = [{}, dict(HOSTED_ENV, GITHUB_ACTIONS="false"), dict(HOSTED_ENV, RUNNER_ENVIRONMENT="self-hosted"),
                   dict(HOSTED_ENV, RUNNER_OS="Linux")]
        # 只缺其中一个、另外两个都对，同样一段也不执行：缺的那一项不能按期望值补上（S7 修正的复验 Minor）
        refused += [{name: value for name, value in HOSTED_ENV.items() if name != missing} for missing in HOSTED_ENV]
        for environment in refused:
            with self.subTest(environment=environment), patch.dict(os.environ, environment, clear=True), \
                    patch.object(probe, "system", side_effect=AssertionError("不应执行")), \
                    patch.object(probe, "final", side_effect=AssertionError("不应执行")), \
                    patch("builtins.print") as printed:
                self.assertEqual(probe.main(["ci_mac_probe.py", "system"]), 3)
                self.assertEqual(probe.main(["ci_mac_probe.py", "final"]), 3)
            self.assertTrue(all(call.kwargs.get("file") is sys.stderr for call in printed.call_args_list))

    def test_sections_are_exactly_the_ones_the_mac_workflow_calls(self):
        # S3 探测用过的 postgres、docker、browsers、safari 段已删（S7 独立审查 M-1：docker 段启动失败时会 colima delete --force）
        workflow = (Path(__file__).resolve().parents[2] / ".github" / "workflows" / "mac.yml").read_text(encoding="utf-8")
        called = set(re.findall(r"ci_mac_probe\.py (\w+)", workflow))
        self.assertEqual(called, {"system", "final"})
        self.assertEqual(set(probe.SECTIONS), called)
        for name in ("postgres", "docker", "browsers", "safari"):
            self.assertFalse(hasattr(probe, name), name)

    def test_lsof_samples_use_the_fixed_command_c_locale_and_keep_only_counts(self):
        calls = []

        def fake(argv, **options):
            calls.append((argv, options["env"]["LC_ALL"], options["timeout"]))
            return subprocess.CompletedProcess(argv, 1, b"p1\n", b"warning")

        with patch("ci_mac_probe.subprocess.run", side_effect=fake):
            samples = probe.lsof_samples(("/usr/bin/sudo", "-n", "--"), count=2, timeout=7)
        self.assertEqual([call[0] for call in calls], [["/usr/bin/sudo", "-n", "--", *probe.LSOF]] * 2)
        self.assertEqual({(call[1], call[2]) for call in calls}, {("C", 7)})
        self.assertEqual([set(sample) for sample in samples], [{"returncode", "stderrBytes", "durationMs"}] * 2)
        self.assertEqual([(sample["returncode"], sample["stderrBytes"]) for sample in samples], [(1, 7)] * 2)

    def test_ps_samples_time_the_same_command_as_the_desktop_session_guard(self):
        # 第 2 轮托管 Mac 门禁（run 42256375539）里会话保护的 ps 两次超过 2 秒的读取时限：探测照同一条命令记录耗时
        import desktop_session

        seen = []

        def capture(argv, **options):
            seen.append((list(argv), options["env"]))
            return subprocess.CompletedProcess(argv, 0, b"", b"")

        with patch("desktop_session.subprocess.run", side_effect=capture):
            with self.assertRaises(desktop_session.SessionReadError):
                desktop_session.read_snapshot()
        calls = []

        def fake(argv, **options):
            calls.append((list(argv), options["env"], options["timeout"]))
            return subprocess.CompletedProcess(argv, 0, b"x" * 50, b"")

        with patch("ci_mac_probe.subprocess.run", side_effect=fake):
            samples = probe.ps_samples(count=2, timeout=9)
        self.assertEqual([call[0] for call in calls], [seen[0][0]] * 2)
        for name, value in seen[0][1].items():
            self.assertEqual({call[1][name] for call in calls}, {value})
        self.assertEqual({call[2] for call in calls}, {9})
        self.assertEqual([set(sample) for sample in samples], [{"returncode", "stdoutBytes", "stderrBytes", "durationMs"}] * 2)
        self.assertEqual([(sample["returncode"], sample["stdoutBytes"]) for sample in samples], [(0, 50)] * 2)

    def test_toolchain_records_only_the_first_bounded_line_of_each_version_or_none(self):
        # 托管的 Apple 芯片 Mac 不起 Docker：门禁的工具链是 Node、pnpm、Homebrew 与它装的 PostgreSQL（开始时还没装，记为 None）
        self.assertEqual([name for name, _argv in probe.TOOLS], ["node", "pnpm", "brew", "postgresql"])
        outputs = {("node", "--version"): "v24.21.0", ("brew", "--version"): "Homebrew " + "9" * 400,
                   ("brew", "list", "--versions", "postgresql@18"): "postgresql@18 18.6_1\nextra"}

        def fake(argv, timeout=20, limit=probe.TAIL_BYTES):
            self.assertLessEqual(timeout, 30)
            return outputs.get(tuple(argv))

        with patch.object(probe, "stdout_of", side_effect=fake):
            value = probe.toolchain()
        self.assertEqual(value["probePython"], sys.version.split()[0])
        self.assertEqual(value["node"], "v24.21.0")
        self.assertIsNone(value["pnpm"])
        self.assertEqual(len(value["brew"]), 200)
        self.assertEqual(value["postgresql"], "postgresql@18 18.6_1")
        self.assertEqual(set(value), {"probePython", *(name for name, _argv in probe.TOOLS)})

    def test_final_records_disk_memory_toolchain_ps_timing_and_lsof_after_the_gate(self):
        with patch.object(probe, "disks", return_value={"root": 1.0}), patch.object(probe, "memory", return_value={}), \
                patch.object(probe, "toolchain", return_value={"node": "v24"}), patch.object(probe, "ps_samples", return_value=[{"durationMs": 5}]), \
                patch.object(probe, "lsof_samples", return_value=[{"returncode": 0}]):
            self.assertEqual(probe.final(), {"diskFreeGiB": {"root": 1.0}, "memory": {}, "toolchain": {"node": "v24"},
                                             "ps": [{"durationMs": 5}], "lsofUser": [{"returncode": 0}]})

    def test_probe_lsof_command_is_the_runner_direct_mode_command(self):
        with patch.dict(os.environ, {"NERVE_TEST_LSOF_MODE": "direct"}), patch("lifecycle.shutil.which", return_value="/usr/sbin/lsof"):
            import lifecycle
            self.assertEqual(lifecycle.lsof_query_command(), list(probe.LSOF))

    def test_system_reports_only_allowlisted_environment_keys(self):
        secret = "ghs_not_a_real_token_value"
        environment = {"GITHUB_TOKEN": secret, "ACTIONS_RUNTIME_TOKEN": secret, "ImageOS": "macos26", "RUNNER_OS": "macOS"}
        with patch.dict(os.environ, environment), \
                patch.object(probe, "run", return_value={"returncode": 1, "durationMs": 0}), \
                patch.object(probe, "lsof_samples", return_value=[]):
            value = probe.system()
        self.assertNotIn(secret, json.dumps(value))
        self.assertEqual(set(value["env"]), set(probe.ENV_KEYS))
        self.assertEqual(value["env"]["ImageOS"], "macos26")
        self.assertIsNone(value["keychain"])

    def test_memory_parses_a_full_vm_stat_listing_longer_than_the_stderr_tail(self):
        # 本机试跑发现：vm_stat 的输出超过错误尾部的长度，页大小那一行在开头，只留尾部就解析不出空闲内存
        listing = ("Mach Virtual Memory Statistics: (page size of 16384 bytes)\n"
                   "Pages free:                               65536.\n"
                   "Pages active:                             1.\n"
                   "Pages inactive:                           65536.\n"
                   "Pages speculative:                        0.\n"
                   + "".join("Filler statistic number %03d:                 1.\n" % index for index in range(40))
                   + "Pages purgeable:                          0.\n").encode()
        self.assertGreater(len(listing), probe.TAIL_BYTES)

        def fake(argv, **options):
            if argv[0].endswith("vm_stat"):
                return subprocess.CompletedProcess(argv, 0, listing, b"")
            return subprocess.CompletedProcess(argv, 0, b"System-wide memory free percentage: 55%\n", b"")

        with patch("ci_mac_probe.subprocess.run", side_effect=fake):
            self.assertEqual(probe.memory(), {"freeGiB": 2.0, "freePercent": 55})


if __name__ == "__main__":
    unittest.main()
