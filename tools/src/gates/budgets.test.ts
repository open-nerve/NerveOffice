import type { BuildOutput, EntryBudget, ViteManifest, WorkerBudget } from './budgets.ts'
import { describe, expect, it } from 'vitest'
import { checkBudgets, initialFiles, initialStyles, reachableFiles, referencedWorkers, workerFiles } from './budgets.ts'

const MANIFEST: ViteManifest = {
  'index.html': { file: 'assets/index.js', imports: ['_shared.js'], css: ['assets/index.css'] },
  '_shared.js': { file: 'assets/shared.js', imports: ['_deep.js'], css: ['assets/shared.css'] },
  '_deep.js': { file: 'assets/deep.js' },
  // 只被动态加载的块（manifest 里在 dynamicImports，不在 imports）
  'src/lazy.ts': { file: 'assets/lazy.js' },
  'editor.html': { file: 'assets/editor.js', imports: ['_shared.js'], dynamicImports: ['src/lazy.ts'] },
}

const SIZES: Record<string, number> = {
  'assets/index.js': 10_000,
  'assets/shared.js': 20_000,
  'assets/deep.js': 5_000,
  'assets/lazy.js': 900_000,
  'assets/editor.js': 1_000,
  'assets/formula.worker-AbC_12.js': 7_000,
  'assets/worker-chunk-X1.js': 3_000,
}

/** 产物的内容：编辑器的入口块引用公式 Worker，Worker 静态引用一个块 */
const TEXTS: Record<string, string> = {
  'assets/editor.js': 'const w=new Worker(new URL(`/assets/formula.worker-AbC_12.js`,``+import.meta.url),{type:`module`})',
  'assets/formula.worker-AbC_12.js': 'import{a as e}from"./worker-chunk-X1.js";e()',
  'assets/worker-chunk-X1.js': 'export const a=()=>1',
}

const OUTPUT: BuildOutput = { gzipSize: file => SIZES[file] ?? 0, readText: file => TEXTS[file] ?? '' }

const budget = (entry: string, maxGzipBytes: number): EntryBudget => ({ entry, label: '平台页面', maxGzipBytes, reason: '测试' })
const workerBudget = (worker: string, maxGzipBytes: number): WorkerBudget => ({ entry: 'editor.html', worker, label: '公式 Worker', maxGzipBytes, reason: '测试' })

describe('US-M1-11 首屏 JS 的体积预算', () => {
  it('首屏的文件：入口块与它静态引用的块（递归），不含动态加载的块；共用的块只算一次', () => {
    expect(initialFiles(MANIFEST, 'index.html')).toEqual(['assets/deep.js', 'assets/index.js', 'assets/shared.js'])
    expect(initialFiles(MANIFEST, 'missing.html')).toBeUndefined()
  })

  it('入口能加载到的全部文件：首屏的块、动态加载的块与样式', () => {
    expect(reachableFiles(MANIFEST, 'editor.html')).toEqual(['assets/deep.js', 'assets/editor.js', 'assets/lazy.js', 'assets/shared.css', 'assets/shared.js'])
    expect(reachableFiles(MANIFEST, 'missing.html')).toEqual([])
  })

  it('首屏的样式：入口与它静态引用的块带的样式', () => {
    expect(initialStyles(MANIFEST, 'index.html')).toEqual(['assets/index.css', 'assets/shared.css'])
    expect(initialStyles(MANIFEST, 'missing.html')).toEqual([])
  })

  it('不超过预算：通过，并给出实测值', () => {
    const result = checkBudgets(MANIFEST, [budget('index.html', 35_000)], [], OUTPUT)
    expect(result.violations).toEqual([])
    expect(result.notes[0]).toContain('34.2 KiB')
  })

  it('超过预算：违规', () => {
    const result = checkBudgets(MANIFEST, [budget('index.html', 34_999)], [], OUTPUT)
    expect(result.violations.map(v => v.rule)).toEqual(['budgets/exceeded'])
  })

  it('预算指向的入口不存在：违规（预算表要跟着入口一起改）', () => {
    const result = checkBudgets(MANIFEST, [budget('platform.html', 1)], [], { ...OUTPUT, gzipSize: () => 0 })
    expect(result.violations.map(v => v.rule)).toEqual(['budgets/missing-entry'])
  })
})

describe('US-M1-11 入口创建的 Worker 的体积预算（P4 设计 §3.9）', () => {
  it('按入口的首屏块里写着的地址找到 Worker 产物，连同它静态引用的块', () => {
    expect(workerFiles(['assets/editor.js', 'assets/shared.js'], 'formula.worker', OUTPUT.readText)).toEqual(['assets/formula.worker-AbC_12.js', 'assets/worker-chunk-X1.js'])
    expect(workerFiles(['assets/index.js'], 'formula.worker', OUTPUT.readText)).toBeUndefined()
    expect(workerFiles(['assets/editor.js'], 'formula', OUTPUT.readText)).toBeUndefined()
  })

  it('不超过预算：通过，并给出实测值；超过：违规', () => {
    const passed = checkBudgets(MANIFEST, [], [workerBudget('formula.worker', 10_000)], OUTPUT)
    expect(passed.violations).toEqual([])
    expect(passed.notes[0]).toContain('公式 Worker（formula.worker）首屏 JS 9.8 KiB')
    const exceeded = checkBudgets(MANIFEST, [], [workerBudget('formula.worker', 9_999)], OUTPUT)
    expect(exceeded.violations.map(v => v.rule)).toEqual(['budgets/exceeded'])
  })

  it('入口的首屏块里没有引用这个 Worker：违规（预算表要跟着 Worker 一起改）', () => {
    const result = checkBudgets(MANIFEST, [], [workerBudget('image.worker', 1)], OUTPUT)
    expect(result.violations.map(v => v.rule)).toEqual(['budgets/missing-worker'])
  })

  it('入口的首屏块里创建了没有登记预算的 Worker：违规', () => {
    const output: BuildOutput = { ...OUTPUT, readText: file => file === 'assets/editor.js' ? `${TEXTS['assets/editor.js'] ?? ''};new SharedWorker(new URL("/assets/sync.worker-Z9.js",import.meta.url))` : OUTPUT.readText(file) }
    expect(referencedWorkers(['assets/editor.js'], output.readText)).toEqual(['assets/formula.worker-AbC_12.js', 'assets/sync.worker-Z9.js'])
    const result = checkBudgets(MANIFEST, [budget('editor.html', 1_000_000)], [workerBudget('formula.worker', 1_000_000)], output)
    expect(result.violations).toEqual([expect.objectContaining({ rule: 'budgets/unbudgeted-worker', subject: 'assets/sync.worker-Z9.js' })])
  })
})
