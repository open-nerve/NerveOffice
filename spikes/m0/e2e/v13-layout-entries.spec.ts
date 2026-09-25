// V13 版式、入口与档案范围（P5，00 号计划书 §4.3）：
// L1 版式：TRADITIONAL 的快照在平台配置下规范为 MODERN；
// L2 不支持功能的命令：隐藏菜单不会停用命令，平台用命令守卫取消（对照 SDK 默认）；
// L3 菜单审计：doc@1 的隐藏清单在工具栏、右键菜单、段落菜单与功能搜索中都生效；
// L4 目录的两种形态：只读的大纲侧栏（docs-ui 的 toc 配置）与目录块插件（docs-toc，tocblock=1 评估）；
// L5 附加能力（§4.3 之外、默认可见的入口）：分割线、表情、符号、段落设置、格式刷、清除格式；
// L6 去掉公式引擎（without=formula）：文字文档样本的保存重开与基本编辑照常。
import type { Page, TestInfo } from '@playwright/test';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { canonicalContent } from '../src/harness/content-compare';
import { DOC_UNSUPPORTED_MENUS } from '../src/profiles/ui-config';
import { browserInfo, SERVERS, writeResult } from './helpers';
import { snapshotText } from './p3-helpers';
import {
    caretPoint, clickToolbar, docId, docSummary, docText, endOffset, focusEditor, offsetOf, openDoc, pageHealth, PLATFORM, policyEvents, press, redo, resetHealth,
    ribbonTab, roundtrip, selectText, setSelection, undo,
} from './p5-helpers';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'doc');
const result = (testInfo: TestInfo, name: string, data: Record<string, unknown>, page: Page) =>
    writeResult(`v13/layout/${testInfo.project.name}-${name}.json`, { check: `V13-layout-${name}`, browser: browserInfo(page, testInfo), timestamp: new Date().toISOString(), ...data });

const exec = (page: Page, id: string, params: Record<string, unknown> = {}) =>
    page.evaluate(async ({ id, params }) => {
        try {
            return await window.__m0!.editor!.univerAPI.executeCommand(id, params);
        } catch (error) {
            return `错误：${error instanceof Error ? error.message.slice(0, 120) : String(error)}`;
        }
    }, { id, params });

/** 构造一份 TRADITIONAL 的快照（带页眉），存进验证服务的文档存储。 */
async function storeTraditional(page: Page, id: string): Promise<void> {
    const data = JSON.parse(readFileSync(join(FIXTURES, 'p5-cap.json'), 'utf8')) as Record<string, any>;
    data.id = id;
    data.documentStyle = { ...data.documentStyle, documentFlavor: 1, defaultHeaderId: 'hdr1' };
    data.headers = { hdr1: { headerId: 'hdr1', body: { dataStream: '页眉文字\r\n', paragraphs: [{ startIndex: 4 }], sectionBreaks: [{ startIndex: 5 }] } } };
    const res = await page.request.put(`${SERVERS.full}/api/docs/${id}`, { data });
    if (!res.ok()) throw new Error(`写入文档失败：${res.status()}`);
}

for (const config of ['default', 'platform'] as const) {
    test(`L1 版式：TRADITIONAL 快照（${config}）`, async ({ page }, testInfo) => {
        const id = docId(testInfo, `traditional-${config}`);
        await storeTraditional(page, id);
        await openDoc(page, `doc=${id}${config === 'platform' ? `&${PLATFORM}` : ''}`);
        const snap = JSON.parse(await snapshotText(page)) as { documentStyle: { documentFlavor?: number }; headers?: Record<string, unknown> };
        const menus = await page.evaluate(() => window.__m0!.auditMenus!().filter((m) => ['doc.command.open-header-footer-panel', 'doc.menu.breaks'].includes(m.id)).map((m) => ({ id: m.id, hidden: m.hidden })));
        const events = await policyEvents(page);
        await page.screenshot({ path: testInfo.outputPath(`traditional-${config}.png`) });
        await result(testInfo, `traditional-${config}`, { config, flavor: snap.documentStyle.documentFlavor, headers: Object.keys(snap.headers ?? {}), menus, policyEvents: events }, page);
        if (config === 'platform') {
            expect.soft(snap.documentStyle.documentFlavor, '平台配置：规范为 MODERN').toBe(2);
            expect.soft(menus.every((m) => m.hidden === true), '页眉页脚与分隔符入口隐藏').toBe(true);
        }
    });
}

/** 不支持功能的命令与参数（参数取自 SDK 的菜单与操作）。 */
const UNSUPPORTED: { id: string; params: (unitId: string) => Record<string, unknown> }[] = [
    { id: 'doc.command.switch-mode', params: () => ({}) },
    { id: 'docs.command.page-setup', params: (unitId) => ({ unitId, documentStyle: { documentFlavor: 1 } }) },
    { id: 'doc.command.insert-section-break', params: () => ({}) },
    { id: 'doc.command.insert-column-break', params: () => ({}) },
    { id: 'doc.command.core-header-footer', params: (unitId) => ({ unitId, createType: 0, headerFooterProps: {} }) },
    { id: 'doc.command.create-header-footer', params: (unitId) => ({ unitId, createType: 0 }) },
    { id: 'doc.command.insert-float-shape.rectangle', params: () => ({}) },
    { id: 'doc.command.insert-float-shape.ellipse', params: () => ({}) },
];

for (const config of ['default', 'platform'] as const) {
    test(`L2 不支持功能的命令（${config}）`, async ({ page }, testInfo) => {
        await openDoc(page, `sample=p5-cap${config === 'platform' ? `&${PLATFORM}` : ''}`);
        await focusEditor(page);
        const unitId = await page.evaluate(() => window.__m0!.editor!.unitId());
        const out: Record<string, unknown>[] = [];
        for (const c of UNSUPPORTED) {
            await setSelection(page, (await offsetOf(page, '段落乙')) + 2);
            const before = await snapshotText(page);
            const r = await exec(page, c.id, c.params(unitId));
            await page.waitForTimeout(300);
            const after = await snapshotText(page);
            const s = JSON.parse(after) as { documentStyle: { documentFlavor?: number }; headers?: object; drawings?: object };
            out.push({ id: c.id, result: r, changed: canonicalContent(before) !== canonicalContent(after), flavor: s.documentStyle.documentFlavor, headers: Object.keys(s.headers ?? {}).length, drawings: Object.keys(s.drawings ?? {}).length });
            if (canonicalContent(before) !== canonicalContent(after)) await press(page, 'Mod+z');
        }
        // Facade：ensurePageHeader（源码梳理：没有 MODERN 的限制）
        const facade = await page.evaluate(() => {
            try {
                const doc = window.__m0!.editor!.univerAPI.getActiveDocument()! as unknown as { ensurePageHeader?: () => string };
                return { segmentId: doc.ensurePageHeader?.() ?? null };
            } catch (error) {
                return { error: error instanceof Error ? error.message.slice(0, 120) : String(error) };
            }
        });
        const headers = Object.keys((JSON.parse(await snapshotText(page)) as { headers?: object }).headers ?? {}).length;
        const events = await policyEvents(page);
        await result(testInfo, `commands-${config}`, { config, commands: out, facadeEnsurePageHeader: { ...facade, headers }, policyEvents: events }, page);
        if (config === 'platform') {
            for (const o of out) expect.soft(o.changed, `${o.id} 没有改动文档`).toBe(false);
            expect.soft(headers, 'Facade 的 ensurePageHeader 也没有建出页眉').toBe(0);
        }
    });
}

test('L3 菜单审计：doc@1 的隐藏清单', async ({ page }, testInfo) => {
    await openDoc(page, `sample=p5-cap&${PLATFORM}`);
    const items = await page.evaluate(() => window.__m0!.auditMenus!());
    const unsupported = DOC_UNSUPPORTED_MENUS as readonly string[];
    const present = items.filter((i) => unsupported.includes(i.id));
    const visible = [...new Set(items.filter((i) => i.hidden !== true && !unsupported.includes(i.id)).map((i) => i.id))].sort();
    // 功能搜索：已隐藏的项不应出现
    await page.evaluate(() => window.__m0!.editor!.univerAPI.executeCommand('ui.operation.open-feature-search'));
    await page.waitForTimeout(500);
    const search: Record<string, string[]> = {};
    // 覆盖每个隐藏项的标题（页面设置、页眉页脚、分隔符与各类分节符、分节设置、形状及其子项、组合、层级、多图对齐）与目录
    for (const q of ['页面设置', '页眉', '分隔符', '分栏符', '分节', '形状', '矩形', '椭圆', '组合', '置于顶层', '上移一层', '水平分布', '顶部对齐', '目录']) {
        await page.getByPlaceholder(/输入功能或菜单名称/).fill(q);
        await page.waitForTimeout(300);
        search[q] = (await page.getByRole('dialog').innerText()).split('\n').slice(1, 6);
    }
    await page.keyboard.press('Escape');
    // `/` 菜单
    await focusEditor(page);
    await setSelection(page, await endOffset(page));
    await page.keyboard.type('/');
    await page.waitForTimeout(500);
    const slash = await page.evaluate(() => [...document.querySelectorAll('button')].filter((b) => b.offsetParent != null).map((b) => b.getAttribute('aria-label') || b.innerText.trim()).filter((t) => /插入|粘贴|形状|目录/.test(t)));
    await result(testInfo, 'menus', { unsupported: present.map((i) => ({ id: i.id, path: i.path, hidden: i.hidden })), visible, search, slash }, page);
    for (const i of present) expect.soft(i.hidden, `${i.id} 已隐藏（${i.path}）`).toBe(true);
    for (const [q, lines] of Object.entries(search)) expect.soft(lines.some((l) => l.includes('未找到')), `功能搜索"${q}"找不到`).toBe(true);
    expect.soft(slash.some((t) => t.includes('形状') || t.includes('目录')), '`/` 菜单没有形状与目录').toBe(false);
});

test('L4a 目录：只读的大纲侧栏', async ({ page }, testInfo) => {
    const out: Record<string, unknown> = {};
    for (const mode of ['edit', 'read'] as const) {
        await openDoc(page, `sample=doc-all&${PLATFORM}&outline=1${mode === 'read' ? '&mode=read' : ''}`);
        const nav = page.getByRole('navigation', { name: '文档大纲' });
        const entries = await nav.getByRole('button').allInnerTexts();
        const mark = await page.evaluate(() => window.__m0!.editor!.detector.mark());
        const scrollBefore = await page.evaluate(() => (JSON.stringify(window.__m0!.editor!.univerAPI.getActiveDocument()!.getBody().dataStream.length)));
        await nav.getByRole('button', { name: '五级标题' }).click();
        await page.waitForTimeout(600);
        const detections = await page.evaluate((mark) => window.__m0!.editor!.detector.state(mark).detections.length, mark);
        const health = await pageHealth(page);
        out[mode] = { entries, detections, scrollBefore, health };
        await page.screenshot({ path: testInfo.outputPath(`outline-${mode}.png`) });
    }
    await result(testInfo, 'outline', out, page);
    const edit = out.edit as { entries: string[]; detections: number; health: { errors: string[] } };
    expect.soft(edit.entries, '大纲列出标题').toEqual(['文档标题', '一级标题', '二级标题', '三级标题', '四级标题', '五级标题']);
    expect.soft(edit.detections, '点击大纲不改动内容').toBe(0);
    expect.soft((out.read as { entries: string[] }).entries.length, '阅读模式下也有大纲').toBe(6);
    expect.soft(edit.health.errors).toEqual([]);
});

test('L4b 目录：目录块插件（评估）', async ({ page }, testInfo) => {
    // 目录只认带 headingId、outlineLevel 的标题：界面设置的标题有，样本构建器（Facade 的 setStyle）设置的没有，见下面的对照
    await openDoc(page, `sample=doc-all&${PLATFORM}&tocblock=1`);
    await focusEditor(page);
    await setSelection(page, 0);
    await ribbonTab(page, '插入');
    await page.locator('[data-u-command="doc.menu.insert-table-of-contents"]').first().click();
    await page.getByRole('menu').getByText('自动目录', { exact: true }).click();
    await page.waitForTimeout(800);
    await ribbonTab(page, '开始');
    const facadeHeadings = { inserted: (await docText(page)).startsWith('目录'), paragraphs: (JSON.parse(await snapshotText(page)) as { body: { paragraphs: { paragraphStyle?: { namedStyleType?: number; headingId?: string; outlineLevel?: number } }[] } }).body.paragraphs.filter((p) => (p.paragraphStyle?.namedStyleType ?? 0) >= 4).map((p) => ({ headingId: p.paragraphStyle?.headingId ?? null, outlineLevel: p.paragraphStyle?.outlineLevel ?? null })).slice(0, 3) };
    await openDoc(page, `sample=p5-cap&${PLATFORM}&tocblock=1`);
    await focusEditor(page);
    await resetHealth(page);
    for (const [text, level] of [['段落甲', 4], ['段落乙', 5], ['段落丙', 6]] as const) {
        await setSelection(page, (await offsetOf(page, text)) + 1);
        await exec(page, 'doc.command.set-paragraph-named-style', { value: level });
    }
    await setSelection(page, 0);
    await ribbonTab(page, '插入');
    await page.locator('[data-u-command="doc.menu.insert-table-of-contents"]').first().click();
    await page.getByRole('menu').getByText('自动目录', { exact: true }).click();
    await page.waitForTimeout(800);
    await ribbonTab(page, '开始');
    const snap = JSON.parse(await snapshotText(page)) as { body: { dataStream: string; customRanges?: { rangeType: number; startIndex: number; endIndex: number; properties?: Record<string, unknown> }[] } };
    const ranges = (snap.body.customRanges ?? []).map((r) => ({ type: r.rangeType, text: snap.body.dataStream.slice(r.startIndex, r.endIndex + 1).replace(/[\r\n]/g, '⏎').slice(0, 20), properties: r.properties }));
    // 改一个标题，再更新目录（目录区间的右键菜单与"目录"功能区的"更新目录"执行的是同一个命令）
    const t = await offsetOf(page, '段落丙', (await docText(page)).lastIndexOf('段落乙'));
    await setSelection(page, t + 3);
    await page.keyboard.type('改');
    await page.waitForTimeout(300);
    const update = await exec(page, 'doc.command.update-table-of-contents', {});
    await page.waitForTimeout(500);
    const occurrencesAfterUpdate = (await docText(page)).split('段落丙改').length - 1;
    const rt = await roundtrip(page, docId(testInfo, 'tocblock'), `${PLATFORM}&tocblock=1`);
    const health = await pageHealth(page);
    await result(testInfo, 'tocblock', { facadeHeadings, ranges, update, occurrencesAfterUpdate, roundtrip: rt, health }, page);
    expect.soft(ranges.some((r) => r.type === 1 && (r.properties as { fieldType?: string })?.fieldType === 'TOC'), '插入了 TOC 区间').toBe(true);
    expect.soft(rt.secondDiff, '再保存一致').toEqual([]);
});

/** 悬停在段落上，点开左侧的把手（"拖动块"），在把手菜单里点选一项。 */
async function handleMenu(page: Page, paragraphText: string, item: string): Promise<void> {
    await setSelection(page, (await offsetOf(page, paragraphText)) + 1);
    const at = await caretPoint(page);
    await page.mouse.move(at.x + 20, at.y + 8);
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: '拖动块' }).first().click();
    await page.waitForTimeout(400);
    await page.getByText(item, { exact: true }).last().click();
    await page.waitForTimeout(400);
}

test('L5b 段落把手与粘贴选项（G9：保留的可见入口）', async ({ page, context }, testInfo) => {
    const clipboard = testInfo.project.name !== 'webkit';
    if (clipboard) await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(SERVERS.full).origin });
    await openDoc(page, `sample=p5-cap&${PLATFORM}`);
    await focusEditor(page);
    await resetHealth(page);
    const steps: { step: string; ok: boolean; detail?: unknown }[] = [];
    const count = async (t: string) => (await docText(page)).split(t).length - 1;
    const undos = () => page.evaluate(() => window.__m0!.editor!.undoStatus().undos);
    const text0 = await docText(page);
    const undos0 = await undos();
    await handleMenu(page, '段落丙', '删除');
    steps.push({ step: '把手菜单：删除段落', ok: (await count('段落丙')) === 0 });
    await handleMenu(page, '段落丁', '复制');
    await setSelection(page, await endOffset(page));
    await press(page, 'Mod+v');
    await page.waitForTimeout(600);
    steps.push({ step: '把手菜单：复制段落后粘贴', ok: (await count('段落丁')) === 2, detail: await count('段落丁') });
    await handleMenu(page, '段落戊', '剪切');
    const cutGone = (await count('段落戊')) === 0;
    await setSelection(page, await endOffset(page));
    await press(page, 'Mod+v');
    await page.waitForTimeout(600);
    steps.push({ step: '把手菜单：剪切段落后粘贴', ok: cutGone && (await count('段落戊')) === 1 });
    // 拖动把手：把"段落甲"拖到"段落己"之后
    await setSelection(page, (await offsetOf(page, '段落甲')) + 1);
    const a = await caretPoint(page);
    await page.mouse.move(a.x + 20, a.y + 8);
    await page.waitForTimeout(400);
    const handle = (await page.getByRole('button', { name: '拖动块' }).first().boundingBox())!;
    await setSelection(page, (await offsetOf(page, '查找目标。')) + 5);
    const b = await caretPoint(page);
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2, b.y + 20, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(600);
    const text = await docText(page);
    steps.push({ step: '拖动把手移动段落', ok: text.indexOf('段落甲') > text.indexOf('段落己'), detail: text.slice(0, 40).replace(/\r/g, '⏎') });
    // 粘贴选项（工具栏）：先用剪贴板接口写入 HTML，再选"仅保留文本"
    if (clipboard) {
        await page.evaluate(async () => {
            const html = '<p><b>粗体的剪贴板内容</b></p>';
            await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob(['粗体的剪贴板内容'], { type: 'text/plain' }) })]);
        });
        await setSelection(page, await endOffset(page));
        const box = (await page.locator('[data-u-command="doc.command.paste-special"]').first().boundingBox())!;
        await page.mouse.click(box.x + box.width - 8, box.y + box.height / 2);
        await page.waitForTimeout(400);
        await page.getByText('仅保留文本', { exact: true }).last().click();
        await page.waitForTimeout(800);
        const run = (await docSummary(page)).runs.find((r) => r.text.includes('粗体的剪贴板内容'));
        steps.push({ step: '粘贴选项：仅保留文本', ok: (await count('粗体的剪贴板内容')) === 1 && run?.ts.bl !== 1, detail: run ?? null });
    }
    // 这些入口都会改结构：按撤销栈的增量逐步撤销回到原文，再逐步重做
    const text1 = await docText(page);
    const n = (await undos()) - undos0;
    for (let i = 0; i < n; i++) await undo(page);
    const restored = (await docText(page)) === text0;
    for (let i = 0; i < n; i++) await redo(page);
    const redone = (await docText(page)) === text1;
    steps.push({ step: '撤销回到原文、重做恢复', ok: n > 0 && restored && redone, detail: { undos: n, restored, redone } });
    const rt = await roundtrip(page, docId(testInfo, 'handle'), PLATFORM);
    const health = await pageHealth(page);
    await result(testInfo, 'handle', { steps, roundtrip: rt, health }, page);
    for (const s of steps) expect.soft(s.ok, `${s.step}：${JSON.stringify(s.detail)?.slice(0, 200)}`).toBe(true);
    expect.soft(rt.secondDiff, '再保存一致').toEqual([]);
    expect.soft(health.errors).toEqual([]);
});

test('L5 附加能力', async ({ page }, testInfo) => {
    await openDoc(page, `sample=p5-cap&${PLATFORM}`);
    await focusEditor(page);
    await resetHealth(page);
    const steps: { step: string; ok: boolean; detail?: unknown }[] = [];
    // 分割线（插入 → 水平分割线）
    await setSelection(page, (await offsetOf(page, '段落乙')) + 3);
    await ribbonTab(page, '插入');
    await clickToolbar(page, 'doc.command.horizontal-line');
    const hrSnap = JSON.parse(await snapshotText(page)) as { body: { paragraphs: { paragraphStyle?: { borderBottom?: unknown } }[] } };
    steps.push({ step: '水平分割线', ok: hrSnap.body.paragraphs.some((p) => p.paragraphStyle?.borderBottom != null), detail: hrSnap.body.paragraphs.filter((p) => p.paragraphStyle?.borderBottom != null).length });
    // 符号：插入 → 符号 → ※
    await setSelection(page, (await offsetOf(page, '段落丙')) + 3);
    await page.locator('[data-u-command="doc.menu.insert-symbol"]').first().click();
    await page.getByRole('button', { name: '※', exact: true }).click();
    await page.waitForTimeout(300);
    steps.push({ step: '符号', ok: (await docText(page)).includes('段落丙※'), detail: null });
    // 表情：插入 → 表情 → 第一个
    await setSelection(page, (await offsetOf(page, '段落丁')) + 3);
    await page.locator('[data-u-command="doc.menu.insert-emoji"]').first().click();
    await page.waitForTimeout(400);
    // 表情面板：右上角的"✋"是肤色选择，取网格里的"😀"
    const emojiButton = page.locator('button').filter({ hasText: /^😀$/ }).first();
    const emoji = await emojiButton.innerText().catch(() => '');
    await emojiButton.click().catch(() => undefined);
    await page.waitForTimeout(300);
    steps.push({ step: '表情', ok: emoji !== '' && (await docText(page)).includes(`段落丁${emoji}`), detail: emoji });
    await ribbonTab(page, '开始');
    // 格式刷：把"可以选中"的粗体刷到"用于对齐"
    const bold = await offsetOf(page, '可以选中');
    await setSelection(page, bold, bold + 4);
    await press(page, 'Mod+b');
    await setSelection(page, bold + 1);
    await clickToolbar(page, 'ui.operation.activate-format-painter');
    await selectText(page, '用于对齐');
    // 格式刷在选区变化（鼠标抬起）时应用：用鼠标在目标文字上拖选
    const t = await offsetOf(page, '用于对齐');
    await setSelection(page, t);
    const p1 = await caretPoint(page);
    await setSelection(page, t + 4);
    const p2 = await caretPoint(page);
    await page.mouse.move(p1.x + 1, p1.y + 8);
    await page.mouse.down();
    await page.mouse.move(p2.x - 1, p2.y + 8, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const painted = (await docSummary(page)).runs.find((r) => r.text.includes('用于对齐'));
    steps.push({ step: '格式刷', ok: painted?.ts.bl === 1, detail: painted });
    // 清除格式
    await setSelection(page, bold, bold + 4);
    await clickToolbar(page, 'ui.command.clear-formatting');
    const cleared = (await docSummary(page)).runs.find((r) => r.text.includes('可以选中'));
    steps.push({ step: '清除格式', ok: cleared == null || cleared.ts.bl !== 1, detail: cleared ?? null });
    // 段落设置：右键 → 段落设置 → 首行缩进 +
    await setSelection(page, (await offsetOf(page, '段落戊')) + 2);
    await exec(page, 'sidebar.operation.doc-paragraph-setting-panel');
    await page.waitForTimeout(500);
    const firstLine = page.getByText('首行(px)', { exact: true }).locator('..').getByRole('textbox');
    await firstLine.fill('24');
    await firstLine.press('Enter');
    await page.waitForTimeout(400);
    const indent = (JSON.parse(await snapshotText(page)) as { body: { paragraphs: { paragraphStyle?: { indentFirstLine?: unknown } }[] } }).body.paragraphs.find((p) => p.paragraphStyle?.indentFirstLine != null)?.paragraphStyle;
    steps.push({ step: '段落设置：首行缩进', ok: indent != null, detail: indent });
    await page.keyboard.press('Escape');
    const rt = await roundtrip(page, docId(testInfo, 'extras'), PLATFORM);
    const health = await pageHealth(page);
    await result(testInfo, 'extras', { steps, roundtrip: rt, health }, page);
    for (const s of steps) expect.soft(s.ok, `${s.step}：${JSON.stringify(s.detail)?.slice(0, 200)}`).toBe(true);
    expect.soft(rt.secondDiff, '再保存一致').toEqual([]);
    expect.soft(health.errors).toEqual([]);
});

test('L6 去掉公式引擎：样本的保存重开与基本编辑', async ({ page }, testInfo) => {
    const samples = ['minimal', 'doc-text', 'doc-list', 'doc-hyperlink', 'doc-table', 'doc-drawing', 'doc-all', 'p5-cap'];
    const out: Record<string, unknown>[] = [];
    for (const sample of samples) {
        const texts: Record<string, string> = {};
        for (const variant of ['', '&without=formula']) {
            await openDoc(page, `sample=${sample}${variant}`);
            // 手写样本没有 sectionId，加载时随机生成，比较前去掉
            texts[variant] = canonicalContent((await snapshotText(page)).replace(/"sectionId":"[^"]*"/g, '"sectionId":""'));
        }
        await openDoc(page, `sample=${sample}&without=formula`);
        const rt = await roundtrip(page, docId(testInfo, `noformula-${sample}`), 'without=formula');
        out.push({ sample, sameAsWithFormula: texts[''] === texts['&without=formula'], roundtrip: rt });
    }
    // 基本编辑：加粗、列表、表格、链接
    await openDoc(page, `sample=p5-cap&${PLATFORM}&without=formula`);
    await focusEditor(page);
    await resetHealth(page);
    await selectText(page, '可以选中');
    await press(page, 'Mod+b');
    await setSelection(page, (await offsetOf(page, '段落丁')) + 2);
    await press(page, 'Mod+Shift+7');
    await setSelection(page, await endOffset(page));
    await exec(page, 'doc.command.create-table', { rowCount: 2, colCount: 2 });
    await page.waitForTimeout(300);
    const s = await docSummary(page);
    const health = await pageHealth(page);
    const registered = await page.evaluate(() => window.__m0!.editor!.resourceHooks().map((h) => h.name));
    await result(testInfo, 'no-formula', { samples: out, edits: { bold: s.runs.some((r) => r.ts.bl === 1), list: s.paragraphs.some((p) => p.list === 'ORDER_LIST'), tables: s.tables.length }, health, resourceHooks: registered }, page);
    for (const o of out) {
        expect.soft(o.sameAsWithFormula, `${o.sample}：与带公式引擎时的快照一致`).toBe(true);
        expect.soft((o.roundtrip as { secondDiff: string[] }).secondDiff, `${o.sample}：再保存一致`).toEqual([]);
    }
    expect.soft(health.errors).toEqual([]);
});
