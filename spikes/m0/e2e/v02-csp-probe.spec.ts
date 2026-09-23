// V02 阳性对照：在页面与 Worker 中各触发一次跨源请求和动态代码执行，
// 1) 确认策略确实生效（off 模式下全部放行，证明目标可达、探测动作本身有效）；
// 2) 确认 Worker 内生效的是 Worker 脚本响应上的策略（html-only 模式下 Worker 不受约束）；
// 3) 记录每个浏览器中，各采集渠道能否看到这些违规，为 v02-csp.spec.ts 的"违规为零"界定覆盖范围。
import type { Violation } from './csp-reports';

import { expect, test } from '@playwright/test';
import { fromConsole, fromPageEvents, fromServer } from './csp-reports';
import { browserInfo, recordConsole, SERVERS, writeResult } from './helpers';

const MODES = [
    { mode: 'off', server: SERVERS.off, target: `${SERVERS.full}/index.html` },
    { mode: 'full', server: SERVERS.full, target: `${SERVERS.off}/index.html` },
    { mode: 'html-only', server: SERVERS.htmlOnly, target: `${SERVERS.off}/index.html` },
] as const;

type Outcome = { fetch: string; eval: string; fn: string } | { error: string };

const EXPECTED: Record<(typeof MODES)[number]['mode'], { page: 'allowed' | 'blocked'; worker: 'allowed' | 'blocked' }> = {
    off: { page: 'allowed', worker: 'allowed' },
    full: { page: 'blocked', worker: 'blocked' },
    'html-only': { page: 'blocked', worker: 'allowed' },
};

function simplify(o: Outcome): Record<string, string> {
    if ('error' in o) return { fetch: `error:${o.error}`, eval: `error:${o.error}`, fn: `error:${o.error}` };
    const s = (v: string) => (v.startsWith('blocked') ? 'blocked' : v);
    return { fetch: s(o.fetch), eval: s(o.eval), fn: s(o.fn) };
}

/** 每个探测动作被哪些渠道看到了。 */
function coverage(violations: Violation[], targetOrigin: string) {
    const enforce = violations.filter((v) => v.policy === 'enforce');
    const seen = (scope: 'page' | 'worker', kind: 'fetch' | 'dyncode') => {
        const hits = enforce.filter((v) => v.scope === scope && (kind === 'fetch'
            ? v.directive.startsWith('connect-src') || v.blocked.startsWith(targetOrigin)
            : v.blocked === 'eval' || v.directive.startsWith('script-src')));
        return [...new Set(hits.map((h) => h.channel))];
    };
    return {
        'page-fetch': seen('page', 'fetch'),
        'page-dyncode': seen('page', 'dyncode'),
        'worker-fetch': seen('worker', 'fetch'),
        'worker-dyncode': seen('worker', 'dyncode'),
    };
}

for (const m of MODES) {
    test(`V02 阳性对照 csp=${m.mode}`, async ({ page, request }, testInfo) => {
        await request.delete(`${m.server}/__csp-reports`);
        const consoleMessages = recordConsole(page);
        await page.goto(`${m.server}/csp-probe.html?target=${encodeURIComponent(m.target)}`);
        await page.waitForSelector('body[data-probe="done"]', { timeout: 30_000 });
        await page.waitForTimeout(1500);

        const probe = await page.evaluate(() => window.__probe!);
        const violations = [
            ...fromPageEvents(probe.events.cspViolations),
            ...(m.mode === 'off' ? [] : await fromServer(request, m.server)),
            ...fromConsole(consoleMessages),
        ];
        const outcomes = { page: simplify(probe.page), worker: simplify(probe.worker as Outcome) };
        const expected = EXPECTED[m.mode];
        const targetOrigin = new URL(m.target).origin;

        await writeResult(`v02/probe/${testInfo.project.name}-${m.mode}.json`, {
            check: 'V02-positive-control',
            mode: m.mode,
            browser: browserInfo(page, testInfo),
            timestamp: new Date().toISOString(),
            target: m.target,
            expected,
            outcomes,
            raw: { page: probe.page, worker: probe.worker },
            coverage: m.mode === 'off' ? null : coverage(violations, targetOrigin),
            violations,
        });

        for (const scope of ['page', 'worker'] as const) {
            for (const action of ['fetch', 'eval', 'fn'] as const) {
                expect.soft(outcomes[scope][action], `${scope} ${action}`).toBe(expected[scope]);
            }
        }
    });
}
