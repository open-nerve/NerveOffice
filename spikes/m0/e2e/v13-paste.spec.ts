// V13 复制粘贴（P5，00 号计划书 §13.4 第 13 条：来源包括 Word、网页和本平台）：
// 1. 剪贴板样本（fixtures/paste/）× 粘贴目标：合成粘贴到编辑器的隐藏输入元素，与快捷键粘贴走同一条路径（P4 的 syntheticPaste）；
//    记录结构的保留情况（标题、列表、表格、链接、文字样式、图片），检查安全（链接地址、脚本不执行）、页面错误、CSP 与保存重开；
// 2. 内部片段（<!--univer-doc-fragment:…-->）：SDK 直接采用，不经过 HTML 转换，对照 SDK 默认与平台配置；
// 3. "仅保留文本"粘贴（⌘⇧V）；
// 4. 本平台的复制：同一文档、另一个标签页、表格到文字文档、文字文档到表格（后三项用真实剪贴板，只在 Chromium 内核上）。
import type { Page, TestInfo } from '@playwright/test';
import type { DocSummary } from './p5-helpers';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { browserInfo, cellCenter, SERVERS, waitForEditor, writeResult } from './helpers';
import { syntheticPaste } from './p4-helpers';
import { docId, docSummary, docText, endOffset, focusEditor, offsetOf, openDoc, pageHealth, PLATFORM, policyEvents, press, resetHealth, roundtrip, setSelection, VARIANT} from './p5-helpers';

const PASTE_DIR = join(import.meta.dirname, '..', 'fixtures', 'paste');
const html = (name: string) => readFileSync(join(PASTE_DIR, `${name}.html`), 'utf8');

type Target = 'empty' | 'middle' | 'heading' | 'list' | 'cell';

const exec = (page: Page, id: string, params: Record<string, unknown>) =>
    page.evaluate(({ id, params }) => window.__m0!.editor!.univerAPI.executeCommand(id, params), { id, params });

/** 准备粘贴目标并放置光标（标题、列表、表格用命令准备，不属于被测路径）。 */
async function placeTarget(page: Page, target: Target): Promise<void> {
    if (target === 'empty') return setSelection(page, await endOffset(page));
    if (target === 'middle') return setSelection(page, (await offsetOf(page, '可以选中')) + 2);
    if (target === 'heading') {
        await setSelection(page, (await offsetOf(page, '段落甲')) + 2);
        await exec(page, 'doc.command.set-paragraph-named-style', { value: 5 });
        return setSelection(page, (await offsetOf(page, '标题样式。')) + 5);
    }
    if (target === 'list') {
        await setSelection(page, (await offsetOf(page, '段落戊')) + 2);
        await exec(page, 'doc.command.bullet-list', {});
        return setSelection(page, (await offsetOf(page, '列表第二项')) + 5);
    }
    await setSelection(page, await endOffset(page));
    await exec(page, 'doc.command.create-table', { rowCount: 2, colCount: 2 });
    await page.waitForTimeout(400);
    return setSelection(page, (await docText(page)).indexOf('\x1c') + 1);
}

/** 粘贴前后结构的变化。 */
function added(before: DocSummary, after: DocSummary) {
    const count = (s: DocSummary) => ({
        paragraphs: s.paragraphs.length,
        headings: s.paragraphs.filter((p) => p.style != null && p.style >= 2).map((p) => `${p.style}:${p.text.slice(0, 12)}`),
        lists: s.paragraphs.filter((p) => p.list != null).map((p) => `${p.list}/${p.level}:${p.text.slice(0, 10)}`),
        aligns: s.paragraphs.filter((p) => p.align != null && p.align > 1).map((p) => `${p.align}:${p.text.slice(0, 8)}`),
        tables: s.tables.map((t) => `${t.rows}×${t.cols}`),
        links: s.links.map((l) => `${l.text.slice(0, 10)}→${l.url}`),
        images: s.images.map((i) => i.source.slice(0, 40)),
    });
    const b = count(before);
    const a = count(after);
    const minus = (x: string[], y: string[]) => {
        const left = [...y];
        return x.filter((v) => {
            const i = left.indexOf(v);
            if (i >= 0) {
                left.splice(i, 1);
                return false;
            }
            return true;
        });
    };
    const key = (r: { text: string; ts: Record<string, unknown> }) => `${r.text}\u0000${JSON.stringify(r.ts)}`;
    const styledKeys = minus(after.runs.map(key), before.runs.map(key));
    const styled = styledKeys.map((k) => {
        const [text, ts] = k.split('\u0000');
        return { text, ts: JSON.parse(ts) as Record<string, unknown> };
    });
    return {
        paragraphs: a.paragraphs - b.paragraphs,
        headings: minus(a.headings, b.headings),
        lists: minus(a.lists, b.lists),
        aligns: minus(a.aligns, b.aligns),
        tables: minus(a.tables, b.tables),
        links: minus(a.links, b.links),
        images: minus(a.images, b.images),
        runs: styled.map((r) => ({ text: r.text.slice(0, 16), ts: r.ts })),
    };
}

/** 各样本要核对的特征：名称 → 判定。结果写进报告的保留情况表，不作为通过条件（安全与稳定性另外断言）。 */
type Added = ReturnType<typeof added>;
const has = (list: string[], re: RegExp) => list.some((x) => re.test(x));
const run = (a: Added, text: string, pred: (ts: Record<string, unknown>) => boolean) => a.runs.some((r) => r.text.includes(text) && pred(r.ts));
const FEATURES: Record<string, Record<string, (a: Added, text: string) => boolean>> = {
    'word-win': {
        一级标题: (a) => has(a.headings, /^4:项目周报/),
        二级标题: (a) => has(a.headings, /^5:一、进展/) || has(a.headings, /^5:二、数据/),
        粗体: (a) => run(a, '文字文档', (ts) => ts.bl === 1),
        斜体: (a) => run(a, '斜体', (ts) => ts.it === 1),
        下划线: (a) => run(a, '下划线', (ts) => (ts.ul as { s?: number })?.s === 1),
        删除线: (a) => run(a, '删除线', (ts) => (ts.st as { s?: number })?.s === 1),
        下标: (a) => a.runs.some((r) => r.text === '2' && r.ts.va === 2),
        文字颜色: (a) => run(a, '红色文字', (ts) => ts.cl != null),
        高亮: (a) => run(a, '黄色高亮', (ts) => ts.bg != null),
        字号: (a) => run(a, '四号黑体', (ts) => ts.fs === 14),
        居中: (a) => has(a.aligns, /^2:居中/),
        右对齐: (a) => has(a.aligns, /^3:右对齐/),
        编号列表: (a) => a.lists.filter((x) => x.startsWith('ORDER_LIST')).length >= 2,
        二级编号: (a) => has(a.lists, /\/1:拼音/),
        项目符号: (a) => a.lists.filter((x) => x.startsWith('BULLET_LIST')).length >= 2,
        列表标记已去掉: (_a, t) => !/\d\.\s*完成能力矩阵|l\s*项目符号/.test(t),
        表格: (a) => a.tables.includes('2×3'),
        网址链接: (a) => has(a.links, /example\.com\/weekly\/39$/),
        邮件链接: (a) => has(a.links, /→mailto:pm@example\.com$/),
    },
    'word-mac': {
        标题样式MsoTitle: (a) => has(a.headings, /会议纪要/),
        三级标题: (a) => has(a.headings, /^6:议题/),
        段内换行: (_a, t) => /日\s*[\r\n\v]\s*地点|日地点/.test(t) && !/日地点/.test(t),
        中文编号列表: (a) => a.lists.length >= 3,
        中文编号标记已去掉: (_a, t) => !/一、文字文档的范围/.test(t),
        图片占位: (a) => a.images.length === 1,
    },
    wps: {
        标题: (a) => has(a.headings, /季度总结/),
        粗体: (a) => run(a, '重点', (ts) => ts.bl === 1),
        红色: (a) => run(a, '是交付', (ts) => ts.cl != null),
        下划线: (a) => run(a, '在线文档平台', (ts) => (ts.ul as { s?: number })?.s === 1),
        编号列表: (a) => a.lists.length >= 2,
        表格: (a) => a.tables.includes('2×2'),
    },
    'web-article': {
        一级标题: (a) => has(a.headings, /^4:快速开始/),
        二级标题: (a) => has(a.headings, /^5:准备工作/),
        六级标题: (a) => has(a.headings, /六级标题/),
        粗体: (a) => run(a, '团队文档平台', (ts) => ts.bl === 1),
        强调是斜体: (a) => run(a, '常见问题', (ts) => ts.it === 1 && ts.bl !== 1),
        链接: (a) => has(a.links, /代码仓库→https:\/\/example\.com\/repo/),
        有序列表: (a) => a.lists.filter((x) => x.startsWith('ORDER_LIST')).length >= 3,
        嵌套列表: (a) => a.lists.some((x) => /\/1:/.test(x)),
        删除线: (a) => run(a, '逻辑复制', (ts) => (ts.st as { s?: number })?.s === 1),
        表格: (a) => a.tables.includes('3×2'),
        段内换行: (_a, t) => !/第一行第二行/.test(t),
    },
    'web-news': {
        粗体: (a) => run(a, '数字政务', (ts) => ts.bl === 1),
        红色: (a) => run(a, '98.5%', (ts) => ts.cl != null),
        font标签颜色: (a) => run(a, '3.2个百分点', (ts) => ts.cl != null),
        分行: (_a, t) => !/机制；二是/.test(t),
        居中: (a) => has(a.aligns, /^2:/),
        链接: (a) => has(a.links, /王五→https:\/\/news\.example\.com\/editor\/42/),
        图片占位: (a) => a.images.length === 1,
    },
    'google-docs': {
        一级标题: (a) => has(a.headings, /^4:产品需求说明/),
        正文不是粗体: (a) => !run(a, '这是正文', (ts) => ts.bl === 1),
        粗体: (a) => run(a, '这几个字加粗', (ts) => ts.bl === 1),
        斜体: (a) => run(a, '这几个字斜体', (ts) => ts.it === 1),
        下划线: (a) => run(a, '这几个字带下划线', (ts) => (ts.ul as { s?: number })?.s === 1),
        无序列表: (a) => a.lists.filter((x) => x.startsWith('BULLET_LIST')).length >= 2,
        表格: (a) => a.tables.includes('2×2'),
        链接: (a) => has(a.links, /参考链接→https:\/\/docs\.example\.com\/spec/),
    },
    feishu: {
        标题: (a) => has(a.headings, /迭代计划/),
        粗体: (a) => run(a, '文字文档', (ts) => ts.bl === 1),
        删除线: (a) => run(a, '不做', (ts) => (ts.st as { s?: number })?.s === 1),
        编号列表: (a) => a.lists.filter((x) => x.startsWith('ORDER_LIST')).length >= 2,
        项目符号: (a) => a.lists.some((x) => x.startsWith('BULLET_LIST')),
        高亮: (a) => run(a, '高亮的文字', (ts) => ts.bg != null),
        链接: (a) => has(a.links, /另一篇文档→https:\/\/example\.feishu\.cn/),
    },
    malicious: {
        安全链接保留: (a) => has(a.links, /带事件的正常链接→https:\/\/example\.com\/ok/),
        本站相对地址: (a) => has(a.links, /本站相对地址→/),
        文档内锚点: (a) => has(a.links, /文档内锚点→/),
    },
    plain: {
        多行成段: (a) => a.paragraphs >= 2,
        网址成链接: (a) => a.links.length >= 1,
    },
};

const PLAIN_TEXT = '第一行纯文本\n第二行纯文本\nhttps://example.com/plain';

async function pasteCase(page: Page, testInfo: TestInfo, source: string, target: Target, config: 'platform' | 'default', withRoundtrip: boolean) {
    await openDoc(page, `sample=p5-cap${config === 'platform' ? `&${PLATFORM}` : ''}`);
    await focusEditor(page);
    await placeTarget(page, target);
    await resetHealth(page);
    await page.evaluate(() => {
        (window as unknown as { __p5_pwned?: string }).__p5_pwned = undefined;
    });
    const before = await docSummary(page);
    const data = source === 'plain' ? { text: PLAIN_TEXT } : { html: html(source), text: '（纯文本版本）' };
    const dispatched = await syntheticPaste(page, data);
    await page.waitForTimeout(1500);
    const after = await docSummary(page);
    const diff = added(before, after);
    const pastedText = after.text.slice(0, after.text.length);
    const features = Object.fromEntries(Object.entries(FEATURES[source] ?? {}).map(([k, f]) => [k, f(diff, pastedText)]));
    const pwned = await page.evaluate(() => (window as unknown as { __p5_pwned?: string }).__p5_pwned ?? null);
    const unsafeLinks = after.links.filter((l) => !/^(https?:|mailto:|\/(?!\/)|#)/i.test(l.url));
    const health = await pageHealth(page);
    const events = await policyEvents(page);
    const rt = withRoundtrip ? await roundtrip(page, docId(testInfo, `paste-${source}-${target}-${config}`), config === 'platform' ? PLATFORM : '') : null;
    const result = { source, target, config, dispatched, changed: after.text !== before.text, diff, features, pwned, unsafeLinks, health, policyEvents: events, roundtrip: rt };
    await writeResult(`v13/paste${VARIANT}/${testInfo.project.name}-${source}-${target}-${config}.json`, { check: 'V13-paste', browser: browserInfo(page, testInfo), timestamp: new Date().toISOString(), ...result });
    return result;
}

const SOURCES = ['word-win', 'word-mac', 'wps', 'web-article', 'web-news', 'google-docs', 'feishu', 'malicious', 'plain'];

for (const source of SOURCES) {
    test(`V13 粘贴：${source} → 空段落`, async ({ page }, testInfo) => {
        const r = await pasteCase(page, testInfo, source, 'empty', 'platform', true);
        expect.soft(r.changed, '粘贴生效').toBe(true);
        expect.soft(r.pwned, '脚本与事件属性不执行').toBeNull();
        expect.soft(r.unsafeLinks, '没有不安全的链接地址').toEqual([]);
        expect.soft(r.health.errors, '没有页面错误').toEqual([]);
        expect.soft(r.health.cspEnforce, '没有 CSP 强制违规').toEqual([]);
        expect.soft(r.roundtrip?.secondDiff, '再保存一致').toEqual([]);
    });
}

test('V13 粘贴：纯文本里的网址（SDK 默认，对照）', async ({ page }, testInfo) => {
    // 纯文本路径把"像网址的行"变成链接；记录 SDK 默认生成的链接地址（平台配置下它被链接地址白名单去掉）
    const r = await pasteCase(page, testInfo, 'plain', 'empty', 'default', false);
    const links = (await docSummary(page)).links;
    await writeResult(`v13/paste${VARIANT}/${testInfo.project.name}-plain-links-default.json`, { check: 'V13-paste-plain-links', browser: browserInfo(page, testInfo), timestamp: new Date().toISOString(), links });
    expect.soft(r.changed).toBe(true);
});

for (const source of ['word-win', 'web-article', 'google-docs', 'plain']) {
    for (const target of ['middle', 'heading', 'list', 'cell'] as const) {
        test(`V13 粘贴：${source} → ${target}`, async ({ page }, testInfo) => {
            const r = await pasteCase(page, testInfo, source, target, 'platform', false);
            // 含表格的内容粘贴到单元格：SDK 整体放弃（不嵌套），不算失败，记录
            if (!(target === 'cell' && source !== 'plain')) expect.soft(r.changed, '粘贴生效').toBe(true);
            expect.soft(r.unsafeLinks, '没有不安全的链接地址').toEqual([]);
            expect.soft(r.health.errors, '没有页面错误').toEqual([]);
            if (target === 'cell') expect.soft(r.diff.tables, '单元格里不嵌套表格').toEqual([]);
        });
    }
}

/** 构造内部片段（SDK 复制时写进 HTML 注释的格式，internal-fragment.ts）。 */
function fragmentHtml(doc: unknown): string {
    return `<!--univer-doc-fragment:${Buffer.from(JSON.stringify({ version: 1, kind: 'univer-doc-fragment', doc })).toString('base64')}--><p>片段</p>`;
}

for (const config of ['default', 'platform'] as const) {
    test(`V13 粘贴：伪造的内部片段（${config}）`, async ({ page }, testInfo) => {
        // 链接地址不经过 HTML 转换的检查；片段还带分节符（\n 之外的 sectionBreaks）与标题样式
        await openDoc(page, `sample=p5-cap${config === 'platform' ? `&${PLATFORM}` : ''}`);
        await focusEditor(page);
        await setSelection(page, await endOffset(page));
        const before = await docSummary(page);
        const doc = {
            body: {
                dataStream: '恶意链接与标题\r',
                customRanges: [{ rangeId: 'p5evil', rangeType: 0, startIndex: 0, endIndex: 3, properties: { url: 'javascript:window.__p5_pwned=1' } }],
                paragraphs: [{ startIndex: 7, paragraphStyle: { namedStyleType: 4 } }],
            },
        };
        await syntheticPaste(page, { html: fragmentHtml(doc), text: '片段' });
        await page.waitForTimeout(1200);
        const after = await docSummary(page);
        const diff = added(before, after);
        const events = await policyEvents(page);
        const health = await pageHealth(page);
        await writeResult(`v13/paste${VARIANT}/${testInfo.project.name}-fragment-${config}.json`, { check: 'V13-paste-fragment', config, browser: browserInfo(page, testInfo), timestamp: new Date().toISOString(), diff, policyEvents: events, health });
        expect.soft(diff.headings.length, '片段里的标题样式保留').toBe(1);
        if (config === 'platform') expect.soft(diff.links, '平台配置：去掉 javascript: 链接').toEqual([]);
        expect.soft(health.errors).toEqual([]);
    });
}

test('V13 粘贴："仅保留文本"（⌘⇧V）', async ({ page }, testInfo) => {
    await openDoc(page, `sample=p5-cap&${PLATFORM}`);
    await focusEditor(page);
    await setSelection(page, await endOffset(page));
    const before = await docSummary(page);
    // ⌘⇧V 的 keydown 让 SDK 把下一次粘贴设为纯文本；随后的粘贴事件带上 Word 的 HTML
    await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control');
    await page.keyboard.down('Shift');
    await page.keyboard.press('v');
    await page.keyboard.up('Shift');
    await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
    await syntheticPaste(page, { html: html('word-win'), text: '项目周报2026年第39周\n本周完成了文字文档的验证' });
    await page.waitForTimeout(1200);
    const after = await docSummary(page);
    const diff = added(before, after);
    await writeResult(`v13/paste${VARIANT}/${testInfo.project.name}-plain-mode.json`, { check: 'V13-paste-plain-mode', browser: browserInfo(page, testInfo), timestamp: new Date().toISOString(), diff });
    expect.soft(after.text.includes('项目周报'), '粘贴了文字').toBe(true);
    expect.soft(diff.headings, '没有标题样式').toEqual([]);
    expect.soft(diff.tables, '没有表格').toEqual([]);
    expect.soft(diff.runs.filter((r) => r.ts.bl === 1), '没有粗体').toEqual([]);
});

test('V13 复制粘贴：同一文档内', async ({ page, context }, testInfo) => {
    // Chromium 内核：复制写入系统剪贴板需要授权（P4 的 D7 同样处理）；WebKit 走 SDK 的页内缓存
    if (testInfo.project.name !== 'webkit') await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(SERVERS.full).origin });
    await openDoc(page, `sample=p5-cap&${PLATFORM}`);
    await focusEditor(page);
    // 准备：标题、粗体、链接、列表
    await setSelection(page, (await offsetOf(page, '段落甲')) + 1);
    await exec(page, 'doc.command.set-paragraph-named-style', { value: 5 });
    const i = await offsetOf(page, '可以选中');
    await setSelection(page, i, i + 4);
    await exec(page, 'doc.command.set-inline-format-bold', {});
    const l = await offsetOf(page, '链接文字');
    await setSelection(page, l, l + 4);
    await exec(page, 'docs.command.add-hyper-link', { unitId: await page.evaluate(() => window.__m0!.editor!.unitId()), payload: 'https://example.com/copy' });
    await setSelection(page, (await offsetOf(page, '段落戊')) + 1);
    await exec(page, 'doc.command.order-list', {});
    const before = await docSummary(page);
    // 选中从"段落甲"到"段落己"一整段（跨标题、粗体、列表、链接），复制，粘贴到文末
    await setSelection(page, await offsetOf(page, '段落甲'), (await offsetOf(page, '查找目标。')) + 5);
    await press(page, 'Mod+c');
    await setSelection(page, await endOffset(page));
    await press(page, 'Mod+v');
    await page.waitForTimeout(1200);
    const after = await docSummary(page);
    const diff = added(before, after);
    const rt = await roundtrip(page, docId(testInfo, 'copy-same-doc'), PLATFORM);
    await writeResult(`v13/paste${VARIANT}/${testInfo.project.name}-copy-same-doc.json`, { check: 'V13-copy-same-doc', browser: browserInfo(page, testInfo), timestamp: new Date().toISOString(), diff, roundtrip: rt });
    expect.soft(diff.headings.length, '标题').toBe(1);
    expect.soft(diff.lists.length, '列表').toBe(1);
    expect.soft(diff.links.length, '链接').toBe(1);
    expect.soft(diff.runs.some((r) => r.ts.bl === 1), '粗体').toBe(true);
    expect.soft(rt.secondDiff, '再保存一致').toEqual([]);
});

test('V13 复制粘贴：另一个标签页、表格与文字文档之间（真实剪贴板）', async ({ page, context, browserName }, testInfo) => {
    test.skip(browserName === 'webkit', '无头 WebKit 不能读写系统剪贴板');
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(SERVERS.full).origin });
    const out: Record<string, unknown> = {};
    // 1. 文字文档 → 另一个标签页的文字文档
    await openDoc(page, `sample=doc-all&${PLATFORM}`);
    await focusEditor(page);
    const all = await docText(page);
    await setSelection(page, 0, all.indexOf('右对齐段落') + 5);
    await press(page, 'Mod+c');
    await page.waitForTimeout(500);
    const clip = await page.evaluate(async () => {
        const items = await navigator.clipboard.read();
        const types = items.flatMap((i) => [...i.types]);
        const htmlItem = items.find((i) => i.types.includes('text/html'));
        const text = htmlItem != null ? await (await htmlItem.getType('text/html')).text() : '';
        return { types, hasFragment: text.includes('univer-doc-fragment'), hasHeadingClass: text.includes('UniverHeading'), length: text.length };
    });
    const tab = await context.newPage();
    await openDoc(tab, `sample=p5-cap&${PLATFORM}`);
    await focusEditor(tab);
    await setSelection(tab, await endOffset(tab));
    const b1 = await docSummary(tab);
    await press(tab, 'Mod+v');
    await tab.waitForTimeout(1500);
    const d1 = added(b1, await docSummary(tab));
    out.docToDoc = { clipboard: clip, headings: d1.headings, runs: d1.runs.length, aligns: d1.aligns };
    // 2. 表格 → 文字文档
    const sheet = await context.newPage();
    await sheet.goto(`${SERVERS.full}/sheet.html?sample=sheet-core&worker=1`);
    await waitForEditor(sheet);
    const a1 = await cellCenter(sheet, 'A1');
    const b2 = await cellCenter(sheet, 'B2');
    await sheet.mouse.click(a1.x, a1.y);
    await sheet.keyboard.down('Shift');
    await sheet.mouse.click(b2.x, b2.y);
    await sheet.keyboard.up('Shift');
    await press(sheet, 'Mod+c');
    await sheet.waitForTimeout(800);
    await tab.bringToFront();
    await setSelection(tab, await endOffset(tab));
    const b3 = await docSummary(tab);
    await press(tab, 'Mod+v');
    await tab.waitForTimeout(1500);
    const d3 = added(b3, await docSummary(tab));
    out.sheetToDoc = { tables: d3.tables, paragraphs: d3.paragraphs };
    // 3. 文字文档 → 表格
    await setSelection(tab, await offsetOf(tab, '段落甲'), (await offsetOf(tab, '段落乙')) + 3);
    await press(tab, 'Mod+c');
    await tab.waitForTimeout(500);
    await sheet.bringToFront();
    const d4 = await cellCenter(sheet, 'D8');
    await sheet.mouse.click(d4.x, d4.y);
    await press(sheet, 'Mod+v');
    await sheet.waitForTimeout(1500);
    out.docToSheet = await sheet.evaluate(() => {
        const ws = window.__m0!.editor!.univerAPI.getActiveWorkbook()!.getActiveSheet();
        return [8, 9, 10].map((r) => ws.getRange(r - 1, 3).getValue());
    });
    const health = { doc: await pageHealth(tab), sheet: await sheet.evaluate(() => [...window.__m0!.events.errors, ...window.__m0!.events.consoleErrors]) };
    await writeResult(`v13/paste${VARIANT}/${testInfo.project.name}-cross.json`, { check: 'V13-copy-cross', browser: browserInfo(page, testInfo), timestamp: new Date().toISOString(), ...out, health });
    expect.soft((out.sheetToDoc as { tables: string[] }).tables.length, '表格粘贴到文字文档成为表格').toBe(1);
    expect.soft(health.doc.errors).toEqual([]);
});
