// 资源比对：V04 验证的两种防护规则共用（00 号计划书 §8.2）。
// - 服务端检查：只看 unknown 与 missing。用户正常删除全部规则时资源也会"变为空"，不能据此拒绝。
// - 客户端打开自检：unknown、missing、emptied 都视为失败。刚打开的文档不可能有用户删除。

export interface ResourceEntry {
    name: string;
    data: string;
}

export interface ResourceComparison {
    /** 不在白名单内的资源名。 */
    unknown: string[];
    /** 原来非空、在新快照中消失的资源。 */
    missing: string[];
    /** 原来非空、在新快照中变为空的资源。 */
    emptied: string[];
    /** 前后都非空、但内容不同的资源（仅供参考）。 */
    changed: string[];
}

function parse(data: unknown): unknown {
    if (typeof data !== 'string') return data;
    try {
        return JSON.parse(data);
    } catch {
        return data;
    }
}

/** 解析后是 null、空字符串、空对象、空数组，或者各层都为空。 */
export function isEmptyResourceData(data: unknown): boolean {
    const v = parse(data);
    if (v == null || v === '') return true;
    if (Array.isArray(v)) return v.every(isEmptyResourceData);
    if (typeof v === 'object') return Object.values(v as Record<string, unknown>).every(isEmptyResourceData);
    return false;
}

/** 键排序后序列化，用于比较两份资源的内容是否相同。 */
export function canonical(value: unknown): string {
    const v = parse(value);
    return JSON.stringify(v, (_k, x) =>
        x != null && typeof x === 'object' && !Array.isArray(x)
            ? Object.fromEntries(Object.keys(x as Record<string, unknown>).sort().map((k) => [k, (x as Record<string, unknown>)[k]]))
            : x,
    );
}

export function compareResources(
    before: ResourceEntry[] | undefined,
    after: ResourceEntry[] | undefined,
    whitelist: readonly string[],
): ResourceComparison {
    const prev = new Map((before ?? []).map((r) => [r.name, r.data]));
    const next = new Map((after ?? []).map((r) => [r.name, r.data]));
    const result: ResourceComparison = { unknown: [], missing: [], emptied: [], changed: [] };
    for (const name of next.keys()) if (!whitelist.includes(name)) result.unknown.push(name);
    for (const [name, data] of prev) {
        if (isEmptyResourceData(data)) continue;
        if (!next.has(name)) result.missing.push(name);
        else if (isEmptyResourceData(next.get(name))) result.emptied.push(name);
        else if (canonical(data) !== canonical(next.get(name))) result.changed.push(name);
    }
    return result;
}

/** 服务端检查：资源名白名单 + 原来非空的条目不得消失。 */
export function serverRejects(c: ResourceComparison): boolean {
    return c.unknown.length > 0 || c.missing.length > 0;
}

/** 客户端打开自检：加载后立即捕获，与原快照比较；任何缺失或变空都判定加载失败。 */
export function openCheckFails(c: ResourceComparison): boolean {
    return c.unknown.length > 0 || c.missing.length > 0 || c.emptied.length > 0;
}
