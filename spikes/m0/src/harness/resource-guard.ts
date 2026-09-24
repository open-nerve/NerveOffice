// 资源比对：V04 验证的防护规则共用（00 号计划书 §8.2）。
// - 服务端检查：结构（资源名唯一、data 为字符串）、白名单、原来非空的条目不得消失。
//   用户正常删除全部规则时资源也会"变为空"，所以"变为空"不能作为服务端拒绝的理由。
// - 客户端打开自检：加载后立即捕获，与刚加载的快照比较；消失、变为空都判定加载失败。
//   结构不对、被插件吞掉的解析错误，要配合资源加载错误捕获（guarded-resource-manager.ts）。

export interface ResourceEntry {
    name: string;
    data: unknown;
}

export interface ResourceComparison {
    /** 不在白名单内的资源名。 */
    unknown: string[];
    /** 同名资源出现多次（SDK 加载时只取第一条，比较时必须拒绝）。 */
    duplicates: string[];
    /** data 不是字符串的资源（SDK 的 toJson 只会输出字符串）。 */
    invalid: string[];
    /** 原来非空、在新快照中消失的资源。 */
    missing: string[];
    /** 原来非空、在新快照中变为空的资源。 */
    emptied: string[];
    /** 前后都非空、但内容不同的资源（仅供参考）。 */
    changed: string[];
}

/** 资源 data 只在顶层解析一次：内部的字符串（例如备注正文恰好是 "[]"）不再当作 JSON 解析。 */
function parseTopLevel(data: unknown): unknown {
    if (typeof data !== 'string') return data;
    if (data === '') return '';
    try {
        return JSON.parse(data);
    } catch {
        return data;
    }
}

/** 结构上为空：null、空字符串、空对象、空数组，或者各层都为空。只对已解析的值递归，不再解析内部字符串。 */
export function isEmptyValue(v: unknown): boolean {
    if (v == null || v === '') return true;
    if (Array.isArray(v)) return v.every(isEmptyValue);
    if (typeof v === 'object') return Object.values(v as Record<string, unknown>).every(isEmptyValue);
    return false;
}

export function isEmptyResourceData(data: unknown): boolean {
    return isEmptyValue(parseTopLevel(data));
}

/** 去掉取值为空的键（例如某个工作表对应的空规则数组），它们与"没有这个键"在内容上等价。 */
export function pruneEmpty(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(pruneEmpty);
    if (v != null && typeof v === 'object') {
        return Object.fromEntries(
            Object.keys(v as Record<string, unknown>)
                .sort()
                .filter((k) => !isEmptyValue((v as Record<string, unknown>)[k]))
                .map((k) => [k, pruneEmpty((v as Record<string, unknown>)[k])]),
        );
    }
    return v;
}

/** 键排序、去掉空值后序列化，用于比较两份资源的内容是否相同。 */
export function canonical(data: unknown): string {
    return JSON.stringify(pruneEmpty(parseTopLevel(data)));
}

/** 与 SDK 一致：同名资源只取第一条（resource-manager.service.ts 与 resource-loader.service.ts 都用 find）。 */
function firstByName(list: ResourceEntry[]): Map<string, unknown> {
    const map = new Map<string, unknown>();
    for (const r of list) if (!map.has(r.name)) map.set(r.name, r.data);
    return map;
}

export function compareResources(
    before: ResourceEntry[] | undefined,
    after: ResourceEntry[] | undefined,
    whitelist: readonly string[],
): ResourceComparison {
    const prevList = before ?? [];
    const nextList = after ?? [];
    const prev = firstByName(prevList);
    const next = firstByName(nextList);
    const result: ResourceComparison = { unknown: [], duplicates: [], invalid: [], missing: [], emptied: [], changed: [] };

    const seen = new Set<string>();
    for (const r of nextList) {
        if (seen.has(r.name) && !result.duplicates.includes(r.name)) result.duplicates.push(r.name);
        seen.add(r.name);
        if (typeof r.data !== 'string' && !result.invalid.includes(r.name)) result.invalid.push(r.name);
        if (!whitelist.includes(r.name) && !result.unknown.includes(r.name)) result.unknown.push(r.name);
    }
    for (const [name, data] of prev) {
        if (isEmptyResourceData(data)) continue;
        if (!next.has(name)) result.missing.push(name);
        else if (isEmptyResourceData(next.get(name))) result.emptied.push(name);
        else if (canonical(data) !== canonical(next.get(name))) result.changed.push(name);
    }
    return result;
}

/** 服务端检查：结构、白名单、原来非空的条目不得消失。 */
export function serverRejects(c: ResourceComparison): boolean {
    return c.duplicates.length > 0 || c.invalid.length > 0 || c.unknown.length > 0 || c.missing.length > 0;
}

/** 客户端打开自检（只看资源比较这一半；另一半是资源加载错误捕获）。 */
export function openCheckFails(c: ResourceComparison): boolean {
    return c.duplicates.length > 0 || c.invalid.length > 0 || c.unknown.length > 0 || c.missing.length > 0 || c.emptied.length > 0;
}
