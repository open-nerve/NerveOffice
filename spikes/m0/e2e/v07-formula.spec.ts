// V07 公式一致性：修改公式依赖的单元格后立即保存，快照中的公式结果与重新计算的结果一致（00 号计划书 §7.3）。
// 每个场景在同一个页面里依次做：
//   1. 无计算时调用一次等待，测"起始等待"的耗时；
//   2. 修改输入 → 立即捕获（不等待）；
//   3. 等 onCalculationResultApplied 后捕获（只用等待接口）；再按 P3 建议的时机捕获（等待接口 + 活动静默 1 秒，活动含公式结果写回）；
//   4. 再修改一次输入 → 用 50 ms 的超时强制走超时 → 捕获（标记"公式待更新"）→ 等计算结束后补捕获（只用等待接口 / 按建议的时机）；
//   5. 把按建议时机捕获的快照写回存储：默认模式重开，显示值应等于快照值；forced 模式重开，SDK 重算的结果应等于快照值。
// 判定有两层：按公式定义从快照的输入独立推算（不依赖 SDK），以及 SDK 的强制重算。
import type { Page } from '@playwright/test';

import { expect, test } from '@playwright/test';
import { browserInfo, SERVERS, waitForEditor, writeResult } from './helpers';
import { brief, detectorMark, detectorState, ensureGenerated, snapshotText, waitQuiet } from './p3-helpers';

test.use({ baseURL: SERVERS.off });

type CellData = Record<string, Record<string, { v?: unknown; f?: string }>>;
type Snapshot = { sheets: Record<string, { name: string; cellData?: CellData }> };

function sheetOf(snap: Snapshot, name: string): CellData {
    const s = Object.values(snap.sheets).find((x) => x.name === name);
    if (s == null) throw new Error(`没有工作表：${name}`);
    return s.cellData ?? {};
}
const num = (x: unknown) => (typeof x === 'number' ? x : Number(x));
const v = (cells: CellData, r: number, c: number) => cells[r]?.[c]?.v;

interface Check {
    cell: string;
    expected: number;
    actual: unknown;
}

/** 按公式定义，从快照中的输入独立推算公式结果，列出不一致的单元格。 */
function independentCheck(scenario: string, text: string): { checked: number; mismatches: Check[] } {
    const snap = JSON.parse(text) as Snapshot;
    const out: Check[] = [];
    let checked = 0;
    const expectEq = (cell: string, expected: number, actual: unknown) => {
        checked += 1;
        if (Math.abs(num(actual) - expected) > 1e-6 * Math.max(1, Math.abs(expected))) out.push({ cell, expected, actual });
    };
    const chain = sheetOf(snap, '链');
    const agg = sheetOf(snap, '聚合');
    const b: number[] = [];
    for (let i = 0; i < 20_000; i++) b.push(num(v(agg, i, 1)));
    const sumB = b.reduce((s, x) => s + x, 0);
    if (scenario === 'chain') {
        const a1 = num(v(chain, 0, 0));
        for (let i = 1; i < 200; i++) expectEq(`链!A${i + 1}`, a1 + i, v(chain, i, 0));
    } else if (scenario === 'aggregate') {
        expectEq('聚合!C1', sumB, v(agg, 0, 2));
        expectEq('聚合!C2', sumB / b.length, v(agg, 1, 2));
        expectEq('聚合!C3', b.filter((x) => x > 500).length, v(agg, 2, 2));
        expectEq('聚合!C4', Math.max(...b), v(agg, 3, 2));
    } else if (scenario === 'cross-sheet') {
        const cross = sheetOf(snap, '跨表');
        expectEq('跨表!A1', num(v(chain, 199, 0)) * 2, v(cross, 0, 0));
        expectEq('跨表!A2', sumB + num(v(chain, 0, 0)), v(cross, 1, 0));
        expectEq('跨表!A3', num(v(agg, 0, 2)) - num(v(agg, 0, 1)), v(cross, 2, 0));
    } else if (scenario === 'slow') {
        const slow = sheetOf(snap, '慢');
        for (let i = 0; i < 200; i++) expectEq(`慢!A${i + 1}`, b.filter((x) => x > i * 5).reduce((s, x) => s + x, 0), v(slow, i, 0));
    } else if (scenario === 'volatile') {
        const vol = sheetOf(snap, '易变');
        expectEq('易变!A5', num(v(vol, 2, 0)) * 2, v(vol, 4, 0));
        const r = num(v(vol, 3, 0));
        checked += 1;
        if (!(Number.isInteger(r) && r >= 1 && r <= 1_000_000)) out.push({ cell: '易变!A4', expected: Number.NaN, actual: r });
    }
    return { checked, mismatches: out };
}

const SCENARIOS = [
    { id: 'chain', sheet: '链', input: 'A1', values: [1000, 2000] },
    { id: 'aggregate', sheet: '聚合', input: 'B1', values: [99_999, 12_345] },
    { id: 'cross-sheet', sheet: '聚合', input: 'B1', values: [77_777, 55_555] },
    { id: 'slow', sheet: '聚合', input: 'B1', values: [88_888, 44_444] },
    // 易变函数：修改一个无关的单元格，触发一次计算
    { id: 'volatile', sheet: '易变', input: 'C1', values: [1, 2] },
] as const;

/** 在页面中修改输入，并按指定方式捕获。 */
async function editAndCapture(page: Page, sheet: string, input: string, value: number, mode: 'none' | 'wait' | 'timeout') {
    return page.evaluate(async ({ sheet, input, value, mode }) => {
        const editor = window.__m0!.editor!;
        const formula = editor.univerAPI.getFormula();
        const ws = editor.univerAPI.getActiveWorkbook()!.getSheetByName(sheet)!;
        const t0 = performance.now();
        ws.getRange(input).setValue(value);
        let outcome = 'none';
        if (mode === 'wait') {
            await formula.onCalculationResultApplied(30_000);
            outcome = 'applied';
        } else if (mode === 'timeout') {
            try {
                await formula.onCalculationResultApplied(50);
                outcome = 'applied';
            } catch {
                outcome = 'timeout';
            }
        }
        const t1 = performance.now();
        return { text: JSON.stringify(editor.save()), waitMs: t1 - t0, outcome };
    }, { sheet, input, value, mode });
}

/** 打开一份存储中的快照，读出各场景涉及单元格的显示值（与快照值比较）。 */
async function reopenValues(page: Page, id: string, extra: string): Promise<{ text: string; calcMs: number }> {
    await page.goto(`/sheet.html?doc=${id}${extra}`);
    await waitForEditor(page);
    const calcMs = await page.evaluate(async () => {
        const t0 = performance.now();
        await window.__m0!.editor!.univerAPI.getFormula().onCalculationResultApplied(120_000);
        return performance.now() - t0;
    });
    return { text: await page.evaluate(() => JSON.stringify(window.__m0!.editor!.save())), calcMs };
}

for (const worker of [false, true]) {
    for (const s of SCENARIOS) {
        const name = `${s.id}${worker ? '-worker' : ''}`;
        test(`V07 公式一致性：${name}`, async ({ page, request }, testInfo) => {
            test.setTimeout(300_000);
            const source = await ensureGenerated(page, request, 'sheet', 'formula-scenarios');
            const w = worker ? '&worker=1' : '';
            await page.goto(`/sheet.html?doc=${source}${w}`);
            await waitForEditor(page);

            // 1. 起始等待：没有计算时，等待也要约 500 ms（waitForLatestApplied 的起始看门狗）
            const idleWait = await page.evaluate(async () => {
                const f = window.__m0!.editor!.univerAPI.getFormula();
                await f.onCalculationResultApplied(30_000);
                const t0 = performance.now();
                await f.onCalculationResultApplied(30_000);
                return performance.now() - t0;
            });
            // 易变函数：空闲时是否持续触发计算
            const idleSessions = await page.evaluate(async () => {
                let n = 0;
                const d = window.__m0!.editor!.univerAPI.getFormula().calculationStart(() => { n += 1; });
                await new Promise((r) => setTimeout(r, 5000));
                d.dispose();
                return n;
            });
            const m0 = await detectorMark(page);

            // 2、3：修改后不等待 / 等待
            const noWait = await editAndCapture(page, s.sheet, s.input, s.values[0], 'none');
            const waited = await page.evaluate(async () => {
                const editor = window.__m0!.editor!;
                const t0 = performance.now();
                await editor.univerAPI.getFormula().onCalculationResultApplied(30_000);
                return { text: JSON.stringify(editor.save()), waitMs: performance.now() - t0 };
            });
            const platformQuiet = await waitQuiet(page);
            const platform = await snapshotText(page);
            // 4：超时 → 捕获（公式待更新）→ 计算结束后补捕获
            const timedOut = await editAndCapture(page, s.sheet, s.input, s.values[1], 'timeout');
            const recapture = await page.evaluate(async () => {
                const editor = window.__m0!.editor!;
                const t0 = performance.now();
                await editor.univerAPI.getFormula().onCalculationResultApplied(120_000);
                return { text: JSON.stringify(editor.save()), waitMs: performance.now() - t0 };
            });
            const recaptureQuiet = await waitQuiet(page);
            const recapturePlatform = await snapshotText(page);
            const detections = await detectorState(page, m0);

            // 5：重开核对（默认模式与强制重算）
            const id = `v07-${testInfo.project.name}-${name}`;
            await request.put(`${SERVERS.off}/api/docs/${id}`, { data: JSON.parse(platform) });
            const reopened = await reopenValues(page, id, w);
            const forced = await reopenValues(page, id, `${w}&calc=forced`);

            const checks = {
                noWait: independentCheck(s.id, noWait.text),
                waited: independentCheck(s.id, waited.text),
                platform: independentCheck(s.id, platform),
                timedOut: independentCheck(s.id, timedOut.text),
                recapture: independentCheck(s.id, recapture.text),
                recapturePlatform: independentCheck(s.id, recapturePlatform),
                reopened: independentCheck(s.id, reopened.text),
                forced: independentCheck(s.id, forced.text),
            };
            const result = {
                check: 'V07',
                scenario: s.id,
                worker,
                browser: browserInfo(page, testInfo),
                timestamp: new Date().toISOString(),
                idleWaitMs: idleWait,
                idleCalcSessions: idleSessions,
                waitMs: {
                    noWait: noWait.waitMs,
                    waited: waited.waitMs,
                    platformExtra: platformQuiet.waitedMs,
                    timeoutAttempt: timedOut.waitMs,
                    recapture: recapture.waitMs,
                    recapturePlatformExtra: recaptureQuiet.waitedMs,
                },
                timeoutOutcome: timedOut.outcome,
                forcedRecalcMs: forced.calcMs,
                checks: Object.fromEntries(Object.entries(checks).map(([k, c]) => [k, { checked: c.checked, mismatches: c.mismatches.length, sample: c.mismatches.slice(0, 5) }])),
                detections: brief(detections).detections.length,
            };
            await writeResult(`v07/${testInfo.project.name}-${name}.json`, result);

            // 平台需要的保证：按建议时机的捕获、超时后按建议时机的补捕获、重开与强制重算，都与公式定义一致。
            // 只用等待接口的两次捕获（waited、recapture）在 Worker 模式下可能不一致（SDK 缺陷），只记录不断言。
            expect.soft(checks.platform.mismatches, '按建议时机捕获').toEqual([]);
            expect.soft(checks.recapturePlatform.mismatches, '超时后按建议时机补捕获').toEqual([]);
            expect.soft(checks.reopened.mismatches, '默认模式重开').toEqual([]);
            expect.soft(checks.forced.mismatches, '强制重算').toEqual([]);
            expect.soft(checks.platform.checked, '核对了单元格').toBeGreaterThan(0);
        });
    }
}
