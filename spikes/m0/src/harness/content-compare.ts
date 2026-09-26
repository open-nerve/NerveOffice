// 内容比较（V06、V07、V09）：判断两份快照的"内容"是否相同。
// 口径见 Phase 文档 §3.4：以 JSON 文本为准；资源按名称排序并展开、做空值等价归一化；去掉视图状态字段。
// 不依赖 DOM，页面与 Playwright 脚本都可以用。
import { isEmptyValue, pruneEmpty } from './resource-guard.ts';

/** 工作表中的视图状态：不产生 mutation，随下一次真实修改保存（00 号计划书 §7.3）。 */
export const VIEW_STATE_FIELDS = ['zoomRatio', 'scrollTop', 'scrollLeft'] as const;

/** 文字文档的视图状态：缩放比例由 operation 直接写进 settings.zoomRatio。 */
export const DOC_VIEW_STATE_FIELDS = ['settings.zoomRatio'] as const;

type Json = Record<string, unknown>;

function parseResourceData(data: unknown): unknown {
    if (typeof data !== 'string' || data === '') return data;
    try {
        return JSON.parse(data);
    } catch {
        return data;
    }
}

/** 规范化后的快照对象：用于逐路径比较。 */
export function normalizeContent(snapshotText: string): Json {
    const snap = JSON.parse(snapshotText) as Json;
    if (Array.isArray(snap.resources)) {
        snap.resources = (snap.resources as { name: string; data: unknown }[])
            .map((r) => {
                const data = parseResourceData(r.data);
                return { name: r.name, data: isEmptyValue(data) ? null : pruneEmpty(data) };
            })
            .sort((a, b) => a.name.localeCompare(b.name));
    }
    const sheets = snap.sheets as Record<string, Json> | undefined;
    if (sheets != null) {
        for (const sheet of Object.values(sheets)) {
            for (const f of VIEW_STATE_FIELDS) delete sheet[f];
        }
    }
    const settings = snap.settings as Json | undefined;
    if (settings != null) {
        delete settings.zoomRatio;
        if (Object.keys(settings).length === 0) delete snap.settings;
    }
    return snap;
}

const isObject = (v: unknown): v is Record<string, unknown> => v != null && typeof v === 'object';

/** 键排序后的规范化 JSON：两份快照的内容相同，当且仅当这个字符串相同。 */
export function canonicalContent(snapshotText: string): string {
    return JSON.stringify(normalizeContent(snapshotText), (_k, x) =>
        isObject(x) && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x,
    );
}

/** 内容哈希（FNV-1a 64 位，仅用于识别与比较，不用于安全目的）。 */
export function contentHash(snapshotText: string): string {
    const text = canonicalContent(snapshotText);
    let h = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    for (let i = 0; i < text.length; i++) {
        h ^= BigInt(text.charCodeAt(i));
        h = (h * prime) & 0xffffffffffffffffn;
    }
    return h.toString(16).padStart(16, '0');
}
