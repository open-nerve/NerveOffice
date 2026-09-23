// V04：复现"插件缺失导致资源丢失"，以及资源损坏、晚注册两种情况；验证两种防护规则的判定结果。
import type { Page } from '@playwright/test';

import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compareResources, openCheckFails, serverRejects } from '../src/harness/resource-guard';
import { browserInfo, SERVERS, waitForEditor, writeResult } from './helpers';

test.use({ baseURL: SERVERS.off });

type Kind = 'sheet' | 'doc';
interface Snapshot {
    id: string;
    resources?: { name: string; data: string }[];
    [k: string]: unknown;
}

async function fixture(kind: Kind, name: string): Promise<Snapshot> {
    return JSON.parse(await readFile(join(import.meta.dirname, '..', 'fixtures', kind, `${name}.json`), 'utf8'));
}

async function openAndSave(page: Page, url: string) {
    const pageErrors: string[] = [];
    const onError = (e: Error) => pageErrors.push(e.message);
    page.on('pageerror', onError);
    await page.goto(url);
    await waitForEditor(page);
    const snapshot: Snapshot = JSON.parse(await page.evaluate(() => JSON.stringify(window.__m0!.editor!.save())));
    const hooks = await page.evaluate(() => window.__m0!.editor!.resourceHooks().map((h) => h.name));
    const events = await page.evaluate(() => window.__m0!.events);
    page.off('pageerror', onError);
    return { snapshot, hooks, pageErrors, consoleErrors: events.consoleErrors };
}

/** 完整档案下注册的资源名：作为服务端白名单。 */
async function whitelistOf(page: Page, kind: Kind): Promise<string[]> {
    return (await openAndSave(page, `/${kind}.html?sample=empty`)).hooks;
}

function judge(s0: Snapshot, s1: Snapshot, whitelist: string[]) {
    const comparison = compareResources(s0.resources, s1.resources, whitelist);
    return { comparison, serverRejects: serverRejects(comparison), openCheckFails: openCheckFails(comparison) };
}

// 情况 1：插件缺失。组 → 对应样本、预期丢失的资源
const MISSING = [
    { kind: 'sheet' as Kind, group: 'cf', sample: 'sheet-cf', resource: 'SHEET_CONDITIONAL_FORMATTING_PLUGIN' },
    { kind: 'sheet' as Kind, group: 'dv', sample: 'sheet-dv', resource: 'SHEET_DATA_VALIDATION_PLUGIN' },
    { kind: 'sheet' as Kind, group: 'filter', sample: 'sheet-filter', resource: 'SHEET_FILTER_PLUGIN' },
    { kind: 'sheet' as Kind, group: 'note', sample: 'sheet-note', resource: 'SHEET_NOTE_PLUGIN' },
    { kind: 'sheet' as Kind, group: 'drawing', sample: 'sheet-drawing', resource: 'SHEET_DRAWING_PLUGIN' },
    { kind: 'sheet' as Kind, group: 'hyperlink', sample: 'sheet-hyperlink', resource: null },
    { kind: 'doc' as Kind, group: 'drawing', sample: 'doc-drawing', resource: 'DOC_DRAWING_PLUGIN' },
    { kind: 'doc' as Kind, group: 'hyperlink', sample: 'doc-hyperlink', resource: 'DOC_HYPER_LINK_PLUGIN' },
];

for (const c of MISSING) {
    test(`V04 插件缺失 ${c.kind}/${c.group}`, async ({ page }, testInfo) => {
        const whitelist = await whitelistOf(page, c.kind);
        const s0 = await fixture(c.kind, c.sample);
        const r = await openAndSave(page, `/${c.kind}.html?sample=${c.sample}&without=${c.group}`);
        const j = judge(s0, r.snapshot, whitelist);
        // 不走资源的数据：表格超链接存在单元格富文本里，文字文档的图片与链接也有一份在正文里
        const inline = c.kind === 'sheet'
            ? { cellsWithCustomRanges: JSON.stringify(r.snapshot.sheets).match(/"rangeType":0/g)?.length ?? 0 }
            : {
                bodyDrawings: Object.keys((r.snapshot as { drawings?: object }).drawings ?? {}).length,
                bodyHyperlinks: ((r.snapshot as { body?: { customRanges?: unknown[] } }).body?.customRanges ?? []).length,
            };
        await writeResult(`v04/missing/${testInfo.project.name}-${c.kind}-${c.group}.json`, {
            check: 'V04-missing-plugin',
            browser: browserInfo(page, testInfo),
            timestamp: new Date().toISOString(),
            case: c,
            hooksWithoutGroup: r.hooks,
            ...j,
            inline,
            pageErrors: r.pageErrors,
            consoleErrors: r.consoleErrors,
        });
        if (c.resource != null) {
            expect.soft(j.comparison.missing, '资源丢失可以复现').toContain(c.resource);
            expect.soft(j.serverRejects, '服务端检查能拦住').toBe(true);
            expect.soft(j.openCheckFails, '客户端打开自检能拦住').toBe(true);
        }
    });
}

// 情况 2：资源损坏。把资源数据改成非法 JSON，或者合法 JSON 但结构不对
const CORRUPT = [
    { kind: 'sheet' as Kind, sample: 'sheet-cf', resource: 'SHEET_CONDITIONAL_FORMATTING_PLUGIN', mode: 'invalid-json' },
    { kind: 'sheet' as Kind, sample: 'sheet-dv', resource: 'SHEET_DATA_VALIDATION_PLUGIN', mode: 'invalid-json' },
    { kind: 'sheet' as Kind, sample: 'sheet-note', resource: 'SHEET_NOTE_PLUGIN', mode: 'invalid-json' },
    { kind: 'sheet' as Kind, sample: 'sheet-drawing', resource: 'SHEET_DRAWING_PLUGIN', mode: 'invalid-json' },
    { kind: 'sheet' as Kind, sample: 'sheet-filter', resource: 'SHEET_FILTER_PLUGIN', mode: 'invalid-json' },
    { kind: 'sheet' as Kind, sample: 'sheet-cf', resource: 'SHEET_CONDITIONAL_FORMATTING_PLUGIN', mode: 'wrong-shape' },
    { kind: 'doc' as Kind, sample: 'doc-drawing', resource: 'DOC_DRAWING_PLUGIN', mode: 'invalid-json' },
    { kind: 'doc' as Kind, sample: 'doc-hyperlink', resource: 'DOC_HYPER_LINK_PLUGIN', mode: 'invalid-json' },
];

for (const c of CORRUPT) {
    test(`V04 资源损坏 ${c.sample}/${c.mode}`, async ({ page, request }, testInfo) => {
        const whitelist = await whitelistOf(page, c.kind);
        const s0 = await fixture(c.kind, c.sample);
        const corrupted = structuredClone(s0);
        const entry = corrupted.resources!.find((r) => r.name === c.resource)!;
        entry.data = c.mode === 'invalid-json' ? `${entry.data.slice(0, Math.floor(entry.data.length / 2))}` : JSON.stringify({ unexpected: 'shape', value: 42 });
        const id = `corrupt-${testInfo.project.name}-${c.sample}-${c.mode}`;
        await request.put(`${SERVERS.off}/api/docs/${id}`, { data: corrupted });
        const r = await openAndSave(page, `/${c.kind}.html?doc=${id}`);
        // 服务端检查比较的是"上一版"（S0）与"新提交"（S1）；打开自检比较的是"刚加载的快照"（损坏版）与"加载后立即捕获"
        const vsPrevious = judge(s0, r.snapshot, whitelist);
        const openCheck = judge(corrupted, r.snapshot, whitelist);
        await writeResult(`v04/corrupt/${testInfo.project.name}-${c.sample}-${c.mode}.json`, {
            check: 'V04-corrupt-resource',
            browser: browserInfo(page, testInfo),
            timestamp: new Date().toISOString(),
            case: c,
            afterLoad: r.snapshot.resources?.find((x) => x.name === c.resource)?.data.slice(0, 300),
            serverCheckAgainstPrevious: vsPrevious,
            openCheckAgainstLoaded: openCheck,
            pageErrors: r.pageErrors,
            consoleErrors: r.consoleErrors,
        });
    });
}

// 情况 3：晚注册。文档创建之后再注册插件组，确认资源被补加载
const LATE = [
    { kind: 'sheet' as Kind, group: 'cf', sample: 'sheet-cf', resource: 'SHEET_CONDITIONAL_FORMATTING_PLUGIN' },
    { kind: 'sheet' as Kind, group: 'note', sample: 'sheet-note', resource: 'SHEET_NOTE_PLUGIN' },
    { kind: 'doc' as Kind, group: 'hyperlink', sample: 'doc-hyperlink', resource: 'DOC_HYPER_LINK_PLUGIN' },
];

for (const c of LATE) {
    test(`V04 晚注册 ${c.kind}/${c.group}`, async ({ page }, testInfo) => {
        const whitelist = await whitelistOf(page, c.kind);
        const s0 = await fixture(c.kind, c.sample);
        const pageErrors: string[] = [];
        page.on('pageerror', (e) => pageErrors.push(e.message));
        await page.goto(`/${c.kind}.html?sample=${c.sample}&without=${c.group}`);
        await waitForEditor(page);
        await page.evaluate((g) => window.__m0!.editor!.lateRegister(g), c.group);
        await page.waitForTimeout(1500);
        const s1 = JSON.parse(await page.evaluate(() => JSON.stringify(window.__m0!.editor!.save())));
        const j = judge(s0, s1, whitelist);
        await writeResult(`v04/late/${testInfo.project.name}-${c.kind}-${c.group}.json`, {
            check: 'V04-late-register',
            browser: browserInfo(page, testInfo),
            timestamp: new Date().toISOString(),
            case: c,
            ...j,
            pageErrors,
            consoleErrors: await page.evaluate(() => window.__m0!.events.consoleErrors),
        });
        expect.soft(j.comparison.missing.concat(j.comparison.emptied), '晚注册不应丢失资源').toEqual([]);
    });
}
