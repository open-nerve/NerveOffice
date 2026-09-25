// V13 文字文档的性能（P5，00 号计划书 §12.1 的文字样本；必须单独运行）：
// doc-20k-full（约 2 万汉字，含标题、列表、8 个表格、10 张图片）与小样本 p5-cap，主线程与排版 Worker 各测一次：
// - 打开：Ready、Rendered、Steady（各打开 3 次取中位数）；
// - 内存：页面与 Worker 的 JS 堆（CDP，只有 Chromium 内核）；
// - 键入响应：在正文中间键入 30 个 ASCII 字符，每次 keydown 到两次 requestAnimationFrame 之后；
// - 输入法响应：10 次拼音组合（每次 6 次更新），每次 compositionupdate 与 compositionend 到两次 requestAnimationFrame 之后
//   （Chromium 内核用 CDP，WebKit 用合成事件）；
// - 事件循环与帧间隔：键入与组合期间的最长阻塞。
import type { CDPSession, Page } from '@playwright/test';

import { test } from '@playwright/test';
import { browserInfo, SERVERS, waitForEditor, writeResult } from './helpers';
import { ensureGenerated } from './p3-helpers';
import { imeCompose } from './p5-helpers';
import { heaps, median, stats, watchWorkers } from './perf-helpers';

test.use({ baseURL: SERVERS.off });

const OPENS = 3;

async function openTimings(page: Page) {
    return page.evaluate(() => {
        const t = window.__m0!.editor!.timings;
        return { ready: t.ready, rendered: t.rendered, steady: t.steady };
    });
}

/** 正文中间的一个普通文字位置（不在表格里、前后都是汉字）。 */
async function middleOffset(page: Page): Promise<number> {
    return page.evaluate(() => {
        const b = window.__m0!.editor!.univerAPI.getActiveDocument()!.getBody();
        const inTable = (i: number) => (b.tables ?? []).some((t) => i > t.startIndex && i < t.endIndex);
        for (let i = Math.floor(b.dataStream.length / 2); i < b.dataStream.length; i++) {
            if (!inTable(i) && /[一-鿿]/.test(b.dataStream[i - 1] ?? '') && /[一-鿿]/.test(b.dataStream[i] ?? '')) return i;
        }
        return 1;
    });
}

async function focusAt(page: Page, offset: number): Promise<void> {
    await page.evaluate((offset) => {
        const editor = window.__m0!.editor!;
        editor.univerAPI.getActiveDocument()!.setSelection(offset, offset);
        document.getElementById(`__editor_${editor.unitId()}`)?.focus();
    }, offset);
    await page.waitForTimeout(300);
}

for (const sample of ['doc-20k-full', 'p5-cap'] as const) {
    for (const worker of [false, true]) {
        test(`V13 性能：${sample}${worker ? '（排版 Worker）' : ''}`, async ({ page, request, browser, browserName }, testInfo) => {
            test.setTimeout(900_000);
            let query = `sample=${sample}`;
            if (sample === 'doc-20k-full') {
                const generator = await browser.newContext({ baseURL: SERVERS.off });
                const id = await ensureGenerated(await generator.newPage(), request, 'doc', 'doc-20k-full');
                await generator.close();
                query = `doc=${id}`;
            }
            const url = `/doc.html?${query}${worker ? '&worker=1' : ''}`;
            const cdp: CDPSession | null = browserName === 'chromium' ? await page.context().newCDPSession(page) : null;
            const workers = cdp != null ? watchWorkers(cdp) : new Map<string, string>();
            if (cdp != null) await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: false });
            // 1. 打开
            const opens: { ready: number; rendered: number; steady: number }[] = [];
            for (let i = 0; i < OPENS; i++) {
                await page.goto(url);
                await waitForEditor(page);
                opens.push(await openTimings(page));
            }
            const size = await page.evaluate(() => {
                const b = window.__m0!.editor!.univerAPI.getActiveDocument()!.getBody();
                return { chars: (b.dataStream.match(/[一-鿿]/g) ?? []).length, tables: b.tables?.length ?? 0, images: b.customBlocks?.length ?? 0, bytes: new TextEncoder().encode(JSON.stringify(window.__m0!.editor!.save())).length };
            });
            await page.waitForTimeout(1500);
            const heapAfterOpen = await heaps(cdp, workers);
            // 2. 键入响应
            await focusAt(page, await middleOffset(page));
            await page.evaluate(() => {
                const w = window as unknown as { __lat: { key: number[]; update: number[]; end: number[] }; __probe?: unknown };
                w.__lat = { key: [], update: [], end: [] };
                const after2 = (bucket: number[]) => {
                    const t = performance.now();
                    requestAnimationFrame(() => requestAnimationFrame(() => bucket.push(performance.now() - t)));
                };
                document.addEventListener('keydown', () => after2(w.__lat.key), true);
                document.addEventListener('compositionupdate', () => after2(w.__lat.update), true);
                document.addEventListener('compositionend', () => after2(w.__lat.end), true);
            });
            await page.evaluate(() => {
                const perf = window.__m0!.perf!;
                (window as unknown as { __blk: unknown }).__blk = { lag: perf.probeEventLoopLag(), frames: perf.probeFrameGap() };
            });
            await page.keyboard.type('abcdefghij0123456789klmnopqrst', { delay: 40 });
            await page.waitForTimeout(500);
            const typing = await page.evaluate(() => {
                const b = (window as unknown as { __blk: { lag: { stop(): { maxGap: number } }; frames: { stop(): { maxGap: number } } } }).__blk;
                return { blockMs: b.lag.stop().maxGap, frameGapMs: b.frames.stop().maxGap };
            });
            // 3. 输入法响应
            await page.evaluate(() => {
                const perf = window.__m0!.perf!;
                (window as unknown as { __blk: unknown }).__blk = { lag: perf.probeEventLoopLag(), frames: perf.probeFrameGap() };
            });
            const driver = browserName === 'webkit' ? 'webkit' : 'cdp';
            for (let k = 0; k < 10; k++) {
                await imeCompose(page, driver, { steps: ['z', 'zh', 'zho', 'zhon', 'zhong', 'zhong w'], commit: '中文' }, 40);
                await page.waitForTimeout(80);
            }
            await page.waitForTimeout(500);
            const ime = await page.evaluate(() => {
                const b = (window as unknown as { __blk: { lag: { stop(): { maxGap: number } }; frames: { stop(): { maxGap: number } } } }).__blk;
                return { blockMs: b.lag.stop().maxGap, frameGapMs: b.frames.stop().maxGap };
            });
            const lat = await page.evaluate(() => (window as unknown as { __lat: { key: number[]; update: number[]; end: number[] } }).__lat);
            const heapAfterEdit = await heaps(cdp, workers);
            const committed = await page.evaluate(() => (window.__m0!.editor!.univerAPI.getActiveDocument()!.getBody().dataStream.match(/中文/g) ?? []).length);
            await writeResult(`v13/perf/${testInfo.project.name}-${sample}${worker ? '-worker' : ''}.json`, {
                check: 'V13-perf', sample, worker, browser: browserInfo(page, testInfo), timestamp: new Date().toISOString(), size,
                open: { runs: opens, median: { ready: median(opens.map((o) => o.ready)), rendered: median(opens.map((o) => o.rendered)), steady: median(opens.map((o) => o.steady)) } },
                heap: { afterOpen: heapAfterOpen, afterEdit: heapAfterEdit },
                typing: { latency: lat.key.length > 0 ? stats(lat.key) : null, ...typing },
                ime: { driver, update: lat.update.length > 0 ? stats(lat.update) : null, end: lat.end.length > 0 ? stats(lat.end) : null, committed, ...ime },
            });
        });
    }
}
