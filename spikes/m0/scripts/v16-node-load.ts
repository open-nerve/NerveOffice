// V16（可选）：在 Node.js 下以无界面方式加载快照再保存（P6，00 号计划书 §8.7），为将来的服务端迁移工具做可行性记录。
// - 纯 Node 24（不用 happy-dom），用发布的包；只注册档案里有数据的无界面插件（资源 hook 与浏览器一致），外加渲染引擎插件
//   （文字文档的编辑 mutation 与表格图片的刷新要用 IRenderManagerService，它不碰 DOM）；
// - 对 fixtures 里的每个表格与文字文档样本：加载 → save()，与浏览器里"加载 → save()"的结果（e2e/results/v16/browser/，
//   由 e2e/v16-browser-saves.spec.ts 生成）按规范化内容比较；另跑一遍 NO_CALCULATION（迁移时不重算公式），与样本本身比较。
// 用法：node scripts/v16-node-load.ts
import type { IDocumentData, IWorkbookData } from '@univerjs/core';

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { IResourceManagerService, LifecycleService, LifecycleStages, LocaleType, LogLevel, Univer } from '@univerjs/core';
import { FUniver } from '@univerjs/core/facade';
import { UniverDataValidationPlugin } from '@univerjs/data-validation';
import { UniverDocsPlugin } from '@univerjs/docs';
import { UniverDocsDrawingPlugin } from '@univerjs/docs-drawing';
import { UniverDocsHyperLinkPlugin } from '@univerjs/docs-hyper-link';
import { UniverDrawingPlugin } from '@univerjs/drawing';
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula';
import { UniverRenderEnginePlugin } from '@univerjs/engine-render';
import { UniverSheetsPlugin } from '@univerjs/sheets';
import { UniverSheetsConditionalFormattingPlugin } from '@univerjs/sheets-conditional-formatting';
import { UniverSheetsDataValidationPlugin } from '@univerjs/sheets-data-validation';
import { UniverSheetsDrawingPlugin } from '@univerjs/sheets-drawing';
import { UniverSheetsFilterPlugin } from '@univerjs/sheets-filter';
import { CalculationMode, UniverSheetsFormulaPlugin } from '@univerjs/sheets-formula';
import { UniverSheetsHyperLinkPlugin } from '@univerjs/sheets-hyper-link';
import { UniverSheetsNotePlugin } from '@univerjs/sheets-note';
import { UniverSheetsNumfmtPlugin } from '@univerjs/sheets-numfmt';
import { UniverSheetsSortPlugin } from '@univerjs/sheets-sort';
import '@univerjs/sheets/facade';
import '@univerjs/docs/facade';
import { canonicalContent, normalizeContent } from '../src/harness/content-compare.ts';
import { diffJson } from '../e2e/diff.ts';

type Kind = 'sheet' | 'doc';
const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'e2e', 'results', 'v16');

function createUniver(kind: Kind, calc: 'default' | 'none'): { univer: Univer; api: FUniver } {
    const univer = new Univer({ locale: LocaleType.ZH_CN, locales: { [LocaleType.ZH_CN]: {} }, logLevel: LogLevel.ERROR });
    univer.registerPlugin(UniverDocsPlugin);
    univer.registerPlugin(UniverRenderEnginePlugin);
    if (kind === 'sheet') {
        univer.registerPlugin(UniverFormulaEnginePlugin);
        univer.registerPlugin(UniverSheetsPlugin, { onlyRegisterFormulaRelatedMutations: false, largeSheetOperation: { largeSheetCellCountThreshold: Number.MAX_SAFE_INTEGER } } as never);
        univer.registerPlugin(UniverSheetsFormulaPlugin, calc === 'none' ? { initialFormulaComputing: CalculationMode.NO_CALCULATION } as never : undefined);
        univer.registerPlugin(UniverSheetsNumfmtPlugin);
        univer.registerPlugin(UniverDrawingPlugin);
        univer.registerPlugin(UniverDocsDrawingPlugin);
        univer.registerPlugin(UniverSheetsDrawingPlugin);
        univer.registerPlugin(UniverSheetsConditionalFormattingPlugin);
        univer.registerPlugin(UniverSheetsFilterPlugin);
        univer.registerPlugin(UniverSheetsHyperLinkPlugin);
        univer.registerPlugin(UniverDataValidationPlugin);
        univer.registerPlugin(UniverSheetsDataValidationPlugin);
        univer.registerPlugin(UniverSheetsNotePlugin);
        univer.registerPlugin(UniverSheetsSortPlugin);
    } else {
        univer.registerPlugin(UniverDrawingPlugin);
        univer.registerPlugin(UniverDocsDrawingPlugin);
        univer.registerPlugin(UniverDocsHyperLinkPlugin);
    }
    return { univer, api: FUniver.newAPI(univer) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function loadAndSave(kind: Kind, data: Record<string, unknown>, calc: 'default' | 'none') {
    const errors: string[] = [];
    const onError = (e: unknown) => errors.push(e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 200) : String(e));
    process.on('uncaughtException', onError);
    process.on('unhandledRejection', onError);
    const t0 = performance.now();
    const heap0 = process.memoryUsage().heapUsed;
    const { univer, api } = createUniver(kind, calc);
    const lifecycle = univer.__getInjector().get(LifecycleService);
    const copy = structuredClone(data);
    const unit = kind === 'sheet' ? api.createWorkbook(copy as Partial<IWorkbookData>) : api.createDocument(copy as Partial<IDocumentData>);
    const tLoad = performance.now();
    // 生命周期只会到 Ready（Rendered 由界面插件推进）；等公式等异步任务落定
    await sleep(calc === 'none' ? 200 : 1500);
    const stage = LifecycleStages[lifecycle.stage];
    const saved = unit.save();
    const tSave = performance.now();
    const hooks = univer.__getInjector().get(IResourceManagerService).getAllResourceHooks().filter((h) => h.businesses.includes(kind === 'sheet' ? 2 : 1)).map((h) => h.pluginName).sort();
    const heapMiB = (process.memoryUsage().heapUsed - heap0) / 1024 / 1024;
    univer.dispose();
    process.off('uncaughtException', onError);
    process.off('unhandledRejection', onError);
    return { saved, text: JSON.stringify(saved), stage, loadMs: tLoad - t0, totalMs: tSave - t0, heapMiB, hooks, errors };
}

const brief = (a: string, b: string) => {
    const diffs = diffJson(normalizeContent(a), normalizeContent(b));
    return { equal: canonicalContent(a) === canonicalContent(b), diffCount: diffs.length, diffs: diffs.slice(0, 8) };
};

const rows: Record<string, unknown>[] = [];
for (const kind of ['sheet', 'doc'] as const) {
    const dir = join(ROOT, 'fixtures', kind);
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
        const name = file.replace(/\.json$/, '');
        const fixtureText = readFileSync(join(dir, file), 'utf8');
        const fixture = JSON.parse(fixtureText) as Record<string, unknown>;
        const run = await loadAndSave(kind, fixture, 'default');
        const migrate = await loadAndSave(kind, fixture, 'none');
        const browserFile = join(OUT, 'browser', `chromium-${kind}-${name}.json`);
        const browserText = existsSync(browserFile) ? JSON.stringify((JSON.parse(readFileSync(browserFile, 'utf8')) as { saved: unknown }).saved) : null;
        const row = {
            sample: `${kind}/${name}`,
            stage: run.stage,
            loadMs: Math.round(run.loadMs),
            totalMs: Math.round(run.totalMs),
            heapMiB: Math.round(run.heapMiB * 10) / 10,
            hooks: run.hooks,
            errors: [...new Set([...run.errors, ...migrate.errors])],
            vsBrowser: browserText == null ? null : brief(browserText, run.text),
            noCalcVsFixture: brief(JSON.stringify(fixture), migrate.text),
            defaultVsFixture: brief(JSON.stringify(fixture), run.text),
        };
        rows.push(row);
        console.log(`${row.sample.padEnd(24)} ${String(row.stage).padEnd(8)} 浏览器：${row.vsBrowser == null ? '—' : row.vsBrowser.equal ? '一致' : `不同 ${row.vsBrowser.diffCount} 处`}；NO_CALCULATION 与样本：${row.noCalcVsFixture.equal ? '一致' : `不同 ${row.noCalcVsFixture.diffCount} 处`}；错误 ${row.errors.length}`);
    }
}
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'node-load.json'), `${JSON.stringify({ check: 'V16', node: process.version, timestamp: new Date().toISOString(), rows }, null, 2)}\n`);
process.exit(0);
