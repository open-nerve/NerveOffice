// 快照中的图片地址（P4，00 号计划书 §8.5、§11.3）：提取、分类，以及引用关系。服务端（验证服务）与页面、用例共用，不依赖 Node 或 DOM。
// 默认拒绝（P4 审查 R1）：任何深度上名为 source 的字段都视为图片地址，不看它旁边有没有 imageSourceType、值是不是字符串。
// Univer 1.0.0 快照里的 source 字段都是图片：浮动图片与单元格图片（drawings）、工作表背景、文字文档的页面背景、
// 列表符号图片（bullet.image）、文字填充图片（textFill.picture），渲染时有的根本不看类型字段。资源条目的 data 是 JSON 文本，先解析再遍历。
// 另做一遍通用扫描：带 data:、http(s):、blob:、file:、javascript: 或 // 开头、又不在 source 字段里的字符串（超链接、正文里的网址等），
// 只报告，不算图片。

export type ImageSourceKind = 'platform' | 'data' | 'external' | 'same-origin-other' | 'blob' | 'file' | 'empty' | 'invalid' | 'other';

export interface ImageRef {
    /** 持有 source 字段的对象的 JSON 路径，资源数据内部用 resources.<名称>/ 开头。 */
    where: string;
    /** 字符串原样；不是字符串时为它的 JSON 文本。 */
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
    stray: StrayRef[];
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** 平台资源地址（相对地址）：/api/assets/{uuid}，不带查询参数与片段。 */
export const ASSET_PATH = new RegExp(`^/api/assets/(${UUID})$`);
const ASSET_REF = new RegExp(`/api/assets/(${UUID})`, 'g');
const SCHEME = /^\s*(?:data:|https?:|blob:|file:|javascript:|\/\/)/i;

/** origin 取自服务配置，不取自请求头（审查 G5）；本站的绝对地址按平台地址处理。 */
export function classifySource(source: unknown, origin?: string): ImageSourceKind {
    if (typeof source !== 'string') return 'invalid';
    if (source === '') return 'empty';
    if (ASSET_PATH.test(source)) return 'platform';
    if (origin != null && source.startsWith(`${origin}/`)) {
        return ASSET_PATH.test(source.slice(origin.length)) ? 'platform' : 'same-origin-other';
    }
    const s = source.trim().toLowerCase();
    if (s.startsWith('data:')) return 'data';
    if (s.startsWith('blob:')) return 'blob';
    if (s.startsWith('file:')) return 'file';
    if (s.startsWith('http:') || s.startsWith('https:') || s.startsWith('//')) return 'external';
    if (s.startsWith('/')) return 'same-origin-other';
    return 'other';
}

function walk(value: unknown, path: string, visit: (value: unknown, path: string, key: string) => void, key = ''): void {
    visit(value, path, key);
    if (Array.isArray(value)) {
        value.forEach((v, i) => walk(v, `${path}/${i}`, visit, String(i)));
    } else if (value != null && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) walk(v, `${path}/${k}`, visit, k);
    }
}

/** 快照（或任意对象，例如命令参数、粘贴的片段）按根与资源分别遍历。 */
function roots(snapshot: unknown): [unknown, string][] {
    if (snapshot == null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return [[snapshot, '']];
    const { resources, ...rest } = snapshot as { resources?: unknown };
    const out: [unknown, string][] = [[rest, '']];
    if (Array.isArray(resources)) {
        for (const r of resources as { name?: unknown; data?: unknown }[]) {
            let data: unknown = r?.data;
            if (typeof data === 'string') {
                try {
                    data = JSON.parse(data);
                } catch {
                    // 不是 JSON：按字符串处理
                }
            }
            out.push([data, `resources.${String(r?.name)}`]);
        }
    }
    return out;
}

export function extractImages(snapshot: unknown, origin?: string): SnapshotImages {
    const images: ImageRef[] = [];
    const stray: StrayRef[] = [];
    for (const [root, prefix] of roots(snapshot)) {
        walk(root, prefix, (value, path, key) => {
            if (typeof value === 'string') {
                if (key !== 'source' && SCHEME.test(value)) stray.push({ where: path, value });
                return;
            }
            if (value == null || typeof value !== 'object' || Array.isArray(value)) return;
            const o = value as Record<string, unknown>;
            if (!('source' in o)) return;
            const type = typeof o.imageSourceType === 'string' ? o.imageSourceType : typeof o.sourceType === 'string' ? o.sourceType : undefined;
            images.push({
                where: path,
                source: typeof o.source === 'string' ? o.source : JSON.stringify(o.source) ?? String(o.source),
                kind: classifySource(o.source, origin),
                imageSourceType: type,
            });
        });
    }
    return { images, stray };
}

/**
 * 引用关系：快照中所有字符串值里出现的平台资源 id（含 IMAGE() 公式里的地址）。
 * 在解析后的值上扫描（审查 G5：原始 JSON 文本里的 / 转义会让文本扫描漏掉），资源数据也先解析。
 */
export function scanAssetRefs(snapshot: unknown): string[] {
    const ids = new Set<string>();
    for (const [root] of roots(snapshot)) {
        walk(root, '', (value) => {
            if (typeof value === 'string') for (const m of value.matchAll(ASSET_REF)) ids.add(m[1]);
        });
    }
    return [...ids];
}
