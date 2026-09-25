// P6 测试辅助：把样本存进验证服务、带发件箱打开文档、读取发件箱状态、修改内容、杀掉浏览器进程。
import type { APIRequestContext, BrowserContext, BrowserType, Page, TestInfo } from '@playwright/test';

import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForEditor } from './helpers';

export type DocKind = 'sheet' | 'doc';

/** 把 fixtures 里的样本以指定 id 存进验证服务，返回服务端的修订号。 */
export async function storeFixture(request: APIRequestContext, server: string, kind: DocKind, sample: string, id: string): Promise<number> {
    const data = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', kind, `${sample}.json`), 'utf8')) as Record<string, unknown>;
    const res = await request.put(`${server}/api/docs/${id}`, { data });
    if (!res.ok()) throw new Error(`存样本失败：${res.status()}`);
    return Number(res.headers()['x-revision'] ?? '0');
}

/** 把验证服务里已有的文档复制到另一个 id（原样复制，修订号为 1）。 */
export async function copyStored(request: APIRequestContext, server: string, from: string, to: string): Promise<void> {
    const res = await request.post(`${server}/api/docs/${from}/copy?to=${to}`);
    if (!res.ok()) throw new Error(`复制文档失败：${res.status()}`);
}

export async function serverRevision(request: APIRequestContext, server: string, id: string): Promise<number> {
    const res = await request.get(`${server}/api/docs/${id}`);
    return Number(res.headers()['x-revision'] ?? '-1');
}

export interface OutboxQuery {
    kind: DocKind;
    doc: string;
    outbox?: 'main' | 'worker';
    user?: string;
    durability?: 'default' | 'strict';
    extra?: string;
}

export const outboxUrl = (server: string, q: OutboxQuery) =>
    `${server}/${q.kind}.html?doc=${q.doc}&outbox=${q.outbox ?? 'main'}&user=${q.user ?? 'u1'}${q.durability === 'strict' ? '&durability=strict' : ''}${q.extra ? `&${q.extra}` : ''}`;

/** 带发件箱打开文档，等到发件箱装好（或安装失败）。 */
export async function openWithOutbox(page: Page, server: string, q: OutboxQuery): Promise<void> {
    await page.goto(outboxUrl(server, q));
    await waitForEditor(page);
    await page.waitForFunction(() => window.__m0?.outbox != null || window.__m0?.outboxError != null, null, { timeout: 30_000 });
    const error = await page.evaluate(() => window.__m0!.outboxError ?? null);
    if (error != null) throw new Error(`发件箱安装失败：${error}`);
}

export interface OutboxInfo {
    state: string;
    lock: string;
    recovery: { status: string; record: { localSeq: number; baseRevision: number; updatedAt: number; jsonBytes: number } | null; serverRevision: number | null; error: string | null } | null;
    autosave: string | null;
    saves: number;
    lastError: string | null;
}

export function outboxInfo(page: Page): Promise<OutboxInfo> {
    return page.evaluate(() => {
        const o = window.__m0!.outbox!;
        const a = o.autosave();
        const r = o.recovery();
        return {
            state: o.state(),
            lock: o.lock().state(),
            recovery: r == null ? null : { status: r.status, record: r.record == null ? null : { localSeq: r.record.localSeq, baseRevision: r.record.baseRevision, updatedAt: r.record.updatedAt, jsonBytes: r.record.jsonBytes }, serverRevision: r.serverRevision, error: r.error },
            autosave: a?.status() ?? null,
            saves: a?.history.length ?? 0,
            lastError: a?.lastError() ?? null,
        };
    });
}

/** 等自动保存把当前的修改写进发件箱。 */
export async function waitSavedLocal(page: Page, timeoutMs = 15_000): Promise<string> {
    return page.evaluate(async (t) => window.__m0!.outbox!.autosave()!.idle(t), timeoutMs);
}

/** 修改内容（Facade）：表格写单元格，文字文档在正文开头插入文字。每次都是真实的内容变化。 */
export async function edit(page: Page, kind: DocKind, mark: string): Promise<void> {
    await page.evaluate(({ kind, mark }) => {
        const api = window.__m0!.editor!.univerAPI;
        if (kind === 'sheet') {
            // 最后一列：第一行是计数，之后每次修改往下写一格。
            // 第一行已有非数字内容时（P3 大样本的表头"合计"）改用最后一行计数、往上写：否则计数得到 NaN，
            // 第二次起写的都是同样的内容，捕获被去重跳过，端到端量不到写入（P6 收尾时发现）
            const ws = api.getActiveWorkbook()!.getActiveSheet();
            const col = ws.getMaxColumns() - 1;
            const head = ws.getRange(0, col).getValue();
            const bottom = head != null && head !== '' && !Number.isFinite(Number(head));
            const counterRow = bottom ? ws.getMaxRows() - 1 : 0;
            const n = Number(ws.getRange(counterRow, col).getValue() ?? 0) + 1;
            ws.getRange(bottom ? counterRow - n : n, col).setValue(mark);
            ws.getRange(counterRow, col).setValue(n);
        } else {
            api.getActiveDocument()!.insertText(0, mark);
        }
    }, { kind, mark });
}

/** 当前内容里是否含有某个标记。 */
export function contains(page: Page, mark: string): Promise<boolean> {
    return page.evaluate((m) => JSON.stringify(window.__m0!.editor!.save()).includes(m), mark);
}

/** 持久化的浏览器上下文（进程被杀的实验）：每次一个独立的用户目录；记下启动时刻，供杀进程时识别 WebKit 的 XPC 服务。 */
export async function launchPersistent(browserType: BrowserType, testInfo: TestInfo, dir?: string): Promise<{ context: BrowserContext; dir: string; launchedAt: number }> {
    const userDir = dir ?? mkdtempSync(join(tmpdir(), 'm0-p6-profile-'));
    const channel = (testInfo.project.use as { channel?: string }).channel;
    const launchedAt = Date.now();
    const context = await browserType.launchPersistentContext(userDir, { channel, viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
    return { context, dir: userDir, launchedAt };
}

export interface KilledProcess {
    pid: number;
    name: string;
}

export interface KillResult {
    killed: KilledProcess[];
    /** WebKit：同时有别的 WebKit 实例在跑时，不杀 XPC 服务（分不清归属），这里记下原因。 */
    note: string | null;
}

function psLines(): { pid: number; ppid: number; start: number; command: string }[] {
    return execSync('ps -axo pid=,ppid=,lstart=,command=').toString().trim().split('\n').map((line) => {
        const m = /^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d+ [\d:]{8} \d{4})\s+(.*)$/.exec(line);
        return m == null ? null : { pid: Number(m[1]), ppid: Number(m[2]), start: new Date(m[3]).getTime(), command: m[4] };
    }).filter((x): x is { pid: number; ppid: number; start: number; command: string } => x != null);
}

/**
 * 杀掉这个用户目录的浏览器（SIGKILL，P6 审查 G6）：
 * - 命令行里带用户目录的进程，以及它们的整棵子进程树；
 * - WebKit 的网络、渲染、GPU 进程是 launchd 拉起的 XPC 服务（父进程为 1），不在进程树里；IndexedDB 由网络进程承载。
 *   只有这一个 Playwright WebKit 实例在跑时，把启动之后出现的这些 XPC 服务一并杀掉；否则不杀并记下原因。
 */
export function killProfile(dir: string, options: { browserName?: string; launchedAt?: number } = {}): KillResult {
    const all = psLines();
    const roots = all.filter((p) => p.command.includes(dir) && p.pid !== process.pid).map((p) => p.pid);
    const targets = new Set<number>(roots);
    let grew = true;
    while (grew) {
        grew = false;
        for (const p of all) {
            if (targets.has(p.ppid) && !targets.has(p.pid)) {
                targets.add(p.pid);
                grew = true;
            }
        }
    }
    let note: string | null = null;
    if (options.browserName === 'webkit') {
        const uiProcesses = all.filter((p) => /ms-playwright\/webkit-[^/]+\/Playwright\.app\/Contents\/MacOS\/Playwright/.test(p.command));
        const mine = uiProcesses.filter((p) => targets.has(p.pid));
        if (uiProcesses.length > mine.length) note = `有 ${uiProcesses.length - mine.length} 个别的 WebKit 实例在跑，没有杀 XPC 服务`;
        else {
            const since = (options.launchedAt ?? Date.now()) - 2000;
            for (const p of all) if (/ms-playwright\/webkit-[^/]+\/com\.apple\.WebKit\./.test(p.command) && p.start >= since) targets.add(p.pid);
        }
    }
    const killed: KilledProcess[] = [];
    for (const pid of targets) {
        try {
            process.kill(pid, 'SIGKILL');
            const cmd = all.find((p) => p.pid === pid)?.command ?? '';
            killed.push({ pid, name: cmd.split('/').pop()?.split(' ')[0] ?? cmd.slice(0, 40) });
        } catch {
            // 已经退出
        }
    }
    return { killed, note };
}

export function removeProfile(dir: string): void {
    rmSync(dir, { recursive: true, force: true });
}
