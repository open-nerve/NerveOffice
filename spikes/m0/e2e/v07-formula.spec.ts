// V07 公式一致性：修改公式依赖的单元格后立即保存，快照中的公式结果与重新计算的结果一致（00 号计划书 §7.3）。
// 每个场景在同一个页面里依次做（三次修改各自独立，互不影响判定）：
//   1. 无计算时调用一次等待，测"起始等待"的耗时；空闲 5 秒内有没有计算；
//   2. 修改 1 → 立即捕获（不等待）→ 只用等待接口后捕获；
//   3. 修改 2 → 从修改时刻起按 P3 报告 §3.4 的捕获时机等待后捕获（capture-timing.ts）；
//   4. 修改 3 → 用 50 ms 的超时强制走超时 → 捕获（公式待更新）→ 只用等待接口补捕获 → 按捕获时机补捕获；
//   5. 把第 3 步的快照写回存储：默认模式重开，显示值应等于快照值；forced 模式重开，SDK 重算的结果应等于快照值。
// 另有"快 + 慢两次修改"：静默窗口内再改一次会牵动慢计算的单元格，同时按新旧两种规则等待并各自捕获（审查 R1）。
// 判定有两层：按公式定义从快照的输入独立推算（不依赖 SDK），以及 SDK 的强制重算。
import type { Page } from '@playwright/test';

import { expect, test } from '@playwright/test';
import { browserInfo, SERVERS, waitForEditor, writeResult } from './helpers';
import { brief, detectorMark, detectorState, ensureGenerated, snapshotText } from './p3-helpers';

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
        expectEq('跨表!A1', (num(v(chain, 0, 0)) + 199) * 2, v(cross, 0, 0));
        expectEq('跨表!A2', sumB + num(v(chain, 0, 0)), v(cross, 1, 0));
        // A3 = 聚合!C1 − 聚合!B1 = SUM(B) − B1：用输入独立推算，不取快照里的 C1
        expectEq('跨表!A3', sumB - b[0], v(cross, 2, 0));
    } else if (scenario === 'slow') {
        const slow = sheetOf(snap, '慢');
        for (let i = 0; i < 200; i++) expectEq(`慢!A${i + 1}`, b.filter((x) => x > i * 5).reduce((s, x) => s + x, 0), v(slow, i, 0));
    } else if (scenario === 'volatile') {
        // 易变函数只能核对快照内部的一致性；"是否被重算"另由修改前后的 RAND 比较判定
        const vol = sheetOf(snap, '易变');
        expectEq('易变!A5', num(v(vol, 2, 0)) * 2, v(vol, 4, 0));
        const r = num(v(vol, 3, 0));
        checked += 1;
        if (!(Number.isInteger(r) && r >= 1 && r <= 1_000_000)) out.push({ cell: '易变!A4', expected: Number.NaN, actual: r });
    }
    return { checked, mismatches: out };
}

const randOf = (text: string) => v(sheetOf(JSON.parse(text) as Snapshot, '易变'), 2, 0);

const SCENARIOS = [
    { id: 'chain', sheet: '链', input: 'A1', values: [1000, 2000, 3000] },
    { id: 'aggregate', sheet: '聚合', input: 'B1', values: [99_999, 12_345, 54_321] },
    { id: 'cross-sheet', sheet: '聚合', input: 'B1', values: [77_777, 55_555, 33_333] },
    { id: 'slow', sheet: '聚合', input: 'B1', values: [88_888, 44_444, 22_222] },
    // 易变函数：修改一个无关的单元格，触发一次计算
    { id: 'volatile', sheet: '易变', input: 'C1', values: [1, 2, 3] },
] as const;

/** 修改输入，并按指定方式捕获：none 立即捕获；api 只用等待接口；rule 按 §3.4 的捕获时机；timeout 用 50 ms 超时。 */
async function editAndCapture(page: Page, sheet: string, input: string, value: number, mode: 'none' | 'api' | 'rule' | 'timeout') {
    return page.evaluate(async ({ sheet, input, value, mode }) => {
        const m0 = window.__m0!;
        const editor = m0.editor!;
        const formula = editor.univerAPI.getFormula();
        const ws = editor.univerAPI.getActiveWorkbook()!.getSheetByName(sheet)!;
        const t0 = performance.now();
        ws.getRange(input).setValue(value);
        let outcome = 'none';
        if (mode === 'api') {
            await formula.onCalculationResultApplied(30_000);
            outcome = 'applied';
        } else if (mode === 'rule') {
            outcome = (await m0.waitForCapture!()).formula;
        } else if (mode === 'timeout') {
            try {
                await formula.onCalculationResultApplied(50);
                outcome = 'applied';
            } catch {
                outcome = 'timeout';
            }
        }
        return { text: JSON.stringify(editor.save()), waitMs: performance.now() - t0, outcome };
    }, { sheet, input, value, mode });
}

/** 打开一份存储中的快照，等计算结束后取快照。 */
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

async function openScenarios(page: Page, request: import('@playwright/test').APIRequestContext, worker: boolean): Promise<string> {
    const source = await ensureGenerated(page, request, 'sheet', 'formula-scenarios');
    await page.goto(`/sheet.html?doc=${source}${worker ? '&worker=1' : ''}`);
    await waitForEditor(page);
    await page.evaluate(() => window.__m0!.editor!.univerAPI.getFormula().onCalculationResultApplied(60_000));
    return source;
}

for (const worker of [false, true]) {
    for (const s of SCENARIOS) {
        const name = `${s.id}${worker ? '-worker' : ''}`;
        test(`V07 公式一致性：${name}`, async ({ page, request }, testInfo) => {
            test.setTimeout(300_000);
            await openScenarios(page, request, worker);
            const w = worker ? '&worker=1' : '';

            // 1. 起始等待：没有计算时，等待也要约 500 ms（waitForLatestApplied 的起始看门狗）
            const idleWait = await page.evaluate(async () => {
                const t0 = performance.now();
                await window.__m0!.editor!.univerAPI.getFormula().onCalculationResultApplied(30_000);
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

            // 2. 修改 1：不等待 / 只用等待接口
            const noWait = await editAndCapture(page, s.sheet, s.input, s.values[0], 'none');
            const api = await page.evaluate(async () => {
                const editor = window.__m0!.editor!;
                const t0 = performance.now();
                await editor.univerAPI.getFormula().onCalculationResultApplied(30_000);
                return { text: JSON.stringify(editor.save()), waitMs: performance.now() - t0 };
            });
            await page.evaluate(() => window.__m0!.waitForCapture!());

            // 3. 修改 2：从修改时刻起按捕获时机等待
            const beforeRule = await snapshotText(page);
            const rule = await editAndCapture(page, s.sheet, s.input, s.values[1], 'rule');

            // 4. 修改 3：超时 → 捕获（公式待更新）→ 只用等待接口补捕获 → 按捕获时机补捕获
            const timedOut = await editAndCapture(page, s.sheet, s.input, s.values[2], 'timeout');
            const recaptureApi = await page.evaluate(async () => {
                const editor = window.__m0!.editor!;
                const t0 = performance.now();
                await editor.univerAPI.getFormula().onCalculationResultApplied(120_000);
                return { text: JSON.stringify(editor.save()), waitMs: performance.now() - t0 };
            });
            const recaptureRule = await page.evaluate(async () => {
                const wait = await window.__m0!.waitForCapture!();
                return { text: JSON.stringify(window.__m0!.editor!.save()), ...wait };
            });
            const detections = await detectorState(page, m0);

            // 5. 重开核对（默认模式与强制重算）
            const id = `v07-${testInfo.project.name}-${name}`;
            await request.put(`${SERVERS.off}/api/docs/${id}`, { data: JSON.parse(rule.text) });
            const reopened = await reopenValues(page, id, w);
            const forced = await reopenValues(page, id, `${w}&calc=forced`);

            const checks = {
                noWait: independentCheck(s.id, noWait.text),
                api: independentCheck(s.id, api.text),
                rule: independentCheck(s.id, rule.text),
                timedOut: independentCheck(s.id, timedOut.text),
                recaptureApi: independentCheck(s.id, recaptureApi.text),
                recaptureRule: independentCheck(s.id, recaptureRule.text),
                reopened: independentCheck(s.id, reopened.text),
                forced: independentCheck(s.id, forced.text),
            };
            const volatileRecalculated = s.id === 'volatile' ? randOf(beforeRule) !== randOf(rule.text) : null;
            const result = {
                check: 'V07',
                scenario: s.id,
                worker,
                browser: browserInfo(page, testInfo),
                timestamp: new Date().toISOString(),
                idleWaitMs: idleWait,
                idleCalcSessions: idleSessions,
                waitMs: {
                    api: api.waitMs,
                    rule: rule.waitMs,
                    timeoutAttempt: timedOut.waitMs,
                    recaptureApi: recaptureApi.waitMs,
                    recaptureRule: recaptureRule.waitedMs,
                },
                ruleOutcome: rule.outcome,
                timeoutOutcome: timedOut.outcome,
                volatileRecalculated,
                forcedRecalcMs: forced.calcMs,
                checks: Object.fromEntries(Object.entries(checks).map(([k, c]) => [k, { checked: c.checked, mismatches: c.mismatches.length, sample: c.mismatches.slice(0, 5) }])),
                detections: brief(detections).detections.length,
            };
            await writeResult(`v07/${testInfo.project.name}-${name}.json`, result);

            // 平台需要的保证：按捕获时机的捕获与补捕获、重开与强制重算，都与公式定义一致。
            // 只用等待接口的捕获（api、recaptureApi）在 Worker 模式下可能不一致（SDK 缺陷），只记录不断言。
            expect.soft(checks.rule.mismatches, '按捕获时机捕获').toEqual([]);
            expect.soft(checks.recaptureRule.mismatches, '超时后按捕获时机补捕获').toEqual([]);
            expect.soft(checks.reopened.mismatches, '默认模式重开').toEqual([]);
            expect.soft(checks.forced.mismatches, '强制重算').toEqual([]);
            expect.soft(checks.rule.checked, '核对了单元格').toBeGreaterThan(0);
            if (s.id === 'volatile') expect.soft(volatileRecalculated, '修改无关单元格后易变函数被重算').toBe(true);
        });
    }

    test(`V07 静默窗口内再改一次（快 + 慢）${worker ? '：Worker' : ''}`, async ({ page, request }, testInfo) => {
        test.setTimeout(300_000);
        await openScenarios(page, request, worker);
        // 修改 链!A1（很快算完）后立即开始等待；300 ms 后再改 聚合!B1（牵动 200 个 SUMPRODUCT）。
        // 新规则：capture-timing.ts；旧规则（审查前的 §3.4）：等待接口一次，再等"活动"（检测到的修改或公式结果写回）静默 1 秒。
        const r = await page.evaluate(async () => {
            const m0 = window.__m0!;
            const editor = m0.editor!;
            const api = editor.univerAPI;
            const f = api.getFormula();
            const wb = api.getActiveWorkbook()!;
            let lastApply = 0;
            const sub = api.addEvent(api.Event.CommandExecuted, (e) => {
                if (e.options?.applyFormulaCalculationResult === true) lastApply = performance.now();
            });
            const t0 = performance.now();
            wb.getSheetByName('链')!.getRange('A1').setValue(4242);
            const oldRule = (async () => {
                const q0 = performance.now();
                try {
                    await f.onCalculationResultApplied(15_000);
                } catch {
                    // 照常
                }
                while (performance.now() - q0 < 15_000) {
                    const last = Math.max(editor.detector.lastDetectionAt() ?? 0, lastApply, q0);
                    if (performance.now() - last >= 1000) break;
                    await new Promise((res) => setTimeout(res, 20));
                }
                return { at: performance.now() - t0, text: JSON.stringify(editor.save()) };
            })();
            const newRule = (async () => {
                const wait = await m0.waitForCapture!();
                return { at: performance.now() - t0, text: JSON.stringify(editor.save()), restarts: wait.restarts, formula: wait.formula };
            })();
            await new Promise((res) => setTimeout(res, 300));
            wb.getSheetByName('聚合')!.getRange('B1').setValue(31_337);
            const [old, next] = await Promise.all([oldRule, newRule]);
            await m0.waitForCapture!();
            sub.dispose();
            return { old, next, settled: JSON.stringify(editor.save()) };
        });
        const check = (text: string) => {
            const chain = independentCheck('chain', text);
            const slow = independentCheck('slow', text);
            return { checked: chain.checked + slow.checked, mismatches: chain.mismatches.length + slow.mismatches.length };
        };
        const result = {
            check: 'V07-edit-during-quiet',
            worker,
            browser: browserInfo(page, testInfo),
            timestamp: new Date().toISOString(),
            oldRule: { capturedAtMs: Math.round(r.old.at), ...check(r.old.text) },
            newRule: { capturedAtMs: Math.round(r.next.at), restarts: r.next.restarts, formula: r.next.formula, ...check(r.next.text) },
            settled: check(r.settled),
        };
        await writeResult(`v07/edit-during-quiet/${testInfo.project.name}${worker ? '-worker' : ''}.json`, result);
        expect.soft(result.newRule.mismatches, '新规则：捕获时公式结果完整').toBe(0);
        expect.soft(result.settled.mismatches, '计算结束后模型正确').toBe(0);
    });
}

// 计算进行中再改一次（第二轮审查 S1）：SDK 不把新的修改并进正在进行的一轮，而是排队到这一轮的完成通知之后再开始；
// 与正在计算的范围相交时先发 stop，但计算只在让出点检查 stop，常常照样算完。
// 先改一个牵动慢计算的单元格，300 ms 后（第一轮还在算）再改一处，同时按新旧两种规则等待并各自捕获，核对全部 406 个公式：
//   - 旧规则：审查 S1 之前的 capture-timing.ts（只等"最近一轮"收齐，遇到 stop 视为收齐），在这里内联复现，用来证明场景确实走到了排队的路径；
//   - 新规则：当前的 capture-timing.ts（最近一轮开始之后又有会触发计算的修改、或这一轮被 stop，都不算收齐）。
// 两种等待起点：first 从第一次修改开始等（第二次修改在等待中被检测到、从头重来）；
// second 在第二次修改之后才开始一次新的等待，这时第一轮还在算（对应"打开时的计算还没算完用户就改了"，或检测到修改就立即重新开始等待的实现）。
const QUEUED_CASES = [
    // A：两次都改 聚合!B1，范围相交，走 stop
    { id: 'A-stop', worker: true, interval: undefined, first: ['聚合', 'B1'], second: ['聚合', 'B1'] },
    // B：第一轮只有"聚合"一张表有结果，第二次改 链!A1
    { id: 'B-one-sheet', worker: true, interval: undefined, first: ['聚合', 'B2'], second: ['链', 'A1'] },
    // C：主线程模式的退路（让出间隔 20），第二次修改在两段计算之间执行
    { id: 'C-main-interval20', worker: false, interval: 20, first: ['聚合', 'B1'], second: ['链', 'A1'] },
    // D：对照，Worker，第一轮四张表都有结果
    { id: 'D-worker', worker: true, interval: undefined, first: ['聚合', 'B1'], second: ['链', 'A1'] },
    // E：对照，主线程默认让出间隔：计算整段阻塞主线程，第二次修改要等这一轮算完才执行
    { id: 'E-main', worker: false, interval: undefined, first: ['聚合', 'B1'], second: ['链', 'A1'] },
] as const;

for (const c of QUEUED_CASES) for (const waitFrom of ['first', 'second'] as const) {
    test(`V07 计算进行中再改一次：${c.id}（从${waitFrom === 'first' ? '第一次' : '第二次'}修改开始等）`, async ({ page, request }, testInfo) => {
        test.setTimeout(300_000);
        const source = await ensureGenerated(page, request, 'sheet', 'formula-scenarios');
        await page.goto(`/sheet.html?doc=${source}${c.worker ? '&worker=1' : ''}${c.interval == null ? '' : `&interval=${c.interval}`}`);
        await waitForEditor(page);
        await page.evaluate(() => window.__m0!.waitForCapture!({ debounceMs: 0, timeoutMs: 60_000 }));
        const r = await page.evaluate(async ({ c, waitFrom }) => {
            const m0 = window.__m0!;
            const editor = m0.editor!;
            const api = editor.univerAPI;
            const f = api.getFormula();
            const wb = api.getActiveWorkbook()!;
            const detector = editor.detector;
            const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
            // 审查 S1 之前的判定（内联复现）
            const legacyPending = () => {
                const p = detector.formulaProgress();
                if (!p.started || p.stopped) return false;
                if (p.resultSheets == null) return !p.completed;
                return p.resultSheets.some((key) => {
                    const [unitId, sheetId] = key.split('/');
                    return unitId === wb.getId() && wb.getSheetBySheetId(sheetId) != null && !p.appliedSheets.includes(key);
                });
            };
            const legacyWait = async () => {
                const q0 = performance.now();
                const left = () => Math.max(0, q0 + 15_000 - performance.now());
                for (;;) {
                    const lastEdit = detector.lastDetectionAt();
                    try {
                        await f.onCalculationResultApplied(Math.max(1, left()));
                    } catch {
                        // 照常
                    }
                    while (performance.now() - (detector.lastDetectionAt() ?? q0) < 1000 && left() > 0) await sleep(20);
                    while (legacyPending() && left() > 0) await sleep(20);
                    if (detector.lastDetectionAt() !== lastEdit && left() > 0) continue;
                    break;
                }
            };
            const t0 = performance.now();
            const startWaits = () => [
                (async () => {
                    await legacyWait();
                    return { at: performance.now() - t0, text: JSON.stringify(editor.save()), restarts: 0, formula: '—' };
                })(),
                (async () => {
                    const wait = await m0.waitForCapture!();
                    return { at: performance.now() - t0, text: JSON.stringify(editor.save()), restarts: wait.restarts, formula: wait.formula };
                })(),
            ];
            wb.getSheetByName(c.first[0])!.getRange(c.first[1]).setValue(66_666);
            const early = waitFrom === 'first' ? startWaits() : null;
            await sleep(300);
            // 第二次修改时第一轮是否还在算（主线程默认让出间隔下，这个计时器要等计算结束才触发）
            const before = detector.formulaProgress();
            const secondAt = performance.now() - t0;
            wb.getSheetByName(c.second[0])!.getRange(c.second[1]).setValue(c.second[1] === 'A1' ? 4343 : 55_555);
            const [old, next] = await Promise.all(early ?? startWaits());
            await m0.waitForCapture!();
            const after = detector.formulaProgress();
            return {
                secondAtMs: secondAt,
                firstSessionRunningAtSecondEdit: before.started && !before.completed,
                sessions: after.session - before.session,
                old,
                next,
                settled: JSON.stringify(editor.save()),
            };
        }, { c, waitFrom });
        const check = (text: string) => {
            let checked = 0;
            let mismatches = 0;
            for (const s of ['chain', 'aggregate', 'cross-sheet', 'slow']) {
                const x = independentCheck(s, text);
                checked += x.checked;
                mismatches += x.mismatches.length;
            }
            return { checked, mismatches };
        };
        const result = {
            check: 'V07-edit-during-calc',
            case: c,
            waitFrom,
            browser: browserInfo(page, testInfo),
            timestamp: new Date().toISOString(),
            secondEditAtMs: Math.round(r.secondAtMs),
            firstSessionRunningAtSecondEdit: r.firstSessionRunningAtSecondEdit,
            sessionsAfterSecondEdit: r.sessions,
            oldRule: { capturedAtMs: Math.round(r.old.at), ...check(r.old.text) },
            newRule: { capturedAtMs: Math.round(r.next.at), restarts: r.next.restarts, formula: r.next.formula, ...check(r.next.text) },
            settled: check(r.settled),
        };
        await writeResult(`v07/edit-during-calc/${testInfo.project.name}-${c.id}-from-${waitFrom}.json`, result);
        expect.soft(result.newRule.mismatches, '新规则：捕获时公式结果完整').toBe(0);
        expect.soft(result.newRule.formula, '新规则：没有超时').toBe('settled');
        expect.soft(result.settled.mismatches, '计算结束后模型正确').toBe(0);
    });
}
