// V14-1、V14-2、V14-5 写入管道的成本（P6，00 号计划书 §7.2、§7.6、§12.2）。必须单独运行。
// 样本与 V08 相同（表格 1 MiB、5 MiB，文字文档 2 万字、1 MiB），发件箱的两种放置方式（main、worker）× 两种持久性（默认、strict）：
// - 管道各段：save()、序列化、编码、去重哈希、gzip、加密、写入 IndexedDB；主线程的同步段与异步段的最长阻塞（事件循环延迟探针，Chromium 内核另有 Long Tasks）；
// - 恢复路径：读取、解密、解压、解析；
// - 端到端：修改 → 按捕获时机等待 → 写入发件箱完成（"已保存在本机"），对照 §12.2 的 2 秒。
import type { Page } from '@playwright/test';
import type { PipelineResult } from '../src/harness/outbox/pipeline';

import { expect, test } from '@playwright/test';
import { browserInfo, SERVERS, writeResult } from './helpers';
import { ensureGenerated, waitQuiet } from './p3-helpers';
import { stats } from './perf-helpers';
import { edit, openWithOutbox } from './p6-helpers';

test.use({ baseURL: SERVERS.off });

type E2eDetail = { e2eMs: number; trigger: string; formulaPending: boolean; skipped: boolean; waitMs: number; pipelineMs: number; syncMs: number; gzipMs: number; putMs: number; workerRoundTripMs: number | null };

/** 最后一次自动保存：端到端、触发原因，以及"等待捕获"（修改 → 管道开始）与"管道"两段。 */
function lastAutosave(page: Page): Promise<E2eDetail> {
    return page.evaluate(() => {
        const h = window.__m0!.outbox!.autosave()!.history;
        const last = h[h.length - 1];
        const r = last.result;
        return {
            e2eMs: last.e2eMs, trigger: last.trigger, formulaPending: last.formulaPending, skipped: r.skipped,
            waitMs: r.startedAt - last.editAt, pipelineMs: r.finishedAt - r.startedAt,
            syncMs: r.syncMs, gzipMs: r.gzipMs, putMs: r.putMs, workerRoundTripMs: r.workerRoundTripMs,
        };
    });
}

const SAMPLES = [
    { kind: 'sheet' as const, builder: 'big-1m' },
    { kind: 'sheet' as const, builder: 'big-5m' },
    { kind: 'doc' as const, builder: 'doc-20k' },
    { kind: 'doc' as const, builder: 'doc-1m' },
];

const RUNS = 10;
const WARMUP = 2;

type Brief = Omit<PipelineResult, 'longTasks'> & { longestTaskMs: number | null };

function summarize(runs: Brief[]) {
    const pick = (k: keyof Brief) => stats(runs.map((r) => (r[k] as number | null) ?? 0));
    return {
        saveMs: pick('saveMs'),
        stringifyMs: pick('stringifyMs'),
        encodeMs: pick('encodeMs'),
        syncMs: pick('syncMs'),
        hashMs: pick('hashMs'),
        gzipMs: pick('gzipMs'),
        encryptMs: pick('encryptMs'),
        putMs: pick('putMs'),
        workerRoundTripMs: runs[0].workerRoundTripMs == null ? null : pick('workerRoundTripMs'),
        totalMs: pick('totalMs'),
        asyncMaxGapMs: pick('asyncMaxGapMs'),
        longestTaskMs: runs[0].longestTaskMs == null ? null : pick('longestTaskMs'),
        jsonBytes: runs[0].jsonBytes,
        gzipBytes: runs[0].gzipBytes,
        cipherBytes: runs[0].cipherBytes,
        errors: runs.filter((r) => r.error != null).length,
    };
}

for (const s of SAMPLES) {
    for (const placement of ['main', 'worker'] as const) {
        test(`V14 写入管道：${s.kind}-${s.builder}，${placement}`, async ({ page, request }, testInfo) => {
            test.setTimeout(600_000);
            const source = await ensureGenerated(page, request, s.kind, s.builder);
            const id = `p6-perf-${s.builder}-${placement}-${testInfo.project.name}`;
            const res = await request.get(`${SERVERS.off}/api/docs/${source}`);
            await request.put(`${SERVERS.off}/api/docs/${id}`, { data: await res.json() });
            const user = `perf-${testInfo.project.name}-${Date.now()}`;
            await openWithOutbox(page, SERVERS.off, { kind: s.kind, doc: id, outbox: placement, user });
            await waitQuiet(page);

            // 1. 管道：两种持久性，预热后各测 RUNS 次
            const capture: Record<string, ReturnType<typeof summarize>> = {};
            for (const durability of ['default', 'strict'] as const) {
                const runs = await page.evaluate(async ({ runs, warmup, durability }) => {
                    const out = [];
                    for (let i = 0; i < warmup + runs; i++) {
                        const r = await window.__m0!.outbox!.capture({ force: true, durability });
                        const { longTasks, ...rest } = r;
                        if (i >= warmup) out.push({ ...rest, longestTaskMs: longTasks == null ? null : Math.max(0, ...longTasks.map((t) => t.duration)) });
                        await new Promise((res) => setTimeout(res, 200));
                    }
                    return out;
                }, { runs: RUNS, warmup: WARMUP, durability });
                capture[durability] = summarize(runs as Brief[]);
            }

            // 2. 恢复路径：读取、解密、解压、解析
            const recovery = await page.evaluate(async () => {
                const out = [];
                for (let i = 0; i < 5; i++) out.push((await window.__m0!.outbox!.inspect()).timings);
                return out;
            });

            // 3. 端到端：修改后停止，等写入发件箱完成；拆成"等待捕获"（修改 → 管道开始）与"管道"两段，便于解释离群值
            const e2e: number[] = [];
            const e2eDetail: E2eDetail[] = [];
            for (let i = 0; i < 5; i++) {
                await edit(page, s.kind, `P6PERF${i}`);
                await page.evaluate(() => window.__m0!.outbox!.autosave()!.idle(20_000));
                const d = await lastAutosave(page);
                expect.soft(d.skipped, `第 ${i + 1} 次修改：捕获真的写入了（没有被去重跳过）`).toBe(false);
                e2e.push(d.e2eMs);
                e2eDetail.push(d);
                await page.waitForTimeout(500);
            }

            await writeResult(`v14/pipeline/${testInfo.project.name}-${s.kind}-${s.builder}-${placement}.json`, {
                check: 'V14-pipeline', sample: `${s.kind}-${s.builder}`, placement, browser: browserInfo(page, testInfo), timestamp: new Date().toISOString(),
                capture,
                recovery: {
                    readMs: stats(recovery.map((r) => r.readMs)),
                    decryptMs: stats(recovery.map((r) => r.decryptMs)),
                    gunzipMs: stats(recovery.map((r) => r.gunzipMs)),
                    parseMs: stats(recovery.map((r) => r.parseMs)),
                },
                e2e: { runs: e2e, ...stats(e2e), detail: e2eDetail },
            });
        });
    }
}

// 端到端（P6 审查 R2）：牵动约 320 个公式的修改（V08 的 perf-50k，改数据表 D 列），公式主线程与公式 Worker 两种模式，
// 发件箱用 Worker 放置（M4 的建议）。"从修改停止到已保存在本机"含公式等待，对照 §12.2 的 2 秒；第一次修改是打开后的第一次
for (const formulaWorker of [false, true]) {
    test(`V14 端到端：perf-50k 牵动约 320 个公式${formulaWorker ? '（公式 Worker）' : '（公式主线程）'}`, async ({ page, request }, testInfo) => {
        test.setTimeout(600_000);
        const source = await ensureGenerated(page, request, 'sheet', 'perf-50k');
        const id = `p6-perf-formula-${formulaWorker ? 'worker' : 'main'}-${testInfo.project.name}`;
        const res = await request.get(`${SERVERS.off}/api/docs/${source}`);
        await request.put(`${SERVERS.off}/api/docs/${id}`, { data: await res.json() });
        const user = `perf-f-${testInfo.project.name}-${Date.now()}`;
        await openWithOutbox(page, SERVERS.off, { kind: 'sheet', doc: id, outbox: 'worker', user, extra: formulaWorker ? 'worker=1' : '' });
        await waitQuiet(page);
        const runs: E2eDetail[] = [];
        for (let i = 0; i < 5; i++) {
            await page.evaluate((i) => window.__m0!.editor!.univerAPI.getActiveWorkbook()!.getSheetByName('数据表')!.getRange(`D${i + 2}`).setValue(700 + i), i);
            await page.evaluate(() => window.__m0!.outbox!.autosave()!.idle(30_000));
            const d = await lastAutosave(page);
            expect.soft(d.skipped, `第 ${i + 1} 次修改：捕获真的写入了（没有被去重跳过）`).toBe(false);
            runs.push(d);
            await page.waitForTimeout(500);
        }
        const e2e = runs.map((r) => r.e2eMs);
        await writeResult(`v14/pipeline-formula/${testInfo.project.name}-${formulaWorker ? 'worker' : 'main'}.json`, {
            check: 'V14-pipeline-formula', formulaWorker, browser: browserInfo(page, testInfo), timestamp: new Date().toISOString(), runs, e2e: stats(e2e),
        });
    });
}

