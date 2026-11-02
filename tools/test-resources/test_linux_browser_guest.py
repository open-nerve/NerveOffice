import json
from pathlib import Path
import tempfile
import unittest

import linux_browser_guest as subject
from test_linux_browser_evidence import report


class GuestTests(unittest.TestCase):
    def test_failed_calibration_does_not_start_stories_and_keeps_small_evidence(self):
        with tempfile.TemporaryDirectory(prefix='nerve-linux-guest-') as directory:
            root = Path(directory).resolve(); repo = root / 'source'; repo.mkdir()
            called = []
            def execute(args):
                called.append(args)
                results = repo / 'tests/e2e/test-results'; results.mkdir(parents=True)
                (results / 'failure.txt').write_text('fixture failure')
                return 1
            self.assertEqual(subject.run_groups(repo, root, execute), 1)
            self.assertEqual(len(called), 1)
            self.assertIn('security/csp.spec.ts', called[0])
            self.assertTrue((root / 'evidence/groups/calibration/tests/e2e/test-results/failure.txt').is_file())

    def test_success_requires_inner_cleanup_and_runs_exact_groups_in_order(self):
        with tempfile.TemporaryDirectory(prefix='nerve-linux-guest-') as directory:
            root = Path(directory).resolve(); repo = root / 'source'; repo.mkdir()
            calls = []
            def execute(args):
                calls.append(args)
                results = repo / 'tests/e2e/test-results'; results.mkdir(parents=True)
                (results / 'results.json').write_text(json.dumps(report(1 if len(calls) == 1 else 13)))
                (results / 'cleanup-receipt.json').write_text(json.dumps({'status': 'passed', 'cleanupStage': 'complete'}))
                return 0
            self.assertEqual(subject.run_groups(repo, root, execute), 0)
            self.assertEqual(len(calls), 2)
            self.assertIn('editor/paste-images.spec.ts', calls[1])
            self.assertTrue(all('--workers=1' in args for args in calls))

    def test_zero_exit_without_inner_cleanup_is_not_success(self):
        with tempfile.TemporaryDirectory(prefix='nerve-linux-guest-') as directory:
            root = Path(directory).resolve(); repo = root / 'source'; repo.mkdir()
            calls = []
            def execute(args):
                calls.append(args)
                return 0
            with self.assertRaises((OSError, ValueError)):
                subject.run_groups(repo, root, execute)
            self.assertEqual(len(calls), 1)

    def test_preflight_does_not_write_pass_when_complete_handle_query_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve(); (root/'evidence').mkdir()
            def failed(path): raise RuntimeError('mapping-identity-mismatch')
            with self.assertRaises(RuntimeError):subject.handle_preflight(root,'before-install',failed)
            self.assertFalse((root/'evidence/preflight-before-install.json').exists())
            subject.handle_preflight(root,'before-install',lambda path: [])
            self.assertEqual(json.loads((root/'evidence/preflight-before-install.json').read_text()),
                             {'version':1,'phase':'before-install','completeQueryPassed':True})


if __name__ == '__main__':
    unittest.main()
