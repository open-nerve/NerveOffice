import type { BuildOutput, EntryBudget, ViteManifest, WorkerBudget } from './budgets.ts'
import { describe, expect, it } from 'vitest'
import { checkBudgets, entryWorkers, initialFiles, reachableFiles, workerClosure } from './budgets.ts'

const MANIFEST: ViteManifest = {
  'index.html': { file: 'assets/index.js', isEntry: true, imports: ['_shared.js'], css: ['assets/index.css'] },
  '_shared.js': { file: 'assets/shared.js', imports: ['_deep.js'], css: ['assets/shared.css'] },
  '_deep.js': { file: 'assets/deep.js' },
  // 只被动态加载的块（manifest 里在 dynamicImports，不在 imports）
  'src/lazy.ts': { file: 'assets/lazy.js' },
  // 编辑器页的入口块创建公式 Worker：Vite 把 Worker 的产物列在 assets 里
  'editor.html': { file: 'assets/editor.js', isEntry: true, imports: ['_shared.js'], dynamicImports: ['src/lazy.ts'], assets: ['assets/formula.worker-AbC_12xy.js', 'assets/logo-Q1.png'] },
}

const SIZES: Record<string, number> = {
  'assets/index.js': 10_000,
  'assets/shared.js': 20_000,
  'assets/deep.js': 5_000,
  'assets/lazy.js': 900_000,
  'assets/editor.js': 1_000,
  'assets/formula.worker-AbC_12xy.js': 7_000,
  'assets/worker-chunk-X1.js': 3_000,
}

/** 产物的内容：编辑器的入口块创建公式 Worker，Worker 静态引用一个块、动态加载一个块 */
const TEXTS: Record<string, string> = {
  'assets/editor.js': 'const w=new Worker(new URL(`/assets/formula.worker-AbC_12xy.js`,``+import.meta.url),{type:`module`})',
  'assets/formula.worker-AbC_12xy.js': 'import{a as e}from"./worker-chunk-X1.js";e();import("./worker-lazy-L1.js")',
  'assets/worker-chunk-X1.js': 'export const a=()=>1',
  'assets/worker-lazy-L1.js': 'export const b=2',
}

/** 产物里的全部脚本：构建清单里的块、公式 Worker 与它的块 */
const FILES = ['assets/index.js', 'assets/shared.js', 'assets/deep.js', 'assets/lazy.js', 'assets/editor.js', 'assets/formula.worker-AbC_12xy.js', 'assets/worker-chunk-X1.js', 'assets/worker-lazy-L1.js', 'assets/index.css', 'assets/logo-Q1.png']

const OUTPUT: BuildOutput = { files: FILES, gzipSize: file => SIZES[file] ?? 0, readText: file => TEXTS[file] ?? '' }

const budget = (entry: string, maxGzipBytes: number): EntryBudget => ({ entry, label: '平台页面', maxGzipBytes, reason: '测试' })
const workerBudget = (worker: string, maxGzipBytes: number): WorkerBudget => ({ entry: 'editor.html', worker, label: '公式 Worker', maxGzipBytes, reason: '测试' })
/** 编辑器页与它的公式 Worker 的预算都足够：只看平台页面的结果 */
const editorBudget = budget('editor.html', 10_000_000)
const formulaBudget = workerBudget('formula.worker', 10_000_000)

describe('US-M1-11 首屏 JS 的体积预算', () => {
  it('首屏的文件：入口块与它静态引用的块（递归），不含动态加载的块；共用的块只算一次', () => {
    expect(initialFiles(MANIFEST, 'index.html')).toEqual(['assets/deep.js', 'assets/index.js', 'assets/shared.js'])
    expect(initialFiles(MANIFEST, 'missing.html')).toBeUndefined()
  })

  it('入口能加载到的全部文件：首屏的块、动态加载的块与样式', () => {
    expect(reachableFiles(MANIFEST, 'editor.html')).toEqual(['assets/deep.js', 'assets/editor.js', 'assets/lazy.js', 'assets/shared.css', 'assets/shared.js'])
    expect(reachableFiles(MANIFEST, 'missing.html')).toEqual([])
  })

  it('不超过预算：通过，并给出实测值', () => {
    const result = checkBudgets(MANIFEST, [budget('index.html', 35_000), editorBudget], [formulaBudget], OUTPUT)
    expect(result.violations).toEqual([])
    expect(result.notes[0]).toContain('34.2 KiB')
  })

  it('超过预算：违规', () => {
    const result = checkBudgets(MANIFEST, [budget('index.html', 34_999), editorBudget], [formulaBudget], OUTPUT)
    expect(result.violations.map(v => v.rule)).toEqual(['budgets/exceeded'])
  })

  it('预算指向的入口不存在：违规（预算表要跟着入口一起改）', () => {
    const manifest: ViteManifest = { 'index.html': MANIFEST['index.html'] ?? { file: '' } }
    const result = checkBudgets(manifest, [budget('index.html', 1_000_000), budget('platform.html', 1)], [], { ...OUTPUT, files: ['assets/index.js'], gzipSize: () => 0 })
    expect(result.violations.map(v => v.rule)).toEqual(['budgets/missing-entry'])
  })

  it('构建清单里的入口没有预算：违规（新增入口时一起定下预算，复验 RA5）', () => {
    const manifest: ViteManifest = { 'index.html': MANIFEST['index.html'] ?? { file: '' }, 'report.html': { file: 'assets/report.js', isEntry: true } }
    const result = checkBudgets(manifest, [budget('index.html', 1_000_000)], [], { ...OUTPUT, files: ['assets/index.js', 'assets/report.js'] })
    expect(result.violations).toEqual([expect.objectContaining({ rule: 'budgets/unbudgeted-entry', subject: 'report.html' })])
  })
})

describe('US-M1-11 入口创建的 Worker 的体积预算（P4 设计 §3.9）', () => {
  const entryBudgets = [budget('index.html', 10_000_000), editorBudget]

  it('按构建清单找到入口能加载到的块创建的 Worker（块的 assets 里的脚本；图片不算）', () => {
    expect(entryWorkers(MANIFEST, 'editor.html')).toEqual(['assets/formula.worker-AbC_12xy.js'])
    expect(entryWorkers(MANIFEST, 'index.html')).toEqual([])
    expect(entryWorkers(MANIFEST, 'missing.html')).toEqual([])
  })

  it('Worker 的产物与它引用的块：首屏按静态引用；要全部能加载到的产物时连同动态加载的块', () => {
    expect(workerClosure('assets/formula.worker-AbC_12xy.js', OUTPUT.readText)).toEqual(['assets/formula.worker-AbC_12xy.js', 'assets/worker-chunk-X1.js'])
    expect(workerClosure('assets/formula.worker-AbC_12xy.js', OUTPUT.readText, true)).toEqual(['assets/formula.worker-AbC_12xy.js', 'assets/worker-chunk-X1.js', 'assets/worker-lazy-L1.js'])
  })

  it('不超过预算：通过，并给出实测值；超过：违规', () => {
    const passed = checkBudgets(MANIFEST, entryBudgets, [workerBudget('formula.worker', 10_000)], OUTPUT)
    expect(passed.violations).toEqual([])
    expect(passed.notes).toContain('公式 Worker（formula.worker）首屏 JS 9.8 KiB / 预算 10 KiB（gzip，2 个文件）')
    const exceeded = checkBudgets(MANIFEST, entryBudgets, [workerBudget('formula.worker', 9_999)], OUTPUT)
    expect(exceeded.violations.map(v => v.rule)).toEqual(['budgets/exceeded'])
  })

  it('入口能加载到的块没有创建这个 Worker：违规（预算表要跟着 Worker 一起改）', () => {
    const result = checkBudgets(MANIFEST, entryBudgets, [formulaBudget, workerBudget('image.worker', 1)], OUTPUT)
    expect(result.violations.map(v => v.rule)).toEqual(['budgets/missing-worker'])
  })

  it('产物里没有归属的脚本（例如 Worker 里再创建的 Worker）：违规（复验 SA5）', () => {
    const output: BuildOutput = { ...OUTPUT, files: [...FILES, 'assets/nested.worker-N1n2N3n4.js'] }
    const result = checkBudgets(MANIFEST, entryBudgets, [formulaBudget], output)
    expect(result.violations).toEqual([expect.objectContaining({ rule: 'budgets/unattributed-script', subject: 'assets/nested.worker-N1n2N3n4.js' })])
  })

  it('名字以登记的 Worker 开头的另一个 Worker 不算登记过（复验 SA9）', () => {
    const manifest: ViteManifest = { ...MANIFEST, 'editor.html': { ...MANIFEST['editor.html'] ?? { file: '' }, assets: ['assets/formula.worker-extra-Z9z8Z7z6.js'] } }
    const output: BuildOutput = { ...OUTPUT, files: [...FILES.filter(file => !file.includes('formula.worker') && !file.includes('worker-')), 'assets/formula.worker-extra-Z9z8Z7z6.js'] }
    const result = checkBudgets(manifest, entryBudgets, [formulaBudget], output)
    expect(result.violations.map(v => v.rule).sort()).toEqual(['budgets/missing-worker', 'budgets/unbudgeted-worker'])
  })

  it('没有登记预算的 Worker：首屏块创建的、?worker 写法的与动态加载的块创建的都违规（审查 A 路建议 B2，复验 RA5）', () => {
    const manifest: ViteManifest = {
      ...MANIFEST,
      'editor.html': { ...MANIFEST['editor.html'] ?? { file: '' }, assets: ['assets/formula.worker-AbC_12xy.js', 'assets/sync.worker-Z9.js'] },
      'src/lazy.ts': { file: 'assets/lazy.js', assets: ['assets/lazy.worker-K2.js'] },
    }
    const result = checkBudgets(manifest, entryBudgets, [formulaBudget], OUTPUT)
    expect(result.violations).toEqual([
      expect.objectContaining({ rule: 'budgets/unbudgeted-worker', subject: 'assets/lazy.worker-K2.js' }),
      expect.objectContaining({ rule: 'budgets/unbudgeted-worker', subject: 'assets/sync.worker-Z9.js' }),
    ])
  })
})
