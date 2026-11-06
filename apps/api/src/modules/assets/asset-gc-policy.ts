import type { AppConfig } from '../config/index.ts'

export type AssetGcSettings = Pick<AppConfig['jobs']['assetGc'], 'enabled' | 'graceDays' | 'backupRetentionDays' | 'recoveryBefore'>
export type AssetGcPause = 'disabled' | 'backup-retention-missing' | 'recovery-boundary-missing' | 'recovery-boundary-future' | 'recovery-boundary-too-new'
export type AssetGcPolicy = { readonly state: AssetGcPause } | { readonly state: 'ready', readonly graceBefore: number, readonly recoveryBefore: number }
const DAY = 86_400_000

function finiteTime(value: Date): number {
  const time = value.getTime()
  if (!Number.isFinite(time))
    throw new Error('资源回收需要有限的数据库时刻')
  return time
}

/** 输入配置已在启动时严格校验；这里用锁后的数据库时刻核对会随时间变化的条件。 */
export function assetGcPolicy(settings: AssetGcSettings, now: Date): AssetGcPolicy {
  const time = finiteTime(now)
  if (!settings.enabled)
    return { state: 'disabled' }
  if (settings.backupRetentionDays === undefined)
    return { state: 'backup-retention-missing' }
  if (settings.recoveryBefore === undefined)
    return { state: 'recovery-boundary-missing' }
  const recoveryBefore = finiteTime(new Date(settings.recoveryBefore))
  if (recoveryBefore > time)
    return { state: 'recovery-boundary-future' }
  if (recoveryBefore > time - settings.backupRetentionDays * DAY)
    return { state: 'recovery-boundary-too-new' }
  return { state: 'ready', graceBefore: time - settings.graceDays * DAY, recoveryBefore }
}

export function canRetire(since: Date, policy: AssetGcPolicy): boolean {
  const time = finiteTime(since)
  return policy.state === 'ready' && time <= policy.graceBefore && time < policy.recoveryBefore
}

/**
 * 宽限已满、只因候选时刻不早于恢复水位而不能回收（M5R-M-03，D-05）：水位不随备份轮换推进时，这类资源会一直累积，
 * 每轮按资源、对象与文件任务分别计数并告警，提醒运维推进 NERVE_ASSET_GC_RECOVERY_BEFORE
 */
export function blockedByRecovery(since: Date, policy: AssetGcPolicy): boolean {
  const time = finiteTime(since)
  return policy.state === 'ready' && time <= policy.graceBefore && time >= policy.recoveryBefore
}
