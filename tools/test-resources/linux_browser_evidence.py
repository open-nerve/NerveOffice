"""固定 Linux 浏览器校准的源码、SDK 和报告证据；不决定生产者已退出。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat

import report_safety
from git_repository import git
from stable_reports import _Tree


def write_json(path, value):
    with Path(path).open('x', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n'); stream.flush(); os.fsync(stream.fileno())


def read_json(path, limit=16 * 1024 ** 2):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_size > limit:
            raise ValueError('evidence-json-budget')
        data = stream.read(limit + 1)
        after = os.fstat(stream.fileno())
        if len(data) > limit or len(data) != before.st_size or (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise ValueError('evidence-json-budget')
    return json.loads(data, object_pairs_hook=report_safety._pairs, parse_constant=report_safety._constant)


def linux_profile(suite):
    if suite not in ('calibration', 'selftest'):
        raise ValueError('linux-browser-fixed-suite-only')
    profiles = read_json(Path(__file__).with_name('linux-browser-profiles.json'), limit=16 * 1024)
    if (not isinstance(profiles, dict) or set(profiles) != {'version', 'calibration', 'selftest'}
            or type(profiles['version']) is not int or profiles['version'] != 1):
        raise ValueError('linux-browser-profile-format')
    expected_names = {'calibration': ['calibration', 'stories'], 'selftest': ['selftest']}
    for name, names in expected_names.items():
        groups = profiles[name]
        if not isinstance(groups, list) or len(groups) != len(names):
            raise ValueError('linux-browser-profile-format')
        for group, expected_name in zip(groups, names):
            if (not isinstance(group, dict) or set(group) != {'name', 'count', 'args'}
                    or group['name'] != expected_name or type(group['count']) is not int
                    or not 1 <= group['count'] <= 29 or not isinstance(group['args'], list)
                    or not 1 <= len(group['args']) <= 16
                    or any(not isinstance(arg, str) or not arg for arg in group['args'])):
                raise ValueError('linux-browser-profile-format')
    return profiles[suite]


def group_command(group):
    return ['pnpm', '--filter', '@nerve-office/e2e', 'run', 'test', *group['args']]


def safe_path(root, name):
    if not isinstance(name, str) or not name or name.startswith('/') or '\\' in name:
        raise ValueError('source-path')
    parts = name.split('/')
    if any(part in ('', '.', '..') for part in parts):
        raise ValueError('source-path')
    path = Path(root)
    for part in parts:
        path = path / part
        if path.is_symlink():
            raise ValueError('source-mode')
    return path


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def link_target(entry, entries):
    link = entry['link']
    if not isinstance(link, str) or not link or link.startswith('/') or '\\' in link:
        raise ValueError('source-mode')
    target = os.path.normpath(str(Path(entry['path']).parent / link))
    if target not in entries or 'link' in entries[target]:
        raise ValueError('source-mode')
    return target


def snapshot_source(repo, destination, manifest):
    repo, destination = Path(repo).resolve(), Path(destination)
    if git(repo, 'status', '--porcelain', '--untracked-files=normal').strip():
        raise ValueError('source-dirty')
    head = git(repo, 'rev-parse', 'HEAD').decode().strip()
    entries = []
    for record in git(repo, 'ls-tree', '-r', '-z', 'HEAD').split(b'\0'):
        if not record:
            continue
        metadata, name = record.split(b'\t', 1)
        mode, kind, blob = metadata.decode().split()
        if mode not in ('100644', '100755', '120000') or kind != 'blob':
            raise ValueError('source-mode')
        name = name.decode('utf-8')
        link = {}
        if mode == '120000':
            parent = str(Path(name).parent)
            source = (repo if parent == '.' else safe_path(repo, parent)) / Path(name).name
            if not source.is_symlink():
                raise ValueError('source-mode')
            link = {'link': os.readlink(source)}
            raw = link['link'].encode('utf-8')
        else:
            source = safe_path(repo, name)
            if not source.is_file() or source.stat().st_size > 64 * 1024 ** 2:
                raise ValueError('source-size')
            raw = source.read_bytes()
        if hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest() != blob:
            raise ValueError('source-bytes')
        entries.append({'path': name, 'mode': int(mode, 8) & 0o777, **link,
                        'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()})
    if not entries or len(entries) > 20000 or sum(item['bytes'] for item in entries) > 256 * 1024 ** 2:
        raise ValueError('source-budget')
    by_path = {entry['path']: entry for entry in entries}
    for entry in entries:
        if 'link' in entry:
            link_target(entry, by_path)
    destination.mkdir(mode=0o700)
    for entry in entries:
        target = destination / entry['path']; target.parent.mkdir(parents=True, exist_ok=True)
        if 'link' in entry:
            target.symlink_to(entry['link'])
        else:
            with target.open('xb') as stream:
                stream.write(safe_path(repo, entry['path']).read_bytes())
            target.chmod(entry['mode'])
    proof = {'version': 1, 'head': head, 'files': entries}
    verify_source(destination, proof); verify_source(repo, proof)
    if git(repo, 'rev-parse', 'HEAD').decode().strip() != head or git(repo, 'status', '--porcelain').strip():
        raise ValueError('source-changed')
    write_json(manifest, proof)
    return proof


def verify_source(repo, proof):
    if proof.get('version') != 1 or not proof.get('files'):
        raise ValueError('source-manifest')
    names = set(); by_path = {entry['path']: entry for entry in proof['files']}
    for entry in proof['files']:
        if 'link' in entry:
            target = link_target(entry, by_path)
            parent = str(Path(entry['path']).parent)
            path = (Path(repo) if parent == '.' else safe_path(repo, parent)) / Path(entry['path']).name
            if not path.is_symlink() or os.readlink(path) != entry['link']:
                raise ValueError('source-bytes')
            if not safe_path(repo, target).is_file():
                raise ValueError('source-mode')
            raw = entry['link'].encode('utf-8')
            if len(raw) != entry['bytes'] or hashlib.sha256(raw).hexdigest() != entry['sha256']:
                raise ValueError('source-bytes')
            names.add(entry['path']); continue
        path = safe_path(repo, entry['path'])
        if entry['path'] in names or not path.is_file():
            raise ValueError('source-mode')
        names.add(entry['path'])
        if (path.stat().st_size != entry['bytes'] or stat.S_IMODE(path.stat().st_mode) != entry['mode']
                or sha(path) != entry['sha256']):
            raise ValueError('source-bytes')
    return {'head': proof['head'], 'files': len(names), 'verified': True}


def installed_patches(repo):
    repo = Path(repo); result = {}; patches = set()
    for manifest in sorted((repo / 'patches').glob('*.json')):
        data = read_json(manifest)
        for item in data.get('packages', [data]):
            name = item['package']
            if name in result or not re.fullmatch(r'@[\w-]+/[\w-]+', name):
                raise ValueError('patch-package')
            patch = safe_path(repo, item['patch'])
            if sha(patch) != item['patchSha256']:
                raise ValueError('patch-source-bytes')
            installed = repo / 'apps/web/node_modules' / name
            if read_json(installed / 'package.json')['version'] != item['version']:
                raise ValueError('patch-version')
            paths = re.findall(r'^\+\+\+ b/(.+)$', patch.read_text(), re.MULTILINE)
            if not paths or len(paths) != len(set(paths)):
                raise ValueError('patch-paths')
            files = {path: sha(safe_path(installed.resolve(), path)) for path in paths}
            expected = ({entry['path']: entry['patchedSha256'] for entry in item['files']}
                        if 'files' in item else {item['entry']: item['patchedEsSha256']})
            if any(files.get(path) != value for path, value in expected.items()):
                raise ValueError('patch-installed-bytes')
            if 'files' in item and set(files) != set(expected):
                raise ValueError('patch-file-set')
            patches.add(item['patch'])
            result[name] = {'version': item['version'], 'patch': item['patch'],
                            'patchSha256': item['patchSha256'], 'files': files}
    if not result or patches != {str(path.relative_to(repo)) for path in (repo / 'patches').glob('*.patch')}:
        raise ValueError('patch-set')
    return result


def validate_results(value, count):
    report_safety._configuration(json.dumps(value))
    stats = value.get('stats', {})
    if value.get('errors') or stats.get('expected') != count or any(stats.get(key) != 0 for key in ('unexpected', 'flaky', 'skipped')):
        raise ValueError('test-results-count')
    tests = []
    def visit(suites):
        for suite in suites:
            for spec in suite.get('specs', []):
                if spec.get('ok') is not True:
                    raise ValueError('test-results-spec')
                tests.extend(spec.get('tests', []))
            visit(suite.get('suites', []))
    visit(value.get('suites', []))
    if len(tests) != count:
        raise ValueError('test-results-count')
    for test in tests:
        results = test.get('results', [])
        if (test.get('projectName') != 'chromium' or test.get('expectedStatus') != 'passed'
                or test.get('status') != 'expected' or len(results) != 1
                or results[0].get('status') != 'passed' or results[0].get('retry') != 0):
            raise ValueError('test-results-outcome')
    return count


def collect_group(source, destination, run_id, count, budget=5 * 1024 ** 3, require_pass=True):
    source, destination = Path(source), Path(destination)
    # Caller proves all container writers gone. Copy only published reports;
    # never assign GitHub's host-disposal-pending semantics to this strict run.
    for leaf in ('test-results', 'playwright-report'):
        report_safety.check_leaf(source / 'tests/e2e' / leaf, leaf)
    entries = []; total = 0
    with _Tree(source) as tree:
        def visit(relative, target):
            nonlocal total
            for name in tree.names(relative, observe=True, limit=100000):
                path = relative + '/' + name; output = target + '/' + name
                parts = output.split('/')
                if 'persistent-profiles' in parts:
                    index = parts.index('persistent-profiles')
                    if len(parts) > index + 2 and parts[index + 2] not in ('resource-owner.json', 'retention.json', 'opfs-archive'):
                        continue
                info = tree.info(path)
                if stat.S_ISDIR(info.st_mode):
                    visit(path, output)
                elif stat.S_ISREG(info.st_mode):
                    size, digest, unused, unused_data = tree.read(path, limit=5 * 1024 ** 3)
                    total += size
                    if len(entries) >= 100000 or total > budget:
                        raise ValueError('report-budget')
                    entries.append({'source': path, 'path': output, 'bytes': size, 'sha256': digest})
                else:
                    raise ValueError('report-file-type')
        for leaf in ('test-results', 'playwright-report'):
            visit('tests/e2e/' + leaf, leaf)
        receipt = {'version': 1, 'runId': run_id, 'bytes': total, 'files': entries}
        if destination.exists():
            if read_json(destination / 'linux-export.json') != receipt:
                raise ValueError('report-export-changed')
            with _Tree(destination) as existing:
                for entry in entries:
                    size, digest, unused, unused_data = existing.read(entry['path'])
                    if (size, digest) != (entry['bytes'], entry['sha256']):
                        raise ValueError('report-export-changed')
                existing.check()
        else:
            destination.mkdir(mode=0o700)
            with _Tree(destination) as target:
                for entry in entries:
                    target.mkdirs(str(Path(entry['path']).parent))
                    target.create(entry['path'], lambda sink, entry=entry: tree.read(entry['source'], sink=sink, limit=5 * 1024 ** 3))
                target.check()
            tree.check()
            write_json(destination / 'linux-export.json', receipt)
        tree.check()
    for leaf in ('test-results', 'playwright-report'):
        report_safety.check_leaf(destination / leaf, leaf)
    with _Tree(destination / 'test-results') as tree:
        value, unused_sha, unused_identity = tree.json('results.json', limit=report_safety.MAX_JSON_BYTES)
        tree.check()
    if require_pass:
        validate_results(value, count)
    if not (destination / 'playwright-report/index.html').is_file():
        raise ValueError('test-results-html-missing')
    return receipt


def validate_guest_evidence(root, suite='calibration'):
    root = Path(root)
    def evidence(name):
        return read_json(safe_path(root, 'evidence/' + name))
    source = read_json(safe_path(root, 'source.json'))
    expected = {'head': source['head'], 'files': len(source['files']), 'verified': True}
    if evidence('source-before.json') != expected or evidence('source-after.json') != expected:
        raise ValueError('guest-source-proof')
    host = read_json(safe_path(root, 'host-patches.json'))
    if len(host) != 16 or evidence('patches-before.json') != host or evidence('patches-after.json') != host:
        raise ValueError('guest-sdk-proof')
    versions = evidence('versions.json')
    expected_versions = {'platform': 'Linux', 'machine': 'aarch64', 'node': 'v24.21.0', 'pnpm': '12.6.0', 'playwright': '1.63.0'}
    if any(versions.get(key) != value for key, value in expected_versions.items()) or 'VERSION_ID="24.04"' not in versions.get('osRelease', ''):
        raise ValueError('guest-version-proof')
    for phase in ('before-install', 'after-pnpm'):
        if evidence('preflight-' + phase + '.json') != {'version': 1, 'phase': phase, 'completeQueryPassed': True}:
            raise ValueError('guest-preflight-proof')
    execution = evidence('execution.json')
    expected_commands = [
        ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts', '--store-dir', '/owned/pnpm-store'],
        ['pnpm', '--filter', '@nerve-office/api...', 'run', 'build'],
        ['pnpm', '--filter', '@nerve-office/web', 'run', 'build:e2e'],
        *[group_command(group) for group in linux_profile(suite)],
    ]
    steps = execution.get('steps', [])
    if (execution.get('version') != 1 or execution.get('suite') != suite or execution.get('status') != 0
            or not isinstance(steps, list) or any(not isinstance(step, dict) or step.get('status') != 0 for step in steps)
            or [step.get('command') for step in steps] != expected_commands):
        raise ValueError('guest-execution-proof')
    return {'head': source['head'], 'suite': suite, 'patchPackages': len(host), 'verified': True}


def export_inner_run(directory, output, budget):
    entries = []; total = 0
    with _Tree(directory) as source, _Tree(output) as target:
        for name in ('run.json', 'command.log', 'reports/command.log', 'reports/temporary-inventory.json'):
            if not source.exists(name):
                continue
            size, digest, unused, unused_data = source.read(name, limit=4 * 1024 ** 2)
            total += size
            if total > budget:
                raise ValueError('inner-ledger-export-budget')
            path = 'inner-runs/' + directory.name + '/' + name
            target.mkdirs(str(Path(path).parent))
            try:
                target.info(path)
                exists = True
            except FileNotFoundError:
                exists = False
            if exists:
                copied, checksum, unused, unused_data = target.read(path, limit=4 * 1024 ** 2)
                if (copied, checksum) != (size, digest):
                    raise ValueError('inner-ledger-export-changed')
            else:
                target.create(path, lambda sink, name=name: source.read(name, sink=sink, limit=4 * 1024 ** 2))
            entries.append({'path': path, 'bytes': size, 'sha256': digest})
        source.check(); target.check()
    return {'runId': directory.name, 'bytes': total, 'files': entries}


def report_bytes(root, limit=5 * 1024 ** 3):
    total = entries = 0
    with _Tree(root) as tree:
        def visit(relative):
            nonlocal total, entries
            for name in tree.names(relative, observe=True):
                entries += 1
                if entries > 100000:
                    raise ValueError('report-entry-budget')
                path = relative + '/' + name if relative else name
                info = tree.info(path)
                if stat.S_ISDIR(info.st_mode):
                    visit(path)
                elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                    total += info.st_size
                    if total > limit:
                        raise ValueError('report-total-budget')
                else:
                    raise ValueError('report-file-type')
        visit(''); tree.check()
    return total


def collect_all(root, output, suite='calibration'):
    root, output = Path(root), Path(output)
    groups = []; errors = []; exported_ids = set(); safe = True
    inner_exports = []; inner_remaining = 16 * 1024 ** 2
    profile = linux_profile(suite)
    group_root = safe_path(root, 'evidence/groups')
    if group_root.exists():
        expected_names = {group['name'] for group in profile}
        for child in group_root.iterdir():
            if child.name not in expected_names or child.is_symlink() or not child.is_dir():
                safe = False; errors.append('unexpected-group')
    transport = root / 'transport.json'
    if transport.exists() or transport.is_symlink():
        try:
            transfer = read_json(transport)
            sections = transfer['sections']
            if (transfer.get('version') != 1 or transfer.get('suite') != suite or len(sections) != 2
                    or [part['section'] for part in sections] != ['evidence', 'runs']
                    or sections[1].get('unknownRunResidue') is not False):
                raise ValueError('inner-run-residue')
        except (OSError, ValueError, KeyError, TypeError):
            safe = False; errors.append('inner-original-requires-retention')
    remaining = 5 * 1024 ** 3 - 64 * 1024 ** 2 - inner_remaining - report_bytes(output)
    if remaining <= 0:
        raise ValueError('report-total-budget')
    for definition in profile:
        name, count = definition['name'], definition['count']
        group = safe_path(root, 'evidence/groups/' + name)
        if not group.is_dir():
            errors.append(name + '-missing'); continue
        try:
            receipt = read_json(safe_path(group, 'tests/e2e/test-results/cleanup-receipt.json'))
            inner_id = receipt['runId']
            if not isinstance(inner_id, str) or inner_id in exported_ids:
                raise ValueError('inner-run-identity')
            export = collect_group(group, output / name, inner_id, count, remaining, require_pass=False)
            remaining -= export['bytes']; exported_ids.add(inner_id)
            groups.append({'group': name, 'runId': inner_id, 'export': {
                'bytes': export['bytes'], 'files': len(export['files']),
                'manifestSha256': sha(output / name / 'linux-export.json')}})
            if receipt.get('cleanupStage') != 'complete':
                safe = False; errors.append(name + '-inner-cleanup')
            try:
                validate_results(read_json(output / name / 'test-results/results.json'), count)
                if receipt.get('status') != 'passed':
                    raise ValueError('inner-not-passed')
            except ValueError:
                errors.append(name + '-product-failed')
        except (OSError, ValueError, KeyError):
            safe = False; errors.append(name + '-export-rejected'); break
    # Detect raw/unpublished reports and interrupted inner runs, including those
    # the guest never moved into groups. A persistent parent hold protects them.
    runs = safe_path(root, 'source/.test-resources/runs')
    seen = set()
    if runs.exists():
        for directory in runs.iterdir():
            try:
                if directory.is_symlink() or not directory.is_dir():
                    raise ValueError('inner-run-path')
                run = read_json(directory / 'run.json')
                if (run['runId'] != directory.name or run['runId'] not in exported_ids
                        or run.get('cleanupStage') != 'complete' or run.get('publicationComplete') is not True
                        or (directory / 'scratch').exists()):
                    raise ValueError('inner-run-not-exported')
                export = export_inner_run(directory, output, inner_remaining)
                inner_remaining -= export['bytes']; inner_exports.append(export)
                seen.add(run['runId'])
            except (OSError, ValueError, KeyError):
                safe = False; errors.append('inner-original-requires-retention')
    if seen != exported_ids:
        safe = False; errors.append('inner-run-ledger-missing')
    report_bytes(output, limit=5 * 1024 ** 3 - 64 * 1024 ** 2)
    if not errors:
        try:
            validate_guest_evidence(root, suite)
        except (OSError, ValueError, KeyError):
            errors.append('guest-proof-incomplete')
    return {'version': 1, 'suite': suite, 'safeToRelease': safe, 'passed': not errors, 'groups': groups, 'innerRunExports': inner_exports, 'errors': errors}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('snapshot', 'verify', 'patches', 'collect'))
    parser.add_argument('--repo', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--manifest', type=Path)
    parser.add_argument('--run-id')
    parser.add_argument('--suite', choices=('calibration', 'selftest'), default='calibration')
    args = parser.parse_args()
    if args.action == 'snapshot':
        snapshot_source(args.repo, args.output, args.manifest)
    elif args.action == 'verify':
        write_json(args.output, verify_source(args.repo, read_json(args.manifest)))
    elif args.action == 'patches':
        write_json(args.output, installed_patches(args.repo))
    else:
        summary = collect_all(args.repo, args.output, args.suite)
        write_json(args.output / 'groups.json', summary)
        if not summary['passed']:
            raise ValueError('linux-browser-evidence-incomplete')


if __name__ == '__main__':
    main()
