// A01：随构建产物分发的第三方许可清单（00 号计划书 §3.3）。
// Vite 的 build.license 生成 .vite/license.md；有的包的发布包里没有许可文件，清单里就没有正文，由仓库补齐。
import type { Violation } from './types.ts'
import { satisfies } from './licenses.ts'

export interface LicenseSection {
  name: string
  version: string
  license: string
  hasText: boolean
}

const HEADING = /^## (.+) - ([^ ]+) \((.*)\)$/

export function parseLicenseMarkdown(markdown: string): LicenseSection[] {
  const sections: LicenseSection[] = []
  for (const line of markdown.split('\n')) {
    const match = HEADING.exec(line.trim())
    const current = sections.at(-1)
    if (match !== null)
      sections.push({ name: match[1] ?? '', version: match[2] ?? '', license: match[3] ?? '', hasText: false })
    else if (current !== undefined && line.trim() !== '')
      current.hasText = true
  }
  return sections
}

/** supplements 是仓库补齐了许可正文的包名；allowed 是生产依赖允许的许可。 */
export function checkLicenseBundle(sections: readonly LicenseSection[], supplements: ReadonlySet<string>, allowed: readonly string[]): Violation[] {
  if (sections.length === 0)
    return [{ rule: 'license-bundle/empty', subject: '.vite/license.md', detail: '第三方许可清单是空的，检查构建是否开启了 build.license' }]
  const violations: Violation[] = []
  for (const section of sections) {
    const subject = `${section.name}@${section.version}`
    if (!section.hasText && !supplements.has(section.name))
      violations.push({ rule: 'license-bundle/missing-text', subject, detail: '发布包里没有许可文件；把许可正文补进仓库的第三方许可目录' })
    if (!satisfies(section.license, id => allowed.includes(id)))
      violations.push({ rule: 'license-bundle/license', subject, detail: `打进产物的包的许可 ${section.license} 不在生产依赖的白名单里` })
  }
  return violations
}
