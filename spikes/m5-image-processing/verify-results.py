"""Read-only evidence audit with Pillow, independently of Sharp's decoder.

Usage: python3 verify-results.py RESULT_DIR NEW_RECEIPT.json
Never overwrites source evidence or re-runs the processing experiment.
"""
from pathlib import Path
from PIL import Image
import hashlib, json, sys

root, receipt = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
assert not receipt.exists(), 'receipt already exists'
summary = json.loads((root / 'summary.json').read_text())
source = root / 'source'
digest = lambda data: hashlib.sha256(data).hexdigest()
assert summary['passed'] is True, 'experiment did not pass'
assert digest((source / 'fixtures/manifest.json').read_bytes()) == summary['manifestSha256']
assert digest((root / 'runtime-lock.yaml').read_bytes()) == summary['lockSha256']
for name, expected in summary['sources'].items():
    assert Path(name).name == name
    assert digest((source / name).read_bytes()) == expected, ('source hash', name)
manifest = json.loads((source / 'fixtures/manifest.json').read_text())
cases = {row['id']: row for row in manifest['cases']}
assert len(cases) == len(manifest['cases'])
for row in cases.values():
    assert Path(row['file']).name == row['file']
    data = (source / 'fixtures' / row['file']).read_bytes()
    assert len(data) == row['bytes'] and digest(data) == row['sha256']
small = summary.get('sampleSet', 'small' if summary['platform'] == 'darwin' else 'all') == 'small'
expected_ids = {key for key, value in cases.items() if not small or not value['large']}
assert {row['id'] for row in summary['results']} == expected_ids
assert len(summary['results']) == len(expected_ids)


def verify_image(path, row, actual):
    data = path.read_bytes()
    assert digest(data) == actual['outputSha256'], (path.name, 'output hash')
    assert 0 < len(data) == actual['outputBytes'] <= summary['limits']['outputBytes']
    assert b'NERVE_TEST_PRIVATE_METADATA' not in data
    expected = row['expected']
    with Image.open(path) as image:
        assert image.format.lower() == row['declaredType'].split('/')[1]
        assert image.size == (expected['width'], expected['height'])
        count = getattr(image, 'n_frames', 1)
        assert count == expected['frames'] == actual['frames']
        assert not image.getexif(), (path.name, 'EXIF')
        assert not any(image.info.get(key) for key in ('exif', 'icc_profile', 'xmp', 'comment'))
        delays, hashes = [], []
        for index in range(count):
            image.seek(index)
            pixels = image.convert('RGBA')
            pixels.load()
            hashes.append(digest(pixels.tobytes()))
            delays.append(image.info.get('duration', 0))
            tolerance = 25 if image.format == 'JPEG' else 15 if image.format == 'WEBP' else 0
            for point in expected['points'][index]:
                got = pixels.getpixel((point['x'], point['y']))
                assert all(abs(a - b) <= tolerance for a, b in zip(got, point['rgba'])), (path.name, index, point, got)
        if 'rgbaSha256' in expected:
            assert hashes == expected['rgbaSha256'], (path.name, 'independent lossless decode')
        if count > 1:
            assert delays == expected['delay'] == actual['delay'], (path.name, 'delay')
            assert image.info.get('loop') == expected['loop'] == actual['loop'], (path.name, 'loop')
    return {'file': path.name, 'sha256': digest(data), 'frames': count}


outputs = []
for item in summary['results']:
    assert item['passed'] is True
    row = cases[item['id']]
    record = json.loads((root / (row['id'] + '.json')).read_text())
    actual = record['actual']
    assert record['passed'] is True and record['expected'] == row['expected']
    assert record['inputSha256'] == row['sha256']
    assert actual['exitCode'] == 0 and actual.get('signal') is None and not actual.get('parentFailure')
    wire = json.loads(actual['stdout'])
    for key, value in wire.items():
        assert actual[key] == value, (row['id'], 'wire evidence', key)
    assert actual['status'] == row['expected']['status']
    path = root / (row['id'] + '.image')
    if actual['status'] == 'reject':
        assert actual['reason'] == row['expected']['reason'] and not path.exists()
    else:
        assert actual['inputSha256'] == row['sha256'] and actual['inputBytes'] == row['bytes']
        assert actual['privateMetadata'] == []
        outputs.append(verify_image(path, row, actual))

faults = ['timeout', 'crash'] + (['address-limit'] if summary['limits']['addressMiB'] else [])
assert [item['fault'] for item in summary['faults']] == faults
for fault in faults:
    record = json.loads((root / ('fault-' + fault + '.json')).read_text())
    assert record['passed'] is True
    actual = record['actual']
    if fault == 'timeout':
        assert actual['signal'] == 'SIGKILL' and actual['parentFailure'] == 'timeout'
    elif fault == 'crash':
        assert actual['exitCode'] == 17
    else:
        assert actual['exitCode'] == 0 and actual['refused'] is True
    recovery = record['recovery']
    assert recovery['exitCode'] == 0 and recovery['status'] == 'accept'
    outputs.append(verify_image(root / ('after-' + fault + '.image'), cases['minimum'], recovery))
if summary['platform'] == 'linux':
    events = dict(line.split() for line in summary['cgroup']['memory.events'].splitlines())
    assert events['oom'] == events['oom_kill'] == '0'
    assert summary['cgroup']['memory.max'] == str(512 * 1024 * 1024)
    assert summary['cgroup']['cpu.max'] == '100000 100000'
files = {}
for path in sorted(root.rglob('*')):
    if path.is_file():
        files[str(path.relative_to(root))] = digest(path.read_bytes())
report = {'passed': True, 'pillow': Image.__version__, 'verifierSha256': digest(Path(__file__).read_bytes()),
          'resultRoot': str(root), 'cases': len(expected_ids), 'faults': len(faults), 'outputs': outputs,
          'summarySha256': digest((root / 'summary.json').read_bytes()), 'files': files}
with receipt.open('x') as target:
    target.write(json.dumps(report, indent=2) + '\n')
print(json.dumps({'passed': True, 'cases': len(expected_ids), 'faults': len(faults), 'outputs': len(outputs), 'files': len(files)}))
