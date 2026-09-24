// V06-4 观察者效应（P2 报告 §2.3 第 5 条；Phase 设计 §3.3 V06 第 4 条）：
// Facade 的部分读取方法会在模型里建空条目，改变下一次 save() 的字节。核对它们不执行 mutation、不被检测为修改，
// 规范化之后的内容也不变（属于空值等价）。
import { expect, test } from '@playwright/test';
import { browserInfo, SERVERS, waitForEditor, writeResult } from './helpers';
import { brief, contentDiff, detectorMark, detectorState } from './p3-helpers';

test.use({ baseURL: SERVERS.off });

const READERS = ['getDataValidations', 'getConditionalFormattingRules', 'getFilter', 'getImages'] as const;

for (const sample of ['sheet-all', 'sheet-core', 'sheet-dv']) {
    test(`V06 观察者效应：${sample}`, async ({ page }, testInfo) => {
        await page.goto(`/sheet.html?sample=${sample}`);
        await waitForEditor(page);
        await page.waitForTimeout(1000);
        const m0 = await detectorMark(page);
        const r = await page.evaluate(async (readers) => {
            const editor = window.__m0!.editor!;
            const before = JSON.stringify(editor.save());
            const wb = editor.univerAPI.getActiveWorkbook()!;
            const called: string[] = [];
            for (const ws of wb.getSheets()) {
                const w = ws as unknown as Record<string, (() => unknown) | undefined>;
                for (const name of readers) {
                    if (typeof w[name] === 'function') {
                        w[name]!.call(ws);
                        called.push(name);
                    }
                }
            }
            await new Promise((res) => setTimeout(res, 1000));
            return { before, after: JSON.stringify(editor.save()), called: [...new Set(called)] };
        }, READERS);
        const state = await detectorState(page, m0);
        const result = {
            check: 'V06-observer',
            sample,
            browser: browserInfo(page, testInfo),
            timestamp: new Date().toISOString(),
            readers: r.called,
            bytesChanged: r.before !== r.after,
            contentDiff: contentDiff(r.before, r.after).slice(0, 10),
            ...brief(state),
        };
        await writeResult(`v06/observer/${testInfo.project.name}-${sample}.json`, result);
        expect(result.readers.length).toBeGreaterThan(0);
        expect.soft(result.detections, '读取方法不被检测为修改').toEqual([]);
        expect.soft(result.mutations, '读取方法不执行非本地 mutation').toEqual([]);
        expect.soft(result.contentDiff, '规范化之后内容不变').toEqual([]);
    });
}
