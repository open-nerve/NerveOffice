// P3 验证脚本共用的工具：大样本的按需生成、等待变更检测静默、快照与检测记录、内容差异。
import type { APIRequestContext, Page } from '@playwright/test';
import type { ChangeDetectorState } from '../src/harness/change-detector';

import { canonicalContent, normalizeContent } from '../src/harness/content-compare';
import { diffJson } from './diff';
import { SERVERS, waitForEditor } from './helpers';

export type DocKind = 'sheet' | 'doc';

/** 由构建器生成的大样本：同一次运行内只生成一次，写入验证服务的文档存储（id 为 p3-<类型>-<构建器>）。 */
export async function ensureGenerated(page: Page, request: APIRequestContext, kind: DocKind, builder: string): Promise<string> {
    const id = `p3-${kind}-${builder}`;
    const res = await request.get(`${SERVERS.off}/api/docs/${id}`);
    if (res.ok()) return id;
    await page.goto(`${SERVERS.off}/${kind}.html?sample=empty&unit=${id}`);
    await waitForEditor(page);
    await page.evaluate(async ({ builder, id }) => {
        const m0 = window.__m0!;
        await m0.builders![builder](m0.editor!);
        await m0.persist!(id);
    }, { builder, id });
    return id;
}

/** 从文档存储读取快照文本。 */
export async function storedText(request: APIRequestContext, id: string): Promise<string> {
    const res = await request.get(`${SERVERS.off}/api/docs/${id}`);
    if (!res.ok()) throw new Error(`文档不存在：${id}`);
    return JSON.stringify(await res.json());
}

export async function snapshotText(page: Page): Promise<string> {
    return page.evaluate(() => JSON.stringify(window.__m0!.editor!.save()));
}

export async function detectorMark(page: Page): Promise<number> {
    return page.evaluate(() => window.__m0!.editor!.detector.mark());
}

export async function detectorState(page: Page, since = 0): Promise<ChangeDetectorState> {
    return page.evaluate((since) => window.__m0!.editor!.detector.state(since), since);
}

export interface QuietResult {
    waitedMs: number;
    /** 表格：公式结果是否已写回（等待超时记为 timeout）。 */
    formula: 'applied' | 'timeout' | 'n/a';
}

/**
 * 等待编辑落定（P3 建议的捕获时机）：表格先等公式结果写回，再等到距最后一次"活动"至少 quietMs。
 * 活动包括检测到的修改与公式结果写回（见 ChangeDetector.lastActivityAt），对应平台管道的"修改停止 1 秒后捕获"（00 号计划书 §7.2）。
 */
export async function waitQuiet(page: Page, quietMs = 1000, maxMs = 15_000): Promise<QuietResult> {
    return page.evaluate(async ({ quietMs, maxMs }) => {
        const editor = window.__m0!.editor!;
        const t0 = performance.now();
        let formula: 'applied' | 'timeout' | 'n/a' = 'n/a';
        if (editor.kind === 'sheet') {
            try {
                await editor.univerAPI.getFormula().onCalculationResultApplied(maxMs);
                formula = 'applied';
            } catch {
                formula = 'timeout';
            }
        }
        while (performance.now() - t0 < maxMs) {
            const last = editor.detector.lastActivityAt() ?? 0;
            if (performance.now() - Math.max(last, t0) >= quietMs) break;
            await new Promise((r) => setTimeout(r, 100));
        }
        return { waitedMs: performance.now() - t0, formula };
    }, { quietMs, maxMs });
}

/** 两份快照的内容差异（按 Phase 文档 §3.4 的口径规范化后逐路径比较）。 */
export function contentDiff(before: string, after: string) {
    if (canonicalContent(before) === canonicalContent(after)) return [];
    return diffJson(normalizeContent(before), normalizeContent(after));
}

/** 精简检测记录，便于写入结果文件。 */
export function brief(state: ChangeDetectorState) {
    return {
        detections: state.detections.map((r) => r.id),
        mutations: state.mutations.map((r) => ({ id: r.id, verdict: r.verdict, options: r.options, unitId: r.unitId })),
        syncOnly: state.syncOnly.map((r) => r.id),
        total: state.total,
    };
}

/** 在页面中执行一段 Facade 代码：表格提供 api、wb、ws（当前工作表），文字文档提供 api、doc。 */
export async function runFacade(page: Page, kind: DocKind, code: string): Promise<unknown> {
    const prelude = kind === 'sheet'
        ? 'const api = window.__m0.editor.univerAPI; const wb = api.getActiveWorkbook(); const ws = wb.getActiveSheet();'
        : 'const api = window.__m0.editor.univerAPI; const doc = api.getActiveDocument();';
    return page.evaluate(`(async () => { ${prelude} ${code} })()`);
}
