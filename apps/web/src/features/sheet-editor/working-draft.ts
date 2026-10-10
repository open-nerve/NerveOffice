import type { MirrorStatus } from '../../shared/outbox/draft-mirror.ts'
import type { ContentFormat, InFlightSave } from '../../shared/outbox/draft-record.ts'
import type { ConfirmResult, ResealResult, WriterProblem } from '../../shared/outbox/draft-writer.ts'
import type { FailureDescription } from '../../shared/outbox/failure.ts'

/** 内存仍可供上传，但不能声称已持久保存；来源与页面共用这些事实，具体问题由准备/写入结果保留。 */
export type DraftMemoryReason = 'disabled' | 'unsupported' | 'existing-draft' | 'no-key' | 'quota' | 'unavailable' | 'fenced' | 'worker-failed' | 'paused'

/** 只传引用，不把快照或密钥散给保存调度、页头或订阅者。对象身份属于创建它的来源，复制字段不构成有效引用。 */
export interface DraftCaptureRef {
  readonly sessionId: string
  readonly serial: number
  readonly draftSeq: number
  readonly editorSeq: number
  readonly bytes: number
  readonly formulasPending: boolean
}

export interface DraftCapture {
  readonly editorSeq: number
  readonly snapshot: string
  readonly formulasPending: boolean
  readonly dedupe: boolean
}

export type DraftLocalFact
  = | { readonly kind: 'writing' }
    | { readonly kind: 'persisted', readonly mirror: MirrorStatus }
    | { readonly kind: 'memory', readonly reason: DraftMemoryReason, readonly problem?: WriterProblem }
    /** 云端已确认且本机记录已删除；当前内容仍归来源或固定上传持有，不冒充本机仍有记录。 */
    | { readonly kind: 'confirmed', readonly revision: number }

export interface DraftSummary {
  readonly kind: 'ready'
  readonly ref: DraftCaptureRef
  /** 实际字节对应的内容序号；持久去重时可能小于本次分配的 ref.draftSeq。 */
  readonly contentSeq: number
  readonly digest: string | undefined
  readonly baseRevision: number
  readonly format: ContentFormat
  readonly local: DraftLocalFact
  readonly confirmedRevision: number | undefined
}

export type DraftFailure
  = | { readonly kind: 'superseded' | 'disposed', readonly ref: DraftCaptureRef }
    | { readonly kind: 'failed', readonly ref: DraftCaptureRef, readonly error: FailureDescription }

export type DraftReady = DraftSummary | DraftFailure

/** prepare 同步保留目标，再异步准备；gzip 只供上传者读取，不能转移、修改或用于别的引用。release 后不能再调用 mark/confirm。 */
export interface PreparedDraft {
  readonly kind: 'prepared'
  readonly ref: DraftCaptureRef
  readonly contentSeq: number
  readonly gzip: Uint8Array<ArrayBuffer>
  readonly digest: string | undefined
  readonly baseRevision: number
  readonly format: ContentFormat
  readonly formulasPending: boolean
}

export type DraftPreparation = PreparedDraft | DraftFailure
export type DraftMutation = ResealResult | ConfirmResult | { readonly kind: 'memory', readonly reason: DraftMemoryReason }
export type DraftReadLatest
  = | { readonly kind: 'snapshot', readonly ref: DraftCaptureRef, readonly snapshot: string }
    | { readonly kind: 'empty' | 'disposed' }
    | DraftFailure

export type WorkingDraftView
  = | { readonly kind: 'empty' | 'disposed' }
    | { readonly kind: 'working', readonly ref: DraftCaptureRef, readonly local: DraftLocalFact, readonly summary: DraftReady | undefined }

export interface WorkingDraft {
  /** 同步编码、分配序号；销毁或序号越界时抛出，不返回半有效引用。 */
  readonly capture: (capture: DraftCapture) => DraftCaptureRef
  readonly ready: (ref: DraftCaptureRef) => Promise<DraftReady>
  readonly prepare: (ref: DraftCaptureRef) => Promise<DraftPreparation>
  /** 结束这个上传并放开正文；未知结果须继续保留，不调用 release。对应在途标记随下次真实落盘清除。 */
  readonly release: (prepared: PreparedDraft) => void
  readonly markInFlight: (prepared: PreparedDraft, inFlight: InFlightSave) => Promise<DraftMutation>
  readonly confirm: (prepared: PreparedDraft, revision: number) => Promise<DraftMutation>
  readonly readLatest: () => Promise<DraftReadLatest>
  readonly view: () => WorkingDraftView
  readonly subscribe: (listener: () => void) => () => void
  readonly dispose: () => void
}

export interface WorkingDraftOptions {
  readonly sessionId: string
  readonly initialDraftSeq: number
  readonly baseRevision: number
  readonly format: ContentFormat
  readonly writtenBy: string
  readonly reportError: (error: unknown) => void
}
