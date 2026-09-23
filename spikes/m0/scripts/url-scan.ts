// V01：扫描构建产物中的绝对 URL 与联网能力代码，找出可能在运行时访问的外部地址。
// 用法：先 vite build，再 node scripts/url-scan.ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, 'e2e', 'results', 'v01');

const URL_RE = /\bhttps?:\/\/[^\s"'`()<>\\,;{}]+/g;
/** 联网能力：出现不等于会被调用，需要结合上下文判断。 */
const NETWORK_APIS: Record<string, RegExp> = {
    'fetch(': /\bfetch\(/g,
    XMLHttpRequest: /\bXMLHttpRequest\b/g,
    WebSocket: /\bnew WebSocket\(/g,
    sendBeacon: /\bsendBeacon\(/g,
    EventSource: /\bnew EventSource\(/g,
    importScripts: /\bimportScripts\(/g,
};
const KEYWORDS = ['univerjs-pro', 'univer-pro', 'licenseKey', 'license-key', 'telemetry', 'posthog', 'sentry', 'google-analytics', 'gtag(', 'mixpanel', 'grpc', 'protobuf'];

function files(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? files(p) : [p];
    });
}

function context(text: string, index: number, span = 60): string {
    return text.slice(Math.max(0, index - span), index + span).replace(/\s+/g, ' ');
}

const hosts = new Map<string, { count: number; files: Set<string>; samples: string[] }>();
const network: Record<string, { count: number; files: Record<string, number> }> = {};
const keywords: Record<string, { count: number; samples: string[] }> = {};

for (const file of files(DIST).filter((f) => /\.(js|css|html)$/.test(f))) {
    const text = readFileSync(file, 'utf8');
    const rel = relative(DIST, file);
    for (const m of text.matchAll(URL_RE)) {
        let host: string;
        try {
            host = new URL(m[0]).host;
        } catch {
            host = m[0];
        }
        const h = hosts.get(host) ?? { count: 0, files: new Set(), samples: [] };
        h.count++;
        h.files.add(rel);
        if (h.samples.length < 3) h.samples.push(context(text, m.index!));
        hosts.set(host, h);
    }
    for (const [name, re] of Object.entries(NETWORK_APIS)) {
        const n = [...text.matchAll(re)].length;
        if (n > 0) {
            network[name] ??= { count: 0, files: {} };
            network[name].count += n;
            network[name].files[rel] = n;
        }
    }
    for (const k of KEYWORDS) {
        let i = text.indexOf(k);
        while (i >= 0) {
            keywords[k] ??= { count: 0, samples: [] };
            keywords[k].count++;
            if (keywords[k].samples.length < 3) keywords[k].samples.push(`${rel}: ${context(text, i)}`);
            i = text.indexOf(k, i + k.length);
        }
    }
}

const result = {
    check: 'V01-url-scan',
    timestamp: new Date().toISOString(),
    hosts: [...hosts.entries()]
        .map(([host, h]) => ({ host, count: h.count, files: [...h.files].slice(0, 5), samples: h.samples }))
        .sort((a, b) => b.count - a.count),
    networkApis: network,
    keywords,
};
await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, 'url-scan.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(result.hosts.map((h) => `${String(h.count).padStart(5)}  ${h.host}`).join('\n'));
console.log('network APIs:', JSON.stringify(Object.fromEntries(Object.entries(network).map(([k, v]) => [k, v.count]))));
console.log('keywords:', JSON.stringify(Object.fromEntries(Object.entries(keywords).map(([k, v]) => [k, v.count]))));
