import type { StoredDraft } from '../../shared/outbox/draft-record.ts'
import type { LocalSaveIdentity } from './local-save-report.ts'

/** 已结束计时后的原件门槛；ACK 抢先清理、错身份或旧序号都不能借 UI 文案通过。 */
export function assertMeasuredDraft(draft: StoredDraft | undefined, expected: {
  readonly identity: LocalSaveIdentity
  readonly lastDraftSeq: number
  readonly baseRevision: number
  readonly wallStartedAt: number
  readonly readAt: number
}): asserts draft is StoredDraft {
  if (draft === undefined || Object.entries(expected.identity).some(([field, value]) => draft[field as keyof LocalSaveIdentity] !== value)
    || draft.draftSeq <= expected.lastDraftSeq || draft.baseRevision !== expected.baseRevision || draft.formulasPending
    || draft.updatedAt < expected.wallStartedAt || draft.updatedAt > expected.readAt) {
    throw new Error('缺少本轮完整真实草稿，或写入身份/序号/时刻不符')
  }
}
