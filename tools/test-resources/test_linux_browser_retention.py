"""KiB fixtures: a rejected inner report must survive outer cleanup/restart."""
from pathlib import Path
import subprocess
import sys
import unittest

from fixture_retention import ManagedFixture
from lifecycle import Store


class EvidenceRetentionTests(unittest.TestCase):
    def test_hold_keeps_original_across_finish_and_sweep_until_explicit_release(self):
        with ManagedFixture() as fixture:
            store = Store(fixture.path)
            run = store.create('container')
            original = run.scratch / 'rejected-report.json'
            original.write_text('{"fixture":"original"}')
            hold = run.directory / 'linux-browser-evidence-hold.json'
            hold.write_text('{"version":1}')
            result = run.finish('failed')
            self.assertEqual(result['status'], 'cleanup-pending')
            self.assertEqual(result['cleanupError'], 'linux-browser-evidence-retention-pending')
            store.sweep()
            self.assertEqual(original.read_text(), '{"fixture":"original"}')
            marker = store.repo / 'must-not-start'
            attempt = subprocess.run([sys.executable, '-B', str(Path(__file__).with_name('run.py')),
                                      '--repo', str(store.repo), 'container', '--', sys.executable, '-c',
                                      'from pathlib import Path; Path(' + repr(str(marker)) + ').touch()'],
                                     capture_output=True, timeout=20)
            self.assertNotEqual(attempt.returncode, 0)
            self.assertFalse(marker.exists())
            hold.unlink()  # only this fixture's explicit evidence disposition
            store.sweep(); store.sweep()
            self.assertFalse(run.scratch.exists())


if __name__ == '__main__':
    unittest.main()
