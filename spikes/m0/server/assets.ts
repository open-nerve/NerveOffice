// 图片资源的最小实现（P4），只用于验证 00 号计划书 §8.5、§11.4 的机制，不进入生产。
// - 上传：按文件头识别 PNG、JPEG、WebP、GIF（不接受 SVG、HTML 等主动内容），单张不超过 5 MiB，限制像素数；
//   每次上传生成独立的 assetId、记下上传者的会话，文件按 SHA-256 去重存储。
// - 读取：要求会话 Cookie；能读取引用它的文档（验证服务里所有会话都能读所有文档），或者是 24 小时内的上传者，才允许读取。
//   无权读取与不存在都返回 404（审查 S5：不让人借此探测 assetId 是否存在）。
// - 引用关系：保存文档时扫描快照中的平台地址（snapshot-images.ts），但只为保存者有权读取的图片建立引用（00 号计划书 §8.5 的保存校验，
//   审查 R2）：否则任何人把别人的地址写进自己的文档并保存，就能获得读取权。无权的地址不建立引用，保存照常成功。
import type { IncomingMessage, ServerResponse } from 'node:http';

import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { scanAssetRefs } from './snapshot-images.ts';

export const MAX_BYTES = 5 * 1024 * 1024;
/** 像素上限：00 号计划书 §12.1 只写了"另设像素上限"，这里取 4,000 万像素作验证值，M5 定稿。 */
export const MAX_PIXELS = 40_000_000;
export const UPLOADER_WINDOW_MS = 24 * 3600 * 1000;
/** 平台内置的占位图（外部图片未导入时替换用），任何会话都能读。 */
export const PLACEHOLDER_ASSET_ID = '00000000-0000-4000-8000-000000000000';
export const SESSION_COOKIE = 'm0_sid';

export type ImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface SniffResult {
    type: ImageType;
    width: number;
    height: number;
}

export interface AssetRecord {
    assetId: string;
    fileHash: string;
    uploader: string;
    uploadedAt: number;
    type: ImageType;
    width: number;
    height: number;
    bytes: number;
}

export interface AssetReadLog {
    assetId: string;
    at: string;
    session: string | null;
    status: number;
    secFetchMode?: string;
    secFetchDest?: string;
    secFetchSite?: string;
}

export interface UploadLog {
    at: string;
    session: string | null;
    status: number;
    claimedType?: string;
    fileName?: string;
    bytes: number;
    assetId?: string;
    reason?: string;
}

// ---- 文件头识别 ----

function pngSize(b: Buffer): [number, number] | null {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (b.length < 24 || !sig.every((x, i) => b[i] === x) || b.toString('ascii', 12, 16) !== 'IHDR') return null;
    return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

function gifSize(b: Buffer): [number, number] | null {
    const head = b.toString('ascii', 0, 6);
    if (b.length < 10 || (head !== 'GIF87a' && head !== 'GIF89a')) return null;
    return [b.readUInt16LE(6), b.readUInt16LE(8)];
}

function jpegSize(b: Buffer): [number, number] | null {
    if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
    let i = 2;
    while (i + 9 < b.length) {
        if (b[i] !== 0xff) return null;
        const marker = b[i + 1];
        // 独立标记（没有长度）
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            i += 2;
            continue;
        }
        const len = b.readUInt16BE(i + 2);
        // SOF0–SOF15，排除 DHT（C4）、JPG（C8）、DAC（CC）
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
        }
        i += 2 + len;
    }
    return null;
}

function webpSize(b: Buffer): [number, number] | null {
    if (b.length < 30 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return null;
    const chunk = b.toString('ascii', 12, 16);
    if (chunk === 'VP8 ') return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
    if (chunk === 'VP8L') {
        const bits = b.readUInt32LE(21);
        return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
    }
    if (chunk === 'VP8X') return [b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1];
    return null;
}

/** 按文件头识别图片类型与尺寸；不是这四种之一就返回 null（不采信客户端声明的类型与扩展名）。 */
export function sniffImage(b: Buffer): SniffResult | null {
    const probes: [ImageType, (b: Buffer) => [number, number] | null][] = [
        ['image/png', pngSize],
        ['image/jpeg', jpegSize],
        ['image/gif', gifSize],
        ['image/webp', webpSize],
    ];
    for (const [type, probe] of probes) {
        const size = probe(b);
        if (size != null) return { type, width: size[0], height: size[1] };
    }
    return null;
}

const EXTENSIONS: Record<ImageType, string[]> = {
    'image/png': ['png'],
    'image/jpeg': ['jpg', 'jpeg', 'jpe', 'jfif'],
    'image/gif': ['gif'],
    'image/webp': ['webp'],
};

// ---- 占位图：纯色 PNG（不引入依赖，手工拼 IHDR / IDAT / IEND） ----

function crc32(buf: Buffer): number {
    let c = ~0;
    for (const byte of buf) {
        c ^= byte;
        for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
}

export function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // 位深
    ihdr[9] = 2; // RGB
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
    const raw = Buffer.concat(Array.from({ length: height }, () => row));
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', deflateSync(raw)),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

// ---- 存储与授权 ----

const files = new Map<string, Buffer>();
const assets = new Map<string, AssetRecord>();
/** 文档 → 它引用的 assetId（保存文档时由快照文本扫描得出）。 */
const links = new Map<string, Set<string>>();
const reads: AssetReadLog[] = [];
const uploads: UploadLog[] = [];
/** 故障注入：接下来的 n 次上传返回指定状态码（验证上传失败时编辑器的行为）。 */
let failNext: { status: number; count: number } | null = null;

function addAsset(bytes: Buffer, session: string, assetId: string = randomUUID()): AssetRecord {
    const info = sniffImage(bytes)!;
    const fileHash = createHash('sha256').update(bytes).digest('hex');
    if (!files.has(fileHash)) files.set(fileHash, bytes);
    const record: AssetRecord = { assetId, fileHash, uploader: session, uploadedAt: Date.now(), type: info.type, width: info.width, height: info.height, bytes: bytes.length };
    assets.set(assetId, record);
    return record;
}

addAsset(solidPng(160, 90, [214, 214, 214]), 'platform', PLACEHOLDER_ASSET_ID);

export function sessionOf(req: IncomingMessage): string | null {
    const cookie = req.headers.cookie ?? '';
    const m = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([\\w-]+)`).exec(cookie);
    return m?.[1] ?? null;
}

/** 页面响应：没有会话时下发一个（HttpOnly、SameSite=Strict）。 */
export function sessionCookieHeader(req: IncomingMessage): Record<string, string> {
    if (sessionOf(req) != null) return {};
    return { 'Set-Cookie': `${SESSION_COOKIE}=${randomUUID()}; Path=/; HttpOnly; SameSite=Strict` };
}

export interface LinkUpdate {
    linked: string[];
    /** 没有建立引用的地址：不存在，或者保存者无权读取（见 canLink）。 */
    ignored: string[];
}

/**
 * 保存文档时更新引用关系：快照里的平台地址，只有这几种情况才建立引用：
 * 这份文档原来就引用它；保存者是 24 小时内的上传者；它已被其他文档引用（验证服务里所有会话都能读所有文档，生产上要求保存者能读那份文档）。
 */
export function updateLinks(docId: string, snapshot: unknown, session: string | null): LinkUpdate {
    const previous = links.get(docId) ?? new Set<string>();
    const linked: string[] = [];
    const ignored: string[] = [];
    for (const id of scanAssetRefs(snapshot)) {
        const record = assets.get(id);
        const allowed = record != null && (previous.has(id) || record.assetId === PLACEHOLDER_ASSET_ID || (session != null && (isFreshUpload(record, session) || referenced(id, docId))));
        (allowed ? linked : ignored).push(id);
    }
    links.set(docId, new Set(linked));
    return { linked, ignored };
}

export function copyLinks(from: string, to: string): void {
    links.set(to, new Set(links.get(from) ?? []));
}

export function removeLinks(docId: string): void {
    links.delete(docId);
}

/** 是否被某份文档引用（exceptDoc 除外）。 */
function referenced(assetId: string, exceptDoc?: string): boolean {
    for (const [doc, set] of links) if (doc !== exceptDoc && set.has(assetId)) return true;
    return false;
}

function isFreshUpload(record: AssetRecord, session: string): boolean {
    return record.uploader === session && Date.now() - record.uploadedAt < UPLOADER_WINDOW_MS;
}

function canRead(record: AssetRecord, session: string): boolean {
    if (record.assetId === PLACEHOLDER_ASSET_ID) return true;
    return isFreshUpload(record, session) || referenced(record.assetId);
}

async function readBytes(req: IncomingMessage, limit: number): Promise<Buffer | null> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > limit) return null;
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
}

function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
}

const ASSET_URL = /^\/api\/assets\/([0-9a-f-]{36})$/;

export interface AssetOptions {
    /**
     * 读取失败（401、404）时返回平台的占位图（200，状态放在 X-Asset-Status 头里），而不是错误状态码。
     * 编辑器用 <img> 读取图片，读取失败时 SDK 的渲染可能对破损的图片调用 drawImage，抛出未捕获的 InvalidStateError（P4 报告）。
     */
    fallback?: boolean;
}

/** 处理 /api/assets 与 /__assets；不是这些路径时返回 false。 */
export async function handleAssets(req: IncomingMessage, res: ServerResponse, url: URL, options: AssetOptions = {}): Promise<boolean> {
    if (url.pathname === '/api/assets' && req.method === 'POST') {
        const session = sessionOf(req);
        const claimedType = req.headers['content-type'];
        const fileName = typeof req.headers['x-file-name'] === 'string' ? decodeURIComponent(req.headers['x-file-name']) : undefined;
        const log = (status: number, bytes: number, extra: Partial<UploadLog>) => uploads.push({ at: new Date().toISOString(), session, status, claimedType, fileName, bytes, ...extra });
        if (session == null) {
            log(401, 0, { reason: '没有会话' });
            json(res, 401, { error: 'unauthenticated' });
            return true;
        }
        if (failNext != null && failNext.count > 0) {
            failNext.count -= 1;
            log(failNext.status, 0, { reason: '故障注入' });
            json(res, failNext.status, { error: 'injected' });
            return true;
        }
        const bytes = await readBytes(req, MAX_BYTES);
        if (bytes == null) {
            log(413, MAX_BYTES + 1, { reason: '超过 5 MiB' });
            json(res, 413, { error: 'too-large' });
            return true;
        }
        const info = sniffImage(bytes);
        if (info == null) {
            log(415, bytes.length, { reason: '不是 PNG、JPEG、WebP、GIF' });
            json(res, 415, { error: 'unsupported-type' });
            return true;
        }
        const ext = fileName?.split('.').pop()?.toLowerCase();
        if (ext != null && fileName!.includes('.') && !EXTENSIONS[info.type].includes(ext)) {
            log(415, bytes.length, { reason: `扩展名 ${ext} 与内容 ${info.type} 不符` });
            json(res, 415, { error: 'extension-mismatch' });
            return true;
        }
        if (info.width * info.height > MAX_PIXELS) {
            log(422, bytes.length, { reason: '像素数超限' });
            json(res, 422, { error: 'too-many-pixels' });
            return true;
        }
        const record = addAsset(bytes, session);
        log(201, bytes.length, { assetId: record.assetId });
        json(res, 201, { assetId: record.assetId, url: `/api/assets/${record.assetId}`, type: record.type, width: record.width, height: record.height });
        return true;
    }

    const m = ASSET_URL.exec(url.pathname);
    if (m != null && (req.method === 'GET' || req.method === 'HEAD')) {
        const session = sessionOf(req);
        const record = assets.get(m[1]);
        const status = session == null ? 401 : record != null && canRead(record, session) ? 200 : 404;
        reads.push({
            assetId: m[1],
            at: new Date().toISOString(),
            session,
            status,
            secFetchMode: req.headers['sec-fetch-mode'] as string | undefined,
            secFetchDest: req.headers['sec-fetch-dest'] as string | undefined,
            secFetchSite: req.headers['sec-fetch-site'] as string | undefined,
        });
        if (status !== 200 && !options.fallback) {
            res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end(String(status));
            return true;
        }
        const served = status === 200 ? record! : assets.get(PLACEHOLDER_ASSET_ID)!;
        const bytes = files.get(served.fileHash)!;
        res.writeHead(200, {
            'Content-Type': served.type,
            'X-Asset-Status': String(status),
            'Content-Length': bytes.length,
            'X-Content-Type-Options': 'nosniff',
            // 资源不可变；验证服务不缓存，便于核对每次读取都经过鉴权
            'Cache-Control': 'private, no-store',
            'Content-Security-Policy': "default-src 'none'; sandbox",
            'Cross-Origin-Resource-Policy': 'same-origin',
        });
        res.end(req.method === 'HEAD' ? undefined : bytes);
        return true;
    }

    if (url.pathname === '/__assets') {
        if (req.method === 'DELETE') {
            reads.length = 0;
            uploads.length = 0;
            failNext = null;
            res.writeHead(204).end();
            return true;
        }
        json(res, 200, {
            assets: [...assets.values()],
            files: files.size,
            links: Object.fromEntries([...links].map(([k, v]) => [k, [...v]])),
            reads,
            uploads,
        });
        return true;
    }
    if (url.pathname === '/__assets/fail' && req.method === 'POST') {
        failNext = { status: Number(url.searchParams.get('status') ?? 503), count: Number(url.searchParams.get('count') ?? 1) };
        res.writeHead(204).end();
        return true;
    }
    return false;
}
