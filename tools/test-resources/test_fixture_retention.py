"""KiB fixture/outer-run preservation; injected OS observations, no browsers."""
import json
import hashlib
import os
from pathlib import Path
import selectors
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from lifecycle import Store, atomic_json, open_paths as real_open_paths
import lifecycle

try:
    from fixture_retention import ManagedFixture
except ModuleNotFoundError:
    ManagedFixture = None


class OuterFixtureHoldTests(unittest.TestCase):
    def test_unreleased_fixture_preserves_parent_on_finish_and_restart(self):
        with tempfile.TemporaryDirectory(prefix='fixture-hold-sample-') as name, \
                patch('lifecycle.open_paths', return_value=[]):
            store = Store(Path(name))
            run = store.create('unit')
            hold = run.directory / 'fixture-holds'
            hold.mkdir()
            atomic_json(hold / 'pending.json', {'fixture': 'sample'})
            evidence = run.scratch / 'inner-run.json'
            evidence.write_bytes(b'{"cleanupError":"injected-query-failure"}\n')
            result = run.finish('failed')
            self.assertEqual(result['status'], 'cleanup-pending')
            self.assertEqual(evidence.read_bytes(), b'{"cleanupError":"injected-query-failure"}\n')
            store.sweep()
            self.assertTrue(evidence.exists())
            self.assertIn('fixture', json.loads((run.directory / 'run.json').read_text())['cleanupError'])


class ManagedFixtureTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(ManagedFixture, 'nested fixtures need an owned preservation boundary')
        self.actual_environment = {key: os.environ[key] for key in
                                   ('NERVE_TEST_RUN_DIR', 'NERVE_TEST_RUN_ID', 'NERVE_TEST_SCRATCH',
                                    'NERVE_TEST_OUTPUT_DIR', 'TMPDIR')}
        # No finalizer: the actual enclosing run owns these small test files.
        self.root = Path(tempfile.mkdtemp(prefix='fixture-contract-')).resolve()
        self.parent = Store(self.root).create('unit')
        self.parent.update(status='running', childGroup=os.getpgrp())
        temporary = self.parent.scratch / 'tmp'; temporary.mkdir()
        self.output = self.parent.scratch / 'tests/e2e/test-results'; self.output.mkdir(parents=True)
        self.env = patch.dict(os.environ, NERVE_TEST_RUN_DIR=str(self.parent.directory),
                              NERVE_TEST_RUN_ID=self.parent.id, NERVE_TEST_SCRATCH=str(self.parent.scratch),
                              NERVE_TEST_OUTPUT_DIR=str(self.output), TMPDIR=str(temporary))
        self.env.start(); self.addCleanup(self.env.stop)
        self.addCleanup(self.parent.release)
        self.query = patch('lifecycle.open_paths', return_value=[])
        self.query.start(); self.addCleanup(self.query.stop)

    def child(self, fixture, status='failed'):
        child = Store(fixture.path).create('unit')
        child.update(status=status, cleanupError='injected-failure')
        self.addCleanup(child.release)
        return child

    def assert_failed_case_preserves_child(self, case, inject):
        """Exercise the real test fixture teardown, using only a KiB model child."""
        original = []
        def failure(repo):
            child = Store(repo).create('unit')
            child.update(status='cleanup-pending', cleanupError='controlled-inner-query-failure')
            record = child.directory / 'run.json'
            original.append((record, record.read_bytes()))
            child.release()
            raise RuntimeError('controlled-inner-query-failure')
        result = unittest.TestResult()
        with inject(failure):
            case.run(result)
        self.assertFalse(result.wasSuccessful(), 'the injected child must fail the case')
        self.assertEqual(len(original), 1)
        record, raw = original[0]
        self.assertTrue(record.exists(), 'test teardown deleted the failed child ledger')
        self.assertEqual(record.read_bytes(), raw)
        self.parent.update(childGroup=None)
        self.assertEqual(self.parent.finish('failed')['status'], 'cleanup-pending')
        Store(self.root).sweep()
        self.assertEqual(record.read_bytes(), raw, 'outer recovery deleted the failed child ledger')

    def test_desktop_fixture_failure_survives_test_teardown_and_outer_restart(self):
        from test_desktop_session_runner import DesktopSessionRunnerTests
        def inject(failure):
            return patch.object(DesktopSessionRunnerTests, 'invoke',
                                lambda case, *_: failure(case.repo))
        self.assert_failed_case_preserves_child(
            DesktopSessionRunnerTests('test_healthy_session_preserves_success'), inject)

    def test_runner_fixture_failure_survives_context_finalizer_and_outer_restart(self):
        from test_lifecycle import RunnerTests
        def inject(failure):
            def command(arguments, **_):
                return failure(Path(arguments[arguments.index('--repo') + 1]))
            return patch('test_lifecycle.subprocess.run', side_effect=command)
        self.assert_failed_case_preserves_child(
            RunnerTests('test_success_failure_and_interrupt_use_real_small_child'), inject)

    def test_node_failure_fixture_survives_test_teardown_and_outer_restart(self):
        from test_container_resources import ContainerResourceTests
        def inject(failure):
            return patch.object(ContainerResourceTests, 'run_node_protocol',
                                lambda case, *_: failure(case.repo))
        self.assert_failed_case_preserves_child(
            ContainerResourceTests('test_product_failure_is_preserved_after_actual_node_cleanup'), inject)

    def test_short_runner_fixture_failure_survives_test_teardown_and_outer_restart(self):
        from test_short_paths import ShortPathTests
        def inject(failure):
            def command(arguments, **_):
                return failure(Path(arguments[arguments.index('--repo') + 1]))
            return patch('test_short_paths.subprocess.run', side_effect=command)
        self.assert_failed_case_preserves_child(
            ShortPathTests('test_runner_uses_short_alias_but_writes_to_canonical_scratch'), inject)

    def test_alias_signal_fixture_failure_survives_test_teardown_and_outer_restart(self):
        from test_short_paths import ShortPathTests
        def inject(failure):
            def command():
                return failure(Path(sys.argv[sys.argv.index('--repo') + 1]))
            return patch('run.main', side_effect=command)
        self.assert_failed_case_preserves_child(
            ShortPathTests('test_sigterm_during_alias_creation_never_starts_command_and_cleans_roots'), inject)

    def test_hosted_real_child_failure_survives_test_teardown_and_outer_restart(self):
        from test_hosted_lifecycle import HostedLifecycleTests
        def inject(failure):
            def command():
                return failure(Path(sys.argv[sys.argv.index('--repo') + 1]))
            return patch('run.main', side_effect=command)
        self.assert_failed_case_preserves_child(
            HostedLifecycleTests('test_real_successful_producer_records_success_and_preserves_source'), inject)

    def protocol_model(self):
        self.assertTrue(callable(getattr(ManagedFixture, 'dispose_node_protocol_model', None)),
                        'a simulated pending protocol needs an explicit non-product disposition')
        fixture = ManagedFixture(simulation='node-docker-stub-v1')
        child = Store(fixture.path).create('container')
        self.addCleanup(child.release)
        child.update(status='cleanup-pending', producerQuiescent=True)
        ledger = child.directory / 'container-resources.json'
        value = json.loads(ledger.read_text())
        value.update(state='reserved', daemon='protocol-daemon', producers=[None],
                     repoHash=hashlib.sha256(str(fixture.path).encode()).hexdigest(),
                     project='nerve-office-e2e-' + child.id, image='nerve-office:e2e-' + child.id,
                     temporaryDirectory=str(child.scratch / 'tmp/model'),
                     observed={'containers': [], 'networks': [], 'volumes': [], 'images': []})
        atomic_json(ledger, value)
        child.release()
        return fixture, child

    def test_protocol_model_disposal_keeps_pending_original_and_delegates_owned_files(self):
        fixture, child = self.protocol_model()
        original = (child.directory / 'run.json').read_bytes()
        fixture.dispose_node_protocol_model()
        self.assertFalse(fixture.hold.exists())
        self.assertTrue(child.scratch.exists(), 'the outer owner removes the local model files')
        self.assertEqual((child.directory / 'run.json').read_bytes(), original)
        self.assertEqual((fixture.evidence / child.id / 'run.json').read_bytes(), original)
        proof = json.loads((fixture.evidence / 'simulation-disposition.json').read_text())
        self.assertEqual(proof['disposition'], 'test-model-only')
        self.assertFalse(proof['realDockerClosureObserved'])
        fixture.close()  # idempotent, never turn the product record into passed/complete.

    def test_protocol_model_disposal_does_not_count_its_own_lock_as_a_writer(self):
        fixture, child = self.protocol_model()
        # Real lsof: the former all-root query ran after acquiring run.lock.
        with patch('lifecycle.open_paths', side_effect=real_open_paths):
            fixture.dispose_node_protocol_model()
        self.assertFalse(fixture.hold.exists())

    def test_protocol_model_disposal_rejects_unregistered_mode_and_live_producer(self):
        fixture, child = self.protocol_model()
        ordinary = ManagedFixture()
        value = self.child(ordinary); value.release()
        with patch('lifecycle.group_alive', return_value=True):
            with self.assertRaisesRegex(RuntimeError, 'retained'):
                fixture.dispose_node_protocol_model()
        self.assertTrue(fixture.hold.exists())
        with self.assertRaisesRegex(RuntimeError, 'retained'):
            ordinary.dispose_node_protocol_model()
        self.assertTrue(ordinary.hold.exists())

    def test_protocol_model_disposal_query_failure_preserves_raw_ledger(self):
        fixture, child = self.protocol_model()
        original = (child.directory / 'container-resources.json').read_bytes()
        with patch('lifecycle.open_paths', side_effect=RuntimeError('controlled-model-query-failure')):
            with self.assertRaisesRegex(RuntimeError, 'retained'):
                fixture.dispose_node_protocol_model()
        self.assertTrue(fixture.hold.exists())
        self.assertEqual((child.directory / 'container-resources.json').read_bytes(), original)

    def test_protocol_model_rejects_unknown_fields_and_unmodelled_resource_states(self):
        cases = ('unknown', 'repoHash', 'project', 'temporary', 'images', 'problem',
                 'cleanupFailures', 'closure', 'serviceScope', 'hostedScope')
        # Reserve every independent fixture before the first deliberately retained failure.
        models = [self.protocol_model() for _ in cases]
        for case, (fixture, child) in zip(cases, models):
            with self.subTest(case=case):
                path = child.directory / 'container-resources.json'
                value = json.loads(path.read_text())
                if case == 'unknown': value['extraPrivateField'] = 'fixture-private-marker'
                elif case == 'repoHash': value['repoHash'] = '0' * 64
                elif case == 'project': value['project'] = 'another-project'
                elif case == 'temporary': value['temporaryDirectory'] = '/not-owned'
                elif case == 'images': value['observedImageIds'] = {'unexpected': 'sha256:1234'}
                elif case == 'problem': value['problem'] = 'docker-query-failed'
                elif case == 'cleanupFailures': value['cleanupFailures'] = []
                elif case == 'closure':
                    value['closure'] = {'daemon':'protocol-daemon','observedAt':'2026-11-03T00:00:00.000Z',
                                        'absent':{'containers':[],'networks':[],'volumes':[],'images':[]}}
                else: child.update(**{case:{'fixture':True}})
                atomic_json(path, value)
                original = path.read_bytes()
                with self.assertRaisesRegex(RuntimeError, 'retained'):
                    fixture.dispose_node_protocol_model()
                self.assertTrue(fixture.hold.exists())
                self.assertEqual(path.read_bytes(), original)
                self.assertFalse((fixture.evidence / 'simulation-ledger.json').exists())

    def test_closed_vm_record_keeps_its_vm_short_namespace(self):
        fixture = ManagedFixture()
        child = Store(fixture.path).create('vm')
        self.addCleanup(child.release)
        # A completed creation interrupted before mkdir has no global resource.
        short = Path('/tmp').resolve() / ('nerve-vm-' + child.id)
        child.update(shortRoot=str(short), shortRootIdentity=None)
        self.assertEqual(child.finish('interrupted').get('cleanupStage'), 'complete')
        fixture.close()
        self.assertFalse(fixture.hold.exists())

    def hosted_model(self):
        self.assertTrue(callable(getattr(ManagedFixture, 'dispose_hosted_command_model', None)),
                        'real hosted-model producers need physical cleanup after observations are restored')
        fixture = ManagedFixture(simulation='hosted-command-observation-v1')
        context = {'version':1,'policy':'github-hosted-vm','repo':str(fixture.path),
                   'repository':'open-nerve/NerveOffice','sha':'a'*40,'runId':'40600596503',
                   'attempt':'2','job':'e2e','runner':'GitHub Actions test',
                   'bootId':'66666666-7777-4888-8999-aaaaaaaaaaaa'}
        with patch.object(lifecycle.hosted, 'context', return_value=context):
            child = Store(fixture.path).create('check')
        self.addCleanup(child.release)
        child.update(status='passed',cleanupStage='host-disposal-pending',cleanupComplete=False,
                     producerQuiescent=True)
        child.release()
        return fixture, child

    def test_hosted_command_model_uses_real_queries_and_preserves_deferred_original(self):
        fixture, child = self.hosted_model()
        original = (child.directory / 'run.json').read_bytes()
        with patch('lifecycle.open_paths', side_effect=real_open_paths):
            fixture.dispose_hosted_command_model()
        self.assertFalse(fixture.hold.exists())
        self.assertEqual((child.directory / 'run.json').read_bytes(), original)
        self.assertEqual((fixture.evidence / child.id / 'run.json').read_bytes(), original)
        proof = json.loads((fixture.evidence / 'simulation-disposition.json').read_text())
        self.assertEqual(proof['disposition'], 'test-model-only')
        self.assertFalse(proof['hostDisposalObserved'])

    def test_hosted_command_model_rejects_changed_scope_live_writer_or_incomplete_producer(self):
        cases = ('scope', 'service', 'producer', 'writer')
        models = [self.hosted_model() for _ in cases]
        for case, (fixture, child) in zip(cases, models):
            with self.subTest(case=case):
                if case == 'scope':
                    scope = child.data['hostedScope']; scope['context']['runId'] = 'different'
                    child.update(hostedScope=scope)
                elif case == 'service': child.update(serviceScope={'unexpected':True})
                elif case == 'producer': child.update(producerQuiescent=False)
                with patch('lifecycle.open_paths', return_value=[str(child.scratch / 'writer')] if case == 'writer' else []):
                    with self.assertRaisesRegex(RuntimeError, 'retained'):
                        fixture.dispose_hosted_command_model()
                self.assertTrue(fixture.hold.exists())
                self.assertTrue(child.scratch.exists())

    def test_pending_keeps_original_bytes_and_blocks_parent_after_restart(self):
        fixture = ManagedFixture()
        child = self.child(fixture)
        child.update(status='cleanup-pending')
        before = (child.directory / 'run.json').read_bytes()
        child.release()
        with self.assertRaisesRegex(RuntimeError, 'retained'):
            fixture.close()
        self.assertEqual((fixture.evidence / child.id / 'run.json').read_bytes(), before)
        self.assertEqual((child.directory / 'run.json').read_bytes(), before)
        self.parent.update(childGroup=None)
        self.assertEqual(self.parent.finish('failed')['status'], 'cleanup-pending')
        Store(self.root).sweep()
        self.assertTrue(child.scratch.exists())
        self.assertTrue((fixture.path / '.test-resources/runs' / child.id / 'run.json').exists())

    def test_closed_failure_releases_only_own_hold_and_close_is_idempotent(self):
        first, second = ManagedFixture(), ManagedFixture()
        a, b = self.child(first), self.child(second)
        a.finish('failed'); b.release()
        original = (a.directory / 'run.json').read_bytes()
        first.close(); first.close()
        self.assertFalse(first.hold.exists())
        self.assertTrue(second.hold.exists())
        self.assertTrue(first.path.exists())
        self.assertEqual((first.evidence / a.id / 'run.json').read_bytes(), original)
        self.assertEqual(json.loads(original)['status'], 'failed')
        self.parent.update(childGroup=None)
        self.assertEqual(self.parent.finish('failed')['status'], 'cleanup-pending')

    def test_active_writer_and_lease_are_not_released(self):
        fixture = ManagedFixture()
        child = self.child(fixture)
        target = child.scratch / 'writer.txt'
        code = 'import pathlib,sys; f=pathlib.Path(sys.argv[1]).open("w"); f.write("keep"); f.flush(); print("ready",flush=True); sys.stdin.read(1); f.close()'
        process = subprocess.Popen([sys.executable, '-c', code, str(target)],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, start_new_session=True)
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                self.assertTrue(selector.select(timeout=5), 'owned writer did not start')
                self.assertEqual(process.stdout.readline(), b'ready\n')
            child.update(status='running', childGroup=process.pid)
            with self.assertRaisesRegex(RuntimeError, 'retained'):
                fixture.close()
            self.assertTrue(fixture.hold.exists())
            self.assertEqual(target.read_text(), 'keep')
            self.assertIsNone(process.poll())
        finally:
            process.communicate(input=b'x', timeout=5)
            child.finish('failed')
        # Explicit child closure is not permission to retry an already failed fixture.
        with self.assertRaisesRegex(RuntimeError, 'retained'):
            fixture.close()
        self.assertTrue(fixture.hold.exists())
        self.assertEqual(json.loads((fixture.evidence / child.id / 'run.json').read_text())['status'], 'running')

    def test_oversized_record_retains_source_and_rejects_export(self):
        fixture = ManagedFixture()
        child = self.child(fixture)
        child.update(cleanupError='x' * (64 * 1024)); child.release()
        with self.assertRaisesRegex(RuntimeError, 'retained'):
            fixture.close()
        self.assertTrue(fixture.hold.exists())
        self.assertTrue((child.directory / 'run.json').exists())
        self.assertLess(sum(p.stat().st_size for p in fixture.evidence.rglob('*') if p.is_file()), 64 * 1024)

    def test_empty_fixture_or_replaced_root_never_releases_registration(self):
        empty, replaced = ManagedFixture(), ManagedFixture()
        with self.assertRaisesRegex(RuntimeError, 'retained'):
            empty.close()
        self.assertTrue(empty.hold.exists())
        saved = replaced.path.with_name(replaced.path.name + '-original')
        replaced.path.rename(saved); replaced.path.mkdir()
        with self.assertRaisesRegex(RuntimeError, 'retained'):
            replaced.close()
        self.assertTrue(saved.exists())
        self.assertTrue(replaced.hold.exists())

    def test_short_root_creation_identity_and_original_owner_are_exported(self):
        # This sample creates a real global short root. Its guard belongs to the
        # actual runner, not the simulated parent used by the other injection cases.
        with patch.dict(os.environ, self.actual_environment):
            fixture = ManagedFixture()
            child = self.child(fixture)
            try:
                child.create_short_tmp()
                owner = (Path(child.data['shortRoot']) / 'owner.json').read_bytes()
                original = (child.directory / 'run.json').read_bytes()
                actual_hold = Path(self.actual_environment['NERVE_TEST_RUN_DIR']) / 'fixture-holds' / (fixture.token + '.json')
                self.assertTrue(actual_hold.is_file(), 'the real outer run must preserve every global short root')
                fixture.capture()
                destination = fixture.evidence / child.id
                self.assertEqual((destination / 'run.json').read_bytes(), original)
                self.assertEqual((destination / 'short-owner.json').read_bytes(), owner)
                self.assertEqual(json.loads(original)['shortRootIdentity'], child.data['shortRootIdentity'])
                self.assertTrue(Path(child.data['shortRoot']).exists())
            finally:
                result = child.finish('failed')
                self.assertEqual(result.get('cleanupStage'), 'complete', result.get('cleanupError'))
            self.assertFalse(Path(child.data['shortRoot']).exists())
            fixture.close()

    def test_total_report_budget_blocks_new_export_without_touching_prior_evidence(self):
        first, second = ManagedFixture(), ManagedFixture()
        a, b = self.child(first), self.child(second)
        a.finish('failed'); b.finish('failed')
        first.capture()
        before = (first.evidence / a.id / 'run.json').read_bytes()
        used = sum(p.stat().st_size for p in first.report_root.rglob('*') if p.is_file())
        with patch('fixture_retention.REPORT_LIMIT', used + 1):
            with self.assertRaisesRegex(RuntimeError, 'budget'):
                second.close()
        self.assertEqual((first.evidence / a.id / 'run.json').read_bytes(), before)
        self.assertTrue(second.hold.exists())

    def test_existing_registration_and_tampered_export_are_never_adopted(self):
        fixture = ManagedFixture()
        original = fixture.hold.read_bytes()
        with patch('fixture_retention.uuid.uuid4', return_value=fixture.token):
            with self.assertRaisesRegex(ValueError, 'registration-exists'):
                ManagedFixture()
        self.assertEqual(fixture.hold.read_bytes(), original)
        child = self.child(fixture); child.finish('failed'); fixture.capture()
        (fixture.evidence / child.id / 'run.json').write_text('replaced')
        with self.assertRaisesRegex(RuntimeError, 'export-changed'):
            fixture.close()
        self.assertTrue(fixture.hold.exists())

    def test_interrupted_creation_is_registered_before_directory_exists(self):
        original = Path.mkdir
        def mkdir(path, *args, **kwargs):
            if path.name.startswith('resource-fixture-'):
                raise OSError('injected-create-failure')
            return original(path, *args, **kwargs)
        with patch.object(Path, 'mkdir', mkdir):
            with self.assertRaisesRegex(OSError, 'injected-create-failure'):
                ManagedFixture()
        hold, = (self.parent.directory / 'fixture-holds').iterdir()
        data = json.loads(hold.read_text())
        self.assertEqual(data['state'], 'reserved')
        self.assertFalse(Path(data['root']).exists())
        self.parent.update(childGroup=None)
        self.assertEqual(self.parent.finish('failed')['status'], 'cleanup-pending')

    def test_live_group_remains_blocking_after_lease_is_released(self):
        fixture = ManagedFixture()
        child = self.child(fixture); child.finish('failed')
        process = subprocess.Popen([sys.executable, '-c', 'import sys; sys.stdin.read(1)'],
                                   stdin=subprocess.PIPE, start_new_session=True)
        try:
            child.update(childGroup=process.pid)
            with self.assertRaisesRegex(RuntimeError, 'child-not-closed'):
                fixture.close()
            self.assertIsNone(process.poll())
            self.assertTrue(fixture.hold.exists())
        finally:
            process.communicate(input=b'x', timeout=5)

    def test_foreign_outer_environment_is_rejected_before_registration(self):
        with patch.dict(os.environ, NERVE_TEST_SCRATCH=str(self.root)):
            with self.assertRaisesRegex(ValueError, 'active-owned-run'):
                ManagedFixture()
        self.assertFalse((self.parent.directory / 'fixture-holds').exists())

    def test_boundary_query_failure_is_exported_even_without_child_cleanup_error(self):
        fixture = ManagedFixture()
        child = self.child(fixture); child.finish('failed')
        message = 'injected-query-context-' + 'x' * 4096 + '-fd=fp.'
        with patch('lifecycle.open_paths', side_effect=RuntimeError(message)):
            with self.assertRaisesRegex(RuntimeError, 'retained'):
                fixture.close()
        diagnostic = fixture.evidence / 'failure.json'
        self.assertTrue(diagnostic.is_file(), 'outer boundary error needs durable evidence too')
        self.assertEqual(json.loads(diagnostic.read_text())['error'], message)
        self.assertTrue(fixture.hold.exists())


if __name__ == '__main__':
    unittest.main()
