// V09 阅读模式（00 号计划书 §6.5）：每个编辑入口都被拦截，或者不会产生可提交的内容；模式切换；入口隐藏；真实用户身份。
// 三种候选方案（Phase 文档 §3.3）：facade（官方接口）、points（本地权限点）、firewall（取消非本地 mutation）。
// 每个入口的结论：拦截（内容不变）/ 没有拦截但被检测到（进入编辑前必须重新加载）/ 没有拦截也没有被检测到（不可接受）。
import type { Page } from '@playwright/test';
import type { DocKind } from './p3-helpers';

import { expect, test } from '@playwright/test';
import { SHEET_PROTECTION_MENUS, SHEET_READ_MODE_MENUS, SHEET_UNSUPPORTED_MENUS } from '../src/profiles/ui-config';
import { browserInfo, cellCenter, SERVERS, waitForEditor, writeResult } from './helpers';
import { brief, contentDiff, detectorMark, detectorState, runFacade, snapshotText, waitQuiet } from './p3-helpers';

test.use({ baseURL: SERVERS.off });

const STRATEGIES = ['facade', 'points', 'firewall'] as const;

type Step = string | ((page: Page) => Promise<void>);

interface Entry {
    id: string;
    method: 'F' | 'U';
    run: Step;
}

async function clickCell(page: Page, a1: string): Promise<void> {
    const p = await cellCenter(page, a1);
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(150);
}

async function clickDoc(page: Page): Promise<void> {
    const box = (await page.locator('canvas#univer-doc-main-canvas').boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + 120);
    await page.waitForTimeout(200);
}

const SHEET_ENTRIES: Entry[] = [
    {
        id: 'type-value', method: 'U',
        run: async (page) => {
            await clickCell(page, 'K3');
            await page.keyboard.type('123');
            await page.keyboard.press('Enter');
        },
    },
    {
        id: 'delete-content', method: 'U',
        run: async (page) => {
            await clickCell(page, 'A2');
            await page.keyboard.press('Delete');
        },
    },
    {
        id: 'paste', method: 'U',
        run: async (page) => {
            await clickCell(page, 'A2');
            await page.keyboard.press('Meta+C');
            await page.waitForTimeout(300);
            await clickCell(page, 'K6');
            await page.keyboard.press('Meta+V');
        },
    },
    {
        id: 'cut-paste', method: 'U',
        run: async (page) => {
            await clickCell(page, 'A3');
            await page.keyboard.press('Meta+X');
            await page.waitForTimeout(300);
            await clickCell(page, 'K7');
            await page.keyboard.press('Meta+V');
        },
    },
    {
        id: 'drag-fill', method: 'U',
        run: async (page) => {
            // 选中 B2，按住右下角的填充柄拖到 B4
            await clickCell(page, 'B2');
            const corner = await page.evaluate(() => {
                const canvas = document.querySelector('canvas[id^="univer-sheet-main-canvas"]')!;
                const rect = canvas.getBoundingClientRect();
                const ws = window.__m0!.editor!.univerAPI.getActiveWorkbook()!.getActiveSheet();
                const b2 = ws.getRange('B2').getCell();
                const b4 = ws.getRange('B4').getCell();
                return { x: rect.left + b2.endX - 1, y: rect.top + b2.endY - 1, toY: rect.top + b4.endY - 2 };
            });
            await page.mouse.move(corner.x, corner.y);
            await page.mouse.down();
            await page.mouse.move(corner.x, corner.toY, { steps: 8 });
            await page.mouse.up();
        },
    },
    {
        id: 'formula-bar', method: 'U',
        run: async (page) => {
            await clickCell(page, 'K5');
            const bar = page.locator('[data-u-comp="formula-bar"]');
            const box = (await bar.boundingBox())!;
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            await page.keyboard.type('编辑栏输入');
            await page.keyboard.press('Enter');
        },
    },
    { id: 'filter', method: 'F', run: "ws.getRange('A1:F6').createFilter();" },
    { id: 'sort', method: 'F', run: "ws.getRange('A2:F6').sort({ column: 1, ascending: false });" },
    { id: 'add-sheet', method: 'F', run: "wb.insertSheet('新表');" },
    { id: 'delete-sheet', method: 'F', run: "wb.deleteSheet(wb.getSheetByName('汇总'));" },
    { id: 'rename-sheet', method: 'F', run: "wb.getSheetByName('汇总').setName('汇总二');" },
    { id: 'copy-sheet', method: 'F', run: "wb.duplicateSheet(wb.getSheetByName('汇总'));" },
    { id: 'hide-sheet', method: 'F', run: "wb.getSheetByName('汇总').hideSheet();" },
    { id: 'move-sheet', method: 'F', run: "wb.moveSheet(wb.getSheetByName('汇总'), 0);" },
    { id: 'move-image', method: 'F', run: "await wb.getSheetByName('功能').getImages()[0].setPositionAsync(12, 12);" },
    { id: 'delete-image', method: 'F', run: "wb.getSheetByName('功能').getImages()[0].remove();" },
    { id: 'row-height', method: 'F', run: 'ws.setRowHeight(5, 40);' },
    { id: 'insert-row', method: 'F', run: 'ws.insertRowAfter(3);' },
    { id: 'delete-row', method: 'F', run: 'ws.deleteRows(16, 1);' },
    { id: 'merge', method: 'F', run: "ws.getRange('K10:L11').merge();" },
    { id: 'bold', method: 'F', run: "ws.getRange('A2:B3').setFontWeight('bold');" },
    { id: 'conditional-format', method: 'F', run: "ws.addConditionalFormattingRule(ws.newConditionalFormattingRule().whenCellNotEmpty().setRanges([ws.getRange('K1:K20').getRange()]).setBackground('#fecaca').build());" },
    { id: 'data-validation', method: 'F', run: "ws.getRange('K20:K25').setDataValidation(api.newDataValidation().requireNumberBetween(1, 10).build());" },
    { id: 'hyperlink', method: 'F', run: "await ws.getRange('K31').setHyperLink('https://example.com/new', '新链接');" },
    { id: 'note', method: 'F', run: "ws.getRange('K30').createOrUpdateNote({ note: '新备注', width: 160, height: 60 });" },
    { id: 'replace-all', method: 'F', run: "const f = await api.createTextFinderAsync('苹果'); await f.replaceAllWithAsync('苹果X');" },
];

const DOC_ENTRIES: Entry[] = [
    {
        id: 'type', method: 'U',
        run: async (page) => {
            await clickDoc(page);
            await page.keyboard.type('新文字');
        },
    },
    {
        id: 'delete', method: 'U',
        run: async (page) => {
            await clickDoc(page);
            for (let i = 0; i < 3; i++) await page.keyboard.press('Backspace');
        },
    },
    {
        id: 'paste', method: 'U',
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
        id: 'bold', method: 'U',
        run: async (page) => {
            await clickDoc(page);
            await page.keyboard.press('Shift+ArrowLeft');
            await page.keyboard.press('Shift+ArrowLeft');
            await page.keyboard.press('Meta+B');
        },
    },
    { id: 'heading', method: 'F', run: "doc.findParagraphByText('居中段落').setStyle({ namedStyleType: 5 });" },
    {
        id: 'list', method: 'F',
        run: "const start = doc.getBody().dataStream.indexOf('右对齐段落'); doc.setSelection(start, start); await new Promise((r) => setTimeout(r, 300)); await api.executeCommand('doc.command.bullet-list');",
    },
    {
        id: 'table', method: 'F',
        run: "const end = doc.getBody().dataStream.length - 2; doc.setSelection(end, end); await new Promise((r) => setTimeout(r, 300)); await api.executeCommand('doc.command.create-table', { rowCount: 2, colCount: 2 });",
    },
    {
        id: 'image', method: 'F',
        run: "const end = doc.getBody().dataStream.length - 2; await doc.insertImage({ source: '/fixtures-assets/blue-120x80.png', imageSourceType: 'URL', width: 120, textRange: { startOffset: end, endOffset: end } });",
    },
];

async function step(page: Page, kind: DocKind, s: Step): Promise<string | null> {
    try {
        if (typeof s === 'string') await runFacade(page, kind, s);
        else await s(page);
        return null;
    } catch (e) {
        return e instanceof Error ? e.message.split('\n')[0] : String(e);
    }
}

async function openRead(page: Page, kind: DocKind, strategy: string): Promise<void> {
    await page.goto(`/${kind}.html?sample=${kind === 'sheet' ? 'sheet-all' : 'doc-all'}&mode=read&ro=${strategy}`);
    await waitForEditor(page);
    await waitQuiet(page);
}

const PROTECTION_RESOURCES = [
    'SHEET_RANGE_PROTECTION_PLUGIN',
    'SHEET_WORKSHEET_PROTECTION_PLUGIN',
    'SHEET_WORKSHEET_PROTECTION_POINT_PLUGIN',
    'SHEET_AuthzIoMockService_PLUGIN',
    'DOC_OBJECT_PERMISSION_PLUGIN',
];

function nonEmptyProtection(text: string): string[] {
    const snap = JSON.parse(text) as { resources?: { name: string; data: string }[] };
    return (snap.resources ?? [])
        .filter((r) => PROTECTION_RESOURCES.includes(r.name))
        .filter((r) => {
            try {
                const d = JSON.parse(r.data);
                return !(d == null || (typeof d === 'object' && Object.values(d).every((x) => x == null || (typeof x === 'object' && Object.keys(x).length === 0))));
            } catch {
                return r.data !== '';
            }
        })
        .map((r) => r.name);
}

for (const kind of ['sheet', 'doc'] as const) {
    for (const strategy of STRATEGIES) {
        test(`V09 入口矩阵：${kind}-${strategy}`, async ({ page, context }, testInfo) => {
            test.setTimeout(900_000);
            if (testInfo.project.name !== 'webkit') await context.grantPermissions(['clipboard-read', 'clipboard-write']);

            // 1. 痕迹：进入阅读模式本身是否产生 mutation、是否写入保护类数据
            await page.goto(`/${kind}.html?sample=${kind === 'sheet' ? 'sheet-all' : 'doc-all'}`);
            await waitForEditor(page);
            const editText = await snapshotText(page);
            await openRead(page, kind, strategy);
            const readText = await snapshotText(page);
            const entering = await detectorState(page);
            const report = await page.evaluate(() => window.__m0!.readMode!.report);
            const traces = {
                steps: report.steps,
                detections: brief(entering).detections,
                protectionResources: nonEmptyProtection(readText),
                contentDiff: contentDiff(editText, readText).slice(0, 20),
            };

            // 2. 入口矩阵
            const entries = kind === 'sheet' ? SHEET_ENTRIES : DOC_ENTRIES;
            const results: Record<string, unknown>[] = [];
            for (const entry of entries) {
                const s0 = await snapshotText(page);
                const m0 = await detectorMark(page);
                const error = await step(page, kind, entry.run);
                await waitQuiet(page);
                await page.waitForTimeout(300);
                const s1 = await snapshotText(page);
                const state = await detectorState(page, m0);
                const diff = contentDiff(s0, s1);
                const canceled = await page.evaluate(() => window.__m0!.readMode!.report.canceled.length);
                const verdict = diff.length === 0 ? '拦截' : state.detections.length > 0 ? '未拦截-被检测到' : '未拦截-未检测到';
                results.push({ entry: entry.id, method: entry.method, verdict, error, detections: brief(state).detections, diff: diff.slice(0, 5), canceledSoFar: canceled });
                // 模型被改动过：重新加载，下一个入口从干净的状态开始
                if (diff.length > 0 || state.detections.length > 0) await openRead(page, kind, strategy);
            }

            await writeResult(`v09/entries/${testInfo.project.name}-${kind}-${strategy}.json`, {
                check: 'V09-entries',
                kind,
                strategy,
                browser: browserInfo(page, testInfo),
                timestamp: new Date().toISOString(),
                traces,
                entries: results,
                summary: {
                    blocked: results.filter((r) => r.verdict === '拦截').map((r) => r.entry),
                    detected: results.filter((r) => r.verdict === '未拦截-被检测到').map((r) => r.entry),
                    undetected: results.filter((r) => r.verdict === '未拦截-未检测到').map((r) => r.entry),
                },
            });
            // 不可接受的结论：没有拦截、也没有被检测到
            expect.soft(results.filter((r) => r.verdict === '未拦截-未检测到').map((r) => r.entry)).toEqual([]);
        });
    }

    test(`V09 撤销重做的拦截：${kind}`, async ({ page }, testInfo) => {
        const out: Record<string, unknown>[] = [];
        for (const strategy of STRATEGIES) {
            await page.goto(`/${kind}.html?sample=${kind === 'sheet' ? 'sheet-all' : 'doc-all'}`);
            await waitForEditor(page);
            // 编辑模式下先产生一条撤销记录，再原地进入阅读模式（不清空撤销栈，单独验证拦截）
            if (kind === 'sheet') {
                await clickCell(page, 'K8');
                await page.keyboard.type('阅读前的编辑');
                await page.keyboard.press('Enter');
            } else {
                await clickDoc(page);
                await page.keyboard.type('阅读前的编辑');
            }
            await waitQuiet(page);
            await page.evaluate((ro) => window.__m0!.enterReadMode!(ro, { clearUndo: false }), strategy);
            const s0 = await snapshotText(page);
            const undoBefore = await page.evaluate(() => window.__m0!.editor!.undoStatus());
            if (kind === 'sheet') await clickCell(page, 'K12');
            else await clickDoc(page);
            await page.keyboard.press('Meta+Z');
            await waitQuiet(page);
            const afterUndo = await snapshotText(page);
            await page.keyboard.press('Meta+Shift+Z');
            await waitQuiet(page);
            const afterRedo = await snapshotText(page);
            const canceled = await page.evaluate(() => window.__m0!.readMode!.report.canceled);
            out.push({
                strategy,
                undoBefore,
                undoChanged: contentDiff(s0, afterUndo).length > 0,
                redoChanged: contentDiff(afterUndo, afterRedo).length > 0,
                canceled,
            });
        }
        await writeResult(`v09/undo-redo/${testInfo.project.name}-${kind}.json`, {
            check: 'V09-undo-redo',
            kind,
            browser: browserInfo(page, testInfo),
            timestamp: new Date().toISOString(),
            results: out,
        });
        for (const r of out) expect.soft(r.undoChanged || r.redoChanged, `${r.strategy}：撤销重做被拦截`).toBe(false);
    });

    test(`V09 模式切换：${kind}`, async ({ page, request }, testInfo) => {
        test.setTimeout(300_000);
        const id = `v09-switch-${testInfo.project.name}-${kind}`;
        const sample = kind === 'sheet' ? 'sheet-all' : 'doc-all';
        const out: Record<string, unknown> = {};

        // 原地切换：每种方案进入再退出，比较退出后的快照与进入前是否相同、撤销栈是否已清空、之后能否正常编辑
        const inPlace: Record<string, unknown>[] = [];
        for (const strategy of STRATEGIES) {
            await page.goto(`/${kind}.html?sample=${sample}`);
            await waitForEditor(page);
            await waitQuiet(page);
            const before = await snapshotText(page);
            const m0 = await detectorMark(page);
            const t0 = Date.now();
            await page.evaluate((ro) => window.__m0!.enterReadMode!(ro), strategy);
            const undoInRead = await page.evaluate(() => window.__m0!.editor!.undoStatus());
            const exitSteps = await page.evaluate(() => window.__m0!.readMode!.exit());
            const ms = Date.now() - t0;
            await waitQuiet(page);
            const after = await snapshotText(page);
            const state = await detectorState(page, m0);
            // 退出后能否编辑
            const m1 = await detectorMark(page);
            if (kind === 'sheet') await runFacade(page, kind, "ws.getRange('K3').setValue('退出后编辑');");
            else await runFacade(page, kind, "doc.insertText(1, '退出后编辑');");
            await waitQuiet(page);
            const editable = (await detectorState(page, m1)).detections.length > 0;
            inPlace.push({
                strategy,
                ms,
                undoInRead,
                exitSteps,
                detectionsWhileSwitching: brief(state).detections,
                leftover: contentDiff(before, after).slice(0, 10),
                protectionResourcesAfter: nonEmptyProtection(after),
                editableAfterExit: editable,
            });
        }
        out.inPlace = inPlace;

        // 销毁重建：写入存储，再分别以阅读、编辑模式重建
        await page.goto(`/${kind}.html?sample=${sample}`);
        await waitForEditor(page);
        await page.evaluate((docId) => window.__m0!.persist!(docId), id);
        const toRead = await page.evaluate((docId) => window.__m0!.remount!({ mode: 'read', doc: docId, ro: 'points' }), id);
        const readUndo = await page.evaluate(() => window.__m0!.editor!.undoStatus());
        const toEdit = await page.evaluate((docId) => window.__m0!.remount!({ mode: 'edit', doc: docId }), id);
        const stored = JSON.stringify(await (await request.get(`${SERVERS.off}/api/docs/${id}`)).json());
        const rebuilt = await snapshotText(page);
        out.remount = { toReadMs: toRead.ms, toEditMs: toEdit.ms, readUndo, leftover: contentDiff(stored, rebuilt).slice(0, 10) };

        await writeResult(`v09/switch/${testInfo.project.name}-${kind}.json`, {
            check: 'V09-switch',
            kind,
            browser: browserInfo(page, testInfo),
            timestamp: new Date().toISOString(),
            ...out,
        });
    });
}

test('V09 入口隐藏：表格', async ({ page }, testInfo) => {
    const audit = async (mode: 'edit' | 'read') => {
        await page.goto(`/sheet.html?sample=sheet-all${mode === 'read' ? '&mode=read&ro=points' : ''}`);
        await waitForEditor(page);
        await page.waitForTimeout(500);
        const items = await page.evaluate(() => window.__m0!.auditMenus!());
        const toolbarCommands = await page.evaluate(() => [...document.querySelectorAll('[data-u-command]')].map((e) => e.getAttribute('data-u-command')));
        return { items, toolbarCommands };
    };
    const edit = await audit('edit');
    await page.screenshot({ path: `e2e/results/v09/menus/${testInfo.project.name}-sheet-edit.png` });
    const read = await audit('read');
    await page.screenshot({ path: `e2e/results/v09/menus/${testInfo.project.name}-sheet-read.png` });

    const shouldHideEdit = [...SHEET_PROTECTION_MENUS, ...SHEET_UNSUPPORTED_MENUS];
    const shouldHideRead = [...shouldHideEdit, ...SHEET_READ_MODE_MENUS];
    const visible = (items: { id: string; hidden: boolean | null }[], ids: readonly string[]) =>
        items.filter((i) => ids.includes(i.id) && i.hidden !== true).map((i) => i.id);
    const result = {
        check: 'V09-menus',
        browser: browserInfo(page, testInfo),
        timestamp: new Date().toISOString(),
        edit: {
            visibleButShouldHide: visible(edit.items, shouldHideEdit),
            foundIds: shouldHideEdit.filter((id) => edit.items.some((i) => i.id === id)),
            toolbarProtectionButton: edit.toolbarCommands.includes('sheet.command.add-range-protection-from-toolbar'),
        },
        read: {
            visibleButShouldHide: visible(read.items, shouldHideRead),
            foundIds: shouldHideRead.filter((id) => read.items.some((i) => i.id === id)),
            // 阅读模式下仍然可见、且未禁用的菜单项（供报告逐项说明）
            enabledItems: read.items.filter((i) => i.hidden !== true && i.disabled !== true).map((i) => i.id),
        },
    };
    await writeResult('v09/menus/' + testInfo.project.name + '-sheet.json', result);
    expect.soft(result.edit.visibleButShouldHide, '编辑模式：应隐藏的菜单').toEqual([]);
    expect.soft(result.read.visibleButShouldHide, '阅读模式：应隐藏的菜单').toEqual([]);
    expect.soft(result.edit.toolbarProtectionButton, '工具栏没有保护按钮').toBe(false);
});

test('V09 真实用户身份', async ({ page }, testInfo) => {
    // P2 交接：设置一个非 Owner_ 前缀的用户后，普通编辑与保护区域的表现
    const out: Record<string, unknown>[] = [];
    for (const sample of ['sheet-all', 'sheet-protection']) {
        await page.goto(`/sheet.html?sample=${sample}`);
        await waitForEditor(page);
        const user = await page.evaluate(() => window.__m0!.editor!.currentUserId());
        const before = await snapshotText(page);
        const m0 = await detectorMark(page);
        await page.evaluate(() => window.__m0!.editor!.setCurrentUser({ userID: 'user-reader-1', name: '普通成员' }));
        await clickCell(page, 'A1');
        await page.keyboard.type('身份验证');
        await page.keyboard.press('Enter');
        await waitQuiet(page);
        const after = await snapshotText(page);
        out.push({
            sample,
            userBefore: user,
            userAfter: await page.evaluate(() => window.__m0!.editor!.currentUserId()),
            a1Changed: contentDiff(before, after).some((d) => d.path.includes('cellData.0.0')),
            detections: brief(await detectorState(page, m0)).detections,
        });
    }
    await writeResult(`v09/identity/${testInfo.project.name}.json`, {
        check: 'V09-identity',
        browser: browserInfo(page, testInfo),
        timestamp: new Date().toISOString(),
        results: out,
    });
});
