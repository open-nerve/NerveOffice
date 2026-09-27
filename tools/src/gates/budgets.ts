// 首屏 JS 的体积预算（规范 §11，P3 设计 §3.7，P4 设计 §3.9）：按 Vite 的构建清单，入口块加上它静态引用的块（不含动态加载的块），
// 用 gzip（默认压缩级别）统计。入口在启动时就创建的 Worker 另列一项：Worker 脚本在页面加载时就下载，事实上属于首屏的传输量。
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

/** 入口引用的 Worker：构建清单里没有 Worker，按入口的首屏块里写着的 Worker 地址找到产物。 */
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
  imports: z.array(z.string()).optional(),
  dynamicImports: z.array(z.string()).optional(),
  css: z.array(z.string()).optional(),
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

/** 入口首屏的样式文件。入口不在清单里时返回空的清单。 */
export function initialStyles(manifest: ViteManifest, entry: string): string[] {
  return [...new Set((initialChunks(manifest, entry) ?? []).flatMap(chunk => chunk.css ?? []))].sort()
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Worker 里静态引用的块：import … from "./x.js"、import "./x.js"（Worker 按 ES 模块构建） */
const STATIC_IMPORT = /\b(?:from|import)\s*["'`](\.{1,2}\/[^"'`]+\.js)["'`]/g

/** 创建 Worker 的写法：new Worker(new URL("/assets/<名字>-<哈希>.js", import.meta.url))，SharedWorker 同样 */
const WORKER_REFERENCE = /\bnew\s+(?:Shared)?Worker\(\s*new\s+URL\(\s*["'`]\/?(assets\/[^"'`]+?\.js)["'`]/g

/** 这些文件里创建的 Worker 的产物（去重，按名字排序） */
export function referencedWorkers(files: readonly string[], readText: (file: string) => string): string[] {
  return [...new Set(files.flatMap(file => [...readText(file).matchAll(WORKER_REFERENCE)].map(match => match[1] ?? '')))].sort()
}

/** Worker 的产物与它静态引用的块 */
export function workerClosure(worker: string, readText: (file: string) => string): string[] {
  const files = new Set<string>()
  const pending = [worker]
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (files.has(file))
      continue
    files.add(file)
    for (const match of readText(file).matchAll(STATIC_IMPORT))
      pending.push(posix.join(posix.dirname(file), match[1] ?? ''))
  }
  return [...files].sort()
}

function isWorkerNamed(file: string, worker: string): boolean {
  return new RegExp(String.raw`^assets/${escapeRegExp(worker)}-[\w-]+\.js$`).test(file)
}

/**
 * 入口的首屏块里创建的、名字是 worker 的 Worker 的产物与它静态引用的块。
 * 首屏块里没有创建这个 Worker 时返回 undefined。
 */
export function workerFiles(entryFiles: readonly string[], worker: string, readText: (file: string) => string): string[] | undefined {
  const found = referencedWorkers(entryFiles, readText).find(file => isWorkerNamed(file, worker))
  return found === undefined ? undefined : workerClosure(found, readText)
}

export interface BudgetResult {
  violations: Violation[]
  notes: string[]
}

export interface BuildOutput {
  /** 产物里某个文件 gzip 之后的字节数 */
  gzipSize: (file: string) => number
  /** 产物里某个文件的内容 */
  readText: (file: string) => string
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
  for (const budget of workers) {
    const entryFiles = initialFiles(manifest, budget.entry) ?? []
    const files = workerFiles(entryFiles, budget.worker, output.readText)
    results.push(files === undefined
      ? { violations: [{ rule: 'budgets/missing-worker', subject: budget.worker, detail: `${budget.entry} 的首屏块里没有引用 ${budget.worker}：${budget.label}的预算指向的 Worker 不存在，更新预算表` }], notes: [] }
      : measure(budget.label, budget.worker, files, budget.maxGzipBytes, output))
  }
  // 入口在首屏创建、却没有登记预算的 Worker：它随页面下载，同样要有预算（审查 A 路建议 B2）
  for (const budget of budgets) {
    const created = referencedWorkers(initialFiles(manifest, budget.entry) ?? [], output.readText)
    for (const worker of created.filter(file => !workers.some(item => item.entry === budget.entry && isWorkerNamed(file, item.worker)))) {
      results.push({ violations: [{ rule: 'budgets/unbudgeted-worker', subject: worker, detail: `${budget.entry} 的首屏块里创建了这个 Worker，却没有登记它的预算（WORKER_BUDGETS）` }], notes: [] })
    }
  }
  return { violations: results.flatMap(result => result.violations), notes: results.flatMap(result => result.notes) }
}
