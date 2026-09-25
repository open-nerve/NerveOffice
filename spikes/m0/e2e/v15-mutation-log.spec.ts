// V15 mutation 增量日志（P6，00 号计划书 §7.5 的"可选增强"）：
// - 重放等价：在快照 S0 上执行一组操作并记录日志（src/harness/mutation-log.ts），另开实例加载 S0、按序号重放日志，
//   与原实例的 save() 比较（规范化内容；表格另比"样式按 id 展开"之后的内容，因为样式 id 在 mutation 里随机生成）；
// - 组合恢复：快照 + 快照之后的日志，杀进程重启后恢复到被杀前的内容（发件箱与日志的位置一致）；
// - 成本：每条 mutation 的克隆耗时、批量写入 IndexedDB 的耗时、日志体积。
import type { Page, TestInfo } from '@playwright/test';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { canonicalContent, normalizeContent } from '../src/harness/content-compare';
import { diffJson } from './diff';
import { browserInfo, cellCenter, SERVERS, waitForEditor, writeResult } from './helpers';
import { syntheticPaste } from './p4-helpers';
import { endOffset, focusEditor, imeCompose, press, setSelection } from './p5-helpers';
import { contains, edit, killProfile, launchPersistent, openWithOutbox, outboxInfo, removeProfile, storeFixture, waitSavedLocal } from './p6-helpers';

type Kind = 'sheet' | 'doc';
type Json = Record<string, any>;

interface Scenario {
    name: string;
    kind: Kind;
    run: (page: Page, testInfo: TestInfo) => Promise<void>;
}

const settle = (page: Page, ms = 1500) => page.waitForTimeout(ms);
const builder = (name: string) => async (page: Page) => {
    await page.evaluate(async (n) => window.__m0!.builders![n](window.__m0!.editor!), name);
};
const pasteHtml = (name: string) => readFileSync(join(import.meta.dirname, '..', 'fixtures', 'paste', `${name}.html`), 'utf8');

const SCENARIOS: Scenario[] = [
    // 表格：V03 的样本构建器（各插件的数据），加上几类容易出问题的操作
    ...['sheet-core', 'sheet-cf', 'sheet-dv', 'sheet-filter', 'sheet-hyperlink', 'sheet-note', 'sheet-drawing'].map((n) => ({ name: n, kind: 'sheet' as const, run: builder(n) })),
    {
        name: 'sheet-style-copy',
        kind: 'sheet',
        run: async (page) => {
            await page.evaluate(() => {
                const wb = window.__m0!.editor!.univerAPI.getActiveWorkbook()!;
                const ws = wb.getActiveSheet();
                ws.getRange('A1:C3').setValues([[1, 2, 3], [4, 5, 6], [7, 8, 9]]);
                ws.getRange('A1:C1').setFontWeight('bold');
                ws.getRange('B2').setBackground('#fde68a');
                const copy = wb.duplicateSheet(ws);
                copy.getRange('C3').setFontColor('#dc2626');
            });
        },
    },
    {
        name: 'sheet-rows-drawing',
        kind: 'sheet',
        run: async (page) => {
            await page.evaluate(async () => {
                const ws = window.__m0!.editor!.univerAPI.getActiveWorkbook()!.getActiveSheet();
                ws.getRange('A1:A10').setValues([...Array(10).keys()].map((i) => [`行 ${i + 1}`]));
                await ws.insertImage('/fixtures-assets/blue-120x80.png', 2, 3);
                await new Promise((r) => setTimeout(r, 1200));
                ws.insertRowsBefore(1, 2);
                ws.deleteRows(6, 1);
                ws.setRowHeight(2, 60);
            });
        },
    },
    {
        name: 'sheet-autoheight',
        kind: 'sheet',
        run: async (page) => {
            await page.evaluate(() => {
                const ws = window.__m0!.editor!.univerAPI.getActiveWorkbook()!.getActiveSheet();
                ws.getRange('A1').setValue('很长的一段文字，用来触发自动换行与自动行高。'.repeat(6));
                ws.getRange('A1').setWrap(true);
                ws.getRange('B3').setValue('大字号').setFontSize(36);
            });
        },
    },
    {
        name: 'sheet-undo-redo',
        kind: 'sheet',
        run: async (page) => {
            await page.evaluate(async () => {
                const api = window.__m0!.editor!.univerAPI;
                const ws = api.getActiveWorkbook()!.getActiveSheet();
                ws.getRange('A1').setValue('一');
                ws.getRange('A2').setValue('二');
                ws.getRange('A3').setValue('三').setFontWeight('bold');
                await api.undo();
                await api.undo();
                await api.redo();
            });
        },
    },
    {
        name: 'sheet-paste',
        kind: 'sheet',
        run: async (page) => {
            const at = await cellCenter(page, 'B2');
            await page.mouse.click(at.x, at.y);
            await syntheticPaste(page, { html: '<table><tr><td><b>粗体</b></td><td>2</td></tr><tr><td style="color:#dc2626">红字</td><td>3.5</td></tr></table>', text: '粗体\t2\n红字\t3.5' });
        },
    },
    // 文字文档：键入、输入法、格式、表格与列表、图片、粘贴、撤销重做
    {
        name: 'doc-typing',
        kind: 'doc',
        run: async (page) => {
            await focusEditor(page);
            await setSelection(page, await endOffset(page));
            await page.keyboard.type('Hello 世界 abc', { delay: 20 });
            await page.keyboard.press('Enter');
            await page.keyboard.type('第二段文字', { delay: 20 });
        },
    },
    {
        name: 'doc-ime',
        kind: 'doc',
        run: async (page, testInfo) => {
            const driver = testInfo.project.name === 'webkit' ? 'webkit' : 'cdp';
            await focusEditor(page);
            await setSelection(page, await endOffset(page));
            await imeCompose(page, driver, { steps: ['n', 'ni', 'ni h', 'ni hao'], commit: '你好' });
            await page.keyboard.type(' ok', { delay: 20 });
            await imeCompose(page, driver, { steps: ['s', 'sh', 'shi', 'shi j', 'shi jie'], commit: '世界' });
            await imeCompose(page, driver, { steps: ['q', 'qu'], commit: '' });
        },
    },
    {
        name: 'doc-format',
        kind: 'doc',
        run: async (page) => {
            await focusEditor(page);
            const end = await endOffset(page);
            await setSelection(page, end);
            await page.keyboard.type('标题文字', { delay: 20 });
            await press(page, 'Mod+Alt+1');
            await page.keyboard.press('Enter');
            await page.keyboard.type('加粗与斜体', { delay: 20 });
            const e2 = await endOffset(page);
            await setSelection(page, e2 - 5, e2 - 3);
            await press(page, 'Mod+b');
            await setSelection(page, e2 - 2, e2);
            await press(page, 'Mod+i');
        },
    },
    {
        name: 'doc-table-list',
        kind: 'doc',
        run: async (page) => {
            await focusEditor(page);
            await setSelection(page, await endOffset(page));
            await page.keyboard.type('列表项', { delay: 20 });
            await page.evaluate(() => window.__m0!.editor!.univerAPI.executeCommand('doc.command.bullet-list'));
            await page.keyboard.press('Enter');
            await page.keyboard.type('第二项', { delay: 20 });
            await page.keyboard.press('Enter');
            await page.keyboard.press('Enter');
            await page.evaluate(() => window.__m0!.editor!.univerAPI.executeCommand('doc.command.create-table', { rowCount: 2, colCount: 2 }));
            await page.waitForTimeout(400);
            await page.keyboard.type('单元格', { delay: 20 });
        },
    },
    {
        name: 'doc-image',
        kind: 'doc',
        run: async (page) => {
            await page.evaluate(async () => {
                const doc = window.__m0!.editor!.univerAPI.getActiveDocument()!;
                const end = () => doc.getBody().dataStream.length - 2;
                await doc.insertImage({ source: '/fixtures-assets/blue-120x80.png', imageSourceType: 'URL' as never, width: 120, textRange: { startOffset: end(), endOffset: end() } } as never);
                await doc.insertImage({ source: '/fixtures-assets/orange-64x64.png', imageSourceType: 'URL' as never, width: 64, wrappingStyle: 'wrapSquare' as never, textRange: { startOffset: end(), endOffset: end() } } as never);
            });
        },
    },
    {
        name: 'doc-paste',
        kind: 'doc',
        run: async (page) => {
            await focusEditor(page);
            await setSelection(page, await endOffset(page));
            await syntheticPaste(page, { html: pasteHtml('word-win'), text: 'Word' });
        },
    },
    {
        name: 'doc-undo-redo',
        kind: 'doc',
        run: async (page) => {
            await focusEditor(page);
            await setSelection(page, await endOffset(page));
            await page.keyboard.type('撤销', { delay: 30 });
            await page.waitForTimeout(400);
            await page.keyboard.type('重做', { delay: 30 });
            await press(page, 'Mod+z');
            await press(page, 'Mod+Shift+z');
            await press(page, 'Mod+z');
        },
    },
];

/** 表格：把单元格与行列上的样式 id 换成样式对象，再去掉 styles 表；同时找出悬空的样式引用。 */
function resolveStyles(snapshot: Json): { snapshot: Json; dangling: string[] } {
    const styles = (snapshot.styles ?? {}) as Record<string, unknown>;
    const dangling: string[] = [];
    const resolve = (holder: Json, path: string) => {
        if (typeof holder.s === 'string') {
            if (styles[holder.s] == null) dangling.push(`${path} → ${holder.s}`);
            holder.s = styles[holder.s] ?? `悬空:${holder.s}`;
        }
    };
    for (const [sid, sheet] of Object.entries((snapshot.sheets ?? {}) as Record<string, Json>)) {
        for (const [r, row] of Object.entries((sheet.cellData ?? {}) as Record<string, Record<string, Json>>)) {
            for (const [c, cell] of Object.entries(row)) if (cell != null) resolve(cell, `${sheet.name ?? sid}!R${r}C${c}`);
        }
        for (const [r, row] of Object.entries((sheet.rowData ?? {}) as Record<string, Json>)) if (row != null) resolve(row, `${sheet.name ?? sid}!行${r}`);
        for (const [c, col] of Object.entries((sheet.columnData ?? {}) as Record<string, Json>)) if (col != null) resolve(col, `${sheet.name ?? sid}!列${c}`);
    }
    delete snapshot.styles;
    return { snapshot, dangling };
}

function compare(kind: Kind, before: string, after: string) {
    const strict = canonicalContent(before) === canonicalContent(after);
    const a = normalizeContent(before);
    const b = normalizeContent(after);
    const ra = kind === 'sheet' ? resolveStyles(a) : { snapshot: a, dangling: [] };
    const rb = kind === 'sheet' ? resolveStyles(b) : { snapshot: b, dangling: [] };
    const diffs = diffJson(ra.snapshot, rb.snapshot);
    return { strict, resolved: diffs.length === 0, diffs: diffs.slice(0, 20), diffCount: diffs.length, danglingOriginal: ra.dangling, danglingReplayed: rb.dangling };
}

const snapshotText = (page: Page) => page.evaluate(() => JSON.stringify(window.__m0!.editor!.save()));

/** 不补全参数时已知的不确定：样式 id 与批注 id 在处理器里随机生成（用例断言缺陷的特征，特征变了就会发现）。 */
const KNOWN_PLAIN: Record<string, { reason: string; check: (r: ReturnType<typeof compare>) => boolean }> = {
    'sheet-note': { reason: '批注 id 在 SheetsNoteModel.updateNote 里随机生成', check: (r) => r.diffCount > 0 && r.diffs.every((d) => /\.id$/.test(d.path) && d.path.includes('resources')) },
    'sheet-style-copy': { reason: '复制工作表的单元格按字符串引用样式 id，重放的实例里没有这些 id', check: (r) => r.danglingReplayed.length > 0 },
};
const ENRICH = ['sheet-note', 'sheet-style-copy'];

for (const s of SCENARIOS) {
    for (const mode of ENRICH.includes(s.name) ? (['plain', 'enrich'] as const) : (['plain'] as const)) {
        test(`V15 重放等价：${s.name}${mode === 'enrich' ? '（补全参数）' : ''}`, async ({ page, request }, testInfo) => {
            test.setTimeout(180_000);
            // S0：先把空白样本保存一次存进验证服务（样本加载时随机生成的 sectionId 等固定下来），记录与重放都从它开始
            const s0 = `p6-v15-${s.name}-${mode}-${testInfo.project.name}`;
            await page.goto(`${SERVERS.full}/${s.kind}.html?sample=empty`);
            await waitForEditor(page);
            await request.put(`${SERVERS.full}/api/docs/${s0}`, { data: JSON.parse(await snapshotText(page)) });
            const url = `${SERVERS.full}/${s.kind}.html?doc=${s0}&mutlog=${mode === 'enrich' ? 'enrich' : '1'}`;
            await page.goto(url);
            await waitForEditor(page);
            const logId = await page.evaluate(() => window.__m0!.mutlog!.logger().logId);
            await s.run(page, testInfo);
            await settle(page);
            await page.evaluate(() => window.__m0!.mutlog!.logger().flush());
            const original = await snapshotText(page);
            const log = await page.evaluate(async (logId) => {
                const m = window.__m0!.mutlog!;
                const entries = await m.read(logId);
                const ids: Record<string, number> = {};
                for (const e of entries) ids[e.id] = (ids[e.id] ?? 0) + 1;
                return { stats: m.logger().stats(), entries: entries.length, bytes: JSON.stringify(entries).length, ids };
            }, logId);
            // 另开一个实例：加载同一个 S0，重放日志
            await page.goto(url);
            await waitForEditor(page);
            const replay = await page.evaluate((logId) => window.__m0!.mutlog!.replay(logId), logId);
            await settle(page);
            const replayed = await snapshotText(page);
            const result = compare(s.kind, original, replayed);
            const known = mode === 'plain' ? KNOWN_PLAIN[s.name] ?? null : null;
            await writeResult(`v15/replay/${testInfo.project.name}-${s.name}${mode === 'enrich' ? '-enrich' : ''}.json`, {
                check: 'V15-replay', scenario: s.name, mode, kind: s.kind, browser: browserInfo(page, testInfo), timestamp: new Date().toISOString(),
                log, replay, known: known?.reason ?? null, ...result,
            });
            expect.soft(log.stats.cloneErrors, '参数都能结构化克隆').toEqual([]);
            expect.soft(replay.failed, '重放没有失败的条目').toEqual([]);
            if (known != null) {
                expect.soft(known.check(result), `已知的不确定（${known.reason}）：${JSON.stringify(result.diffs.slice(0, 3))}`).toBe(true);
            } else {
                expect.soft(result.resolved, `重放后内容一致（样式按 id 展开）：${JSON.stringify(result.diffs.slice(0, 3))}`).toBe(true);
                expect.soft(result.danglingReplayed, '重放后没有悬空的样式引用').toEqual([]);
            }
        });
    }
}

test('V15 组合恢复：快照 + 快照之后的日志', async ({ playwright, browserName, request }, testInfo) => {
    test.setTimeout(240_000);
    const browserType = playwright[browserName];
    const out: Record<string, unknown>[] = [];
    for (const kind of ['sheet', 'doc'] as const) {
        const id = `p6-combined-${kind}-${testInfo.project.name}`;
        await storeFixture(request, SERVERS.full, kind, kind === 'sheet' ? 'sheet-core' : 'doc-text', id);
        let { context, dir } = await launchPersistent(browserType, testInfo);
        try {
            let page = await context.newPage();
            await openWithOutbox(page, SERVERS.full, { kind, doc: id, extra: 'mutlog=1' });
            await edit(page, kind, 'P6L1');
            await waitSavedLocal(page);
            // 写入本机之后再改三处，不等快照：只在日志里
            for (const m of ['P6L2', 'P6L3', 'P6L4']) {
                await edit(page, kind, m);
                await page.waitForTimeout(60);
            }
            await page.waitForTimeout(250);
            await page.evaluate(() => window.__m0!.mutlog!.logger().flush());
            const beforeKill = await snapshotText(page);
            killProfile(dir);
            await context.close().catch(() => undefined);
            await new Promise((r) => setTimeout(r, 500));
            ({ context } = await launchPersistent(browserType, testInfo, dir));
            page = await context.newPage();
            await openWithOutbox(page, SERVERS.full, { kind, doc: id, extra: 'mutlog=1' });
            const info = await outboxInfo(page);
            const mark = await page.evaluate(async () => {
                const r = await window.__m0!.outbox!.inspect();
                return { logId: r.record?.logId ?? null, logSeq: r.record?.logSeq ?? null };
            });
            await page.evaluate(() => window.__m0!.outbox!.restore());
            const snapshotOnly = { l1: await contains(page, 'P6L1'), l4: await contains(page, 'P6L4') };
            const replay = mark.logId == null ? null : await page.evaluate(({ logId, logSeq }) => window.__m0!.mutlog!.replay(logId, logSeq ?? 0), mark as { logId: string; logSeq: number });
            await page.waitForTimeout(1500);
            const recovered = await snapshotText(page);
            const result = compare(kind, beforeKill, recovered);
            out.push({ kind, info: info.recovery?.status, mark, snapshotOnly, replay, withLog: { l4: await contains(page, 'P6L4') }, ...result });
        } finally {
            await context.close().catch(() => undefined);
            removeProfile(dir);
        }
    }
    await writeResult(`v15/combined/${testInfo.project.name}.json`, { check: 'V15-combined', browser: { project: testInfo.project.name }, timestamp: new Date().toISOString(), runs: out });
    for (const r of out) {
        expect.soft(r.info, `${r.kind}：有可恢复的快照`).toBe('restorable');
        expect.soft((r.snapshotOnly as Json).l4, `${r.kind}：只用快照时丢了之后的修改`).toBe(false);
        expect.soft((r.withLog as Json).l4, `${r.kind}：加上日志后恢复到被杀前`).toBe(true);
        expect.soft(r.resolved, `${r.kind}：与被杀前的内容一致：${JSON.stringify((r.diffs as unknown[]).slice(0, 3))}`).toBe(true);
    }
});
