"""Exercise the real resource state machine with small files and controlled OS observations."""
import copy
from contextlib import ExitStack
import errno
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import lifecycle
import run as runner


UNKNOWN = b'p987654\nf3\ntsock\nnprotocol: UNIX-STREAM\n'
CLEAR = b'p987654\nfcwd\ntDIR\nn/unrelated\n'


class HostedLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ['TMPDIR'])
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name).resolve()
        self.assertTrue(hasattr(lifecycle, 'hosted'), 'lifecycle has no hosted policy integration')
        self.context = {'version': 1, 'policy': 'github-hosted-vm', 'repo': str(self.repo),
                        'repository': 'open-nerve/NerveOffice', 'sha': 'a' * 40,
                        'runId': '40600596503', 'attempt': '2', 'job': 'e2e',
                        'runner': 'GitHub Actions test',
                        'bootId': '66666666-7777-4888-8999-aaaaaaaaaaaa'}
        self.environment = patch.dict(os.environ, {'NERVE_TEST_LSOF_MODE': 'direct'})
        self.environment.start(); self.addCleanup(self.environment.stop)
        self.host = patch.object(lifecycle.hosted, 'context', side_effect=lambda _: copy.deepcopy(self.context))
        self.host.start(); self.addCleanup(self.host.stop)
        self.query = patch.object(lifecycle.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, UNKNOWN, b''))
        self.query.start(); self.addCleanup(self.query.stop)
        self.runs = []
        self.addCleanup(self.dispose)
        self.store = lifecycle.Store(self.repo)

    def dispose(self):
        for run in self.runs:
            run.release()
            short = run.data.get('shortRoot')
            if short:
                root = Path(short)
                if root.is_dir() and json.loads((root / 'owner.json').read_text())['runId'] == run.id:
                    shutil.rmtree(root)

    def create(self, kind='e2e'):
        value = self.store.create(kind)
        self.runs.append(value)
        value.create_short_tmp()
        results = value.scratch / 'tests/e2e/test-results'
        results.mkdir(parents=True)
        (results / 'results.json').write_text('{"suites":[],"errors":[],"stats":{}}')
        html = value.scratch / 'tests/e2e/playwright-report'
        html.mkdir(); (html / 'index.html').write_text('<html>test</html>')
        (value.scratch / 'raw.db').write_bytes(b'keep-raw')
        value.update(producerQuiescent=True, exitCode=0, interrupted=False)
        return value

    def test_accepted_legacy_hosted_container_remains_unchanged_without_adoption(self):
        value = self.create('e2e')  # Legacy registration has no container protocol.
        value.update(kind='container', exitCode=9, childGroup=2147483646)
        self.assertEqual(value.finish('failed', release=False)['cleanupStage'], 'host-disposal-pending')
        value.release()
        before = (value.directory / 'run.json').read_bytes()
        self.store.sweep()
        self.assertEqual((value.directory / 'run.json').read_bytes(), before)
        self.assertTrue(value.scratch.exists())
        self.assertFalse((value.directory / 'container-resources.json').exists())

    def test_new_container_protocol_cannot_bypass_pending_or_missing_ledger_via_hosted_fast_path(self):
        for mode in ('reserved', 'missing'):
            with self.subTest(mode=mode):
                value = self.create('container')
                value.update(exitCode=9)
                self.assertEqual(value.finish('failed', release=False)['cleanupStage'], 'host-disposal-pending')
                path = value.directory / 'container-resources.json'
                if mode == 'missing':
                    path.unlink()
                else:
                    ledger = json.loads(path.read_text())
                    ledger['state'] = 'reserved'
                    lifecycle.atomic_json(path, ledger)
                with self.assertRaises((ValueError, OSError)):
                    value.validate_hosted_completion()
                value.release()
                self.store.sweep()
                result = json.loads((value.directory / 'run.json').read_text())
                self.assertEqual(result['status'], 'cleanup-pending')
                self.assertTrue(value.scratch.exists())

    def test_pending_container_diagnostics_keep_existing_hosted_publication_identity_chain(self):
        value = self.create('container')
        value.update(exitCode=9)
        path = value.directory / 'container-resources.json'
        ledger = json.loads(path.read_text())
        ledger.update(state='reserved', producers=[None])
        lifecycle.atomic_json(path, ledger)
        self.assertEqual(value.finish('failed', release=False)['status'], 'cleanup-pending')
        runner.publish_container_diagnostic(value)
        target = self.repo / 'tests/e2e/test-results'
        self.assertIsNotNone(value.hosted_proof(target))
        self.assertEqual(sorted(p.name for p in target.iterdir()),
                         ['cleanup-receipt.json', 'container-resource-receipt.json', 'resource-run.json'])
        self.assertTrue(value.scratch.exists())
        self.assertFalse(value.data['publicationComplete'])
        with self.assertRaises(ValueError):
            value.validate_hosted_completion()

    def test_valid_pending_container_payload_is_sealed_without_hosted_completion(self):
        value = self.create('container')
        value.update(exitCode=9)
        path = value.directory / 'container-resources.json'
        ledger = json.loads(path.read_text())
        ledger.update(state='pending', daemon='fixture-daemon',
                      repoHash=hashlib.sha256(str(self.repo).encode()).hexdigest(),
                      project='nerve-office-e2e-' + value.id, image='nerve-office:e2e-' + value.id,
                      temporaryDirectory=str(value.scratch / 'tmp/env'), producers=[None],
                      observed={'containers': [], 'networks': [], 'volumes': [], 'images': []},
                      problem='container-producer-not-quiescent')
        lifecycle.atomic_json(path, ledger)
        original = path.read_bytes()
        self.assertEqual(value.finish('failed', release=False)['status'], 'cleanup-pending')
        runner.publish_container_diagnostic(value)
        target = self.repo / 'tests/e2e/test-results'
        self.assertIsNotNone(value.hosted_proof(target))
        self.assertEqual((target / 'container-resource-ledger.json').read_bytes(), original)
        receipt = json.loads((target / 'container-resource-receipt.json').read_text())
        self.assertEqual(receipt['ledgerSha256'], hashlib.sha256(original).hexdigest())
        self.assertFalse(receipt['dockerClosed'])
        self.assertTrue(receipt['diagnosticOnly'])
        self.assertFalse(value.data['publicationComplete'])
        self.assertTrue(value.scratch.exists())
        with self.assertRaises(ValueError):
            value.validate_hosted_completion()

    def command(self, script, *, kind='check', wait_for_output=False):
        """Run an actual child and pipe; only advance the output thread's schedule."""
        created = []
        children = []
        real_create = lifecycle.Store.create
        real_start = runner.threading.Thread.start
        real_popen = runner.subprocess.Popen
        def remember(store, kind):
            value = real_create(store, kind)
            self.runs.append(value)
            created.append(value)
            return value
        def remember_child(*args, **kwargs):
            child = real_popen(*args, **kwargs)
            children.append(child)
            return child
        def finish_output_before_poll(thread):
            real_start(thread)
            thread.join(timeout=5)
            self.assertFalse(thread.is_alive(), 'the tiny producer must finish its output')
            self.assertEqual(len(children), 1)
            children[0].wait(timeout=5)
        with ExitStack() as patches:
            patches.enter_context(patch.object(lifecycle.Store, 'create', remember))
            patches.enter_context(patch.object(sys, 'argv', [
                'run.py', '--repo', str(self.repo), kind, '--', sys.executable, '-c', script,
            ]))
            if wait_for_output:
                patches.enter_context(patch.object(runner.subprocess, 'Popen', remember_child))
                patches.enter_context(patch.object(runner.threading.Thread, 'start', finish_output_before_poll))
            code = runner.main()
        self.assertEqual(len(created), 1)
        value = created[0]
        return code, json.loads((value.directory / 'run.json').read_text()), value

    def test_scope_is_durable_before_scratch_creation(self):
        original = Path.mkdir
        seen = []
        def inspect(path, *args, **kwargs):
            if path.name == 'scratch':
                value = json.loads((path.parent / 'run.json').read_text())
                self.assertEqual(value['hostedScope']['context'], self.context)
                self.assertIsNone(value['serviceScope'])
                seen.append(value['runId'])
            return original(path, *args, **kwargs)
        with patch.object(Path, 'mkdir', inspect):
            value = self.create()
        self.assertEqual(seen, [value.id])

    def test_strict_default_still_rejects_unknown_global_reference(self):
        with patch.object(lifecycle.hosted, 'context', return_value=None):
            value = self.create()
            result = value.finish('passed', release=False)
        self.assertEqual(result['status'], 'cleanup-pending')
        self.assertTrue(value.scratch.exists())

    def test_hosted_pass_exports_without_deleting_or_claiming_raw_cleanup(self):
        value = self.create()
        result = value.finish('passed', release=False)
        self.assertEqual(result['status'], 'passed', result.get('cleanupError'))
        self.assertEqual(result['cleanupStage'], 'host-disposal-pending')
        self.assertIs(result['cleanupComplete'], False)
        self.assertTrue(result['stableExport']['complete'])
        self.assertEqual((value.scratch / 'raw.db').read_bytes(), b'keep-raw')
        self.assertTrue(Path(result['shortRoot']).exists())
        self.assertTrue((value.directory / 'reports/portable/test-results/results.json').is_file())
        self.assertGreater(result['referenceObservation']['incompleteRecordCount'], 0)
        self.assertEqual(result.get('compactedProfiles', 0), 0)

    def test_failed_and_interrupted_results_are_not_converted_to_passed(self):
        for status, code in [('failed', 7), ('interrupted', 143)]:
            value = self.create('check')
            value.update(exitCode=code, interrupted=status == 'interrupted')
            result = value.finish(status, release=False)
            self.assertEqual(result['status'], status, result.get('cleanupError'))
            self.assertEqual(result['exitCode'], code)
            self.assertEqual(result['cleanupStage'], 'host-disposal-pending')

    def test_known_file_and_short_alias_references_block_export(self):
        value = self.create()
        for name in [str(value.scratch / 'raw.db'), str(Path(value.data['shortRoot']) / 't/socket')]:
            result = subprocess.CompletedProcess([], 0, UNKNOWN + ('p987655\nf4\ntREG\nn' + name + '\n').encode(), b'')
            with patch.object(lifecycle.subprocess, 'run', return_value=result):
                with self.assertRaises(RuntimeError):
                    value.assert_exportable()
        self.assertFalse((value.directory / 'reports').exists())

    def test_annotated_owned_root_is_still_a_known_reference(self):
        value = self.create()
        for suffix in (' (stat: Permission denied)', ' (deleted) (stat: Permission denied)'):
            with self.subTest(suffix=suffix):
                output = UNKNOWN + ('p987655\nf4\ntDIR\nn' + str(value.scratch) + suffix + '\n').encode()
                result = subprocess.CompletedProcess([], 0, output, b'')
                with patch.object(lifecycle.subprocess, 'run', return_value=result):
                    with self.assertRaises(RuntimeError):
                        value.assert_exportable()
        self.assertFalse((value.directory / 'reports').exists())

    def test_external_symlink_loop_is_unknown_only_for_owned_hosted_export(self):
        value = self.create()
        loop = self.repo / 'foreign-private-loop'
        loop.symlink_to(loop.name)
        output = ('p987655\nf4\ntREG\nn' + str(loop / 'file') + '\n').encode()
        result = subprocess.CompletedProcess([], 0, output, b'')
        with patch.object(lifecycle.subprocess, 'run', return_value=result):
            finished = value.finish('passed', release=False)
        self.assertEqual(finished['status'], 'passed', finished.get('cleanupError'))
        self.assertEqual(finished['cleanupStage'], 'host-disposal-pending')
        self.assertIs(finished['cleanupComplete'], False)
        self.assertEqual((value.scratch / 'raw.db').read_bytes(), b'keep-raw')
        observation = finished['referenceObservation']
        self.assertEqual(observation['incompleteRecordCount'], 1)
        self.assertIs(observation['absenceProven'], False)
        self.assertIs(observation['rawDeletionAuthorized'], False)
        sample = observation['incompleteRecords'][0]
        self.assertEqual(sample['reason'], 'alias-resolution-error')
        self.assertEqual(sample['operation'], 'resolve')
        self.assertIn(sample['exceptionType'], ('RuntimeError', 'OSError'))
        self.assertNotIn(str(loop), json.dumps(observation))
        self.assertEqual(sample['nameSha256'], hashlib.sha256(os.fsencode(loop / 'file')).hexdigest())

    def test_external_symlink_loop_stays_strict_without_export_authority(self):
        value = self.create()
        loop = self.repo / 'foreign-loop'
        loop.symlink_to(loop.name)
        result = subprocess.CompletedProcess([], 0, ('p987655\nf4\ntREG\nn' + str(loop) + '\n').encode(), b'')
        with patch.object(lifecycle.subprocess, 'run', return_value=result):
            with self.assertRaises(RuntimeError):
                lifecycle.open_paths(value.scratch, owner=value)
            with self.assertRaises(RuntimeError):
                lifecycle.open_paths(value.scratch, export_only=True)
            value.update(hostedScope=None)
            with self.assertRaises(RuntimeError):
                lifecycle.open_paths(value.scratch, owner=value, export_only=True)
        self.assertTrue(value.scratch.exists())

    def test_unknown_alias_does_not_hide_later_known_owned_reference(self):
        value = self.create()
        loop = self.repo / 'foreign-loop'
        loop.symlink_to(loop.name)
        known = str(value.scratch / 'raw.db')
        output = ('p987655\nf4\ntREG\nn' + str(loop) + '\nf5\ntREG\nn' + known + '\n').encode()
        with patch.object(lifecycle.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, output, b'')):
            self.assertEqual(lifecycle.open_paths(value.scratch, owner=value, export_only=True), [known])
            with self.assertRaisesRegex(RuntimeError, '已知'):
                value.assert_exportable()

    def test_resolvable_alias_prefix_into_owned_root_blocks_after_leaf_failure(self):
        value = self.create()
        nested = value.scratch / 'nested'
        nested.mkdir()
        (nested / 'loop').symlink_to('loop')
        alias = self.repo / 'outside-alias'
        alias.symlink_to(nested, target_is_directory=True)
        known = str(alias / 'loop' / 'leaf')
        output = ('p987655\nf4\ntREG\nn' + known + '\n').encode()
        with patch.object(lifecycle.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, output, b'')):
            self.assertEqual(lifecycle.open_paths(value.scratch, owner=value, export_only=True), [known])
            with self.assertRaisesRegex(RuntimeError, '已知'):
                value.assert_exportable()

    def test_annotated_root_matches_before_an_unreadable_candidate_is_resolved(self):
        value = self.create()
        real_resolve = Path.resolve
        for suffix in (' (stat: Permission denied)', ' (deleted) (stat: Permission denied)'):
            name = str(value.scratch) + suffix
            def denied(path, *args, **kwargs):
                if str(path) == name:
                    raise PermissionError(errno.EACCES, 'private filename must not leak', str(path))
                return real_resolve(path, *args, **kwargs)
            output = ('p987655\nf4\ntDIR\nn' + name + '\n').encode()
            with self.subTest(suffix=suffix), patch.object(Path, 'resolve', denied), patch.object(
                    lifecycle.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, output, b'')):
                self.assertEqual(lifecycle.open_paths(value.scratch, owner=value, export_only=True), [name])

    def test_permission_unknown_diagnostics_are_counted_bounded_and_redacted(self):
        value = self.create()
        names = [str(self.repo / ('PRIVATE-' + str(index))) for index in range(20)]
        output = ('p987655\n' + ''.join('f' + str(index + 4) + '\ntREG\nn' + name + '\n'
                                     for index, name in enumerate(names))).encode()
        real_resolve = Path.resolve
        def denied(path, *args, **kwargs):
            if str(path) in names:
                raise PermissionError(errno.EACCES, 'PRIVATE-MESSAGE', str(path))
            return real_resolve(path, *args, **kwargs)
        with patch.object(Path, 'resolve', denied), patch.object(
                lifecycle.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, output, b'')):
            self.assertEqual(lifecycle.open_paths(value.scratch, owner=value, export_only=True), [])
        observation = value.data['referenceObservation']
        self.assertEqual(observation['incompleteRecordCount'], 20)
        self.assertEqual(len(observation['incompleteRecords']), 16)
        self.assertIs(observation['incompleteRecordsTruncated'], True)
        self.assertNotIn('PRIVATE', json.dumps(observation))
        for sample in observation['incompleteRecords']:
            self.assertEqual(sample['errno'], errno.EACCES)
            self.assertEqual(sample['exceptionType'], 'PermissionError')
            self.assertEqual(sample['name'], '<absolute-path>')
            self.assertTrue(sample['nameRedacted'])

    def test_value_error_and_owned_root_resolution_failures_remain_fatal(self):
        value = self.create()
        candidate = self.repo / 'foreign-invalid'
        output = ('p987655\nf4\ntREG\nn' + str(candidate) + '\n').encode()
        real_resolve = Path.resolve
        for failed_path, failure in ((candidate, ValueError('invalid input')),
                                     (value.scratch, PermissionError(errno.EACCES, 'owned root unavailable'))):
            def fail(path, *args, **kwargs):
                if path == failed_path:
                    raise failure
                return real_resolve(path, *args, **kwargs)
            with self.subTest(path=failed_path), patch.object(Path, 'resolve', fail), patch.object(
                    lifecycle.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, output, b'')):
                with self.assertRaises((RuntimeError, ValueError, OSError)):
                    lifecycle.open_paths(value.scratch, owner=value, export_only=True)
        self.assertTrue(value.scratch.exists())

    def test_alias_diagnostic_uses_the_complete_record_when_name_precedes_type(self):
        value = self.create()
        loop = self.repo / 'foreign-loop'
        loop.symlink_to(loop.name)
        output = ('p987655\nf4\nn' + str(loop) + '\ntREG\n').encode()
        with patch.object(lifecycle.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, output, b'')):
            self.assertEqual(lifecycle.open_paths(value.scratch, owner=value, export_only=True), [])
        sample = value.data['referenceObservation']['incompleteRecords'][0]
        self.assertEqual((sample['pid'], sample['fd'], sample['type']), (987655, '4', 'REG'))

    def test_alias_diagnostics_preserve_existing_and_repeated_record_counts(self):
        value = self.create()
        loop = self.repo / 'foreign-loop'
        loop.symlink_to(loop.name)
        record = ('p987655\nf4\ntREG\nn' + str(loop) + '\n').encode()
        with patch.object(lifecycle.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, UNKNOWN * 2 + record * 3, b'')):
            self.assertEqual(lifecycle.open_paths(value.scratch, owner=value, export_only=True), [])
        observation = value.data['referenceObservation']
        self.assertEqual(observation['incompleteRecordCount'], 5)
        self.assertEqual(len(observation['incompleteRecords']), 2)
        self.assertEqual([sample['multiplicity'] for sample in observation['incompleteRecords']], [2, 3])
        self.assertIs(observation['incompleteRecordsTruncated'], False)

    def test_nofd_alias_diagnostic_preserves_a_missing_type(self):
        value = self.create()
        loop = self.repo / 'foreign-loop'
        loop.symlink_to(loop.name)
        output = ('p987655\nfNOFD\nn' + str(loop) + '\n').encode()
        with patch.object(lifecycle.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, output, b'')):
            self.assertEqual(lifecycle.open_paths(value.scratch, owner=value, export_only=True), [])
        observation = value.data['referenceObservation']
        self.assertEqual(observation['incompleteRecordCount'], 2)
        sample = next(row for row in observation['incompleteRecords'] if row['reason'] == 'alias-resolution-error')
        self.assertEqual((sample['pid'], sample['fd']), (987655, 'NOFD'))
        self.assertIsNone(sample['type'])
        self.assertIsNone(sample['typeBytes'])

    def test_structural_errors_and_query_failures_are_not_semantic_unknowns(self):
        value = self.create()
        for result in [subprocess.CompletedProcess([], 0, b'p987654\nf3\nn/x\n', b''),
                       subprocess.CompletedProcess([], 2, CLEAR, b''),
                       subprocess.CompletedProcess([], 0, CLEAR, b'warning')]:
            with patch.object(lifecycle.subprocess, 'run', return_value=result):
                with self.assertRaises(RuntimeError):
                    value.assert_exportable()

    def test_active_producer_or_missing_exit_receipt_blocks_finish(self):
        value = self.create()
        with patch.object(lifecycle, 'group_alive', return_value=True):
            self.assertEqual(value.finish('passed', release=False)['status'], 'cleanup-pending')
        value.update(producerQuiescent=False)
        self.assertEqual(value.finish('passed', release=False)['status'], 'cleanup-pending')

    def test_foreign_context_and_replaced_root_never_gain_export_authority(self):
        value = self.create()
        self.context['attempt'] = '3'
        with self.assertRaises(ValueError):
            value.assert_exportable()
        self.context['attempt'] = '2'
        value.scratch.rename(value.directory / 'old-scratch')
        value.scratch.mkdir()
        with self.assertRaises(ValueError):
            value.assert_exportable()

    def test_scope_cannot_be_added_to_an_existing_legacy_run(self):
        value = self.create()
        value.update(hostedScope=None)
        with self.assertRaises(ValueError):
            value.assert_exportable()

    def test_sweep_and_prune_preserve_completed_delegation_and_count_its_bytes(self):
        value = self.create()
        self.assertEqual(value.finish('passed')['status'], 'passed')
        before = json.loads((value.directory / 'run.json').read_text())
        report = self.store.sweep(now=before['startedAt'] + 100 * 86400)
        after = json.loads((value.directory / 'run.json').read_text())
        self.assertEqual(after['status'], 'passed')
        self.assertNotIn(value.id, report['recovered'])
        self.assertTrue(value.scratch.exists())
        self.assertGreater(self.store.hosted_budget()['bytes'], 8)
        self.assertEqual(self.store.prune(before['startedAt'] + 100 * 86400), [])

    def test_publish_and_rotate_use_export_copy_and_reject_tampering(self):
        value = self.create()
        self.assertEqual(value.finish('passed', release=False)['status'], 'passed')
        runner.publish(value, 'e2e')
        source = value.scratch / 'tests/e2e/test-results/results.json'
        published = self.repo / 'tests/e2e/test-results/results.json'
        self.assertTrue(source.exists()); self.assertTrue(published.exists())
        value.verify_export()
        published.write_text('{}')
        with self.assertRaises(ValueError):
            runner.rotate_reports(self.store, 'e2e', current_run=value)

    def test_recover_completed_export_before_publication_preserves_original_success(self):
        state = self.repo / 'ci-state'
        state.mkdir()
        token = '1f641a87-e0b4-4502-98f0-8cb92f50bd18'
        (state / 'owner.json').write_text(json.dumps({'root': str(self.repo), 'token': token}))
        (state / 'quiescence.json').write_text(json.dumps({'quiescent': True}))
        value = self.create()
        value.update(ciOwner=token, ciState=str(state))
        self.assertEqual(value.finish('passed')['status'], 'passed')
        before = json.loads((value.directory / 'run.json').read_text())
        self.assertNotIn('publicationReports', before)
        self.assertEqual(runner.recover_ci(self.store, state), 0)
        after = json.loads((value.directory / 'run.json').read_text())
        self.assertEqual(after['status'], 'passed')
        self.assertEqual(after['exitCode'], 0)
        self.assertEqual(after['stableExport'], before['stableExport'])
        self.assertTrue(after['publicationComplete'])
        self.assertTrue((self.repo / 'tests/e2e/test-results/results.json').is_file())
        self.assertEqual((value.scratch / 'raw.db').read_bytes(), b'keep-raw')

    def test_export_failure_remains_failed_and_keeps_original_environment(self):
        value = self.create()
        report = value.scratch / 'tests/e2e/test-results/bad.sqlite'
        report.write_bytes(b'raw database')
        result = value.finish('passed', release=False)
        self.assertEqual(result['status'], 'cleanup-pending')
        self.assertTrue(report.exists())

    def test_real_successful_producer_records_success_and_preserves_source(self):
        code, result, value = self.command("print('small successful producer')")
        self.assertEqual(code, 0)
        self.assertEqual(result['status'], 'passed')
        self.assertEqual(result['exitCode'], 0)
        self.assertEqual(result['commandExitCode'], 0)
        self.assertIs(result['interrupted'], False)
        self.assertIs(result['producerQuiescent'], True)
        self.assertEqual(result['cleanupStage'], 'host-disposal-pending')
        self.assertIs(result['cleanupComplete'], False)
        self.assertEqual((value.directory / 'command.log').read_text(), 'small successful producer\n')
        self.assertTrue(value.scratch.is_dir())

    def test_real_unsuccessful_producer_keeps_its_exit_code(self):
        code, result, value = self.command("import sys; print('expected child failure'); sys.exit(7)")
        self.assertEqual(code, 7)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['exitCode'], 7)
        self.assertEqual(result['commandExitCode'], 7)
        self.assertIs(result['interrupted'], False)
        self.assertIs(result['producerQuiescent'], True)
        self.assertEqual(result['cleanupStage'], 'host-disposal-pending')
        self.assertTrue(value.scratch.is_dir())

    def test_hosted_integration_child_gets_its_own_coverage_path_over_inherited_value(self):
        self.context['job'] = 'verify'
        wrong = self.repo / 'another-run-coverage'
        with patch.dict(os.environ, {'NERVE_TEST_COVERAGE_DIR': str(wrong)}):
            code, unused, value = self.command(
                "import json, os; print(json.dumps({'coverage': os.environ.get('NERVE_TEST_COVERAGE_DIR'), "
                "'output': os.environ['NERVE_TEST_OUTPUT_DIR']}))", kind='integration')
        self.assertEqual(code, 0)
        observed = json.loads((value.directory / 'command.log').read_text())
        expected = value.scratch / 'tests/e2e/test-results/coverage'
        self.assertEqual(observed['coverage'], str(expected))
        self.assertEqual(observed['coverage'], str(Path(observed['output']) / 'coverage'))
        self.assertFalse(wrong.exists())

    def test_other_child_does_not_inherit_a_previous_coverage_destination(self):
        with patch.dict(os.environ, {'NERVE_TEST_COVERAGE_DIR': str(self.repo / 'another-run-coverage')}):
            code, unused, value = self.command(
                "import json, os; print(json.dumps({'inherited': 'NERVE_TEST_COVERAGE_DIR' in os.environ}))")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads((value.directory / 'command.log').read_text()), {'inherited': False})

    def test_real_catchable_interrupt_stops_its_owned_producer_and_stays_interrupted(self):
        # The child is only released after main installed its handlers and recorded
        # this process group. SIGTERM targets this test's invocation, not its runner.
        code, result, value = self.command(
            "import os, signal, time; os.kill(os.getppid(), signal.SIGTERM); time.sleep(30)")
        self.assertEqual(code, 143)
        self.assertEqual(result['status'], 'interrupted')
        self.assertEqual(result['exitCode'], 143)
        self.assertIs(result['interrupted'], True)
        self.assertIs(result['producerQuiescent'], True)
        self.assertEqual(result['cleanupStage'], 'host-disposal-pending')
        self.assertFalse(lifecycle.group_alive(result['childGroup']))
        self.assertTrue(value.scratch.is_dir())

    def test_final_output_chunk_over_log_cap_cannot_be_a_successful_run(self):
        # The genuine child/pipe finish before the next supervisor poll. This is
        # the scheduling window missed by checks only inside the live-child loop.
        with patch.object(runner, 'MAX_LOG', 4):
            code, result, value = self.command("print('12345678')", wait_for_output=True)
        self.assertNotEqual(code, 0)
        self.assertNotEqual(result['status'], 'passed')
        self.assertNotEqual(result.get('exitCode'), 0)
        self.assertTrue(value.scratch.is_dir())

    def test_output_thread_write_error_cannot_be_a_successful_run(self):
        real_open = Path.open
        failed_paths = []
        def readonly_log(path, mode='r', *args, **kwargs):
            if path.name == 'command.log' and mode == 'wb':
                # The source remains a real regular file, so later export cannot
                # mask the missing thread-error handling by rejecting its type.
                with real_open(path, 'wb'):
                    pass
                failed_paths.append(path)
                return real_open(path, 'rb')
            return real_open(path, mode, *args, **kwargs)
        with patch.object(Path, 'open', readonly_log):
            code, result, value = self.command("print('output must be recorded')", wait_for_output=True)
        self.assertEqual(failed_paths, [value.directory / 'command.log'])
        self.assertTrue(failed_paths[0].is_file())
        self.assertNotEqual(code, 0)
        self.assertNotEqual(result['status'], 'passed')
        self.assertNotEqual(result.get('exitCode'), 0)
        self.assertTrue(value.scratch.is_dir())

    def test_publication_metadata_cannot_exceed_the_report_budget(self):
        value = self.create()
        self.assertEqual(value.finish('passed', release=False)['status'], 'passed')
        report_bytes = self.store.hosted_budget()['reportBytes']
        self.assertLess(report_bytes, 64 * 1024, 'capacity validation must remain a KiB fixture')
        self.store.report_bytes = report_bytes + 128
        with self.assertRaises((ValueError, RuntimeError)):
            runner.publish(value, 'e2e')
        self.assertEqual((value.scratch / 'raw.db').read_bytes(), b'keep-raw')

    def checker(self):
        spec = importlib.util.find_spec('check_ci_resources')
        self.assertIsNotNone(spec, 'CI resource acceptance checker is missing')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def ci_runs(self, status='passed'):
        preflight = self.create('ci-preflight')
        self.assertEqual(preflight.finish('passed')['status'], 'passed')
        value = self.create()
        if status != 'passed':
            value.update(exitCode=3, interrupted=status == 'interrupted')
        self.assertEqual(value.finish(status, release=False)['status'], status)
        runner.publish(value, 'e2e'); value.release()
        return value

    def coverage_summary(self):
        return json.dumps({'total': {
            metric: {'total': 1, 'covered': 1, 'skipped': 0, 'pct': 100}
            for metric in ('lines', 'statements', 'functions', 'branches')
        }})

    def ci_integration_runs(self, summary=None, html='<html>coverage report</html>'):
        self.context['job'] = 'verify'
        preflight = self.create('ci-preflight')
        self.assertEqual(preflight.finish('passed')['status'], 'passed')
        value = self.create('integration')
        results = value.scratch / 'tests/e2e/test-results'
        (results / 'results.json').unlink()
        playwright = value.scratch / 'tests/e2e/playwright-report'
        (playwright / 'index.html').unlink()
        playwright.rmdir()
        if summary is not None:
            coverage = results / 'coverage'
            coverage.mkdir()
            (coverage / 'coverage-summary.json').write_text(summary)
            if html is not None:
                (coverage / 'index.html').write_text(html)
        self.assertEqual(value.finish('passed')['status'], 'passed')
        return value

    def ci_container_runs(self, *, status='passed',
                          result='{"suites":[],"errors":[],"stats":{"expected":1,"unexpected":0,"flaky":0,"skipped":0}}',
                          html='<html>container report</html>'):
        self.context['job'] = 'container'
        preflight = self.create('ci-preflight')
        self.assertEqual(preflight.finish('passed')['status'], 'passed')
        value = self.create('container')
        results = value.scratch / 'tests/e2e/test-results'
        if result is None:
            (results / 'results.json').unlink()
        else:
            (results / 'results.json').write_text(result)
        playwright = value.scratch / 'tests/e2e/playwright-report'
        if html is None:
            (playwright / 'index.html').unlink()
            playwright.rmdir()
        else:
            (playwright / 'index.html').write_text(html)
        diagnostics = results / 'container'
        diagnostics.mkdir()
        (diagnostics / 'build.log').write_text('bounded container build diagnostic\n')
        if status != 'passed':
            value.update(exitCode=7, interrupted=False)
        self.assertEqual(value.finish(status, release=False)['status'], status)
        runner.publish(value, 'container')
        value.release()
        return value

    def test_ci_checker_attaches_same_job_resource_contract_without_changing_failed_product(self):
        checker = self.checker()
        value = self.ci_runs('failed')
        report = checker.check(self.repo)
        self.assertTrue(report['reportsVerified'])
        self.assertEqual(report['runId'], value.id)
        self.assertEqual(report['status'], 'failed')
        self.assertIs(report['cleanupComplete'], False)
        receipt = json.loads((self.repo / 'tests/e2e/test-results/cleanup-receipt.json').read_text())
        self.assertEqual(receipt['ciResources']['context'], self.context)
        self.assertEqual(len(receipt['ciResources']['runs']), 2)
        self.assertTrue(value.scratch.exists())

    def test_ci_checker_accepts_the_complete_unpacked_baseline(self):
        value = self.ci_runs()
        ledger = json.loads((value.directory / 'run.json').read_text())
        self.assertNotIn('packagedProfiles', ledger)
        self.assertTrue(ledger['publicationComplete'])
        self.assertTrue(ledger['stableExport']['complete'])
        result = self.checker().check(self.repo)
        self.assertEqual(result['runId'], value.id)
        self.assertEqual(result['status'], 'passed')
        self.assertTrue(result['reportsVerified'])
        receipt = json.loads((self.repo / 'tests/e2e/test-results/cleanup-receipt.json').read_text())
        self.assertTrue(all('packagedProfiles' not in row for row in receipt['ciResources']['runs']))

    def test_ci_checker_rejects_prepared_profile_transport(self):
        value = self.ci_runs()
        owner = lifecycle.Run(self.store, value.directory, existing=True)
        try:
            owner.update(packagedProfiles={
                'version': 1, 'runId': value.id, 'stage': 'prepared',
                'stableManifestSha256': owner.data['stableExport']['sha256'],
            })
        finally:
            owner.release()
        with self.assertRaises((ValueError, RuntimeError, OSError)):
            self.checker().check(self.repo)
        self.assertTrue(value.scratch.exists())

    def test_ci_checker_rejects_complete_marker_without_actual_transport(self):
        value = self.ci_runs()
        owner = lifecycle.Run(self.store, value.directory, existing=True)
        try:
            owner.update(packagedProfiles={
                'version': 1, 'runId': value.id, 'stage': 'complete',
                'stableManifestSha256': owner.data['stableExport']['sha256'],
                'archive': 'test-results/persistent-profiles.tar.zst',
                'sha256': '0' * 64, 'bytes': 128,
            })
        finally:
            owner.release()
        self.assertFalse((self.repo / 'tests/e2e/test-results/persistent-profiles.tar.zst').exists())
        with self.assertRaises((ValueError, RuntimeError, OSError)):
            self.checker().check(self.repo)
        self.assertTrue(value.scratch.exists())

    def test_ci_checker_rejects_tampered_bytes_and_wrong_current_host(self):
        checker = self.checker()
        value = self.ci_runs()
        self.context['attempt'] = '3'
        with self.assertRaises(ValueError):
            checker.check(self.repo)
        self.context['attempt'] = '2'
        (self.repo / 'tests/e2e/test-results/results.json').write_text('tampered')
        with self.assertRaises(ValueError):
            checker.check(self.repo)
        self.assertTrue(value.scratch.exists())

    def test_ci_checker_requires_the_persisted_stable_export_receipt(self):
        value = self.ci_runs()
        owner = lifecycle.Run(self.store, value.directory, existing=True)
        try:
            del owner.data['stableExport']
            owner.persist()
        finally:
            owner.release()
        with self.assertRaises(ValueError):
            self.checker().check(self.repo)
        self.assertTrue((self.repo / 'tests/e2e/test-results/stable-export.json').is_file())
        self.assertTrue(value.scratch.exists())

    def test_ci_checker_rejects_resigned_report_against_the_persisted_receipt(self):
        value = self.ci_runs()
        ledger = json.loads((value.directory / 'run.json').read_text())
        original_receipt = copy.deepcopy(ledger['stableExport'])
        results = self.repo / 'tests/e2e/test-results'
        payload = b'{"suites":[],"errors":[],"stats":{"expected":999}}'
        (results / 'results.json').write_bytes(payload)
        manifest_path = results / 'stable-export.json'
        manifest = json.loads(manifest_path.read_text())
        matches = [entry for entry in manifest['entries'] if entry['path'] == 'test-results/results.json']
        self.assertEqual(len(matches), 1)
        matches[0].update(bytes=len(payload), sha256=hashlib.sha256(payload).hexdigest())
        manifest_path.write_text(json.dumps(manifest))
        with self.assertRaises(ValueError):
            self.checker().check(self.repo)
        self.assertEqual(json.loads((value.directory / 'run.json').read_text())['stableExport'], original_receipt)
        self.assertTrue(value.scratch.exists())

    def test_verify_checker_accepts_only_registered_coverage_and_delivers_its_contract(self):
        value = self.ci_integration_runs(self.coverage_summary())
        results = value.directory / 'reports/portable/test-results'
        manifest = json.loads((results / 'stable-export.json').read_text())
        registered = {entry['path'] for entry in manifest['entries']}
        self.assertTrue({'test-results/coverage/coverage-summary.json',
                         'test-results/coverage/index.html'} <= registered)
        report = self.checker().check(self.repo)
        self.assertTrue(report['reportsVerified'])
        self.assertEqual(report['runId'], value.id)
        self.assertEqual(report['status'], 'passed')
        receipt = json.loads((results / 'cleanup-receipt.json').read_text())
        self.assertEqual(receipt['ciResources']['context']['job'], 'verify')
        self.assertEqual(receipt['runId'], value.id)

    def test_verify_checker_rejects_missing_coverage(self):
        value = self.ci_integration_runs()
        with self.assertRaises(ValueError):
            self.checker().check(self.repo)
        self.assertTrue(value.scratch.exists())

    def test_verify_checker_rejects_invalid_coverage_summary_json(self):
        self.ci_integration_runs('{invalid json')
        with self.assertRaises(ValueError):
            self.checker().check(self.repo)

    def test_verify_checker_rejects_empty_coverage_total(self):
        self.ci_integration_runs('{"total": {}}')
        with self.assertRaises(ValueError):
            self.checker().check(self.repo)

    def test_verify_checker_rejects_missing_coverage_html(self):
        self.ci_integration_runs(self.coverage_summary(), html=None)
        with self.assertRaises(ValueError):
            self.checker().check(self.repo)

    def test_verify_checker_rejects_empty_coverage_html(self):
        self.ci_integration_runs(self.coverage_summary(), html='')
        with self.assertRaises(ValueError):
            self.checker().check(self.repo)

    def test_verify_checker_rejects_coverage_not_in_the_stable_export(self):
        value = self.ci_integration_runs()
        coverage = value.directory / 'reports/portable/test-results/coverage'
        coverage.mkdir()
        (coverage / 'coverage-summary.json').write_text(self.coverage_summary())
        (coverage / 'index.html').write_text('<html>unregistered report</html>')
        with self.assertRaises(ValueError):
            self.checker().check(self.repo)

    def test_container_checker_accepts_complete_successful_reports(self):
        value = self.ci_container_runs()
        report = self.checker().check(self.repo)
        self.assertEqual(report['runId'], value.id)
        self.assertEqual(report['status'], 'passed')
        self.assertTrue(report['reportsVerified'])
        self.assertFalse(report['cleanupComplete'])
        receipt = json.loads((self.repo / 'tests/e2e/test-results/cleanup-receipt.json').read_text())
        self.assertEqual(receipt['exitCode'], 0)
        self.assertEqual(receipt['ciResources']['context']['job'], 'container')

    def test_container_checker_rejects_success_without_results_json(self):
        value = self.ci_container_runs(result=None)
        # The absent result is already reflected in a valid stable inventory;
        # this must fail report completeness rather than post-export tampering.
        with self.assertRaises((ValueError, OSError)):
            self.checker().check(self.repo)
        self.assertTrue(value.scratch.exists())

    def test_container_checker_rejects_success_with_malformed_results_json(self):
        self.ci_container_runs(result='{incomplete json')
        with self.assertRaises(ValueError):
            self.checker().check(self.repo)

    def test_container_checker_rejects_success_with_incomplete_result_schema(self):
        self.ci_container_runs(result='{"suites":[],"errors":[],"stats":{}}')
        with self.assertRaises(ValueError):
            self.checker().check(self.repo)

    def test_container_checker_rejects_success_without_html_report(self):
        self.ci_container_runs(html=None)
        with self.assertRaises((ValueError, OSError)):
            self.checker().check(self.repo)

    def test_container_checker_rejects_success_with_empty_html_report(self):
        self.ci_container_runs(html='')
        with self.assertRaises(ValueError):
            self.checker().check(self.repo)

    def test_container_checker_accepts_failed_build_diagnostics_without_playwright_reports(self):
        # A build failure occurs before Playwright starts. Its safe diagnostic
        # export must remain uploadable without inventing JSON or HTML results.
        value = self.ci_container_runs(status='failed', result=None, html=None)
        results = self.repo / 'tests/e2e/test-results'
        self.assertFalse((results / 'results.json').exists())
        self.assertFalse((self.repo / 'tests/e2e/playwright-report').exists())
        report = self.checker().check(self.repo)
        self.assertEqual(report['runId'], value.id)
        self.assertEqual(report['status'], 'failed')
        self.assertTrue(report['reportsVerified'])
        self.assertFalse(report['cleanupComplete'])
        receipt = json.loads((results / 'cleanup-receipt.json').read_text())
        self.assertEqual((receipt['status'], receipt['exitCode']), ('failed', 7))
        self.assertEqual((results / 'container/build.log').read_text(),
                         'bounded container build diagnostic\n')
        self.assertTrue(value.scratch.exists())

    def test_ci_checker_requires_one_expected_main_run_and_preflight(self):
        checker = self.checker()
        with self.assertRaises(ValueError):
            checker.check(self.repo)
        preflight = self.create('ci-preflight')
        preflight.finish('passed')
        with self.assertRaises(ValueError):
            checker.check(self.repo)

    def test_ci_checker_rejects_active_lease_and_inconsistent_producer_receipt(self):
        checker = self.checker()
        value = self.ci_runs()
        owner = lifecycle.Run(self.store, value.directory, existing=True)
        try:
            with self.assertRaises(BlockingIOError):
                checker.check(self.repo)
            owner.update(producerQuiescent=False)
        finally:
            owner.release()
        with self.assertRaises(ValueError):
            checker.check(self.repo)


if __name__ == '__main__':
    unittest.main()
