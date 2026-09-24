// 快照比较：逐路径列出差异，用于 V03 的保真分析。

export interface DiffEntry {
    path: string;
    kind: 'added' | 'removed' | 'changed';
    before?: string;
    after?: string;
}

const preview = (v: unknown): string => {
    const s = JSON.stringify(v);
    return s === undefined ? 'undefined' : s.length > 160 ? `${s.slice(0, 157)}...` : s;
};

const isObject = (v: unknown): v is Record<string, unknown> => v != null && typeof v === 'object';

/** 深度比较两个 JSON 值，返回全部差异路径（数组按下标比较）。 */
export function diffJson(a: unknown, b: unknown, path = '$', out: DiffEntry[] = []): DiffEntry[] {
    if (Object.is(a, b)) return out;
    if (isObject(a) && isObject(b) && Array.isArray(a) === Array.isArray(b)) {
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const k of keys) {
            const p = Array.isArray(a) ? `${path}[${k}]` : `${path}.${k}`;
            if (!(k in b)) out.push({ path: p, kind: 'removed', before: preview(a[k]) });
            else if (!(k in a)) out.push({ path: p, kind: 'added', after: preview(b[k]) });
            else diffJson(a[k], b[k], p, out);
        }
        return out;
    }
    out.push({ path, kind: 'changed', before: preview(a), after: preview(b) });
    return out;
}

/** 键排序后序列化，作为内容哈希的输入。 */
export function canonicalJson(value: unknown): string {
    return JSON.stringify(value, (_k, x) =>
        isObject(x) && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x,
    );
}

/** 把资源的 data（JSON 字符串）展开，便于逐路径比较资源内部的差异。 */
export function expandResources<T extends { resources?: { name: string; data: string }[] }>(snapshot: T): unknown {
    const copy = structuredClone(snapshot) as T & { resources?: { name: string; data: unknown }[] };
    for (const r of copy.resources ?? []) {
        try {
            r.data = typeof r.data === 'string' && r.data !== '' ? JSON.parse(r.data) : r.data;
        } catch {
            // 非 JSON 的资源保持原样
        }
    }
    return copy;
}
