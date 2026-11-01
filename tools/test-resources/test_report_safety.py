"""KiB 级报告边界：只使用虚构值，不启动浏览器、数据库或 VM。"""
import base64
import hashlib
import importlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import lifecycle
import run as runner


CANARY = 'synthetic-report-secret-value'
UNSAFE = {'config': {'webServer': {'env': {'UNRELATED_CREDENTIAL': CANARY}}},
          'stats': {'expected': 1, 'unexpected': 0}}
SAFE = {'config': {'webServer': {'command': 'node service.mjs'}},
        'stats': {'expected': 1, 'unexpected': 0}}


def html_report(value):
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as zipped:
        zipped.writestr('report.json', json.dumps(value))
    return b'<html><script>window.playwrightReportBase64="data:application/zip;base64,' + base64.b64encode(archive.getvalue()) + b'";</script></html>'


class ReportSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='nerve-report-safety-')
        self.root = Path(self.temporary.name).resolve()
        self.addCleanup(self.temporary.cleanup)
        self.results = self.root / 'test-results'; self.results.mkdir()
        self.html = self.root / 'playwright-report'; self.html.mkdir()

    def check(self, leaf='test-results'):
        try:
            safety = importlib.import_module('report_safety')
        except ModuleNotFoundError:
            self.fail('缺少报告环境发布保护')
        return safety.check_leaf(self.root / leaf, leaf)

    def rejected(self, leaf='test-results'):
        with self.assertRaises(ValueError) as error:
            self.check(leaf)
        self.assertNotIn(CANARY, str(error.exception))
        self.assertNotIn('UNRELATED_CREDENTIAL', str(error.exception))

    def test_safe_reports_are_read_only_and_repeatable(self):
        path = self.results / 'results.json'; path.write_text(json.dumps(SAFE))
        html = self.html / 'index.html'; html.write_bytes(html_report(SAFE))
        before = [hashlib.sha256(p.read_bytes()).hexdigest() for p in [path, html]]
        self.assertEqual(self.check(), self.check())
        self.assertEqual(self.check('playwright-report'), self.check('playwright-report'))
        self.assertEqual(before, [hashlib.sha256(p.read_bytes()).hexdigest() for p in [path, html]])

    def test_any_nonempty_serialized_environment_is_rejected_including_arrays(self):
        for server in [{'env': {'NON_SECRET_TOO': ''}}, [{'env': {}}, UNSAFE['config']['webServer']], {'env': CANARY}]:
            with self.subTest(serverType=type(server).__name__):
                (self.results / 'results.json').write_text(json.dumps({'config': {'webServer': server}}))
                self.rejected()

    def test_empty_or_absent_environments_and_failed_reports_are_allowed(self):
        for server in [None, [], {'env': {}}, [{'command': 'false'}]]:
            with self.subTest(serverType=type(server).__name__):
                (self.results / 'results.json').write_text(json.dumps({'config': {'webServer': server}, 'stats': {'unexpected': 1}}))
                self.check()

    def test_embedded_html_zip_cannot_hide_a_serialized_environment(self):
        (self.html / 'index.html').write_bytes(html_report(UNSAFE))
        self.rejected('playwright-report')

    def test_invalid_or_ambiguous_json_is_rejected_without_body_in_error(self):
        for payload in [b'{', b'[]', b'{"config":{},"config":{"webServer":{"env":{"x":"synthetic-report-secret-value"}}}}', b'{"config":{"webServer":42}}', b'{"value":NaN}', b'\xff']:
            with self.subTest(length=len(payload)):
                (self.results / 'results.json').write_bytes(payload)
                self.rejected()

    def test_invalid_embedded_payload_is_not_treated_as_plain_html(self):
        for payload in [b'data:application/zip;base64,!!!!', b'data:application/zip;base64,YmFk', b'data:application/zip;base64,AAAA=']:
            with self.subTest(length=len(payload)):
                (self.html / 'index.html').write_bytes(payload)
                self.rejected('playwright-report')

    def test_linked_file_and_parent_are_rejected_without_reading_target(self):
        external = self.root / 'unrelated.json'; external.write_text(json.dumps(UNSAFE))
        (self.results / 'results.json').symlink_to(external)
        self.rejected()
        (self.results / 'results.json').unlink(); self.results.rmdir()
        self.results.symlink_to(self.html, target_is_directory=True)
        self.rejected()
        self.assertEqual(json.loads(external.read_text()), UNSAFE)

    def test_json_and_expanded_zip_have_small_testable_budgets(self):
        safety = importlib.import_module('report_safety')
        (self.results / 'results.json').write_text(json.dumps({'large': 'x' * 1024}))
        with patch.object(safety, 'MAX_JSON_BYTES', 512):
            self.rejected()
        (self.html / 'index.html').write_bytes(html_report({'large': 'x' * 1024}))
        with patch.object(safety, 'MAX_EXPANDED_BYTES', 512):
            self.rejected('playwright-report')


class ReportPublicationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='nerve-report-publication-')
        self.repo = Path(self.temporary.name).resolve()
        self.addCleanup(self.temporary.cleanup)
        host = patch.object(lifecycle.hosted, 'context', return_value=None)
        host.start(); self.addCleanup(host.stop)
        self.store = lifecycle.Store(self.repo)

    def create(self, document, html):
        value = self.store.create('e2e'); self.addCleanup(value.release)
        results = value.scratch / 'tests/e2e/test-results'; results.mkdir(parents=True)
        (results / 'results.json').write_text(json.dumps(document))
        page = value.scratch / 'tests/e2e/playwright-report'; page.mkdir()
        (page / 'index.html').write_bytes(html)
        value.update(producerQuiescent=True, exitCode=0)
        value.finish('passed', release=False)
        return value

    def test_unsafe_json_or_html_cannot_partially_publish_or_rewrite_evidence(self):
        for document, html in [(UNSAFE, html_report(SAFE)), (SAFE, html_report(UNSAFE))]:
            with self.subTest(unsafeJson=document is UNSAFE):
                value = self.create(document, html)
                report = value.directory / 'reports/test-results/results.json'
                before = report.read_bytes()
                with self.assertRaises(ValueError) as error:
                    runner.publish(value, 'e2e')
                self.assertNotIn(CANARY, str(error.exception))
                self.assertEqual(report.read_bytes(), before)
                self.assertFalse((self.repo / 'tests/e2e/test-results').exists())
                self.assertFalse((self.repo / 'tests/e2e/playwright-report').exists())
                self.assertEqual(value.data['status'], 'passed')
                self.assertFalse(value.data.get('publicationComplete', False))
                self.assertEqual(value.data['reportSafety']['status'], 'rejected')
                self.assertFalse(value.scratch.exists())
                value.release()

    def test_safe_publication_can_resume_without_mutating_test_results(self):
        value = self.create(SAFE, html_report(SAFE))
        expected = (value.directory / 'reports/test-results/results.json').read_bytes()
        runner.publish(value, 'e2e'); runner.publish(value, 'e2e')
        self.assertTrue(value.data['publicationComplete'])
        self.assertEqual(value.data['reportSafety']['status'], 'passed')
        self.assertEqual((self.repo / 'tests/e2e/test-results/results.json').read_bytes(), expected)

    def test_resume_rechecks_already_published_reports_before_acceptance(self):
        value = self.create(SAFE, html_report(SAFE))
        runner.publish(value, 'e2e')
        (self.repo / 'tests/e2e/test-results/results.json').write_text(json.dumps(UNSAFE))
        with self.assertRaises(ValueError):
            runner.publish(value, 'e2e')
        self.assertFalse(value.data.get('publicationComplete', False))


if __name__ == '__main__':
    unittest.main()
