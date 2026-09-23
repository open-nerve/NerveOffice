// V05：复制文档时不改 unitId。两份内容与 unitId 完全相同的文档，在两个标签页里同时打开、各自编辑、保存、重开，互不影响。
import type { Page } from '@playwright/test';

import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compareResources, isEmptyResourceData } from '../src/harness/resource-guard';
import { diffJson, expandResources } from './diff';
import { browserInfo, cellCenter, SERVERS, waitForEditor, writeResult } from './helpers';

test.use({ baseURL: SERVERS.off });

type Snapshot = { id: string; resources?: { name: string; data: string }[]; [k: string]: unknown };

const CASES = [
    { kind: 'sheet' as const, sample: 'sheet-all' },
    { kind: 'doc' as const, sample: 'doc-all' },
];

async function edit(page: Page, kind: 'sheet' | 'doc', text: string): Promise<void> {
    if (kind === 'sheet') {
        const p = await cellCenter(page, 'J3');
        await page.mouse.click(p.x, p.y);
        await page.keyboard.type(text);
        await page.keyboard.press('Enter');
    } else {
        const box = (await page.locator('canvas#univer-doc-main-canvas').boundingBox())!;
        await page.mouse.click(box.x + box.width / 2, box.y + 120);
        await page.keyboard.type(text);
    }
    await page.waitForTimeout(500);
}

async function snapshotText(page: Page): Promise<string> {
    return page.evaluate(() => JSON.stringify(window.__m0!.editor!.save()));
}

/** 与原文档的差异：去掉资源内部的"空值等价"后，只应剩下这次编辑本身。 */
function realDiff(original: Snapshot, edited: Snapshot) {
    const parse = (x?: string) => {
        if (x == null) return undefined;
        try {
            return JSON.parse(x);
        } catch {
            return x;
        }
    };
    return diffJson(expandResources(original), expandResources(edited)).filter(
        (d) => !(/^\$\.resources\[\d+\]\.data/.test(d.path) && isEmptyResourceData(parse(d.before)) && isEmptyResourceData(parse(d.after))),
    );
}

for (const c of CASES) {
    test(`V05 复制不改 unitId：${c.kind}`, async ({ context, request }, testInfo) => {
        const project = testInfo.project.name;
        const original: Snapshot = JSON.parse(await readFile(join(import.meta.dirname, '..', 'fixtures', c.kind, `${c.sample}.json`), 'utf8'));
        const idA = `copy-${project}-${c.kind}-A`;
        const idB = `copy-${project}-${c.kind}-B`;
        await request.put(`${SERVERS.off}/api/docs/${idA}`, { data: original });
        await request.post(`${SERVERS.off}/api/docs/${idA}/copy?to=${idB}`);

        // 两个标签页同时打开 A 与 B
        const pageA = await context.newPage();
        const pageB = await context.newPage();
        await Promise.all([pageA.goto(`/${c.kind}.html?doc=${idA}`), pageB.goto(`/${c.kind}.html?doc=${idB}`)]);
        await Promise.all([waitForEditor(pageA), waitForEditor(pageB)]);
        const unitIds = await Promise.all([pageA, pageB].map((p) => p.evaluate(() => window.__m0!.editor!.save().id)));

        await edit(pageA, c.kind, 'A 的修改');
        await edit(pageB, c.kind, 'B 的修改');
        await pageA.evaluate((id) => window.__m0!.persist!(id), idA);
        await pageB.evaluate((id) => window.__m0!.persist!(id), idB);
        const errorsA = await pageA.evaluate(() => window.__m0!.events.errors);
        const errorsB = await pageB.evaluate(() => window.__m0!.events.errors);
        await pageA.close();
        await pageB.close();

        // 分别用新页面重开
        const reopen = async (id: string) => {
            const p = await context.newPage();
            await p.goto(`/${c.kind}.html?doc=${id}`);
            await waitForEditor(p);
            const text = await snapshotText(p);
            await p.close();
            return text;
        };
        const reopenWithSemantics = async (id: string) => {
            const p = await context.newPage();
            await p.goto(`/${c.kind}.html?doc=${id}`);
            await waitForEditor(p);
            const semantics = await p.evaluate(() => window.__m0!.editor!.semantics());
            await p.close();
            return semantics;
        };
        const textA = await reopen(idA);
        const textB = await reopen(idB);
        const semanticsOriginal = await (async () => {
            const p = await context.newPage();
            await p.goto(`/${c.kind}.html?sample=${c.sample}`);
            await waitForEditor(p);
            const semantics = await p.evaluate(() => window.__m0!.editor!.semantics());
            await p.close();
            return semantics;
        })();
        const semanticsA = await reopenWithSemantics(idA);
        const semanticsB = await reopenWithSemantics(idB);
        const snapA: Snapshot = JSON.parse(textA);
        const snapB: Snapshot = JSON.parse(textB);
        const whitelist = (original.resources ?? []).map((r) => r.name);
        const resA = compareResources(original.resources, snapA.resources, whitelist);
        const resB = compareResources(original.resources, snapB.resources, whitelist);

        // 与原文档的差异：表格只应剩下被编辑的单元格（数据表 J3 = 第 2 行第 9 列）；文字文档比较去掉插入文字后的正文
        const diffA = realDiff(original, snapA);
        const diffB = realDiff(original, snapB);
        const editedCell = /^\$\.sheets\.sheet-1\.cellData\.2\.9(\.|$)/;
        // 编辑产生的新样式条目（被编辑的单元格引用它）也属于这次编辑
        const editedStyle = (snap: Snapshot) => (snap as { sheets?: Record<string, { cellData?: Record<string, Record<string, { s?: unknown }>> }> }).sheets?.['sheet-1']?.cellData?.['2']?.['9']?.s;
        const outsideEdit = (diff: typeof diffA, snap: Snapshot) => (c.kind === 'sheet'
            ? diff.filter((d) => !editedCell.test(d.path) && !(typeof editedStyle(snap) === 'string' && d.path === `$.styles.${editedStyle(snap)}`))
            : []);
        const bodyWithoutEdit = (snap: Snapshot, text: string) => ((snap as { body?: { dataStream?: string } }).body?.dataStream ?? '').replace(text, '');
        const docBodyUnchanged = c.kind === 'doc'
            ? bodyWithoutEdit(snapA, 'A 的修改') === (original as { body?: { dataStream?: string } }).body?.dataStream
                && bodyWithoutEdit(snapB, 'B 的修改') === (original as { body?: { dataStream?: string } }).body?.dataStream
            : null;
        // 语义：除了正文长度，复制品与原文档一致（条件格式、图片、链接、筛选等都在）
        const withoutLength = (x: unknown) => ({ ...(x as object), textLength: undefined });

        // 表格：内部链接指向的工作表 id 在复制品中依然存在
        const internalLinks = c.kind === 'sheet' ? [...textB.matchAll(/#gid=([\w-]+)/g)].map((m) => m[1]) : [];
        const sheetIdsB = c.kind === 'sheet' ? Object.keys((snapB as unknown as { sheets: object }).sheets) : [];

        const result = {
            check: 'V05',
            kind: c.kind,
            browser: browserInfo(pageA, testInfo),
            timestamp: new Date().toISOString(),
            unitIds,
            isolation: {
                aHasOwnEdit: textA.includes('A 的修改'),
                aHasOtherEdit: textA.includes('B 的修改'),
                bHasOwnEdit: textB.includes('B 的修改'),
                bHasOtherEdit: textB.includes('A 的修改'),
            },
            resourcesA: resA,
            resourcesB: resB,
            internalLinksResolveInCopy: internalLinks.every((gid) => sheetIdsB.includes(gid)),
            diffOutsideEdit: { A: outsideEdit(diffA, snapA).slice(0, 50), B: outsideEdit(diffB, snapB).slice(0, 50) },
            docBodyUnchangedExceptEdit: docBodyUnchanged,
            semantics: { original: semanticsOriginal, A: semanticsA, B: semanticsB },
            internalLinks,
            errors: { A: errorsA, B: errorsB },
        };
        await writeResult(`v05/${project}-${c.kind}.json`, result);

        expect.soft(unitIds[0], '两份文档 unitId 相同').toBe(unitIds[1]);
        expect.soft(result.isolation).toEqual({ aHasOwnEdit: true, aHasOtherEdit: false, bHasOwnEdit: true, bHasOtherEdit: false });
        expect.soft([...resA.missing, ...resA.emptied, ...resB.missing, ...resB.emptied], '资源丢失或变空').toEqual([]);
        expect.soft(result.internalLinksResolveInCopy, '复制品中的内部链接有效').toBe(true);
        expect.soft([...outsideEdit(diffA, snapA), ...outsideEdit(diffB, snapB)], '除被编辑的单元格外没有其他差异').toEqual([]);
        if (c.kind === 'doc') expect.soft(docBodyUnchanged, '正文除插入的文字外不变').toBe(true);
        expect.soft(withoutLength(semanticsA), '复制品 A 的语义与原文档一致').toEqual(withoutLength(semanticsOriginal));
        expect.soft(withoutLength(semanticsB), '复制品 B 的语义与原文档一致').toEqual(withoutLength(semanticsOriginal));
        expect.soft([...errorsA, ...errorsB], '页面错误').toEqual([]);
    });

    test(`V05 同一实例中重复 unitId：${c.kind}`, async ({ page }, testInfo) => {
        await page.goto(`/${c.kind}.html?sample=${c.sample}`);
        await waitForEditor(page);
        const outcome = await page.evaluate((kind) => {
            const m = window.__m0!.editor!;
            const snapshot = m.save();
            try {
                if (kind === 'sheet') m.univerAPI.createWorkbook(snapshot as never, { makeCurrent: false });
                else m.univerAPI.createDocument(snapshot as never, { makeCurrent: false });
                return { threw: false, message: '' };
            } catch (e) {
                return { threw: true, message: e instanceof Error ? e.message : String(e) };
            }
        }, c.kind);
        await writeResult(`v05/duplicate-${testInfo.project.name}-${c.kind}.json`, {
            check: 'V05-duplicate-unitId',
            kind: c.kind,
            browser: browserInfo(page, testInfo),
            timestamp: new Date().toISOString(),
            ...outcome,
        });
        expect(outcome.threw, '同一实例中重复 unitId 应抛异常').toBe(true);
    });
}
