// V10 性能基线（00 号计划书 §12.1、§12.2）：5 万单元格 + 1,000 公式的表格样本。
// 首屏（从导航开始到 Rendered，第一次打开与之后的打开分开）、第一次键盘输入被接受的时间、编辑响应（按键到下一帧）、
// 公式计算（增量与全量，以及计算期间主线程的最长阻塞与界面冻结）、内存（Chromium 内核：页面与公式 Worker 各自的 JS 堆）、打开过程中的长任务。
// 数据只作相对基线（M0 总设计 §7），正式压测在 M7；Playwright 以无头模式运行；n = 5 时 p95 就是最大值。
import type { CDPSession, Page } from '@playwright/test';

import { test } from '@playwright/test';
import { browserInfo, cellCenter, SERVERS, waitForEditor, writeResult } from './helpers';
import { brief, contentDiff, detectorState, ensureGenerated, storedText, waitQuiet } from './p3-helpers';

test.use({ baseURL: SERVERS.off });

const OPENS = 5;

function stats(values: number[]) {
    const sorted = [...values].sort((a, b) => a - b);
    const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
    return { p50: at(50), p95: at(95), max: sorted[sorted.length - 1], min: sorted[0], n: sorted.length };
}

const median = (xs: number[]) => stats(xs).p50;

/** 公式 Worker 的 CDP 会话：自动附加到页面新建的 Worker（只有 Chromium 内核支持）。 */
function watchWorkers(cdp: CDPSession): Map<string, string> {
    const workers = new Map<string, string>();
    cdp.on('Target.attachedToTarget', (e) => {
        if (e.targetInfo.type === 'worker') workers.set(e.sessionId, e.targetInfo.url);
    });
    cdp.on('Target.detachedFromTarget', (e) => {
        workers.delete(e.sessionId);
    });
    return workers;
}

async function workerHeap(cdp: CDPSession, sessionId: string): Promise<number | null> {
    let seq = 9000;
    const call = (method: string) => new Promise<Record<string, unknown>>((resolve) => {
        const id = (seq += 1);
        const onMessage = (e: { sessionId?: string; message: string }) => {
            if (e.sessionId !== sessionId) return;
            const m = JSON.parse(e.message) as { id?: number; result?: Record<string, unknown> };
            if (m.id !== id) return;
            cdp.off('Target.receivedMessageFromTarget', onMessage);
            resolve(m.result ?? {});
        };
        cdp.on('Target.receivedMessageFromTarget', onMessage);
        void cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method }) });
    });
    await call('HeapProfiler.collectGarbage');
    const usage = await call('Runtime.getHeapUsage');
    return typeof usage.usedSize === 'number' ? usage.usedSize : null;
}

/** 先强制垃圾回收，再读页面主线程与各个 Worker 的 JS 堆（Runtime.getHeapUsage）。 */
async function heaps(cdp: CDPSession | null, workers: Map<string, string>) {
    if (cdp == null) return null;
    await cdp.send('HeapProfiler.collectGarbage');
    const main = (await cdp.send('Runtime.getHeapUsage')).usedSize;
    const worker: number[] = [];
    for (const sessionId of workers.keys()) {
        const used = await workerHeap(cdp, sessionId);
        if (used != null) worker.push(used);
    }
    return { main, workers: worker, total: main + worker.reduce((s, x) => s + x, 0) };
}

async function openTimings(page: Page) {
    return page.evaluate(() => {
        const m0 = window.__m0!;
        const t = m0.editor!.timings;
        const tasks = (m0.events.longTasks ?? []).filter((x) => x.start <= t.t0 + t.rendered);
        return {
            rendered: t.t0 + t.rendered,
            steady: t.t0 + t.steady,
            longTasks: m0.events.longTasks == null ? -1 : tasks.length,
            longestTask: Math.max(0, ...tasks.map((x) => x.duration)),
        };
    });
}

for (const worker of [false, true]) {
    test(`V10 性能基线：perf-50k${worker ? '-worker' : ''}`, async ({ page, request, browser, browserName }, testInfo) => {
        test.setTimeout(900_000);
        // 样本在另一个浏览器上下文里生成：同一个上下文生成过样本，编辑器代码已经进了缓存，"第一次打开"就不是冷启动（第二轮审查 S2）
        const generator = await browser.newContext({ baseURL: SERVERS.off });
        const id = await ensureGenerated(await generator.newPage(), request, 'sheet', 'perf-50k');
        await generator.close();
        const url = `/sheet.html?doc=${id}${worker ? '&worker=1' : ''}`;
        const cdp = browserName === 'chromium' ? await page.context().newCDPSession(page) : null;
        const workers = cdp == null ? new Map<string, string>() : watchWorkers(cdp);
        if (cdp != null) await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: false });

        // 1. 首屏：OPENS 次，从导航开始计时；第一次打开时 Worker 脚本还没有缓存，单独列出
        const opens: Awaited<ReturnType<typeof openTimings>>[] = [];
        for (let i = 0; i < OPENS; i++) {
            await page.goto(url);
            await waitForEditor(page);
            opens.push(await openTimings(page));
        }
        await waitQuiet(page);
        const heapAfterOpen = await heaps(cdp, workers);

        // 2. 第一次键盘输入被接受的时间：画布一出现就点 K3、键入 abc 并回车；等 Steady 后看提交时间与内容落在哪里
        const k3 = await cellCenter(page, 'K3');
        const stored = await storedText(request, id);
        const firstInput: Record<string, unknown>[] = [];
        for (let i = 0; i < 3; i++) {
            await page.goto(url);
            await page.waitForFunction(() => {
                const c = document.querySelector('canvas[id^="univer-sheet-main-canvas"]') as HTMLCanvasElement | null;
                return c != null && c.width > 0;
            }, null, { polling: 10, timeout: 60_000 });
            const canvasAt = await page.evaluate(() => performance.now());
            await page.mouse.click(k3.x, k3.y);
            await page.keyboard.type('abc');
            await page.keyboard.press('Enter');
            const typedAt = await page.evaluate(() => performance.now());
            await waitForEditor(page);
            await waitQuiet(page);
            const state = await detectorState(page);
            const after = await page.evaluate(() => JSON.stringify(window.__m0!.editor!.save()));
            const r = await page.evaluate(() => {
                const e = window.__m0!.editor!;
                const set = e.detector.state().detections.find((d) => d.id === 'sheet.mutation.set-range-values');
                return {
                    rendered: e.timings.t0 + e.timings.rendered,
                    committedAt: set?.t ?? null,
                    k3: e.univerAPI.getActiveWorkbook()!.getActiveSheet().getRange('K3').getValue(),
                };
            });
            firstInput.push({
                canvasAt: Math.round(canvasAt),
                typedAt: Math.round(typedAt),
                ...r,
                accepted: r.k3 === 'abc',
                detections: brief(state).detections,
                diff: contentDiff(stored, after).slice(0, 5),
            });
        }
        await page.goto(url);
        await waitForEditor(page);
        await waitQuiet(page);

        // 3. 编辑响应：在 10 个单元格中各键入 8 个 ASCII 字符并回车；每次按键测到下一帧（两次 rAF）。
        //    汉字由输入法经 insertText 送入、不触发 keydown，所以这里只测 ASCII；中文输入的响应由 P5 覆盖。
        await page.evaluate(() => {
            const samples: number[] = [];
            (window as unknown as { __keyLatency: number[] }).__keyLatency = samples;
            document.addEventListener('keydown', () => {
                const t = performance.now();
                requestAnimationFrame(() => requestAnimationFrame(() => samples.push(performance.now() - t)));
            }, true);
        });
        for (let i = 0; i < 10; i++) {
            const p = await cellCenter(page, `L${i + 3}`);
            await page.mouse.click(p.x, p.y);
            await page.keyboard.type('abcd1234', { delay: 30 });
            await page.keyboard.press('Enter');
            await page.waitForTimeout(200);
        }
        await page.waitForTimeout(500);
        const keyLatency = await page.evaluate(() => (window as unknown as { __keyLatency: number[] }).__keyLatency);

        // 4. 公式计算：增量（修改 D 列的一个数据单元格，牵动约 320 个公式：行合计、D 列的统计与条件统计、300 个 VLOOKUP）
        //    与全量（强制重算全部公式）。同时测计算期间界面的冻结，三种口径互相印证：
        //    事件循环延迟探针（三个浏览器）、帧间隔（三个浏览器）、最长的长任务（只有 Chromium 内核支持 Long Tasks）。
        const formula = await page.evaluate(async () => {
            const m0 = window.__m0!;
            const perf = m0.perf!;
            const api = m0.editor!.univerAPI;
            const f = api.getFormula();
            const ws = api.getActiveWorkbook()!.getSheetByName('数据表')!;
            await m0.waitForCapture!({ debounceMs: 0 });
            const measure = async (act: () => void) => {
                const lag = perf.probeEventLoopLag();
                const frames = perf.probeFrameGap();
                const tasks = perf.observeLongTasks();
                const t0 = performance.now();
                act();
                // 只用捕获等待（其中已发起等待接口，并逐表收齐）；再单独调一次等待接口会多出约 500 ms 的起始等待
                await m0.waitForCapture!({ debounceMs: 0, timeoutMs: 120_000 });
                const ms = performance.now() - t0;
                const blockMs = lag.stop().maxGap;
                const frameGapMs = frames.stop().maxGap;
                const longTasks = await tasks.stop();
                return { ms, blockMs, frameGapMs, longestTaskMs: tasks.supported ? Math.max(0, ...longTasks.map((x) => x.duration)) : null };
            };
            const incremental = [];
            for (let i = 0; i < 5; i++) incremental.push(await measure(() => ws.getRange(`D${i + 2}`).setValue(500 + i)));
            const full = [];
            for (let i = 0; i < 3; i++) full.push(await measure(() => f.executeCalculation()));
            return { incremental, full };
        });
        const pick = (xs: typeof formula.full, key: 'ms' | 'blockMs' | 'frameGapMs' | 'longestTaskMs') => {
            const values = xs.map((x) => x[key]).filter((v): v is number => v != null);
            return values.length === 0 ? null : stats(values);
        };

        // 5. 内存：再做 50 次编辑后读取
        await page.evaluate(async () => {
            const ws = window.__m0!.editor!.univerAPI.getActiveWorkbook()!.getSheetByName('数据表')!;
            for (let i = 0; i < 50; i++) ws.getRange(`E${i + 2}`).setValue(i);
            await window.__m0!.waitForCapture!();
        });
        const heapAfterEdits = await heaps(cdp, workers);

        const rendered = opens.map((o) => o.rendered);
        await writeResult(`v10/${testInfo.project.name}-perf-50k${worker ? '-worker' : ''}.json`, {
            check: 'V10',
            worker,
            browser: browserInfo(page, testInfo),
            timestamp: new Date().toISOString(),
            firstScreen: {
                renderedMs: stats(rendered),
                renderedColdMs: rendered[0],
                renderedWarmMedianMs: median(rendered.slice(1)),
                steadyMs: stats(opens.map((o) => o.steady)),
                longTasksBeforeRendered: opens.map((o) => o.longTasks),
                longestTaskBeforeRenderedMs: stats(opens.map((o) => o.longestTask)),
            },
            firstInput,
            keyLatencyMs: stats(keyLatency),
            // 从修改到这一轮公式结果逐表收齐（capture-timing.ts 的判定，不含 1 秒防抖）
            formulaMs: { incremental: pick(formula.incremental, 'ms'), full: pick(formula.full, 'ms') },
            // 计算期间主线程的最长阻塞（事件循环延迟探针，分辨率约 4 ms）
            formulaBlockMs: { incremental: pick(formula.incremental, 'blockMs'), full: pick(formula.full, 'blockMs') },
            // 计算期间界面最长没有刷新的时间（帧间隔）
            formulaFrameGapMs: { incremental: pick(formula.incremental, 'frameGapMs'), full: pick(formula.full, 'frameGapMs') },
            // 计算期间最长的长任务（只有 Chromium 内核有数据）
            formulaLongestTaskMs: { incremental: pick(formula.incremental, 'longestTaskMs'), full: pick(formula.full, 'longestTaskMs') },
            heapBytes: { afterOpen: heapAfterOpen, afterEdits: heapAfterEdits },
            raw: { opens, keyLatency, formula },
        });
    });
}

// 主线程模式的另一种做法：调小公式引擎的让出间隔（intervalCount，SDK 默认每 500 个公式让出一次主线程）。
// 同样的增量与全量计算，比较到结果收齐的时间与计算期间的冻结；只测公式计算，不重复首屏与内存。
test('V10 公式的让出间隔（主线程模式）', async ({ page, request }, testInfo) => {
    test.setTimeout(600_000);
    const id = await ensureGenerated(page, request, 'sheet', 'perf-50k');
    const out: Record<string, unknown>[] = [];
    for (const interval of [500, 100, 20, 5]) {
        await page.goto(`/sheet.html?doc=${id}&interval=${interval}`);
        await waitForEditor(page);
        await waitQuiet(page);
        const r = await page.evaluate(async () => {
            const m0 = window.__m0!;
            const perf = m0.perf!;
            const api = m0.editor!.univerAPI;
            const ws = api.getActiveWorkbook()!.getSheetByName('数据表')!;
            const measure = async (act: () => void) => {
                const lag = perf.probeEventLoopLag();
                const frames = perf.probeFrameGap();
                const tasks = perf.observeLongTasks();
                const t0 = performance.now();
                act();
                await m0.waitForCapture!({ debounceMs: 0, timeoutMs: 120_000 });
                const ms = performance.now() - t0;
                const blockMs = lag.stop().maxGap;
                const frame = frames.stop();
                const longTasks = await tasks.stop();
                // 最长的长任务：区分"主线程真的被一段计算占住"与"setTimeout 被其他任务推后"（第二轮审查 S8）
                return { ms, blockMs, frameGapMs: frame.maxGap, frames: frame.frames, longestTaskMs: tasks.supported ? Math.max(0, ...longTasks.map((x) => x.duration)) : null };
            };
            const incremental = [];
            for (let i = 0; i < 3; i++) incremental.push(await measure(() => ws.getRange(`D${i + 2}`).setValue(600 + i)));
            const full = [];
            for (let i = 0; i < 2; i++) full.push(await measure(() => api.getFormula().executeCalculation()));
            return { incremental, full };
        });
        out.push({ interval, ...r });
    }
    await writeResult(`v10/interval/${testInfo.project.name}.json`, {
        check: 'V10-interval',
        browser: browserInfo(page, testInfo),
        timestamp: new Date().toISOString(),
        results: out,
    });
});
