// V08 捕获成本（00 号计划书 §7.2 ①、§12.2）：save()、序列化、gzip、SHA-256 的耗时与主线程阻塞。
// 另测：打开自检（捕获 + 资源比较）、资源加载错误捕获（guard=1）的开销、从修改停止到哈希完成的端到端耗时。
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

        // 3. 端到端（只测表格 1 MiB）：修改 → 1 秒防抖 → 等公式写回 → 捕获管道
        let endToEnd: number[] | null = null;
        if (s.builder === 'big-1m') {
            endToEnd = await page.evaluate(async (n) => {
                const m0 = window.__m0!;
                const editor = m0.editor!;
                const ws = editor.univerAPI.getActiveWorkbook()!.getActiveSheet();
                const out: number[] = [];
                for (let i = 0; i < n; i++) {
                    const t0 = performance.now();
                    ws.getRange(`D${i + 2}`).setValue(i * 7);
                    await new Promise((res) => setTimeout(res, 1000));
                    await editor.univerAPI.getFormula().onCalculationResultApplied(30_000);
                    await m0.perf!.measureCapture(editor);
                    out.push(performance.now() - t0);
                }
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
            endToEndMs: endToEnd == null ? null : stats(endToEnd),
            raw: runs.map((r) => ({ ...r, longTasks: r.longTasks?.length ?? null })),
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
