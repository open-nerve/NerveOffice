// 快照中的图片地址（P4，00 号计划书 §8.5、§11.3）：结构化提取、通用扫描、分类，以及按 /api/assets/{uuid} 模式扫描引用关系。
// 服务端（验证服务）与用例共用。结构化提取不依赖具体字段位置：任何同时带 source 与 imageSourceType（或 sourceType）字符串的对象都视为图片；
// 资源条目的 data 是 JSON 文本，先解析再遍历。通用扫描再找出所有带 data:image、http(s)、blob:、file: 的字符串，用来发现结构化提取漏掉的位置。

export type ImageSourceKind = 'platform' | 'data' | 'external' | 'same-origin-other' | 'blob' | 'file' | 'empty' | 'other';

export interface ImageRef {
    /** JSON 路径，资源数据内部用 resources.<名称>/ 开头。 */
    where: string;
    source: string;
    kind: ImageSourceKind;
    imageSourceType?: string;
}

export interface StrayRef {
    where: string;
    value: string;
}

export interface SnapshotImages {
    images: ImageRef[];
    /** 通用扫描找到、但不在结构化结果里的字符串（超链接地址等也会出现在这里，由调用方判断）。 */
    stray: StrayRef[];
}

/** 平台资源地址：相对地址 /api/assets/{uuid}，或本站的绝对地址。 */
export const ASSET_PATH = /^\/api\/assets\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const ASSET_REF = /\/api\/assets\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;
const SCHEME = /^(?:data:|https?:|blob:|file:)/i;

export function classifySource(source: string, origin?: string): ImageSourceKind {
    if (source === '') return 'empty';
    if (ASSET_PATH.test(source)) return 'platform';
    if (origin != null && source.startsWith(origin)) {
        return ASSET_PATH.test(source.slice(origin.length)) ? 'platform' : 'same-origin-other';
    }
    if (/^data:/i.test(source)) return 'data';
    if (/^blob:/i.test(source)) return 'blob';
    if (/^file:/i.test(source)) return 'file';
    if (/^https?:/i.test(source)) return 'external';
    if (source.startsWith('/')) return 'same-origin-other';
    return 'other';
}

function walk(value: unknown, path: string, visit: (value: unknown, path: string) => void): void {
    visit(value, path);
    if (Array.isArray(value)) {
        value.forEach((v, i) => walk(v, `${path}/${i}`, visit));
    } else if (value != null && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) walk(v, `${path}/${k}`, visit);
    }
}

/** 快照（解析后的对象）里的图片与可疑字符串；origin 用于识别本站的绝对地址。 */
export function extractImages(snapshot: unknown, origin?: string): SnapshotImages {
    const images: ImageRef[] = [];
    const strings: StrayRef[] = [];
    const visit = (root: unknown, prefix: string) => walk(root, prefix, (value, path) => {
        if (typeof value === 'string') {
            if (SCHEME.test(value)) strings.push({ where: path, value });
            return;
        }
        if (value == null || typeof value !== 'object' || Array.isArray(value)) return;
        const o = value as Record<string, unknown>;
        const type = typeof o.imageSourceType === 'string' ? o.imageSourceType : typeof o.sourceType === 'string' ? o.sourceType : undefined;
        if (typeof o.source === 'string' && type != null) {
            images.push({ where: path, source: o.source, kind: classifySource(o.source, origin), imageSourceType: type });
        }
    });

    const root = snapshot as { resources?: { name: string; data: string }[] } | null;
    const { resources, ...rest } = root ?? {};
    visit(rest, '');
    for (const r of resources ?? []) {
        let data: unknown = r.data;
        try {
            data = JSON.parse(r.data);
        } catch {
            // 不是 JSON：按字符串处理
        }
        visit(data, `resources.${r.name}`);
    }
    const known = new Set(images.map((i) => `${i.where}/source`));
    return { images, stray: strings.filter((s) => !known.has(s.where)) };
}

/** 引用关系：快照文本中出现的全部平台资源 id（00 号计划书 §8.5，不需要理解 Univer 的内部结构）。 */
export function scanAssetRefs(text: string): string[] {
    return [...new Set([...text.matchAll(ASSET_REF)].map((m) => m[1]))];
}
