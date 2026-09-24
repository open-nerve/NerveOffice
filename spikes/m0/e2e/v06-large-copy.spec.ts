// V06-3 大工作表的复制与删除。
// 复制单元格数不少于 6,000 的工作表时，SDK 默认拆分：第一批随插入工作表执行，其余先以 syncOnly 宣告、再在空闲时以 onlyLocal 执行。
// 比较默认拆分与关掉拆分（split=0）：检测是否漏报、S1 是否完整、复制时的主线程阻塞；Worker 模式下复制品的公式结果是否正确。
import { expect, test } from '@playwright/test';
import { browserInfo, SERVERS, waitForEditor, writeResult } from './helpers';
import { brief, contentDiff, detectorMark, detectorState, ensureGenerated, snapshotText, waitQuiet } from './p3-helpers';

test.use({ baseURL: SERVERS.off });

type Sheets = Record<string, { name: string; cellData?: Record<string, Record<string, { v?: unknown; f?: string }>> }>;

function cellCount(text: string, name: string): number {
    const sheets = (JSON.parse(text) as { sheets: Sheets }).sheets;
    const sheet = Object.values(sheets).find((s) => s.name === name);
    if (sheet?.cellData == null) return 0;
    return Object.values(sheet.cellData).reduce((n, row) => n + Object.keys(row).length, 0);
}

function cellValue(text: string, name: string, row: number, col: number): unknown {
    const sheets = (JSON.parse(text) as { sheets: Sheets }).sheets;
    return Object.values(sheets).find((s) => s.name === name)?.cellData?.[row]?.[col]?.v;
}

const CONFIGS = [
    { id: 'split-default', split: true, worker: false },
    { id: 'split-off', split: false, worker: false },
    { id: 'split-default-worker', split: true, worker: true },
    { id: 'split-off-worker', split: false, worker: true },
];

for (const c of CONFIGS) {
    test(`V06 大表复制：${c.id}`, async ({ page, request }, testInfo) => {
        test.setTimeout(240_000);
        const id = await ensureGenerated(page, request, 'sheet', 'perf-50k');
        await page.goto(`/sheet.html?doc=${id}${c.split ? '' : '&split=0'}${c.worker ? '&worker=1' : ''}`);
        await waitForEditor(page);
        await waitQuiet(page);
        const s0 = await snapshotText(page);
        const m0 = await detectorMark(page);

        // 复制并测量同步部分的耗时，以及随后空闲执行期间的最长阻塞
        const copy = await page.evaluate(async () => {
            const wb = window.__m0!.editor!.univerAPI.getActiveWorkbook()!;
            let maxGap = 0;
            let last = performance.now();
            let running = true;
            const tick = () => {
                const now = performance.now();
                maxGap = Math.max(maxGap, now - last);
                last = now;
                if (running) setTimeout(tick, 0);
            };
            const t0 = performance.now();
            const copied = wb.duplicateSheet(wb.getSheetByName('数据表')!);
            const syncMs = performance.now() - t0;
            last = performance.now();
            setTimeout(tick, 0);
            await new Promise((r) => setTimeout(r, 3000));
            running = false;
            return { syncMs, idleMaxGapMs: maxGap, name: copied.getSheetName() };
        });
        const quiet = await waitQuiet(page);
        const s1 = await snapshotText(page);
        const m1 = await detectorMark(page);
        const during = await detectorState(page, m0);
        await page.waitForTimeout(5000);
        const s2 = await snapshotText(page);
        const after = await detectorState(page, m1);

        const source = cellCount(s0, '数据表');
        const copiedAtS1 = cellCount(s1, copy.name);
        const copiedAtS2 = cellCount(s2, copy.name);
        const lateDiff = contentDiff(s1, s2);
        // 复制品中第一个行合计公式（J2）的结果应当与原表一致
        const formulaOk = cellValue(s2, copy.name, 1, 9) === cellValue(s2, '数据表', 1, 9);

        // 删除大工作表：检测与撤销栈
        const m2 = await detectorMark(page);
        const removal = await page.evaluate(() => {
            const editor = window.__m0!.editor!;
            const wb = editor.univerAPI.getActiveWorkbook()!;
            const undoBefore = editor.undoStatus();
            const ok = wb.deleteSheet(wb.getSheetByName('数据表')!);
            return { ok, undoBefore };
        });
        await waitQuiet(page);
        const removalState = await detectorState(page, m2);
        const undoAfterRemove = await page.evaluate(() => window.__m0!.editor!.undoStatus());

        const result = {
            check: 'V06-large-copy',
            config: c,
            browser: browserInfo(page, testInfo),
            timestamp: new Date().toISOString(),
            copy,
            quiet,
            sourceCells: source,
            copiedCellsAtS1: copiedAtS1,
            copiedCellsAtS2: copiedAtS2,
            during: brief(during),
            after: brief(after),
            lateDiffCount: lateDiff.length,
            lateDiff: lateDiff.slice(0, 10),
            formulaInCopyMatches: formulaOk,
            removal: { ...removal, ...brief(removalState), undoAfterRemove },
        };
        await writeResult(`v06/large-copy/${testInfo.project.name}-${c.id}.json`, result);

        // 断言按"平台需要的行为"写：捕获时复制已完整；没有未被检测到的迟到变化
        expect.soft(result.during.detections.length, '复制被检测到').toBeGreaterThan(0);
        expect.soft(copiedAtS1, 'S1 时复制已完整').toBe(source);
        expect.soft(lateDiff.length === 0 || after.detections.length > 0, '迟到的变化被检测到').toBe(true);
        expect.soft(formulaOk, '复制品的公式结果与原表一致').toBe(true);
    });
}
