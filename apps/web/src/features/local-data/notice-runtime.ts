import type { DraftMaintenanceView } from '../../shared/local-drafts/draft-maintenance.ts'
import { localDataMessages as text } from '../../shared/i18n/zh-cn/local-data.ts'
import { mountBrowserMaintenance } from '../../shared/local-drafts/browser-maintenance.ts'

export function maintenanceMessage(state: DraftMaintenanceView): string | undefined {
  if (state.cleanup === 'pending' || state.retention === 'pending')
    return text.maintenancePending
  if (state.cleanup === 'failed' || state.retention === 'failed' || state.problem !== undefined || state.catalog?.problem !== undefined || state.catalog?.incomplete)
    return text.maintenanceFailed
  const rows = state.catalog?.rows ?? []
  if (rows.some(row => row.recovery?.notice?.kind === 'expired'))
    return text.maintenanceExpired
  if (state.completed.length > 0)
    return state.completed.map(reason => reason === 'confirmed' ? text.maintenanceConfirmed : text.maintenanceRemoved[reason]).join('；')
  if (rows.some(row => row.recovery?.notice !== undefined || row.recovery?.stage === 'finished'))
    return text.maintenanceChanged
  return undefined
}

/** 完整状态解释、文案与存储协调均按需下载；首屏只有通用渲染壳。 */
export function mountNoticeRuntime() {
  return { ...mountBrowserMaintenance(), text, describe: maintenanceMessage }
}
export type NoticeRuntime = ReturnType<typeof mountNoticeRuntime>
