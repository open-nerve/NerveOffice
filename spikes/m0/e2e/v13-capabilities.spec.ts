// V13 能力矩阵（P5，00 号计划书 §4.3）：每项能力走用户的入口（工具栏、快捷键、菜单、`/` 菜单），然后检查：
// 快照里的结构；撤销回到原状、重做恢复；保存 → 重开 → 再保存两次快照一致；没有页面错误与 CSP 强制违规。
// 平台配置（img=platform&docpolicy=platform）、严格 CSP、三个浏览器。个别能力另跑 SDK 默认作对照（C5 单元格图片、C7 链接地址、C8 `/` 键）。
import type { Page, TestInfo } from '@playwright/test';
import type { DocSummary } from './p5-helpers';

import { expect, test } from '@playwright/test';
import { browserInfo, writeResult } from './helpers';
import {
    caretPoint, clickToolbar, docId, docSummary, docText, endOffset, fillLinkPopup, findColorBox, focusEditor, imageToolbarButtons, offsetOf, openDoc,
    openedWindows, pageHealth, PLATFORM, policyEvents, press, redo, resetHealth, ribbonTab, roundtrip, selectText, setSelection, stubWindowOpen, undo,
} from './p5-helpers';
import { fixtureFile, insertViaFileChooser, syntheticPaste } from './p4-helpers';

interface Step {
    step: string;
    ok: boolean;
    detail?: unknown;
}

interface CapabilityResult {
    id: string;
    name: string;
    config: string;
    steps: Step[];
    undo: { count: number; restored: boolean; redone: boolean };
    roundtrip: { firstDiff: string[]; secondDiff: string[]; preserved: boolean } | null;
    health: { errors: string[]; cspEnforce: string[] };
    policyEvents: { kind: string; detail: string }[];
}

/** 摘要中与内容有关的部分（图片 id、文字样式细节都参与比较）。 */
const contentOf = (s: DocSummary) => JSON.stringify({ text: s.text, paragraphs: s.paragraphs, tables: s.tables, links: s.links, runs: s.runs, images: s.images });

async function undoCount(page: Page): Promise<number> {
    return page.evaluate(() => window.__m0!.editor!.undoStatus().undos);
}

/**
 * 一项能力的完整检查：act 里执行用户操作并记录步骤；之后按撤销栈的增量撤销、重做；最后保存重开。
 * roundtrip 为 false 时跳过保存重开（例如对照组）。
 */
async function capability(
    page: Page,
    testInfo: TestInfo,
    meta: { id: string; name: string; config?: 'platform' | 'default'; sample?: string; roundtrip?: boolean },
    act: (steps: Step[]) => Promise<void>,
): Promise<CapabilityResult> {
    const config = meta.config ?? 'platform';
    const query = `sample=${meta.sample ?? 'p5-cap'}${config === 'platform' ? `&${PLATFORM}` : ''}`;
    await openDoc(page, query);
    await focusEditor(page);
    await resetHealth(page);
    const before = await docSummary(page);
    const undos0 = await undoCount(page);
    const steps: Step[] = [];
    await act(steps);
    await page.waitForTimeout(400);
    const after = await docSummary(page);
    const count = (await undoCount(page)) - undos0;
    for (let i = 0; i < count; i++) await undo(page);
    const restored = contentOf(await docSummary(page)) === contentOf(before);
    for (let i = 0; i < count; i++) await redo(page);
    const redone = contentOf(await docSummary(page)) === contentOf(after);
    const health = await pageHealth(page);
    const events = await policyEvents(page);
    let rt: CapabilityResult['roundtrip'] = null;
    if (meta.roundtrip !== false) {
        const r = await roundtrip(page, docId(testInfo, `cap-${meta.id}-${config}`), config === 'platform' ? PLATFORM : '');
        rt = { ...r, preserved: contentOf(await docSummary(page)) === contentOf(after) };
    }
    const result: CapabilityResult = { id: meta.id, name: meta.name, config, steps, undo: { count, restored, redone }, roundtrip: rt, health, policyEvents: events };
    await writeResult(`v13/capabilities/${testInfo.project.name}-${meta.id}-${config}.json`, {
        check: 'V13-capability', browser: browserInfo(page, testInfo), timestamp: new Date().toISOString(), ...result,
        summary: { before: { paragraphs: before.paragraphs.length }, after },
    });
    return result;
}

function expectCapability(r: CapabilityResult, opts: { undo?: boolean } = {}): void {
    for (const s of r.steps) expect.soft(s.ok, `${r.id} ${s.step}：${JSON.stringify(s.detail)?.slice(0, 300)}`).toBe(true);
    if (opts.undo !== false) {
        expect.soft(r.undo.count, `${r.id} 撤销栈有记录`).toBeGreaterThan(0);
        expect.soft(r.undo.restored, `${r.id} 撤销回到原状`).toBe(true);
        expect.soft(r.undo.redone, `${r.id} 重做恢复`).toBe(true);
    }
    if (r.roundtrip != null) {
        expect.soft(r.roundtrip.secondDiff, `${r.id} 再保存一致`).toEqual([]);
        expect.soft(r.roundtrip.preserved, `${r.id} 重开后内容不变`).toBe(true);
    }
    expect.soft(r.health.errors, `${r.id} 没有页面错误`).toEqual([]);
    expect.soft(r.health.cspEnforce, `${r.id} 没有 CSP 强制违规`).toEqual([]);
}

const para = async (page: Page, text: string) => (await docSummary(page)).paragraphs.find((p) => p.text.includes(text));
const runOf = async (page: Page, text: string) => (await docSummary(page)).runs.find((r) => r.text.includes(text))?.ts ?? null;

/** 光标放在某段文字之后（段落中间）。 */
async function caretAfter(page: Page, text: string): Promise<void> {
    await setSelection(page, (await offsetOf(page, text)) + text.length);
}

/** 工具栏下拉（选择器）：点开后按文字点选。 */
async function chooseFromSelector(page: Page, commandId: string, option: string): Promise<void> {
    await page.locator(`[data-u-command="${commandId}"]`).first().click();
    await page.getByRole('menu').getByText(option, { exact: true }).first().click();
    await page.waitForTimeout(250);
}

/** 按钮加下拉的组合按钮：点右侧的下拉箭头。 */
async function openButtonDropdown(page: Page, commandId: string): Promise<void> {
    const box = (await page.locator(`[data-u-command="${commandId}"]`).first().boundingBox())!;
    await page.mouse.click(box.x + box.width - 8, box.y + box.height / 2);
    await page.waitForTimeout(300);
}

async function pickPresetColor(page: Page, commandId: string, rgb: string): Promise<void> {
    await openButtonDropdown(page, commandId);
    await page.locator(`[data-u-comp="color-picker-presets"] button[style*="${rgb}"]`).first().click();
    await page.waitForTimeout(250);
}

async function resetColor(page: Page, commandId: string): Promise<void> {
    await openButtonDropdown(page, commandId);
    await page.getByText('重置颜色', { exact: true }).first().click();
    await page.waitForTimeout(250);
}

test('C1 标题样式', async ({ page }, testInfo) => {
    const r = await capability(page, testInfo, { id: 'C1', name: '标题样式' }, async (steps) => {
        await caretAfter(page, '段落甲');
        await chooseFromSelector(page, 'doc.command.set-paragraph-named-style', '标题1');
        steps.push({ step: '工具栏：段落甲设为标题1', ok: (await para(page, '段落甲'))?.style === 4, detail: await para(page, '段落甲') });
        await caretAfter(page, '段落乙');
        await press(page, 'Mod+Alt+2');
        steps.push({ step: '快捷键 ⌘⌥2：段落乙设为标题2', ok: (await para(page, '段落乙'))?.style === 5, detail: await para(page, '段落乙') });
        await caretAfter(page, '段落丙');
        await chooseFromSelector(page, 'doc.command.set-paragraph-named-style', '标题');
        steps.push({ step: '工具栏：段落丙设为标题', ok: (await para(page, '段落丙'))?.style === 2, detail: await para(page, '段落丙') });
        await caretAfter(page, '段落丁');
        await chooseFromSelector(page, 'doc.command.set-paragraph-named-style', '副标题');
        steps.push({ step: '工具栏：段落丁设为副标题', ok: (await para(page, '段落丁'))?.style === 3, detail: await para(page, '段落丁') });
        await caretAfter(page, '段落戊');
        await chooseFromSelector(page, 'doc.command.set-paragraph-named-style', '标题5');
        steps.push({ step: '工具栏：段落戊设为标题5', ok: (await para(page, '段落戊'))?.style === 8, detail: await para(page, '段落戊') });
        await setSelection(page, await endOffset(page));
        await page.keyboard.type('### Markdown 标题', { delay: 30 });
        await page.waitForTimeout(300);
        const md = await para(page, 'Markdown 标题');
        steps.push({ step: '空段落里键入 "### " 转为标题3', ok: md?.style === 6 && md.text === 'Markdown 标题', detail: md });
    });
    expectCapability(r);
});

test('C2 字符格式', async ({ page }, testInfo) => {
    const r = await capability(page, testInfo, { id: 'C2', name: '字符格式' }, async (steps) => {
        await selectText(page, '可以选中');
        await press(page, 'Mod+b');
        await press(page, 'Mod+i');
        await press(page, 'Mod+u');
        await press(page, 'Mod+Shift+x');
        const ts = await runOf(page, '可以选中') as Record<string, { s?: number } | number> | null;
        steps.push({ step: '快捷键：粗体、斜体、下划线、删除线', ok: ts?.bl === 1 && ts?.it === 1 && (ts?.ul as { s?: number })?.s === 1 && (ts?.st as { s?: number })?.s === 1, detail: ts });
        await selectText(page, '文字。');
        await clickToolbar(page, 'doc.command.set-inline-format-subscript');
        steps.push({ step: '工具栏：下标', ok: (await runOf(page, '文字'))?.va === 2, detail: await runOf(page, '文字') });
        await selectText(page, '段落乙');
        await clickToolbar(page, 'doc.command.set-inline-format-superscript');
        steps.push({ step: '工具栏：上标', ok: (await runOf(page, '段落乙'))?.va === 3, detail: await runOf(page, '段落乙') });
        await selectText(page, '用于字符格式');
        const size = page.locator('[data-u-command="doc.command.set-inline-format-fontsize"] input').first();
        await size.click();
        await size.fill('18');
        await size.press('Enter');
        await page.waitForTimeout(300);
        steps.push({ step: '工具栏：字号 18', ok: (await runOf(page, '用于字符格式'))?.fs === 18, detail: await runOf(page, '用于字符格式') });
        await selectText(page, '这里有');
        await openButtonDropdown(page, 'doc.command.set-inline-format-font-family');
        await page.getByRole('menu').getByText('宋体', { exact: true }).first().click();
        await page.waitForTimeout(300);
        steps.push({ step: '工具栏：字体 宋体', ok: (await runOf(page, '这里有'))?.ff != null, detail: await runOf(page, '这里有') });
        await selectText(page, '一段');
        await pickPresetColor(page, 'doc.command.set-inline-format-text-color', 'rgb(240, 82, 82)');
        steps.push({ step: '工具栏：文字颜色', ok: (await runOf(page, '一段'))?.cl != null, detail: await runOf(page, '一段') });
        await selectText(page, '用于对齐');
        await pickPresetColor(page, 'doc.command.set-inline-format-text-background-color', 'rgb(255, 244, 185)');
        steps.push({ step: '工具栏：高亮', ok: (await runOf(page, '用于对齐'))?.bg != null, detail: await runOf(page, '用于对齐') });
    });
    expectCapability(r);
});

test('C2b 重置文字颜色与高亮（工具栏）', async ({ page }, testInfo) => {
    // 源码梳理：工具栏的"重置"调用的是设置命令，写入主题色（疑似缺陷）。这里只记录结果，不作为能力是否可用的断言
    const r = await capability(page, testInfo, { id: 'C2b', name: '重置文字颜色与高亮', roundtrip: false }, async (steps) => {
        await selectText(page, '一段');
        await pickPresetColor(page, 'doc.command.set-inline-format-text-color', 'rgb(240, 82, 82)');
        await pickPresetColor(page, 'doc.command.set-inline-format-text-background-color', 'rgb(255, 244, 185)');
        const set = await runOf(page, '一段');
        await resetColor(page, 'doc.command.set-inline-format-text-color');
        await resetColor(page, 'doc.command.set-inline-format-text-background-color');
        const reset = await runOf(page, '一段');
        steps.push({ step: '重置后（记录）', ok: true, detail: { set, reset } });
    });
    for (const s of r.steps) expect.soft(s.ok).toBe(true);
});

test('C3 段落对齐', async ({ page }, testInfo) => {
    const r = await capability(page, testInfo, { id: 'C3', name: '段落对齐' }, async (steps) => {
        await caretAfter(page, '段落丙');
        await chooseFromSelector(page, 'doc.command.align-action', '居中对齐');
        steps.push({ step: '工具栏：居中', ok: (await para(page, '段落丙'))?.align === 2, detail: await para(page, '段落丙') });
        await caretAfter(page, '段落丁');
        await press(page, 'Mod+Shift+r');
        steps.push({ step: '快捷键 ⌘⇧R：右对齐', ok: (await para(page, '段落丁'))?.align === 3, detail: await para(page, '段落丁') });
        await caretAfter(page, '段落甲');
        await press(page, 'Mod+Shift+j');
        steps.push({ step: '快捷键 ⌘⇧J：两端对齐', ok: (await para(page, '段落甲'))?.align === 4, detail: await para(page, '段落甲') });
    });
    expectCapability(r);
});

test('C4 列表', async ({ page }, testInfo) => {
    const r = await capability(page, testInfo, { id: 'C4', name: '列表' }, async (steps) => {
        await setSelection(page, await offsetOf(page, '段落丁'), (await offsetOf(page, '段落戊')) + 3);
        await clickToolbar(page, 'doc.command.order-list');
        const d = await para(page, '段落丁');
        const w = await para(page, '段落戊');
        steps.push({ step: '工具栏：两段设为有序列表', ok: d?.list === 'ORDER_LIST' && w?.list === 'ORDER_LIST', detail: { d, w } });
        await setSelection(page, await offsetOf(page, '段落戊'));
        await page.keyboard.press('Tab');
        await page.waitForTimeout(300);
        steps.push({ step: 'Tab：第二项降一级', ok: (await para(page, '段落戊'))?.level === 1, detail: await para(page, '段落戊') });
        await caretAfter(page, '段落丙');
        await press(page, 'Mod+Shift+8');
        steps.push({ step: '快捷键 ⌘⇧8：无序列表', ok: (await para(page, '段落丙'))?.list === 'BULLET_LIST', detail: await para(page, '段落丙') });
        await caretAfter(page, '段落甲');
        await clickToolbar(page, 'doc.command.check-list');
        steps.push({ step: '工具栏：任务列表', ok: (await para(page, '段落甲'))?.list === 'CHECK_LIST', detail: await para(page, '段落甲') });
        // 点击复选框：光标放到段落开头，隐藏输入元素在光标左上角，复选框在它左侧
        await setSelection(page, await offsetOf(page, '段落甲'));
        const at = await page.evaluate(() => {
            const r = (document.activeElement as HTMLElement).parentElement!.parentElement!.getBoundingClientRect();
            return { x: r.left, y: r.top };
        });
        await page.mouse.move(at.x - 12, at.y + 9);
        await page.mouse.down();
        await page.mouse.up();
        await page.waitForTimeout(300);
        steps.push({ step: '点击复选框：勾选', ok: (await para(page, '段落甲'))?.list === 'CHECK_LIST_CHECKED', detail: { at, p: await para(page, '段落甲') } });
        await setSelection(page, await endOffset(page));
        await page.keyboard.type('1. 自动编号', { delay: 30 });
        await page.keyboard.press('Enter');
        await page.keyboard.press('Enter');
        await page.keyboard.type('列表之后', { delay: 30 });
        await page.waitForTimeout(300);
        const auto = await para(page, '自动编号');
        const next = await para(page, '列表之后');
        steps.push({ step: '键入 "1. " 自动编号；空项回车退出列表', ok: auto?.list === 'ORDER_LIST' && next?.list == null, detail: { auto, next } });
    });
    expectCapability(r);
});

test('C9 查找替换', async ({ page }, testInfo) => {
    const r = await capability(page, testInfo, { id: 'C9', name: '查找替换' }, async (steps) => {
        await setSelection(page, 0);
        await press(page, 'Mod+f');
        const input = page.getByPlaceholder(/查找|搜索/).first();
        await input.fill('查找目标');
        await page.waitForTimeout(500);
        const count = await page.getByRole('dialog').innerText();
        const m = /(\d+)\s*\/\s*(\d+)/.exec(count);
        steps.push({ step: '查找：中文关键词的匹配数', ok: m?.[2] === '2', detail: m?.[0] });
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
        await page.keyboard.press('Control+h');
        await page.waitForTimeout(400);
        await page.getByPlaceholder('输入查找内容').fill('查找目标');
        await page.getByPlaceholder('输入替换内容').fill('替换结果');
        await page.getByRole('dialog').getByRole('button', { name: '查找', exact: true }).click();
        await page.waitForTimeout(400);
        await page.getByRole('dialog').getByRole('button', { name: '替换全部' }).click();
        await page.waitForTimeout(400);
        // 二次确认："确定要替换所有的匹配项吗？"
        await page.getByRole('button', { name: '确定' }).last().click();
        await page.waitForTimeout(600);
        const text = await docText(page);
        steps.push({ step: '全部替换', ok: !text.includes('查找目标') && text.split('替换结果').length === 3, detail: text.slice(60, 110) });
        await page.keyboard.press('Escape');
    });
    expectCapability(r);
});


/** 插入 → 表格 → 插入表格（对话框）。 */
async function insertTableViaDialog(page: Page, rows: number, cols: number): Promise<void> {
    await ribbonTab(page, '插入');
    await page.locator('[data-u-command="doc.menu.table"]').first().click();
    await page.getByRole('menu').getByText('插入表格', { exact: true }).first().click();
    const dialog = page.getByRole('dialog', { name: '插入表格' });
    await dialog.getByRole('textbox').nth(0).fill(String(rows));
    await dialog.getByRole('textbox').nth(1).fill(String(cols));
    await dialog.getByRole('button', { name: '确定' }).click();
    await page.waitForTimeout(500);
    await ribbonTab(page, '开始');
}

/** 第 n 个单元格的内容起点（单元格以 \x1C 开头）。 */
async function cellOffset(page: Page, n: number): Promise<number> {
    const ds = await docText(page);
    let at = -1;
    for (let k = 0; k <= n; k++) at = ds.indexOf('\x1c', at + 1);
    if (at < 0) throw new Error(`没有第 ${n} 个单元格`);
    return at + 1;
}

/** 在光标处点右键，打开右键菜单里的子菜单并点选一项。 */
async function contextMenu(page: Page, submenu: string | null, item: string): Promise<void> {
    const at = await caretPoint(page);
    await page.mouse.click(at.x + 3, at.y + 8, { button: 'right' });
    await page.waitForTimeout(300);
    if (submenu != null) {
        await page.getByRole('button', { name: submenu, exact: true }).last().hover();
        await page.waitForTimeout(300);
    }
    await page.getByText(item, { exact: true }).last().click();
    await page.waitForTimeout(400);
}

/** 在空段落里键入 `/`，返回弹出菜单里的按钮文字。 */
async function openSlashMenu(page: Page): Promise<string[]> {
    const visible = () => page.evaluate(() => [...document.querySelectorAll('button')].filter((b) => b.offsetParent != null).map((b) => b.getAttribute('aria-label') || b.getAttribute('title') || b.innerText.trim() || '（图标）'));
    const before = await visible();
    await page.keyboard.type('/');
    await page.waitForTimeout(500);
    const after = await visible();
    const left = [...before];
    return after.filter((t) => {
        const i = left.indexOf(t);
        if (i >= 0) {
            left.splice(i, 1);
            return false;
        }
        return true;
    });
}

test('C5 基础表格', async ({ page }, testInfo) => {
    const r = await capability(page, testInfo, { id: 'C5', name: '基础表格' }, async (steps) => {
        await setSelection(page, await endOffset(page));
        await insertTableViaDialog(page, 3, 4);
        let s = await docSummary(page);
        steps.push({ step: '插入 → 表格 → 对话框 3×4', ok: s.tables.length === 1 && s.tables[0].rows === 3 && s.tables[0].cols === 4, detail: s.tables });
        await setSelection(page, await cellOffset(page, 0));
        await page.keyboard.type('甲一', { delay: 30 });
        await page.keyboard.press('Tab');
        await page.waitForTimeout(200);
        await page.keyboard.type('甲二', { delay: 30 });
        await page.waitForTimeout(300);
        s = await docSummary(page);
        const cells = s.paragraphs.filter((p) => p.inTable).map((p) => p.text);
        steps.push({ step: '单元格中键入，Tab 移到下一格', ok: cells[0] === '甲一' && cells[1] === '甲二', detail: cells.slice(0, 5) });
        await setSelection(page, await cellOffset(page, 0));
        await contextMenu(page, '插入', '下方插入行');
        s = await docSummary(page);
        steps.push({ step: '右键：插入 → 下方插入行', ok: s.tables[0]?.rows === 4, detail: s.tables });
        await setSelection(page, await cellOffset(page, 3));
        await contextMenu(page, '表格删除', '删除列');
        s = await docSummary(page);
        steps.push({ step: '右键：表格删除 → 删除列', ok: s.tables[0]?.cols === 3 && s.tables[0]?.rows === 4, detail: s.tables });
        // 嵌套表格：单元格里工具栏按钮禁用；`/` 菜单插入表格被拒绝；粘贴含表格的内容无效
        await setSelection(page, await cellOffset(page, 0));
        await ribbonTab(page, '插入');
        const disabled = await page.locator('[data-u-command="doc.menu.table"]').first().evaluate((e) => e.getAttribute('data-disabled') ?? e.getAttribute('aria-disabled'));
        await ribbonTab(page, '开始');
        steps.push({ step: '单元格里：工具栏的表格按钮（记录）', ok: true, detail: disabled });
        await setSelection(page, await cellOffset(page, 4));
        const created = await page.evaluate(() => window.__m0!.editor!.univerAPI.executeCommand('doc.command.create-table', { rowCount: 2, colCount: 2 }));
        await page.waitForTimeout(400);
        s = await docSummary(page);
        steps.push({ step: '单元格里执行插入表格的命令：被拒绝，不嵌套', ok: created === false && s.tables.length === 1, detail: { created, tables: s.tables } });
        await setSelection(page, await cellOffset(page, 4));
        await page.keyboard.type('/');
        await page.waitForTimeout(300);
        s = await docSummary(page);
        steps.push({ step: '空单元格里键入 `/`：原样插入（SDK 默认吞掉且不弹菜单）', ok: s.paragraphs.filter((p) => p.inTable).some((p) => p.text === '/'), detail: s.paragraphs.filter((p) => p.inTable).map((p) => p.text) });
        await setSelection(page, await cellOffset(page, 5));
        const beforePaste = await docText(page);
        await syntheticPaste(page, { html: '<table><tr><td>内层</td><td>表格</td></tr></table>', text: '内层\t表格' });
        await page.waitForTimeout(500);
        s = await docSummary(page);
        steps.push({ step: '单元格里粘贴含表格的内容：不嵌套（SDK 静默不粘贴）', ok: s.tables.length === 1, detail: { tables: s.tables, changed: beforePaste !== s.text } });
    });
    expectCapability(r);
});

test('C5c 删除表格', async ({ page }, testInfo) => {
    const r = await capability(page, testInfo, { id: 'C5c', name: '删除表格' }, async (steps) => {
        await setSelection(page, await endOffset(page));
        await insertTableViaDialog(page, 2, 2);
        await setSelection(page, await cellOffset(page, 0));
        await contextMenu(page, '表格删除', '删除表格');
        const s = await docSummary(page);
        steps.push({ step: '右键：表格删除 → 删除表格', ok: s.tables.length === 0 && !s.text.includes('\x1a'), detail: s.tables });
    });
    expectCapability(r);
});

for (const config of ['default', 'platform'] as const) {
    test(`C5b 单元格里插入图片：${config}`, async ({ page }, testInfo) => {
        // 00 号计划书 §4.3：单元格里不能插入图片。SDK 只在工具栏按钮上禁用；平台以命令守卫与粘贴清洗落实
        const r = await capability(page, testInfo, { id: 'C5b', name: '单元格里插入图片', config, roundtrip: false }, async (steps) => {
            await setSelection(page, await endOffset(page));
            await page.evaluate(() => window.__m0!.editor!.univerAPI.executeCommand('doc.command.create-table', { rowCount: 2, colCount: 2 }));
            await page.waitForTimeout(500);
            await setSelection(page, await cellOffset(page, 0));
            await ribbonTab(page, '插入');
            const toolbarDisabled = await page.locator('[data-u-command="doc.menu.image"]').first().evaluate((e) => e.getAttribute('data-disabled') ?? e.getAttribute('aria-disabled'));
            await ribbonTab(page, '开始');
            steps.push({ step: '单元格里：工具栏的图片按钮（记录）', ok: true, detail: toolbarDisabled });
            // 段落菜单与 `/` 菜单的"插入图片"执行的是同一个命令（打开文件选择框，再插入）
            await setSelection(page, await cellOffset(page, 0));
            await insertViaFileChooser(page, 'doc.command.insert-float-image', [fixtureFile('blue-120x80.png')]);
            await page.waitForTimeout(1500);
            const viaCommand = (await docSummary(page)).images.length;
            steps.push({ step: '单元格里执行"插入图片"（记录）', ok: true, detail: { images: viaCommand } });
            await setSelection(page, await cellOffset(page, 1));
            await syntheticPaste(page, { files: [fixtureFile('orange-64x64.png')] });
            await page.waitForTimeout(1500);
            const viaPaste = (await docSummary(page)).images.length - viaCommand;
            steps.push({ step: '单元格里粘贴图片文件（记录）', ok: true, detail: { images: viaPaste } });
            if (config === 'platform') steps.push({ step: '平台配置：单元格里没有图片', ok: viaCommand === 0 && viaPaste === 0, detail: { viaCommand, viaPaste } });
        });
        expectCapability(r, { undo: false });
    });
}

test('C6 图片', async ({ page }, testInfo) => {
    const r = await capability(page, testInfo, { id: 'C6', name: '图片' }, async (steps) => {
        await setSelection(page, (await offsetOf(page, '段落乙')) + 3);
        await insertViaFileChooser(page, 'doc.command.insert-float-image', [fixtureFile('blue-120x80.png')]);
        await page.waitForTimeout(1500);
        await setSelection(page, (await offsetOf(page, '段落丙')) + 3);
        await insertViaFileChooser(page, 'doc.command.insert-float-image', [fixtureFile('orange-64x64.png')]);
        await page.waitForTimeout(1500);
        let s = await docSummary(page);
        steps.push({ step: '插入两张图片（内联）', ok: s.images.length === 2 && s.images.every((i) => i.layoutType === 0 && i.source.startsWith('/api/assets/')), detail: s.images });
        const blueId = s.images.find((i) => i.size?.[0] === 120)?.id;
        const blueImage = async () => (await docSummary(page)).images.find((i) => i.id === blueId);
        const blueBox = () => findColorBox(page, [54, 92, 245], 30);
        /** 点选蓝色图片，返回浮动工具条的按钮（环绕、编辑、裁剪、删除）。 */
        const selectBlue = async () => {
            const box = await blueBox();
            if (box == null) return { box, buttons: [] as { x: number; y: number }[] };
            await page.keyboard.press('Escape');
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            await page.waitForTimeout(400);
            return { box, buttons: await imageToolbarButtons(page, box) };
        };
        const wraps: Record<string, unknown> = {};
        const setWrap = async (label: string) => {
            const { buttons } = await selectBlue();
            if (buttons.length === 0) {
                wraps[label] = '选不中';
                return;
            }
            const option = page.getByRole('button', { name: label, exact: true }).last();
            // 浮动工具条有淡入动画，动画期间的点击可能只触发提示；等动画结束再点，没打开就再点一次
            for (let attempt = 0; attempt < 2 && !(await option.isVisible().catch(() => false)); attempt++) {
                await page.waitForTimeout(400);
                await page.mouse.click(buttons[0].x, buttons[0].y);
                await page.waitForTimeout(400);
            }
            if (!(await option.isVisible().catch(() => false))) {
                await page.screenshot({ path: testInfo.outputPath(`wrap-${label}.png`) });
                wraps[label] = { error: '下拉没有打开', buttons };
                return;
            }
            await option.click();
            await page.waitForTimeout(500);
            const img = await blueImage();
            wraps[label] = { layoutType: img?.layoutType, behindDoc: img?.behindDoc };
        };
        const first = await selectBlue();
        steps.push({ step: '点击图片：弹出浮动工具条（环绕、编辑、裁剪、删除）', ok: first.buttons.length >= 4, detail: first.buttons.length });
        for (const label of ['上下型', '浮于文字上方', '四周型']) await setWrap(label);
        const w = wraps as Record<string, { layoutType?: number | null; behindDoc?: number | null }>;
        steps.push({
            step: '浮动工具条：环绕方式（上下型、浮于文字上方、四周型）',
            ok: w['上下型']?.layoutType === 6 && w['浮于文字上方']?.layoutType === 1 && w['浮于文字上方']?.behindDoc === 0 && w['四周型']?.layoutType === 3,
            detail: wraps,
        });
        // 拖动（四周型的浮动图片）
        const beforeMove = await blueImage();
        const { box } = await selectBlue();
        if (box != null) {
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.down();
            await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 30, { steps: 10 });
            await page.mouse.up();
            await page.waitForTimeout(600);
        }
        const moved = await blueImage();
        steps.push({ step: '拖动浮动图片', ok: moved?.pos != null && beforeMove?.pos != null && moved.pos.join() !== beforeMove.pos.join(), detail: { before: beforeMove?.pos, after: moved?.pos } });
        // 缩放：拖右下角的控制点
        const sel = await selectBlue();
        if (sel.box != null) {
            await page.mouse.move(sel.box.x + sel.box.width + 1, sel.box.y + sel.box.height + 1);
            await page.mouse.down();
            await page.mouse.move(sel.box.x + sel.box.width + 41, sel.box.y + sel.box.height + 28, { steps: 10 });
            await page.mouse.up();
            await page.waitForTimeout(600);
        }
        const resized = await blueImage();
        steps.push({ step: '拖动控制点缩放', ok: resized?.size != null && resized.size[0] > 140, detail: { before: moved?.size, after: resized?.size, pos: resized?.pos } });
        // 最后设为"衬于文字下方"，再试一次点选（被文字覆盖的图片能否选中）
        await setWrap('衬于文字下方');
        steps.push({ step: '浮动工具条：衬于文字下方', ok: w['衬于文字下方']?.layoutType === 1 && w['衬于文字下方']?.behindDoc === 1, detail: w['衬于文字下方'] });
        const again = await selectBlue();
        steps.push({ step: '衬于文字下方的图片能否再次点选（记录）', ok: true, detail: again.buttons.length > 0 });
        // 删除：点选橙色图片，按退格键（macOS 的 delete 键）。向前删除键不删除图片，一并记录
        await page.keyboard.press('Escape');
        const orange = await findColorBox(page, [249, 115, 22], 30);
        let forwardDelete = -1;
        if (orange != null) {
            await page.mouse.click(orange.x + orange.width / 2, orange.y + orange.height / 2);
            await page.waitForTimeout(300);
            await page.keyboard.press('Delete');
            await page.waitForTimeout(400);
            forwardDelete = (await docSummary(page)).images.length;
            await page.keyboard.press('Backspace');
            await page.waitForTimeout(500);
        }
        s = await docSummary(page);
        steps.push({ step: '点选图片后按退格键删除', ok: orange != null && s.images.length === 1, detail: { imagesAfterForwardDelete: forwardDelete, images: s.images.length } });
    });
    expectCapability(r);
});

/** 选中文字后按 ⌘K，在链接框里填地址并确认。 */
async function addLinkViaPopup(page: Page, text: string, url: string): Promise<void> {
    await selectText(page, text);
    await press(page, 'Mod+k');
    await fillLinkPopup(page, url);
}

test('C7 超链接', async ({ page }, testInfo) => {
    const r = await capability(page, testInfo, { id: 'C7', name: '超链接' }, async (steps) => {
        await addLinkViaPopup(page, '链接文字', 'https://example.com/p5');
        let s = await docSummary(page);
        steps.push({ step: '⌘K 添加链接', ok: s.links.length === 1 && s.links[0].url === 'https://example.com/p5' && s.links[0].text === '链接文字', detail: s.links });
        await setSelection(page, (await offsetOf(page, '链接文字')) + 2);
        const at = await caretPoint(page);
        await page.mouse.click(at.x, at.y + 8);
        await page.waitForTimeout(500);
        const info = await page.getByText('https://example.com/p5').first().isVisible().catch(() => false);
        steps.push({ step: '点击链接：显示信息框', ok: info });
        await page.keyboard.press('Escape');
        await stubWindowOpen(page);
        await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control');
        await page.mouse.click(at.x, at.y + 8);
        await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
        await page.waitForTimeout(400);
        const opened = await openedWindows(page);
        steps.push({ step: '⌘ 点击：新窗口打开（noopener）', ok: opened.length === 1 && opened[0][0] === 'https://example.com/p5' && String(opened[0][2]).includes('noopener'), detail: opened });
        // 信息框：[地址] [复制] [编辑] [取消链接]，后两个是没有标签的图标
        const infoActions = (url: string) => page.locator('section[data-u-comp="rect-popup"]').filter({ hasText: url }).locator('button[aria-label="复制"] ~ div');
        await setSelection(page, (await offsetOf(page, '链接文字')) + 2);
        const at1 = await caretPoint(page);
        await page.mouse.click(at1.x, at1.y + 8);
        await page.waitForTimeout(400);
        await infoActions('https://example.com/p5').nth(0).click();
        await page.waitForTimeout(400);
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
        await fillLinkPopup(page, 'https://example.com/p5-edit');
        s = await docSummary(page);
        steps.push({ step: '信息框：编辑链接地址', ok: s.links.length === 1 && s.links[0].url === 'https://example.com/p5-edit', detail: s.links });
        await page.keyboard.press('Escape');
        await addLinkViaPopup(page, '查找替换', 'example.com/second');
        s = await docSummary(page);
        const second = s.links.find((l) => l.text === '查找替换');
        steps.push({ step: '没有协议的地址补上 https://', ok: second?.url === 'https://example.com/second', detail: second });
        await setSelection(page, (await offsetOf(page, '查找替换')) + 2);
        const at2 = await caretPoint(page);
        await page.mouse.click(at2.x, at2.y + 8);
        await page.waitForTimeout(400);
        await infoActions('https://example.com/second').nth(1).click();
        await page.waitForTimeout(400);
        s = await docSummary(page);
        steps.push({ step: '信息框：取消链接', ok: s.links.length === 1 && s.links[0].text === '链接文字', detail: s.links });
    });
    expectCapability(r);
});

for (const config of ['default', 'platform'] as const) {
    test(`C7b 链接地址的校验：${config}`, async ({ page }, testInfo) => {
        const urls = ['javascript://x@example.com/%0Aalert(1)', 'data://text/html,<b>x</b>', 'vbscript://x', 'javascript:alert(1)'];
        const r = await capability(page, testInfo, { id: 'C7b', name: '链接地址的校验', config, roundtrip: false }, async (steps) => {
            const stored: Record<string, string | null> = {};
            for (const url of urls) {
                const before = (await docSummary(page)).links.length;
                await addLinkViaPopup(page, '段落己', url).catch(() => undefined);
                await page.keyboard.press('Escape');
                const s = await docSummary(page);
                stored[url] = s.links.length > before ? s.links[s.links.length - 1].url : null;
                if (s.links.length > before) await undo(page);
            }
            steps.push({ step: '在链接框里输入危险地址（记录）', ok: true, detail: stored });
            if (config === 'platform') steps.push({ step: '平台配置：危险地址都不保存', ok: Object.values(stored).every((v) => v == null), detail: stored });
        });
        expectCapability(r, { undo: false });
    });
}

test('C8 `/` 快捷插入', async ({ page }, testInfo) => {
    const r = await capability(page, testInfo, { id: 'C8', name: '`/` 快捷插入' }, async (steps) => {
        await setSelection(page, await endOffset(page));
        const items = await openSlashMenu(page);
        steps.push({ step: '空段落里键入 `/`：弹出菜单，只含已启用的能力', ok: items.includes('插入表格') && items.includes('插入图片') && !items.some((t) => t.includes('形状')), detail: items });
        await page.getByRole('button', { name: '插入表格' }).last().click();
        await page.waitForTimeout(500);
        let s = await docSummary(page);
        steps.push({ step: '`/` 菜单：插入表格', ok: s.tables.length === 1, detail: s.tables });
        await setSelection(page, (await offsetOf(page, '可以选中的文字')) + 7);
        await page.keyboard.type(' a/b 2026/9/25', { delay: 40 });
        await page.waitForTimeout(300);
        s = await docSummary(page);
        steps.push({ step: '段落中间键入 `/`：原样插入', ok: s.text.includes('文字 a/b 2026/9/25'), detail: s.paragraphs.find((p) => p.text.includes('a/b')) });
        await selectText(page, '可以选中');
        await press(page, 'Mod+b');
        await setSelection(page, (await offsetOf(page, '可以选中')) + 2);
        await page.keyboard.type('/');
        await page.waitForTimeout(300);
        s = await docSummary(page);
        const run = s.runs.find((x) => x.text.includes('/') && x.text.includes('可以'));
        steps.push({ step: '粗体文字中间键入 `/`：沿用粗体', ok: run?.ts.bl === 1 && run.text.includes('可以/选中'), detail: run });
        await page.evaluate(() => {
            const doc = window.__m0!.editor!.univerAPI.getActiveDocument()!;
            const ds = doc.getBody().dataStream;
            const i = ds.indexOf('链接文字');
            doc.setSelection(i, i + 4);
        });
        await press(page, 'Mod+k');
        await fillLinkPopup(page, 'https://example.com/slash');
        await setSelection(page, (await offsetOf(page, '链接文字')) + 2);
        await page.keyboard.type('/');
        await page.waitForTimeout(300);
        s = await docSummary(page);
        steps.push({ step: '链接文字中间键入 `/`：仍在链接里', ok: s.links.some((l) => l.text === '链接/文字' && l.url === 'https://example.com/slash'), detail: s.links });
    });
    expectCapability(r);
});

test('C8b `/` 键（SDK 默认，对照）', async ({ page }, testInfo) => {
    const r = await capability(page, testInfo, { id: 'C8b', name: '`/` 键（对照）', config: 'default', roundtrip: false }, async (steps) => {
        await setSelection(page, (await offsetOf(page, '可以选中的文字')) + 7);
        await page.keyboard.type(' a/b 2026/9/25', { delay: 40 });
        await page.waitForTimeout(300);
        const text = (await docSummary(page)).paragraphs.find((p) => p.text.startsWith('段落乙'))?.text;
        const menu = await page.getByRole('button', { name: '插入表格' }).last().isVisible().catch(() => false);
        steps.push({ step: '段落中间键入 ` a/b 2026/9/25`（记录）', ok: true, detail: { text, menuOpen: menu } });
    });
    for (const s of r.steps) expect.soft(s.ok).toBe(true);
});
