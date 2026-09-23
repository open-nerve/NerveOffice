// 验证用静态服务：提供 dist/，为所有响应加 CSP 头，接收 CSP 违规报告。只监听 127.0.0.1，不进入生产。
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { cspHeaders } from './csp.ts';

const { values } = parseArgs({
    options: {
        port: { type: 'string', default: '4700' },
        dist: { type: 'string', default: 'dist' },
        csp: { type: 'string', default: 'full' },
        'report-log': { type: 'string', default: '' },
    },
});

const root = resolve(values.dist);
const port = Number(values.port);
const cspMode = values.csp === 'off' ? 'off' : 'full';

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
            ...cspHeaders(cspMode),
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
