"""Synthetic KiB diagnostics; names here are not claims about a CI host."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from lifecycle import Store, lsof_incomplete_records, open_paths


class LsofDiagnosticSampleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="nerve-lsof-diagnostic-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()

    def diagnostic(self, output):
        answer = subprocess.CompletedProcess(["lsof"], 0, os.fsencode(output), b"")
        with patch.dict(os.environ, {}, clear=True), patch("lifecycle.subprocess.run", return_value=answer):
            with self.assertRaises(RuntimeError) as caught:
                open_paths(self.root)
        text = str(caught.exception)
        return json.loads(text.split("：", 1)[1]), text

    def test_protocol_sample_keeps_exact_type_name_and_digest(self):
        name = "protocol: NETLINK"
        count, samples = lsof_incomplete_records(f"p607\nf3\ntsock\nn{name}\n")
        self.assertEqual(count, 1)
        self.assertEqual(len(samples), 1)
        sample = samples[0]
        self.assertEqual(sample.get("type"), "sock")
        self.assertEqual(sample.get("name"), name)
        self.assertEqual(sample.get("nameBytes"), len(name.encode()))
        self.assertEqual(sample.get("nameSha256"), hashlib.sha256(name.encode()).hexdigest())
        self.assertIs(sample.get("nameTruncated"), False)
        self.assertIs(sample.get("nameRedacted"), False)
        self.assertEqual(sample.get("multiplicity"), 1)

    def test_memfd_label_is_redacted_but_deleted_and_errno_remain(self):
        name = "/memfd:GLOBAL-STDOUT-SECRET (deleted) (stat: No such file or directory)"
        details, text = self.diagnostic(f"p2019\nfmem\ntREG\nn{name}\n")
        sample = details["incompleteRecords"][0]
        self.assertEqual(sample.get("name"), "/memfd:<redacted> (deleted) (stat: No such file or directory)")
        self.assertEqual(sample.get("type"), "REG")
        self.assertEqual(sample["operation"], "stat")
        self.assertEqual(sample.get("nameBytes"), len(name.encode()))
        self.assertEqual(sample.get("nameSha256"), hashlib.sha256(name.encode()).hexdigest())
        self.assertIs(sample.get("nameRedacted"), True)
        self.assertNotIn("GLOBAL-STDOUT-SECRET", text)

    def test_absolute_path_redaction_keeps_error_annotation(self):
        for suffix in (" (readlink: Permission denied)", " lstat: No such file or directory)",
                       " (path dev=8,1,inode=42)"):
            with self.subTest(suffix=suffix):
                name = "/other/GLOBAL-STDOUT-SECRET" + suffix
                details, text = self.diagnostic(f"p144\nfmem\ntREG\nn{name}\n")
                sample = details["incompleteRecords"][0]
                self.assertEqual(sample.get("name"), "<absolute-path>" + suffix)
                self.assertIs(sample.get("nameRedacted"), True)
                self.assertNotIn("GLOBAL-STDOUT-SECRET", text)

    def test_filename_annotations_cannot_leak_before_a_safe_tail(self):
        cases = [
            ("/private/file (stat: /private/other/SECRET) (stat: Permission denied)",
             "<absolute-path> (stat: Permission denied)"),
            ("/private/file (path dev=/private/other/SECRET) (path dev=8,1,inode=42)",
             "<absolute-path> (path dev=8,1,inode=42)"),
            ("/private/file (path inode=/private/other/SECRET) (path inode=42)",
             "<absolute-path> (path inode=42)"),
            ("/memfd:label (stat: /private/other/SECRET) (deleted) (stat: No such file or directory)",
             "/memfd:<redacted> (deleted) (stat: No such file or directory)"),
        ]
        for name, expected in cases:
            with self.subTest(name=name):
                details, text = self.diagnostic(f"p123\nfmem\ntREG\nn{name}\n")
                self.assertEqual(details["incompleteRecordCount"], 1)
                self.assertNotIn("/private/other", text)
                self.assertNotIn("SECRET", text)
                sample = details["incompleteRecords"][0]
                self.assertEqual(sample["name"], expected)
                self.assertEqual(sample["nameSha256"], hashlib.sha256(name.encode()).hexdigest())

    def test_unrecognized_annotation_text_is_replaced_by_identity_metadata(self):
        suffixes = [
            " (stat: /private/other/SECRET)",
            " (stat: Permission denied /private/other/SECRET)",
            " (path dev=8,1,inode=/private/other/SECRET)",
            " (path inode=SECRET)",
            " (path dev=8,1, inode=42 /private/other/SECRET)",
        ]
        for suffix in suffixes:
            with self.subTest(suffix=suffix):
                name = "/private/file" + suffix
                details, text = self.diagnostic(f"p123\nfmem\ntREG\nn{name}\n")
                self.assertEqual(details["incompleteRecordCount"], 1)
                self.assertNotIn("/private/other", text)
                self.assertNotIn("SECRET", text)
                sample = details["incompleteRecords"][0]
                self.assertEqual(sample["name"], "<absolute-path>")
                self.assertEqual(sample["operation"], "stat")
                self.assertEqual(sample["nameBytes"], len(name.encode()))
                self.assertEqual(sample["nameSha256"], hashlib.sha256(name.encode()).hexdigest())
                self.assertTrue(sample["nameRedacted"])

    def test_fixed_c_errno_tails_and_numeric_mapping_tails_remain_visible(self):
        # C-locale errno spellings, not arbitrary third-party error text.
        suffixes = [" (stat: No such file or directory)", " (readlink: Permission denied)",
                    " (opendir: Operation not permitted)", " (lstat: Stale file handle)",
                    " (path dev=8,1)", " (path dev=8,1, inode=42)", " (path inode=42)"]
        for suffix in suffixes:
            with self.subTest(suffix=suffix):
                details, text = self.diagnostic(f"p123\nfmem\ntREG\nn/private/SECRET{suffix}\n")
                self.assertEqual(details["incompleteRecordCount"], 1)
                self.assertEqual(details["incompleteRecords"][0]["name"], "<absolute-path>" + suffix)
                self.assertNotIn("SECRET", text)

    def test_identical_task_records_do_not_hide_a_later_anomaly(self):
        repeated = "p1140\nf9\ntsock\nnprotocol: UNIX\n"
        later = "p2019\nfmem\ntREG\nn/memfd:private (stat: No such file or directory)\n"
        details, _ = self.diagnostic(repeated * 20 + later)
        self.assertEqual(details["incompleteRecordCount"], 21)
        self.assertEqual(len(details["incompleteRecords"]), 2)
        self.assertEqual([s.get("multiplicity") for s in details["incompleteRecords"]], [20, 1])
        self.assertEqual([s["pid"] for s in details["incompleteRecords"]], [1140, 2019])
        self.assertIs(details["incompleteRecordsTruncated"], False)

    def test_distinct_original_names_do_not_merge_after_redaction_or_truncation(self):
        names = ["/private/one (stat: Permission denied)", "/private/two (stat: Permission denied)",
                 "protocol: " + "x" * 600 + "a", "protocol: " + "x" * 600 + "b"]
        count, samples = lsof_incomplete_records("".join(f"p123\nfmem\ntREG\nn{name}\n" for name in names))
        self.assertEqual(count, 4)
        self.assertEqual(len(samples), 4)
        self.assertEqual([s.get("multiplicity") for s in samples], [1, 1, 1, 1])
        self.assertEqual(len({s.get("nameSha256") for s in samples}), 4)
        self.assertEqual(samples[0]["name"], samples[1]["name"])
        self.assertEqual(samples[2]["name"], samples[3]["name"])

    def test_pid_fd_and_type_differences_keep_separate_samples(self):
        fields = [(123, "3", "sock"), (124, "3", "sock"), (123, "4", "sock"), (123, "3", "REG")]
        output = "".join(f"p{pid}\nf{fd}\nt{kind}\nnprotocol: TCP\n" for pid, fd, kind in fields)
        count, samples = lsof_incomplete_records(output + output)
        self.assertEqual(count, 8)
        self.assertEqual(len(samples), 4)
        self.assertEqual([s.get("multiplicity") for s in samples], [2, 2, 2, 2])
        self.assertEqual([(s["pid"], s["fd"], s.get("type")) for s in samples], fields)

    def test_unique_cap_counts_later_duplicates_without_hiding_truncation(self):
        records = [f"p{pid}\nf3\ntsock\nnprotocol: UNKNOWN\n" for pid in range(100, 117)]
        details, _ = self.diagnostic("".join(records) + records[0] * 3)
        self.assertEqual(details["incompleteRecordCount"], 20)
        self.assertEqual(len(details["incompleteRecords"]), 16)
        self.assertEqual(details["incompleteRecords"][0].get("multiplicity"), 4)
        self.assertEqual(sum(s.get("multiplicity", 0) for s in details["incompleteRecords"]), 19)
        self.assertIs(details["incompleteRecordsTruncated"], True)

    def test_name_limit_is_bytes_and_digest_covers_the_full_name(self):
        name = "protocol: " + "界" * 200
        details, _ = self.diagnostic(f"p123\nf3\ntsock\nn{name}\n")
        sample = details["incompleteRecords"][0]
        self.assertIn("name", sample)
        self.assertLessEqual(len(os.fsencode(sample["name"])), 512)
        self.assertTrue(sample["name"].startswith("protocol: "))
        self.assertEqual(sample.get("nameBytes"), 610)
        self.assertEqual(sample.get("nameSha256"), hashlib.sha256(name.encode()).hexdigest())
        self.assertIs(sample.get("nameTruncated"), True)

    def test_controls_and_undecodable_bytes_survive_only_as_safe_json(self):
        name = os.fsdecode(b"protocol: UNKNOWN\t\x1b[31m\xff")
        details, text = self.diagnostic(f"p123\nf3\ntsock\nn{name}\n")
        sample = details["incompleteRecords"][0]
        self.assertEqual(sample.get("name"), name)
        self.assertEqual(sample.get("nameSha256"), hashlib.sha256(os.fsencode(name)).hexdigest())
        payload = text.split("：", 1)[1]
        self.assertNotIn("\t", payload)
        self.assertNotIn("\x1b", payload)
        payload.encode("utf-8")
        self.assertIn("\\u001b", payload)
        self.assertIn("\\udcff", payload)

    def test_missing_name_is_distinct_from_present_empty_name(self):
        for field, name, length, digest in [("", None, None, None),
                                            ("n\n", "", 0, hashlib.sha256(b"").hexdigest())]:
            with self.subTest(name=name):
                count, samples = lsof_incomplete_records("p123\nf3\ntREG\n" + field)
                self.assertEqual(count, 1)
                self.assertIn("name", samples[0])
                self.assertEqual(samples[0]["name"], name)
                self.assertEqual(samples[0].get("nameBytes"), length)
                self.assertEqual(samples[0].get("nameSha256"), digest)
                self.assertIs(samples[0].get("nameTruncated"), False)

    def test_invalid_oversized_type_is_bounded_and_still_rejected(self):
        kind = "REG" + "x" * 600
        details, _ = self.diagnostic(f"p123\nf3\nt{kind}\nnprotocol: UNKNOWN\n")
        self.assertEqual(details["incompleteRecordCount"], 2)
        sample = details["incompleteRecords"][-1]
        self.assertIn("type", sample)
        self.assertEqual(sample["type"], "REG" + "x" * 13)
        self.assertEqual(sample.get("typeBytes"), 603)
        self.assertIs(sample.get("typeTruncated"), True)

    def test_full_sample_set_with_escaped_controls_is_still_bounded(self):
        name = "protocol: " + "\x1b" * 600
        output = "".join(f"p{pid}\nf3\ntsock\nn{name}\n" for pid in range(100, 116))
        details, text = self.diagnostic(output)
        self.assertEqual(details["incompleteRecordCount"], 16)
        self.assertEqual(len(details["incompleteRecords"]), 16)
        self.assertIs(details["incompleteRecordsTruncated"], False)
        self.assertLessEqual(len(text.encode()), 64 * 1024)
        for sample in details["incompleteRecords"]:
            self.assertIn("name", sample)
            self.assertLessEqual(len(os.fsencode(sample["name"])), 512)
            self.assertIs(sample.get("nameTruncated"), True)

    def test_regular_global_names_are_not_copied_into_anomaly_samples(self):
        output = "p100\nf3\ntREG\nn/elsewhere/GLOBAL-STDOUT-SECRET\nf4\ntsock\nnprotocol: UNKNOWN\n"
        details, text = self.diagnostic(output)
        self.assertEqual(details["incompleteRecordCount"], 1)
        self.assertEqual(details["incompleteRecords"][0].get("name"), "protocol: UNKNOWN")
        self.assertNotIn("GLOBAL-STDOUT-SECRET", text)

    def test_anomalies_still_preserve_registered_resources(self):
        run = Store(self.root).create("sample")
        marker = run.scratch / "keep"; marker.write_bytes(b"owned")
        answer = subprocess.CompletedProcess(["lsof"], 0, b"p123\nf3\ntsock\nnprotocol: UNKNOWN\n", b"")
        with patch.dict(os.environ, {}, clear=True), patch("lifecycle.subprocess.run", return_value=answer):
            result = run.finish("passed")
        self.assertEqual(result["status"], "cleanup-pending")
        self.assertEqual(marker.read_bytes(), b"owned")
        details = json.loads(result["cleanupError"].split("：", 1)[1])
        self.assertEqual(details["incompleteRecordCount"], 1)
        self.assertEqual(details["incompleteRecords"][0].get("type"), "sock")


if __name__ == "__main__":
    unittest.main()
