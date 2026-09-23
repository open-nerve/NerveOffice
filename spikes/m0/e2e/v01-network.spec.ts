// V01 动态核验：关闭 CSP 运行同样的编辑场景，记录页面与 Worker 发出的全部请求。
// 必须关闭 CSP：被 CSP 拦截的请求在发出前就被取消，请求记录里看不到。
import { expect, test } from '@playwright/test';
import { browserInfo, recordRequests, SERVERS, summarizeRequests, waitForEditor, writeResult } from './helpers';
import { SCENARIOS } from './scenarios';

test.use({ baseURL: SERVERS.off });

for (const s of SCENARIOS) {
    test(`V01 网络核验 ${s.id}`, async ({ page, context }, testInfo) => {
        const requests = recordRequests(context);
        await page.goto(s.path);
        await waitForEditor(page);
        const { checks } = await s.run(page);
        await page.waitForTimeout(1500);

        const net = summarizeRequests(requests, SERVERS.off);
        await writeResult(`v01/network/${testInfo.project.name}-${s.id}.json`, {
            check: 'V01-network',
            scenario: s.id,
            csp: 'off',
            browser: browserInfo(page, testInfo),
            timestamp: new Date().toISOString(),
            functional: checks,
            requests: net,
            urls: [...new Set(requests.map((u) => u.replace(/\?.*$/, '')))],
        });

        for (const c of checks) expect.soft(c.actual, c.name).toEqual(c.expected);
        expect(net.crossOrigin, '非同源请求').toEqual([]);
    });
}
