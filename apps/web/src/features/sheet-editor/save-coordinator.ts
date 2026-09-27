// 保存的状态机（P4 设计 §3.7.2）：输入是用户的保存、编辑器的修改与接口的结果，不依赖 Univer 与界面，用假的编辑器与假的接口做单元测试。
import type { RevisionConflictDetails, SaveContentResponse } from '@nerve-office/contracts'
import { revisionConflictDetailsSchema, SNAPSHOT_MAX_RAW_BYTES } from '@nerve-office/contracts'
import { ApiError, isAuthenticationError, isCsrfTokenError } from '../../shared/api/index.ts'

/** 保存用到的编辑器能力（SheetEditor 的子集）。 */
export interface SaveEditor {
  readonly changeSeq: () => number
  readonly onChange: (listener: () => void) => () => void
  readonly isCellEditing: () => boolean
  readonly commitCellEditing: () => Promise<boolean>
  readonly settleFormulas: (timeoutMs: number) => Promise<'settled' | 'timeout'>
  readonly capture: () => string
}

export interface SaveRequest {
  readonly baseRevision: number
  readonly requestId: string
  readonly clientInstanceId: string
  /** 捕获时本页的修改序号 */
  readonly localSeq: number
  /** 捕获的快照 JSON 文本 */
  readonly snapshot: string
}

/** 压缩并上传；失败时抛出请求层的错误（ApiError、NetworkError、ResponseFormatError）。 */
export type SendSave = (request: SaveRequest) => Promise<SaveContentResponse>

/** 已保存到云端、有未保存的修改、保存中、版本冲突、保存失败。 */
export type SaveStatus = 'clean' | 'dirty' | 'saving' | 'conflict' | 'failed'

/** 最近一次保存没有完成的原因。 */
export type SaveProblem
  /** 单元格的编辑提交不了：保存中止，只是提示，状态照旧 */
  = | { readonly kind: 'cell-editing' }
  /** 序列化之后超过上限：没有上传 */
    | { readonly kind: 'too-large' }
  /** 请求失败（冲突除外） */
    | { readonly kind: 'request', readonly error: unknown }
  /** 提交编辑、等公式收齐或捕获时出了意外的错误（SDK 的缺陷等）：没有上传 */
    | { readonly kind: 'unexpected', readonly error: unknown }

export interface SaveView {
  readonly status: SaveStatus
  /** 最近一次保存时公式还没收齐：提示"公式结果尚未保存，请稍后再保存一次" */
  readonly formulasPending: boolean
  readonly problem: SaveProblem | undefined
  /** 版本冲突的详情（服务端没给出能认出的详情时为 null） */
  readonly conflict: RevisionConflictDetails | null | undefined
  /** 能不能保存：保存中、冲突之后、被页面停用时不能 */
  readonly canSave: boolean
}

export interface SaveCoordinatorOptions {
  readonly editor: SaveEditor
  readonly send: SendSave
  /** 打开时内容的修订号（ETag） */
  readonly baseRevision: number
  /** 本页这次加载的标识 */
  readonly clientInstanceId: string
  readonly newRequestId: () => string
  /** 保存得到未登录或登录已过期：页面整页转到登录页 */
  readonly onUnauthenticated: (error: ApiError) => void
  /** CSRF 令牌不对：页面向服务端确认会话 */
  readonly onSessionStale: () => void
  /** 意外的错误（保存流程本身出错）：上报，页面照常显示保存失败 */
  readonly reportError: (error: unknown) => void
  /** 等公式收齐的上限（P4 设计 §3.6.6） */
  readonly settleTimeoutMs?: number
  /** 快照的上限（解压后，字节） */
  readonly maxSnapshotBytes?: number
}

export interface SaveCoordinator {
  readonly view: () => SaveView
  readonly subscribe: (listener: () => void) => () => void
  /** 保存一次（按钮或快捷键）。同一时间只有一个保存在途，保存中再按不做任何事 */
  readonly save: () => Promise<void>
  /** 离开页面会丢掉内容：有未保存的修改、正在编辑的单元格、保存中、冲突之后本页的内容 */
  readonly hasUnsavedWork: () => boolean
  /** 停止保存（例如别的标签页换了人）：之后的保存都不做，直到 resume */
  readonly stop: () => void
  /** 恢复保存（原来的人又登录回来了） */
  readonly resume: () => void
  readonly dispose: () => void
}

export const SETTLE_TIMEOUT_MS = 3000

/**
 * 结果未知的保存（网络错误、5xx、回包读不出来）：服务端可能已经提交了。
 * 认出"自己追自己"只要它的序号与公式是否收齐；不留快照本身，断网期间多次保存时内存不随之增长（审查 B9）
 */
interface UnconfirmedSave {
  readonly localSeq: number
  readonly settled: boolean
}

const UTF8 = new TextEncoder()

function utf8Length(text: string): number {
  return UTF8.encode(text).byteLength
}

function conflictDetails(error: unknown): RevisionConflictDetails | null | undefined {
  if (!(error instanceof ApiError) || error.code !== 'DOCUMENT_REVISION_CONFLICT')
    return undefined
  const parsed = revisionConflictDetailsSchema.safeParse(error.details)
  return parsed.success ? parsed.data : null
}

/** 请求确定没有提交：服务端在写入之前就拒绝了（4xx，冲突也是）。其余情况（网络、5xx、回包读不出来）结果未知 */
function definitelyRejected(error: unknown): boolean {
  return error instanceof ApiError && error.status >= 400 && error.status < 500
}

export function createSaveCoordinator(options: SaveCoordinatorOptions): SaveCoordinator {
  const { editor, send, clientInstanceId, newRequestId } = options
  const settleTimeoutMs = options.settleTimeoutMs ?? SETTLE_TIMEOUT_MS
  const maxSnapshotBytes = options.maxSnapshotBytes ?? SNAPSHOT_MAX_RAW_BYTES
  const listeners = new Set<() => void>()

  let baseRevision = options.baseRevision
  /** 服务端确认过的最大修改序号：打开时是 0（打开不算修改） */
  let savedSeq = 0
  let formulasPending = false
  let inFlight = false
  let stopped = false
  let problem: SaveProblem | undefined
  let conflict: RevisionConflictDetails | null | undefined
  /** 结果未知的保存，按 requestId：冲突的来源是其中之一时，说明它其实已经提交（自己追自己） */
  const unconfirmed = new Map<string, UnconfirmedSave>()
  /** 最近一次结果未知的请求：内容与基准都没变时，重试沿用它的 requestId */
  let retryable: SaveRequest | undefined
  let current = computeView()

  function computeView(): SaveView {
    let status: SaveStatus
    if (conflict !== undefined)
      status = 'conflict'
    else if (inFlight)
      status = 'saving'
    else if (problem !== undefined && problem.kind !== 'cell-editing')
      status = 'failed'
    else
      status = editor.changeSeq() > savedSeq || formulasPending ? 'dirty' : 'clean'
    return { status, formulasPending, problem, conflict, canSave: !inFlight && !stopped && conflict === undefined }
  }

  function update(): void {
    const next = computeView()
    const changed = (Object.keys(next) as (keyof SaveView)[]).some(key => next[key] !== current[key])
    if (!changed)
      return
    current = next
    for (const listener of [...listeners])
      listener()
  }

  const unsubscribeEditor = editor.onChange(update)

  /** 服务端确认了捕获时序号为 localSeq 的内容，修订号是 revision */
  function confirm(localSeq: number, revision: number, settled: boolean): void {
    baseRevision = revision
    savedSeq = Math.max(savedSeq, localSeq)
    formulasPending = !settled
    unconfirmed.clear()
    retryable = undefined
  }

  /** 这次的请求：内容与基准都没变的重试沿用上一次的 requestId（服务端按幂等返回原来的结果，或者照常处理） */
  function prepare(snapshot: string, localSeq: number): SaveRequest {
    const requestId = retryable !== undefined && retryable.snapshot === snapshot && retryable.baseRevision === baseRevision ? retryable.requestId : newRequestId()
    return { baseRevision, requestId, clientInstanceId, localSeq, snapshot }
  }

  /** 冲突的来源是本页一次结果未知的保存：那次保存其实已经提交，只是没收到回包 */
  function ownUnconfirmedSave(details: RevisionConflictDetails | null | undefined): UnconfirmedSave | undefined {
    const source = details?.source
    if (source === undefined || source === null || source.clientInstanceId !== clientInstanceId)
      return undefined
    return [...unconfirmed.values()].find(save => save.localSeq === source.localSeq)
  }

  function fail(error: unknown, request: SaveRequest): void {
    if (definitelyRejected(error)) {
      unconfirmed.delete(request.requestId)
      if (retryable?.requestId === request.requestId)
        retryable = undefined
    }
    else {
      retryable = request
    }
    const details = conflictDetails(error)
    if (details !== undefined) {
      conflict = details
      return
    }
    problem = { kind: 'request', error }
    if (isAuthenticationError(error))
      options.onUnauthenticated(error)
    else if (isCsrfTokenError(error))
      options.onSessionStale()
  }

  async function attempt(): Promise<void> {
    if (editor.isCellEditing() && !(await editor.commitCellEditing())) {
      problem = { kind: 'cell-editing' }
      return
    }
    const settled = (await editor.settleFormulas(settleTimeoutMs)) === 'settled'
    const localSeq = editor.changeSeq()
    const snapshot = editor.capture()
    if (utf8Length(snapshot) > maxSnapshotBytes) {
      problem = { kind: 'too-large' }
      return
    }
    let request = prepare(snapshot, localSeq)
    // 自己追自己只自动重发一次（P4 设计 §3.5.2）
    let rebased = false
    for (;;) {
      unconfirmed.set(request.requestId, { localSeq: request.localSeq, settled })
      try {
        const result = await send(request)
        confirm(request.localSeq, result.revision, settled)
        return
      }
      catch (error) {
        const details = conflictDetails(error)
        const own = rebased ? undefined : ownUnconfirmedSave(details)
        if (own === undefined || details === undefined || details === null) {
          fail(error, request)
          return
        }
        // 那次保存已经提交：它就是当前修订。换上当前修订号作基准，用新的 requestId 重发这一次的内容
        unconfirmed.delete(request.requestId)
        confirm(own.localSeq, details.currentRevision, own.settled)
        request = { ...request, baseRevision, requestId: newRequestId() }
        rebased = true
      }
    }
  }

  return {
    view: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    save: async () => {
      if (inFlight || stopped || conflict !== undefined)
        return
      inFlight = true
      problem = undefined
      update()
      try {
        await attempt()
      }
      catch (error) {
        // 发出请求之前的步骤出了意外（请求本身的失败在 attempt 里已经归类）：显示保存失败，而不是悄悄回到"有未保存的修改"（审查 B5）
        problem = { kind: 'unexpected', error }
        options.reportError(error)
      }
      finally {
        inFlight = false
        update()
      }
    },
    hasUnsavedWork: () => conflict !== undefined || inFlight || editor.isCellEditing() || editor.changeSeq() > savedSeq || formulasPending,
    stop: () => {
      stopped = true
      update()
    },
    resume: () => {
      stopped = false
      update()
    },
    dispose: () => {
      unsubscribeEditor()
      listeners.clear()
    },
  }
}
