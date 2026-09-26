// A01：随构建产物分发的第三方许可清单（00 号计划书 §3.3）。
// 清单由 web 构建的插件（apps/web/build/third-party-licenses.ts）生成，覆盖主构建与 Worker 的产物；
// 这里检查：每个打进产物的第三方包都有许可正文（包自带或仓库补齐），许可在生产依赖的白名单里。
import type { LicenseException } from './policy.ts'
import type { Violation } from './types.ts'
import { z } from 'zod'
import { isAllowedIn, satisfies } from './licenses.ts'

export const bundledPackagesSchema = z.array(z.object({
  name: z.string(),
  version: z.string(),
  license: z.string(),
  licenseTextSource: z.enum(['package', 'supplement']).nullable(),
}))

export type BundledPackages = z.infer<typeof bundledPackagesSchema>

export function checkLicenseBundle(packages: BundledPackages, allowed: readonly string[], exceptions: readonly LicenseException[]): Violation[] {
  if (packages.length === 0)
    return [{ rule: 'license-bundle/empty', subject: '.vite/third-party-packages.json', detail: '第三方许可清单是空的，检查 web 构建是否挂上了许可收集插件' }]
  const isAllowed = isAllowedIn(allowed)
  const violations: Violation[] = []
  for (const item of packages) {
    const subject = `${item.name}@${item.version}`
    if (item.licenseTextSource === null)
      violations.push({ rule: 'license-bundle/missing-text', subject, detail: '发布包里没有许可文件；把许可正文补进 apps/web/third-party-licenses/<包名>/LICENSE' })
    const excepted = exceptions.some(e => e.name === item.name && e.license.toUpperCase() === item.license.toUpperCase())
    if (!satisfies(item.license, isAllowed) && !excepted)
      violations.push({ rule: 'license-bundle/license', subject, detail: `打进产物的包的许可 ${item.license} 不在生产依赖的白名单里` })
  }
  return violations
}
