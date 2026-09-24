// DEF-002 的可复现证据：浮动图片（默认 Position 锚点：随单元格移动、保持尺寸）所跨的行因自动行高变高后，
// SDK 只在内存里保留了图片尺寸，没有回写终点锚点；之后凡是按锚点重算的时机（切换工作表、重新打开）图片都会被拉伸。
// 触发方式：单元格图片、换行文字、大号字；阴性对照：手动改行高、在图片上方插入行（走显式命令，锚点会同步更新）。
// 断言写的是"缺陷特征"（触发后锚点不变、切表与重开后被拉高）：SDK 修复后这些断言会失败，届时把它们翻转为"尺寸不变"。
import type { Page } from '@playwright/test';

import { expect, test } from '@playwright/test';
import { browserInfo, SERVERS, waitForEditor, writeResult } from './helpers';

test.use({ baseURL: SERVERS.off });

const LONG_TEXT = '很长的一段文字，用来触发自动换行后的行高自适应；很长的一段文字，很长的一段文字。';

const CASES = [
    { id: 'cell-image', trigger: true, run: "await ws.getRange('A3').insertCellImageAsync('/fixtures-assets/orange-64x64.png');" },
    { id: 'wrap-text', trigger: true, run: `const r = ws.getRange('A4'); r.setValue('${LONG_TEXT}'); r.setWrap(true);` },
    { id: 'font-36', trigger: true, run: "const r = ws.getRange('A4'); r.setValue('大字'); r.setFontSize(36);" },
    { id: 'manual-row-height', trigger: false, run: 'ws.setRowHeight(3, 60);' },
    // 在图片上方插入一行：起点锚点应当下移一行，尺寸不变
    { id: 'insert-row-above', trigger: false, run: 'ws.insertRowBefore(1);' },
] as const;

type Anchor = { row: number; rowOffset: number; column: number; columnOffset: number };

async function measure(page: Page) {
    return page.evaluate(() => {
        const editor = window.__m0!.editor!;
        const ws = editor.univerAPI.getActiveWorkbook()!.getSheetByName('数据')!;
        const p = ws.getImages()[0].getPlacement();
        const snap = editor.save() as { resources: { name: string; data: string }[] };
        const drawings = JSON.parse(snap.resources.find((r) => r.name === 'SHEET_DRAWING_PLUGIN')!.data)[ws.getSheetId()].data;
        const d = Object.values(drawings)[0] as { sheetTransform: { from: unknown; to: unknown }; transform: { width: number; height: number } };
        const size = p as unknown as { width: number; height: number };
        return {
            width: size.width,
            height: size.height,
            modelSize: `${d.transform.width}x${d.transform.height}`,
            fromAnchor: d.sheetTransform.from as Anchor,
            toAnchor: d.sheetTransform.to as Anchor,
        };
    });
}

for (const c of CASES) {
    test(`DEF-002 ${c.id}`, async ({ page, request }, testInfo) => {
        const id = `def002-${testInfo.project.name}-${c.id}`;
        await page.goto(`/sheet.html?sample=empty&unit=${id}`);
        await waitForEditor(page);
        await page.evaluate(async () => {
            const wb = window.__m0!.editor!.univerAPI.getActiveWorkbook()!;
            wb.insertSheet('其他');
            const ws = wb.getSheetByName('数据')!;
            wb.setActiveSheet(ws);
            await ws.insertImage('/fixtures-assets/blue-120x80.png', 2, 2);
        });
        await page.waitForTimeout(800);
        const afterInsert = await measure(page);

        // 触发行高变化（字符串代码在页面中执行，ws 为"数据"工作表）
        await page.evaluate(`(async () => { const ws = window.__m0.editor.univerAPI.getActiveWorkbook().getSheetByName('数据'); ${c.run} })()`);
        await page.waitForTimeout(1500);
        const afterTrigger = await measure(page);

        // 切到别的工作表再切回来：SDK 会按锚点重算图片
        await page.evaluate(() => {
            const wb = window.__m0!.editor!.univerAPI.getActiveWorkbook()!;
            wb.setActiveSheet(wb.getSheetByName('其他')!);
        });
        await page.waitForTimeout(500);
        await page.evaluate(() => {
            const wb = window.__m0!.editor!.univerAPI.getActiveWorkbook()!;
            wb.setActiveSheet(wb.getSheetByName('数据')!);
        });
        await page.waitForTimeout(800);
        const afterSwitch = await measure(page);

        // 保存后重开
        await page.evaluate((docId) => window.__m0!.persist!(docId), id);
        await page.goto(`/sheet.html?doc=${id}`);
        await waitForEditor(page);
        const afterReopen = await measure(page);

        await writeResult(`v03/drawing-autoheight/${testInfo.project.name}-${c.id}.json`, {
            check: 'DEF-002',
            case: c.id,
            trigger: c.trigger,
            browser: browserInfo(page, testInfo),
            timestamp: new Date().toISOString(),
            afterInsert,
            afterTrigger,
            afterSwitch,
            afterReopen,
        });
        expect(`${afterInsert.width}x${afterInsert.height}`, '插入后尺寸').toBe('120x80');
        if (c.trigger) {
            // DEF-002 的缺陷特征（SDK 1.0.0）：触发后界面尺寸不变、终点锚点没有回写；切表与重开后按旧锚点被拉高
            expect(`${afterTrigger.width}x${afterTrigger.height}`, '触发后界面尺寸不变').toBe('120x80');
            expect(afterTrigger.toAnchor, '终点锚点没有回写').toEqual(afterInsert.toAnchor);
            expect(afterSwitch.height, '切换工作表后被拉高').toBeGreaterThan(80);
            expect(afterReopen.height, '重开后保持被拉高的尺寸').toBe(afterSwitch.height);
        } else {
            expect(`${afterSwitch.width}x${afterSwitch.height}`, '切换工作表后尺寸不变').toBe('120x80');
            expect(`${afterReopen.width}x${afterReopen.height}`, '重开后尺寸不变').toBe('120x80');
            if (c.id === 'manual-row-height') expect(afterTrigger.toAnchor, '显式改行高时终点锚点已更新').not.toEqual(afterInsert.toAnchor);
            if (c.id === 'insert-row-above') expect(afterTrigger.fromAnchor.row, '上方插入行后起点锚点下移').toBe(afterInsert.fromAnchor.row + 1);
        }
    });
}
