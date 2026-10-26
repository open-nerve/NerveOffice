import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from archive import Archives

class ArchiveTests(unittest.TestCase):
    def test_expired_archive_retires_bulk_but_preserves_source_summary_and_index(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve(); store = Archives(root, cap=1024)
            bundle, lease = store.create('sample')
            try:
                (bundle / 'source').mkdir(); (bundle / 'source/only.ts').write_text('unique source')
                (bundle / 'run.json').write_text('{"status":"failed"}')
                (bundle / 'output').mkdir(); (bundle / 'output/large').write_bytes(b'x'*2048)
                store.seal(bundle)
            finally: lease.__exit__(None, None, None)
            store.prune(); store.prune()
            self.assertFalse((bundle / 'output').exists())
            self.assertEqual((bundle / 'source/only.ts').read_text(), 'unique source')
            self.assertTrue((bundle / 'retirement.json').exists())
            self.assertTrue((bundle / 'run.json').exists())

    def test_active_pinned_and_unknown_bundles_are_preserved(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve(); store = Archives(root, cap=0)
            active, lease = store.create('active')
            try:
                (active / 'output').mkdir(); (active / 'output/data').write_text('active')
                pinned, lease2 = store.create('pinned')
                try:
                    (pinned / 'output').mkdir(); (pinned / 'output/data').write_text('proof')
                    store.seal(pinned); store.pin(pinned, 'final reviewed acceptance')
                finally: lease2.__exit__(None, None, None)
                unknown = root / 'legacy'; (unknown / 'output').mkdir(parents=True)
                (unknown / 'output/data').write_text('unknown')
                store.prune()
                self.assertTrue((active / 'output/data').exists())
                self.assertTrue((pinned / 'output/data').exists())
                self.assertTrue((unknown / 'output/data').exists())
            finally: lease.__exit__(None, None, None)

    def test_interrupted_retirement_keeps_first_inventory_and_finishes_transaction(self):
        import archive
        with tempfile.TemporaryDirectory() as temp:
            store = Archives(Path(temp).resolve(), cap=1024)
            bundle, lease = store.create('crash')
            (bundle / 'output').mkdir(); (bundle / 'output/large').write_bytes(b'x'*2048)
            (bundle / 'prior-output').mkdir(); (bundle / 'prior-output/tiny').write_text('small')
            store.seal(bundle); lease.__exit__(None,None,None)
            original = archive.remove
            class PowerLoss(BaseException): pass
            def interrupted(path, root):
                original(path,root)
                if path.name == 'output': raise PowerLoss()
            with patch.object(archive,'remove',interrupted):
                with self.assertRaises(PowerLoss): store.prune()
            pending = json.loads((bundle / 'retirement-pending.json').read_text())
            store.prune(); store.prune()
            self.assertEqual(json.loads((bundle / 'retirement.json').read_text()),pending)
            self.assertFalse((bundle / 'prior-output').exists())

    def test_tail_log_link_does_not_overwrite_external_file(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp).resolve(); store=Archives(root,cap=1)
            external=root/'business';external.write_text('keep')
            bundle,lease=store.create('linked')
            (bundle/'command.log').write_text('original log')
            (bundle/'command-tail.log').symlink_to(external)
            store.seal(bundle);lease.__exit__(None,None,None)
            with self.assertRaises(ValueError): store.prune()
            self.assertEqual(external.read_text(),'keep')


if __name__ == '__main__': unittest.main()
