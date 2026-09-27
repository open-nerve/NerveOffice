// 首屏 JS 的体积预算（规范 §11，P3 设计 §3.7，P4 设计 §3.9）：按 Vite 的构建清单，入口块加上它静态引用的块（不含动态加载的块），
// 用 gzip（默认压缩级别）统计。入口创建的 Worker 另列一项：公式 Worker 在编辑器启动时就创建，脚本随页面下载，事实上属于首屏的传输量。
// 构建清单里每个入口都要有预算；入口能加载到的块（首屏与动态加载）创建的每个 Worker 都要有预算（复验 RA5）。
// 每一项的预算在建立它的 Phase 里定下；调整要在 Phase 设计里写明原因。
import type { Violation } from './types.ts'
import { posix } from 'node:path'
import { z } from 'zod'

export interface EntryBudget {
  /** 构建清单里的键，例如 index.html */
  entry: string
  label: string
  maxGzipBytes: number
  reason: string
}

/** 入口创建的 Worker：Vite 把 Worker 的产物列在创建它的块的 assets 里，按名字找到它（见 entryWorkers）。 */
export interface WorkerBudget {
  /** 引用它的入口（构建清单里的键） */
  entry: string
  /** Worker 产物的名字：assets/<名字>-<哈希>.js，例如 formula.worker */
  worker: string
  label: string
  maxGzipBytes: number
  reason: string
}

const chunkSchema = z.object({
  file: z.string(),
  /** 页面的入口（index.html、editor.html） */
  isEntry: z.boolean().optional(),
  imports: z.array(z.string()).optional(),
  dynamicImports: z.array(z.string()).optional(),
  css: z.array(z.string()).optional(),
  /** 块以地址引用的产物：Worker（new Worker(new URL(…)) 与 ?worker 两种写法）、图片等 */
  assets: z.array(z.string()).optional(),
})

export const viteManifestSchema = z.record(z.string(), chunkSchema)
export type ViteManifest = z.infer<typeof viteManifestSchema>

/** 入口块与它静态引用的块（递归）的清单项；withDynamic 为真时连同动态加载的块。入口不在清单里时返回 undefined。 */
function chunksFrom(manifest: ViteManifest, entry: string, withDynamic: boolean): ViteManifest[string][] | undefined {
  if (manifest[entry] === undefined)
    return undefined
  const chunks: ViteManifest[string][] = []
  const pending = [entry]
  const visited = new Set<string>()
  while (pending.length > 0) {
    const key = pending.pop() ?? ''
    const chunk = manifest[key]
    if (chunk === undefined || visited.has(key))
      continue
    visited.add(key)
    chunks.push(chunk)
    pending.push(...(chunk.imports ?? []), ...(withDynamic ? chunk.dynamicImports ?? [] : []))
  }
  return chunks
}

function initialChunks(manifest: ViteManifest, entry: string): ViteManifest[string][] | undefined {
  return chunksFrom(manifest, entry, false)
}

/** 入口能加载到的全部 JS 与样式：首屏的块、动态加载的块与它们的样式。入口不在清单里时返回空的清单。 */
export function reachableFiles(manifest: ViteManifest, entry: string): string[] {
  const chunks = chunksFrom(manifest, entry, true) ?? []
  return [...new Set(chunks.flatMap(chunk => [chunk.file, ...(chunk.css ?? [])]))].sort()
}

/** 入口首屏要加载的 JS：入口块与它静态引用的块（递归），不含 dynamicImports。入口不在清单里时返回 undefined。 */
export function initialFiles(manifest: ViteManifest, entry: string): string[] | undefined {
  const chunks = initialChunks(manifest, entry)
  return chunks === undefined ? undefined : [...new Set(chunks.map(chunk => chunk.file))].sort()
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 入口能加载到的块（首屏与动态加载）创建的 Worker：块的 assets 里的脚本。
 * 构建清单不描述 Worker 自己的块，Worker 引用的块另按它的原文找（workerClosure）
 */
export function entryWorkers(manifest: ViteManifest, entry: string): string[] {
  const chunks = chunksFrom(manifest, entry, true) ?? []
  return [...new Set(chunks.flatMap(chunk => (chunk.assets ?? []).filter(file => /\.m?js$/.test(file))))].sort()
}

/** Worker 里引用的块：静态导入，与 withDynamic 为真时的动态导入（Worker 按 ES 模块构建，引用写成相对地址） */
const STATIC_IMPORT = /\b(?:from|import)\s*["'`](\.{1,2}\/[^"'`]+\.js)["'`]/g
const DYNAMIC_IMPORT = /\bimport\(\s*["'`](\.{1,2}\/[^"'`]+\.js)["'`]\s*\)/g

/** Worker 的产物与它引用的块：首屏的体积按静态引用算；withDynamic 为真时连同动态加载的块（它能加载到的全部产物） */
export function workerClosure(worker: string, readText: (file: string) => string, withDynamic = false): string[] {
  const files = new Set<string>()
  const pending = [worker]
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (files.has(file))
      continue
    files.add(file)
    const text = readText(file)
    for (const pattern of withDynamic ? [STATIC_IMPORT, DYNAMIC_IMPORT] : [STATIC_IMPORT]) {
      for (const match of text.matchAll(pattern))
        pending.push(posix.join(posix.dirname(file), match[1] ?? ''))
    }
  }
  return [...files].sort()
}

/** 名字是 worker 的产物：assets/<名字>-<8 位哈希>.js（名字以 worker 开头的另一个 Worker 不算，复验 SA9） */
function isWorkerNamed(file: string, worker: string): boolean {
  return new RegExp(String.raw`^assets/${escapeRegExp(worker)}-[\w-]{8}\.js$`).test(file)
}

export interface BudgetResult {
  violations: Violation[]
  notes: string[]
}

export interface BuildOutput {
  /** 产物里的全部文件（相对产物目录） */
  files: readonly string[]
  /** 产物里某个文件 gzip 之后的字节数 */
  gzipSize: (file: string) => number
  /** 产物里某个文件的内容 */
  readText: (file: string) => string
}

/**
 * 产物里的每个脚本都要有归属：构建清单里的块、块以地址引用的产物（Worker），或者这些 Worker 能加载到的块。
 * 没有归属的脚本不计入任何预算，例如 Worker 里再创建的 Worker（构建清单不描述 Worker 的包，复验 SA5）
 */
function unattributedScripts(manifest: ViteManifest, output: BuildOutput): string[] {
  const chunks = Object.values(manifest)
  const workers = [...new Set(chunks.flatMap(chunk => (chunk.assets ?? []).filter(file => /\.m?js$/.test(file))))]
  const attributed = new Set([...chunks.map(chunk => chunk.file), ...workers.flatMap(worker => workerClosure(worker, output.readText, true))])
  return output.files.filter(file => /\.m?js$/.test(file) && !attributed.has(file))
}

function measure(label: string, subject: string, files: readonly string[], maxGzipBytes: number, output: BuildOutput): BudgetResult {
  const total = files.reduce((sum, file) => sum + output.gzipSize(file), 0)
  const summary = `${label}（${subject}）首屏 JS ${(total / 1024).toFixed(1)} KiB / 预算 ${(maxGzipBytes / 1024).toFixed(0)} KiB（gzip，${files.length} 个文件）`
  const violations: Violation[] = total > maxGzipBytes
    ? [{ rule: 'budgets/exceeded', subject, detail: `${summary}：超出预算。先看是否可以按路由拆分或换掉体积大的依赖；确需调整预算时，在 Phase 设计里写明原因` }]
    : []
  return { violations, notes: [summary] }
}

export function checkBudgets(manifest: ViteManifest, budgets: readonly EntryBudget[], workers: readonly WorkerBudget[], output: BuildOutput): BudgetResult {
  const results: BudgetResult[] = []
  for (const budget of budgets) {
    const files = initialFiles(manifest, budget.entry)
    results.push(files === undefined
      ? { violations: [{ rule: 'budgets/missing-entry', subject: budget.entry, detail: `构建清单里没有这个入口：${budget.label}的预算指向的入口不存在，更新预算表` }], notes: [] }
      : measure(budget.label, budget.entry, files, budget.maxGzipBytes, output))
  }
  // 构建清单里没有预算的入口：新增入口时要一起定下预算（复验 RA5）
  for (const [entry, chunk] of Object.entries(manifest)) {
    if (chunk.isEntry === true && !budgets.some(budget => budget.entry === entry))
      results.push({ violations: [{ rule: 'budgets/unbudgeted-entry', subject: entry, detail: '构建清单里的这个入口没有首屏体积的预算：在 ENTRY_BUDGETS 登记，写明实测与原因' }], notes: [] })
  }
  for (const budget of workers) {
    const found = entryWorkers(manifest, budget.entry).find(file => isWorkerNamed(file, budget.worker))
    results.push(found === undefined
      ? { violations: [{ rule: 'budgets/missing-worker', subject: budget.worker, detail: `${budget.entry} 能加载到的块没有创建 ${budget.worker}：${budget.label}的预算指向的 Worker 不存在，更新预算表` }], notes: [] }
      : measure(budget.label, budget.worker, workerClosure(found, output.readText), budget.maxGzipBytes, output))
  }
  // 入口能加载到的块创建的、却没有登记预算的 Worker：它同样要下载（审查 A 路建议 B2，复验 RA5：含 ?worker 的写法与动态加载的块）
  const entries = [...new Set([...budgets.map(budget => budget.entry), ...Object.keys(manifest).filter(entry => manifest[entry]?.isEntry === true)])]
  for (const entry of entries) {
    for (const worker of entryWorkers(manifest, entry).filter(file => !workers.some(item => item.entry === entry && isWorkerNamed(file, item.worker))))
      results.push({ violations: [{ rule: 'budgets/unbudgeted-worker', subject: worker, detail: `${entry} 能加载到的块创建了这个 Worker（或以地址引用的脚本），却没有登记它的预算（WORKER_BUDGETS）` }], notes: [] })
  }
  for (const script of unattributedScripts(manifest, output))
    results.push({ violations: [{ rule: 'budgets/unattributed-script', subject: script, detail: '产物里的这个脚本不属于构建清单里的任何块、块创建的 Worker 或 Worker 能加载到的块（例如 Worker 里再创建的 Worker），没有计入任何预算：确认来源，在 WORKER_BUDGETS 登记' }], notes: [] })
  return { violations: results.flatMap(result => result.violations), notes: results.flatMap(result => result.notes) }
}
