// V08 捕获成本（00 号计划书 §7.2 ①、§12.2）：save()、序列化、gzip、SHA-256 的耗时与主线程阻塞。
// 另测：打开自检（捕获 + 资源比较）、资源加载错误捕获（guard=1）的开销、规范化内容哈希的开销（审查 R7），
// 以及按 P3 报告 §3.4 的捕获时机，从修改到压缩与哈希完成的端到端耗时（审查 R3：没有依赖公式、牵动少量公式、牵动约 320 个公式三种修改）。
import type { CaptureMeasurement } from '../src/harness/perf';

import { test } from '@playwright/test';
import { browserInfo, SERVERS, waitForEditor, writeResult } from './helpers';
import { ensureGenerated, waitQuiet } from './p3-helpers';

test.use({ baseURL: SERVERS.off });

const SAMPLES = [
    { kind: 'sheet' as const, builder: 'big-1m' },
    { kind: 'sheet' as const, builder: 'big-5m' },
    { kind: 'doc' as const, builder: 'doc-20k' },
    { kind: 'doc' as const, builder: 'doc-1m' },
];

const RUNS = 10;
const WARMUP = 2;

function stats(values: number[]) {
    const sorted = [...values].sort((a, b) => a - b);
    const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
    return { p50: at(50), p95: at(95), max: sorted[sorted.length - 1], min: sorted[0], n: sorted.length };
}

function summarize(runs: CaptureMeasurement[]) {
    const pick = (k: keyof CaptureMeasurement) => stats(runs.map((r) => r[k] as number));
    return {
        saveMs: pick('saveMs'),
        stringifyMs: pick('stringifyMs'),
        syncMs: pick('syncMs'),
        gzipMs: pick('gzipMs'),
        hashMs: pick('hashMs'),
        totalMs: pick('totalMs'),
        asyncMaxGapMs: pick('asyncMaxGapMs'),
        longestTaskMs: runs[0].longTasks == null ? null : stats(runs.map((r) => Math.max(0, ...(r.longTasks ?? []).map((t) => t.duration)))),
        jsonBytes: runs[0].jsonBytes,
        gzipBytes: runs[0].gzipBytes,
        ratio: runs[0].gzipBytes / runs[0].jsonBytes,
    };
}

for (const s of SAMPLES) {
    test(`V08 捕获成本：${s.kind}-${s.builder}`, async ({ page, request }, testInfo) => {
        test.setTimeout(600_000);
        const id = await ensureGenerated(page, request, s.kind, s.builder);
        await page.goto(`/${s.kind}.html?doc=${id}`);
        await waitForEditor(page);
        await waitQuiet(page);

        // 1. 捕获管道：预热后测 RUNS 次
        const runs = await page.evaluate(async ({ runs, warmup }) => {
            const m0 = window.__m0!;
            const out: CaptureMeasurement[] = [];
            for (let i = 0; i < warmup + runs; i++) {
                const r = await m0.perf!.measureCapture(m0.editor!);
                if (i >= warmup) out.push(r);
                await new Promise((res) => setTimeout(res, 200));
            }
            return out;
        }, { runs: RUNS, warmup: WARMUP });

        // 2. 打开自检：加载后立即捕获一次，与刚加载的快照比较资源
        const selfCheck = await page.evaluate(async (runs) => {
            const m0 = window.__m0!;
            const loaded = JSON.parse(m0.loadedText!) as { resources?: { name: string; data: string }[] };
            const declared = m0.editor!.declaredResources();
            const times: number[] = [];
            for (let i = 0; i < runs; i++) {
                const t0 = performance.now();
                const saved = m0.editor!.save() as { resources?: { name: string; data: string }[] };
                m0.guard!.compareResources(loaded.resources, saved.resources, declared);
                times.push(performance.now() - t0);
                await new Promise((res) => setTimeout(res, 100));
            }
            return times;
        }, RUNS);

        // 3. 规范化内容哈希（跨加载比较、服务端"内容相同不递增修订号"要用的口径）：规范化 + SHA-256，只测表格
        let canonical: { canonicalMs: number[]; hashMs: number[] } | null = null;
        if (s.kind === 'sheet') {
            canonical = await page.evaluate(async (n) => {
                const m0 = window.__m0!;
                const canonicalMs: number[] = [];
                const hashMs: number[] = [];
                for (let i = 0; i < n; i++) {
                    const text = JSON.stringify(m0.editor!.save());
                    const t0 = performance.now();
                    const c = m0.content!.canonicalContent(text);
                    const t1 = performance.now();
                    await m0.perf!.sha256Hex(new TextEncoder().encode(c));
                    canonicalMs.push(t1 - t0);
                    hashMs.push(performance.now() - t1);
                    await new Promise((res) => setTimeout(res, 100));
                }
                return { canonicalMs, hashMs };
            }, 5);
        }

        // 4. 端到端（表格 1 MiB）：修改 → 按捕获时机等待（capture-timing.ts）→ 捕获管道。
        //    没有依赖公式：改 D2；牵动一个行合计公式：改 D11（T11 = SUM(D11:S11)）。
        let endToEnd: Record<string, number[]> | null = null;
        if (s.builder === 'big-1m') {
            endToEnd = await page.evaluate(async (n) => {
                const m0 = window.__m0!;
                const editor = m0.editor!;
                const ws = editor.univerAPI.getActiveWorkbook()!.getActiveSheet();
                const run = async (cell: string, i: number) => {
                    const t0 = performance.now();
                    ws.getRange(cell).setValue(1000 + i);
                    await m0.waitForCapture!();
                    await m0.perf!.measureCapture(editor);
                    return performance.now() - t0;
                };
                const out: Record<string, number[]> = { noDependent: [], oneFormula: [] };
                for (let i = 0; i < n; i++) out.noDependent.push(await run('D2', i));
                for (let i = 0; i < n; i++) out.oneFormula.push(await run('D11', i));
                return out;
            }, 5);
        }

        await writeResult(`v08/capture/${testInfo.project.name}-${s.kind}-${s.builder}.json`, {
            check: 'V08-capture',
            sample: s.builder,
            kind: s.kind,
            browser: browserInfo(page, testInfo),
            timestamp: new Date().toISOString(),
            capture: summarize(runs),
            selfCheckMs: stats(selfCheck),
            canonical: canonical == null ? null : { canonicalMs: stats(canonical.canonicalMs), hashMs: stats(canonical.hashMs) },
            endToEndMs: endToEnd == null ? null : Object.fromEntries(Object.entries(endToEnd).map(([k, xs]) => [k, stats(xs)])),
            raw: runs.map((r) => ({ ...r, longTasks: r.longTasks?.length ?? null })),
        });
    });
}

// 端到端（性能基线样本）：改数据表 D 列（被约 320 个公式依赖）→ 按捕获时机等待 → 捕获管道；主线程与 Worker 两种模式
for (const worker of [false, true]) {
    test(`V08 端到端：perf-50k${worker ? '-worker' : ''}`, async ({ page, request }, testInfo) => {
        test.setTimeout(300_000);
        const id = await ensureGenerated(page, request, 'sheet', 'perf-50k');
        await page.goto(`/sheet.html?doc=${id}${worker ? '&worker=1' : ''}`);
        await waitForEditor(page);
        await waitQuiet(page);
        const out = await page.evaluate(async (n) => {
            const m0 = window.__m0!;
            const editor = m0.editor!;
            const ws = editor.univerAPI.getActiveWorkbook()!.getSheetByName('数据表')!;
            const totals: number[] = [];
            const waits: number[] = [];
            for (let i = 0; i < n; i++) {
                const t0 = performance.now();
                ws.getRange(`D${i + 2}`).setValue(700 + i);
                const wait = await m0.waitForCapture!();
                await m0.perf!.measureCapture(editor);
                totals.push(performance.now() - t0);
                waits.push(wait.waitedMs);
            }
            return { totals, waits };
        }, 5);
        await writeResult(`v08/end-to-end/${testInfo.project.name}-perf-50k${worker ? '-worker' : ''}.json`, {
            check: 'V08-end-to-end',
            sample: 'perf-50k',
            worker,
            browser: browserInfo(page, testInfo),
            timestamp: new Date().toISOString(),
            totalMs: stats(out.totals),
            waitMs: stats(out.waits),
            raw: out,
        });
    });
}

// 资源加载错误捕获的开销：同一份样本，guard 开与不开各打开 5 次，比较到 Rendered 的耗时
for (const kind of ['sheet', 'doc'] as const) {
    test(`V08 资源加载错误捕获的开销：${kind}`, async ({ page }, testInfo) => {
        test.setTimeout(300_000);
        const sample = kind === 'sheet' ? 'sheet-all' : 'doc-all';
        const measure = async (guard: boolean) => {
            const out: number[] = [];
            for (let i = 0; i < 5; i++) {
                await page.goto(`/${kind}.html?sample=${sample}${guard ? '&guard=1' : ''}`);
                await waitForEditor(page);
                out.push(await page.evaluate(() => window.__m0!.editor!.timings.rendered));
            }
            return out;
        };
        const off = await measure(false);
        const on = await measure(true);
        await writeResult(`v08/guard-overhead/${testInfo.project.name}-${kind}.json`, {
            check: 'V08-guard-overhead',
            sample,
            browser: browserInfo(page, testInfo),
            timestamp: new Date().toISOString(),
            renderedMs: { off: stats(off), on: stats(on) },
            raw: { off, on },
        });
    });
}
