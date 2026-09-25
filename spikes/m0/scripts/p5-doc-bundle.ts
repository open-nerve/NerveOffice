// P5：文字文档去掉公式引擎后的包体积。验证工程的共用代码（变更检测等）也引用了公式引擎，直接比较 doc.html 的产物看不出差别，
// 所以按 doc@1 的插件清单生成两个最小入口（有、没有公式引擎），各自单独构建，比较全部产物（JS、CSS，原始与 gzip）。
// 用法：node scripts/p5-doc-bundle.ts（结果写入 e2e/results/v13/bundle/doc-bundle.json）
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from 'vite';

const ROOT = join(import.meta.dirname, '..');
const TMP = join(ROOT, '.p5-bundle');
const OUT = join(ROOT, 'e2e', 'results', 'v13', 'bundle');

const COMMON_IMPORTS = `
import { LocaleType, mergeLocales, Univer } from '@univerjs/core';
import { UniverDocsPlugin } from '@univerjs/docs';
import { UniverDocsDrawingPlugin } from '@univerjs/docs-drawing';
import { UniverDocsDrawingUIPlugin } from '@univerjs/docs-drawing-ui';
import { UniverDocsFindReplacePlugin } from '@univerjs/docs-find-replace';
import { UniverDocsHyperLinkPlugin } from '@univerjs/docs-hyper-link';
import { UniverDocsHyperLinkUIPlugin } from '@univerjs/docs-hyper-link-ui';
import { UniverDocsUIPlugin } from '@univerjs/docs-ui';
import { UniverDrawingPlugin } from '@univerjs/drawing';
import { UniverDrawingUIPlugin } from '@univerjs/drawing-ui';
import { UniverRenderEnginePlugin } from '@univerjs/engine-render';
import { UniverFindReplacePlugin } from '@univerjs/find-replace';
import { UniverUIPlugin } from '@univerjs/ui';
import DesignZhCN from '@univerjs/design/locale/zh-CN';
import DocsDrawingUIZhCN from '@univerjs/docs-drawing-ui/locale/zh-CN';
import DocsHyperLinkUIZhCN from '@univerjs/docs-hyper-link-ui/locale/zh-CN';
import DocsUIZhCN from '@univerjs/docs-ui/locale/zh-CN';
import DrawingUIZhCN from '@univerjs/drawing-ui/locale/zh-CN';
import FindReplaceZhCN from '@univerjs/find-replace/locale/zh-CN';
import UIZhCN from '@univerjs/ui/locale/zh-CN';
import '@univerjs/design/lib/index.css';
import '@univerjs/ui/lib/index.css';
import '@univerjs/docs-ui/lib/index.css';
import '@univerjs/drawing-ui/lib/index.css';
import '@univerjs/docs-drawing-ui/lib/index.css';
import '@univerjs/docs-hyper-link-ui/lib/index.css';
import '@univerjs/find-replace/lib/index.css';
import '@univerjs/ui/facade';
import '@univerjs/docs/facade';
import '@univerjs/docs-ui/facade';
import '@univerjs/docs-drawing/facade';
`;

const entry = (formula: boolean) => `${COMMON_IMPORTS}
${formula ? "import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula';\nimport FormulaZhCN from '@univerjs/engine-formula/locale/zh-CN';\nimport '@univerjs/engine-formula/facade';" : ''}

export function start(container: HTMLElement): Univer {
    const univer = new Univer({
        locale: LocaleType.ZH_CN,
        locales: { [LocaleType.ZH_CN]: mergeLocales(DesignZhCN, UIZhCN, DocsUIZhCN, DrawingUIZhCN, DocsDrawingUIZhCN, DocsHyperLinkUIZhCN, FindReplaceZhCN${formula ? ', FormulaZhCN' : ''}) },
    });
    univer.registerPlugin(UniverDocsPlugin);
    univer.registerPlugin(UniverRenderEnginePlugin);
    univer.registerPlugin(UniverUIPlugin, { container });
    univer.registerPlugin(UniverDocsUIPlugin, { toc: true });
    ${formula ? 'univer.registerPlugin(UniverFormulaEnginePlugin);' : ''}
    univer.registerPlugin(UniverDrawingPlugin);
    univer.registerPlugin(UniverDrawingUIPlugin);
    univer.registerPlugin(UniverDocsDrawingPlugin);
    univer.registerPlugin(UniverDocsDrawingUIPlugin);
    univer.registerPlugin(UniverDocsHyperLinkPlugin);
    univer.registerPlugin(UniverDocsHyperLinkUIPlugin);
    univer.registerPlugin(UniverFindReplacePlugin);
    univer.registerPlugin(UniverDocsFindReplacePlugin);
    return univer;
}
`;

/** 按 Vite 的 manifest 区分首屏（静态依赖）与按需加载的块。 */
async function initialSizes(dir: string) {
    const manifest = JSON.parse(await readFile(join(dir, '.vite', 'manifest.json'), 'utf8')) as Record<string, { file: string; imports?: string[]; isEntry?: boolean; css?: string[] }>;
    const entry = Object.keys(manifest).find((k) => manifest[k].isEntry);
    const seen = new Set<string>();
    const stack = entry != null ? [entry] : [];
    while (stack.length > 0) {
        const k = stack.pop()!;
        if (seen.has(k)) continue;
        seen.add(k);
        for (const i of manifest[k]?.imports ?? []) stack.push(i);
    }
    let raw = 0;
    let gzip = 0;
    for (const k of seen) {
        const buf = await readFile(join(dir, manifest[k].file));
        raw += buf.length;
        gzip += gzipSync(buf).length;
    }
    return { raw, gzip, chunks: seen.size };
}

async function sizes(dir: string) {
    const files: { file: string; raw: number; gzip: number }[] = [];
    const walk = async (d: string): Promise<void> => {
        for (const e of await readdir(d, { withFileTypes: true })) {
            const p = join(d, e.name);
            if (e.isDirectory()) await walk(p);
            else if (/\.(js|css)$/.test(e.name)) {
                const buf = await readFile(p);
                files.push({ file: p.slice(dir.length + 1), raw: buf.length, gzip: gzipSync(buf).length });
            }
        }
    };
    await walk(dir);
    const sum = (ext: string) => files.filter((f) => f.file.endsWith(ext)).reduce((a, f) => ({ raw: a.raw + f.raw, gzip: a.gzip + f.gzip }), { raw: 0, gzip: 0 });
    return { js: sum('.js'), css: sum('.css'), files: files.length };
}

await rm(TMP, { recursive: true, force: true });
await mkdir(TMP, { recursive: true });
const report: Record<string, unknown> = { timestamp: new Date().toISOString() };
for (const [name, formula] of [['withFormula', true], ['noFormula', false]] as const) {
    // 与验证工程的页面同样按应用构建（压缩、代码分割），入口是一个只挂载编辑器的页面
    const dir = join(TMP, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'editor.ts'), entry(formula));
    await writeFile(join(dir, 'main.ts'), "import { start } from './editor';\nstart(document.getElementById('root')!);\n");
    await writeFile(join(dir, 'index.html'), '<!doctype html><html><body><div id="root"></div><script type="module" src="./main.ts"></script></body></html>');
    const outDir = join(TMP, `out-${name}`);
    await build({
        configFile: false,
        root: dir,
        logLevel: 'silent',
        build: { outDir, emptyOutDir: true, target: 'es2022', minify: true, manifest: true, chunkSizeWarningLimit: 20_000 },
    });
    report[name] = { ...(await sizes(outDir)), initialJs: await initialSizes(outDir) };
}
const w = report.withFormula as Awaited<ReturnType<typeof sizes>>;
const n = report.noFormula as Awaited<ReturnType<typeof sizes>>;
const wi = (report.withFormula as { initialJs: { raw: number; gzip: number } }).initialJs;
const ni = (report.noFormula as { initialJs: { raw: number; gzip: number } }).initialJs;
report.saving = {
    jsRaw: w.js.raw - n.js.raw,
    jsGzip: w.js.gzip - n.js.gzip,
    ratioRaw: Number(((w.js.raw - n.js.raw) / w.js.raw).toFixed(3)),
    initialRaw: wi.raw - ni.raw,
    initialGzip: wi.gzip - ni.gzip,
    initialRatioRaw: Number(((wi.raw - ni.raw) / wi.raw).toFixed(3)),
};
await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, 'doc-bundle.json'), `${JSON.stringify(report, null, 2)}\n`);
await rm(TMP, { recursive: true, force: true });
const mb = (x: number) => `${(x / 1024 / 1024).toFixed(2)} MiB`;
console.log(`全部 JS：有公式引擎 ${mb(w.js.raw)}（gzip ${mb(w.js.gzip)}），没有 ${mb(n.js.raw)}（gzip ${mb(n.js.gzip)}）；首屏 JS：有 ${mb(wi.raw)}（gzip ${mb(wi.gzip)}），没有 ${mb(ni.raw)}（gzip ${mb(ni.gzip)}）`);
