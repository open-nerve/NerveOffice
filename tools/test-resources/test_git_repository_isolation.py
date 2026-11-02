"""Git hook isolation against owned KiB repositories, never the real project Git dir."""
import hashlib
import json
import os
from pathlib import Path
import selectors
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest


SOURCE = Path(__file__).resolve().parents[2]


class RepositoryIsolationTests(unittest.TestCase):
    def setUp(self):
        scratch = Path(os.environ['NERVE_TEST_SCRATCH']).resolve(strict=True)
        temporary_root = Path(os.environ['TMPDIR']).resolve(strict=True)
        owner = json.loads((scratch.parent / 'run.json').read_text())
        if (scratch.name != 'scratch' or scratch.parent.name != os.environ['NERVE_TEST_RUN_ID']
                or owner.get('runId') != scratch.parent.name or owner.get('repo') != str(SOURCE)
                or owner.get('status') != 'running' or owner.get('childGroup') != os.getpgrp()
                or not temporary_root.is_relative_to(scratch)):
            raise ValueError('Git fixture requires its active managed run')
        # No per-case deletion/finalizer: a timed-out hook may still have descendants.
        # run.py alone removes these fixtures after its complete group/handle checks.
        self.root = Path(tempfile.mkdtemp(prefix='git-isolation-', dir=temporary_root)).resolve()
        # Setup itself must not inherit the real pre-push context. No network or user config.
        self.env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
        self.env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_SYSTEM=os.devnull,
                        GIT_TERMINAL_PROMPT='0')
        self.parent = self.root / 'parent'
        self.parent.mkdir()
        self.git(self.parent, 'init', '-q', '--template=', '-b', 'main')
        self.git(self.parent, 'config', 'user.name', 'Isolation Fixture')
        self.git(self.parent, 'config', 'user.email', 'isolation@example.invalid')
        self.git(self.parent, 'config', 'commit.gpgsign', 'false')
        (self.parent / 'sentinel.txt').write_text('parent data must remain unchanged\n')
        self.git(self.parent, 'add', '.')
        self.git(self.parent, 'commit', '-qm', 'parent fixture')
        self.worktree = self.root / 'linked'
        self.git(self.parent, 'worktree', 'add', '-q', '-b', 'phase', str(self.worktree))
        self.git_dir = Path(self.git(self.worktree, 'rev-parse', '--absolute-git-dir').decode().strip())
        self.assertTrue(self.git_dir.is_relative_to(self.root))

    def git(self, root, *args):
        return subprocess.check_output(['git', '-C', str(root), *args], env=self.env,
                                       stderr=subprocess.PIPE, timeout=15)

    def protected_state(self):
        shared = self.parent / '.git'
        paths = [shared / name for name in ('HEAD', 'index', 'config')]
        paths += [self.git_dir / name for name in ('HEAD', 'index', 'commondir', 'gitdir')]
        paths += list((shared / 'refs').rglob('*'))
        paths += [self.parent / 'sentinel.txt', self.worktree / 'sentinel.txt']
        return {str(path.relative_to(self.root)): hashlib.sha256(path.read_bytes()).hexdigest()
                for path in paths if path.is_file()}

    def hook_fixture(self, language):
        remote = self.root / 'remote.git'
        self.git(self.root, 'init', '-q', '--bare', '--template=', str(remote))
        if language == 'typescript':
            command = [shutil.which('node'), str(SOURCE / 'node_modules/vitest/vitest.mjs'),
                       'run', '--project=unit', '--maxWorkers=1',
                       'tools/src/gates/migrations-gate.test.ts']
        else:
            command = [sys.executable, '-B', '-m', 'unittest', 'discover',
                       '-s', 'tools/test-resources', '-p', 'test_linux_browser_evidence.py']
        self.assertTrue(all(command))
        result_file = self.root / 'hook-result.json'
        driver = self.root / 'hook.py'
        driver.write_text(
            'import json, os, pathlib, subprocess, sys\n'
            f'owned = pathlib.Path({str(self.root)!r})\n'
            'git_dir = pathlib.Path(os.environ["GIT_DIR"]).resolve()\n'
            'assert git_dir.is_relative_to(owned) and git_dir.is_absolute()\n'
            f'child = subprocess.run({command!r}, cwd={str(SOURCE)!r}, capture_output=True, timeout=60)\n'
            f'pathlib.Path({str(result_file)!r}).write_text(json.dumps({{"exitCode": child.returncode, '
            '"gitDir": str(git_dir), "tail": (child.stdout + child.stderr)[-8000:].decode("utf-8", errors="replace")}))\n'
            'sys.exit(child.returncode)\n')
        hook = self.parent / '.git/hooks/pre-push'
        hook.parent.mkdir(exist_ok=True)
        hook.write_text('#!/bin/sh\nexec ' + shlex.quote(sys.executable) + ' ' + shlex.quote(str(driver)) + '\n')
        hook.chmod(0o700)
        before = self.protected_state()
        pushed = subprocess.run(['git', '-C', str(self.worktree), 'push', str(remote),
                                 'HEAD:refs/heads/accepted'], env=self.env, capture_output=True, timeout=75)
        after = self.protected_state()
        self.assertTrue(result_file.is_file(), 'the real pre-push hook must execute')
        result = json.loads(result_file.read_text())
        self.assertEqual(result['gitDir'], str(self.git_dir))
        self.assertEqual(before, after, 'foreign Git fixture changed its parent repository')
        self.assertEqual(result['exitCode'], 0, result['tail'])
        self.assertEqual(pushed.returncode, 0, pushed.stderr[-2000:].decode(errors='replace'))
        self.assertEqual(self.git(self.root, '--git-dir=' + str(remote), 'rev-parse', 'refs/heads/accepted'),
                         self.git(self.worktree, 'rev-parse', 'HEAD'))

    def test_typescript_fixture_inside_real_linked_worktree_pre_push(self):
        self.hook_fixture('typescript')

    def test_python_fixture_inside_real_linked_worktree_pre_push(self):
        self.hook_fixture('python')

    def test_explicit_readers_ignore_foreign_repository_environment(self):
        inner = self.root / 'inner'
        inner.mkdir()
        self.git(inner, 'init', '-q', '--template=', '-b', 'main')
        self.git(inner, 'config', 'user.name', 'Inner Fixture')
        self.git(inner, 'config', 'user.email', 'inner@example.invalid')
        (inner / 'inner.txt').write_text('inner\n')
        self.git(inner, 'add', '.')
        self.git(inner, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'inner fixture')
        before = self.protected_state()
        matrix = [
            {'GIT_DIR': str(self.git_dir)},
            {'GIT_WORK_TREE': str(self.worktree)},
            {'GIT_COMMON_DIR': str(self.parent / '.git')},
            {'GIT_INDEX_FILE': str(self.git_dir / 'index')},
            {'GIT_OBJECT_DIRECTORY': str(self.parent / '.git/objects')},
            {'GIT_ALTERNATE_OBJECT_DIRECTORIES': str(self.parent / '.git/objects')},
            {'GIT_PREFIX': 'wrong-prefix/'},
            {'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': 'core.worktree',
             'GIT_CONFIG_VALUE_0': str(self.worktree)},
            {'GIT_CONFIG_PARAMETERS': "'core.worktree'='" + str(self.worktree) + "'"},
        ]
        expected = self.git(inner, 'rev-parse', 'HEAD').decode().strip()
        python = ('import sys; sys.path.insert(0, ' + repr(str(SOURCE / 'tools/test-resources')) + '); '
                  'import linux_browser_evidence as subject; '
                  'print(subject.git(' + repr(str(inner)) + ', "rev-parse", "HEAD").decode().strip())')
        typescript = ('import {gitIn} from ' + json.dumps((SOURCE / 'tools/src/gates/migrations-gate.ts').as_uri()) + '; '
                      'console.log(gitIn(' + json.dumps(str(inner)) + ').mergeBase("HEAD", "HEAD"))')
        for overrides in matrix:
            for name, command in [('python', [sys.executable, '-B', '-c', python]),
                                  ('typescript', [shutil.which('node'), '--input-type=module', '-e', typescript])]:
                with self.subTest(language=name, variables=sorted(overrides)):
                    env = {**self.env, **overrides}
                    result = subprocess.run(command, env=env, cwd=SOURCE, capture_output=True, timeout=15)
                    self.assertEqual(result.returncode, 0, result.stderr[-2000:].decode(errors='replace'))
                    self.assertEqual(result.stdout.decode().strip(), expected)
        self.assertEqual(before, self.protected_state())

    def test_environment_copy_and_root_guards_preserve_parent(self):
        nested = self.worktree / 'nested'
        nested.mkdir()
        before = self.protected_state()
        controlled = {key: self.env[key] for key in ('PATH', 'TMPDIR')}
        controlled.update(NERVE_TEST_SCRATCH=str(self.root), GIT_DIR=str(self.git_dir),
                          GIT_INDEX_FILE=str(self.git_dir / 'index'), GIT_CONFIG_COUNT='1',
                          GIT_CONFIG_KEY_0='core.worktree', GIT_CONFIG_VALUE_0=str(self.parent))
        python = (
            'import sys; sys.path.insert(0, ' + repr(str(SOURCE / 'tools/test-resources')) + ')\n'
            'import git_repository as subject\n'
            f'original = {controlled!r}\n'
            'before = dict(original)\n'
            f'clean = subject.repository_environment({str(self.worktree)!r}, original)\n'
            'assert original == before\n'
            'assert all(key not in clean for key in original if key.startswith("GIT_"))\n'
            'assert all(clean[key] == value for key, value in original.items() if not key.startswith("GIT_"))\n'
            f'for root, args in [({str(self.worktree)!r}, ("init",)), ({str(nested)!r}, ("config", "user.name", "wrong"))]:\n'
            ' try: subject.git(root, *args, inherited=original)\n'
            ' except ValueError: pass\n'
            ' else: raise AssertionError("foreign root or reinitialization was accepted")\n')
        typescript = (
            'import assert from "node:assert/strict"; import {gitDirectoryEnvironment,gitInDirectory} from '
            + json.dumps((SOURCE / 'tools/src/shared/git-directory.ts').as_uri()) + ';\n'
            + 'const original = ' + json.dumps(controlled) + '; const before = {...original};\n'
            + 'const clean = gitDirectoryEnvironment(' + json.dumps(str(self.worktree)) + ', original);\n'
            + 'assert.deepEqual(original,before); for (const [key,value] of Object.entries(original)) '
            + '{ if (key.startsWith("GIT_")) assert.equal(clean[key],undefined); else assert.equal(clean[key],value); }\n'
            + 'assert.throws(()=>gitInDirectory(' + json.dumps(str(self.worktree)) + ',["init"],original), /已有 Git/);\n'
            + 'assert.throws(()=>gitInDirectory(' + json.dumps(str(nested)) + ',["config","user.name","wrong"],original), /工作树根/);\n')
        for command in ([sys.executable, '-B', '-c', python],
                        [shutil.which('node'), '--input-type=module', '-e', typescript]):
            result = subprocess.run(command, env=self.env, cwd=SOURCE, capture_output=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr[-2000:].decode(errors='replace'))
        self.assertEqual(before, self.protected_state())

    def test_timeout_keeps_fixture_and_receipt_until_descendants_close(self):
        fixture = type(self)('test_python_fixture_inside_real_linked_worktree_pre_push')
        fixture.setUp()
        receipt = fixture.root / 'hook-receipt.json'
        receipt.write_text('{"stage":"writer-started"}\n')
        writer = (
            'import pathlib,select,sys\n'
            'with pathlib.Path(sys.argv[1]).open("w") as stream:\n'
            ' stream.write("open\\n"); stream.flush(); print("ready",flush=True)\n'
            ' if select.select([sys.stdin],[],[],10)[0]: sys.stdin.read(1)\n'
            ' stream.write("closed\\n")\n')
        parent = (
            'import subprocess,sys,select\n'
            f'child=subprocess.Popen([sys.executable,"-c",{writer!r},{str(fixture.root / "writer.txt")!r}],stdin=subprocess.PIPE,stdout=subprocess.PIPE)\n'
            'print(child.stdout.readline().decode().strip(),flush=True)\n'
            'if select.select([sys.stdin],[],[],10)[0]: sys.stdin.read(1)\n'
            'child.communicate(input=b"x",timeout=5)\n'
            'sys.exit(child.returncode)\n')
        producer = subprocess.Popen([sys.executable, '-c', parent], env=self.env,
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(producer.stdout, selectors.EVENT_READ)
                self.assertTrue(selector.select(timeout=5), 'owned writer did not start')
                self.assertEqual(producer.stdout.readline(), b'ready\n')
            with self.assertRaises(subprocess.TimeoutExpired):
                producer.wait(timeout=0.01)
            fixture.doCleanups()
            self.assertIsNone(producer.poll(), 'the descendant must still be owned and alive at case cleanup')
            self.assertTrue(receipt.is_file(), 'case cleanup deleted evidence before producer closure')
            self.assertEqual((fixture.root / 'writer.txt').read_text(), 'open\n')
        finally:
            producer.communicate(input=b'x', timeout=15)
        self.assertEqual(producer.returncode, 0)
        self.assertEqual((fixture.root / 'writer.txt').read_text(), 'open\nclosed\n')
        self.assertTrue(receipt.is_file(), 'the outer managed run owns deletion after closure')


if __name__ == '__main__':
    unittest.main()
