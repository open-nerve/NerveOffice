"""Bounded Docker cp stream: only stopped-container evidence reaches the host.

The caller proves container/producer identity and quiescence before and after.
This module never stops containers, removes volumes, or grants cleanup rights.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import signal
import subprocess
import tarfile

from stable_reports import _Tree

LIMIT = 5 * 1024 ** 3
METADATA_LIMIT = 64 * 1024 ** 2
PROOFS = {'versions.json', 'patches-before.json', 'patches-after.json',
          'source-before.json', 'source-after.json', 'execution.json',
          'preflight-before-install.json', 'preflight-after-pnpm.json'}
RUN_FILES = {'run.json', 'command.log', 'reports/command.log', 'reports/temporary-inventory.json'}
UUID = re.compile(r'^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$')


class _BoundedTarInfo(tarfile.TarInfo):
    def _proc_member(self, archive):
        extended = self.type in (tarfile.XHDTYPE, tarfile.XGLTYPE, tarfile.GNUTYPE_LONGNAME,
                                 tarfile.GNUTYPE_LONGLINK, tarfile.SOLARIS_XHDTYPE)
        if extended and self.size > 64 * 1024:
            raise ValueError('transport-metadata-budget')
        if self.size < 0 or self.size > LIMIT:
            raise ValueError('transport-member-budget')
        metadata = getattr(archive, '_bounded_metadata', 0) + 512
        metadata += self._block(self.size) if extended else self._block(self.size) - self.size
        archive._bounded_metadata = metadata
        if metadata > METADATA_LIMIT:
            raise ValueError('transport-metadata-budget')
        return super()._proc_member(archive)

    def _refuse_sparse(self, *unused):
        raise ValueError('transport-sparse-file')

    _proc_sparse = _refuse_sparse
    _proc_gnusparse_00 = _refuse_sparse
    _proc_gnusparse_01 = _refuse_sparse
    _proc_gnusparse_10 = _refuse_sparse


class _Reader:
    def __init__(self, stream, limit):
        self.stream, self.limit, self.count = stream, limit, 0

    def read(self, size):
        if size < 0 or self.count + size > self.limit:
            raise ValueError('transport-stream-budget')
        value = self.stream.read(size)
        self.count += len(value)
        return value


def _name(name):
    if name.startswith('./'):
        name = name[2:]
    if name in ('', '.'):
        return ''
    if name.endswith('/'):
        name = name[:-1]
    if '\\' in name or '\0' in name or any(p in ('', '.', '..') for p in name.split('/')):
        raise ValueError('transport-path')
    return name


def _retain(name, section, directory):
    parts = name.split('/')
    if section == 'runs':
        if not UUID.fullmatch(parts[0]):
            raise ValueError('transport-run-path')
        return not directory and '/'.join(parts[1:]) in RUN_FILES
    if parts[0] in PROOFS and len(parts) == 1:
        return True
    expected = ('groups', ('calibration', 'stories'), 'tests', 'e2e', ('test-results', 'playwright-report'))
    for index, part in enumerate(parts[:5]):
        if part not in (expected[index] if isinstance(expected[index], tuple) else (expected[index],)):
            raise ValueError('transport-evidence-path')
    if len(parts) < 6 and not directory:
        raise ValueError('transport-evidence-path')
    if 'persistent-profiles' in parts:
        index = parts.index('persistent-profiles')
        if len(parts) > index + 2 and parts[index + 2] not in ('resource-owner.json', 'retention.json', 'opfs-archive'):
            return False
    return True


def receive_archive(stream, destination, section, budget=LIMIT):
    if section not in ('evidence', 'runs') or not 0 < budget <= LIMIT:
        raise ValueError('transport-section-or-budget')
    destination = Path(destination)
    prefix = 'evidence' if section == 'evidence' else 'source/.test-resources/runs'
    reader = _Reader(stream, budget + 64 * 1024 ** 2)
    names = set(); files = []; retained = scanned = omitted = 0
    unknown_runs = []
    with _Tree(destination) as target:
        target.mkdirs(prefix)
        with tarfile.open(fileobj=reader, mode='r|', tarinfo=_BoundedTarInfo) as archive:
            for member in archive:
                if len(names) >= 100000:
                    raise ValueError('transport-entry-budget')
                name = _name(member.name)
                if name in names:
                    raise ValueError('transport-duplicate')
                names.add(name)
                if member.issym() or member.islnk() or not (member.isdir() or member.isreg()):
                    raise ValueError('transport-file-type')
                if not name:
                    if not member.isdir():
                        raise ValueError('transport-root')
                    continue
                keep = _retain(name, section, member.isdir())
                if section == 'runs':
                    # Keep even a mkdir/run.lock-only run visible to the collector.
                    target.mkdirs(prefix + '/' + name.split('/')[0])
                    relative = '/'.join(name.split('/')[1:])
                    known_directory = member.isdir() and relative in ('', 'reports')
                    known_lock = member.isreg() and relative == 'run.lock' and member.size == 0
                    if not keep and not known_directory and not known_lock and len(unknown_runs) < 16:
                        unknown_runs.append({'path': name[:512], 'sha256': hashlib.sha256(name.encode()).hexdigest()})
                scanned += member.size
                if scanned > budget or (section == 'runs' and keep and member.size > 4 * 1024 ** 2):
                    raise ValueError('transport-payload-budget')
                if member.isdir():
                    continue
                if not keep:
                    omitted += 1
                    continue
                path = prefix + '/' + name
                target.mkdirs(str(Path(path).parent))
                digest = hashlib.sha256(); count = 0
                with archive.extractfile(member) as source:
                    def copy(sink):
                        nonlocal count
                        for block in iter(lambda: source.read(1024 * 1024), b''):
                            count += len(block)
                            if count > member.size:
                                raise ValueError('transport-member-grew')
                            digest.update(block); sink(block)
                    target.create(path, copy)
                if count != member.size:
                    raise ValueError('transport-member-truncated')
                retained += count
                files.append({'path': path, 'bytes': count, 'sha256': digest.hexdigest()})
        # Consume bounded trailing tar padding so the Docker producer can exit.
        while reader.read(64 * 1024):
            pass
        target.check()
    return {'version': 1, 'section': section, 'retainedBytes': retained,
            'scannedPayloadBytes': scanned, 'streamBytes': reader.count,
            'omittedFiles': omitted, 'files': files, 'unknownRunResidue': bool(unknown_runs),
            'unknownRunExamples': unknown_runs}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--container', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'[0-9a-f]{64}', args.container):
        raise ValueError('transport-container-id')
    args.output.mkdir(mode=0o700)
    def timeout(*unused):
        raise RuntimeError('transport-timeout')
    signal.signal(signal.SIGALRM, timeout)
    signal.alarm(180)
    receipts = []; remaining = LIMIT
    try:
        for section, source in (('evidence', '/owned/evidence/.'), ('runs', '/owned/source/.test-resources/runs/.')):
            process = subprocess.Popen(['docker', 'cp', args.container + ':' + source, '-'],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                receipt = receive_archive(process.stdout, args.output, section, remaining)
                remaining -= receipt['scannedPayloadBytes']
                if process.wait(timeout=15) != 0 or process.stderr.read(64 * 1024 + 1):
                    raise ValueError('transport-docker-copy-failed')
                receipts.append(receipt)
            finally:
                if process.poll() is None:
                    process.terminate()
                    try: process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill(); process.wait(timeout=5)
                process.stdout.close(); process.stderr.close()
    finally:
        signal.alarm(0)
    with (args.output/'transport.json').open('x') as stream:
        json.dump({'version': 1, 'container': args.container, 'sections': receipts}, stream, indent=2)
        stream.write('\n')


if __name__ == '__main__':
    main()
