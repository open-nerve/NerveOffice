// V13 CSP 复核（P5，P4 交接）：在文字文档的代表性流程里（含排版 Worker、中文输入、粘贴、表情与符号、大纲侧栏），
// 收集强制策略与探测策略（去掉 data:、blob:、'unsafe-inline' 的只报告策略，server/csp.ts）的违规，
// 确认 P4 建议去掉的 font-src data:、worker-src blob: 在这些场景下也没有被触发。
import type { Page } from '@playwright/test';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { browserInfo, SERVERS, waitForEditor, writeResult } from './helpers';
import { cspViolations, fixtureFile, insertViaFileChooser, syntheticPaste } from './p4-helpers';
import { endOffset, focusEditor, imeCompose, offsetOf, PLATFORM, press, ribbonTab, setSelection } from './p5-helpers';

const html = (name: string) => readFileSync(join(import.meta.dirname, '..', 'fixtures', 'paste', `${name}.html`), 'utf8');

async function groups(page: Page) {
    const v = await cspViolations(page);
    const group = (enforce: boolean) => {
        const counts: Record<string, number> = {};
        for (const x of v.filter((y) => (y.disposition === 'enforce') === enforce)) {
            const scheme = /^(data|blob|inline|eval|https?)/.exec(x.blocked)?.[1] ?? x.blocked.slice(0, 30);
            const key = `${x.directive} ${scheme}`;
            counts[key] = (counts[key] ?? 0) + 1;
        }
        return counts;
    };
    await page.evaluate(() => {
        window.__m0!.events.cspViolations.length = 0;
    });
    return { enforce: group(true), probe: group(false) };
}

for (const worker of [false, true]) {
    test(`V13 CSP：文字文档的代表性流程${worker ? '（排版 Worker）' : ''}`, async ({ page, context }, testInfo) => {
        test.setTimeout(300_000);
        if (testInfo.project.name !== 'webkit') await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(SERVERS.full).origin });
        const q = `${PLATFORM}&outline=1${worker ? '&worker=1' : ''}`;
        const steps: Record<string, unknown>[] = [];
        const step = async (label: string) => steps.push({ step: label, ...(await groups(page)) });
        await page.goto(`${SERVERS.full}/doc.html?sample=doc-all&${q}`);
        await waitForEditor(page);
        await page.waitForTimeout(1000);
        await step('加载 doc-all（含大纲侧栏）');
        await focusEditor(page);
        await setSelection(page, (await offsetOf(page, '正文段落')) + 2);
        await page.keyboard.type('abc', { delay: 30 });
        await imeCompose(page, testInfo.project.name === 'webkit' ? 'webkit' : 'cdp', { steps: ['n', 'ni', 'ni h', 'ni hao'], commit: '你好' });
        await page.getByRole('navigation', { name: '文档大纲' }).getByRole('button', { name: '三级标题' }).click();
        await page.waitForTimeout(500);
        await step('键入、中文输入、大纲导航');
        await setSelection(page, await endOffset(page));
        await syntheticPaste(page, { html: html('word-win'), text: 'Word' });
        await page.waitForTimeout(1000);
        await syntheticPaste(page, { html: html('web-article'), text: 'web' });
        await page.waitForTimeout(1000);
        await setSelection(page, await endOffset(page));
        await insertViaFileChooser(page, 'doc.command.insert-float-image', [fixtureFile('blue-120x80.png')]);
        await page.waitForTimeout(1200);
        await syntheticPaste(page, { files: [fixtureFile('orange-64x64.png')] });
        await page.waitForTimeout(1200);
        await step('粘贴 Word 与网页、插入与粘贴图片');
        await setSelection(page, (await offsetOf(page, '居中段落')) + 2);
        await ribbonTab(page, '插入');
        await page.locator('[data-u-command="doc.menu.insert-emoji"]').first().click();
        await page.waitForTimeout(500);
        await page.locator('button').filter({ hasText: /^😀$/ }).first().click();
        await page.waitForTimeout(300);
        await page.locator('[data-u-command="doc.menu.insert-symbol"]').first().click();
        await page.getByRole('button', { name: '※', exact: true }).click();
        await page.waitForTimeout(300);
        await ribbonTab(page, '开始');
        await press(page, 'Mod+f');
        await page.getByPlaceholder('输入查找内容').fill('标题');
        await page.waitForTimeout(500);
        await page.keyboard.press('Escape');
        await setSelection(page, await offsetOf(page, '右对齐段落'), (await offsetOf(page, '右对齐段落')) + 5);
        await press(page, 'Mod+c');
        await setSelection(page, await endOffset(page));
        await press(page, 'Mod+v');
        await page.waitForTimeout(800);
        await step('表情、符号、查找、复制粘贴');
        const all = steps.flatMap((s) => [...Object.keys((s as { enforce: object }).enforce), ...Object.keys((s as { probe: object }).probe)]);
        await writeResult(`v13/csp/${testInfo.project.name}${worker ? '-worker' : ''}.json`, { check: 'V13-csp', worker, browser: browserInfo(page, testInfo), timestamp: new Date().toISOString(), steps });
        for (const s of steps) expect.soft((s as { enforce: object }).enforce, `${(s as { step: string }).step}：没有强制违规`).toEqual({});
        expect.soft(all.filter((k) => k.startsWith('font-src')), '没有触发 font-src').toEqual([]);
        expect.soft(all.filter((k) => k.startsWith('worker-src')), '没有触发 worker-src').toEqual([]);
    });
}
