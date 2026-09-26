// 依赖漏洞（规范 §3，ADR-001）：生产依赖出现高危及以上的漏洞即失败；
// 例外要写明原因与到期日，到期或失效的例外同样失败，迫使重新评审。
import type { AuditException } from './policy.ts'
import type { Violation } from './types.ts'

export interface Advisory {
  github_advisory_id: string
  module_name: string
  severity: string
  title: string
  url: string
  vulnerable_versions: string
  patched_versions: string
}

/** `pnpm audit --json` 的输出。 */
export interface AuditReport {
  advisories: Record<string, Advisory>
}

const BLOCKING = new Set(['high', 'critical'])

/** today 是当天的日期（YYYY-MM-DD），用来判断例外是否到期。 */
export function checkAudit(report: AuditReport, exceptions: readonly AuditException[], today: string): Violation[] {
  const violations: Violation[] = []
  const advisories = Object.values(report.advisories)
  for (const advisory of advisories) {
    if (!BLOCKING.has(advisory.severity))
      continue
    const subject = `${advisory.module_name} ${advisory.github_advisory_id}`
    const exception = exceptions.find(e => e.id === advisory.github_advisory_id)
    if (exception === undefined) {
      violations.push({
        rule: 'audit/advisory',
        subject,
        detail: `${advisory.severity}：${advisory.title}（受影响 ${advisory.vulnerable_versions}，修复于 ${advisory.patched_versions}）${advisory.url}`,
      })
    }
    else if (exception.expires < today) {
      violations.push({ rule: 'audit/exception-expired', subject, detail: `例外已于 ${exception.expires} 到期，需要重新评审` })
    }
  }
  const present = new Set(advisories.map(a => a.github_advisory_id))
  for (const exception of exceptions) {
    if (!present.has(exception.id))
      violations.push({ rule: 'audit/exception-unused', subject: exception.id, detail: '对应的漏洞已经不存在，删除这条例外' })
  }
  return violations
}
