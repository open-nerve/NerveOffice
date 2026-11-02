import hashlib
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import linux_browser_transport as evidence


def archive(entries):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w') as output:
        for name, content, kind in entries:
            item = tarfile.TarInfo(name)
            item.type = kind
            if kind == tarfile.REGTYPE:
                item.size = len(content)
                output.addfile(item, io.BytesIO(content))
            else:
                item.linkname = content.decode()
                output.addfile(item)
    stream.seek(0)
    return stream


class TransportTests(unittest.TestCase):
    def receive(self, root, entries, section='evidence', **kwargs):
        return evidence.receive_archive(archive(entries), root, section, **kwargs)

    def test_regular_proof_and_trace_bytes_are_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            result = self.receive(root, [('versions.json', b'{"fixture":true}', tarfile.REGTYPE),
                ('groups/calibration/tests/e2e/test-results/case/trace.zip', b'fixture', tarfile.REGTYPE)])
            self.assertEqual((root/'evidence/versions.json').read_bytes(), b'{"fixture":true}')
            self.assertEqual(result['retainedBytes'], 23)
            self.assertEqual(result['files'][0]['sha256'], hashlib.sha256(b'{"fixture":true}').hexdigest())

    def test_raw_profile_is_not_exported_but_ownership_and_opfs_proof_are(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(); base='groups/calibration/tests/e2e/test-results/persistent-profiles/one/'
            result=self.receive(root, [(base+'Default/History', b'raw', tarfile.REGTYPE),
                (base+'resource-owner.json', b'{}', tarfile.REGTYPE),
                (base+'opfs-archive/index.json', b'{}', tarfile.REGTYPE)])
            self.assertFalse((root/'evidence'/base/'Default/History').exists())
            self.assertTrue((root/'evidence'/base/'opfs-archive/index.json').is_file())
            self.assertEqual(result['omittedFiles'], 1)

    def test_only_original_inner_ledger_and_log_are_copied(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve(); uid='0199a2c4-1111-7000-8000-111111111111'
            self.receive(root, [(uid+'/run.json', b'{"status":"cleanup-pending"}', tarfile.REGTYPE),
                (uid+'/scratch/tmp/large.db', b'not evidence', tarfile.REGTYPE)], section='runs')
            run=root/'source/.test-resources/runs'/uid
            self.assertEqual((run/'run.json').read_bytes(), b'{"status":"cleanup-pending"}')
            self.assertFalse((run/'scratch').exists())

    def test_links_special_files_traversal_and_unknown_evidence_are_rejected(self):
        for name,kind in [('../escape',tarfile.REGTYPE),('/escape',tarfile.REGTYPE),
            ('versions.json',tarfile.SYMTYPE),('versions.json',tarfile.LNKTYPE),
            ('versions.json',tarfile.FIFOTYPE),('database.db',tarfile.REGTYPE)]:
            with self.subTest(name=name,kind=kind),tempfile.TemporaryDirectory() as directory:
                with self.assertRaises((ValueError,RuntimeError)):
                    self.receive(Path(directory).resolve(),[(name,b'fixture',kind)])

    def test_duplicate_and_existing_files_cannot_be_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve()
            entries=[('versions.json',b'first',tarfile.REGTYPE),('./versions.json',b'second',tarfile.REGTYPE)]
            with self.assertRaises((ValueError,RuntimeError)):self.receive(root,entries)
            self.assertEqual((root/'evidence/versions.json').read_bytes(),b'first')
            with self.assertRaises((ValueError,RuntimeError,OSError)):self.receive(root,entries[:1])

    def test_payload_and_metadata_budgets_are_enforced_before_large_allocation(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve()
            with self.assertRaises((ValueError,RuntimeError)):
                self.receive(root,[('versions.json',b'x'*2048,tarfile.REGTYPE)],budget=1024)
            self.assertFalse((root/'evidence/versions.json').exists())
        stream=io.BytesIO()
        member=tarfile.TarInfo('pax');member.type=tarfile.XHDTYPE;member.size=1024**3
        stream.write(member.tobuf());stream.seek(0)
        with tempfile.TemporaryDirectory() as directory,self.assertRaises((ValueError,RuntimeError)):
            evidence.receive_archive(stream,Path(directory).resolve(),'evidence')

    def test_sparse_extensions_are_rejected_before_decoding_a_sparse_map(self):
        stream=io.BytesIO()
        with tarfile.open(fileobj=stream,mode='w',format=tarfile.PAX_FORMAT) as output:
            item=tarfile.TarInfo('versions.json');item.size=1
            item.pax_headers={'GNU.sparse.map':'0,1','GNU.sparse.size':'1'}
            output.addfile(item,io.BytesIO(b'x'))
        stream.seek(0)
        with tempfile.TemporaryDirectory() as directory,self.assertRaises(ValueError):
            evidence.receive_archive(stream,Path(directory).resolve(),'evidence')

    def test_aggregate_metadata_has_an_independent_small_budget(self):
        with tempfile.TemporaryDirectory() as directory,patch.object(evidence,'METADATA_LIMIT',1024,create=True):
            with self.assertRaises(ValueError):
                self.receive(Path(directory).resolve(),[(name,b'x',tarfile.REGTYPE) for name in
                    ('versions.json','source-before.json','source-after.json')])

    def test_empty_scratch_and_unknown_run_residue_survive_as_retention_signals(self):
        uid='0199a2c4-1111-7000-8000-111111111111'
        for name,kind in [(uid+'/scratch',tarfile.DIRTYPE),(uid+'/unknown.txt',tarfile.REGTYPE)]:
            with tempfile.TemporaryDirectory() as directory:
                result=self.receive(Path(directory).resolve(),[(name,b'',kind)],section='runs')
                self.assertTrue(result.get('unknownRunResidue',False))

    def test_completed_run_log_at_actual_reports_location_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve(); uid='0199a2c4-1111-7000-8000-111111111111'
            self.receive(root,[(uid+'/reports/command.log',b'original log',tarfile.REGTYPE)],section='runs')
            self.assertTrue((root/'source/.test-resources/runs'/uid/'reports/command.log').is_file())

    def test_empty_or_lock_only_run_remains_visible_when_ledger_creation_was_interrupted(self):
        uid='0199a2c4-1111-7000-8000-111111111111'
        for name,kind in [(uid,tarfile.DIRTYPE),(uid+'/run.lock',tarfile.REGTYPE)]:
            with tempfile.TemporaryDirectory() as directory:
                root=Path(directory).resolve()
                self.receive(root,[(name,b'',kind)],section='runs')
                self.assertTrue((root/'source/.test-resources/runs'/uid).is_dir())
                self.assertFalse((root/'source/.test-resources/runs'/uid/'run.json').exists())


if __name__=='__main__':unittest.main()
