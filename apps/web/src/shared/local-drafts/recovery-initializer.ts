import type { DraftObservation } from '../outbox/draft-observation.ts'
import type { ObservedRemoveResult, ObserveResult } from '../outbox/draft-writer.ts'
import type { DraftCapture, DraftMemoryReason } from './working-draft.ts'

/** 只有本次登记产生的 existing 端口能提供持久采用资格；memory 由协调器的独立 Reader 处理。 */
export type RecoveryContext
  = | { readonly kind: 'empty', readonly highWater: number }
    | {
      readonly kind: 'existing'
      readonly highWater: number
      readonly observe: () => Promise<ObserveResult>
      readonly remove: (observation: DraftObservation) => Promise<ObservedRemoveResult>
      /** 不再采用时先关闭原宿主，释放 Worker 镜像句柄；调用后只能返回 blocked。 */
      readonly retire: () => void
    }
    | { readonly kind: 'memory', readonly highWater: number, readonly reason: DraftMemoryReason, readonly recordKnown?: true }

export type RecoveryBlockedReason = 'preserved' | 'changed' | 'refresh-cloud' | 'open-check' | 'formulas' | 'cancelled'

export type RecoveryInitialization
  = | { readonly kind: 'none' }
    /** 无法使用存储且没有已知待处理原件：只编辑云端内容，后续不自动恢复持久写入。 */
    | { readonly kind: 'memory', readonly reason: DraftMemoryReason }
    | { readonly kind: 'blocked', readonly reason: RecoveryBlockedReason }
    | {
      readonly kind: 'restore'
      /** 仅在打开自检及公式收齐后交入；适配器消费后不得留在 ready 结果或长期配置。 */
      readonly capture: Omit<DraftCapture, 'dedupe'>
      readonly baseRevision: number
      readonly highWater: number
      readonly recoveryObservation?: DraftObservation
      /** 仅用于未采用的内存退路，绑定原观察；不能携带正文或重新观察后套用旧确认。 */
      readonly onConfirmed?: () => Promise<void>
      /** 原文档的有效上传已获确认；持久和内存来源都通知，与条件清理资格分开。 */
      readonly onSaved?: () => void
      readonly dispose?: () => void
    }

export type RecoveryInitializer = (context: RecoveryContext) => Promise<RecoveryInitialization>
