"""Bounded local gate archives. Existing unregistered evidence is never adopted."""
import argparse
import json
from pathlib import Path
import re
import time
import uuid
from lifecycle import GIB, atomic_bytes, atomic_json, byte_size, contained, group_alive, locked, open_paths, read_json, remove

BULK = ('output', 'prior-output', 'command.log')

class Archives:
    def __init__(self, root, cap=5 * GIB):
        self.root = Path(root).absolute()
        if self.root.resolve() != self.root:
            raise ValueError('归档根不得经过链接')
        self.root.mkdir(parents=True, exist_ok=True)
        self.cap = cap
        with locked(self.root / '.retention.lock'):
            marker = self.root / '.retention-policy.json'
            if not marker.exists():
                atomic_json(marker, {'version': 1, 'purpose': 'nerve-test-archives', 'root': str(self.root), 'owner': str(uuid.uuid4())})
            if marker.is_symlink():
                raise ValueError('归档策略不得是链接')
            value = read_json(marker)
            if value.get('version') != 1 or value.get('purpose') != 'nerve-test-archives' or value.get('root') != str(self.root):
                raise ValueError('归档根归属不符')
            self.owner = value['owner']

    def record(self, bundle):
        contained(bundle, self.root)
        if bundle.parent != self.root or bundle.is_symlink():
            raise ValueError('归档路径不符')
        marker = bundle / '.test-archive.json'
        if marker.is_symlink():
            raise ValueError('归档记录不得是链接')
        value = read_json(marker)
        if value.get('owner') != self.owner or value.get('bundle') != bundle.name:
            raise ValueError('归档归属不符')
        return value

    def create(self, name):
        if re.fullmatch('[a-zA-Z0-9-]+', name) is None:
            raise ValueError('归档名称无效')
        bundle = self.root / name
        bundle.mkdir(mode=0o700)
        lease = locked(bundle / '.run.lock', blocking=False); lease.__enter__()
        atomic_json(bundle / '.test-archive.json', {'version': 1, 'owner': self.owner,
                    'bundle': name, 'startedAt': time.time(), 'status': 'running'})
        return bundle, lease

    def seal(self, bundle):
        value = self.record(bundle)
        value.update(status='sealed', endedAt=time.time())
        atomic_json(bundle / '.test-archive.json', value)

    def pin(self, bundle, reason):
        value = self.record(bundle)
        if value['status'] != 'sealed' or not reason:
            raise ValueError('只有结束并注明理由的最终证据可长期保留')
        value.update(status='pinned', reason=reason)
        atomic_json(bundle / '.test-archive.json', value)

    def prune(self, now=None):
        now = time.time() if now is None else now
        receipts = []
        with locked(self.root / '.retention.lock'):
            candidates = []
            for bundle in self.root.iterdir():
                if not bundle.is_dir() or bundle.is_symlink():
                    continue
                try:
                    value = self.record(bundle)
                    if value['status'] == 'pinned' or (bundle / 'retirement.json').exists():
                        continue
                    size = sum(byte_size(bundle / name) for name in BULK)
                    candidates.append((value.get('endedAt', value['startedAt']), bundle, size))
                except (OSError, ValueError, KeyError):
                    continue
            total = sum(item[2] for item in candidates)
            for ended, bundle, size in sorted(candidates):
                if not (bundle / 'retirement-pending.json').exists() and now - ended <= 14 * 86400 and total <= self.cap:
                    continue
                try:
                    with locked(bundle / '.run.lock', blocking=False):
                        value = self.record(bundle)
                        run = read_json(bundle / 'run.json') if (bundle / 'run.json').exists() else {}
                        handles = [name for name in open_paths(bundle) if name != str(bundle / '.run.lock')]
                        if group_alive(run.get('processGroupId')) or handles:
                            continue
                        inventory = [{'path': name, 'bytes': byte_size(bundle / name)} for name in BULK]
                        # Original source, patches, run summaries, catalogs and checksum indexes stay.
                        log = bundle / 'command.log'
                        if log.is_file() and not log.is_symlink():
                            with log.open('rb') as stream:
                                stream.seek(max(0, log.stat().st_size - 32768))
                                atomic_bytes(bundle / 'command-tail.log', stream.read())
                        receipt = {'at': now, 'owner': self.owner, 'bundle': bundle.name,
                                   'reason': '14-days' if now - ended > 14 * 86400 else '5-GiB-total-cap',
                                   'retired': inventory, 'sourceAndIndexesPreserved': True}
                        # Inventory precedes deletion, so an interrupted sweep is reviewable and repeatable.
                        pending = bundle / 'retirement-pending.json'
                        if pending.exists():
                            if pending.is_symlink():
                                raise ValueError('退役事务不能是链接')
                            receipt = read_json(pending)
                            if receipt.get('owner') != self.owner or receipt.get('bundle') != bundle.name or [item['path'] for item in receipt['retired']] != list(BULK):
                                raise ValueError('退役事务归属或范围不符')
                        else:
                            atomic_json(pending, receipt)
                        for name in BULK:
                            remove(bundle / name, self.root)
                        atomic_json(bundle / 'retirement.json', receipt)
                        (bundle / 'retirement-pending.json').unlink()
                        receipts.append(receipt); total -= size
                except BlockingIOError:
                    continue
        return receipts

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('--pin')
    parser.add_argument('--reason')
    args = parser.parse_args()
    archives = Archives(args.root)
    if args.pin:
        with locked(archives.root / '.retention.lock'):
            archives.pin(archives.root / args.pin, args.reason)
    else:
        print(json.dumps(archives.prune(), ensure_ascii=False))
