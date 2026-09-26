import type { AuditReport } from './pnpm-outputs.ts'
// 依赖漏洞（规范 §3，ADR-001）：生产依赖出现高危及以上的漏洞即失败；
// 例外要写明原因与到期日，到期或失效的例外同样失败，迫使重新评审。
// 清单与 metadata 的计数不一致时同样失败：pnpm 的 auditConfig 能把漏洞从清单里藏起来，metadata 却照样计数。
import type { AuditException } from './policy.ts'
import type { Violation } from './types.ts'

const BLOCKING = ['high', 'critical'] as const

/** today 是当天的日期（YYYY-MM-DD），用来判断例外是否到期。 */
export function checkAudit(report: AuditReport, exceptions: readonly AuditException[], today: string): Violation[] {
  const violations: Violation[] = []
  const advisories = Object.values(report.advisories)
  const blocking = advisories.filter(a => (BLOCKING as readonly string[]).includes(a.severity))
  for (const advisory of blocking) {
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
  const counted = BLOCKING.reduce((sum, level) => sum + (report.metadata.vulnerabilities[level] ?? 0), 0)
  if (counted > blocking.length)
    violations.push({ rule: 'audit/hidden', subject: 'pnpm audit', detail: `metadata 计有 ${counted} 个高危及以上的漏洞，清单里只有 ${blocking.length} 个，有漏洞被配置（例如 auditConfig）忽略了` })
  const present = new Set(advisories.map(a => a.github_advisory_id))
  for (const exception of exceptions) {
    if (!present.has(exception.id))
      violations.push({ rule: 'audit/exception-unused', subject: exception.id, detail: '对应的漏洞已经不存在，删除这条例外' })
  }
  return violations
}
