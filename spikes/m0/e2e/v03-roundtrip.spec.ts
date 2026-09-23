// V03：保存 → 重开 → 再保存的保真度（三浏览器），以及运行时注册的资源 hook 清单、保护类资源的影响。
import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compareResources, isEmptyResourceData } from '../src/harness/resource-guard';
import type { DiffEntry } from './diff';

import { canonicalJson, diffJson, expandResources } from './diff';
import { browserInfo, cellCenter, SERVERS, waitForEditor, writeResult } from './helpers';

test.use({ baseURL: SERVERS.off });

const SHEET_SAMPLES = ['minimal', 'sheet-core', 'sheet-cf', 'sheet-dv', 'sheet-filter', 'sheet-hyperlink', 'sheet-note', 'sheet-drawing', 'sheet-protection', 'sheet-all'];
const DOC_SAMPLES = ['minimal', 'doc-text', 'doc-list', 'doc-hyperlink', 'doc-table', 'doc-drawing', 'doc-all'];
const SAMPLES = [...SHEET_SAMPLES.map((name) => ({ kind: 'sheet' as const, name })), ...DOC_SAMPLES.map((name) => ({ kind: 'doc' as const, name }))];

const sha256 = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');

/** 以 JSON 文本取出快照：与平台持久化时一致（例如内存中的 Infinity 会变成 null）。 */
async function saveAsJson(page: import('@playwright/test').Page) {
    return JSON.parse(await page.evaluate(() => JSON.stringify(window.__m0!.editor!.save())));
}

/**
 * 资源数据在"空字符串"与"空对象"之间变化，内容上等价。
 * 原因：资源 hook 晚于文档单元注册时，走 loadHookResource 路径，条目存在就调用 onLoad（即使数据是 ""）；
 * 而文档单元创建时走 loadResources 路径，会跳过空数据。于是缺少条目的快照第一次保存得到 ""，之后得到 "{}"。
 */
function isEmptyEquivalent(d: DiffEntry): boolean {
    if (!/^\$\.resources\[\d+\]\.data/.test(d.path)) return false;
    const parse = (x?: string) => {
        if (x == null) return undefined;
        try {
            return JSON.parse(x);
        } catch {
            return x; // 预览被截断的长值：肯定不是空值
        }
    };
    // 资源内部某个键的取值为空（例如某个工作表对应的空规则数组）时，删掉这个键与保留它在内容上等价
    return isEmptyResourceData(parse(d.before)) && isEmptyResourceData(parse(d.after));
}

function split(diff: DiffEntry[]) {
    return { real: diff.filter((d) => !isEmptyEquivalent(d)), emptyEquivalent: diff.filter(isEmptyEquivalent) };
}

for (const s of SAMPLES) {
    test(`V03 ${s.kind}/${s.name}`, async ({ page, request }, testInfo) => {
        const project = testInfo.project.name;
        const s0 = JSON.parse(await readFile(join(import.meta.dirname, '..', 'fixtures', s.kind, `${s.name}.json`), 'utf8'));
        const pageErrors: string[] = [];
        page.on('pageerror', (e) => pageErrors.push(e.message));

        // 第一次打开：加载样本 S0，得到 S1
        await page.goto(`/${s.kind}.html?sample=${s.name}`);
        await waitForEditor(page);
        const hooks = await page.evaluate(() => window.__m0!.editor!.resourceHooks());
        const s1 = await saveAsJson(page);
        const consoleErrors1 = await page.evaluate(() => window.__m0!.events.consoleErrors);

        // 写回存储，用新页面重开：加载 S1，得到 S2
        const id = `rt-${project}-${s.kind}-${s.name}`;
        await request.put(`${SERVERS.off}/api/docs/${id}`, { data: s1 });
        await page.goto(`/${s.kind}.html?doc=${id}`);
        await waitForEditor(page);
        const s2 = await saveAsJson(page);
        const consoleErrors2 = await page.evaluate(() => window.__m0!.events.consoleErrors);

        // 再来一轮：加载 S2，得到 S3，确认已经收敛
        await request.put(`${SERVERS.off}/api/docs/${id}`, { data: s2 });
        await page.goto(`/${s.kind}.html?doc=${id}`);
        await waitForEditor(page);
        const s3 = await saveAsJson(page);

        const d12 = split(diffJson(expandResources(s1), expandResources(s2)));
        const d23 = diffJson(expandResources(s2), expandResources(s3));
        const fidelity = split(diffJson(expandResources(s0), expandResources(s1)));
        const fidelityDiff = fidelity.real;
        const whitelist = hooks.map((h) => h.name);
        const resources = compareResources(s0.resources, (s1 as { resources?: { name: string; data: string }[] }).resources, whitelist);
        const count = (kind: string) => fidelityDiff.filter((d) => d.kind === kind).length;

        await writeResult(`v03/roundtrip/${project}-${s.kind}-${s.name}.json`, {
            check: 'V03',
            sample: `${s.kind}/${s.name}`,
            browser: browserInfo(page, testInfo),
            timestamp: new Date().toISOString(),
            resourceHooks: hooks,
            // S1→S2：除"空值等价"外不应有差异；S2→S3：必须完全一致
            stable12: d12.real.length === 0,
            stable12Diff: d12.real.slice(0, 100),
            stable12EmptyEquivalent: d12.emptyEquivalent,
            stable23: d23.length === 0,
            stable23Diff: d23.slice(0, 100),
            fidelity: {
                added: count('added'),
                removed: count('removed'),
                changed: count('changed'),
                emptyEquivalent: fidelity.emptyEquivalent.length,
                entries: fidelityDiff.slice(0, 300),
            },
            resources,
            hashes: { s0: sha256(s0), s1: sha256(s1), s2: sha256(s2), s3: sha256(s3) },
            pageErrors,
            consoleErrors: [...consoleErrors1, ...consoleErrors2],
        });
        await writeResult(`v03/s1/${project}-${s.kind}-${s.name}.json`, s1);

        expect.soft(d12.real, 'S1 与 S2 除空值等价外应一致').toEqual([]);
        expect.soft(d23, 'S2 与 S3 应完全一致').toEqual([]);
        expect.soft([...resources.unknown, ...resources.missing, ...resources.emptied], '资源不在白名单、丢失或变空').toEqual([]);
        expect.soft(pageErrors, '页面错误').toEqual([]);
        expect.soft([...consoleErrors1, ...consoleErrors2], '控制台错误').toEqual([]);
    });
}

test('V03 保护类资源对编辑的影响', async ({ page }, testInfo) => {
    await page.goto('/sheet.html?sample=sheet-protection');
    await waitForEditor(page);
    const typeInto = async (a1: string, text: string) => {
        const p = await cellCenter(page, a1);
        await page.mouse.click(p.x, p.y);
        await page.keyboard.type(text);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(500);
        return page.evaluate((cell) => window.__m0!.editor!.univerAPI.getActiveWorkbook()!.getActiveSheet().getRange(cell).getValue(), a1);
    };
    const protectedValue = await typeInto('A1', '尝试修改');
    const freeValue = await typeInto('D10', '可以修改');
    const info = await page.evaluate(async () => {
        const wb = window.__m0!.editor!.univerAPI.getActiveWorkbook()!;
        return wb.getSheets().map((ws) => ({ name: ws.getSheetName(), isProtected: ws.getWorksheetPermission().isProtected() }));
    });
    await writeResult(`v03/protection-${testInfo.project.name}.json`, {
        check: 'V03-protection',
        browser: browserInfo(page, testInfo),
        timestamp: new Date().toISOString(),
        protectedCellA1AfterTyping: protectedValue,
        unprotectedCellD10AfterTyping: freeValue,
        sheets: info,
    });
});
