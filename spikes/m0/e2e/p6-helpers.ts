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

/** 修改内容（Facade）：表格写单元格，文字文档在正文开头插入文字。返回修改后的文本标记。 */
export async function edit(page: Page, kind: DocKind, mark: string): Promise<void> {
    await page.evaluate(({ kind, mark }) => {
        const api = window.__m0!.editor!.univerAPI;
        if (kind === 'sheet') {
            // 最后一列：第一行是计数，之后每次修改往下写一格
            const ws = api.getActiveWorkbook()!.getActiveSheet();
            const col = ws.getMaxColumns() - 1;
            const n = Number(ws.getRange(0, col).getValue() ?? 0) + 1;
            ws.getRange(n, col).setValue(mark);
            ws.getRange(0, col).setValue(n);
        } else {
            api.getActiveDocument()!.insertText(0, mark);
        }
    }, { kind, mark });
}

/** 当前内容里是否含有某个标记。 */
export function contains(page: Page, mark: string): Promise<boolean> {
    return page.evaluate((m) => JSON.stringify(window.__m0!.editor!.save()).includes(m), mark);
}

/** 持久化的浏览器上下文（进程被杀的实验）：每次一个独立的用户目录。 */
export async function launchPersistent(browserType: BrowserType, testInfo: TestInfo, dir?: string): Promise<{ context: BrowserContext; dir: string }> {
    const userDir = dir ?? mkdtempSync(join(tmpdir(), 'm0-p6-profile-'));
    const channel = (testInfo.project.use as { channel?: string }).channel;
    const context = await browserType.launchPersistentContext(userDir, { channel, viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
    return { context, dir: userDir };
}

/** 杀掉这个用户目录的全部浏览器进程（SIGKILL），返回杀掉的进程数。 */
export function killProfile(dir: string): number {
    const pids = execSync(`pgrep -f "${dir}" || true`).toString().trim().split('\n').filter(Boolean).map(Number).filter((p) => p !== process.pid);
    for (const p of pids) {
        try {
            process.kill(p, 'SIGKILL');
        } catch {
            // 已经退出
        }
    }
    return pids.length;
}

export function removeProfile(dir: string): void {
    rmSync(dir, { recursive: true, force: true });
}
