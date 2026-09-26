// A01：pnpm 的供应链设置（规范 §3，00 号计划书 §3.3）。
// 安装脚本与发布冷却期的豁免逐项决定，并在 pnpm-workspace.yaml 里用注释写明原因。
import type { Document, Node as YamlNode } from 'yaml'
import type { Violation } from './types.ts'
import { isMap, isScalar, isSeq, parseDocument } from 'yaml'

const FILE = 'pnpm-workspace.yaml'

export interface PnpmPolicy {
  minimumReleaseAgeMinutes: number
  trustPolicy: string
}

function hasText(comment: string | null | undefined): boolean {
  return comment !== null && comment !== undefined && comment.trim() !== ''
}

/** 集合里第一项的注释挂在集合上，其余各项挂在自己身上（yaml 的解析方式）。 */
function itemsWithoutReason(doc: Document, key: string): string[] {
  const collection: YamlNode | null | undefined = doc.get(key, true) as YamlNode | null | undefined
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

export function checkPnpmConfig(text: string, policy: PnpmPolicy): Violation[] {
  const doc = parseDocument(text)
  if (doc.errors.length > 0)
    return [{ rule: 'pnpm-config/parse', subject: FILE, detail: doc.errors.map(e => e.message).join('；') }]

  const violations: Violation[] = []
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

  const allowBuilds: unknown = doc.get('allowBuilds', true)
  if (isMap(allowBuilds)) {
    for (const pair of allowBuilds.items) {
      const value = isScalar(pair.value) ? pair.value.value : undefined
      if (typeof value !== 'boolean') {
        const name = isScalar(pair.key) ? String(pair.key.value) : '?'
        violations.push({ rule: 'pnpm-config/allow-builds-decision', subject: `${FILE} allowBuilds.${name}`, detail: '必须明确写 true 或 false' })
      }
    }
  }
  for (const name of itemsWithoutReason(doc, 'allowBuilds'))
    violations.push({ rule: 'pnpm-config/allow-builds-reason', subject: `${FILE} allowBuilds.${name}`, detail: '在这一项上方用注释写明原因' })
  for (const name of itemsWithoutReason(doc, 'minimumReleaseAgeExclude'))
    violations.push({ rule: 'pnpm-config/release-age-exclude-reason', subject: `${FILE} minimumReleaseAgeExclude ${name}`, detail: '在这一项上方用注释写明原因' })
  return violations
}
