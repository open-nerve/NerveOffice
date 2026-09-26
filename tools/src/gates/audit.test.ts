import type { AuditReport } from './pnpm-outputs.ts'
import { describe, expect, it } from 'vitest'
import { checkAudit } from './audit.ts'
import { readFixture } from './fixtures.ts'
import { auditReportSchema } from './pnpm-outputs.ts'

const empty: AuditReport = { advisories: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } } }

function report(severity: 'info' | 'low' | 'moderate' | 'high' | 'critical', id = 'GHSA-aaaa-bbbb-cccc'): AuditReport {
  return {
    advisories: {
      1: { github_advisory_id: id, module_name: 'pkg', severity, title: '示例漏洞', url: `https://github.com/advisories/${id}`, vulnerable_versions: '<1.2.3', patched_versions: '>=1.2.3' },
    },
    metadata: { vulnerabilities: { ...empty.metadata.vulnerabilities, [severity]: 1 } },
  }
}

describe('US-M1-11 A01 漏洞扫描', () => {
  it('合规：没有漏洞', () => {
    expect(checkAudit(empty, [], '2026-09-26')).toEqual([])
  })

  it('违规：真实输出里的 1 个严重、2 个高危漏洞', () => {
    const real = auditReportSchema.parse(readFixture('pnpm-12/audit-with-advisories.json'))
    expect(checkAudit(real, [], '2026-09-26').map(v => v.rule)).toEqual(['audit/advisory', 'audit/advisory', 'audit/advisory'])
  })

  it('违规：漏洞被 auditConfig 从清单里藏起来（真实输出：清单里没有，metadata 照样计数）', () => {
    const hidden = auditReportSchema.parse(readFixture('pnpm-12/audit-with-ignored-advisories.json'))
    expect(checkAudit(hidden, [], '2026-09-26').map(v => v.rule)).toEqual(['audit/hidden'])
  })

  it.each(['info', 'low', 'moderate'] as const)('合规：%s 级别只报告不拦截', (severity) => {
    expect(checkAudit(report(severity), [], '2026-09-26')).toEqual([])
  })

  it.each(['high', 'critical'] as const)('违规：%s 级别的漏洞', (severity) => {
    expect(checkAudit(report(severity), [], '2026-09-26').map(v => v.rule)).toEqual(['audit/advisory'])
  })

  it('合规：登记了例外且没有到期', () => {
    const exceptions = [{ id: 'GHSA-aaaa-bbbb-cccc', reason: '只在构建时使用', expires: '2026-10-31' }]
    expect(checkAudit(report('high'), exceptions, '2026-09-26')).toEqual([])
  })

  it('违规：例外已经到期', () => {
    const exceptions = [{ id: 'GHSA-aaaa-bbbb-cccc', reason: '只在构建时使用', expires: '2026-09-01' }]
    expect(checkAudit(report('high'), exceptions, '2026-09-26').map(v => v.rule)).toEqual(['audit/exception-expired'])
  })

  it('违规：例外对应的漏洞已经不存在，需要清理', () => {
    const exceptions = [{ id: 'GHSA-zzzz-zzzz-zzzz', reason: '旧的例外', expires: '2026-12-31' }]
    expect(checkAudit(empty, exceptions, '2026-09-26').map(v => v.rule)).toEqual(['audit/exception-unused'])
  })
})
