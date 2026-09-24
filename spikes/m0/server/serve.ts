// 验证用静态服务：提供 dist/，为所有响应加 CSP 头，接收 CSP 违规报告；P2 起提供文档存储，P4 起提供图片资源（assets.ts）。
// 只监听 127.0.0.1，不进入生产。
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { CspMode } from './csp.ts';

import { copyLinks, handleAssets, removeLinks, sessionCookieHeader, updateLinks } from './assets.ts';
import { cspHeaders } from './csp.ts';
import { extractImages } from './snapshot-images.ts';

const { values } = parseArgs({
    options: {
        port: { type: 'string', default: '4700' },
        dist: { type: 'string', default: 'dist' },
        csp: { type: 'string', default: 'full' },
        'report-log': { type: 'string', default: '' },
        // P4：读取图片失败（401、403、404）时返回占位图，状态放在 X-Asset-Status 头里
        'asset-fallback': { type: 'boolean', default: false },
    },
});

const root = resolve(values.dist);
const port = Number(values.port);
const cspMode: CspMode = values.csp === 'off' ? 'off' : values.csp === 'html-only' ? 'html-only' : 'full';

const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.wasm': 'application/wasm',
};

export interface CspReport {
    policy: string;
    receivedAt: string;
    userAgent: string;
    body: unknown;
}

const reports: CspReport[] = [];
/** 真实 Safari 自检页面回传的结果（Playwright 无法驱动真实 Safari）。 */
const selftests: unknown[] = [];
/** 文档存储（内存）：P2 起用于保存重开、复制等实验。键是文档 id，值是快照 JSON 原文。 */
const documents = new Map<string, string>();
const DOC_PATH = /^\/api\/docs\/([\w.-]+)$/;
const DOC_COPY_PATH = /^\/api\/docs\/([\w.-]+)\/copy$/;

async function readBody(req: import('node:http').IncomingMessage, limit = 1024 * 1024): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > limit) throw new Error('报告体积超限');
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
}

const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    try {
        if (url.pathname === '/csp-report' && req.method === 'POST') {
            const text = await readBody(req);
            let parsed: unknown = text;
            try {
                parsed = JSON.parse(text);
            } catch {
                // 保留原文
            }
            // Reporting API 一次可能发来多条。
            const items = Array.isArray(parsed) ? parsed : [parsed];
            for (const body of items) {
                const report: CspReport = {
                    policy: url.searchParams.get('policy') ?? 'unknown',
                    receivedAt: new Date().toISOString(),
                    userAgent: req.headers['user-agent'] ?? '',
                    body,
                };
                reports.push(report);
                if (values['report-log']) {
                    await appendFile(values['report-log'], `${JSON.stringify(report)}\n`);
                }
            }
            res.writeHead(204).end();
            return;
        }
        if (await handleAssets(req, res, url, { fallback: values['asset-fallback'] })) return;
        if (url.pathname === '/__csp-reports') {
            if (req.method === 'DELETE') {
                reports.length = 0;
                res.writeHead(204).end();
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify(reports));
            return;
        }
        const docMatch = DOC_PATH.exec(url.pathname);
        if (docMatch != null) {
            const id = docMatch[1];
            if (req.method === 'PUT') {
                const text = await readBody(req, 64 * 1024 * 1024);
                const snapshot = JSON.parse(text); // 只接受合法 JSON
                // 保存校验（P4，00 号计划书 §11.3）：validate=1 时拒绝含非平台图片地址的快照
                if (url.searchParams.get('validate') === '1') {
                    const { images } = extractImages(snapshot, `http://${req.headers.host}`);
                    const rejected = images.filter((i) => i.kind !== 'platform');
                    if (rejected.length > 0) {
                        res.writeHead(422, { 'Content-Type': 'application/json; charset=utf-8' });
                        res.end(JSON.stringify({ error: 'non-platform-image', images: rejected.map((i) => ({ ...i, source: i.source.slice(0, 120) })) }));
                        return;
                    }
                }
                documents.set(id, text);
                updateLinks(id, text);
                res.writeHead(204).end();
                return;
            }
            if (req.method === 'DELETE') {
                documents.delete(id);
                removeLinks(id);
                res.writeHead(204).end();
                return;
            }
            const text = documents.get(id);
            if (text == null) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('document not found');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(text);
            return;
        }
        const copyMatch = DOC_COPY_PATH.exec(url.pathname);
        if (copyMatch != null && req.method === 'POST') {
            const source = documents.get(copyMatch[1]);
            const to = url.searchParams.get('to');
            if (source == null || to == null || !/^[\w.-]+$/.test(to)) {
                res.writeHead(400).end();
                return;
            }
            // 原样复制：不改 unitId 与工作表 id（00 号计划书 §8.3）；只新增引用关系，不复制图片文件（§8.5）
            documents.set(to, source);
            copyLinks(copyMatch[1], to);
            res.writeHead(204).end();
            return;
        }
        if (url.pathname === '/__selftest') {
            if (req.method === 'POST') {
                selftests.push(JSON.parse(await readBody(req)));
                res.writeHead(204).end();
                return;
            }
            if (req.method === 'DELETE') {
                selftests.length = 0;
                res.writeHead(204).end();
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify(selftests));
            return;
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405).end();
            return;
        }

        let pathname = decodeURIComponent(url.pathname);
        if (pathname === '/') pathname = '/index.html';
        const filePath = normalize(join(root, pathname));
        if (!filePath.startsWith(root)) {
            res.writeHead(403).end();
            return;
        }
        const info = await stat(filePath).catch(() => null);
        if (info == null || !info.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
            return;
        }
        res.writeHead(200, {
            'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
            'Content-Length': info.size,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            ...cspHeaders(cspMode, extname(filePath) === '.html'),
            // 页面响应下发会话 Cookie：图片读取按会话鉴权（P4）；nosession=1 时不下发，用来验证没有会话时的读取
            ...(extname(filePath) === '.html' && url.searchParams.get('nosession') !== '1' ? sessionCookieHeader(req) : {}),
        });
        if (req.method === 'HEAD') {
            res.end();
            return;
        }
        createReadStream(filePath).pipe(res);
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(error instanceof Error ? error.message : String(error));
    }
});

if (values['report-log']) {
    await mkdir(resolve(values['report-log'], '..'), { recursive: true });
}

server.listen(port, '127.0.0.1', () => {
    console.log(`[m0] serving ${root} on http://127.0.0.1:${port} (csp=${cspMode})`);
});
