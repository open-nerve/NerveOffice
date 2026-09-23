// V02：严格 CSP 下，表格与文字文档编辑器能否加载、编辑（含 Web Worker）。
// 同时为 V01 提供运行时网络核验：页面与 Worker 的全部请求都应是同源的。
import type { APIRequestContext, Page } from '@playwright/test';

import { expect, test } from '@playwright/test';
import { browserInfo, cellCenter, recordRequests, summarizeRequests, waitForEditor, writeResult } from './helpers';

interface Violation {
    source: 'page' | 'server';
    policy: 'enforce' | 'probe';
    directive: string;
    blocked: string;
    sourceFile: string;
    line: number;
}

interface Check {
    name: string;
    expected: unknown;
    actual: unknown;
    pass: boolean;
}

function check(name: string, expected: unknown, actual: unknown): Check {
    return { name, expected, actual, pass: JSON.stringify(expected) === JSON.stringify(actual) };
}

function blockedKind(uri: string): string {
    if (!uri) return '';
    if (['inline', 'eval', 'wasm-eval', 'data', 'blob'].includes(uri)) return uri;
    if (uri.startsWith('data:')) return 'data';
    if (uri.startsWith('blob:')) return 'blob';
    try {
        const u = new URL(uri);
        return `${u.origin}${u.pathname.replace(/[^/]+$/, '*')}`;
    } catch {
        return uri;
    }
}

function stripAsset(file: string): string {
    return file.replace(/^https?:\/\/[^/]+/, '');
}

/** 把服务端收到的报告（report-uri 旧格式或 Reporting API 格式）统一成 Violation。 */
function fromServerReport(r: { policy: string; body: any }): Violation {
    const legacy = r.body?.['csp-report'];
    const b = legacy ?? r.body?.body ?? r.body;
    return {
        source: 'server',
        policy: r.policy === 'enforce' ? 'enforce' : 'probe',
        directive: b?.['effective-directive'] ?? b?.effectiveDirective ?? b?.['violated-directive'] ?? '',
        blocked: blockedKind(b?.['blocked-uri'] ?? b?.blockedURL ?? ''),
        sourceFile: stripAsset(b?.['source-file'] ?? b?.sourceFile ?? ''),
        line: Number(b?.['line-number'] ?? b?.lineNumber ?? 0),
    };
}

function summarize(list: Violation[]) {
    const groups = new Map<string, { directive: string; blocked: string; sourceFile: string; count: number }>();
    for (const v of list) {
        const key = `${v.directive}|${v.blocked}|${v.sourceFile}`;
        const g = groups.get(key) ?? { directive: v.directive, blocked: v.blocked, sourceFile: v.sourceFile, count: 0 };
        g.count++;
        groups.set(key, g);
    }
    return [...groups.values()].sort((a, b) => b.count - a.count);
}

async function domSize(page: Page): Promise<number> {
    return page.evaluate(() => document.querySelectorAll('*').length);
}

async function clickCommand(page: Page, commandId: string): Promise<void> {
    await page.locator(`[data-u-command="${commandId}"]:visible`).first().click();
}

async function runSheet(page: Page): Promise<{ checks: Check[]; ui: Record<string, number> }> {
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

    // 等公式结果与空闲任务
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

async function runDoc(page: Page): Promise<{ checks: Check[]; ui: Record<string, number> }> {
    const ui: Record<string, number> = {};
    const canvas = page.locator('canvas#univer-doc-main-canvas');
    const box = (await canvas.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.type('追加ABC ');
    await page.waitForTimeout(300);
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
    // 段落样式下拉菜单（点击按钮主体会应用当前样式，所以放在核对之后）
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

const scenarios = [
    { id: 'sheet-main', path: '/sheet.html?sample=minimal', run: runSheet, worker: false },
    { id: 'sheet-worker', path: '/sheet.html?sample=minimal&worker=1', run: runSheet, worker: true },
    { id: 'doc-main', path: '/doc.html?sample=minimal', run: runDoc, worker: false },
    { id: 'doc-worker', path: '/doc.html?sample=minimal&worker=1', run: runDoc, worker: true },
] as const;

async function serverReports(request: APIRequestContext): Promise<Violation[]> {
    const res = await request.get('/__csp-reports');
    const list = (await res.json()) as { policy: string; body: unknown }[];
    return list.map(fromServerReport);
}

for (const s of scenarios) {
    test(`V02 ${s.id}`, async ({ page, context, request, baseURL }, testInfo) => {
        await request.delete('/__csp-reports');
        const requests = recordRequests(context);
        const pageErrors: string[] = [];
        page.on('pageerror', (e) => pageErrors.push(e.message));
        const workers: string[] = [];
        page.on('worker', (w) => workers.push(w.url()));

        await page.goto(s.path);
        await waitForEditor(page);
        const { checks, ui } = await s.run(page);
        // 给 report-uri 的异步上报留出时间
        await page.waitForTimeout(1500);

        const pageSide = await page.evaluate(() => window.__m0!.events);
        const timings = await page.evaluate(() => window.__m0!.editor!.timings);
        const workerStats = await page.evaluate(() => window.__m0!.workerStats);
        const pageViolations: Violation[] = pageSide.cspViolations.map((v) => ({
            source: 'page',
            policy: v.disposition === 'enforce' ? 'enforce' : 'probe',
            directive: v.effectiveDirective,
            blocked: blockedKind(v.blockedURI),
            sourceFile: stripAsset(v.sourceFile),
            line: v.lineNumber,
        }));
        const server = await serverReports(request);
        const enforce = [...pageViolations, ...server].filter((v) => v.policy === 'enforce');
        const probe = server.filter((v) => v.policy === 'probe');
        const net = summarizeRequests(requests, baseURL!);

        const result = {
            check: 'V02',
            scenario: s.id,
            browser: browserInfo(page, testInfo),
            timestamp: new Date().toISOString(),
            timings,
            functional: checks,
            ui,
            worker: { expected: s.worker, started: workers, stats: workerStats },
            enforceViolations: enforce,
            probeViolations: { total: probe.length, groups: summarize(probe) },
            pageSideViolationCount: pageViolations.length,
            requests: net,
            pageErrors: [...pageErrors, ...pageSide.errors],
            consoleErrors: pageSide.consoleErrors,
            consoleWarningCount: pageSide.consoleWarnings.length,
        };
        await writeResult(`v02/${testInfo.project.name}-${s.id}.json`, result);

        for (const c of checks) expect.soft(c.actual, c.name).toEqual(c.expected);
        expect.soft(enforce, '强制策略的违规').toEqual([]);
        expect.soft(net.crossOrigin, '非同源请求').toEqual([]);
        expect.soft(result.pageErrors, '页面错误').toEqual([]);
        if (s.worker) {
            expect.soft(workers.length, 'Worker 已启动').toBeGreaterThan(0);
            expect.soft(workerStats.messagesFromWorker, 'Worker 有回传消息').toBeGreaterThan(0);
        }
    });
}
