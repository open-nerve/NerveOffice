// V07 探针（P3 报告 §3.3 第 2、3 条的证据，审查 R8）：修改"聚合!B1"（牵动 200 个 SUMPRODUCT）后，
// 记录主线程上公式相关 mutation 的到达顺序、每张表的写回、等待接口返回的时刻，以及那一刻"慢!A1"是否已经是新值；
// 同时每 250 ms 采样一次，看计算期间主线程是否被阻塞（主线程模式下采样会停住）。
import { test } from '@playwright/test';
import { browserInfo, SERVERS, waitForEditor, writeResult } from './helpers';
import { ensureGenerated } from './p3-helpers';

test.use({ baseURL: SERVERS.off });

for (const worker of [true, false]) {
    test(`V07 公式写回时间线${worker ? '：Worker' : '：主线程'}`, async ({ page, request }, testInfo) => {
        test.setTimeout(240_000);
        const id = await ensureGenerated(page, request, 'sheet', 'formula-scenarios');
        await page.goto(`/sheet.html?doc=${id}${worker ? '&worker=1' : ''}`);
        await waitForEditor(page);
        const r = await page.evaluate(async () => {
            const api = window.__m0!.editor!.univerAPI;
            const f = api.getFormula();
            const wb = api.getActiveWorkbook()!;
            await f.onCalculationResultApplied(60_000);
            const slowA1 = () => wb.getSheetByName('慢')!.getRange('A1').getValue();
            const sheetName = (sheetId: unknown) => wb.getSheets().find((s) => s.getSheetId() === sheetId)?.getSheetName() ?? String(sheetId);
            const before = slowA1();
            const t0 = performance.now();
            const log: string[] = [];
            const at = () => Math.round(performance.now() - t0);
            const sub = api.addEvent(api.Event.CommandExecuted, (e) => {
                const p = (e.params ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
                if (e.id.startsWith('formula.mutation.set-formula-calculation')) {
                    const kind = e.id.replace('formula.mutation.set-formula-calculation-', '');
                    const info = p.stageInfo != null ? `stage=${p.stageInfo.stage}` : p.functionsExecutedState !== undefined ? `executed=${p.functionsExecutedState}` : p.unitData != null ? `sheets=${Object.values(p.unitData as Record<string, object>).map((u) => Object.keys(u).map(sheetName).join('、')).join('；')}` : '';
                    log.push(`${at()} ${kind} ${info} 慢!A1=${slowA1()}`);
                } else if (e.options?.applyFormulaCalculationResult === true) {
                    log.push(`${at()} 写回 ${sheetName(p.subUnitId)} 慢!A1=${slowA1()}`);
                }
            });
            // 250 ms 采样：主线程被阻塞时采样会停住
            const samples: number[] = [];
            let sampling = true;
            const tick = () => {
                samples.push(at());
                if (sampling) setTimeout(tick, 250);
            };
            setTimeout(tick, 250);
            let resolvedAt = -1;
            let valueAtResolve: unknown = null;
            wb.getSheetByName('聚合')!.getRange('B1').setValue(88_888);
            await f.onCalculationResultApplied(60_000).then(() => {
                resolvedAt = at();
                valueAtResolve = slowA1();
                log.push(`${resolvedAt} ==== 等待接口返回 慢!A1=${valueAtResolve}`);
            });
            await new Promise((res) => setTimeout(res, 2000));
            sampling = false;
            sub.dispose();
            const gaps = samples.map((t, i) => t - (i === 0 ? 0 : samples[i - 1]));
            return { before, after: slowA1(), resolvedAt, valueAtResolve, log, maxSampleGapMs: Math.max(...gaps), samples: samples.length };
        });
        await writeResult(`v07/timeline/${testInfo.project.name}${worker ? '-worker' : ''}.json`, {
            check: 'V07-timeline',
            worker,
            browser: browserInfo(page, testInfo),
            timestamp: new Date().toISOString(),
            slowA1: { before: r.before, atResolve: r.valueAtResolve, after: r.after },
            staleAtResolve: r.valueAtResolve === r.before,
            resolvedAtMs: r.resolvedAt,
            maxSampleGapMs: r.maxSampleGapMs,
            log: r.log,
        });
    });
}
