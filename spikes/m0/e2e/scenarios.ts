// V02 与 V01（网络核验）共用的编辑场景：全部使用真实的键盘与鼠标操作，最后用 save() 核对快照。
import type { Page } from '@playwright/test';

import { cellCenter } from './helpers';

export interface Check {
    name: string;
    expected: unknown;
    actual: unknown;
    pass: boolean;
}

export function check(name: string, expected: unknown, actual: unknown): Check {
    return { name, expected, actual, pass: JSON.stringify(expected) === JSON.stringify(actual) };
}

async function domSize(page: Page): Promise<number> {
    return page.evaluate(() => document.querySelectorAll('*').length);
}

async function clickCommand(page: Page, commandId: string): Promise<void> {
    await page.locator(`[data-u-command="${commandId}"]:visible`).first().click();
}

export interface ScenarioOutcome {
    checks: Check[];
    /** 打开菜单前后的 DOM 节点数之差，证明弹出层确实渲染了。 */
    ui: Record<string, number>;
}

export async function runSheet(page: Page): Promise<ScenarioOutcome> {
    const ui: Record<string, number> = {};

    let p = await cellCenter(page, 'B2');
    await page.mouse.click(p.x, p.y);
    await page.keyboard.type('hello 你好');
    await page.keyboard.press('Enter');

    p = await cellCenter(page, 'B3');
    await page.mouse.click(p.x, p.y);
    await page.keyboard.type('=SUM(1,2)');
    await page.keyboard.press('Enter');

    // 工具栏加粗
    p = await cellCenter(page, 'B2');
    await page.mouse.click(p.x, p.y);
    await clickCommand(page, 'sheet.command.set-range-bold');

    // 数字格式下拉菜单
    let before = await domSize(page);
    await clickCommand(page, 'sheet.operation.open.numfmt.panel');
    await page.waitForTimeout(500);
    ui.numfmtMenuDomDelta = (await domSize(page)) - before;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    // 右键菜单
    p = await cellCenter(page, 'D6');
    before = await domSize(page);
    await page.mouse.click(p.x, p.y, { button: 'right' });
    await page.waitForTimeout(500);
    ui.contextMenuDomDelta = (await domSize(page)) - before;
    await page.keyboard.press('Escape');

    // 等公式结果写回
    await page.waitForFunction(
        () => window.__m0!.editor!.univerAPI.getActiveWorkbook()!.getActiveSheet().getRange('B3').getValue() === 3,
        null,
        { timeout: 15_000 },
    ).catch(() => undefined);

    const r = await page.evaluate(() => {
        const snap = window.__m0!.editor!.save() as any;
        const sheet = snap.sheets[snap.sheetOrder[0]];
        const b2 = sheet.cellData?.[1]?.[1];
        const b3 = sheet.cellData?.[2]?.[1];
        const style = typeof b2?.s === 'string' ? snap.styles?.[b2.s] : b2?.s;
        return { b2v: b2?.v, b2bold: style?.bl ?? 0, b3f: b3?.f, b3v: b3?.v };
    });
    return {
        checks: [
            check('B2 值（键盘输入）', 'hello 你好', r.b2v),
            check('B2 加粗（工具栏）', 1, r.b2bold),
            check('B3 公式', '=SUM(1,2)', r.b3f),
            check('B3 计算结果', 3, r.b3v),
        ],
        ui,
    };
}

export async function runDoc(page: Page): Promise<ScenarioOutcome> {
    const ui: Record<string, number> = {};
    const canvas = page.locator('canvas#univer-doc-main-canvas');
    const box = (await canvas.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.type('追加ABC ');
    await page.waitForTimeout(300);
    // Univer 按 UA 判断快捷键修饰键：配置中不使用设备预设，保持浏览器在 macOS 上的真实 UA
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.waitForTimeout(300);
    await clickCommand(page, 'doc.command.set-inline-format-bold');
    await page.waitForTimeout(300);

    const r = await page.evaluate(() => {
        const snap = window.__m0!.editor!.save() as any;
        const runs: any[] = snap.body?.textRuns ?? [];
        const text: string = snap.body?.dataStream ?? '';
        const contentLength = text.replace(/\r\n$/, '').length;
        const boldCovered = runs.filter((t) => t.ts?.bl === 1).reduce((n, t) => n + (t.ed - t.st), 0);
        return { text, contentLength, boldCovered };
    });

    // 段落样式下拉菜单
    const before = await domSize(page);
    await clickCommand(page, 'doc.command.set-paragraph-named-style');
    await page.waitForTimeout(500);
    ui.namedStyleMenuDomDelta = (await domSize(page)) - before;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    return {
        checks: [
            check('正文包含键盘输入', true, r.text.includes('追加ABC')),
            check('原有内容保留', true, r.text.includes('M0 文字文档样本')),
            check('全文加粗（工具栏）', r.contentLength, r.boldCovered),
        ],
        ui,
    };
}

export const SCENARIOS = [
    { id: 'sheet-main', path: '/sheet.html?sample=minimal', run: runSheet, worker: false },
    { id: 'sheet-worker', path: '/sheet.html?sample=minimal&worker=1', run: runSheet, worker: true },
    { id: 'doc-main', path: '/doc.html?sample=minimal', run: runDoc, worker: false },
    { id: 'doc-worker', path: '/doc.html?sample=minimal&worker=1', run: runDoc, worker: true },
] as const;
