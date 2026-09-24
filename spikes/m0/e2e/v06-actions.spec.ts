// V06-2 动作矩阵：用户的每一类编辑都能被检测到；只改视图的动作不被检测；检测安静之后没有未被检测到的迟到变化。
// 每个动作：S0 → 执行动作 → 等到检测静默 1 秒、公式结果写回 → S1 → 再等 5 秒 → S2。
// 执行方式：F 为 Facade 或命令（与界面走同一个命令），U 为真实的键盘鼠标操作。
// 表格动作另在公式 Worker 模式下跑一遍（平台默认启用公式 Worker，P3 报告 §6.3；第二轮审查 S12）。
import type { Page } from '@playwright/test';
import type { DocKind } from './p3-helpers';

import { expect, test } from '@playwright/test';
import { browserInfo, cellCenter, SERVERS, waitForEditor, writeResult } from './helpers';
import { brief, contentDiff, detectorMark, detectorState, runFacade, snapshotText, waitQuiet } from './p3-helpers';

test.use({ baseURL: SERVERS.off });

type Step = string | ((page: Page) => Promise<void>);

interface Action {
    id: string;
    kind: DocKind;
    expect: 'change' | 'view';
    method: 'F' | 'U';
    pre?: Step;
    run: Step;
}

const LONG = '很长的一段文字，用来触发自动换行后的行高自适应；很长的一段文字，很长的一段文字。';

async function clickCell(page: Page, a1: string): Promise<void> {
    const p = await cellCenter(page, a1);
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(150);
}

async function typeInCell(page: Page, a1: string, text: string): Promise<void> {
    await clickCell(page, a1);
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
}

async function docBox(page: Page) {
    return (await page.locator('canvas#univer-doc-main-canvas').boundingBox())!;
}

async function clickDoc(page: Page): Promise<void> {
    const box = await docBox(page);
    await page.mouse.click(box.x + box.width / 2, box.y + 120);
    await page.waitForTimeout(200);
}

async function typeInDoc(page: Page, text: string): Promise<void> {
    await clickDoc(page);
    await page.keyboard.type(text);
    await page.waitForTimeout(300);
}

const SHEET: Action[] = [
    // 改变内容：界面操作
    { id: 'type-value', kind: 'sheet', expect: 'change', method: 'U', run: (page) => typeInCell(page, 'K3', '123') },
    { id: 'type-formula', kind: 'sheet', expect: 'change', method: 'U', run: (page) => typeInCell(page, 'K4', '=SUM(B2:B6)') },
    {
        id: 'delete-content', kind: 'sheet', expect: 'change', method: 'U',
        run: async (page) => {
            await clickCell(page, 'A2');
            await page.keyboard.press('Delete');
        },
    },
    {
        id: 'paste', kind: 'sheet', expect: 'change', method: 'U',
        run: async (page) => {
            await clickCell(page, 'A2');
            await page.keyboard.press('Meta+C');
            await page.waitForTimeout(300);
            await clickCell(page, 'K6');
            await page.keyboard.press('Meta+V');
        },
    },
    {
        id: 'undo', kind: 'sheet', expect: 'change', method: 'U',
        pre: (page) => typeInCell(page, 'K8', '撤销前'),
        run: async (page) => {
            await clickCell(page, 'K12');
            await page.keyboard.press('Meta+Z');
        },
    },
    {
        id: 'redo', kind: 'sheet', expect: 'change', method: 'U',
        pre: async (page) => {
            await typeInCell(page, 'K8', '重做前');
            await page.keyboard.press('Meta+Z');
        },
        run: async (page) => {
            await clickCell(page, 'K12');
            await page.keyboard.press('Meta+Shift+Z');
        },
    },
    // 改变内容：Facade
    { id: 'bold', kind: 'sheet', expect: 'change', method: 'F', run: "ws.getRange('A2:B3').setFontWeight('bold');" },
    { id: 'number-format', kind: 'sheet', expect: 'change', method: 'F', run: "ws.getRange('B2:B6').setNumberFormat('0.0');" },
    { id: 'merge', kind: 'sheet', expect: 'change', method: 'F', run: "ws.getRange('K10:L11').merge();" },
    { id: 'unmerge', kind: 'sheet', expect: 'change', method: 'F', run: "ws.getRange('A13:C14').breakApart();" },
    { id: 'insert-row', kind: 'sheet', expect: 'change', method: 'F', run: 'ws.insertRowAfter(3);' },
    { id: 'delete-row', kind: 'sheet', expect: 'change', method: 'F', run: 'ws.deleteRows(16, 1);' },
    { id: 'insert-col', kind: 'sheet', expect: 'change', method: 'F', run: 'ws.insertColumnAfter(3);' },
    { id: 'delete-col', kind: 'sheet', expect: 'change', method: 'F', run: 'ws.deleteColumns(12, 1);' },
    { id: 'row-height', kind: 'sheet', expect: 'change', method: 'F', run: 'ws.setRowHeight(5, 40);' },
    { id: 'col-width', kind: 'sheet', expect: 'change', method: 'F', run: 'ws.setColumnWidth(5, 150);' },
    { id: 'wrap-autoheight', kind: 'sheet', expect: 'change', method: 'F', run: `const r = ws.getRange('K12'); r.setValue('${LONG}'); r.setWrap(true);` },
    {
        // 命令内只同步计算视口附近的 ceil(10000 / 列数) 行（"数据"表 26 列，约 385 行），其余交给空闲任务、每轮 500 行，行高变化迟到
        // （sheets/src/commands/commands/util.ts 的 getSuitableRangesInView；sheets-ui 的 auto-height.service.ts）
        id: 'lazy-autoheight', kind: 'sheet', expect: 'change', method: 'F',
        pre: "ws.setRowCount(2000); ws.getRange('M1:M1500').setValues(Array.from({ length: 1500 }, (_, i) => ['行' + i]));",
        run: "ws.getRange('M1:M1500').setFontSize(28);",
    },
    {
        // 2 万行：空闲时的自动行高持续约 1 秒，用来检验"排除自动行高"（00 号计划书 §7.3）会不会让捕获早于迟到的行高变化
        id: 'lazy-autoheight-20k', kind: 'sheet', expect: 'change', method: 'F',
        pre: "ws.setRowCount(20100); ws.getRange('N1:N20000').setValues(Array.from({ length: 20000 }, (_, i) => ['行' + i]));",
        run: "ws.getRange('N1:N20000').setFontSize(28);",
    },
    {
        // 5 万行：空闲时的自动行高明显超过 1 秒（2 万行在本机约 0.9–1.1 秒，处在临界点）
        id: 'lazy-autoheight-50k', kind: 'sheet', expect: 'change', method: 'F',
        pre: "ws.setRowCount(50100); ws.getRange('N1:N50000').setValues(Array.from({ length: 50000 }, (_, i) => ['行' + i]));",
        run: "ws.getRange('N1:N50000').setFontSize(28);",
    },
    { id: 'freeze', kind: 'sheet', expect: 'change', method: 'F', run: 'ws.setFrozenRows(3);' },
    { id: 'add-sheet', kind: 'sheet', expect: 'change', method: 'F', run: "wb.insertSheet('新表');" },
    { id: 'delete-sheet', kind: 'sheet', expect: 'change', method: 'F', run: "wb.deleteSheet(wb.getSheetByName('汇总'));" },
    { id: 'rename-sheet', kind: 'sheet', expect: 'change', method: 'F', run: "wb.getSheetByName('汇总').setName('汇总二');" },
    { id: 'move-sheet', kind: 'sheet', expect: 'change', method: 'F', run: "wb.moveSheet(wb.getSheetByName('汇总'), 0);" },
    { id: 'hide-sheet', kind: 'sheet', expect: 'change', method: 'F', run: "wb.getSheetByName('汇总').hideSheet();" },
    { id: 'copy-sheet', kind: 'sheet', expect: 'change', method: 'F', run: "wb.duplicateSheet(wb.getSheetByName('汇总'));" },
    {
        id: 'conditional-format', kind: 'sheet', expect: 'change', method: 'F',
        run: "ws.addConditionalFormattingRule(ws.newConditionalFormattingRule().whenCellNotEmpty().setRanges([ws.getRange('K1:K20').getRange()]).setBackground('#fecaca').build());",
    },
    { id: 'data-validation', kind: 'sheet', expect: 'change', method: 'F', run: "ws.getRange('K20:K25').setDataValidation(api.newDataValidation().requireNumberBetween(1, 10).build());" },
    { id: 'filter', kind: 'sheet', expect: 'change', method: 'F', run: "ws.getRange('A1:F6').createFilter();" },
    { id: 'sort', kind: 'sheet', expect: 'change', method: 'F', run: "ws.getRange('A2:F6').sort({ column: 1, ascending: false });" },
    { id: 'note', kind: 'sheet', expect: 'change', method: 'F', run: "ws.getRange('K30').createOrUpdateNote({ note: '新备注', width: 160, height: 60 });" },
    { id: 'hyperlink', kind: 'sheet', expect: 'change', method: 'F', run: "await ws.getRange('K31').setHyperLink('https://example.com/new', '新链接');" },
    { id: 'defined-name', kind: 'sheet', expect: 'change', method: 'F', run: "wb.insertDefinedName('新名称', \"'数据'!$A$2:$A$6\");" },
    { id: 'insert-image', kind: 'sheet', expect: 'change', method: 'F', run: "await ws.insertImage('/fixtures-assets/blue-120x80.png', 12, 12);" },
    {
        id: 'move-image', kind: 'sheet', expect: 'change', method: 'F',
        pre: "await ws.insertImage('/fixtures-assets/blue-120x80.png', 12, 12);",
        run: 'await ws.getImages()[0].setPositionAsync(20, 14);',
    },
    { id: 'replace-all', kind: 'sheet', expect: 'change', method: 'F', run: "const f = await api.createTextFinderAsync('苹果'); await f.replaceAllWithAsync('苹果X');" },
    // 只改视图
    { id: 'select', kind: 'sheet', expect: 'view', method: 'F', run: "ws.getRange('C3:D4').activate();" },
    {
        id: 'scroll', kind: 'sheet', expect: 'view', method: 'U',
        run: async (page) => {
            const p = await cellCenter(page, 'E8');
            await page.mouse.move(p.x, p.y);
            await page.mouse.wheel(0, 800);
        },
    },
    { id: 'zoom', kind: 'sheet', expect: 'view', method: 'F', run: 'ws.zoom(1.5);' },
    { id: 'switch-sheet', kind: 'sheet', expect: 'view', method: 'F', run: "wb.setActiveSheet(wb.getSheetByName('汇总'));" },
    { id: 'find', kind: 'sheet', expect: 'view', method: 'F', run: "const f = await api.createTextFinderAsync('苹果'); f.findAll();" },
];

const DOC: Action[] = [
    { id: 'type', kind: 'doc', expect: 'change', method: 'U', run: (page) => typeInDoc(page, '新文字') },
    {
        id: 'delete', kind: 'doc', expect: 'change', method: 'U',
        run: async (page) => {
            await clickDoc(page);
            for (let i = 0; i < 3; i++) await page.keyboard.press('Backspace');
        },
    },
    {
        id: 'bold', kind: 'doc', expect: 'change', method: 'U',
        run: async (page) => {
            await clickDoc(page);
            await page.keyboard.press('Shift+ArrowLeft');
            await page.keyboard.press('Shift+ArrowLeft');
            await page.keyboard.press('Meta+B');
        },
    },
    { id: 'heading', kind: 'doc', expect: 'change', method: 'F', run: "doc.findParagraphByText('居中段落').setStyle({ namedStyleType: 5 });" },
    {
        id: 'list', kind: 'doc', expect: 'change', method: 'F',
        run: "const start = doc.getBody().dataStream.indexOf('右对齐段落'); doc.setSelection(start, start); await new Promise((r) => setTimeout(r, 300)); await api.executeCommand('doc.command.bullet-list');",
    },
    {
        id: 'table', kind: 'doc', expect: 'change', method: 'F',
        run: "const end = doc.getBody().dataStream.length - 2; doc.setSelection(end, end); await new Promise((r) => setTimeout(r, 300)); await api.executeCommand('doc.command.create-table', { rowCount: 2, colCount: 2 });",
    },
    {
        id: 'image', kind: 'doc', expect: 'change', method: 'F',
        run: "const end = doc.getBody().dataStream.length - 2; await doc.insertImage({ source: '/fixtures-assets/blue-120x80.png', imageSourceType: 'URL', width: 120, textRange: { startOffset: end, endOffset: end } });",
    },
    {
        id: 'hyperlink', kind: 'doc', expect: 'change', method: 'F',
        run: "doc.setSelection(0, 2); await new Promise((r) => setTimeout(r, 300)); await api.executeCommand('docs.command.add-hyper-link', { unitId: doc.getId(), payload: 'https://example.com/x' });",
    },
    {
        id: 'paste', kind: 'doc', expect: 'change', method: 'U',
        run: async (page) => {
            await clickDoc(page);
            await page.keyboard.press('Shift+ArrowLeft');
            await page.keyboard.press('Shift+ArrowLeft');
            await page.keyboard.press('Meta+C');
            await page.waitForTimeout(300);
            await page.keyboard.press('ArrowRight');
            await page.keyboard.press('Meta+V');
        },
    },
    {
        id: 'undo', kind: 'doc', expect: 'change', method: 'U',
        pre: (page) => typeInDoc(page, '撤销前'),
        run: async (page) => {
            await page.keyboard.press('Meta+Z');
        },
    },
    {
        id: 'redo', kind: 'doc', expect: 'change', method: 'U',
        pre: async (page) => {
            await typeInDoc(page, '重做前');
            await page.keyboard.press('Meta+Z');
        },
        run: async (page) => {
            await page.keyboard.press('Meta+Shift+Z');
        },
    },
    {
        id: 'select', kind: 'doc', expect: 'view', method: 'U',
        run: async (page) => {
            await clickDoc(page);
            for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight');
        },
    },
    {
        id: 'scroll', kind: 'doc', expect: 'view', method: 'U',
        run: async (page) => {
            const box = await docBox(page);
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.wheel(0, 600);
        },
    },
    { id: 'zoom', kind: 'doc', expect: 'view', method: 'F', run: "await api.executeCommand('doc.command.set-zoom-ratio', { zoomRatio: 1.5, documentId: doc.getId() });" },
];

async function step(page: Page, kind: DocKind, s: Step): Promise<void> {
    if (typeof s === 'string') await runFacade(page, kind, s);
    else await s(page);
}

const RUNS = [
    ...SHEET.map((a) => ({ a, worker: false })),
    ...SHEET.map((a) => ({ a, worker: true })),
    ...DOC.map((a) => ({ a, worker: false })),
];

for (const { a, worker } of RUNS) {
    const name = `${a.kind}-${a.id}${worker ? '-worker' : ''}`;
    test(`V06 动作：${name}`, async ({ page, context }, testInfo) => {
        if (testInfo.project.name !== 'webkit') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await page.goto(`/${a.kind}.html?sample=${a.kind === 'sheet' ? 'sheet-all' : 'doc-all'}${worker ? '&worker=1' : ''}`);
        await waitForEditor(page);
        if (a.pre != null) await step(page, a.kind, a.pre);
        await waitQuiet(page);
        const s0 = await snapshotText(page);
        const m0 = await detectorMark(page);
        const tAction = await page.evaluate(() => performance.now());

        await step(page, a.kind, a.run);
        const quiet = await waitQuiet(page);
        const s1 = await snapshotText(page);
        const m1 = await detectorMark(page);
        const during = await detectorState(page, m0);
        await page.waitForTimeout(5000);
        const s2 = await snapshotText(page);
        const after = await detectorState(page, m1);
        const errors = await page.evaluate(() => window.__m0!.events.errors);

        const diff01 = contentDiff(s0, s1);
        const diff12 = contentDiff(s1, s2);
        const changed = diff01.length > 0;
        const detected = during.detections.length > 0;
        const late = diff12.length > 0;
        const lateDetected = after.detections.length > 0;
        let verdict: string;
        if (a.expect === 'change') {
            verdict = !changed ? '内容没有变化' : !detected ? '漏报' : late && !lateDetected ? '迟到的变化没有被检测到' : '通过';
        } else {
            verdict = changed ? '只改视图的动作改变了内容' : detected ? '误报' : late ? '迟到的内容变化' : '通过';
        }

        // 若按 00 号计划书 §7.3 排除自动行高：捕获发生在最后一次其他检测之后 1 秒，此后到达的行高变化不会再被检测到
        const AUTO_HEIGHT = 'sheet.mutation.set-worksheet-row-auto-height';
        const timeline = during.mutations.map((r) => ({ dt: Math.round(r.t - tAction), id: r.id, verdict: r.verdict }));
        const autoHeight = timeline.filter((x) => x.id === AUTO_HEIGHT);
        const others = timeline.filter((x) => x.verdict === 'detected' && x.id !== AUTO_HEIGHT);
        const planRule = autoHeight.length === 0 || others.length === 0 ? null : (() => {
            const captureAt = Math.max(...others.map((x) => x.dt)) + 1000;
            return { captureAtMs: captureAt, autoHeightMutations: autoHeight.length, lastAutoHeightMs: Math.max(...autoHeight.map((x) => x.dt)), missed: autoHeight.filter((x) => x.dt > captureAt).length };
        })();

        await writeResult(`v06/actions/${testInfo.project.name}-${name}.json`, {
            check: 'V06-actions',
            action: a.id,
            kind: a.kind,
            worker,
            method: a.method,
            expect: a.expect,
            verdict,
            browser: browserInfo(page, testInfo),
            timestamp: new Date().toISOString(),
            quiet,
            during: brief(during),
            after: brief(after),
            // 检测时间线（相对动作开始，毫秒）与按 §7.3 规则的推演
            timeline: timeline.slice(0, 100),
            planRule,
            diff: diff01.slice(0, 30),
            diffCount: diff01.length,
            lateDiff: diff12.slice(0, 30),
            errors,
        });
        expect(verdict).toBe('通过');
    });
}
