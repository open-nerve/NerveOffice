// V03：保存 → 重开 → 再保存的保真度（三浏览器），以及运行时注册的资源 hook 清单、保护类资源的影响。
// 这个脚本同时是插件档案的回归门禁（插件档案 v1 §4）：实际差异必须与基线一致，语义必须与预期一致。
import type { Page } from '@playwright/test';
import type { DiffEntry } from './diff';

import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compareResources, isEmptyResourceData } from '../src/harness/resource-guard';
import { canonicalJson, diffJson, expandResources } from './diff';
import { browserInfo, cellCenter, RESULTS_DIR, SERVERS, waitForEditor, writeResult } from './helpers';
import { BUSINESS, EXPECTED_SEMANTICS } from './samples-expected';
import { baselineOf, matchesBaseline } from './v03-baselines';

test.use({ baseURL: SERVERS.off });

const SHEET_SAMPLES = ['minimal', 'sheet-core', 'sheet-cf', 'sheet-dv', 'sheet-filter', 'sheet-hyperlink', 'sheet-note', 'sheet-drawing', 'sheet-protection', 'sheet-all'];
const DOC_SAMPLES = ['minimal', 'doc-text', 'doc-list', 'doc-hyperlink', 'doc-table', 'doc-drawing', 'doc-all'];
const SAMPLES = [...SHEET_SAMPLES.map((name) => ({ kind: 'sheet' as const, name })), ...DOC_SAMPLES.map((name) => ({ kind: 'doc' as const, name }))];

type Snapshot = { resources?: { name: string; data: string }[]; [k: string]: unknown };

/** 内容哈希：资源数组按名称排序（它的顺序取决于插件注册顺序，与内容无关）。 */
function contentHash(snapshot: Snapshot): string {
    const copy = { ...snapshot, resources: [...(snapshot.resources ?? [])].sort((a, b) => a.name.localeCompare(b.name)) };
    return createHash('sha256').update(canonicalJson(copy)).digest('hex');
}

/** 以 JSON 文本取出快照：与平台持久化时一致（例如内存中的 Infinity 会变成 null）。 */
async function saveAsJson(page: Page): Promise<Snapshot> {
    return JSON.parse(await page.evaluate(() => JSON.stringify(window.__m0!.editor!.save())));
}

/**
 * 资源数据在"空字符串"与"空对象"之间变化，或者删掉取值为空的键，内容上等价。
 * 原因：资源 hook 晚于文档单元注册时，走 loadHookResource 路径，条目存在就调用 onLoad（即使数据是 ""）；
 * 而文档单元创建时走 loadResources 路径，会跳过空数据。
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
    return isEmptyResourceData(parse(d.before)) && isEmptyResourceData(parse(d.after));
}

function split(diff: DiffEntry[]) {
    return { real: diff.filter((d) => !isEmptyEquivalent(d)), emptyEquivalent: diff.filter(isEmptyEquivalent) };
}

async function open(page: Page, url: string) {
    await page.goto(url);
    await waitForEditor(page);
}

for (const s of SAMPLES) {
    test(`V03 ${s.kind}/${s.name}`, async ({ page, request }, testInfo) => {
        const project = testInfo.project.name;
        const sample = `${s.kind}/${s.name}`;
        const s0: Snapshot = JSON.parse(await readFile(join(import.meta.dirname, '..', 'fixtures', s.kind, `${s.name}.json`), 'utf8'));
        const pageErrors: string[] = [];
        page.on('pageerror', (e) => pageErrors.push(e.message));

        // 第一次打开：加载样本 S0，得到 S1
        await open(page, `/${s.kind}.html?sample=${s.name}`);
        // 先保存再读语义：Facade 的部分读取方法会在模型里建空条目（例如 getDataValidations 给每个工作表建空数组），
        // 虽然内容上等价，但会改变快照的字节，所以不能在取 S1 之前调用
        const s1 = await saveAsJson(page);
        const hooks = await page.evaluate(() => window.__m0!.editor!.resourceHooks());
        const declared = await page.evaluate(() => window.__m0!.editor!.declaredResources());
        const semantics0 = await page.evaluate(() => window.__m0!.editor!.semantics());
        const consoleErrors1 = await page.evaluate(() => window.__m0!.events.consoleErrors);

        // 写回存储，用新页面重开：加载 S1，得到 S2；再来一轮得到 S3，确认已经收敛
        const id = `rt-${project}-${s.kind}-${s.name}`;
        await request.put(`${SERVERS.off}/api/docs/${id}`, { data: s1 });
        await open(page, `/${s.kind}.html?doc=${id}`);
        const s2 = await saveAsJson(page);
        const semantics2 = await page.evaluate(() => window.__m0!.editor!.semantics());
        const consoleErrors2 = await page.evaluate(() => window.__m0!.events.consoleErrors);
        await request.put(`${SERVERS.off}/api/docs/${id}`, { data: s2 });
        await open(page, `/${s.kind}.html?doc=${id}`);
        const s3 = await saveAsJson(page);

        const d12 = split(diffJson(expandResources(s1), expandResources(s2)));
        const d23 = diffJson(expandResources(s2), expandResources(s3));
        const fidelity = split(diffJson(expandResources(s0), expandResources(s1)));
        const realDiff = fidelity.real.map((d) => `${d.kind} ${d.path}`).sort();
        const hookNames = hooks.filter((h) => h.businesses.includes(BUSINESS[s.kind])).map((h) => h.name).sort();
        // 白名单取档案声明（不是运行时 hook），这样"S1 的资源名都在白名单内"才是真的检验
        const resources = compareResources(s0.resources, s1.resources, declared);
        const baseline = baselineOf(sample);
        const count = (kind: string) => fidelity.real.filter((d) => d.kind === kind).length;

        await writeResult(`v03/roundtrip/${project}-${s.kind}-${s.name}.json`, {
            check: 'V03',
            sample,
            browser: browserInfo(page, testInfo),
            timestamp: new Date().toISOString(),
            resourceHooks: hooks,
            declaredResources: declared,
            semantics: { afterFirstOpen: semantics0, afterReopen: semantics2, expected: EXPECTED_SEMANTICS[s.name] ?? null },
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
                entries: fidelity.real.slice(0, 300),
            },
            baseline,
            resources,
            hashes: { s0: contentHash(s0), s1: contentHash(s1), s2: contentHash(s2), s3: contentHash(s3) },
            pageErrors,
            consoleErrors: [...consoleErrors1, ...consoleErrors2],
        });
        await writeResult(`v03/s1/${project}-${s.kind}-${s.name}.json`, s1);

        expect.soft(d12.real, 'S1 与 S2 除空值等价外应一致').toEqual([]);
        expect.soft(d23, 'S2 与 S3 应完全一致').toEqual([]);
        expect.soft(matchesBaseline(realDiff, baseline.realDiff), `S0→S1 的实际差异应与基线一致：${JSON.stringify(realDiff)}`).toBe(true);
        expect.soft(resources.changed, '内容变化的资源应与基线一致').toEqual(baseline.resourcesChanged);
        expect.soft([...resources.duplicates, ...resources.invalid, ...resources.unknown, ...resources.missing, ...resources.emptied], '资源结构、白名单、丢失、变空').toEqual([]);
        expect.soft(declared, '档案声明的资源名应与运行时注册的 hook 一致').toEqual(hookNames);
        expect.soft(semantics2, '重开后语义不变').toEqual(semantics0);
        if (EXPECTED_SEMANTICS[s.name] != null) expect.soft(semantics0, '样本语义与构建器的预期一致').toEqual(EXPECTED_SEMANTICS[s.name]);
        expect.soft(pageErrors, '页面错误').toEqual([]);
        expect.soft([...consoleErrors1, ...consoleErrors2], '控制台错误').toEqual([]);
    });
}

// Worker 模式：表格公式在 Worker、文字文档排版在 Worker 时，S1 应与非 Worker 模式相同（只在 Chromium 上核对）
for (const s of SAMPLES.filter((x) => x.name !== 'minimal')) {
    test(`V03 Worker 模式 ${s.kind}/${s.name}`, async ({ page }, testInfo) => {
        test.skip(testInfo.project.name !== 'chromium', 'Worker 模式只在 Chromium 上核对');
        await open(page, `/${s.kind}.html?sample=${s.name}`);
        const plain = await saveAsJson(page);
        await open(page, `/${s.kind}.html?sample=${s.name}&worker=1`);
        const withWorker = await saveAsJson(page);
        const stats = await page.evaluate(() => window.__m0!.workerStats);
        const diff = split(diffJson(expandResources(plain), expandResources(withWorker))).real;
        await writeResult(`v03/worker/${testInfo.project.name}-${s.kind}-${s.name}.json`, {
            check: 'V03-worker',
            sample: `${s.kind}/${s.name}`,
            browser: browserInfo(page, testInfo),
            timestamp: new Date().toISOString(),
            sameAsPlain: diff.length === 0,
            diff: diff.slice(0, 50),
            workerStarted: stats.created,
        });
        expect.soft(stats.created, 'Worker 已启动').toBeGreaterThan(0);
        expect.soft(diff, 'Worker 模式下的 S1 与非 Worker 模式一致').toEqual([]);
    });
}

test('V03 保护类资源对编辑的影响', async ({ page }, testInfo) => {
    await open(page, '/sheet.html?sample=sheet-protection');
    await page.screenshot({ path: join(RESULTS_DIR, 'v03', `protection-${testInfo.project.name}.png`) });
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
    const info = await page.evaluate(() => {
        const editor = window.__m0!.editor!;
        const wb = editor.univerAPI.getActiveWorkbook()!;
        return {
            currentUser: editor.currentUserId(),
            sheets: wb.getSheets().map((ws) => ({ name: ws.getSheetName(), isProtected: ws.getWorksheetPermission().isProtected() })),
        };
    });
    await writeResult(`v03/protection-${testInfo.project.name}.json`, {
        check: 'V03-protection',
        browser: browserInfo(page, testInfo),
        timestamp: new Date().toISOString(),
        protectedCellA1AfterTyping: protectedValue,
        unprotectedCellD10AfterTyping: freeValue,
        ...info,
        screenshot: `protection-${testInfo.project.name}.png`,
    });
    // 记录现状：本地模拟的授权服务下，受保护区域照样能改（保护不构成安全边界）
    expect.soft(protectedValue, '受保护区域照样能改').toBe('尝试修改');
    expect.soft(freeValue).toBe('可以修改');
});
