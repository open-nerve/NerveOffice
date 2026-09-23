// P1：按编辑器入口统计包体积（首屏静态依赖、按需加载的块、Worker），原始体积与 gzip 体积。
// 用法：先 vite build，再 node scripts/bundle-size.ts
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const ROOT = join(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, 'e2e', 'results', 'p1');

interface Chunk {
    file: string;
    imports?: string[];
    dynamicImports?: string[];
    css?: string[];
    assets?: string[];
    isEntry?: boolean;
}
const manifest = JSON.parse(readFileSync(join(DIST, '.vite', 'manifest.json'), 'utf8')) as Record<string, Chunk>;

function size(file: string) {
    const buf = readFileSync(join(DIST, file));
    return { raw: buf.length, gzip: gzipSync(buf).length };
}

function sum(files: Iterable<string>) {
    let raw = 0;
    let gzip = 0;
    const list: { file: string; raw: number; gzip: number }[] = [];
    for (const f of files) {
        const s = size(f);
        raw += s.raw;
        gzip += s.gzip;
        list.push({ file: f, ...s });
    }
    list.sort((a, b) => b.raw - a.raw);
    return { raw, gzip, count: list.length, files: list };
}

function closure(keys: string[], follow: 'imports' | 'dynamicImports'): Set<string> {
    const seen = new Set<string>();
    const stack = [...keys];
    while (stack.length > 0) {
        const k = stack.pop()!;
        if (seen.has(k)) continue;
        seen.add(k);
        for (const i of manifest[k]?.imports ?? []) stack.push(i);
        if (follow === 'dynamicImports') for (const i of manifest[k]?.dynamicImports ?? []) stack.push(i);
    }
    return seen;
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MiB`;
const report: Record<string, unknown> = { timestamp: new Date().toISOString() };

for (const entry of ['sheet.html', 'doc.html']) {
    const initial = closure([entry], 'imports');
    const all = closure([entry], 'dynamicImports');
    const lazy = [...all].filter((k) => !initial.has(k));
    const js = [...initial].map((k) => manifest[k].file);
    const css = [...new Set([...initial].flatMap((k) => manifest[k].css ?? []))];
    const workers = (manifest[entry].assets ?? []).filter((a) => a.includes('worker'));
    const r = {
        initialJs: sum(js),
        initialCss: sum(css),
        lazyJs: sum(lazy.map((k) => manifest[k].file)),
        workers: sum(workers),
    };
    report[entry] = r;
    console.log(`${entry}: 首屏 JS ${mb(r.initialJs.raw)}（gzip ${mb(r.initialJs.gzip)}），CSS ${mb(r.initialCss.raw)}（gzip ${mb(r.initialCss.gzip)}），按需 JS ${r.lazyJs.count} 块 ${mb(r.lazyJs.raw)}（gzip ${mb(r.lazyJs.gzip)}），Worker ${mb(r.workers.raw)}（gzip ${mb(r.workers.gzip)}）`);
}

await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, 'bundle-size.json'), `${JSON.stringify(report, null, 2)}\n`);
