// pnpm 12 的 JSON 输出（ls、licenses list、audit）的结构校验：外部数据先校验再使用（规范 §2.1）。
// 只声明门禁用到的字段，其他字段放行；真实输出的样例在 tools/fixtures/pnpm-12/。
import { z } from 'zod'

export interface LsNode {
  from?: string | undefined
  version: string
  path: string
  deduped?: boolean | undefined
  dependencies?: Record<string, LsNode> | undefined
}

const lsNodeSchema: z.ZodType<LsNode> = z.object({
  from: z.string().optional(),
  version: z.string(),
  path: z.string(),
  // pnpm 在同一次输出里已经展开过的子树，再次出现时只输出占位（deduped: true，不带子树）
  deduped: z.boolean().optional(),
  get dependencies() {
    return z.record(z.string(), lsNodeSchema).optional()
  },
})

const dependencyMap = z.record(z.string(), lsNodeSchema).optional()

/** `pnpm ls --json`：每个工作区项目一项。可选依赖在项目这一层单独放在 optionalDependencies 里。 */
export const lsOutputSchema = z.array(z.object({
  name: z.string(),
  path: z.string(),
  dependencies: dependencyMap,
  optionalDependencies: dependencyMap,
  devDependencies: dependencyMap,
}))

export type LsProject = z.infer<typeof lsOutputSchema>[number]

/** `pnpm licenses list --json`：许可 → 包列表；paths 是各个安装实例的路径。 */
export const licenseReportSchema = z.record(z.string(), z.array(z.object({
  name: z.string(),
  versions: z.array(z.string()),
  paths: z.array(z.string()),
  license: z.string(),
})))

export type LicenseReport = z.infer<typeof licenseReportSchema>
export type LicenseEntry = LicenseReport[string][number]

const severitySchema = z.enum(['info', 'low', 'moderate', 'high', 'critical'])

/** `pnpm audit --json`。metadata 里的计数不受 auditConfig 的忽略设置影响，用来核对清单是否完整。 */
export const auditReportSchema = z.object({
  advisories: z.record(z.string(), z.object({
    github_advisory_id: z.string(),
    module_name: z.string(),
    severity: severitySchema,
    title: z.string(),
    url: z.string(),
    vulnerable_versions: z.string(),
    patched_versions: z.string(),
  })),
  metadata: z.object({
    vulnerabilities: z.record(severitySchema, z.number()),
  }),
})

export type AuditReport = z.infer<typeof auditReportSchema>
