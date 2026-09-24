// V06-1 打开静默：打开文档不会被判定为"有修改"（00 号计划书 §7.3）。
// 检测器在创建文档单元之前挂上；等到 Steady 后再等 5 秒。记录全部非本地的 mutation 与 syncOnly 的 mutation，据此定排除名单；
// 同时比较 Steady 与 5 秒后的两次捕获（迟到的内容变化），以及打开后与原快照的差异（没有 mutation 的内容变化）。
import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { browserInfo, SERVERS, waitForEditor, writeResult } from './helpers';
import { brief, contentDiff, detectorState, ensureGenerated, snapshotText, storedText } from './p3-helpers';

test.use({ baseURL: SERVERS.off });

const FIXTURES = {
    sheet: ['empty', 'minimal', 'sheet-all', 'sheet-cf', 'sheet-core', 'sheet-drawing', 'sheet-dv', 'sheet-filter', 'sheet-hyperlink', 'sheet-note', 'sheet-protection'],
    doc: ['empty', 'minimal', 'doc-all', 'doc-drawing', 'doc-hyperlink', 'doc-list', 'doc-table', 'doc-text'],
} as const;

const GENERATED = { sheet: ['big-1m', 'perf-50k', 'formula-scenarios'], doc: ['doc-20k'] } as const;

interface Case {
    kind: 'sheet' | 'doc';
    sample: string;
    generated: boolean;
    worker: boolean;
}

const CASES: Case[] = [];
for (const kind of ['sheet', 'doc'] as const) {
    for (const sample of FIXTURES[kind]) {
        CASES.push({ kind, sample, generated: false, worker: false });
        if (kind === 'sheet') CASES.push({ kind, sample, generated: false, worker: true });
    }
    for (const sample of GENERATED[kind]) {
        CASES.push({ kind, sample, generated: true, worker: false });
        if (kind === 'sheet') CASES.push({ kind, sample, generated: true, worker: true });
    }
}

for (const c of CASES) {
    const name = `${c.kind}-${c.sample}${c.worker ? '-worker' : ''}`;
    test(`V06 打开静默：${name}`, async ({ page, request }, testInfo) => {
        test.setTimeout(240_000);
        let original: string;
        let url: string;
        if (c.generated) {
            const id = await ensureGenerated(page, request, c.kind, c.sample);
            original = await storedText(request, id);
            url = `/${c.kind}.html?doc=${id}`;
        } else {
            original = JSON.stringify(JSON.parse(await readFile(join(import.meta.dirname, '..', 'fixtures', c.kind, `${c.sample}.json`), 'utf8')));
            url = `/${c.kind}.html?sample=${c.sample}`;
        }
        await page.goto(`${url}${c.worker ? '&worker=1' : ''}`);
        await waitForEditor(page);
        const atSteady = await snapshotText(page);
        await page.waitForTimeout(5000);
        const after5s = await snapshotText(page);
        const state = await detectorState(page);
        const timings = await page.evaluate(() => window.__m0!.editor!.timings);
        const errors = await page.evaluate(() => window.__m0!.events.errors);

        const lateDiff = contentDiff(atSteady, after5s);
        const openDiff = contentDiff(original, after5s);
        const result = {
            check: 'V06-open-quiet',
            sample: c.sample,
            kind: c.kind,
            generated: c.generated,
            worker: c.worker,
            browser: browserInfo(page, testInfo),
            timestamp: new Date().toISOString(),
            bytes: after5s.length,
            timings,
            ...brief(state),
            lateDiff: lateDiff.slice(0, 50),
            openDiffCount: openDiff.length,
            openDiff: openDiff.slice(0, 50),
            errors,
        };
        await writeResult(`v06/open-quiet/${testInfo.project.name}-${name}.json`, result);

        expect.soft(result.detections, '打开后没有被检测到的修改').toEqual([]);
        expect.soft(result.lateDiff, 'Steady 之后 5 秒内没有迟到的内容变化').toEqual([]);
        expect.soft(errors, '页面错误').toEqual([]);
    });
}
