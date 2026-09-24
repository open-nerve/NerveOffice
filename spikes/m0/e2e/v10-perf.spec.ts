// V10 性能基线（00 号计划书 §12.1、§12.2）：5 万单元格 + 1,000 公式的表格样本。
// 首屏（从导航开始到 Rendered）、编辑响应（按键到下一帧）、公式计算（增量与全量）、内存（Chromium）、打开过程中的长任务。
// 数据只作相对基线（M0 总设计 §7），正式压测在 M7。
import type { Page } from '@playwright/test';

import { test } from '@playwright/test';
import { browserInfo, cellCenter, SERVERS, waitForEditor, writeResult } from './helpers';
import { ensureGenerated, waitQuiet } from './p3-helpers';

test.use({ baseURL: SERVERS.off });

const OPENS = 5;

function stats(values: number[]) {
    const sorted = [...values].sort((a, b) => a - b);
    const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
    return { p50: at(50), p95: at(95), max: sorted[sorted.length - 1], min: sorted[0], n: sorted.length };
}

/** Chromium：先强制垃圾回收，再读 JS 堆占用（CDP）；其他浏览器返回 null。 */
async function heapUsed(page: Page, browserName: string): Promise<number | null> {
    if (browserName !== 'chromium') return null;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('Performance.enable');
    const { metrics } = await cdp.send('Performance.getMetrics');
    await cdp.detach();
    return metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? null;
}

for (const worker of [false, true]) {
    test(`V10 性能基线：perf-50k${worker ? '-worker' : ''}`, async ({ page, request, browserName }, testInfo) => {
        test.setTimeout(900_000);
        const id = await ensureGenerated(page, request, 'sheet', 'perf-50k');
        const url = `/sheet.html?doc=${id}${worker ? '&worker=1' : ''}`;

        // 1. 首屏：OPENS 次，从导航开始计时
        const opens: { rendered: number; steady: number; longTasks: number; longestTask: number }[] = [];
        for (let i = 0; i < OPENS; i++) {
            await page.goto(url);
            await waitForEditor(page);
            opens.push(await page.evaluate(() => {
                const m0 = window.__m0!;
                const t = m0.editor!.timings;
                const tasks = (m0.events.longTasks ?? []).filter((x) => x.start <= t.t0 + t.rendered);
                return {
                    rendered: t.t0 + t.rendered,
                    steady: t.t0 + t.steady,
                    longTasks: m0.events.longTasks == null ? -1 : tasks.length,
                    longestTask: Math.max(0, ...tasks.map((x) => x.duration)),
                };
            }));
        }
        await waitQuiet(page);
        const heapAfterOpen = await heapUsed(page, browserName);

        // 2. 编辑响应：在 10 个单元格中各键入 8 个字符并回车；每次按键测到下一帧（两次 rAF）
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
            await page.keyboard.type('测试12345', { delay: 30 });
            await page.keyboard.press('Enter');
            await page.waitForTimeout(200);
        }
        await page.waitForTimeout(500);
        const keyLatency = await page.evaluate(() => (window as unknown as { __keyLatency: number[] }).__keyLatency);

        // 3. 公式计算：增量（修改一个数据单元格）与全量（强制重算全部公式）；同时测计算期间主线程的最长阻塞（界面冻结）
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
                await f.onCalculationResultApplied(120_000);
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
                full.push(performance.now() - t0);
                fullBlock.push(probe.stop().maxGap);
            }
            return { incremental, full, incrementalBlock, fullBlock };
        });

        // 4. 内存：再做 50 次编辑后读取
        await page.evaluate(async () => {
            const ws = window.__m0!.editor!.univerAPI.getActiveWorkbook()!.getSheetByName('数据表')!;
            for (let i = 0; i < 50; i++) ws.getRange(`E${i + 2}`).setValue(i);
            await window.__m0!.editor!.univerAPI.getFormula().onCalculationResultApplied(120_000);
        });
        await waitQuiet(page);
        const heapAfterEdits = await heapUsed(page, browserName);

        await writeResult(`v10/${testInfo.project.name}-perf-50k${worker ? '-worker' : ''}.json`, {
            check: 'V10',
            worker,
            browser: browserInfo(page, testInfo),
            timestamp: new Date().toISOString(),
            firstScreen: {
                renderedMs: stats(opens.map((o) => o.rendered)),
                steadyMs: stats(opens.map((o) => o.steady)),
                longTasksBeforeRendered: opens.map((o) => o.longTasks),
                longestTaskBeforeRenderedMs: stats(opens.map((o) => o.longestTask)),
            },
            keyLatencyMs: stats(keyLatency),
            formulaMs: { incremental: stats(formula.incremental), full: stats(formula.full) },
            // 计算期间主线程的最长阻塞（事件循环延迟探针，分辨率约 4 ms）
            formulaBlockMs: { incremental: stats(formula.incrementalBlock), full: stats(formula.fullBlock) },
            heapBytes: { afterOpen: heapAfterOpen, afterEdits: heapAfterEdits },
            raw: { opens, keyLatency, formula },
        });
    });
}
