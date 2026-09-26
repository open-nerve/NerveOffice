// A01：pnpm 的供应链设置（规范 §3，00 号计划书 §3.3）。
// - 必须有的设置：发布冷却期、可信度策略、引擎严格；
// - 只允许经过评审的顶层设置：不少设置能削弱供应链策略（例如 dangerouslyAllowAllBuilds、
//   minimumReleaseAgeStrict: false、trustPolicyExclude、auditConfig），用允许清单拦下未评审的设置；
// - 逐项的决定与豁免（安装脚本、冷却期豁免、overrides、peer 规则、补丁）都要在上方用注释写明原因。
import type { Document, Node as YamlNode } from 'yaml'
import type { Violation } from './types.ts'
import { isMap, isScalar, isSeq, parseDocument } from 'yaml'

const FILE = 'pnpm-workspace.yaml'
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Z.-]+)?$/i

/** 评审过的顶层设置。新增一项要写明它不会削弱供应链策略，经代码审查。 */
export const REVIEWED_SETTINGS: ReadonlySet<string> = new Set([
  'packages',
  'catalog',
  'catalogs',
  'minimumReleaseAge',
  'minimumReleaseAgeExclude',
  'minimumReleaseAgeExcludePrune',
  'trustPolicy',
  'engineStrict',
  'allowBuilds',
  'overrides',
  'patchedDependencies',
  'peerDependencyRules',
  'shellEmulator',
])

export interface PnpmPolicy {
  minimumReleaseAgeMinutes: number
  trustPolicy: string
}

function hasText(comment: string | null | undefined): boolean {
  return comment !== null && comment !== undefined && comment.trim() !== ''
}

/** 集合里第一项的注释挂在集合上，其余各项挂在自己身上（yaml 的解析方式）。 */
function itemsWithoutReason(collection: unknown): string[] {
  const missing: string[] = []
  if (isMap(collection)) {
    collection.items.forEach((pair, index) => {
      const name = isScalar(pair.key) ? String(pair.key.value) : '?'
      const comment = index === 0 ? collection.commentBefore : (isScalar(pair.key) ? pair.key.commentBefore : undefined)
      if (!hasText(comment))
        missing.push(name)
    })
  }
  else if (isSeq(collection)) {
    collection.items.forEach((item, index) => {
      const name = isScalar(item) ? String(item.value) : '?'
      const comment = index === 0 ? collection.commentBefore : (isScalar(item) ? item.commentBefore : undefined)
      if (!hasText(comment))
        missing.push(name)
    })
  }
  return missing
}

function node(doc: Document, key: string): YamlNode | null | undefined {
  return doc.get(key, true) as YamlNode | null | undefined
}

function reasonViolations(collection: unknown, rule: string, label: string): Violation[] {
  return itemsWithoutReason(collection).map(name => ({ rule, subject: `${FILE} ${label} ${name}`, detail: '在这一项上方用注释写明原因' }))
}

export function checkPnpmConfig(text: string, policy: PnpmPolicy): Violation[] {
  const doc = parseDocument(text)
  if (doc.errors.length > 0)
    return [{ rule: 'pnpm-config/parse', subject: FILE, detail: doc.errors.map(e => e.message).join('；') }]

  const violations: Violation[] = []
  const root: unknown = doc.contents
  if (isMap(root)) {
    for (const pair of root.items) {
      const key = isScalar(pair.key) ? String(pair.key.value) : '?'
      if (!REVIEWED_SETTINGS.has(key))
        violations.push({ rule: 'pnpm-config/unreviewed-setting', subject: `${FILE} ${key}`, detail: '这项设置没有经过评审，可能削弱供应链策略；确需使用时，先在门禁的允许清单里登记原因' })
    }
  }

  const releaseAge: unknown = doc.get('minimumReleaseAge')
  if (typeof releaseAge !== 'number' || releaseAge < policy.minimumReleaseAgeMinutes) {
    violations.push({
      rule: 'pnpm-config/minimum-release-age',
      subject: FILE,
      detail: `minimumReleaseAge 必须是不少于 ${policy.minimumReleaseAgeMinutes} 的分钟数，现在是 ${JSON.stringify(releaseAge) ?? '（未设置）'}`,
    })
  }
  if (doc.get('trustPolicy') !== policy.trustPolicy)
    violations.push({ rule: 'pnpm-config/trust-policy', subject: FILE, detail: `trustPolicy 必须是 ${policy.trustPolicy}` })
  if (doc.get('engineStrict') !== true)
    violations.push({ rule: 'pnpm-config/engine-strict', subject: FILE, detail: 'engineStrict 必须是 true' })

  const allowBuilds = node(doc, 'allowBuilds')
  if (isMap(allowBuilds)) {
    for (const pair of allowBuilds.items) {
      if (typeof (isScalar(pair.value) ? pair.value.value : undefined) !== 'boolean') {
        const name = isScalar(pair.key) ? String(pair.key.value) : '?'
        violations.push({ rule: 'pnpm-config/allow-builds-decision', subject: `${FILE} allowBuilds.${name}`, detail: '必须明确写 true 或 false' })
      }
    }
  }
  violations.push(...reasonViolations(allowBuilds, 'pnpm-config/allow-builds-reason', 'allowBuilds'))
  violations.push(...reasonViolations(node(doc, 'minimumReleaseAgeExclude'), 'pnpm-config/release-age-exclude-reason', 'minimumReleaseAgeExclude'))

  const overrides = node(doc, 'overrides')
  if (isMap(overrides)) {
    for (const pair of overrides.items) {
      const value = isScalar(pair.value) ? String(pair.value.value) : ''
      if (value !== '-' && !EXACT_VERSION.test(value)) {
        const name = isScalar(pair.key) ? String(pair.key.value) : '?'
        violations.push({ rule: 'pnpm-config/override-version', subject: `${FILE} overrides.${name}`, detail: `必须是精确版本或 -（移除），现在是 ${value}` })
      }
    }
  }
  violations.push(...reasonViolations(overrides, 'pnpm-config/override-reason', 'overrides'))
  violations.push(...reasonViolations(node(doc, 'patchedDependencies'), 'pnpm-config/patch-reason', 'patchedDependencies'))

  const peerRules = node(doc, 'peerDependencyRules')
  if (isMap(peerRules)) {
    for (const pair of peerRules.items) {
      const kind = isScalar(pair.key) ? String(pair.key.value) : '?'
      violations.push(...reasonViolations(pair.value, 'pnpm-config/peer-rule-reason', `peerDependencyRules.${kind}`))
    }
  }
  return violations
}
