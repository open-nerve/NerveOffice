// V04：复现"插件缺失导致资源丢失"，以及资源损坏、重复资源名、晚注册几种情况；验证防护规则的判定结果。
// 防护规则：服务端检查（结构、白名单、条目不得消失）、客户端打开自检（加载后立即捕获比较），
// 以及资源加载错误捕获（依赖注入覆盖 IResourceManagerService，guard=1）。
import type { Page } from '@playwright/test';

import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonical, compareResources, openCheckFails, serverRejects } from '../src/harness/resource-guard';
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
    const declared = await page.evaluate(() => window.__m0!.editor!.declaredResources());
    const events = await page.evaluate(() => window.__m0!.events);
    const loadFailures = await page.evaluate(() => window.__m0!.resourceLoadFailures ?? []);
    page.off('pageerror', onError);
    return { snapshot, declared, pageErrors, consoleErrors: events.consoleErrors, loadFailures };
}

/** 完整档案声明的资源名：作为服务端白名单。 */
async function whitelistOf(page: Page, kind: Kind): Promise<string[]> {
    return (await openAndSave(page, `/${kind}.html?sample=empty`)).declared;
}

function judge(before: Snapshot, after: Snapshot, whitelist: string[]) {
    const comparison = compareResources(before.resources, after.resources, whitelist);
    return { comparison, serverRejects: serverRejects(comparison), openCheckFails: openCheckFails(comparison) };
}

/** 不走资源的数据：表格超链接与单元格图片在单元格富文本里；文字文档的图片与链接也有一份在正文里。 */
function inlineData(kind: Kind, s: Snapshot) {
    if (kind === 'sheet') {
        const text = JSON.stringify(s.sheets);
        let cellImages = 0;
        for (const sheet of Object.values(s.sheets as Record<string, { cellData?: Record<string, Record<string, any>> }>)) {
            for (const row of Object.values(sheet.cellData ?? {})) {
                for (const cell of Object.values(row)) if (Object.keys(cell?.p?.drawings ?? {}).length > 0) cellImages++;
            }
        }
        return { cellHyperlinks: text.match(/"rangeType":0/g)?.length ?? 0, cellImages };
    }
    return {
        bodyDrawings: Object.keys((s as { drawings?: object }).drawings ?? {}).length,
        bodyHyperlinks: ((s as { body?: { customRanges?: unknown[] } }).body?.customRanges ?? []).length,
    };
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
        const inline = { before: inlineData(c.kind, s0), after: inlineData(c.kind, r.snapshot) };
        await writeResult(`v04/missing/${testInfo.project.name}-${c.kind}-${c.group}.json`, {
            check: 'V04-missing-plugin',
            browser: browserInfo(page, testInfo),
            timestamp: new Date().toISOString(),
            case: c,
            ...j,
            inline,
            pageErrors: r.pageErrors,
            consoleErrors: r.consoleErrors,
        });
        expect.soft(inline.after, '不走资源的数据保留').toEqual(inline.before);
        expect.soft(r.pageErrors, '缺插件时页面没有报错（丢失是静默的）').toEqual([]);
        if (c.resource != null) {
            expect.soft(j.comparison.missing, '资源丢失可以复现').toEqual([c.resource]);
            expect.soft(j.serverRejects, '服务端检查能拦住').toBe(true);
            expect.soft(j.openCheckFails, '客户端打开自检能拦住').toBe(true);
        } else {
            expect.soft(j.comparison.missing, '没有资源丢失').toEqual([]);
        }
    });
}

// 情况 2：资源损坏。平台里"上一版"就是损坏的快照，所以两种检查都拿损坏版与"加载后立即保存"的结果比较
const CORRUPT = [
    { kind: 'sheet' as Kind, sample: 'sheet-cf', resource: 'SHEET_CONDITIONAL_FORMATTING_PLUGIN', mode: 'invalid-json', expect: 'emptied' },
    { kind: 'sheet' as Kind, sample: 'sheet-dv', resource: 'SHEET_DATA_VALIDATION_PLUGIN', mode: 'invalid-json', expect: 'emptied' },
    { kind: 'sheet' as Kind, sample: 'sheet-note', resource: 'SHEET_NOTE_PLUGIN', mode: 'invalid-json', expect: 'emptied' },
    { kind: 'sheet' as Kind, sample: 'sheet-drawing', resource: 'SHEET_DRAWING_PLUGIN', mode: 'invalid-json', expect: 'emptied' },
    { kind: 'sheet' as Kind, sample: 'sheet-filter', resource: 'SHEET_FILTER_PLUGIN', mode: 'invalid-json', expect: 'emptied' },
    { kind: 'sheet' as Kind, sample: 'sheet-cf', resource: 'SHEET_CONDITIONAL_FORMATTING_PLUGIN', mode: 'wrong-shape', expect: 'garbage' },
    { kind: 'doc' as Kind, sample: 'doc-drawing', resource: 'DOC_DRAWING_PLUGIN', mode: 'invalid-json', expect: 'emptied' },
    { kind: 'doc' as Kind, sample: 'doc-hyperlink', resource: 'DOC_HYPER_LINK_PLUGIN', mode: 'invalid-json', expect: 'regenerated' },
] as const;

for (const c of CORRUPT) {
    test(`V04 资源损坏 ${c.sample}/${c.mode}`, async ({ page, request }, testInfo) => {
        const whitelist = await whitelistOf(page, c.kind);
        const s0 = await fixture(c.kind, c.sample);
        const corrupted = structuredClone(s0);
        const entry = corrupted.resources!.find((r) => r.name === c.resource)!;
        entry.data = c.mode === 'invalid-json' ? entry.data.slice(0, Math.floor(entry.data.length / 2)) : JSON.stringify({ unexpected: 'shape', value: 42 });
        const id = `corrupt-${testInfo.project.name}-${c.sample}-${c.mode}`;
        await request.put(`${SERVERS.off}/api/docs/${id}`, { data: corrupted });

        const plain = await openAndSave(page, `/${c.kind}.html?doc=${id}`);
        const guarded = await openAndSave(page, `/${c.kind}.html?doc=${id}&guard=1`);
        const j = judge(corrupted, plain.snapshot, whitelist);
        const after = plain.snapshot.resources?.find((x) => x.name === c.resource)?.data ?? '';
        await writeResult(`v04/corrupt/${testInfo.project.name}-${c.sample}-${c.mode}.json`, {
            check: 'V04-corrupt-resource',
            browser: browserInfo(page, testInfo),
            timestamp: new Date().toISOString(),
            case: c,
            afterLoad: after.slice(0, 300),
            ...j,
            loadErrorCapture: guarded.loadFailures,
            pageErrors: plain.pageErrors,
            consoleErrors: plain.consoleErrors,
        });

        expect.soft(guarded.loadFailures.map((f) => f.name), '资源加载错误捕获能发现').toContain(c.resource);
        if (c.expect === 'emptied') {
            expect.soft(j.comparison.emptied, '资源被清空').toEqual([c.resource]);
            expect.soft(j.serverRejects, '服务端检查拦不住（变为空不能作为拒绝理由）').toBe(false);
            expect.soft(j.openCheckFails, '打开自检能拦住').toBe(true);
        } else if (c.expect === 'regenerated') {
            expect.soft(canonical(after), '资源从正文重新生成，与损坏前一致').toBe(canonical(s0.resources!.find((x) => x.name === c.resource)!.data));
        } else {
            expect.soft(j.openCheckFails, '结构错误只靠资源比较拦不住').toBe(false);
        }
    });
}

test('V04 资源加载错误捕获：正常样本不误报', async ({ page }, testInfo) => {
    const samples = [['sheet', 'sheet-all'], ['doc', 'doc-all'], ['sheet', 'minimal'], ['doc', 'minimal']] as const;
    const results: Record<string, unknown> = {};
    for (const [kind, name] of samples) {
        const r = await openAndSave(page, `/${kind}.html?sample=${name}&guard=1`);
        results[`${kind}/${name}`] = r.loadFailures;
        expect.soft(r.loadFailures, `${kind}/${name} 没有误报`).toEqual([]);
    }
    await writeResult(`v04/guard-no-false-positive-${testInfo.project.name}.json`, {
        check: 'V04-guard-no-false-positive',
        browser: browserInfo(page, testInfo),
        timestamp: new Date().toISOString(),
        results,
    });
});

// 情况 3：重复资源名。SDK 加载时取第一条，比较时若取最后一条就会被绕过
test('V04 重复资源名', async ({ page, request }, testInfo) => {
    const whitelist = await whitelistOf(page, 'doc');
    const s0 = await fixture('doc', 'doc-hyperlink');
    const original = s0.resources!.find((r) => r.name === 'DOC_HYPER_LINK_PLUGIN')!;
    const evil = JSON.parse(original.data) as { links: { id: string; payload: string }[] };
    evil.links = evil.links.map((l) => ({ ...l, payload: 'https://evil.example/phish' }));
    const forged = structuredClone(s0);
    const index = forged.resources!.findIndex((r) => r.name === 'DOC_HYPER_LINK_PLUGIN');
    // 伪造的一条放在前面，原样的一条放在后面
    forged.resources!.splice(index, 0, { name: 'DOC_HYPER_LINK_PLUGIN', data: JSON.stringify(evil) });
    const id = `dup-${testInfo.project.name}`;
    await request.put(`${SERVERS.off}/api/docs/${id}`, { data: forged });
    const r = await openAndSave(page, `/doc.html?doc=${id}`);
    const urls = ((r.snapshot as { body?: { customRanges?: { properties?: { url?: string } }[] } }).body?.customRanges ?? []).map((x) => x.properties?.url);
    const j = judge(s0, forged, whitelist);
    await writeResult(`v04/duplicate-${testInfo.project.name}.json`, {
        check: 'V04-duplicate-resource',
        browser: browserInfo(page, testInfo),
        timestamp: new Date().toISOString(),
        bodyUrlsAfterLoad: urls,
        serverCheckOnForged: j,
    });
    expect.soft(urls.every((u) => u === 'https://evil.example/phish'), 'SDK 采用了第一条（伪造的）资源，正文链接被改写').toBe(true);
    expect.soft(j.comparison.duplicates, '检查能识别重复资源名').toEqual(['DOC_HYPER_LINK_PLUGIN']);
    expect.soft(j.serverRejects, '服务端检查拒绝').toBe(true);
});

// 情况 4：晚注册。文档创建之后再注册插件组，确认资源被补加载
// 注：文字文档超链接的资源可以从正文重新生成，这个用例区分不了"补加载"与"重新生成"，只作参考
const LATE = [
    { kind: 'sheet' as Kind, group: 'cf', sample: 'sheet-cf' },
    { kind: 'sheet' as Kind, group: 'note', sample: 'sheet-note' },
    { kind: 'doc' as Kind, group: 'hyperlink', sample: 'doc-hyperlink' },
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
        const semantics = await page.evaluate(() => window.__m0!.editor!.semantics());
        const j = judge(s0, s1, whitelist);
        await writeResult(`v04/late/${testInfo.project.name}-${c.kind}-${c.group}.json`, {
            check: 'V04-late-register',
            browser: browserInfo(page, testInfo),
            timestamp: new Date().toISOString(),
            case: c,
            ...j,
            semantics,
            pageErrors,
            consoleErrors: await page.evaluate(() => window.__m0!.events.consoleErrors),
        });
        expect.soft([...j.comparison.missing, ...j.comparison.emptied, ...j.comparison.changed], '晚注册不应丢失或改变资源').toEqual([]);
        expect.soft(pageErrors, '页面错误').toEqual([]);
    });
}
