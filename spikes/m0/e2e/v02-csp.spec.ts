// V02：严格 CSP 下，表格与文字文档编辑器能否加载、编辑（含 Web Worker）。
// 违规从三条渠道采集：页面 securitypolicyviolation 事件、服务端 report-uri 报告、浏览器控制台（含 Worker）。
// 各渠道在不同浏览器、不同作用域下的覆盖范围，由 v02-csp-probe.spec.ts 的阳性对照给出。
import { expect, test } from '@playwright/test';
import { fromConsole, fromPageEvents, fromServer, groupViolations } from './csp-reports';
import { browserInfo, classifyCspConsole, recordConsole, recordRequests, SERVERS, summarizeRequests, waitForEditor, writeResult } from './helpers';
import { SCENARIOS } from './scenarios';

test.use({ baseURL: SERVERS.full });

for (const s of SCENARIOS) {
    test(`V02 ${s.id}`, async ({ page, context, request }, testInfo) => {
        await request.delete(`${SERVERS.full}/__csp-reports`);
        const requests = recordRequests(context);
        const consoleMessages = recordConsole(page);
        const pageErrors: string[] = [];
        page.on('pageerror', (e) => pageErrors.push(e.message));
        const workers: string[] = [];
        page.on('worker', (w) => workers.push(w.url()));

        await page.goto(s.path);
        await waitForEditor(page);
        const { checks, ui } = await s.run(page);
        // 给 report-uri 的异步上报留出时间
        await page.waitForTimeout(1500);

        const pageSide = await page.evaluate(() => window.__m0!.events);
        const timings = await page.evaluate(() => window.__m0!.editor!.timings);
        const workerStats = await page.evaluate(() => window.__m0!.workerStats);
        const violations = [
            ...fromPageEvents(pageSide.cspViolations),
            ...(await fromServer(request, SERVERS.full)),
            ...fromConsole(consoleMessages),
        ];
        const enforce = violations.filter((v) => v.policy === 'enforce');
        const probe = violations.filter((v) => v.policy === 'probe');
        const workerFailures = Object.entries({ ...workerStats.toWorker, ...workerStats.fromWorker })
            .filter(([k]) => /CALL_FAILURE|SUBSCRIBE_ERROR/.test(k));

        const result = {
            check: 'V02',
            scenario: s.id,
            browser: browserInfo(page, testInfo),
            timestamp: new Date().toISOString(),
            timingsNote: '从 createEditor 调用开始计时，不含脚本下载解析与样本加载',
            timings,
            functional: checks,
            ui,
            worker: { expected: s.worker, started: workers, stats: workerStats, failures: workerFailures },
            enforceViolations: enforce,
            probeViolations: { total: probe.length, groups: groupViolations(probe) },
            requests: summarizeRequests(requests, SERVERS.full),
            pageErrors: [...pageErrors, ...pageSide.errors],
            // 页面脚本主动调用 console.error / console.warn 的记录（不含浏览器自己输出的提示）
            scriptConsoleErrors: pageSide.consoleErrors,
            scriptConsoleWarningCount: pageSide.consoleWarnings.length,
            // 浏览器控制台中的错误级消息（含 Worker），CSP 提示已单独归入上面的违规
            browserConsoleErrors: consoleMessages
                .filter((m) => m.type === 'error' && classifyCspConsole(m.text) == null)
                .map((m) => m.text)
                .slice(0, 50),
        };
        await writeResult(`v02/${testInfo.project.name}-${s.id}.json`, result);

        for (const c of checks) expect.soft(c.actual, c.name).toEqual(c.expected);
        expect.soft(enforce, '强制策略的违规（三条渠道）').toEqual([]);
        expect.soft(result.pageErrors, '页面错误').toEqual([]);
        expect.soft(result.browserConsoleErrors, '浏览器控制台错误（CSP 提示除外）').toEqual([]);
        if (s.worker) {
            expect.soft(workers.length, 'Worker 已启动').toBeGreaterThan(0);
            expect.soft(workerStats.fromWorker.CALL_SUCCESS ?? 0, 'Worker 返回过成功的调用').toBeGreaterThan(0);
            expect.soft(workerFailures, 'Worker 调用失败').toEqual([]);
        }
    });
}
