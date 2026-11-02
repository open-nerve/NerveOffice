import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import linux_browser_guest as subject
from test_linux_browser_evidence import report


class GuestTests(unittest.TestCase):
    def test_fresh_gitless_install_does_not_run_prepare_before_pnpm_preflight(self):
        # Regression: pnpm 12 exec installs missing dependencies and runs prepare.
        # Exercise the real pinned pnpm with no external packages or browser.
        with tempfile.TemporaryDirectory(prefix='nerve-linux-install-') as directory:
            root = Path(directory).resolve(); repo = root / 'source'; repo.mkdir()
            (repo / 'pnpm-workspace.yaml').write_text('packages: []\n')
            (repo / 'prepare.cjs').write_text("require('node:fs').writeFileSync('prepare-ran', 'unexpected'); process.exit(42);\n")
            (repo / 'package.json').write_text(json.dumps({
                'name': 'nerve-guest-install-regression', 'version': '1.0.0', 'private': True,
                'packageManager': 'pnpm@12.6.0', 'scripts': {'prepare': 'node prepare.cjs'},
            }))
            (root / 'empty.npmrc').write_text('')
            environment = {'XDG_STATE_HOME': str(root / 'state'), 'XDG_CACHE_HOME': str(root / 'cache'),
                           'XDG_DATA_HOME': str(root / 'data'), 'XDG_CONFIG_HOME': str(root / 'config'),
                           'npm_config_userconfig': str(root / 'empty.npmrc'),
                           'npm_config_cache': str(root / 'npm-cache'), 'CI': '1'}
            probe = root / 'probe.py'
            probe.write_text("from pathlib import Path\nPath('probe-ran').write_text('complete')\n")
            with patch.dict(os.environ, environment), patch.object(subject, '__file__', str(probe)):
                self.assertEqual(subprocess.check_output(['pnpm', '--version'], text=True).strip(), '12.6.0')
                subprocess.check_call(['pnpm', 'install', '--lockfile-only', '--ignore-scripts',
                                       '--store-dir', str(root / 'pnpm-store')], cwd=repo)
                lock = (repo / 'pnpm-lock.yaml').read_bytes()
                execute = lambda args: subprocess.call(args, cwd=repo)
                try:
                    status = subject.install_dependencies(repo, root, execute)
                except subprocess.CalledProcessError as error:
                    self.fail('preflight invoked implicit install/prepare before explicit install: '
                              + str((repo / 'prepare-ran').exists()) + '; exit=' + str(error.returncode))
            self.assertEqual(status, 0)
            self.assertEqual((repo / 'probe-ran').read_text(), 'complete')
            self.assertFalse((repo / 'prepare-ran').exists())
            self.assertEqual((repo / 'pnpm-lock.yaml').read_bytes(), lock)

    def test_failed_install_stops_before_pnpm_preflight(self):
        with patch.object(subject.subprocess, 'check_call',
                          side_effect=AssertionError('preflight started after failed install')):
            self.assertEqual(subject.install_dependencies(Path('/unused/source'), Path('/unused'),
                                                          lambda args: 23), 23)

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
