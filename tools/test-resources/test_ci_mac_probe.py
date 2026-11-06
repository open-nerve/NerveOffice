"""托管 Mac 环境探测（M5-P8 S3）的单测：命令都有时限、输出有界、不泄露环境变量、注解按工作流命令规则转义。"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import ci_mac_probe as probe


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
        with patch.object(probe, "final", return_value={"diskFreeGiB": {"root": 1.5}}), \
                patch("builtins.print") as printed:
            self.assertEqual(probe.main(["ci_mac_probe.py", "final"]), 0)
        lines = [call.args[0] for call in printed.call_args_list]
        self.assertEqual(json.loads(lines[0]), {"diskFreeGiB": {"root": 1.5}})
        self.assertEqual(sum(line.startswith("::notice") for line in lines), 1)

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

    def test_json_of_returns_none_for_failure_oversized_or_invalid_output(self):
        cases = [
            (subprocess.CompletedProcess([], 0, b'{"a": 1}', b""), {"a": 1}),
            (subprocess.CompletedProcess([], 1, b'{"a": 1}', b""), None),
            (subprocess.CompletedProcess([], 0, b"not json", b""), None),
            (subprocess.CompletedProcess([], 0, b" " * (probe.JSON_BYTES + 1), b""), None),
        ]
        for completed, expected in cases:
            with self.subTest(returncode=completed.returncode, size=len(completed.stdout)), \
                    patch("ci_mac_probe.subprocess.run", return_value=completed):
                self.assertEqual(probe.json_of(["brew"], 5), expected)
        with patch("ci_mac_probe.subprocess.run", side_effect=subprocess.TimeoutExpired("brew", 5)):
            self.assertIsNone(probe.json_of(["brew"], 5))

    def test_formula_stable_reads_the_brew_json_shape(self):
        with patch.object(probe, "json_of", return_value={"formulae": [{"versions": {"stable": "18.6"}}]}):
            self.assertEqual(probe.formula_stable("postgresql@18"), "18.6")
        for broken in (None, {}, {"formulae": []}, {"formulae": [{}]}):
            with self.subTest(broken=broken), patch.object(probe, "json_of", return_value=broken):
                self.assertIsNone(probe.formula_stable("postgresql@18"))

    def test_browsers_records_every_browser_even_when_launch_fails(self):
        with tempfile.TemporaryDirectory(prefix="nerve-mac-probe-") as temporary, \
                patch.dict(os.environ, {"RUNNER_TEMP": temporary, "HOME": temporary}), \
                patch.object(probe, "run", return_value={"returncode": 1, "durationMs": 3, "stderrTail": "launch failed"}) as launched:
            value = probe.browsers()
        self.assertEqual(set(value), {"chromium", "webkit", "chrome", "playwrightCacheGiB"})
        self.assertEqual(value["chrome"], {"returncode": 1, "durationMs": 3, "stderrTail": "launch failed", "screenshotBytes": 0})
        self.assertIsNone(value["playwrightCacheGiB"])
        channels = [call.args[0] for call in launched.call_args_list]
        self.assertIn(["--channel", "chrome"], [argv[argv.index("--channel"):argv.index("--channel") + 2] for argv in channels if "--channel" in argv])
        self.assertTrue(all(argv[-2] == "about:blank" and Path(argv[-1]).parent == Path(temporary) for argv in channels))


if __name__ == "__main__":
    unittest.main()
