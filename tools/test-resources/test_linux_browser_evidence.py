import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

import linux_browser_evidence as subject


def command(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], stderr=subprocess.DEVNULL)


def report(count=1):
    return {'config': {}, 'errors': [], 'stats': {'expected': count, 'unexpected': 0, 'flaky': 0, 'skipped': 0},
            'suites': [{'specs': [{'ok': True, 'tests': [{'projectName': 'chromium', 'expectedStatus': 'passed',
                                                       'status': 'expected', 'results': [{'status': 'passed', 'retry': 0}]}]}
                                  for unused in range(count)]}]}


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='nerve-linux-evidence-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.repo = self.root / 'repo'; self.repo.mkdir()
        command(self.repo, 'init', '-q')
        command(self.repo, 'config', 'user.email', 'fixture@example.invalid')
        command(self.repo, 'config', 'user.name', 'Fixture')
        (self.repo / 'input.txt').write_text('source\n')
        command(self.repo, 'add', '.')
        command(self.repo, 'commit', '-qm', 'fixture')

    def snapshot(self):
        return subject.snapshot_source(self.repo, self.root / 'copy', self.root / 'source.json')

    def test_copy_has_committed_bytes_and_no_git_or_ignored_data(self):
        (self.repo / '.git' / 'private-data').write_text('keep')
        proof = self.snapshot()
        self.assertEqual((self.root / 'copy/input.txt').read_bytes(), b'source\n')
        self.assertFalse((self.root / 'copy/.git').exists())
        self.assertEqual(proof['head'], command(self.repo, 'rev-parse', 'HEAD').decode().strip())
        subject.verify_source(self.root / 'copy', proof)

    def test_dirty_or_untracked_source_is_refused_before_copy(self):
        (self.repo / 'input.txt').write_text('unfinished')
        with self.assertRaisesRegex(ValueError, 'source-dirty'):
            self.snapshot()
        self.assertFalse((self.root / 'copy').exists())

    def test_source_symlink_is_refused_even_when_committed(self):
        (self.repo / 'escape').symlink_to(self.root / 'other')
        command(self.repo, 'add', '.'); command(self.repo, 'commit', '-qm', 'link')
        with self.assertRaisesRegex(ValueError, 'source-mode'):
            self.snapshot()

    def test_relative_license_link_with_tracked_regular_target_is_preserved(self):
        licenses = self.repo / 'licenses/platform'; licenses.mkdir(parents=True)
        (self.repo / 'licenses/LICENSE').write_text('license fixture')
        (licenses / 'LICENSE').symlink_to('../LICENSE')
        command(self.repo, 'add', '.'); command(self.repo, 'commit', '-qm', 'license')
        proof = self.snapshot()
        self.assertTrue((self.root / 'copy/licenses/platform/LICENSE').is_symlink())
        self.assertEqual((self.root / 'copy/licenses/platform/LICENSE').read_text(), 'license fixture')
        subject.verify_source(self.root / 'copy', proof)
        (self.root / 'copy/licenses/platform/LICENSE').unlink()
        (self.root / 'copy/licenses/platform/LICENSE').symlink_to('../../input.txt')
        with self.assertRaises(ValueError):
            subject.verify_source(self.root / 'copy', proof)

    def test_drift_and_parent_symlink_fail_verification(self):
        proof = self.snapshot()
        (self.root / 'copy/input.txt').write_text('drift')
        with self.assertRaisesRegex(ValueError, 'source-bytes'):
            subject.verify_source(self.root / 'copy', proof)
        (self.root / 'copy/input.txt').unlink()
        (self.root / 'copy/input.txt').symlink_to(self.repo / 'input.txt')
        with self.assertRaisesRegex(ValueError, 'source-mode'):
            subject.verify_source(self.root / 'copy', proof)

    def test_sdk_proof_checks_actual_bytes_and_patch_set(self):
        patches = self.repo / 'patches'; patches.mkdir()
        package = self.repo / 'apps/web/node_modules/@example/sdk'; package.mkdir(parents=True)
        (package / 'package.json').write_text('{"version":"1.0.1"}')
        (package / 'entry.js').write_bytes(b'fixed')
        patch = b'+++ b/entry.js\n'
        (patches / 'sdk.patch').write_bytes(patch)
        manifest = {'package': '@example/sdk', 'version': '1.0.1', 'patch': 'patches/sdk.patch',
                    'patchSha256': hashlib.sha256(patch).hexdigest(), 'entry': 'entry.js',
                    'patchedEsSha256': hashlib.sha256(b'fixed').hexdigest()}
        (patches / 'sdk.json').write_text(json.dumps(manifest))
        proof = subject.installed_patches(self.repo)
        self.assertEqual(proof['@example/sdk']['version'], '1.0.1')
        (package / 'entry.js').write_bytes(b'wrong')
        with self.assertRaisesRegex(ValueError, 'patch-installed-bytes'):
            subject.installed_patches(self.repo)

    def test_result_requires_every_original_case_without_skips_retries_or_errors(self):
        self.assertEqual(subject.validate_results(report(13), 13), 13)
        for field in ('skipped', 'unexpected', 'flaky'):
            value = report(); value['stats'][field] = 1
            with self.assertRaises(ValueError):
                subject.validate_results(value, 1)
        value = report(); value['suites'][0]['specs'][0]['tests'][0]['results'][0]['retry'] = 1
        with self.assertRaises(ValueError):
            subject.validate_results(value, 1)
        with self.assertRaises(ValueError):
            subject.validate_results(report(), 13)

    def test_result_refuses_serialized_server_environment(self):
        value = report(); value['config'] = {'webServer': {'env': {'PRIVATE': 'fixture-only'}}}
        with self.assertRaisesRegex(ValueError, 'serialized-webserver-environment'):
            subject.validate_results(value, 1)

    def test_group_collection_omits_profile_and_is_repeatable(self):
        group = self.root / 'group'; results = group / 'tests/e2e/test-results'
        results.mkdir(parents=True)
        (results / 'results.json').write_text(json.dumps(report()))
        (results / 'persistent-profiles/example').mkdir(parents=True)
        (results / 'persistent-profiles/example/cache').write_bytes(b'not a report')
        html = group / 'tests/e2e/playwright-report'; html.mkdir()
        (html / 'index.html').write_text('<html>fixture</html>')
        target = self.root / 'export'
        run = '0199a2c4-1111-7000-8000-111111111111'
        subject.collect_group(group, target, run, 1)
        subject.collect_group(group, target, run, 1)
        self.assertTrue((target / 'test-results/results.json').is_file())
        self.assertFalse((target / 'test-results/persistent-profiles/example/cache').exists())
        self.assertTrue((results / 'persistent-profiles/example/cache').exists())

    def test_unsafe_report_is_refused_before_export(self):
        group = self.root / 'group'; results = group / 'tests/e2e/test-results'; results.mkdir(parents=True)
        value = report(); value['config'] = {'webServer': {'env': {'PRIVATE': 'fixture-only'}}}
        (results / 'results.json').write_text(json.dumps(value))
        target = self.root / 'export'
        with self.assertRaisesRegex(ValueError, 'serialized-webserver-environment'):
            subject.collect_group(group, target, 'fixture', 1)
        self.assertFalse(target.exists())

    def test_json_input_is_bounded_and_refuses_symlink_or_duplicate_keys(self):
        path = self.root / 'bounded.json'; path.write_text('{"fixture":"too long"}')
        with self.assertRaisesRegex(ValueError, 'evidence-json-budget'):
            subject.read_json(path, limit=8)
        alias = self.root / 'alias.json'; alias.symlink_to(path)
        with self.assertRaises(OSError):
            subject.read_json(alias)
        path.write_text('{"version":1,"version":2}')
        with self.assertRaises(ValueError):
            subject.read_json(path)

    def test_missing_or_mismatched_guest_proofs_cannot_pass(self):
        root = self.root / 'owned'; root.mkdir(); evidence = root / 'evidence'; evidence.mkdir()
        with self.assertRaises((OSError, ValueError)):
            subject.validate_guest_evidence(root)
        (root / 'source.json').write_text(json.dumps({'head': 'fixture-head', 'files': [{'path': 'input'}]}))
        patches = {str(index): {'fixture': index} for index in range(16)}
        (root / 'host-patches.json').write_text(json.dumps(patches))
        fixtures = {
            'source-before.json': {'head': 'fixture-head', 'files': 1, 'verified': True},
            'source-after.json': {'head': 'fixture-head', 'files': 1, 'verified': True},
            'patches-before.json': patches, 'patches-after.json': patches,
            'versions.json': {'platform': 'Linux', 'machine': 'aarch64', 'node': 'v24.21.0', 'pnpm': '12.6.0',
                              'playwright': '1.63.0', 'osRelease': 'VERSION_ID="24.04"'},
            'execution.json': {'status': 0, 'steps': [{'status': 0} for unused in range(5)]},
            'preflight-before-install.json': {'version': 1, 'phase': 'before-install', 'completeQueryPassed': True},
            'preflight-after-pnpm.json': {'version': 1, 'phase': 'after-pnpm', 'completeQueryPassed': True},
        }
        for name, value in fixtures.items():
            (evidence / name).write_text(json.dumps(value))
        self.assertTrue(subject.validate_guest_evidence(root)['verified'])
        for name, original in fixtures.items():
            (evidence / name).write_text('{}')
            with self.subTest(name=name), self.assertRaises(ValueError):
                subject.validate_guest_evidence(root)
            (evidence / name).write_text(json.dumps(original))

    def test_unpublished_inner_report_requests_retention_without_exporting_it(self):
        root = self.root / 'owned'; run = root / 'source/.test-resources/runs/inner'; run.mkdir(parents=True)
        (run / 'run.json').write_text(json.dumps({'runId': 'inner', 'status': 'passed', 'cleanupStage': 'complete',
                                                'publicationComplete': False, 'reportSafety': {'status': 'rejected'}}))
        original = run / 'reports/test-results/results.json'; original.parent.mkdir(parents=True)
        original.write_text('{"fixture":"rejected-original"}')
        output = self.root / 'output'; output.mkdir()
        summary = subject.collect_all(root, output)
        self.assertFalse(summary['safeToRelease'])
        self.assertTrue(original.exists())
        self.assertFalse((output / 'calibration').exists())

    def test_safe_failed_group_is_exported_and_allows_temporary_environment_release(self):
        root = self.root / 'owned'
        inner = root / 'source/.test-resources/runs/inner'; inner.mkdir(parents=True)
        (inner / 'run.json').write_text(json.dumps({'runId': 'inner', 'status': 'failed', 'cleanupStage': 'complete', 'publicationComplete': True}))
        (inner / 'reports').mkdir()
        (inner / 'reports/command.log').write_bytes(b'original inner log')
        group = root / 'evidence/groups/calibration/tests/e2e'
        results = group / 'test-results'; results.mkdir(parents=True)
        value = report(); value['stats']['unexpected'] = 1; value['stats']['expected'] = 0
        (results / 'results.json').write_text(json.dumps(value))
        (results / 'cleanup-receipt.json').write_text(json.dumps({'runId': 'inner', 'status': 'failed', 'cleanupStage': 'complete'}))
        html = group / 'playwright-report'; html.mkdir(); (html / 'index.html').write_text('<html>failure</html>')
        output = self.root / 'output'; output.mkdir()
        summary = subject.collect_all(root, output)
        self.assertTrue(summary['safeToRelease'])
        self.assertFalse(summary['passed'])
        self.assertTrue((output / 'calibration/test-results/results.json').is_file())
        self.assertEqual((output / 'inner-runs/inner/run.json').read_bytes(), (inner / 'run.json').read_bytes())
        self.assertEqual((output / 'inner-runs/inner/reports/command.log').read_bytes(), b'original inner log')

    def test_filtered_run_residue_still_prevents_volume_release(self):
        root=self.root/'exported';root.mkdir();output=self.root/'output';output.mkdir()
        (root/'transport.json').write_text(json.dumps({'version':1,'sections':[
            {'section':'runs','unknownRunResidue':True}]}))
        self.assertFalse(subject.collect_all(root,output)['safeToRelease'])

    def test_published_budget_counts_metadata_and_inner_logs_not_only_group_payload(self):
        output=self.root/'output';output.mkdir()
        (output/'transport.json').write_bytes(b'x'*700)
        (output/'inner-runs').mkdir();(output/'inner-runs/log.txt').write_bytes(b'x'*400)
        with self.assertRaises(ValueError):subject.report_bytes(output,limit=1024)
        self.assertEqual(subject.report_bytes(output,limit=2048),1100)


if __name__ == '__main__':
    unittest.main()
