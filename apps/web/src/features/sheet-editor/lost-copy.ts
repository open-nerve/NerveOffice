// 副本接收失效会话的唯一内容来源；原保存已结束上传所有权后才移交。
// 固定请求和 gzip 由同一个 pin 提供；未知结果原样重放，成功或确定拒绝才释放。正文不在本模块另存。
import type { ConflictCopyQuery, CreatedDocument } from '@nerve-office/contracts'
import type { ContentFormat } from '../../shared/outbox/draft-record.ts'
import type { DraftCaptureRef, DraftFailure, PreparedDraft, WorkingDraft } from './working-draft.ts'
import { conflictCopyTitle } from '@nerve-office/contracts'
import { isDefiniteRejection } from '../../shared/api/index.ts'

/** 另存为副本的标题里的时间：页面所在的时区，写到分钟，例如"2026-10-04 15:30" */
export function conflictCopyLabel(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

export interface LostCopyOptions {
  readonly documentId: string
  /** 接收唯一所有权，dispose 时销毁来源；不得与原保存协调器同时持有上传。 */
  readonly draft: WorkingDraft
  readonly ref: DraftCaptureRef
  /** 失去编辑权的时刻（墙上时间）：副本的标题里的时间用它，不用点"另存为副本"的时刻 */
  readonly lostAt: Date
  /** 原文档现在的标题：副本的标题以它开头 */
  readonly title: () => string
  readonly newId: () => string
  /** 另存为副本的请求（M3-P2 设计 §3.2） */
  readonly conflictCopy: (documentId: string, query: ConflictCopyRequest, body: Uint8Array<ArrayBuffer>) => Promise<CreatedDocument>
}

export interface ConflictCopyRequest extends ConflictCopyQuery {
  readonly format: ContentFormat
}

export interface LostCopy {
  /** 上传快照、新建一份文档，交回它；失败时抛出那次的错误（内容留着，可以再试） */
  readonly save: () => Promise<CreatedDocument>
  readonly dispose: () => void
}

export function createLostCopy(options: LostCopyOptions): LostCopy {
  const { draft } = options
  let ref = options.ref
  let retryCapture = false
  let query: ConflictCopyRequest | undefined
  let owned: PreparedDraft | undefined
  let running: Promise<CreatedDocument> | undefined
  let disposed = false

  const inactive = (): Error => Object.assign(new Error('副本流程已结束'), { name: 'LostCopyDisposed' })
  function failure(result: DraftFailure): Error {
    return result.kind === 'failed'
      ? Object.assign(new Error(result.error.message), { name: result.error.name })
      : Object.assign(new Error('副本的内容引用已失效'), { name: result.kind === 'disposed' ? 'LostCopyDisposed' : 'DraftSuperseded' })
  }

  /** 编码失败的引用不可变；显式再试从来源临时读回并分配新引用，不另留 JSON。 */
  async function recapture(): Promise<DraftCaptureRef> {
    const content = await draft.readLatest()
    if (disposed)
      throw inactive()
    if (content.kind !== 'snapshot' || content.ref !== ref)
      throw new Error('无法从原来源重新取得副本内容')
    return draft.capture({ editorSeq: ref.editorSeq, snapshot: content.snapshot, formulasPending: ref.formulasPending, dedupe: false })
  }

  async function prepare(): Promise<PreparedDraft> {
    if (retryCapture) {
      ref = await recapture()
      retryCapture = false
    }
    const result = await draft.prepare(ref)
    if (disposed) {
      if (result.kind === 'prepared')
        draft.release(result)
      throw inactive()
    }
    if (result.kind !== 'prepared') {
      const view = draft.view()
      retryCapture = view.kind === 'working' && view.ref === ref && view.summary?.kind === 'failed'
      throw failure(result)
    }
    return result
  }

  function release(): void {
    const upload = owned
    owned = undefined
    query = undefined
    if (upload !== undefined)
      draft.release(upload)
  }

  async function send(): Promise<CreatedDocument> {
    const upload = owned ?? await prepare()
    if (disposed)
      throw inactive()
    owned = upload
    const sending = query ?? Object.freeze({ requestId: options.newId(), title: conflictCopyTitle(options.title(), conflictCopyLabel(options.lostAt)), formulasPending: upload.formulasPending, format: upload.format })
    if (disposed)
      throw inactive()
    query = sending
    try {
      const created = await options.conflictCopy(options.documentId, sending, upload.gzip)
      release()
      // 新文档的 revision 不确认到原文档，原持久记录保留给后续恢复/清理流程。
      return created
    }
    catch (error) {
      if (isDefiniteRejection(error))
        release()
      throw error
    }
  }

  return {
    save: async () => {
      if (disposed)
        return Promise.reject(inactive())
      running ??= send().finally(() => {
        running = undefined
      })
      return running
    },
    dispose: () => {
      if (disposed)
        return
      disposed = true
      release()
      draft.dispose()
    },
  }
}
