// V01：扫描编辑器产物（表格、文字文档入口的全部 JS/CSS 块与 Worker）中的绝对 URL、联网能力与动态代码执行。
// 只扫描编辑器产物：入口页与 CSP 阳性对照页属于验证工程本身，不计入。
// 用法：先 vite build，再 node scripts/url-scan.ts
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, 'e2e', 'results', 'v01');

interface Chunk {
    file: string;
    imports?: string[];
    dynamicImports?: string[];
    css?: string[];
    assets?: string[];
}
const manifest = JSON.parse(readFileSync(join(DIST, '.vite', 'manifest.json'), 'utf8')) as Record<string, Chunk>;

/** 编辑器入口的全部产物：静态与按需加载的 JS、CSS、Worker。 */
function editorFiles(): string[] {
    const files = new Set<string>();
    const seen = new Set<string>();
    const stack = ['sheet.html', 'doc.html'];
    while (stack.length > 0) {
        const k = stack.pop()!;
        if (seen.has(k)) continue;
        seen.add(k);
        const c = manifest[k];
        files.add(c.file);
        for (const css of c.css ?? []) files.add(css);
        for (const a of c.assets ?? []) if (/\.(js|css)$/.test(a)) files.add(a);
        stack.push(...(c.imports ?? []), ...(c.dynamicImports ?? []));
    }
    return [...files].sort();
}

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
/** 动态代码执行：严格 CSP 下会被拦截；WebKit 的 Worker 内这类违规没有任何渠道可见，所以用静态扫描兜底。 */
const DYNAMIC_CODE: Record<string, RegExp> = {
    'eval(': /(?<![\w$])eval\s*\(/g,
    '(0, eval)': /\(\s*0\s*,\s*eval\s*\)/g,
    'new Function(': /\bnew\s+Function\s*\(/g,
    "Function('…')": /(?<![\w$.])Function\s*\(\s*["'`]/g,
    "setTimeout('…')": /\bset(?:Timeout|Interval)\s*\(\s*["'`]/g,
    'WebAssembly.': /\bWebAssembly\./g,
};
const KEYWORDS = ['univerjs-pro', 'univer-pro', 'licenseKey', 'license-key', 'watermark', 'telemetry', 'posthog', 'sentry', 'google-analytics', 'gtag(', 'mixpanel', 'grpc', 'protobuf'];

function context(text: string, index: number, span = 60): string {
    return text.slice(Math.max(0, index - span), index + span).replace(/\s+/g, ' ');
}

const files = editorFiles();
const hosts = new Map<string, { count: number; files: Set<string>; samples: string[] }>();
const network: Record<string, { count: number; files: Record<string, number>; samples: string[] }> = {};
const dynamic: Record<string, { count: number; samples: string[] }> = {};
const keywords: Record<string, { count: number; samples: string[] }> = {};

function tally(target: Record<string, { count: number; samples: string[]; files?: Record<string, number> }>, name: string, text: string, rel: string, re: RegExp) {
    for (const m of text.matchAll(re)) {
        target[name] ??= { count: 0, samples: [], ...(target === network ? { files: {} } : {}) };
        const t = target[name];
        t.count++;
        if (t.files) t.files[rel] = (t.files[rel] ?? 0) + 1;
        if (t.samples.length < 3) t.samples.push(`${rel}: ${context(text, m.index!)}`);
    }
}

for (const rel of files) {
    const text = readFileSync(join(DIST, rel), 'utf8');
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
    for (const [name, re] of Object.entries(NETWORK_APIS)) tally(network, name, text, rel, re);
    for (const [name, re] of Object.entries(DYNAMIC_CODE)) tally(dynamic, name, text, rel, re);
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
    scope: { entries: ['sheet.html', 'doc.html'], fileCount: files.length, files },
    hosts: [...hosts.entries()]
        .map(([host, h]) => ({ host, count: h.count, files: [...h.files].slice(0, 5), samples: h.samples }))
        .sort((a, b) => b.count - a.count),
    networkApis: network,
    dynamicCode: dynamic,
    keywords,
    keywordsSearched: KEYWORDS,
};
await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, 'url-scan.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(`扫描 ${files.length} 个编辑器产物文件`);
console.log(result.hosts.map((h) => `${String(h.count).padStart(5)}  ${h.host}`).join('\n'));
console.log('network APIs:', JSON.stringify(Object.fromEntries(Object.entries(network).map(([k, v]) => [k, v.count]))));
console.log('dynamic code:', JSON.stringify(Object.fromEntries(Object.entries(dynamic).map(([k, v]) => [k, v.count]))));
console.log('keywords:', JSON.stringify(Object.fromEntries(Object.entries(keywords).map(([k, v]) => [k, v.count]))));
