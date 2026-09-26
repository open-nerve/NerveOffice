// 首屏 JS 的体积预算（规范 §11，P3 设计 §3.7）：按 Vite 的构建清单，入口块加上它静态引用的块（不含动态加载的块），
// 用 gzip（默认压缩级别）统计。每个入口的预算在建立它的 Phase 里定下；调整要在 Phase 设计里写明原因。
import type { Violation } from './types.ts'
import { z } from 'zod'

export interface EntryBudget {
  /** 构建清单里的键，例如 index.html */
  entry: string
  label: string
  maxGzipBytes: number
  reason: string
}

const chunkSchema = z.object({
  file: z.string(),
  imports: z.array(z.string()).optional(),
})

export const viteManifestSchema = z.record(z.string(), chunkSchema)
export type ViteManifest = z.infer<typeof viteManifestSchema>

/** 入口首屏要加载的 JS：入口块与它静态引用的块（递归），不含 dynamicImports。入口不在清单里时返回 undefined。 */
export function initialFiles(manifest: ViteManifest, entry: string): string[] | undefined {
  if (manifest[entry] === undefined)
    return undefined
  const files = new Set<string>()
  const pending = [entry]
  const visited = new Set<string>()
  while (pending.length > 0) {
    const key = pending.pop() ?? ''
    const chunk = manifest[key]
    if (chunk === undefined || visited.has(key))
      continue
    visited.add(key)
    files.add(chunk.file)
    pending.push(...(chunk.imports ?? []))
  }
  return [...files].sort()
}

export interface BudgetResult {
  violations: Violation[]
  notes: string[]
}

/** gzipSize：构建产物里某个文件 gzip 之后的字节数。 */
export function checkBudgets(manifest: ViteManifest, budgets: readonly EntryBudget[], gzipSize: (file: string) => number): BudgetResult {
  const violations: Violation[] = []
  const notes: string[] = []
  for (const budget of budgets) {
    const files = initialFiles(manifest, budget.entry)
    if (files === undefined) {
      violations.push({ rule: 'budgets/missing-entry', subject: budget.entry, detail: `构建清单里没有这个入口：${budget.label}的预算指向的入口不存在，更新预算表` })
      continue
    }
    const total = files.reduce((sum, file) => sum + gzipSize(file), 0)
    const summary = `${budget.label}（${budget.entry}）首屏 JS ${(total / 1024).toFixed(1)} KiB / 预算 ${(budget.maxGzipBytes / 1024).toFixed(0)} KiB（gzip，${files.length} 个文件）`
    notes.push(summary)
    if (total > budget.maxGzipBytes)
      violations.push({ rule: 'budgets/exceeded', subject: budget.entry, detail: `${summary}：超出预算。先看是否可以按路由拆分或换掉体积大的依赖；确需调整预算时，在 Phase 设计里写明原因` })
  }
  return { violations, notes }
}
