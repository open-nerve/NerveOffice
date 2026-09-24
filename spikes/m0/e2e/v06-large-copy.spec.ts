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

// perf-50k：5 万单元格（数据表）；big-5m：约 23 万单元格（明细）
const SAMPLES = [
    { builder: 'perf-50k', sheet: '数据表' },
    { builder: 'big-5m', sheet: '明细' },
];

for (const sample of SAMPLES) for (const c of CONFIGS) {
    test(`V06 大表复制：${sample.builder}-${c.id}`, async ({ page, request }, testInfo) => {
        test.setTimeout(240_000);
        const id = await ensureGenerated(page, request, 'sheet', sample.builder);
        await page.goto(`/sheet.html?doc=${id}${c.split ? '' : '&split=0'}${c.worker ? '&worker=1' : ''}`);
        await waitForEditor(page);
        await waitQuiet(page);
        const s0 = await snapshotText(page);
        const m0 = await detectorMark(page);

        // 复制：只测同步部分的耗时；事件循环延迟探针一直开到 S2，用来测懒执行期间的最长阻塞。
        // 之后按平台的时机捕获：最后一次检测之后静默 1 秒（不额外等待懒执行）。
        const copy = await page.evaluate((sheet) => {
            const w = window as unknown as { __probe?: { stop(): { maxGap: number } } };
            const wb = window.__m0!.editor!.univerAPI.getActiveWorkbook()!;
            const t0 = performance.now();
            const copied = wb.duplicateSheet(wb.getSheetByName(sheet)!);
            const syncMs = performance.now() - t0;
            // 立即捕获：对应"释放编辑权、标签页转入后台时立即上传"（00 号计划书 §7.2）
            const immediate = JSON.stringify(window.__m0!.editor!.save());
            w.__probe = window.__m0!.perf!.probeEventLoopLag();
            return { syncMs, t0, name: copied.getSheetName(), immediate };
        }, sample.sheet);
        const quiet = await waitQuiet(page);
        const s1 = await snapshotText(page);
        const m1 = await detectorMark(page);
        const during = await detectorState(page, m0);
        await page.waitForTimeout(5000);
        const s2 = await snapshotText(page);
        const after = await detectorState(page, m1);
        const idleMaxGapMs = await page.evaluate(() => (window as unknown as { __probe: { stop(): { maxGap: number } } }).__probe.stop().maxGap);
        const rel = (t: number | null) => (t == null ? null : Math.round(t - copy.t0));
        const localDone = rel(during.localMutations.lastT);
        const localLast = rel(after.localMutations.lastT ?? during.localMutations.lastT);
        // 捕获等待从 waitQuiet 开始计（复制的 page.evaluate 返回之后，含立即捕获的序列化），与上面相对复制开始的时刻起点不同
        const capturedAt = Math.round(quiet.waitedMs);

        const source = cellCount(s0, sample.sheet);
        const copiedImmediately = cellCount(copy.immediate, copy.name);
        const copiedAtS1 = cellCount(s1, copy.name);
        const copiedAtS2 = cellCount(s2, copy.name);
        const lateDiff = contentDiff(s1, s2);
        // 复制品中第一个行合计公式（J2）的结果应当与原表一致
        const formulaCol = sample.builder === 'perf-50k' ? 9 : 19;
        const formulaRow = sample.builder === 'perf-50k' ? 1 : 10;
        const formulaOk = cellValue(s2, copy.name, formulaRow, formulaCol) === cellValue(s2, sample.sheet, formulaRow, formulaCol);

        // 删除大工作表：检测与撤销栈
        const m2 = await detectorMark(page);
        const removal = await page.evaluate((sheet) => {
            const editor = window.__m0!.editor!;
            const wb = editor.univerAPI.getActiveWorkbook()!;
            const undoBefore = editor.undoStatus();
            const ok = wb.deleteSheet(wb.getSheetByName(sheet)!);
            return { ok, undoBefore };
        }, sample.sheet);
        await waitQuiet(page);
        const removalState = await detectorState(page, m2);
        const undoAfterRemove = await page.evaluate(() => window.__m0!.editor!.undoStatus());

        const result = {
            check: 'V06-large-copy',
            sample: sample.builder,
            config: c,
            browser: browserInfo(page, testInfo),
            timestamp: new Date().toISOString(),
            copy: { syncMs: copy.syncMs, name: copy.name, idleMaxGapMs },
            quiet,
            // 本地 mutation（懒执行与公式结果，均为 onlyLocal）：捕获前、全部的最后一条相对复制开始的时间
            localMutations: { beforeS1: during.localMutations.count, afterS1: after.localMutations.count, lastBeforeS1Ms: localDone, lastMs: localLast },
            capturedAfterMs: capturedAt,
            sourceCells: source,
            copiedCellsImmediately: copiedImmediately,
            copiedCellsAtS1: copiedAtS1,
            copiedCellsAtS2: copiedAtS2,
            during: brief(during),
            after: brief(after),
            lateDiffCount: lateDiff.length,
            lateDiff: lateDiff.slice(0, 10),
            formulaInCopyMatches: formulaOk,
            removal: { ...removal, ...brief(removalState), undoAfterRemove },
        };
        await writeResult(`v06/large-copy/${testInfo.project.name}-${sample.builder}-${c.id}.json`, result);

        // 断言按"平台需要的行为"写：捕获时复制已完整；没有未被检测到的迟到变化
        expect.soft(result.during.detections.length, '复制被检测到').toBeGreaterThan(0);
        expect.soft(copiedAtS1, 'S1 时复制已完整').toBe(source);
        expect.soft(lateDiff.length === 0 || after.detections.length > 0, '迟到的变化被检测到').toBe(true);
        expect.soft(formulaOk, '复制品的公式结果与原表一致').toBe(true);
    });
}
