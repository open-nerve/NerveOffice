// P6：把 V14、V15、V16 的结果文件汇总成报告用的表格（Markdown），报告中的数字都可以用它重新得出。
// 用法：先跑完 P6 的用例，再 node scripts/p6-summary.ts [章节…]，
// 章节为 pipeline recovery e2e quota locks crash window midwrite conflict replay combined node，缺省为全部。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type Json = Record<string, any>;

const RESULTS = join(import.meta.dirname, '..', 'e2e', 'results');
const BROWSERS = ['chromium', 'chrome', 'webkit'];

function load(dir: string): { file: string; data: Json }[] {
    const full = join(RESULTS, dir);
    if (!existsSync(full)) return [];
    return readdirSync(full).filter((f) => f.endsWith('.json')).sort().map((f) => ({ file: f, data: JSON.parse(readFileSync(join(full, f), 'utf8')) as Json }));
}

const browserOf = (file: string) => BROWSERS.find((b) => file.startsWith(`${b}-`) || file === `${b}.json`) ?? '?';
const table = (head: string[], rows: string[][]) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
const n1 = (x: number | null | undefined) => (x == null ? '—' : x < 10 ? x.toFixed(1) : String(Math.round(x)));
const pair = (s: Json | null | undefined) => (s == null ? '—' : `${n1(s.p50)} / ${n1(s.p95)}`);
const kib = (x: number) => `${Math.round(x / 1024)} KiB`;
const SAMPLE_NAMES: Record<string, string> = { 'sheet-big-1m': '表格 1 MiB', 'sheet-big-5m': '表格 5 MiB', 'doc-doc-20k': '文字 2 万字', 'doc-doc-1m': '文字 1 MiB' };

function pipeline(): string {
    const list = load('v14/pipeline');
    const rows: string[][] = [];
    for (const x of list) {
        for (const durability of ['default', 'strict']) {
            const c = x.data.capture[durability];
            if (c == null) continue;
            rows.push([browserOf(x.file), SAMPLE_NAMES[x.data.sample] ?? x.data.sample, x.data.placement, durability === 'strict' ? 'strict' : '默认', `${kib(c.jsonBytes)} → ${kib(c.gzipBytes)}`,
                pair(c.syncMs), pair(c.hashMs), pair(c.gzipMs), pair(c.encryptMs), pair(c.putMs), pair(c.totalMs), pair(c.asyncMaxGapMs), pair(c.longestTaskMs), String(c.errors)]);
        }
    }
    return ['## V14 写入管道（p50 / p95，毫秒；最长长任务只有 Chromium 内核有数据）',
        table(['浏览器', '样本', '放置', '持久性', 'JSON → gzip', '同步段（save + 序列化 + 编码）', '去重哈希', 'gzip', '加密', '写入', '合计', '异步段最长阻塞', '最长长任务', '失败'], rows)].join('\n\n');
}

function recovery(): string {
    const rows = load('v14/pipeline').filter((x) => x.data.placement === 'main').map((x) => {
        const r = x.data.recovery;
        return [browserOf(x.file), SAMPLE_NAMES[x.data.sample] ?? x.data.sample, pair(r.readMs), pair(r.decryptMs), pair(r.gunzipMs), pair(r.parseMs)];
    });
    return ['## V14 恢复路径（p50 / p95，毫秒）', table(['浏览器', '样本', '读取', '解密', '解压', '解析'], rows)].join('\n\n');
}

function e2e(): string {
    const rows = load('v14/pipeline').map((x) => [browserOf(x.file), SAMPLE_NAMES[x.data.sample] ?? x.data.sample, x.data.placement, (x.data.e2e.runs as number[]).map((v) => String(Math.round(v))).join('、'), n1(x.data.e2e.p50), n1(x.data.e2e.max)]);
    return ['## V14 端到端：最后一次修改 → 已保存在本机（毫秒，各 5 次）', table(['浏览器', '样本', '放置', '每次', 'p50', '最大'], rows)].join('\n\n');
}

function quota(): string {
    const est = load('v14/quota').filter((x) => x.file.endsWith('-estimate.json')).map((x) => [browserOf(x.file), `${(x.data.estimate.quota / 1024 ** 3).toFixed(1)} GiB`, String(x.data.persisted), String(x.data.persist)]);
    const full = load('v14/quota').filter((x) => x.file.endsWith('-full.json')).map((x) => [browserOf(x.file), `${x.data.quotaSize / 1024 / 1024} MiB`, String(x.data.writes - 1), x.data.failed?.error ?? '—', x.data.checks.failed, x.data.checks.first, `${x.data.autosave.autosave}（${x.data.autosave.lastError}）`]);
    return ['## V14 配额：估算与持久化申请', table(['浏览器', '配额估算', 'persisted()', 'persist()'], est),
        '## V14 配额：写满时（用 CDP 把配额设小）', table(['浏览器', '配额', '成功写入', '失败的错误', '失败的键', '之前的记录', '自动保存'], full)].join('\n\n');
}

function locks(): string {
    const rows = load('v14/locks').map((x) => {
        const d = x.data;
        if (d.check === 'V14-locks-steal') return [browserOf(x.file), '被抢锁', '—', '—', `A：${d.lost.state}`, `之后写入 ${d.afterWrites - d.before} 次；手动写入：${d.captureError == null ? '成功' : '被拒绝'}`];
        return [browserOf(x.file), { close: '关闭', crash: '崩溃', navigate: '导航离开' }[d.release as string] ?? d.release, `A ${d.initial.a.state}，B ${d.initial.b.state}`, String(d.bWritesWhileBusy), `${d.takeover.state}（${n1(d.takeover.ms)} ms）`, d.after.recovery?.status ?? '—'];
    });
    return ['## V14 标签页协调', table(['浏览器', '持有者释放方式', '初始状态', 'B 等锁时的写入', 'B 接手', '接手后的恢复检查'], rows)].join('\n\n');
}

function crash(): string {
    const rows = load('v14/crash').map((x) => {
        const d = x.data;
        return [browserOf(x.file), x.data.check === 'V14-crash' ? (x.file.includes('-doc') ? '文字文档' : '表格') : '?', String(d.killed), d.reopened.recovery?.status ?? '—', d.restored.m1 ? '有' : '无', d.restored.m2 ? '有' : '无', `${n1(d.timings.decryptMs)} / ${n1(d.timings.gunzipMs)} / ${n1(d.timings.parseMs)}`, String(d.seqAfter)];
    });
    return ['## V14 进程被杀之后恢复', table(['浏览器', '文档', '杀掉的进程', '重启后', '最后一次写入本机的修改', '没来得及保存的修改', '解密 / 解压 / 解析（毫秒）', '恢复后继续编号'], rows)].join('\n\n');
}

function window(): string {
    const rows = load('v14/window').flatMap((x) => (x.data.runs as Json[]).map((r) => [browserOf(x.file), String(r.edits), `${(r.editingMs / 1000).toFixed(1)} 秒`, `${r.recovered}/${r.edits}`, `${r.lossMs} ms`, r.contiguous ? '是' : '否', (r.history as Json[]).map((h) => h.trigger).join('、')]));
    return ['## V14 持续编辑时被杀：丢失窗口（每 200 ms 改一处）', table(['浏览器', '修改次数', '编辑时长', '恢复出的修改', '丢失窗口', '连续前缀', '期间的捕获'], rows)].join('\n\n');
}

function midwrite(): string {
    const rows = load('v14/midwrite').flatMap((x) => (x.data.runs as Json[]).map((r) => [browserOf(x.file), `${r.delay} ms`, String(r.first), String(r.seq), r.seq === r.first ? '旧记录' : r.seq === r.first + 1 ? '新记录' : '异常', r.status]));
    return ['## V14 写入中被杀（5 MiB 表格；延迟从第二次写入的同步段结束算起）', table(['浏览器', '杀进程的延迟', '旧记录的序号', '重启后的序号', '结果', '状态'], rows)].join('\n\n');
}

function conflict(): string {
    const rows = load('v14/conflict').map((x) => [browserOf(x.file), `${x.data.conflict.recovery.status}（本机基于 ${x.data.conflict.recovery.record.baseRevision}，服务端 ${x.data.conflict.recovery.serverRevision}）`, x.data.restoreError ?? '—', `${x.data.revoked.recovery.status}（${x.data.revoked.recovery.error}）`]);
    const users = load('v14/users').map((x) => [browserOf(x.file), x.data.other.recovery.status, x.data.same.recovery.status]);
    return ['## V14 修订号已变与密钥吊销', table(['浏览器', '修订号已变', '一键恢复', '密钥吊销后'], rows),
        '## V14 用户隔离', table(['浏览器', '另一个用户打开同一文档', '原用户再打开'], users)].join('\n\n');
}

function replay(): string {
    const rows = load('v15/replay').map((x) => {
        const d = x.data;
        return [browserOf(x.file), `${d.scenario}${d.mode === 'enrich' ? '（补全）' : ''}`, String(d.log.entries), kib(d.log.bytes), `${n1(d.log.stats.clone.totalMs)} / ${n1(d.log.stats.clone.maxMs)}`, String(d.replay.failed.length), d.strict ? '一致' : '不一致', d.resolved ? '一致' : `不一致（${d.diffCount} 处）`, String(d.danglingReplayed.length), d.known ?? '—'];
    });
    return ['## V15 重放等价', table(['浏览器', '场景', '日志条数', '日志体积', '克隆耗时合计 / 最大（毫秒）', '重放失败', '规范化内容', '样式按 id 展开后', '悬空样式引用', '已知原因'], rows)].join('\n\n');
}

function combined(): string {
    const rows = load('v15/combined').flatMap((x) => (x.data.runs as Json[]).map((r) => [browserOf(x.file), r.kind === 'sheet' ? '表格' : '文字文档', r.info, `${r.mark.logSeq}`, r.snapshotOnly.l4 ? '有' : '无', `${r.replay?.executed ?? 0} 条`, r.withLog.l4 ? '有' : '无', r.resolved ? '一致' : '不一致']));
    return ['## V15 组合恢复（快照 + 快照之后的日志）', table(['浏览器', '文档', '快照', '快照所含的日志位置', '只用快照：最后的修改', '重放日志', '加日志：最后的修改', '与被杀前比较'], rows)].join('\n\n');
}

function node(): string {
    const file = join(RESULTS, 'v16', 'node-load.json');
    if (!existsSync(file)) return '## V16 Node 加载\n\n（没有结果）';
    const d = JSON.parse(readFileSync(file, 'utf8')) as Json;
    const rows = (d.rows as Json[]).map((r) => [r.sample, r.stage, `${r.loadMs} ms`, r.vsBrowser == null ? '—' : r.vsBrowser.equal ? '一致' : `不同：${(r.vsBrowser.diffs as Json[]).map((x) => x.path.replace(/^\$\./, '')).join('；')}`, r.noCalcVsFixture.equal ? '一致' : `不同 ${r.noCalcVsFixture.diffCount} 处`, String(r.errors.length)]);
    return [`## V16 Node 加载（${d.node}，不用 happy-dom）`, table(['样本', '生命周期', '加载', '与浏览器加载再保存比较', 'NO_CALCULATION 与样本本身比较', '错误'], rows)].join('\n\n');
}

const SECTIONS: Record<string, () => string> = { pipeline, recovery, e2e, quota, locks, crash, window, midwrite, conflict, replay, combined, node };
const wanted = process.argv.slice(2);
for (const name of wanted.length > 0 ? wanted : Object.keys(SECTIONS)) {
    const fn = SECTIONS[name];
    if (fn == null) throw new Error(`没有这个章节：${name}`);
    console.log(`${fn()}\n`);
}
