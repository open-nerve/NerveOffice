// V12 外部请求（P4，00 号计划书 §11.3）：
// 1. IMAGE()：外链、平台地址、data URL 三种参数 × 三种处理（default、off、restricted）× 主线程与 Worker：
//    单元格显示的值、严格 CSP 下的违规、关掉 CSP 时实际发出的外部请求（page.route 拦截计数）、快照内容；
// 2. 外链图片（文字文档粘贴、Facade）：关掉 CSP 时两种图片服务下实际发出的外部请求。
// 被 CSP 拦截的请求在发出前就被取消，请求记录里看不到，所以"会不会发出请求"要在关掉 CSP 的服务（SERVERS.off）上看。
import type { Page } from '@playwright/test';

import { expect, test } from '@playwright/test';
import { browserInfo, SERVERS, waitForEditor, writeResult } from './helpers';
import { waitQuiet } from './p3-helpers';
import { cspViolations, dataUrl, fixtureFile, syntheticPaste, watchExternalRequests } from './p4-helpers';

const EXTERNAL = 'https://example.invalid/image-formula.png';

async function uploadPlatformImage(page: Page): Promise<string> {
    return page.evaluate(async () => {
        const blob = await (await fetch('/fixtures-assets/blue-120x80.png')).blob();
        const r = await window.__m0!.images!.io().saveImage(new File([blob], 'blue.png', { type: 'image/png' }));
        return r!.source;
    });
}

for (const policy of ['default', 'off', 'restricted'] as const) {
    for (const worker of [false, true]) {
        test(`V12 IMAGE()：${policy}${worker ? '（Worker）' : ''}`, async ({ page }, testInfo) => {
            test.setTimeout(180_000);
            const runs: Record<string, unknown>[] = [];
            for (const base of [SERVERS.full, SERVERS.off]) {
                const origin = new URL(base).origin;
                const external = base === SERVERS.off ? await watchExternalRequests(page, origin) : [];
                await page.goto(`${base}/sheet.html?sample=minimal&img=platform&imagefn=${policy}${worker ? '&worker=1' : ''}`);
                await waitForEditor(page);
                const platform = await uploadPlatformImage(page);
                await page.evaluate(() => {
                    window.__m0!.events.cspViolations.length = 0;
                });
                const r = await page.evaluate(async ({ external, platform, data }) => {
                    const m0 = window.__m0!;
                    const ws = m0.editor!.univerAPI.getActiveWorkbook()!.getActiveSheet();
                    ws.getRange('D2').setValue(`=IMAGE("${external}")`);
                    ws.getRange('D3').setValue(`=IMAGE("${platform}")`);
                    ws.getRange('D4').setValue(`=IMAGE("${data}")`);
                    ws.getRange('D5').setValue('=LEN("abc")');
                    await m0.waitForCapture!({ debounceMs: 0 });
                    await new Promise((res) => setTimeout(res, 2000));
                    const snap = m0.editor!.save() as { sheets: Record<string, { cellData?: Record<string, Record<string, { f?: string; v?: unknown; p?: unknown }>> }> };
                    const cells = Object.values(snap.sheets)[0].cellData ?? {};
                    return {
                        installed: m0.editor!.imageFunctionInstalled(),
                        display: { external: ws.getRange('D2').getDisplayValue(), platform: ws.getRange('D3').getDisplayValue(), data: ws.getRange('D4').getDisplayValue(), len: ws.getRange('D5').getDisplayValue() },
                        // 快照里只应有公式字符串（与缓存值），不应有图片数据
                        snapshot: [1, 2, 3].map((r) => ({ f: cells[r]?.[3]?.f ?? null, v: cells[r]?.[3]?.v ?? null, hasP: cells[r]?.[3]?.p != null })),
                    };
                }, { external: EXTERNAL, platform, data: dataUrl(fixtureFile('orange-64x64.png')) });
                runs.push({
                    csp: base === SERVERS.full ? 'full' : 'off',
                    ...r,
                    externalRequests: [...external],
                    cspEnforced: (await cspViolations(page)).filter((v) => v.disposition === 'enforce').map((v) => `${v.directive} ${v.blocked.slice(0, 60)}`),
                });
                await page.unrouteAll({ behavior: 'ignoreErrors' });
            }
            await writeResult(`v12/image-formula/${testInfo.project.name}-${policy}${worker ? '-worker' : ''}.json`, {
                check: 'V12-image-formula',
                policy,
                worker,
                browser: browserInfo(page, testInfo),
                timestamp: new Date().toISOString(),
                runs,
            });
            for (const run of runs as { csp: string; display: Record<string, string>; externalRequests: string[]; installed: boolean | null }[]) {
                expect.soft(run.display.len, `${run.csp}：普通公式正常`).toBe('3');
                if (policy !== 'default') {
                    expect.soft(run.installed, `${run.csp}：限制已装上`).toBe(true);
                    expect.soft(run.externalRequests, `${run.csp}：没有外部请求`).toEqual([]);
                    expect.soft(run.display.external, `${run.csp}：外链不显示图片`).toBe(policy === 'off' ? '#NAME?' : '#VALUE!');
                }
            }
        });
    }
}

// 外链图片：关掉 CSP 时，两种图片服务下实际发出的外部请求
const EXTERNAL_IMG = 'https://example.invalid/pasted.png';
for (const img of ['default', 'platform'] as const) {
    test(`V12 外链图片的请求：${img}`, async ({ page }, testInfo) => {
        test.setTimeout(180_000);
        const out: Record<string, unknown>[] = [];
        const origin = new URL(SERVERS.off).origin;
        const external = await watchExternalRequests(page, origin);
        // 文字文档粘贴外链图片
        await page.goto(`${SERVERS.off}/doc.html?sample=minimal&img=${img}`);
        await waitForEditor(page);
        await page.evaluate(() => {
            const doc = window.__m0!.editor!.univerAPI.getActiveDocument()!;
            const end = doc.getBody().dataStream.length - 2;
            doc.setSelection(end, end);
        });
        await page.waitForTimeout(300);
        const before = external.length;
        await syntheticPaste(page, { html: `<p>外链<img src="${EXTERNAL_IMG}">图片</p>` });
        await page.waitForTimeout(2000);
        await waitQuiet(page);
        out.push({ path: '文字文档粘贴外链图片', requests: external.slice(before) });
        // Facade：FDocument.insertImage(外链)
        const before2 = external.length;
        await page.evaluate(async (url) => {
            const doc = window.__m0!.editor!.univerAPI.getActiveDocument()!;
            const end = doc.getBody().dataStream.length - 2;
            try {
                await doc.insertImage({ source: url, imageSourceType: 'URL' as never, width: 80, height: 60, textRange: { startOffset: end, endOffset: end } } as never);
            } catch {
                // 记录请求即可
            }
        }, `${EXTERNAL_IMG}?facade`);
        await page.waitForTimeout(2000);
        out.push({ path: 'FDocument.insertImage(外链)', requests: external.slice(before2) });
        // 表格：FWorksheet.insertImage(外链)
        await page.goto(`${SERVERS.off}/sheet.html?sample=minimal&img=${img}&worker=1`);
        await waitForEditor(page);
        const before3 = external.length;
        await page.evaluate(async (url) => {
            try {
                await window.__m0!.editor!.univerAPI.getActiveWorkbook()!.getActiveSheet().insertImage(url, 2, 2);
            } catch {
                // 记录请求即可
            }
        }, `${EXTERNAL_IMG}?sheet`);
        await page.waitForTimeout(2000);
        out.push({ path: 'FWorksheet.insertImage(外链)', requests: external.slice(before3) });
        await writeResult(`v12/external-images/${testInfo.project.name}-${img}.json`, { check: 'V12-external-images', img, browser: browserInfo(page, testInfo), timestamp: new Date().toISOString(), results: out });
        if (img === 'platform') expect.soft((out[0].requests as string[]).length, '平台配置：粘贴外链图片不发出外部请求').toBe(0);
    });
}
