"""Preserve nested runner fixtures; never retry a failed child or delete its files."""
import hashlib
import json
import os
from pathlib import Path
import stat
import uuid

import lifecycle

CHILD_LIMIT = 64 * 1024
REPORT_LIMIT = 1024 * 1024


def read_bytes(path, limit):
    path = Path(path)
    if path.parent.resolve() != path.parent.absolute():
        raise ValueError('fixture-linked-parent')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError('fixture-nonregular-record')
        raw = stream.read(limit + 1)
    if len(raw) > limit:
        raise ValueError('fixture-record-budget')
    return raw


def decode(raw):
    def unique(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError('fixture-duplicate-key')
            value[key] = item
        return value
    value = json.loads(raw, object_pairs_hook=unique)
    if not isinstance(value, dict):
        raise ValueError('fixture-record-type')
    return value


def identity(path):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise ValueError('fixture-directory-identity')
    return {'device': info.st_dev, 'inode': info.st_ino}


def report_size(root):
    size = 0
    for parent, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            item = Path(parent) / name
            mode = item.lstat().st_mode
            if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
                raise ValueError('fixture-report-type')
            if stat.S_ISREG(mode):
                size += item.stat().st_size
            if size > REPORT_LIMIT:
                raise ValueError('fixture-report-budget')
    return size


class ManagedFixture:
    def __init__(self):
        self.parent = Path(os.environ['NERVE_TEST_RUN_DIR']).absolute()
        owner = decode(read_bytes(self.parent / 'run.json', CHILD_LIMIT))
        token = os.environ['NERVE_TEST_RUN_ID']
        scratch = Path(os.environ['NERVE_TEST_SCRATCH']).resolve(strict=True)
        temporary = Path(os.environ['TMPDIR']).resolve(strict=True)
        output = Path(os.environ['NERVE_TEST_OUTPUT_DIR']).resolve(strict=True)
        if (not lifecycle.RUN_ID.fullmatch(token) or self.parent.name != token
                or self.parent != Path(owner['repo']) / '.test-resources/runs' / token
                or owner.get('runId') != token or owner.get('version') != 1
                or owner.get('status') != 'running' or owner.get('childGroup') != os.getpgrp()
                or scratch != self.parent / 'scratch' or not temporary.is_relative_to(scratch)
                or output != scratch / 'tests/e2e/test-results'):
            raise ValueError('fixture-requires-active-owned-run')
        self.holds = self.parent / 'fixture-holds'
        self.lock = self.parent / 'fixture-holds.lock'
        self.token = str(uuid.uuid4())
        self.path = temporary / ('resource-fixture-' + self.token)
        self.hold = self.holds / (self.token + '.json')
        self.report_root = output / 'fixture-evidence'
        self.evidence = self.report_root / self.token
        self.closed = False
        self.failure = None
        self.exports = {}
        with lifecycle.locked(self.lock):
            self.holds.mkdir(mode=0o700, exist_ok=True)
            self.holds_identity = identity(self.holds)
            for existing in self.holds.iterdir():
                if decode(read_bytes(existing, CHILD_LIMIT)).get('state') == 'pending':
                    raise RuntimeError('prior-fixture-retained')
            self.record = {'version': 1, 'parentRunId': token, 'fixtureId': self.token,
                           'root': str(self.path), 'identity': None, 'state': 'reserved'}
            if self.hold.exists() or self.hold.is_symlink():
                raise ValueError('fixture-registration-exists')
            lifecycle.atomic_json(self.hold, self.record)  # Durable before mkdir.
            self.path.mkdir(mode=0o700)
            self.record.update(identity=identity(self.path), state='active')
            lifecycle.atomic_json(self.hold, self.record)
            report_owner = {'version': 1, 'parentRunId': token, 'purpose': 'nested-fixture-evidence'}
            if self.report_root.exists() or self.report_root.is_symlink():
                if decode(read_bytes(self.report_root / 'owner.json', CHILD_LIMIT)) != report_owner:
                    raise ValueError('fixture-report-owner')
            else:
                self.report_root.mkdir(mode=0o700)
                lifecycle.atomic_json(self.report_root / 'owner.json', report_owner)
            self.report_identity = identity(self.report_root)
            self.evidence.mkdir(mode=0o700)
            self.evidence_identity = identity(self.evidence)

    def verify(self):
        if (identity(self.holds) != self.holds_identity
                or decode(read_bytes(self.hold, CHILD_LIMIT)) != self.record
                or identity(self.path) != self.record['identity']
                or identity(self.report_root) != self.report_identity
                or identity(self.evidence) != self.evidence_identity):
            raise ValueError('fixture-identity-changed')

    def records(self):
        store = self.path / '.test-resources'
        expected = {'version': 1, 'purpose': 'nerve-office-test-resources', 'repo': str(self.path)}
        if decode(read_bytes(store / 'owner.json', CHILD_LIMIT)) != expected:
            raise ValueError('fixture-store-owner')
        roots = sorted((store / 'runs').iterdir())
        if not 1 <= len(roots) <= 16:
            raise ValueError('fixture-run-count')
        result = []
        for root in roots:
            if not lifecycle.RUN_ID.fullmatch(root.name):
                raise ValueError('fixture-run-name')
            identity(root)
            raw = read_bytes(root / 'run.json', CHILD_LIMIT)
            value = decode(raw)
            if value.get('runId') != root.name or value.get('repo') != str(self.path) or value.get('version') != 1:
                raise ValueError('fixture-child-owner')
            result.append((root, value, raw))
        return result

    def pending(self, error):
        raw = str(error).encode('utf-8', errors='replace')
        self.failure = raw[:8192].decode('utf-8', errors='replace')
        details = {'version': 1, 'parentRunId': self.record['parentRunId'], 'fixtureId': self.token,
                   'error': self.failure, 'errorBytes': len(raw),
                   'errorSha256': hashlib.sha256(raw).hexdigest(), 'errorTruncated': len(raw) > 8192}
        # Never rewrite a marker that no longer matches this instance.
        try:
            with lifecycle.locked(self.lock):
                if (identity(self.holds) == self.holds_identity
                        and decode(read_bytes(self.hold, CHILD_LIMIT)) == self.record):
                    self.record.update(state='pending', **{key: details[key] for key in
                                                          ('error', 'errorBytes', 'errorSha256', 'errorTruncated')})
                    lifecycle.atomic_json(self.hold, self.record)
                    try:
                        if (identity(self.report_root) != self.report_identity
                                or identity(self.evidence) != self.evidence_identity):
                            raise ValueError('fixture-report-identity')
                        encoded = (json.dumps(details, ensure_ascii=True, indent=2) + '\n').encode()
                        if len(encoded) > CHILD_LIMIT or report_size(self.report_root) + len(encoded) > REPORT_LIMIT:
                            raise ValueError('fixture-evidence-budget')
                        target = self.evidence / 'failure.json'
                        if target.exists() or target.is_symlink():
                            raise ValueError('fixture-error-export-exists')
                        lifecycle.atomic_bytes(target, encoded)
                        if read_bytes(target, CHILD_LIMIT) != encoded:
                            raise ValueError('fixture-error-export-mismatch')
                        self.record['diagnosticExported'] = True
                    except (OSError, ValueError, RuntimeError) as export_error:
                        self.record.update(diagnosticExported=False, diagnosticExportError=type(export_error).__name__)
                    lifecycle.atomic_json(self.hold, self.record)
        except (OSError, ValueError, RuntimeError):
            pass  # The original hold remains, including malformed/unknown holds.
        raise RuntimeError('nested-fixture-retained: ' + self.failure) from error

    def capture(self):
        if self.failure:
            raise RuntimeError('nested-fixture-retained: ' + self.failure)
        try:
            with lifecycle.locked(self.lock):
                self.verify()
                report_size(self.report_root)
                records = self.records()
                for root, value, raw in records:
                    target = self.evidence / root.name
                    if target.exists() or target.is_symlink():
                        # First observation is immutable; a later closure cannot erase a failure.
                        identity(target)
                        expected = self.exports.get(root.name)
                        if expected is None or set(p.name for p in target.iterdir()) != set(expected):
                            raise ValueError('fixture-export-identity')
                        for name, digest in expected.items():
                            if hashlib.sha256(read_bytes(target / name, CHILD_LIMIT)).hexdigest() != digest:
                                raise ValueError('fixture-export-changed')
                        continue
                    files = {'run.json': raw}
                    short = value.get('shortRoot')
                    expected_short = Path('/tmp').resolve() / ('nerve-t-' + root.name)
                    if short is not None:
                        if short != str(expected_short):
                            raise ValueError('fixture-short-owner')
                        if expected_short.exists() or expected_short.is_symlink():
                            if identity(expected_short) != value.get('shortRootIdentity'):
                                raise ValueError('fixture-short-identity')
                            files['short-owner.json'] = read_bytes(expected_short / 'owner.json', CHILD_LIMIT)
                            if decode(files['short-owner.json']) != {'runId': root.name, 'repo': str(self.path), 'kind': 'test-short-path'}:
                                raise ValueError('fixture-short-owner')
                    summary = {'version': 1, 'parentRunId': self.record['parentRunId'],
                               'fixtureId': self.token, 'runId': root.name, 'root': str(self.path),
                               'identity': self.record['identity'],
                               'sha256': {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
                    files['index.json'] = (json.dumps(summary, ensure_ascii=False, indent=2) + '\n').encode()
                    size = sum(len(data) for data in files.values())
                    if size > CHILD_LIMIT or report_size(self.report_root) + size > REPORT_LIMIT:
                        raise ValueError('fixture-evidence-budget')
                    target.mkdir(mode=0o700)
                    for name, data in files.items():
                        lifecycle.atomic_bytes(target / name, data)
                        if read_bytes(target / name, CHILD_LIMIT) != data:
                            raise ValueError('fixture-export-mismatch')
                    self.exports[root.name] = {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}
                return records
        except (OSError, ValueError, RuntimeError, KeyError) as error:
            self.pending(error)

    def close(self):
        if self.closed:
            return
        records = self.capture()
        try:
            with lifecycle.locked(self.lock):
                self.verify()
                if lifecycle.open_paths(self.path):
                    raise RuntimeError('fixture-open-handles')
                for root, _, captured in records:
                    lock = root / 'run.lock'
                    if not stat.S_ISREG(lock.lstat().st_mode):
                        raise ValueError('fixture-run-lock-type')
                    with lifecycle.locked(lock, blocking=False):
                        current = read_bytes(root / 'run.json', CHILD_LIMIT)
                        if current != captured:
                            raise ValueError('fixture-child-record-changed')
                        value = decode(current)
                        if (value.get('runId') != root.name or value.get('repo') != str(self.path)
                                or value.get('status') not in ('passed', 'failed', 'interrupted')
                                or value.get('cleanupStage') not in ('complete', 'never-started')
                                or lifecycle.group_alive(value.get('childGroup'))):
                            raise RuntimeError('fixture-child-not-closed')
                        scratch = root / 'scratch'
                        short = Path('/tmp').resolve() / ('nerve-t-' + root.name)
                        if (scratch.exists() or scratch.is_symlink() or short.exists() or short.is_symlink()):
                            raise RuntimeError('fixture-child-resources-remain')
                self.verify()
                self.hold.unlink()
                if not any(self.holds.iterdir()):
                    self.holds.rmdir()
                self.closed = True
        except (OSError, ValueError, RuntimeError, KeyError) as error:
            self.pending(error)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
