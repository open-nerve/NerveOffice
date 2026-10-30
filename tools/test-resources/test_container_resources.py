"""KiB-owned fixtures only; Docker is never invoked by these tests."""
import json
import hashlib
import os
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import container_resources
import run as runner
from lifecycle import Store, atomic_json


class ContainerResourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='nerve-container-resources-')
        self.repo = Path(self.temp.name).resolve()
        self.store = Store(self.repo)
        self.runs = []

    def tearDown(self):
        for run in self.runs:
            run.release()
        # These deliberately pending ledgers describe only this test's KiB files, never Docker.
        self.temp.cleanup()

    def reserved(self):
        run = self.store.create('container')
        self.runs.append(run)
        run.update(containerResources={'version': 1, 'file': 'container-resources.json'})
        atomic_json(run.directory / 'container-resources.json', {
            'version': 1, 'runId': run.id, 'repo': str(self.repo), 'scratch': str(run.scratch),
            'state': 'reserved',
        })
        (run.scratch / 'test.env').write_text('fixture-only')
        return run

    def test_reserved_docker_intent_prevents_finish_from_discarding_environment(self):
        run = self.reserved()
        result = run.finish('interrupted')
        self.assertEqual(result['status'], 'cleanup-pending')
        self.assertEqual((run.scratch / 'test.env').read_text(), 'fixture-only')
        self.assertEqual(json.loads((run.directory / 'container-resources.json').read_text())['state'], 'reserved')

    def test_pending_intent_survives_sweep_and_blocks_next_container_entry(self):
        run = self.reserved()
        run.release()
        marker = self.repo / 'must-not-start'
        child = f'from pathlib import Path; Path({str(marker)!r}).write_text("started")'
        result = subprocess.run([sys.executable, '-B', str(Path(__file__).with_name('run.py')),
                                 '--repo', str(self.repo), 'container', '--', sys.executable, '-c', child],
                                text=True, capture_output=True, timeout=20)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(marker.exists())
        self.assertTrue((run.scratch / 'test.env').exists())

    def test_unclaimed_registration_is_present_before_child_and_finishes_normally(self):
        run = self.store.create('container')
        self.runs.append(run)
        self.assertEqual(run.data['containerResources'], container_resources.MARKER)
        self.assertEqual(json.loads((run.directory / container_resources.FILE).read_text()),
                         container_resources.initial(run.id, self.repo, run.scratch))
        self.assertEqual(run.finish('passed')['status'], 'passed')
        self.assertFalse(run.scratch.exists())

    def test_legacy_run_without_protocol_remains_legacy(self):
        run = self.store.create('check')
        self.runs.append(run)
        run.update(kind='container')
        self.assertEqual(run.finish('passed')['status'], 'passed')

    def test_started_legacy_container_with_remaining_scratch_is_not_claimed(self):
        run = self.store.create('check')
        self.runs.append(run)
        run.update(kind='container', status='running', childGroup=2147483646)
        env = run.scratch / 'test.env'
        env.write_text('legacy-private')
        self.assertEqual(run.finish('interrupted')['status'], 'cleanup-pending')
        self.assertEqual(env.read_text(), 'legacy-private')
        self.assertNotIn('containerResources', run.data)
        self.assertFalse((run.directory / 'container-resources.json').exists())

    def test_invalid_or_missing_ledgers_are_never_closed(self):
        for mode in ('missing', 'symlink', 'malformed', 'oversize', 'identity', 'forged-closed', 'dirty-unclaimed'):
            with self.subTest(mode=mode):
                run = self.store.create('container')
                self.runs.append(run)
                path = run.directory / container_resources.FILE
                value = json.loads(path.read_text())
                if mode == 'missing': path.unlink()
                elif mode == 'symlink':
                    other = self.repo / ('other-' + run.id)
                    other.write_text(path.read_text())
                    path.unlink(); path.symlink_to(other)
                elif mode == 'malformed': path.write_text('{')
                elif mode == 'oversize': path.write_text(' ' * (container_resources.LIMIT + 1))
                else:
                    if mode == 'identity': value['runId'] = 'different'
                    elif mode == 'forged-closed': value['state'] = 'closed'
                    else: value['producers'] = [1]
                    atomic_json(path, value)
                self.assertEqual(run.finish('passed')['status'], 'cleanup-pending')
                self.assertTrue(run.scratch.exists())
                self.assertFalse(container_resources.receipt(run.directory, run.id, self.repo, run.scratch)['dockerClosed'])

    def run_node_protocol(self, mode):
        source = Path(__file__).resolve().parents[1] / 'src/deploy'
        script = self.repo / 'owned-protocol.mjs'
        script.write_text("""
import fs from 'node:fs'
import path from 'node:path'
import { ContainerRunResources } from %s
import { createSettings } from %s
import { createInterruption, runTracked } from %s
const context = { directory: process.env.NERVE_TEST_RUN_DIR, runId: process.env.NERVE_TEST_RUN_ID,
  repo: process.cwd(), scratch: process.env.NERVE_TEST_SCRATCH }
const temp = fs.mkdtempSync(path.join(process.env.TMPDIR, 'env-'))
const settings = createSettings({ runId: context.runId, composeFile: path.join(context.repo, 'unused.yaml'),
  envFile: path.join(temp, 'test.env'), httpsPort: 1, databasePort: 2 })
fs.writeFileSync(settings.envFile, 'private-only', { mode: 0o600 })
let image = false
let resources
const capture = args => {
  let stdout = ''
  if (args[0] === 'info') stdout = 'protocol-daemon'
  else if (args[1] === 'ls' && args[0] === 'image' && image) stdout = settings.image
  else if (args[1] === 'inspect') stdout = JSON.stringify({id:'sha256:1234',name:settings.image,
    run:context.runId,repo:resources.repoHash,project:null})
  else if (args[1] === 'rm') image = false
  return {status:0,stdout,stderr:''}
}
resources = new ContainerRunResources(context, settings, capture)
resources.reserve()
resources.producerIntent()
if (process.argv[2] === 'killed') process.kill(process.pid, 'SIGKILL')
let pid
const result = await runTracked(createInterruption(), process.execPath, ['-e', 'process.exit(0)'], {
 cwd: context.repo, capture:true, onSpawn: value => {pid=value;resources.producerStarted(value)} })
resources.producerStopped(pid, result.quiescent)
image = true
if (!resources.cleanup() || image) throw new Error('not-closed')
process.exitCode = process.argv[2] === 'failed' ? 9 : 0
""" % tuple(json.dumps(str(source / name)) for name in ('container-e2e-resources.ts', 'container-e2e.ts', 'container-e2e-process.ts')))
        result = subprocess.run([sys.executable, '-B', str(Path(__file__).with_name('run.py')),
                                 '--repo', str(self.repo), 'container', '--', shutil.which('node'), str(script), mode],
                                cwd=self.repo, text=True, capture_output=True, timeout=30)
        manifests = list((self.store.root / 'runs').glob('*/run.json'))
        self.assertEqual(len(manifests), 1, result.stdout + result.stderr)
        value = json.loads(manifests[0].read_text())
        receipt = json.loads((self.repo / 'tests/e2e/test-results/container-resource-receipt.json').read_text())
        self.assertNotIn('private-only', json.dumps(receipt))
        self.assertLess(len(json.dumps(receipt)), 65536)
        return result, value, receipt, manifests[0].parent

    def test_python_parent_accepts_actual_node_closed_ledger_and_publishes_success(self):
        result, value, receipt, directory = self.run_node_protocol('passed')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(value['status'], 'passed')
        self.assertTrue(receipt['dockerClosed'])
        self.assertFalse((directory / 'scratch').exists())

    def test_product_failure_is_preserved_after_actual_node_cleanup(self):
        result, value, receipt, directory = self.run_node_protocol('failed')
        self.assertEqual(result.returncode, 9, result.stdout + result.stderr)
        self.assertEqual(value['status'], 'failed')
        self.assertTrue(receipt['dockerClosed'])
        self.assertFalse((directory / 'scratch').exists())

    def test_killed_node_exports_only_pending_diagnostic_and_retains_ledger_and_env(self):
        result, value, receipt, directory = self.run_node_protocol('killed')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(value['status'], 'cleanup-pending')
        self.assertTrue(value['containerDiagnosticOnly'])
        self.assertFalse(value['publicationComplete'])
        self.assertFalse(receipt['dockerClosed'])
        self.assertTrue(receipt['diagnosticOnly'])
        self.assertTrue(list((directory / 'scratch/tmp').glob('env-*/test.env')))
        self.assertEqual(json.loads((directory / 'container-resources.json').read_text())['producers'], [None])
        exported = self.repo / 'tests/e2e/test-results'
        self.assertEqual(sorted(p.name for p in exported.iterdir()),
                         ['cleanup-receipt.json', 'container-resource-ledger.json', 'container-resource-receipt.json', 'resource-run.json'])
        before = (directory / 'container-resources.json').read_bytes()
        self.store.sweep(); self.store.sweep()
        self.assertEqual((directory / 'container-resources.json').read_bytes(), before)


    def closed(self, run):
        value = container_resources.initial(run.id, self.repo, run.scratch)
        value.update(state='closed', daemon='test-daemon', repoHash=hashlib.sha256(str(self.repo).encode()).hexdigest(),
                     project='nerve-office-e2e-' + run.id, image='nerve-office:e2e-' + run.id,
                     temporaryDirectory=str(run.scratch / 'tmp/env'), producers=[],
                     observed={'containers': ['owned-app'], 'networks': [], 'volumes': [],
                               'images': ['nerve-office:e2e-' + run.id]},
                     observedImageIds={'nerve-office:e2e-' + run.id: 'sha256:1234'}, cleanupFailures=[],
                     closure={'daemon': 'test-daemon', 'observedAt': '2026-10-30T00:00:00.000Z',
                              'absent': {'containers': [], 'networks': [], 'volumes': [], 'images': []}})
        return value

    def test_duplicate_json_identity_and_closure_never_discard_environment(self):
        for mode in ('state', 'escaped-state', 'closure', 'identity', 'number'):
            with self.subTest(mode=mode):
                run = self.store.create('container')
                self.runs.append(run)
                path = run.directory / container_resources.FILE
                if mode == 'closure':
                    raw = json.dumps(self.closed(run)).replace('"closure": {"daemon": "test-daemon"',
                        '"closure": {"daemon":"other", "daemon":"test-daemon"')
                else:
                    raw = path.read_text()
                    if mode == 'identity': raw = raw.replace('"version": 1', '"version": 2, "version": 1')
                    elif mode == 'number': raw = raw.replace('"version": 1', '"version": true')
                    else: raw = raw.replace('"state": "unclaimed"', '"state":"reserved", "' +
                                           ('st\\u0061te' if mode == 'escaped-state' else 'state') + '":"unclaimed"')
                path.write_text(raw)
                (run.scratch / 'test.env').write_text('keep-private')
                self.assertEqual(run.finish('passed')['status'], 'cleanup-pending')
                self.assertEqual((run.scratch / 'test.env').read_text(), 'keep-private')
                self.assertEqual(path.read_text(), raw)
                self.assertFalse(container_resources.receipt(run.directory, run.id, self.repo, run.scratch)['dockerClosed'])

    def test_exported_full_ownership_survives_removal_of_source_run(self):
        result, value, receipt, directory = self.run_node_protocol('passed')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        exported = self.repo / 'tests/e2e/test-results'
        self.assertTrue((exported / 'container-resource-ledger.json').is_file())
        raw = (exported / 'container-resource-ledger.json').read_bytes()
        self.assertEqual(hashlib.sha256(raw).hexdigest(), receipt['ledgerSha256'])
        shutil.rmtree(directory)  # Only this test's own completed KiB run, no Docker objects.
        payload = container_resources.parse((exported / container_resources.PORTABLE).read_bytes())
        container_resources.validate(payload, value['runId'], self.repo, directory / 'scratch')
        self.assertEqual(receipt['observedCounts'], {k: len(v) for k, v in payload['observed'].items()})
        self.assertEqual(receipt['labels'], {'org.nerve-office.test.run': value['runId'],
                         'org.nerve-office.test.repo': hashlib.sha256(str(self.repo).encode()).hexdigest()})
        self.assertEqual(payload['runId'], value['runId'])
        self.assertEqual(payload['repo'], str(self.repo))
        self.assertEqual(payload['scratch'], str(directory / 'scratch'))
        self.assertEqual(payload['observedImageIds'], {'nerve-office:e2e-' + value['runId']: 'sha256:1234'})
        self.assertEqual(payload['producers'], [])
        self.assertEqual(payload['cleanupFailures'], [])
        self.assertEqual(payload['closure']['daemon'], payload['daemon'])
        self.assertNotIn('private-only', raw.decode())

    def test_receipt_never_signs_old_pending_snapshot_using_a_new_closed_read(self):
        run = self.store.create('container')
        self.runs.append(run)
        value = self.closed(run)
        value['state'] = 'pending'
        atomic_json(run.directory / container_resources.FILE, value)
        read = container_resources.read
        def replace_after_read(*args):
            snapshot = read(*args)
            atomic_json(run.directory / container_resources.FILE, self.closed(run))
            return snapshot
        with patch.object(container_resources, 'read', side_effect=replace_after_read):
            receipt = container_resources.receipt(run.directory, run.id, self.repo, run.scratch)
        self.assertFalse(receipt['dockerClosed'])
        self.assertTrue(receipt['diagnosticOnly'])


    def test_portable_reread_requires_complete_strict_identity_bound_payload(self):
        result, value, receipt, directory = self.run_node_protocol('passed')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        exported = self.repo / 'tests/e2e/test-results'
        path = exported / container_resources.PORTABLE
        raw = path.read_bytes()
        shutil.rmtree(directory)
        for mode in ('missing', 'identity', 'oversize', 'duplicate', 'extra'):
            with self.subTest(mode=mode):
                if mode == 'missing': path.unlink()
                elif mode == 'oversize': path.write_bytes(raw + b' ' * container_resources.LIMIT)
                elif mode == 'duplicate': path.write_bytes(raw.replace(b'"state": "closed"', b'"state":"pending", "state":"closed"'))
                else:
                    payload = json.loads(raw)
                    if mode == 'identity': payload['scratch'] = str(self.repo / 'foreign')
                    else: payload['Config.Env'] = ['private-value']
                    path.write_text(json.dumps(payload))
                with self.assertRaises((OSError, ValueError)):
                    payload = container_resources.parse(path.read_bytes())
                    container_resources.validate(payload, value['runId'], self.repo, directory / 'scratch')
                path.write_bytes(raw)
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), receipt['ledgerSha256'])

    def test_unknown_or_secret_fields_export_only_fixed_pending_diagnostic(self):
        run = self.store.create('container')
        self.runs.append(run)
        value = self.closed(run)
        value['Config.Env'] = ['unique-private-env']
        atomic_json(run.directory / container_resources.FILE, value)
        (run.scratch / 'test.env').write_text('unique-private-env')
        self.assertEqual(run.finish('passed', release=False)['status'], 'cleanup-pending')
        runner.publish_container_diagnostic(run)
        exported = self.repo / 'tests/e2e/test-results'
        self.assertFalse((exported / container_resources.PORTABLE).exists())
        receipt = json.loads((exported / container_resources.RECEIPT).read_text())
        self.assertFalse(receipt['dockerClosed'])
        self.assertTrue(receipt['diagnosticOnly'])
        self.assertFalse(run.data['publicationComplete'])
        self.assertTrue((run.scratch / 'test.env').exists())
        self.assertNotIn('unique-private-env', ''.join(p.read_text() for p in exported.iterdir()))

    def test_same_validated_snapshot_is_sealed_even_if_source_changes_after_read(self):
        run = self.store.create('container')
        self.runs.append(run)
        value = self.closed(run)
        value['state'] = 'pending'
        atomic_json(run.directory / container_resources.FILE, value)
        raw = (run.directory / container_resources.FILE).read_bytes()
        read = container_resources.read
        def replace_after_read(*args):
            snapshot = read(*args)
            atomic_json(run.directory / container_resources.FILE, self.closed(run))
            return snapshot
        destination = self.repo / 'detached-output'
        destination.mkdir()
        with patch.object(container_resources, 'read', side_effect=replace_after_read):
            receipt = container_resources.export(run.directory, destination, run.id, self.repo, run.scratch)
        self.assertEqual((destination / container_resources.PORTABLE).read_bytes(), raw)
        self.assertEqual(receipt['ledgerSha256'], hashlib.sha256(raw).hexdigest())
        self.assertFalse(receipt['dockerClosed'])
        self.assertTrue(receipt['diagnosticOnly'])

    def test_repeated_export_of_same_closed_bytes_is_idempotent(self):
        run = self.store.create('container')
        self.runs.append(run)
        atomic_json(run.directory / container_resources.FILE, self.closed(run))
        destination = self.repo / 'detached-output'
        destination.mkdir()
        first = container_resources.export(run.directory, destination, run.id, self.repo, run.scratch, require_closed=True)
        raw = (destination / container_resources.PORTABLE).read_bytes()
        second = container_resources.export(run.directory, destination, run.id, self.repo, run.scratch, require_closed=True)
        self.assertEqual(first, second)
        self.assertEqual((destination / container_resources.PORTABLE).read_bytes(), raw)


    def test_compact_pending_input_cannot_expand_beyond_receipt_byte_limit(self):
        run = self.store.create('container')
        self.runs.append(run)
        value = self.closed(run)
        value['state'] = 'pending'
        absent = value['closure']['absent']
        # Only safe, bounded identifiers; grow the compact valid record up to its
        # original 64 KiB input limit, without creating any Docker resources.
        raw = json.dumps(value, separators=(',', ':')).encode()
        for index in range(256):
            items = absent[container_resources.KINDS[index % 4]]
            items.append(f'{index:03d}-' + 'x' * 252)
            candidate = json.dumps(value, separators=(',', ':')).encode()
            if len(candidate) > container_resources.LIMIT:
                items.pop()
                break
            raw = candidate
        self.assertLessEqual(len(raw), container_resources.LIMIT)
        path = run.directory / container_resources.FILE
        path.write_bytes(raw)
        container_resources.read(run.directory, run.id, self.repo, run.scratch)
        expanded = (json.dumps(container_resources.receipt(run.directory, run.id, self.repo, run.scratch),
                               ensure_ascii=False, indent=2) + '\n').encode()
        self.assertGreater(len(expanded), container_resources.LIMIT)
        print(json.dumps({'compactInputBytes': len(raw), 'derivedReceiptBytesBeforeLimit': len(expanded)}))
        (run.scratch / 'test.env').write_text('keep-private')
        self.assertEqual(run.finish('passed', release=False)['status'], 'cleanup-pending')
        runner.publish_container_diagnostic(run)
        destination = self.repo / 'tests/e2e/test-results'
        exported = (destination / container_resources.RECEIPT).read_bytes()
        self.assertLessEqual(len(exported), container_resources.LIMIT)
        receipt = json.loads(exported)
        self.assertEqual(receipt['state'], 'pending')
        self.assertEqual(receipt['problem'], 'container-receipt-size-limit')
        print(json.dumps({'boundedReceiptBytes': len(exported)}))
        self.assertFalse(receipt['dockerClosed'])
        self.assertTrue(receipt['diagnosticOnly'])
        self.assertEqual(receipt['ledgerSha256'], hashlib.sha256(raw).hexdigest())
        self.assertEqual((destination / container_resources.PORTABLE).read_bytes(), raw)
        self.assertEqual(path.read_bytes(), raw)
        self.assertEqual((run.scratch / 'test.env').read_text(), 'keep-private')
        self.assertFalse(run.data['publicationComplete'])
        # The compact original and the bounded refusal can be exported again
        # byte-for-byte; the large closure must not be truncated into "closed".
        repeated = self.repo / 'same-diagnostic'
        repeated.mkdir()
        container_resources.export(run.directory, repeated, run.id, self.repo, run.scratch)
        container_resources.export(run.directory, repeated, run.id, self.repo, run.scratch)
        self.assertEqual((repeated / container_resources.RECEIPT).read_bytes(), exported)
        self.assertEqual((repeated / container_resources.PORTABLE).read_bytes(), raw)


if __name__ == '__main__':
    unittest.main()
