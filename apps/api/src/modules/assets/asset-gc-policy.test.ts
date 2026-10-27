import type { AssetGcSettings } from './asset-gc-policy.ts'
import { describe, expect, it } from 'vitest'
import { assetGcPolicy, canRetire } from './asset-gc-policy.ts'

const DAY = 86_400_000
const NOW = new Date('2026-12-01T12:34:56.789Z')
const BEFORE = new Date(NOW.getTime() - 30 * DAY)
const READY: AssetGcSettings = { enabled: true, graceDays: 30, backupRetentionDays: 30, recoveryBefore: BEFORE.toISOString() }

describe('资源回收的备份保护政策', () => {
  it.each([
    [{ ...READY, enabled: false }, 'disabled'],
    [{ ...READY, backupRetentionDays: undefined }, 'backup-retention-missing'],
    [{ ...READY, recoveryBefore: undefined }, 'recovery-boundary-missing'],
    [{ ...READY, recoveryBefore: new Date(NOW.getTime() + 1).toISOString() }, 'recovery-boundary-future'],
    [{ ...READY, recoveryBefore: new Date(BEFORE.getTime() + 1).toISOString() }, 'recovery-boundary-too-new'],
  ] as const)('声明不足或不成立时只整理元数据：%j', (settings, state) => {
    const policy = assetGcPolicy(settings, NOW)
    expect(policy.state).toBe(state)
    expect(canRetire(new Date(0), policy)).toBe(false)
  })

  it('水位不晚于保留期边界才有效；候选恰好等于水位仍保留，早一毫秒才放行', () => {
    const policy = assetGcPolicy(READY, NOW)
    expect(policy.state).toBe('ready')
    expect(canRetire(BEFORE, policy)).toBe(false)
    expect(canRetire(new Date(BEFORE.getTime() - 1), policy)).toBe(true)
    expect(canRetire(new Date(BEFORE.getTime() + 1), policy)).toBe(false)
  })

  it('水位通过后仍等满独立宽限，截止点可删、晚一毫秒不删', () => {
    const policy = assetGcPolicy({ ...READY, graceDays: 31 }, NOW)
    const cutoff = new Date(NOW.getTime() - 31 * DAY)
    expect(canRetire(cutoff, policy)).toBe(true)
    expect(canRetire(new Date(cutoff.getTime() + 1), policy)).toBe(false)
  })

  it('使用当次数据库时刻，不能沿用调度开始时已通过的备份结论', () => {
    expect(assetGcPolicy(READY, NOW).state).toBe('ready')
    expect(assetGcPolicy(READY, new Date(NOW.getTime() - 1)).state).toBe('recovery-boundary-too-new')
    expect(assetGcPolicy({ ...READY, backupRetentionDays: 31, graceDays: 31 }, NOW).state).toBe('recovery-boundary-too-new')
  })

  it('非法内部时刻直接拒绝，不能绕过有限日期与完整宽限', () => {
    expect(() => assetGcPolicy(READY, new Date(Number.NaN))).toThrow()
    expect(() => canRetire(new Date(Number.NaN), assetGcPolicy(READY, NOW))).toThrow()
  })
})
