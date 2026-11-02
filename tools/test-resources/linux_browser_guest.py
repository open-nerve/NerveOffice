"""固定的 Linux Chromium 小范围执行入口。"""
from pathlib import Path
import platform
import resource
import subprocess
import sys
import time

from linux_browser_evidence import installed_patches, read_json, validate_results, verify_source, write_json

GROUPS = (
    ('calibration', 1, ['security/csp.spec.ts']),
    ('stories', 13, ['editor/image-input.spec.ts', 'editor/image-policy.spec.ts',
                     'editor/links.spec.ts', 'editor/paste-images.spec.ts']),
)


def run_groups(repo, root, execute):
    for name, count, files in GROUPS:
        args = ['pnpm', '--filter', '@nerve-office/e2e', 'run', 'test', *files,
                '--project=chromium', '--workers=1', '--grep=US-M5-14']
        destination = root / 'evidence/groups' / name / 'tests/e2e'
        destination.mkdir(parents=True)
        status = execute(args)
        # The inner runner has returned. Move only its published evidence, never
        # its source/scratch/DB/profile archive. Parent checks bytes after Docker closes.
        for leaf in ('test-results', 'playwright-report'):
            source = repo / 'tests/e2e' / leaf
            if source.exists():
                if source.is_symlink():
                    raise ValueError('guest-report-link')
                source.rename(destination / leaf)
        if status != 0:
            return status
        receipt = read_json(destination / 'test-results/cleanup-receipt.json')
        if receipt.get('status') != 'passed' or receipt.get('cleanupStage') != 'complete':
            raise ValueError('guest-inner-cleanup-incomplete')
        validate_results(read_json(destination / 'test-results/results.json'), count)
    return 0


def main():
    root = Path('/owned'); repo = root / 'source'; evidence = root / 'evidence'
    evidence.mkdir(exist_ok=True)
    proof = read_json(root / 'source.json')
    versions = {'platform': platform.system(), 'machine': platform.machine(),
                'node': subprocess.check_output(['node', '--version'], text=True).strip(),
                'osRelease': Path('/etc/os-release').read_text()}
    if (versions['platform'] != 'Linux' or versions['machine'] != 'aarch64'
            or versions['node'] != 'v24.21.0' or 'VERSION_ID="24.04"' not in versions['osRelease']):
        raise ValueError('guest-platform-mismatch')
    verify_source(repo, proof)
    steps = []
    def execute(args):
        started = time.time()
        print('Linux 校准步骤：' + ' '.join(args), flush=True)
        status = subprocess.call(args, cwd=repo)
        steps.append({'command': args, 'status': status, 'seconds': time.time() - started,
                      'maxChildRssKiB': resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss})
        return status
    status = 1
    try:
        subprocess.check_call(['npm', 'install', '--global', '--prefix', '/owned/pnpm', 'pnpm@12.6.0'], cwd=repo)
        versions['pnpm'] = subprocess.check_output(['pnpm', '--version'], text=True).strip()
        if versions['pnpm'] != '12.6.0':
            raise ValueError('guest-pnpm-mismatch')
        # Source copy deliberately has no .git. This follows the existing image
        # install policy; the real host commit hooks are unaffected.
        if execute(['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts', '--store-dir', '/owned/pnpm-store']) != 0:
            return 1
        versions['playwright'] = read_json(repo / 'tests/e2e/node_modules/@playwright/test/package.json')['version']
        if versions['playwright'] != '1.63.0':
            raise ValueError('guest-playwright-mismatch')
        write_json(evidence / 'versions.json', versions)
        patches = installed_patches(repo)
        if len(patches) != 16 or patches != read_json(root / 'host-patches.json'):
            raise ValueError('guest-sdk-mismatch')
        write_json(evidence / 'patches-before.json', patches)
        for args in (['pnpm', '--filter', '@nerve-office/api...', 'run', 'build'],
                     ['pnpm', '--filter', '@nerve-office/web', 'run', 'build:e2e']):
            if execute(args) != 0:
                return 1
        write_json(evidence / 'source-before.json', verify_source(repo, proof))
        group_status = run_groups(repo, root, execute)
        write_json(evidence / 'source-after.json', verify_source(repo, proof))
        after = installed_patches(repo)
        write_json(evidence / 'patches-after.json', after)
        if after != patches:
            raise ValueError('guest-sdk-changed')
        status = group_status
        return status
    finally:
        write_json(evidence / 'execution.json', {'version': 1, 'steps': steps, 'status': status})


if __name__ == '__main__':
    sys.exit(main())
