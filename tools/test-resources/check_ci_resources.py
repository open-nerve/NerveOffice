"""Accept portable reports on the current disposable VM; never attest final deletion."""
from contextlib import ExitStack
import copy
import json
import math
import os
from pathlib import Path
import stat
import sys

import hosted
from lifecycle import Store, Run, RUN_ID, atomic_json, locked, open_paths, read_run_manifest


FIELDS = ('version', 'runId', 'repo', 'kind', 'status', 'exitCode', 'interrupted',
          'childGroup', 'producerQuiescent', 'hostedScope', 'scopePaths', 'scopeMoves',
          'shortRoot', 'shortRootIdentity', 'shortTmp', 'shortTmpIdentity',
          'cleanupStage', 'cleanupComplete', 'stableExport', 'resourceBudget',
          'referenceObservation', 'published', 'publicationComplete', 'exportDirectory',
          'ciOwner', 'ciState', 'packagedProfiles')


def container_report(repo):
    # Match the E2E report shape without requiring a report from a build that
    # failed before Playwright started. The stable export was already verified.
    result = repo / 'tests/e2e/test-results/results.json'
    descriptor = os.open(result, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    limit = 64 * 1024 * 1024
    with os.fdopen(descriptor, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise ValueError('容器结果 JSON 不是有界普通报告')
        raw = stream.read(limit + 1)
    if len(raw) > limit:
        raise ValueError('容器结果 JSON 超过 64 MiB')
    value = json.loads(raw)
    if (type(value) is not dict or type(value.get('suites')) is not list
            or type(value.get('errors')) is not list or type(value.get('stats')) is not dict
            or any(type(value['stats'].get(key)) is not int or value['stats'][key] < 0
                   for key in ('expected', 'unexpected', 'flaky', 'skipped'))):
        raise ValueError('容器结果 JSON 结构不完整')
    html = repo / 'tests/e2e/playwright-report/index.html'
    descriptor = os.open(html, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_size == 0:
            raise ValueError('容器缺少完整的 HTML 报告')
    finally:
        os.close(descriptor)


def coverage_report(results):
    # verify_export has already checked that both paths are listed and immutable.
    coverage = results / 'coverage'
    summary = coverage / 'coverage-summary.json'
    html = coverage / 'index.html'
    if not summary.is_file() or not html.is_file() or html.stat().st_size == 0:
        raise ValueError('本轮覆盖率缺少 JSON 或 HTML 报告')
    descriptor = os.open(summary, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError('覆盖率摘要必须是普通文件')
        raw = stream.read(16 * 1024 * 1024 + 1)
    if len(raw) > 16 * 1024 * 1024:
        raise ValueError('覆盖率摘要超过元数据限制')
    value = json.loads(raw)
    total = value.get('total') if type(value) is dict else None
    if type(total) is not dict:
        raise ValueError('覆盖率摘要缺少 total')
    for name in ('lines', 'statements', 'functions', 'branches'):
        metric = total.get(name)
        if (type(metric) is not dict
                or any(type(metric.get(key)) is not int or metric[key] < 0 for key in ('total', 'covered', 'skipped'))
                or metric['covered'] > metric['total']
                or type(metric.get('pct')) not in (int, float) or not math.isfinite(metric['pct'])
                or not 0 <= metric['pct'] <= 100):
            raise ValueError('覆盖率摘要指标格式不完整')


def check(repo):
    repo = Path(repo).absolute()
    context = hosted.context(repo)
    if context is None:
        raise ValueError('CI 资源核验必须使用显式托管 VM 策略')
    marker = repo / '.test-resources/owner.json'
    if not marker.is_file() or marker.is_symlink():
        raise ValueError('缺少本轮资源登记，不能创建台账补签')
    store = Store(repo)
    expected = {'verify': 'integration', 'e2e': 'e2e', 'container': 'container'}[context['job']]
    with ExitStack() as stack:
        stack.enter_context(locked(store.root / 'publication.lock', blocking=False))
        directories = sorted((store.root / 'runs').iterdir())
        if not 1 <= len(directories) <= 128:
            raise ValueError('本轮资源台账数量无效')
        runs = []
        for directory in directories:
            if directory.is_symlink() or not RUN_ID.fullmatch(directory.name):
                raise ValueError('本轮包含未知资源台账')
            value = Run(store, directory, existing=True)
            stack.callback(value.release)
            value.validate_hosted_completion()
            value.assert_exportable()
            value.verify_export()
            if 'packagedProfiles' in value.data:
                # The transport has a separate manifest binding. Do not accept
                # a self-declared completion flag or widen stable-report paths.
                if type(value.data['packagedProfiles']) is not dict or value.data['packagedProfiles'].get('stage') != 'complete':
                    raise ValueError('运输归档尚未完成，拒绝上传')
                from pack_ci_profiles import verify_packaged
                verify_packaged(value)
            # Published leaves no longer contain this run's transport or
            # preflight report roots. Check both, without ignoring whole PIDs.
            roots = [value.directory / 'reports'] + [store.repo / p for p in value.data.get('published', [])]
            for root in roots:
                if open_paths(root, owner=value, export_only=True):
                    raise ValueError('报告仍有已知使用者，拒绝上传')
            runs.append(value)
        primaries = [value for value in runs if value.data['kind'] == expected]
        preflights = [value for value in runs if value.data['kind'] == 'ci-preflight']
        if len(primaries) != 1 or len(preflights) != 1 or len(runs) != 2:
            raise ValueError('资源合同必须恰好关联本 job 的预检与主测试')
        primary = primaries[0]
        if preflights[0].data['status'] != 'passed':
            raise ValueError('预检失败不能由后续报告替代')
        if expected in ('e2e', 'container'):
            required = {'tests/e2e/test-results', 'tests/e2e/playwright-report'}
            published = set(primary.data.get('published', []))
            failed_container = expected == 'container' and primary.data['status'] != 'passed'
            valid_leaves = (published <= required and 'tests/e2e/test-results' in published
                            if failed_container else published == required)
            if not valid_leaves or primary.data.get('publicationComplete') is not True:
                raise ValueError('主测试报告未完整发布')
            results = repo / 'tests/e2e/test-results'
            if expected == 'container' and not failed_container:
                container_report(repo)
        else:
            results = primary.directory / 'reports/portable/test-results'
            coverage_report(results)
        budget = store.hosted_budget()
        # Historical budget evidence must retain the fixed production thresholds too.
        for value in runs:
            observed = value.data.get('resourceBudget', {})
            if (observed.get('limitBytes') != hosted.RAW_LIMIT or observed.get('reserveBytes') != hosted.DISK_RESERVE
                    or any(type(observed.get(key)) is not int or observed[key] < 0
                           for key in ('bytes', 'files', 'freeBytes', 'reportBytes'))
                    or observed['bytes'] > hosted.RAW_LIMIT or observed['reportBytes'] > store.report_bytes
                    or observed['freeBytes'] < hosted.DISK_RESERVE):
                raise ValueError('资源预算证明不符')
        contract = {'version': 1, 'policy': hosted.POLICY, 'context': context,
                    'reportsVerified': True, 'cleanupComplete': False,
                    'disposalOwner': 'GitHub job VM lifecycle; final deletion not observed',
                    'budget': budget,
                    'runs': [{key: copy.deepcopy(value.data[key]) for key in FIELDS if key in value.data}
                             for value in runs]}
        if len(json.dumps(contract).encode()) > 64 * 1024:
            raise ValueError('CI 资源合同超过有界回执限制')
        receipt = results / 'cleanup-receipt.json'
        previous = read_run_manifest(receipt) if receipt.exists() else {}
        if previous and previous.get('runId') != primary.id:
            raise ValueError('资源回执属于其他运行')
        atomic_json(receipt, {**primary.data, 'ciResources': contract})
        primary.verify_export()
        final_budget = store.hosted_budget()  # Include the final receipt; avoid a self-referential receipt digest.
        return {'runId': primary.id, 'status': primary.data['status'],
                'reportsVerified': True, 'cleanupComplete': False, 'resourceRuns': len(runs),
                'finalBudget': final_budget}


def main():
    if len(sys.argv) != 1:
        raise ValueError('资源核验入口不接受额外参数')
    result = check(Path(__file__).resolve().parents[2])
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, KeyError) as error:
        print('CI 资源核验拒绝：' + str(error), file=sys.stderr)
        sys.exit(1)
