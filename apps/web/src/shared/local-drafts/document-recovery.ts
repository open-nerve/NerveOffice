// 文档恢复只保留视图事实与条件操作资格；正文只在一次判定/安装期间借用，副本接收唯一 WorkingDraft。
import type { DocumentDetail, RevisionSource, SaveContentResponse } from '@nerve-office/contracts'
import type { LeaseClock } from '../outbox/clock.ts'
import type { ContentFormat, DraftKey, DraftMeta } from '../outbox/draft-record.ts'
import type { ObservedRemoveResult, ObserveResult } from '../outbox/draft-writer.ts'
import type { RecoveryNotice } from '../outbox/recovery-notice.ts'
import type { DraftSessionPermit } from '../outbox/session-fence.ts'
import type { CopyResult, CopyState, LostCopyFlow } from './copy-flow.ts'
import type { LostCopyOptions } from './lost-copy.ts'
import type { DraftReplayRequest, RecoveryDecision, RecoveryFacts } from './recovery-decision.ts'
import type { RecoveryBlockedReason, RecoveryContext, RecoveryInitialization } from './recovery-initializer.ts'
import type { RecoveryReader } from './recovery-reader.ts'
import type { ResolvedRecovery } from './resolve-recovery.ts'
import type { DraftCapture } from './working-draft.ts'
import { isAuthenticationError, isCsrfTokenError } from '../api/index.ts'
import { draftAad } from '../outbox/draft-aad.ts'
import { sha256Hex } from '../outbox/draft-codec.ts'
import { createLostCopyFlow } from './copy-flow.ts'
import { createMemoryWorkingDraft } from './memory-working-draft.ts'
import { createRecoveryReader } from './recovery-reader.ts'
import { decodeRecovery, resolveRecovery } from './resolve-recovery.ts'

export type RecoveryAccessFacts = Pick<RecoveryFacts, 'access' | 'online' | 'current'>
type VisibleDecision = Exclude<RecoveryDecision, { readonly kind: 'replay' }>
type Operation = 'discover' | 'prepare' | 'copy' | 'discard' | 'cleanup' | 'acknowledge'

export interface RecoveryView {
  readonly completedCopies?: readonly DocumentDetail[]
  readonly saved?: boolean
  readonly stage: 'unchecked' | 'checking' | 'ready' | 'restored' | 'finished'
  readonly decision: VisibleDecision | undefined
  readonly updatedAt: number | undefined
  readonly operation: Operation | undefined
  readonly cleanup: ObservedRemoveResult | undefined
  readonly copy: CopyState
  readonly notice: RecoveryNotice | undefined
  readonly problem: RecoveryBlockedReason | 'invalidated' | 'storage' | undefined
}

export type RecoveryInstall = (snapshot: string, formulasPending: boolean) => Promise<
  { readonly kind: 'installed', readonly capture: Omit<DraftCapture, 'dedupe'> }
  | { readonly kind: 'blocked', readonly reason: RecoveryBlockedReason }
>

/** 在点击的同步段固定已认证来源；等待会话、交接与租约期间不能换成新候选。 */
export type RecoveryPreparation = (context: RecoveryContext, facts: RecoveryAccessFacts, install: RecoveryInstall) => Promise<RecoveryInitialization>

/** 确认框只持有这个不透明对象；确认期间的新发现不能替换其目标。 */
export interface RecoveryDiscard {
  readonly updatedAt: number | undefined
}

export interface DocumentRecovery {
  readonly view: () => RecoveryView
  readonly subscribe: (listener: () => void) => () => void
  readonly discover: () => Promise<void>
  readonly beginRestore: () => RecoveryPreparation
  /** 编辑器已经通过初值采用、保存调度及安装屏障之后才通知。 */
  readonly restored: () => void
  readonly copy: () => Promise<void>
  readonly beginDiscard: () => RecoveryDiscard | undefined
  readonly discard: (intent: RecoveryDiscard) => Promise<void>
  readonly retryCleanup: () => Promise<void>
  readonly acknowledge: (at: number) => Promise<void>
  readonly suspend: () => void
  readonly dispose: () => void
}

export interface DocumentRecoveryOptions {
  readonly key: DraftKey
  readonly pageFormat: ContentFormat
  readonly writtenBy: string
  readonly clock: LeaseClock
  readonly now: () => number
  readonly still: () => boolean
  readonly facts: () => Promise<RecoveryAccessFacts>
  readonly permit?: () => DraftSessionPermit | undefined
  readonly reader?: () => RecoveryReader
  readonly replay: (request: DraftReplayRequest, gzip: Uint8Array<ArrayBuffer>) => Promise<SaveContentResponse>
  /** 只在阅读发现已确认旧请求时刷新；prepare 交回 refresh-cloud，由编辑模式在原租约下重取。 */
  readonly refreshCloud: () => Promise<void>
  readonly conflictCopy: LostCopyOptions['conflictCopy']
  readonly title: () => string
  readonly newId: () => string
  readonly onSessionProblem: (error: unknown) => void
  readonly reportError: (error: unknown) => void
}

interface ReadPort {
  readonly observe: () => Promise<ObserveResult>
  readonly remove: RecoveryReader['remove']
  readonly refreshKey?: RecoveryReader['refreshKey']
}

type RecoveryOrigin = Pick<DraftMeta, 'userId' | 'documentId' | 'writeEpoch' | 'writerId' | 'writtenBy'>

function originOf({ userId, documentId, writeEpoch, writerId, writtenBy }: DraftMeta): RecoveryOrigin {
  return { userId, documentId, writeEpoch, writerId, writtenBy }
}

function sameOrigin(a: RecoveryOrigin, b: RecoveryOrigin): boolean {
  return a.userId === b.userId && a.documentId === b.documentId && a.writeEpoch === b.writeEpoch && a.writerId === b.writerId && a.writtenBy === b.writtenBy
}

interface CleanupTarget {
  readonly generation: number
  readonly presence: number
  /** 只用于副本流程归属，不授予删除资格；新观察的条件删除仍由 remove 闭包核对。 */
  readonly recordId?: string
  readonly remove: () => Promise<ObservedRemoveResult>
}

interface Checked extends ResolvedRecovery {
  readonly originChanged?: true
  readonly snapshot?: string
  readonly recordId?: string
}

interface RecoveryCopy {
  readonly flow: LostCopyFlow
  readonly cleanup: CleanupTarget
  result: CopyResult | undefined
  pending: { readonly started: number, readonly promise: Promise<CopyResult> } | undefined
}

const INVALIDATED: ObservedRemoveResult = { kind: 'failed', error: { name: 'RecoveryObservationExpired', message: '原观察已失效，请重新检查本机修改' } }

export function createDocumentRecovery(options: DocumentRecoveryOptions): DocumentRecovery {
  const key = Object.freeze({ ...options.key })
  let state: RecoveryView = { stage: 'unchecked', decision: undefined, updatedAt: undefined, operation: undefined, cleanup: undefined, copy: { kind: 'idle' }, notice: undefined, problem: undefined }
  let disposed = false
  let generation = 0
  let restoration = 0
  // 记录存在的事实独立于短期观察资格；读取失败、暂停或换 Reader 不能把它变成没有记录。
  let recordKnown = false
  let presence = 0
  let knownSource: { readonly revision: number, readonly source: RevisionSource | null } | undefined
  let reader: RecoveryReader | undefined
  // 视图中已认证的来源独立于短期 Reader；会话确认会关闭 Reader，但不能让旧提示的点击改选新来源。
  let shownOrigin: RecoveryOrigin | undefined
  let candidate: CleanupTarget | undefined
  let cleanup: CleanupTarget | undefined
  let ownedCopy: RecoveryCopy | undefined
  let action: { readonly done: Promise<void>, readonly finish: () => void } | undefined
  const intents = new WeakMap<RecoveryDiscard, CleanupTarget>()
  const discarded = new WeakSet<CleanupTarget>()
  const listeners = new Set<() => void>()

  function publish(patch: Partial<RecoveryView>): void {
    state = { ...state, ...patch }
    for (const listener of [...listeners])
      listener()
  }

  function copyFacts(result: CopyResult | undefined): Pick<RecoveryView, 'completedCopies'> {
    if (result?.kind !== 'done')
      return {}
    const completed = state.completedCopies ?? []
    return { completedCopies: completed.some(document => document.id === result.document.id) ? completed : [...completed, result.document] }
  }

  function retireCopy(): void {
    if (ownedCopy === undefined)
      return
    const facts = copyFacts(ownedCopy.result)
    ownedCopy.flow.dispose()
    ownedCopy = undefined
    publish({ copy: { kind: 'idle' }, ...facts })
  }

  function closeReader(): void {
    reader?.dispose()
    reader = undefined
    candidate = undefined
  }

  function closeIdleReader(owned: RecoveryReader | undefined): void {
    if (owned !== undefined && reader === owned && candidate === undefined && cleanup === undefined)
      closeReader()
  }

  function suspend(): void {
    generation += 1
    knownSource = undefined
    closeReader()
    action?.finish()
    action = undefined
    if (!disposed)
      publish({ operation: undefined, problem: 'invalidated' })
  }

  function live(): boolean {
    if (disposed)
      return false
    if (!options.still()) {
      suspend()
      return false
    }
    return true
  }

  function current(run: number): boolean {
    return live() && run === generation
  }

  function getReader(): RecoveryReader {
    reader ??= options.reader?.() ?? createRecoveryReader({ permit: options.permit?.(), key, clock: options.clock, still: () => !disposed && options.still(), onSessionProblem: options.onSessionProblem })
    return reader
  }

  async function run<T>(operation: Operation, work: (run: number) => Promise<T>, fallback: T): Promise<T> {
    if (!live() || action !== undefined)
      return fallback
    let finish!: () => void
    const done = new Promise<void>((resolve) => {
      finish = resolve
    })
    const ticket = { done, finish }
    action = ticket
    const started = generation
    publish({ operation, problem: undefined })
    try {
      return await work(started)
    }
    catch (error) {
      if (current(started)) {
        if (isAuthenticationError(error) || isCsrfTokenError(error))
          options.onSessionProblem(error)
        else
          options.reportError(error)
        publish({ problem: 'storage' })
      }
      return fallback
    }
    finally {
      finish()
      if (action === ticket) {
        action = undefined
        closeIdleReader(reader)
        publish({ operation: undefined })
      }
    }
  }

  function target(port: ReadPort, observation: Extract<ObserveResult, { kind: 'observed' }>['observation'], started: number, recordId?: string): CleanupTarget {
    return { generation: started, presence, recordId, remove: async () => port.remove(observation) }
  }

  async function remove(target: CleanupTarget): Promise<void> {
    if (!current(target.generation)) {
      if (live())
        publish({ cleanup: INVALIDATED, problem: 'invalidated' })
      return
    }
    const ownedReader = reader
    cleanup = target
    const result = await target.remove()
    if (!current(target.generation) || cleanup !== target)
      return
    const gone = result.kind === 'removed' || result.kind === 'absent'
    publish({ cleanup: result, ...(gone && candidate === target ? { stage: 'finished' as const } : {}), problem: result.kind === 'changed' ? 'changed' : result.kind === 'failed' && result.error.name.includes('Inactive') ? 'invalidated' : undefined })
    if (gone || result.kind === 'changed') {
      cleanup = undefined
      if (candidate === target) {
        if (gone && target.presence === presence) {
          recordKnown = false
          shownOrigin = undefined
          presence += 1
        }
        candidate = undefined
      }
      if (discarded.has(target) && ownedCopy !== undefined && (ownedCopy.cleanup === target || (target.recordId !== undefined && target.recordId === ownedCopy.cleanup.recordId)))
        retireCopy()
      if (action === undefined)
        closeIdleReader(ownedReader)
    }
  }

  function rememberPresence(observed: ObserveResult): void {
    if (observed.kind === 'observed') {
      recordKnown = observed.record.kind !== 'absent'
      presence += 1
    }
    else if (observed.recordKnown === true) {
      recordKnown = true
      presence += 1
    }
  }

  function changedOrigin(observed: ObserveResult, expected: RecoveryOrigin | undefined): Checked | undefined {
    if (expected === undefined || observed.kind !== 'observed' || observed.record.kind === 'absent')
      return undefined
    if (observed.record.kind === 'draft' && sameOrigin(expected, observed.record.meta))
      return undefined
    // 新原件属于下一次明确选择，不能原样重放、条件清理或安装；重新发现也不能改写本次闭包。
    publish({ problem: 'changed' })
    return { observed, decision: { kind: 'preserve', reason: 'storage' }, originChanged: true }
  }

  async function check(started: number, facts: RecoveryAccessFacts, port: ReadPort, expected?: RecoveryOrigin): Promise<Checked | undefined> {
    if (!current(started))
      return undefined
    if (facts.access === 'unknown') {
      knownSource = undefined
      publish({ stage: 'ready', decision: { kind: 'preserve', reason: 'session' } })
      return undefined
    }
    let observed = await port.observe()
    if (!current(started))
      return undefined
    rememberPresence(observed)
    // 旧密钥不能证明来源。先重取密钥并认证，再判断是否仍是点击时的写入者；不借明文元数据授权。
    if (expected !== undefined && observed.kind === 'observed' && observed.record.kind === 'unreadable' && observed.record.reason === 'stale-key' && port.refreshKey !== undefined) {
      observed = await port.refreshKey(observed.record.meta.keyVersion)
      if (!current(started))
        return undefined
      rememberPresence(observed)
    }
    const changed = changedOrigin(observed, expected)
    if (changed !== undefined)
      return changed
    // 阅读状态不带 source。已核实的同修订来源可继续使用，权限与占用始终来自本次请求。
    let server = facts.current
    if (server !== undefined) {
      if (knownSource?.revision !== server.revision)
        knownSource = undefined
      if (server.source !== undefined)
        knownSource = { revision: server.revision, source: server.source === null ? null : { ...server.source } }
      else if (knownSource !== undefined)
        server = { ...server, source: knownSource.source }
    }
    const inputs = { ...facts, current: server, key, pageFormat: options.pageFormat, now: options.now() }
    let resolved = await resolveRecovery({ observed, facts: inputs, replay: options.replay })
    if (!current(started))
      return undefined
    if (resolved.decision.kind === 'refresh-key') {
      if (port.refreshKey !== undefined && observed.kind === 'observed' && 'meta' in observed.record) {
        observed = await port.refreshKey(observed.record.meta.keyVersion)
        if (!current(started))
          return undefined
        rememberPresence(observed)
        const changed = changedOrigin(observed, expected)
        if (changed !== undefined)
          return changed
        resolved = await resolveRecovery({ observed, facts: inputs, replay: options.replay })
        if (!current(started))
          return undefined
      }
      if (resolved.decision.kind === 'refresh-key')
        resolved = { ...resolved, decision: { kind: 'preserve', reason: 'key' } }
    }
    if (isAuthenticationError(resolved.problem) || isCsrfTokenError(resolved.problem)) {
      options.onSessionProblem(resolved.problem)
      if (!current(started))
        return undefined
    }
    let snapshot: string | undefined
    if (observed.kind === 'observed' && observed.record.kind === 'draft' && (resolved.decision.kind === 'restore' || resolved.decision.kind === 'copy' || resolved.decision.kind === 'held')) {
      const decoded = await decodeRecovery(observed.record)
      if (!current(started))
        return undefined
      if (decoded.kind === 'corrupted')
        resolved = { ...resolved, decision: { kind: 'remove', reason: 'corrupted' } }
      else
        snapshot = decoded.snapshot
    }
    // 保留短摘要以区分重查同一原件与真正的新内容，不将正文或 gzip 留进长期候选。
    const recordId = observed.kind === 'observed' && observed.record.kind === 'draft'
      ? (await Promise.all([sha256Hex(draftAad(observed.record.meta)), sha256Hex(observed.record.gzip)])).join(':')
      : undefined
    if (!current(started))
      return undefined
    shownOrigin = observed.kind === 'observed' && observed.record.kind === 'draft' ? originOf(observed.record.meta) : undefined
    candidate = observed.kind === 'observed' && observed.record.kind !== 'absent' ? target(port, observed.observation, started, recordId) : undefined
    if ((ownedCopy?.result?.kind === 'done' || ownedCopy?.result?.kind === 'refused') && ((observed.kind === 'observed' && observed.record.kind === 'absent') || (recordId !== undefined && recordId !== ownedCopy.cleanup.recordId)))
      retireCopy()
    const decision = resolved.decision.kind === 'replay' ? { kind: 'preserve' as const, reason: 'replay' as const } : resolved.decision
    publish({ stage: 'ready', decision, saved: false, updatedAt: observed.kind === 'observed' && 'meta' in observed.record ? observed.record.meta.updatedAt : undefined, cleanup: undefined })
    if ((decision.kind === 'confirmed' || decision.kind === 'remove') && candidate !== undefined)
      await remove(candidate)
    if (!current(started))
      return undefined
    return { ...resolved, recordId, ...(snapshot === undefined ? {} : { snapshot }) }
  }

  /** 未采用的编辑来源随 blocked 结果关闭；阅读动作须先换成独立观察，不能续用该来源的清理凭证。 */
  async function blocked(context: RecoveryContext, started: number, facts: RecoveryAccessFacts, checked: Checked | undefined, reason: RecoveryBlockedReason, expected?: RecoveryOrigin): Promise<RecoveryInitialization> {
    if (context.kind === 'existing' && reason !== 'cancelled') {
      candidate = undefined
      context.retire()
      const fresh = await check(started, facts, getReader(), expected)
      if (!current(started))
        return { kind: 'blocked', reason: 'cancelled' }
      if (fresh?.originChanged === true)
        return { kind: 'blocked', reason: 'changed' }
      if (fresh?.decision.kind === 'confirmed' || fresh?.decision.kind === 'remove')
        return { kind: 'blocked', reason: 'refresh-cloud' }
      if (fresh?.decision.kind === 'none' || ((reason === 'open-check' || reason === 'formulas') && (fresh?.decision.kind !== 'restore' || fresh.snapshot !== checked?.snapshot)))
        return { kind: 'blocked', reason: 'changed' }
    }
    if (reason === 'open-check' || reason === 'formulas' || reason === 'cancelled')
      publish({ problem: reason })
    return { kind: 'blocked', reason }
  }

  /** 单独作用域只闭包原条件动作，不把 check 的正文或 SDK 初值留进来源。 */
  function confirmation(target: CleanupTarget): () => Promise<void> {
    return async () => remove(target)
  }

  /** 只闭包本轮标识，不让解码正文随确认提示驻留。 */
  function saved(identity: number): () => void {
    return () => {
      // 会话暂停会退休清理凭证；同一恢复内容在重新确认身份后发出的新上传仍能记录成功。
      if (live() && restoration === identity)
        publish({ saved: true })
    }
  }

  function releaseReader(owned: RecoveryReader): () => void {
    return () => {
      if (reader === owned)
        closeReader()
      else
        owned.dispose()
    }
  }

  async function prepare(context: RecoveryContext, facts: RecoveryAccessFacts, install: RecoveryInstall, queued: number, expected: RecoveryOrigin | undefined): Promise<RecoveryInitialization> {
    if (!current(queued))
      return { kind: 'blocked', reason: 'cancelled' }
    const waiting = action !== undefined
    await action?.done
    if (!current(queued))
      return { kind: 'blocked', reason: 'cancelled' }
    // 排队期间旧回执确认了：阅读刷新可能因已经开始进入编辑而跳过，即使记录已删也必须重取云端。
    if (waiting && state.decision?.kind === 'confirmed')
      return { kind: 'blocked', reason: 'refresh-cloud' }
    if (ownedCopy !== undefined && ownedCopy.result?.kind !== 'done' && ownedCopy.result?.kind !== 'refused')
      return { kind: 'blocked', reason: 'preserved' }
    return run<RecoveryInitialization>('prepare', async (started) => {
      if (context.kind === 'empty') {
        recordKnown = false
        shownOrigin = undefined
        presence += 1
        closeReader()
        retireCopy()
        return { kind: 'none' }
      }
      let port: ReadPort
      let ownedReader: RecoveryReader | undefined
      if (context.kind === 'existing') {
        recordKnown = true
        presence += 1
        closeReader()
        port = context
      }
      else {
        if (context.recordKnown === true) {
          recordKnown = true
          presence += 1
        }
        ownedReader = getReader()
        port = ownedReader
      }
      const checked = await check(started, facts, port, expected)
      if (!current(started))
        return { kind: 'blocked', reason: 'cancelled' }
      if (checked?.originChanged === true)
        return { kind: 'blocked', reason: 'changed' }
      if (checked?.decision.kind === 'none')
        return context.kind === 'existing' ? { kind: 'blocked', reason: 'changed' } : { kind: 'none' }
      if (checked?.decision.kind === 'confirmed' || checked?.decision.kind === 'remove')
        return { kind: 'blocked', reason: 'refresh-cloud' }
      // 浏览器明确禁止/缺少存储能力时，保留 P2 的内存编辑退路。镜像忙等未知失败不属于此许可。
      if (context.kind === 'memory' && !recordKnown && facts.access === 'editable' && facts.online && facts.current?.occupied === false
        && checked?.observed.kind === 'unavailable' && (checked.observed.reason === 'denied' || checked.observed.reason === 'unsupported')) {
        return { kind: 'memory', reason: context.reason }
      }
      // 明确拒绝不挡住发现新原件；仍是同一原件时，保留拒绝，交给用户明确处理。
      if (ownedCopy?.result?.kind === 'refused')
        return blocked(context, started, facts, checked, 'preserved', expected)
      if (checked?.decision.kind !== 'restore' || checked.observed.kind !== 'observed' || checked.observed.record.kind !== 'draft' || checked.snapshot === undefined)
        return blocked(context, started, facts, checked, 'preserved', expected)
      const original = candidate ?? target(port, checked.observed.observation, started)
      const installed = await install(checked.snapshot, checked.decision.formulasPending)
      if (!current(started))
        return { kind: 'blocked', reason: 'cancelled' }
      if (installed.kind === 'blocked')
        return blocked(context, started, facts, checked, installed.reason, expected)
      return {
        kind: 'restore',
        capture: installed.capture,
        baseRevision: checked.decision.baseRevision,
        highWater: Math.max(context.highWater, checked.observed.writer?.lastDraftSeq ?? 0, checked.observed.record.meta.draftSeq),
        ...(context.kind === 'existing' ? { recoveryObservation: checked.observed.observation } : {}),
        onConfirmed: confirmation(original),
        onSaved: saved(++restoration),
        ...(ownedReader === undefined ? {} : { dispose: releaseReader(ownedReader) }),
      }
    }, { kind: 'blocked', reason: 'preserved' })
  }

  const recovery: DocumentRecovery = {
    view: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    discover: async () => run('discover', async (started) => {
      publish({ stage: 'checking' })
      const facts = await options.facts()
      if (!current(started))
        return
      const source = getReader()
      const checked = await check(started, facts, source)
      if (!current(started))
        return
      const notices = await source.notices()
      if (!current(started))
        return
      if (notices.kind === 'notices')
        publish({ notice: notices.notices.find(notice => notice.documentId === key.documentId) })
      if (checked?.decision.kind === 'confirmed')
        await options.refreshCloud()
      if (current(started))
        closeIdleReader(source)
    }, undefined),
    beginRestore: () => {
      const queued = generation
      const expected = shownOrigin
      return async (context, facts, install) => prepare(context, facts, install, queued, expected)
    },
    restored: () => {
      if (live())
        publish({ stage: 'restored', problem: undefined })
    },
    copy: async () => run('copy', async (started) => {
      const facts = await options.facts()
      if (!current(started) || !facts.online || (facts.access !== 'editable' && facts.access !== 'read-only'))
        return
      if (ownedCopy?.result?.kind === 'done' || ownedCopy?.result?.kind === 'refused') {
        // 旧回包可能晚于新一轮发现。这里只结束旧流程，不借旧回执清理或自动复制新候选。
        if (candidate?.generation === started && candidate.recordId !== undefined && candidate.recordId !== ownedCopy.cleanup.recordId) {
          retireCopy()
          return
        }
        publish({ copy: ownedCopy.result, ...copyFacts(ownedCopy.result) })
        return
      }
      if (ownedCopy === undefined) {
        const source = getReader()
        const checked = await check(started, facts, source)
        if (!current(started))
          return
        if (checked?.decision.kind === 'confirmed') {
          await options.refreshCloud()
          return
        }
        if (checked === undefined || (checked.decision.kind !== 'copy' && checked.decision.kind !== 'held' && checked.decision.kind !== 'restore') || checked.observed.kind !== 'observed' || checked.observed.record.kind !== 'draft' || checked.snapshot === undefined)
          return
        const meta = checked.observed.record.meta
        const draft = createMemoryWorkingDraft({ sessionId: `recovery-copy:${options.newId()}`, writtenBy: options.writtenBy, format: meta.format, initialDraftSeq: meta.draftSeq, baseRevision: meta.baseRevision, reportError: options.reportError, reason: 'existing-draft', initialCapture: { snapshot: checked.snapshot, editorSeq: 0, formulasPending: meta.formulasPending } })
        const view = draft.view()
        if (view.kind !== 'working') {
          draft.dispose()
          return
        }
        const ready = await draft.ready(view.ref)
        if (!current(started) || ready.kind !== 'ready') {
          draft.dispose()
          return
        }
        // 同一 flow 会跨暂停保留请求；认证错误由下方按每次发送的代次分派。
        ownedCopy = { flow: createLostCopyFlow({ documentId: key.documentId, draft, ref: view.ref, lostAt: new Date(meta.updatedAt), title: options.title, newId: options.newId, conflictCopy: options.conflictCopy, onSessionProblem: () => {} }), cleanup: candidate ?? target(source, checked.observed.observation, started, checked.recordId), result: undefined, pending: undefined }
      }
      const owned = ownedCopy
      publish({ copy: { kind: 'saving' } })
      // 暂停后新动作可以等待旧发送；不会因此获得旧发送的会话副作用资格。
      const sending = owned.pending ??= { started, promise: owned.flow.save() }
      const result = await sending.promise
      if (owned.pending === sending)
        owned.pending = undefined
      // 迟到的成功仍是已创建的事实：本页恢复后不能换 requestId 再建一份，但旧身份不能自动清理。
      if (!disposed && ownedCopy === owned) {
        owned.result = result
        if (result.kind === 'done' || result.kind === 'refused')
          owned.flow.dispose()
      }
      if (!current(started))
        return
      publish({ copy: result, ...copyFacts(result) })
      if (current(sending.started) && result.kind === 'failed' && (isAuthenticationError(result.error) || isCsrfTokenError(result.error)))
        options.onSessionProblem(result.error)
      if (result.kind === 'done')
        await remove(owned.cleanup)
    }, undefined),
    beginDiscard: () => {
      if (!live() || candidate === undefined || action !== undefined)
        return undefined
      const intent = Object.freeze({ updatedAt: state.updatedAt })
      intents.set(intent, candidate)
      return intent
    },
    discard: async intent => run('discard', async (started) => {
      const original = intents.get(intent)
      if (original === undefined)
        return
      const facts = await options.facts()
      if (!current(started) || facts.access === 'unknown')
        return
      discarded.add(original)
      await remove(original)
    }, undefined),
    retryCleanup: async () => run('cleanup', async () => {
      if (cleanup !== undefined)
        await remove(cleanup)
    }, undefined),
    acknowledge: async at => run('acknowledge', async (started) => {
      const facts = await options.facts()
      if (!current(started) || facts.access === 'unknown' || state.notice?.at !== at)
        return
      const source = getReader()
      const result = await source.clearNotice(at)
      if (current(started)) {
        if ((result.kind === 'cleared' || result.kind === 'absent') && state.notice?.at === at)
          publish({ notice: undefined })
        closeIdleReader(source)
      }
    }, undefined),
    suspend,
    dispose: () => {
      if (disposed)
        return
      disposed = true
      suspend()
      ownedCopy?.flow.dispose()
      ownedCopy = undefined
      cleanup = undefined
      listeners.clear()
    },
  }
  return recovery
}
