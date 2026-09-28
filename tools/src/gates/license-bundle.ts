// A01：随构建产物分发的第三方许可清单（00 号计划书 §3.3）。
// 清单由 web 构建的插件（apps/web/build/third-party-licenses.ts）生成，覆盖主构建与 Worker 的产物；
// 这里检查：每个打进产物的第三方包都有许可正文（包自带或仓库补齐），许可在生产依赖的白名单里；
// 随产物分发的许可正文文件确实在产物里，与清单一一对应（Codex 评审 CX9：清单说收集过正文，不等于分发的文件还在）。
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

/** 随产物分发的许可正文（相对产物目录） */
export const LICENSE_TEXT_FILE = 'THIRD-PARTY-LICENSES.md'

/**
 * 许可正文里每个包一节，标题是"## 包名 版本（许可）"，下面是正文；包里没有许可文件、仓库也没补齐时正文是占位
 * （写法见 apps/web/build/third-party-licenses.ts 的 renderLicenses）。只有整行符合这个写法的才是标题：许可正文自己的 Markdown 标题不算
 */
const SECTION_HEADING = /^## (\S+) ([^\s（]+)（(.*)）$/
const MISSING_TEXT_PLACEHOLDER = '（缺少许可正文）'

interface LicenseSection {
  readonly license: string
  readonly body: string
}

/** 按标题切开许可正文：包名与版本 → 许可与正文 */
function licenseSections(text: string): Map<string, LicenseSection> {
  const sections = new Map<string, LicenseSection>()
  let current: { key: string, license: string, lines: string[] } | undefined
  const close = (): void => {
    if (current !== undefined)
      sections.set(current.key, { license: current.license, body: current.lines.join('\n').trim() })
  }
  for (const line of text.split('\n')) {
    const heading = SECTION_HEADING.exec(line.trimEnd())
    if (heading?.[1] !== undefined && heading[2] !== undefined && heading[3] !== undefined) {
      close()
      current = { key: `${heading[1]}@${heading[2]}`, license: heading[3], lines: [] }
    }
    else {
      current?.lines.push(line)
    }
  }
  close()
  return sections
}

/** 分发的许可正文文件在、不是空的（Codex 评审 CX9）。text 为 undefined 表示产物里没有这个文件 */
export function checkLicenseTextFile(text: string | undefined): Violation[] {
  if (text !== undefined && text.trim() !== '')
    return []
  return [{
    rule: 'license-bundle/missing-text-file',
    subject: LICENSE_TEXT_FILE,
    detail: text === undefined ? '产物里没有随部署分发的第三方许可正文：检查 web 构建的许可收集插件与构建之后的处理' : '随部署分发的第三方许可正文是空的',
  }]
}

/**
 * 分发的许可正文与清单核对（Codex 评审 CX9）：文件在、不是空的；清单里的每个包都有一节，许可一致，
 * 清单说有正文的那一节确实有正文；正文里没有清单之外的包（两份文件是同一次构建写出的）。
 * text 为 undefined 表示产物里没有这个文件。
 */
export function checkLicenseText(packages: BundledPackages, text: string | undefined): Violation[] {
  const fileProblems = checkLicenseTextFile(text)
  if (text === undefined || fileProblems.length > 0)
    return fileProblems
  const sections = licenseSections(text)
  const violations: Violation[] = []
  const mismatch = (subject: string, detail: string): void => {
    violations.push({ rule: 'license-bundle/text-mismatch', subject: `${LICENSE_TEXT_FILE} ${subject}`, detail })
  }
  for (const item of packages) {
    const subject = `${item.name}@${item.version}`
    const section = sections.get(subject)
    if (section === undefined)
      mismatch(subject, '清单里的这个包在许可正文里没有对应的一节')
    else if (section.license !== item.license)
      mismatch(subject, `许可正文里写的许可是 ${section.license}，清单里是 ${item.license}`)
    else if (item.licenseTextSource !== null && (section.body === '' || section.body === MISSING_TEXT_PLACEHOLDER))
      mismatch(subject, '清单说收集到了许可正文，分发的文件里这一节却没有正文')
  }
  const listed = new Set(packages.map(item => `${item.name}@${item.version}`))
  for (const key of sections.keys()) {
    if (!listed.has(key))
      mismatch(key, '许可正文里有清单之外的包：两份文件不是同一次构建写出的')
  }
  return violations
}
