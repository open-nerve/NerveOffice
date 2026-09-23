import type { BrowserContext, ConsoleMessage, Page, TestInfo } from '@playwright/test';

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const RESULTS_DIR = join(import.meta.dirname, 'results');

/** 三个验证服务：同一份 dist，不同的 CSP 模式（见 server/csp.ts）。 */
export const SERVERS = {
    full: 'http://127.0.0.1:4700',
    off: 'http://127.0.0.1:4701',
    htmlOnly: 'http://127.0.0.1:4702',
} as const;

/** 等待编辑器进入 Steady；页面报错时直接失败。 */
export async function waitForEditor(page: Page): Promise<void> {
    await page.waitForFunction(
        () => window.__m0?.editor != null || document.querySelector('[data-status="error"]') != null,
        null,
        { timeout: 90_000 },
    );
    const status = await page.getByTestId('m0-status').textContent();
    if (status !== 'ready') {
        const bar = await page.getByTestId('m0-bar').textContent();
        throw new Error(`编辑器加载失败：${bar}`);
    }
}

/** 表格单元格中心的页面坐标（滚动为 0、缩放 100% 时成立）。 */
export async function cellCenter(page: Page, a1: string): Promise<{ x: number; y: number }> {
    return page.evaluate((a1) => {
        const canvas = document.querySelector('canvas[id^="univer-sheet-main-canvas"]');
        if (canvas == null) throw new Error('找不到表格画布');
        const rect = canvas.getBoundingClientRect();
        const ws = window.__m0!.editor!.univerAPI.getActiveWorkbook()!.getActiveSheet();
        const cell = ws.getRange(a1).getCell();
        return { x: rect.left + (cell.startX + cell.endX) / 2, y: rect.top + (cell.startY + cell.endY) / 2 };
    }, a1);
}

/** 记录页面及其 Worker 发出的全部请求。注意：被 CSP 拦截的请求在发出前就被取消，不会出现在这里。 */
export function recordRequests(context: BrowserContext): string[] {
    const urls: string[] = [];
    context.on('request', (req) => urls.push(req.url()));
    return urls;
}

export function summarizeRequests(urls: string[], baseURL: string) {
    const self = new URL(baseURL).origin;
    const byOrigin: Record<string, number> = {};
    const crossOrigin: string[] = [];
    for (const u of urls) {
        const origin = u.startsWith('data:') ? 'data:' : u.startsWith('blob:') ? 'blob:' : new URL(u).origin;
        byOrigin[origin] = (byOrigin[origin] ?? 0) + 1;
        if (origin !== self && origin !== 'data:' && origin !== 'blob:') crossOrigin.push(u);
    }
    return { total: urls.length, byOrigin, crossOrigin };
}

export interface ConsoleRecord {
    scope: 'page' | 'worker';
    type: string;
    text: string;
    url: string;
}

/** 收集浏览器控制台消息，包括 Worker 作用域的消息（浏览器自己输出的 CSP 提示也在这里）。 */
export function recordConsole(page: Page): ConsoleRecord[] {
    const list: ConsoleRecord[] = [];
    const push = (scope: ConsoleRecord['scope'], m: ConsoleMessage) =>
        list.push({ scope, type: m.type(), text: m.text(), url: m.location()?.url ?? '' });
    page.on('console', (m) => push('page', m));
    page.on('worker', (w) => w.on('console', (m) => push('worker', m)));
    return list;
}

/** 判断一条控制台消息是否是 CSP 违规提示，以及属于强制策略还是只报告的探测策略。 */
export function classifyCspConsole(text: string): 'enforce' | 'probe' | null {
    const t = text.toLowerCase();
    // Chromium 在请求被拦截后还会追加一条 "Fetch API cannot load … Refused to connect…"，与主消息重复，不计入
    if (t.startsWith('fetch api cannot load')) return null;
    const isCsp = t.includes('content security policy') || t.includes('content-security-policy') || /refused to (load|connect|execute|apply|evaluate|create)/.test(t);
    if (!isCsp) return null;
    if (t.includes('report-only') || t.includes('[report only]')) return 'probe';
    return 'enforce';
}

export async function writeResult(relPath: string, data: unknown): Promise<string> {
    const file = join(RESULTS_DIR, relPath);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
    return file;
}

export function browserInfo(page: Page, testInfo: TestInfo) {
    const browser = page.context().browser();
    return {
        project: testInfo.project.name,
        name: browser?.browserType().name() ?? 'unknown',
        version: browser?.version() ?? 'unknown',
        channel: (testInfo.project.use as { channel?: string }).channel ?? 'bundled',
    };
}
