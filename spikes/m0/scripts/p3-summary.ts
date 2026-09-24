// P3：把 V06–V10 的结果文件汇总成报告用的表格（Markdown），报告中的数字都可以用它重新得出。
// 用法：先跑完 P3 的用例，再 node scripts/p3-summary.ts [章节…]，章节为 v06 v07 v08 v09 v10，缺省为全部。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const RESULTS = join(import.meta.dirname, '..', 'e2e', 'results');
const BROWSERS = ['chromium', 'chrome', 'webkit'];

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function load(dir: string): { file: string; data: Json }[] {
    const full = join(RESULTS, dir);
    if (!existsSync(full)) return [];
    return readdirSync(full)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => ({ file: f, data: JSON.parse(readFileSync(join(full, f), 'utf8')) as Json }));
}

const browserOf = (file: string) => BROWSERS.find((b) => file.startsWith(`${b}-`)) ?? '?';
const r0 = (x: number | null | undefined) => (x == null || Number.isNaN(x) ? '—' : String(Math.round(x)));
const r1 = (x: number | null | undefined) => (x == null || Number.isNaN(x) ? '—' : x.toFixed(1));
const kib = (x: number) => `${(x / 1024).toFixed(0)} KiB`;
const table = (head: string[], rows: string[][]) =>
    [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');

function v06(): string {
    const out: string[] = ['## V06 变更检测'];
    const open = load('v06/open-quiet');
    const byBrowser = BROWSERS.map((b) => {
        const list = open.filter((x) => browserOf(x.file) === b).map((x) => x.data);
        const muts = new Set(list.flatMap((d) => d.mutations.map((m: Json) => `${m.id}（${m.verdict}）`)));
        return [
            b,
            String(list.length),
            String(list.reduce((n, d) => n + d.detections.length, 0)),
            String(list.reduce((n, d) => n + d.lateDiff.length, 0)),
            String(list.reduce((n, d) => n + d.syncOnly.length, 0)),
            [...muts].join('；') || '—',
        ];
    });
    out.push('### 打开静默', table(['浏览器', '用例', '检测到修改', '迟到的内容变化', 'syncOnly', '出现过的非本地 mutation（判定）'], byBrowser));
    const openDiff = new Map<string, string>();
    for (const x of open) if (x.data.openDiffCount > 0) openDiff.set(`${x.data.kind}-${x.data.sample}${x.data.worker ? '（Worker）' : ''}`, `${x.data.openDiffCount}：${x.data.openDiff.slice(0, 3).map((d: Json) => d.path).join('，')}`);
    out.push('打开后与原快照不同（没有 mutation）的样本（任一浏览器）：', table(['样本', '差异数：示例路径'], [...openDiff].map(([k, v]) => [k, v])));

    const actions = load('v06/actions');
    const ids = [...new Set(actions.map((x) => `${x.data.kind}-${x.data.action}`))];
    const rows = ids.map((id) => {
        const cells = BROWSERS.map((b) => actions.find((x) => browserOf(x.file) === b && `${x.data.kind}-${x.data.action}` === id)?.data);
        const any = cells.find((c) => c != null)!;
        const dets = [...new Set(cells.flatMap((c) => c?.during.detections ?? []))];
        return [id, any.method, any.expect === 'change' ? '改内容' : '只改视图', ...cells.map((c) => c?.verdict ?? '—'), dets.join('、') || '—'];
    });
    out.push('### 动作矩阵', table(['动作', '方式', '预期', ...BROWSERS, '检测到的 mutation'], rows));
    const plan = actions.filter((x) => x.data.planRule != null).map((x) => [x.file.replace('.json', ''), r0(x.data.planRule.captureAtMs), r0(x.data.planRule.lastAutoHeightMs), String(x.data.planRule.autoHeightMutations), String(x.data.planRule.missed)]);
    out.push('按 00 号计划书 §7.3（排除自动行高）推演的捕获时机：', table(['用例', '捕获时刻 ms', '最后一条行高 ms', '行高 mutation', '捕获后才到达'], plan));

    const copy = load('v06/large-copy');
    out.push('### 大表复制', table(
        ['浏览器', '样本', '配置', '同步复制 ms', '立即捕获', 'S1', '原表', '本地 mutation 最后 ms', '捕获时刻 ms', '懒执行期间最长阻塞 ms', '复制品公式', '删除前后撤销数'],
        copy.map((x) => {
            const d = x.data;
            return [browserOf(x.file), d.sample, d.config.id, r0(d.copy.syncMs), String(d.copiedCellsImmediately), String(d.copiedCellsAtS1), String(d.sourceCells), r0(d.localMutations.lastMs), r0(d.capturedAfterMs), r0(d.copy.idleMaxGapMs), d.formulaInCopyMatches ? '一致' : '不一致', `${d.removal.undoBefore.undos}→${d.removal.undoAfterRemove.undos}`];
        }),
    ));
    return out.join('\n\n');
}

function v07(): string {
    const out: string[] = ['## V07 公式一致性'];
    const list = load('v07');
    const kinds = ['noWait', 'waited', 'platform', 'timedOut', 'recapture', 'recapturePlatform', 'reopened', 'forced'];
    out.push(table(
        ['浏览器', '场景', 'Worker', ...kinds, '起始等待 ms', '等待 ms', '超时尝试'],
        list.map((x) => {
            const d = x.data;
            return [browserOf(x.file), d.scenario, d.worker ? '是' : '否', ...kinds.map((k) => `${d.checks[k].mismatches}/${d.checks[k].checked}`), r0(d.idleWaitMs), r0(d.waitMs.waited), d.timeoutOutcome];
        }),
    ));
    return out.join('\n\n');
}

function stat(s: Json | null | undefined, digits = 0): string {
    if (s == null) return '—';
    const f = digits === 0 ? r0 : r1;
    return `${f(s.p50)} / ${f(s.p95)}`;
}

function v08(): string {
    const out: string[] = ['## V08 捕获成本（p50 / p95，毫秒）'];
    const list = load('v08/capture');
    out.push(table(
        ['浏览器', '样本', 'JSON', 'gzip', '压缩率', 'save()', '序列化', '同步段', 'gzip', 'SHA-256', '合计', '异步段最长阻塞', '最长长任务', '打开自检', '端到端'],
        list.map((x) => {
            const d = x.data;
            const c = d.capture;
            return [browserOf(x.file), `${d.kind}-${d.sample}`, kib(c.jsonBytes), kib(c.gzipBytes), `${(c.ratio * 100).toFixed(1)}%`, stat(c.saveMs, 1), stat(c.stringifyMs, 1), stat(c.syncMs, 1), stat(c.gzipMs, 1), stat(c.hashMs, 1), stat(c.totalMs), stat(c.asyncMaxGapMs), stat(c.longestTaskMs), stat(d.selfCheckMs, 1), stat(d.endToEndMs)];
        }),
    ));
    const guard = load('v08/guard-overhead');
    out.push('资源加载错误捕获的开销（到 Rendered，p50 / p95）：', table(
        ['浏览器', '样本', '不开', '开'],
        guard.map((x) => [browserOf(x.file), x.data.sample, stat(x.data.renderedMs.off), stat(x.data.renderedMs.on)]),
    ));
    return out.join('\n\n');
}

function v09(): string {
    const out: string[] = ['## V09 阅读模式'];
    const entries = load('v09/entries');
    out.push(table(
        ['浏览器', '文档', '方案', '拦截', '未拦截-被检测到', '未拦截-未检测到', '进入时的检测', '非空的保护类资源', '拦截时的页面错误'],
        entries.map((x) => {
            const d = x.data;
            const errs = d.entries.filter((e: Json) => (e.pageErrors ?? []).length > 0).map((e: Json) => e.entry);
            return [browserOf(x.file), d.kind, d.strategy, String(d.summary.blocked.length), d.summary.detected.join('、') || '—', d.summary.undetected.join('、') || '—', String(d.traces.detections.length), d.traces.protectionResources.join('、') || '—', errs.join('、') || '—'];
        }),
    ));
    const undo = load('v09/undo-redo');
    out.push('撤销重做（编辑模式下先产生一条记录，再原地进入阅读模式、不清空撤销栈）：', table(
        ['浏览器', '文档', '方案', '撤销改了内容', '重做改了内容'],
        undo.flatMap((x) => x.data.results.map((r: Json) => [browserOf(x.file), x.data.kind, r.strategy, r.undoChanged ? '是' : '否', r.redoChanged ? '是' : '否'])),
    ));
    const sw = load('v09/switch');
    out.push('模式切换：', table(
        ['浏览器', '文档', '方式', '耗时 ms', '退出后残留', '非空的保护类资源', '退出后可编辑'],
        sw.flatMap((x) => [
            ...x.data.inPlace.map((r: Json) => [browserOf(x.file), x.data.kind, `原地：${r.strategy}`, r0(r.ms), String(r.leftover.length), r.protectionResourcesAfter.join('、') || '—', r.editableAfterExit ? '是' : '否']),
            [browserOf(x.file), x.data.kind, '销毁重建：进入阅读 / 回到编辑（到 Rendered）', `${r0(x.data.remount.toReadRenderedMs)} / ${r0(x.data.remount.toEditRenderedMs)}`, String(x.data.remount.leftover.length), '—', '是'],
        ]),
    ));
    const menus = load('v09/menus');
    out.push('入口隐藏：', table(
        ['浏览器', '编辑：应隐藏而可见', '编辑：工具栏按钮 / 右键菜单', '阅读：应隐藏而可见', '阅读：工具栏按钮 / 右键菜单'],
        menus.map((x) => [browserOf(x.file), x.data.edit.visibleButShouldHide.join('、') || '无', `${x.data.edit.toolbarButtons} / ${x.data.edit.contextMenuShown ? '有' : '无'}`, x.data.read.visibleButShouldHide.join('、') || '无', `${x.data.read.toolbarButtons} / ${x.data.read.contextMenuShown ? '有' : '无'}`]),
    ));
    const identity = load('v09/identity');
    out.push('真实用户身份：', table(
        ['浏览器', '样本', '默认身份编辑 K3', '真实身份编辑 K4', '真实身份编辑 A1'],
        identity.flatMap((x) => x.data.results.map((r: Json) => [browserOf(x.file), r.sample, r.controlK3.changed ? '成功' : '失败', r.realUserK4.changed ? '成功' : '失败', r.realUserA1.changed ? '成功' : '失败'])),
    ));
    return out.join('\n\n');
}

function v10(): string {
    const out: string[] = ['## V10 性能基线（p50 / p95，毫秒）'];
    const list = load('v10');
    out.push(table(
        ['浏览器', 'Worker', '到 Rendered', '到 Steady', 'Rendered 前最长长任务', '按键到下一帧', '增量计算', '全量重算', 'JS 堆：打开后 / 50 次编辑后'],
        list.map((x) => {
            const d = x.data;
            const heap = d.heapBytes.afterOpen == null ? '无法测量' : `${(d.heapBytes.afterOpen / 1048576).toFixed(0)} / ${(d.heapBytes.afterEdits / 1048576).toFixed(0)} MiB`;
            return [browserOf(x.file), d.worker ? '是' : '否', stat(d.firstScreen.renderedMs), stat(d.firstScreen.steadyMs), stat(d.firstScreen.longestTaskBeforeRenderedMs), stat(d.keyLatencyMs, 1), stat(d.formulaMs.incremental), stat(d.formulaMs.full), heap];
        }),
    ));
    return out.join('\n\n');
}

const SECTIONS: Record<string, () => string> = { v06, v07, v08, v09, v10 };
const wanted = process.argv.slice(2).length > 0 ? process.argv.slice(2) : Object.keys(SECTIONS);
console.log(wanted.map((k) => SECTIONS[k]()).join('\n\n'));
