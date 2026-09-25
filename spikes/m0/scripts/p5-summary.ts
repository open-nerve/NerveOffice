// P5：把 V13 的结果文件汇总成报告用的表格（Markdown），报告中的数字都可以用它重新得出。
// 用法：先跑完 P5 的用例，再 node scripts/p5-summary.ts [章节…]，
// 章节为 capabilities variants ime anchor capture paste pasteExtra layout csp perf bundle，缺省为全部。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type Json = Record<string, any>;

const RESULTS = join(import.meta.dirname, '..', 'e2e', 'results', 'v13');
const BROWSERS = ['chromium', 'chrome', 'webkit'];

function load(dir: string): { file: string; data: Json }[] {
    const full = join(RESULTS, dir);
    if (!existsSync(full)) return [];
    return readdirSync(full).filter((f) => f.endsWith('.json')).sort().map((f) => ({ file: f, data: JSON.parse(readFileSync(join(full, f), 'utf8')) as Json }));
}

const browserOf = (file: string) => BROWSERS.find((b) => file.startsWith(`${b}-`) || file === `${b}.json`) ?? '?';
const table = (head: string[], rows: string[][]) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
function merged(values: { browser: string; value: string }[]): string {
    const distinct = [...new Set(values.map((v) => v.value))];
    if (distinct.length <= 1) return distinct[0] ?? '—';
    return values.map((v) => `${v.browser}：${v.value}`).join('；');
}
const ms = (x: number | null | undefined) => (x == null ? '—' : `${Math.round(x)}`);
const mib = (x: number | null | undefined) => (x == null ? '—' : (x / 1024 / 1024).toFixed(1));

function capabilityRows(dir: string): string[][] {
    const list = load(dir);
    const ids = [...new Set(list.map((x) => `${x.data.id}|${x.data.config}`))];
    return ids.map((key) => {
        const [id, config] = key.split('|');
        const of = list.filter((x) => x.data.id === id && x.data.config === config);
        const any = of[0].data;
        const steps = merged(of.map((x) => ({ browser: browserOf(x.file), value: `${(x.data.steps as Json[]).filter((s) => s.ok).length}/${(x.data.steps as Json[]).length}` })));
        const undo = merged(of.map((x) => ({ browser: browserOf(x.file), value: x.data.undo.count === 0 ? '—' : x.data.undo.restored && x.data.undo.redone ? '一致' : '不一致' })));
        const rt = merged(of.map((x) => ({ browser: browserOf(x.file), value: x.data.roundtrip == null ? '—' : x.data.roundtrip.secondDiff.length === 0 && x.data.roundtrip.preserved ? '一致' : '不一致' })));
        const errors = merged(of.map((x) => ({ browser: browserOf(x.file), value: `${x.data.health.errors.length} / ${x.data.health.cspEnforce.length}` })));
        return [id, any.name, config, steps, undo, rt, errors];
    });
}

function capabilities(): string {
    return ['## V13 能力矩阵（平台配置，严格 CSP）', table(['编号', '能力', '配置', '步骤通过', '撤销重做', '保存重开', '页面错误 / CSP 强制违规'], capabilityRows('capabilities'))].join('\n\n');
}

function capabilityRecords(): string {
    const list = load('capabilities');
    const rows = list.flatMap((x) => (x.data.steps as Json[]).filter((s) => String(s.step).includes('记录')).map((s) => [browserOf(x.file), x.data.id, x.data.config, s.step, JSON.stringify(s.detail)?.slice(0, 160) ?? '—']));
    return ['## V13 能力矩阵：记录项', table(['浏览器', '编号', '配置', '步骤', '结果'], rows)].join('\n\n');
}

function variants(): string {
    const parts: string[] = [];
    for (const dir of readdirSync(RESULTS).filter((d) => /^(capabilities|ime|paste)-/.test(d))) {
        const list = load(dir);
        if (dir.startsWith('capabilities')) {
            const bad = capabilityRows(dir).filter((r) => r[3].includes('/') && r[3].split('；').some((v) => { const m = /(\d+)\/(\d+)/.exec(v); return m != null && m[1] !== m[2]; }));
            parts.push(`- \`${dir}\`：${list.length} 个结果文件，步骤未全通过的 ${bad.length} 项${bad.length > 0 ? `（${bad.map((r) => `${r[0]} ${r[3]}`).join('；')}）` : ''}`);
        } else if (dir.startsWith('ime')) {
            const matrix = list.filter((x) => Array.isArray(x.data.cases));
            const bad = matrix.flatMap((x) => (x.data.cases as Json[]).filter((c) => !Object.entries(c.ok).every(([k, v]) => v || ((k === 'undo' || k === 'redo') && x.data.driver === 'webkit' && x.data.config === 'default'))).map((c) => `${browserOf(x.file)} ${x.data.driver}/${x.data.config} ${c.id}`));
            parts.push(`- \`${dir}\`：${matrix.length} 组输入法矩阵，异常 ${bad.length} 项${bad.length > 0 ? `（${bad.slice(0, 5).join('；')}）` : ''}`);
        } else {
            const cases = list.filter((x) => x.data.source != null);
            const bad = cases.filter((x) => x.data.pwned != null || (x.data.unsafeLinks ?? []).length > 0 || (x.data.health?.errors ?? []).length > 0);
            parts.push(`- \`${dir}\`：${cases.length} 个粘贴结果，安全或页面错误问题 ${bad.length} 项`);
        }
    }
    return ['## V13 档案变体的回归', parts.join('\n') || '（没有变体结果）'].join('\n\n');
}

function ime(): string {
    const list = load('ime').filter((x) => Array.isArray(x.data.cases));
    const keys = [...new Set(list.map((x) => `${x.data.driver}|${x.data.config}`))];
    const rows = keys.map((key) => {
        const [driver, config] = key.split('|');
        const of = list.filter((x) => x.data.driver === driver && x.data.config === config);
        const count = (k: string) => merged(of.map((x) => ({ browser: browserOf(x.file), value: `${(x.data.cases as Json[]).filter((c) => c.ok[k]).length}/${(x.data.cases as Json[]).length}` })));
        const mixed = merged(of.map((x) => ({ browser: browserOf(x.file), value: x.data.mixed.after === x.data.mixed.expected ? (x.data.mixed.restored ? '正确，撤销复原' : '正确，撤销未复原') : '错误' })));
        const errors = merged(of.map((x) => ({ browser: browserOf(x.file), value: String(x.data.health.errors.length) })));
        return [driver, config, count('text'), count('paragraphs'), count('caret'), count('extra'), count('undo'), count('redo'), mixed, errors];
    });
    const defect = list.filter((x) => x.data.driver === 'webkit' && x.data.config === 'default').slice(0, 1).flatMap((x) => (x.data.cases as Json[]).filter((c) => !c.ok.undo).slice(0, 4).map((c) => [browserOf(x.file), c.id, c.after.slice(-24), c.undone.slice(-24), c.redone.slice(-24)]));
    return [
        '## V13 中文输入（13 种情形：5 种输入序列 × 段落末尾，拼音 × 8 种位置）',
        table(['驱动', '配置', '正文', '段落数', '光标', '样式与结构', '撤销', '重做', '标点与连续组合', '页面错误'], rows),
        '### WebKit 顺序、SDK 默认：撤销与重做（示例）',
        table(['浏览器', '情形', '提交后（末尾）', '撤销后', '重做后'], defect),
    ].join('\n\n');
}

function anchor(): string {
    const list = load('ime').filter((x) => x.file.includes('candidate-anchor'));
    const rows = list.flatMap((x) => (x.data.results as Json[]).flatMap((r) => (r.samples as Json[]).map((s) => [browserOf(x.file), String(r.zoomRatio ?? r.zoom), r.nowrap ? '不换行' : '默认', s.text, String(s.compositionOffsetOnCanvas ?? '—'), String(s.dx), String(s.dy), s.font])));
    return ['## V13 候选框锚点：隐藏输入元素里组合文字的末尾，相对画布上组合文字末尾的偏移（px）', table(['浏览器', '缩放', '隐藏输入元素', '组合文字', '画布上组合文字的宽度', '横向偏移', '纵向偏移', '隐藏输入元素的字体'], rows)].join('\n\n');
}

function capture(): string {
    const list = load('ime').filter((x) => x.file.includes('capture-'));
    const rows = list.map((x) => {
        const mid = x.data.mid;
        const midText = x.data.config === 'platform'
            ? (mid.wait.composing ? `等到时限（${ms(mid.wait.waitedMs)} ms）仍在组合，不捕获` : `${ms(mid.wait.waitedMs)} ms 后捕获`)
            : `${ms(mid.wait.waitedMs)} ms 后捕获，快照${mid.hasPinyin ? '含拼音' : '无拼音'}`;
        return [browserOf(x.file), x.data.config, x.data.driver, midText, `${ms(x.data.end.wait.waitedMs)} ms 后捕获，${x.data.end.hasFinal && !x.data.end.hasPinyin ? '是最终文字' : '异常'}`, x.data.finalText.slice(-12)];
    });
    return ['## V13 组合进行中的捕获（停在候选上 1.5 秒，去抖 1 秒、时限 2.5 秒）', table(['浏览器', '配置', '驱动', '组合进行中', '提交后', '最终正文（末尾）'], rows)].join('\n\n');
}

function paste(): string {
    const list = load('paste').filter((x) => x.data.source != null && x.data.target === 'empty' && x.data.config === 'platform');
    const sources = [...new Set(list.map((x) => x.data.source as string))];
    const rows = sources.map((source) => {
        const of = list.filter((x) => x.data.source === source);
        const features = Object.keys(of[0].data.features ?? {});
        const kept = features.filter((f) => of.every((x) => x.data.features[f]));
        const lost = features.filter((f) => of.every((x) => !x.data.features[f]));
        const mixed = features.filter((f) => !kept.includes(f) && !lost.includes(f)).map((f) => `${f}（${of.filter((x) => x.data.features[f]).map((x) => browserOf(x.file)).join('、')}）`);
        const safety = merged(of.map((x) => ({ browser: browserOf(x.file), value: `${x.data.pwned == null ? '无脚本' : `脚本执行：${x.data.pwned}`}；不安全链接 ${(x.data.unsafeLinks ?? []).length}；页面错误 ${x.data.health.errors.length}` })));
        const rt = merged(of.map((x) => ({ browser: browserOf(x.file), value: x.data.roundtrip == null ? '—' : x.data.roundtrip.secondDiff.length === 0 ? '一致' : '不一致' })));
        return [source, kept.join('、') || '—', lost.join('、') || '—', mixed.join('；') || '—', safety, rt];
    });
    return ['## V13 粘贴：剪贴板样本 → 空段落（平台配置）', table(['来源', '保留', '丢失', '因浏览器而异', '安全与错误', '保存重开'], rows)].join('\n\n');
}

function pasteExtra(): string {
    const all = load('paste');
    const targets = all.filter((x) => x.data.source != null && x.data.target !== 'empty');
    const rows = targets.map((x) => [browserOf(x.file), x.data.source, x.data.target, x.data.changed ? '已粘贴' : '没有粘贴', (x.data.diff.headings as string[]).join('、') || '—', (x.data.diff.tables as string[]).join('、') || '—', String(x.data.health.errors.length)]);
    const frag = all.filter((x) => x.file.includes('-fragment-')).map((x) => [browserOf(x.file), x.data.config, (x.data.diff.links as string[]).join('、') || '无', (x.data.diff.headings as string[]).join('、') || '—', (x.data.policyEvents as Json[]).map((e) => e.detail).join('；').slice(0, 80) || '—']);
    const plainLinks = all.filter((x) => x.file.includes('plain-links-default')).map((x) => [browserOf(x.file), JSON.stringify(x.data.links).slice(0, 160)]);
    const mode = all.filter((x) => x.file.includes('plain-mode')).map((x) => [browserOf(x.file), String(x.data.diff.paragraphs), (x.data.diff.headings as string[]).length === 0 && (x.data.diff.tables as string[]).length === 0 ? '无标题、无表格' : '有格式']);
    const same = all.filter((x) => x.file.includes('copy-same-doc')).map((x) => [browserOf(x.file), (x.data.diff.headings as string[]).join('、'), (x.data.diff.lists as string[]).join('、'), (x.data.diff.links as string[]).join('、'), x.data.roundtrip.secondDiff.length === 0 ? '一致' : '不一致']);
    const cross = all.filter((x) => x.file.includes('-cross')).map((x) => [browserOf(x.file), JSON.stringify(x.data.docToDoc).slice(0, 220), JSON.stringify(x.data.sheetToDoc), JSON.stringify(x.data.docToSheet)]);
    return [
        '## V13 粘贴：其他目标（平台配置）',
        table(['浏览器', '来源', '目标', '结果', '新增标题', '新增表格', '页面错误'], rows),
        '## V13 粘贴：伪造的内部片段',
        table(['浏览器', '配置', '新增链接', '新增标题', '平台的处理'], frag),
        '## V13 粘贴：纯文本里的网址（SDK 默认）',
        table(['浏览器', '生成的链接'], plainLinks),
        '## V13 粘贴："仅保留文本"',
        table(['浏览器', '新增段落', '格式'], mode),
        '## V13 复制粘贴：同一文档内',
        table(['浏览器', '标题', '列表', '链接', '保存重开'], same),
        '## V13 复制粘贴：跨标签页、表格与文字文档之间（Chromium 内核，真实剪贴板）',
        table(['浏览器', '文字文档 → 另一个标签页', '表格 → 文字文档', '文字文档 → 表格（D8:D10）'], cross),
    ].join('\n\n');
}

function layout(): string {
    const list = load('layout');
    const pick = (name: string) => list.filter((x) => x.file.endsWith(`-${name}.json`));
    const trad = [...pick('traditional-default'), ...pick('traditional-platform')].map((x) => [browserOf(x.file), x.data.config, String(x.data.flavor), (x.data.headers as string[]).join('、') || '无', (x.data.policyEvents as Json[]).map((e) => e.detail).join('；') || '—']);
    const cmdRows: string[][] = [];
    for (const x of [...pick('commands-default'), ...pick('commands-platform')]) {
        for (const c of x.data.commands as Json[]) cmdRows.push([browserOf(x.file), x.data.config, c.id, String(c.result), c.changed ? '改动了文档' : '没有改动', `版式 ${c.flavor}，图片 ${c.drawings}`]);
    }
    const cmdMerged = new Map<string, string[]>();
    for (const r of cmdRows) {
        const k = `${r[1]}|${r[2]}`;
        const v = `${r[3]}，${r[4]}，${r[5]}`;
        cmdMerged.set(k, [...(cmdMerged.get(k) ?? []), `${r[0]}：${v}`]);
    }
    const cmds = [...cmdMerged.entries()].map(([k, vs]) => {
        const [config, id] = k.split('|');
        const values = vs.map((v) => v.split('：').slice(1).join('：'));
        return [config, id, new Set(values).size === 1 ? values[0] : vs.join('；')];
    });
    const menus = pick('menus').map((x) => [browserOf(x.file), `${(x.data.unsupported as Json[]).filter((m) => m.hidden === true).length}/${(x.data.unsupported as Json[]).length}`, Object.entries(x.data.search as Record<string, string[]>).map(([q, l]) => `${q}：${l.some((t) => t.includes('未找到')) ? '找不到' : l.join('/')}`).join('；'), (x.data.slash as string[]).join('、')]);
    const outline = pick('outline').map((x) => [browserOf(x.file), (x.data.edit.entries as string[]).join('、'), String(x.data.edit.detections), (x.data.read.entries as string[]).length > 0 ? '有' : '无']);
    const toc = pick('tocblock').map((x) => [browserOf(x.file), x.data.facadeHeadings.inserted ? '插入了' : '没有插入（标题没有 headingId、outlineLevel）', (x.data.ranges as Json[]).map((r) => `${r.type === 1 ? `FIELD ${r.properties?.fieldType}` : r.type === 0 ? `HYPERLINK ${r.properties?.url ?? `#${r.properties?.headingId}`}` : r.type}`).slice(0, 4).join('、'), String(x.data.update), x.data.roundtrip.firstDiff.length > 0 ? `首次保存补 ${x.data.roundtrip.firstDiff.length} 处` : '无', x.data.roundtrip.secondDiff.length === 0 ? '一致' : '不一致']);
    const extras = pick('extras').flatMap((x) => (x.data.steps as Json[]).map((s) => [browserOf(x.file), s.step, s.ok ? '可用' : '不可用', JSON.stringify(s.detail)?.slice(0, 80) ?? '—']));
    const noFormula = pick('no-formula').map((x) => [browserOf(x.file), `${(x.data.samples as Json[]).filter((s) => s.sameAsWithFormula).length}/${(x.data.samples as Json[]).length}`, `${(x.data.samples as Json[]).filter((s) => s.roundtrip.secondDiff.length === 0).length}/${(x.data.samples as Json[]).length}`, JSON.stringify(x.data.edits), String(x.data.health.errors.length)]);
    return [
        '## V13 版式：TRADITIONAL 快照',
        table(['浏览器', '配置', '运行时的 documentFlavor', '快照里的页眉', '平台的处理'], trad),
        '## V13 不支持功能的命令',
        table(['配置', '命令', '结果（三个浏览器）'], cmds),
        '## V13 菜单审计（doc@1 的隐藏清单）',
        table(['浏览器', '已隐藏 / 清单中出现的项', '功能搜索', '`/` 菜单里的插入项'], menus),
        '## V13 目录：大纲侧栏',
        table(['浏览器', '大纲条目', '点击后的内容改动', '阅读模式'], outline),
        '## V13 目录：目录块插件（评估）',
        table(['浏览器', '用样本构建器设置的标题', '插入后的区间（前 4 个）', '更新命令', '首次保存', '再保存'], toc),
        '## V13 附加能力',
        table(['浏览器', '能力', '结论', '数据'], extras),
        '## V13 去掉公式引擎',
        table(['浏览器', '快照与带公式引擎时一致', '再保存一致', '基本编辑', '页面错误'], noFormula),
    ].join('\n\n');
}

function csp(): string {
    const list = load('csp');
    const rows = list.flatMap((x) => (x.data.steps as Json[]).map((s) => {
        const fmt = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k} × ${v}`).join('；') || '—';
        return [browserOf(x.file), x.data.worker ? '排版 Worker' : '主线程', s.step, fmt(s.enforce), fmt(s.probe)];
    }));
    return ['## V13 CSP：强制策略与探测策略的违规', table(['浏览器', '模式', '步骤', '强制策略', '探测策略（去掉 data:、blob:、unsafe-inline）'], rows)].join('\n\n');
}

function perf(): string {
    const list = load('perf');
    const rows = list.map((x) => {
        const d = x.data;
        const heap = d.heap.afterOpen == null ? '—' : `${mib(d.heap.afterOpen.main)}${d.heap.afterOpen.workers.length > 0 ? ` + ${d.heap.afterOpen.workers.map(mib).join('+')}` : ''}`;
        return [browserOf(x.file), d.sample, d.worker ? 'Worker' : '主线程', `${d.size.chars} 字，表格 ${d.size.tables}，图片 ${d.size.images}，${mib(d.size.bytes)} MiB`, `${ms(d.open.median.rendered)} / ${ms(d.open.median.steady)}`, heap,
            d.typing.latency == null ? '—' : `${ms(d.typing.latency.p50)} / ${ms(d.typing.latency.p95)}`, `${ms(d.typing.blockMs)} / ${ms(d.typing.frameGapMs)}`,
            d.ime.update == null ? '—' : `${ms(d.ime.update.p50)} / ${ms(d.ime.update.p95)}`, d.ime.end == null ? '—' : `${ms(d.ime.end.p50)} / ${ms(d.ime.end.p95)}`, `${ms(d.ime.blockMs)} / ${ms(d.ime.frameGapMs)}`, String(d.ime.committed)];
    });
    return ['## V13 性能（毫秒；堆为 MiB，只有 Chromium）', table(['浏览器', '样本', '模式', '规模', '打开：Rendered / Steady', 'JS 堆（页面 + Worker）', '键入 p50 / p95', '键入期间：最长阻塞 / 帧间隔', '组合更新 p50 / p95', '提交 p50 / p95', '组合期间：最长阻塞 / 帧间隔', '提交次数'], rows)].join('\n\n');
}

function bundle(): string {
    const f = join(RESULTS, 'bundle', 'doc-bundle.json');
    if (!existsSync(f)) return '## V13 包体积\n\n（没有结果）';
    const d = JSON.parse(readFileSync(f, 'utf8')) as Json;
    const row = (name: string, x: Json) => [name, `${mib(x.initialJs.raw)}（gzip ${mib(x.initialJs.gzip)}）`, `${mib(x.js.raw)}（gzip ${mib(x.js.gzip)}）`, `${(x.css.raw / 1024).toFixed(0)} KiB`];
    return ['## V13 包体积：doc@1 的插件清单（MiB）', table(['入口', '首屏 JS', '全部 JS', 'CSS'], [row('有公式引擎', d.withFormula), row('没有公式引擎', d.noFormula)]), `首屏 JS 减少 ${mib(d.saving.initialRaw)} MiB（gzip ${mib(d.saving.initialGzip)} MiB，${(d.saving.initialRatioRaw * 100).toFixed(0)}%）。`].join('\n\n');
}

const SECTIONS: Record<string, () => string> = { capabilities, capabilityRecords, variants, ime, anchor, capture, paste, pasteExtra, layout, csp, perf, bundle };
const wanted = process.argv.slice(2).length > 0 ? process.argv.slice(2) : Object.keys(SECTIONS);
console.log(wanted.map((k) => SECTIONS[k]()).join('\n\n'));
