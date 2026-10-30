"""The parent owns files; the container CLI alone proves its Docker namespace absent."""
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat

FILE = 'container-resources.json'
PORTABLE = 'container-resource-ledger.json'
RECEIPT = 'container-resource-receipt.json'
MARKER = {'version': 1, 'file': FILE}
LIMIT = 64 * 1024
UUID = re.compile(r'^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$')
KINDS = ('containers', 'networks', 'volumes', 'images')
PROBLEMS = {'docker-query-failed', 'docker-daemon-changed', 'docker-namespace-invalid',
            'docker-owner-mismatch', 'docker-resources-remain', 'container-producer-not-quiescent',
            'container-resource-check-failed'}
FAILURES = {'container-stop-failed', *(kind + '-remove-failed' for kind in KINDS)}


def initial(run_id, repo, scratch):
    return {'version': 1, 'runId': run_id, 'repo': str(repo), 'scratch': str(scratch), 'state': 'unclaimed'}


def register(directory: Path, run_id: str, repo: Path, scratch: Path):
    from lifecycle import atomic_json
    if not UUID.fullmatch(run_id) or directory.resolve() != directory or directory.name != run_id:
        raise ValueError('容器预登记身份不符')
    path = directory / FILE
    if path.exists() or path.is_symlink():
        raise ValueError('容器台账已存在，拒绝覆盖')
    atomic_json(path, initial(run_id, repo, scratch))


def _pairs(items):
    value = {}
    for key, item in items:
        if key in value:
            raise ValueError('容器台账包含重复键')
        value[key] = item
    return value


def _number(raw):
    value = float(raw)
    if not math.isfinite(value):
        raise ValueError('容器台账数值无效')
    return value


def _invalid_constant(_):
    raise ValueError('容器台账不是严格 JSON')


def parse(raw):
    """Bounded strict input, also used to verify a portable payload without its source run."""
    if len(raw) > LIMIT:
        raise ValueError('容器台账超限')
    try:
        return json.loads(raw.decode('utf-8'), object_pairs_hook=_pairs,
                          parse_float=_number, parse_constant=_invalid_constant)
    except (UnicodeError, RecursionError) as error:
        raise ValueError('容器台账不是严格 JSON') from error


def _text(value):
    return isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_:./-]{1,256}', value) is not None


def _inventory(value):
    if not isinstance(value, dict) or set(value) != set(KINDS):
        return False
    return all(isinstance(items, list) and len(items) <= 64 and all(_text(item) for item in items)
               and len(items) == len(set(items)) for items in value.values())


def validate(value, run_id, repo, scratch):
    """Exact field/type allowlist. Unknown fields never enter the portable artifact."""
    base = initial(run_id, repo, scratch)
    if (not UUID.fullmatch(run_id) or not isinstance(value, dict) or type(value.get('version')) is not int
            or any(value.get(k) != v for k, v in base.items() if k != 'state')):
        raise ValueError('容器台账身份不符')
    if value == base:
        return
    required = set(base) | {'daemon', 'repoHash', 'project', 'image', 'temporaryDirectory', 'producers', 'observed'}
    optional = {'observedImageIds', 'cleanupFailures', 'problem', 'closure'}
    if not required <= set(value) or not set(value) <= required | optional:
        raise ValueError('容器台账字段不符')
    project, image = 'nerve-office-e2e-' + run_id, 'nerve-office:e2e-' + run_id
    temporary = value['temporaryDirectory']
    producers = value['producers']
    if (value['state'] not in ('reserved', 'pending', 'closed') or not isinstance(value['daemon'], str)
            or not re.fullmatch(r'[A-Za-z0-9_:.-]{1,256}', value['daemon'])
            or value['repoHash'] != hashlib.sha256(str(repo).encode()).hexdigest()
            or value['project'] != project or value['image'] != image
            or not isinstance(temporary, str) or len(temporary) > 4096 or '\x00' in temporary
            or str(Path(temporary)) != temporary or '..' in Path(temporary).parts
            or Path(scratch) / 'tmp' not in Path(temporary).parents
            or not isinstance(producers, list) or len(producers) > 1
            or not all(p is None or (type(p) is int and 0 < p <= 2**53 - 1) for p in producers)
            or not _inventory(value['observed'])):
        raise ValueError('容器台账资源字段不符')
    observed = value['observed']
    if (any(name not in (project + '_pgdata', project + '_assets') for name in observed['volumes'])
            or any(name != image for name in observed['images'])):
        raise ValueError('容器台账命名空间不符')
    images = value.get('observedImageIds', {})
    if (not isinstance(images, dict) or set(images) != set(observed['images'])
            or any(not _text(identity) for identity in images.values())):
        raise ValueError('容器镜像观测不符')
    if 'cleanupFailures' in value:
        failures = value['cleanupFailures']
        if not isinstance(failures, list) or len(failures) > 256 or any(not isinstance(x, str) or x not in FAILURES for x in failures):
            raise ValueError('容器清理结果不符')
    if 'problem' in value and (not isinstance(value['problem'], str) or value['problem'] not in PROBLEMS):
        raise ValueError('容器诊断字段不符')
    if 'closure' in value:
        closure = value['closure']
        if (not isinstance(closure, dict) or set(closure) != {'daemon', 'observedAt', 'absent'}
                or closure['daemon'] != value['daemon'] or not isinstance(closure['observedAt'], str)
                or not re.fullmatch(r'[0-9TZ:.-]{20,40}', closure['observedAt']) or not _inventory(closure['absent'])):
            raise ValueError('容器末态查询不符')


def _read_file(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > LIMIT:
            raise ValueError('容器台账不是有界普通文件')
        raw = stream.read(LIMIT + 1)
    if len(raw) > LIMIT:
        raise ValueError('容器台账超限')
    return raw


def read(directory, run_id, repo, scratch):
    if directory.resolve() != directory or directory.name != run_id:
        raise ValueError('容器台账目录身份不符')
    raw = _read_file(directory / FILE)
    value = parse(raw)
    validate(value, run_id, repo, scratch)
    return value, raw


def _assert_value_closed(value):
    if value['state'] == 'unclaimed':
        return
    if (value['state'] != 'closed' or value['producers'] != [] or value.get('cleanupFailures') != []
            or 'problem' in value or value.get('closure', {}).get('absent') != {k: [] for k in KINDS}):
        raise ValueError('本轮 Docker 资源尚未证实闭合；保留环境，禁止同类重试')


def assert_closed(directory: Path, run_id: str, repo: Path, scratch: Path):
    snapshot = read(directory, run_id, repo, scratch)
    _assert_value_closed(snapshot[0])
    return snapshot


def _receipt(snapshot):
    value, raw = snapshot
    run_id = value['runId']
    result = {'version': 1, 'runId': run_id, 'dockerClosed': False, 'diagnosticOnly': True,
              'ledgerFile': PORTABLE, 'ledgerSha256': hashlib.sha256(raw).hexdigest(),
              'state': value['state'], 'project': 'nerve-office-e2e-' + run_id,
              'image': 'nerve-office:e2e-' + run_id,
              'repoHash': hashlib.sha256(value['repo'].encode()).hexdigest()}
    result['labels'] = {'org.nerve-office.test.run': run_id, 'org.nerve-office.test.repo': result['repoHash']}
    for key in ('daemon', 'producers', 'problem', 'cleanupFailures', 'closure'):
        if key in value:
            result[key] = value[key]
    if 'observed' in value:
        result['observedCounts'] = {k: len(v) for k, v in value['observed'].items()}
    try:
        _assert_value_closed(value)
        result.update(dockerClosed=True, diagnosticOnly=False)
    except ValueError:
        pass
    return result


def _invalid_receipt(run_id):
    return {'version': 1, 'runId': run_id, 'dockerClosed': False,
            'diagnosticOnly': True, 'state': 'unreadable-or-invalid'}


def receipt(directory, run_id, repo, scratch):
    try:
        return _receipt(read(directory, run_id, repo, scratch))
    except (OSError, ValueError, RuntimeError, TypeError):
        return _invalid_receipt(run_id)


def export(directory, destination, run_id, repo, scratch, *, snapshot=None, require_closed=False):
    """Seal exact validated bytes and their summary before report relocation/checksums.

    A normal finish passes its already validated snapshot; no second source read can
    upgrade an earlier pending state. Invalid input only yields a fixed diagnostic.
    """
    from lifecycle import atomic_bytes
    try:
        snapshot = snapshot if snapshot is not None else read(directory, run_id, repo, scratch)
        if require_closed:
            _assert_value_closed(snapshot[0])
        result = _receipt(snapshot)
    except (OSError, ValueError, RuntimeError, TypeError):
        if require_closed:
            raise
        result = _invalid_receipt(run_id)
        snapshot = None
    if not require_closed:
        result['diagnosticOnly'] = True
    encoded = (json.dumps(result, ensure_ascii=False, indent=2) + '\n').encode()
    if len(encoded) > LIMIT:
        if require_closed or snapshot is None:
            raise ValueError('容器派生回执超限；保留环境')
        # The complete validated ledger remains available; never truncate its
        # closure into an apparently successful result just to fit a receipt.
        result = {'version': 1, 'runId': run_id, 'state': 'pending', 'dockerClosed': False,
                  'diagnosticOnly': True, 'problem': 'container-receipt-size-limit',
                  'ledgerFile': PORTABLE, 'ledgerSha256': hashlib.sha256(snapshot[1]).hexdigest()}
        encoded = (json.dumps(result, ensure_ascii=False, indent=2) + '\n').encode()
    if len(encoded) > LIMIT:
        raise ValueError('容器派生诊断回执超限；保留环境')
    if (destination / PORTABLE).exists() or (destination / PORTABLE).is_symlink():
        if snapshot is None or _read_file(destination / PORTABLE) != snapshot[1]:
            raise ValueError('容器便携台账已存在且不符，拒绝覆盖')
    elif snapshot is not None:
        atomic_bytes(destination / PORTABLE, snapshot[1])
    atomic_bytes(destination / RECEIPT, encoded)
    return result
