// V10 性能基线（00 号计划书 §12.1、§12.2）：5 万单元格 + 1,000 公式的表格样本。
// 首屏（从导航开始到 Rendered，第一次打开与之后的打开分开）、第一次键盘输入被接受的时间、编辑响应（按键到下一帧）、
// 公式计算（增量与全量，以及计算期间主线程的最长阻塞）、内存（Chromium 内核：页面与公式 Worker 各自的 JS 堆）、打开过程中的长任务。
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
    test(`V10 性能基线：perf-50k${worker ? '-worker' : ''}`, async ({ page, request, browserName }, testInfo) => {
        test.setTimeout(900_000);
        const id = await ensureGenerated(page, request, 'sheet', 'perf-50k');
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

        // 4. 公式计算：增量（修改一个数据单元格）与全量（强制重算全部公式）；同时测计算期间主线程的最长阻塞（界面冻结）
        const formula = await page.evaluate(async () => {
            const m0 = window.__m0!;
            const api = m0.editor!.univerAPI;
            const f = api.getFormula();
            const ws = api.getActiveWorkbook()!.getSheetByName('数据表')!;
            const incremental: number[] = [];
            const incrementalBlock: number[] = [];
            for (let i = 0; i < 5; i++) {
                const probe = m0.perf!.probeEventLoopLag();
                const t0 = performance.now();
                ws.getRange(`D${i + 2}`).setValue(500 + i);
                await m0.waitForCapture!({ debounceMs: 0 });
                incremental.push(performance.now() - t0);
                incrementalBlock.push(probe.stop().maxGap);
            }
            const full: number[] = [];
            const fullBlock: number[] = [];
            for (let i = 0; i < 3; i++) {
                const probe = m0.perf!.probeEventLoopLag();
                const t0 = performance.now();
                f.executeCalculation();
                await f.onCalculationResultApplied(120_000);
                await m0.waitForCapture!({ debounceMs: 0 });
                full.push(performance.now() - t0);
                fullBlock.push(probe.stop().maxGap);
            }
            return { incremental, full, incrementalBlock, fullBlock };
        });

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
            formulaMs: { incremental: stats(formula.incremental), full: stats(formula.full) },
            // 计算期间主线程的最长阻塞（事件循环延迟探针，分辨率约 4 ms）
            formulaBlockMs: { incremental: stats(formula.incrementalBlock), full: stats(formula.fullBlock) },
            heapBytes: { afterOpen: heapAfterOpen, afterEdits: heapAfterEdits },
            raw: { opens, keyLatency, formula },
        });
    });
}
