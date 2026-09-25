// V13 文字文档的性能（P5，00 号计划书 §12.1 的文字样本；必须单独运行）：
// doc-20k-full（约 2 万汉字，含标题、列表、8 个表格、10 张图片）与小样本 p5-cap，主线程与排版 Worker 各测一次：
// - 打开：Ready、Rendered、Steady（各打开 3 次取中位数）；
// - 内存：页面与 Worker 的 JS 堆（CDP，只有 Chromium 内核）；
// - 键入与输入法的响应，两种口径（P5 审查 R1）：
//   · 画出来：从事件的 timeStamp 起，到光标右侧一段画布的像素发生变化（每帧检查），键入间隔 350 ms（不排队）；
//     排版 Worker 模式下排版结果异步回到主线程，只有这个口径量得到"画出来"；
//   · 两帧：从监听器执行起到两次 requestAnimationFrame 之后（P3 的口径），键入间隔 40 ms；只在主线程模式下等于"画出来"；
// - 输入法：10 次拼音组合（每次 6 次更新），Chromium 内核用 CDP，WebKit 用合成事件；
// - 事件循环与帧间隔：快速键入与组合期间的最长阻塞。
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
            // 2a. 画出来的口径：键入间隔 350 ms、每次一个组合更新之后停 350 ms
            const paintAt = await middleOffset(page);
            await focusAt(page, paintAt);
            await page.evaluate(() => {
                const w = window as unknown as { __paint: { key: number[]; update: number[]; missed: number } };
                w.__paint = { key: [], update: [], missed: 0 };
                const canvas = document.querySelector('canvas#univer-doc-main-canvas') as HTMLCanvasElement;
                const ctx = canvas.getContext('2d')!;
                const id = window.__m0!.editor!.unitId();
                /** 光标右侧 3–240 px、一行高的区域的像素摘要（避开光标本身的闪烁）。 */
                const regionHash = (): number => {
                    const el = document.getElementById(`univer-doc-selection-container-${id}`);
                    const rect = canvas.getBoundingClientRect();
                    const r = el?.getBoundingClientRect();
                    const sx = canvas.width / rect.width;
                    const sy = canvas.height / rect.height;
                    const x = Math.max(0, Math.round(((r?.left ?? rect.left) - rect.left + 3) * sx));
                    const y = Math.max(0, Math.round(((r?.top ?? rect.top) - rect.top) * sy));
                    const d = ctx.getImageData(x, y, Math.round(240 * sx), Math.round(22 * sy)).data;
                    let h = 0;
                    for (let i = 0; i < d.length; i += 8) h = (Math.imul(h, 31) + d[i] + d[i + 1] * 3 + d[i + 2] * 7) >>> 0;
                    return h;
                };
                const watch = (bucket: number[], t0: number) => {
                    const before = regionHash();
                    const poll = () => {
                        if (regionHash() !== before) bucket.push(performance.now() - t0);
                        else if (performance.now() - t0 < 2000) requestAnimationFrame(poll);
                        else w.__paint.missed += 1;
                    };
                    requestAnimationFrame(poll);
                };
                document.addEventListener('keydown', (e) => watch(w.__paint.key, e.timeStamp), true);
                document.addEventListener('compositionupdate', (e) => watch(w.__paint.update, e.timeStamp), true);
            });
            await page.keyboard.type('abcdefghij', { delay: 350 });
            await page.waitForTimeout(800);
            const paintDriver = browserName === 'webkit' ? 'webkit' : 'cdp';
            for (let k = 0; k < 5; k++) {
                await imeCompose(page, paintDriver, { steps: ['z', 'zh', 'zho', 'zhon'], commit: '中' }, 350);
                await page.waitForTimeout(300);
            }
            await page.waitForTimeout(800);
            const paint = await page.evaluate(() => (window as unknown as { __paint: { key: number[]; update: number[]; missed: number } }).__paint);
            // 重新打开，免得画出来口径的监听器干扰后面的测量
            await page.goto(url);
            await waitForEditor(page);
            await page.waitForTimeout(1000);
            // 2b. 两帧口径与阻塞：快速键入
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
                typing: { latency: lat.key.length > 0 ? stats(lat.key) : null, painted: paint.key.length > 0 ? stats(paint.key) : null, ...typing },
                ime: { driver, update: lat.update.length > 0 ? stats(lat.update) : null, updatePainted: paint.update.length > 0 ? stats(paint.update) : null, end: lat.end.length > 0 ? stats(lat.end) : null, committed, ...ime },
                paintMissed: paint.missed,
            });
        });
    }
}
