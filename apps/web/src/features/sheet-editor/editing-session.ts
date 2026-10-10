// 编辑会话拥有的资源（M4-P2 S1）：租约、本机锁、保存协调与自动保存。
// 页面管理模式和编辑器槽位，这里管理资源的建立与释放。停捕获不等于销毁保存协调：失去编辑权时，
// 在途保存与结果未知的重放仍要由协调器收尾。已交出/失效时 detachLease，不再次发释放请求。
import type { PendingEditRequest, SaveContentResponse } from '@nerve-office/contracts'
import type { ApiError } from '../../shared/api/index.ts'
import type { ConnectionState } from '../../shared/lib/connection-state.ts'
import type { Autosave, AutosaveEditor, AutosaveEvent, AutosavePage, AutosaveTuning } from './autosave.ts'
import type { Incompatibility } from './client-format.ts'
import type { AcquireIntent, EditLease, EditLeaseApi, LeaseAcquisition, LeaseClock, LeaseLoss, LeaseVerdict } from './edit-lease.ts'
import type { DraftStorageView, EditingDraft, EditingDraftOptions, EditingDraftPreparation, EditingDraftReady } from './editing-draft.ts'
import type { LeaseCredentials } from './editor-api.ts'
import type { HandoverTrace } from './handover-trace.ts'
import type { LocalLock, LockClaim } from './local-lock.ts'
import type { SameBrowser } from './same-browser.ts'
import type { SaveCoordinator, SaveEditor, SaveRequest, SaveSendIntent, SaveSendResult } from './save-coordinator.ts'
import type { WorkingDraftView } from './working-draft.ts'
import { ApiError as RequestError } from '../../shared/api/index.ts'
import { createAutosave } from './autosave.ts'
import { incompatibilityOf, PAGE_CLIENT_FORMAT } from './client-format.ts'
import { acquireEditLease, leaseLossOf } from './edit-lease.ts'
import { prepareEditingDraft } from './editing-draft.ts'
import { holdLocalLock } from './local-lock.ts'
import { createSaveCoordinator } from './save-coordinator.ts'
import { takeSnapshot } from './snapshot-capture.ts'

/** 只需要捕获与保存能力，不持有或销毁编辑器的 UI。 */
export type EditingSessionEditor = AutosaveEditor & SaveEditor

export interface EditingSessionOptions {
  readonly userId: string
  /** 是否仍是本页用户；和临时阻止 HTTP 的“会话确认在途”分开。 */
  readonly sessionActive?: (() => boolean) | undefined
  /** 连接恢复只允许发起核对，不能直接恢复上传。独立使用者可不装浏览器连接适配器。 */
  readonly connection?: Pick<ConnectionState, 'view' | 'subscribe'> | undefined
  readonly documentId: string
  readonly clientInstanceId: string
  readonly api: {
    readonly editLease: EditLeaseApi
    readonly save: (documentId: string, request: SaveRequest, body: Uint8Array<ArrayBuffer>, lease: LeaseCredentials) => Promise<SaveContentResponse>
  }
  readonly clock: LeaseClock
  readonly sameBrowser: SameBrowser
  readonly lastActivity: () => number
  readonly newId: () => string
  readonly session: {
    readonly saveUnauthenticated: (error: ApiError) => void
    readonly saveStale: () => void
    readonly writeProblem: (error: ApiError) => void
  }
  readonly autosave: {
    readonly page: AutosavePage
    readonly tuning?: AutosaveTuning | undefined
    readonly observe?: ((event: AutosaveEvent) => void) | undefined
    readonly attach?: ((autosave: Autosave | undefined) => void) | undefined
  }
  readonly reportError: (error: unknown) => void
  readonly onLost: (loss: LeaseLoss) => void
  readonly onIncompatible: (kind: Incompatibility) => void
  readonly onRequest: (request: PendingEditRequest | null) => void
  readonly onChange: () => void
  readonly trace?: HandoverTrace | undefined
  /** 页面传服务端实际开关；未配置的独立使用者保持内存来源。 */
  readonly localDrafts?: ({ readonly enabled: () => boolean } & Pick<EditingDraftOptions, 'keeper' | 'host' | 'supported' | 'persist'>) | undefined
}

export interface InitialSaving {
  readonly revision: number
  readonly snapshotBytes: number
  readonly formulasPending: boolean
  readonly blocked: Incompatibility | undefined
}

export interface LocalSaveView {
  readonly draft: WorkingDraftView
  readonly storage: DraftStorageView
  /** 本份捕获是否覆盖当前模型和未提交输入；不是持久保存成功的同义词。 */
  readonly coversCurrent: boolean
  readonly unsaved: boolean
  readonly enabled: boolean
}

export interface EditingSession {
  readonly lease: EditLease | undefined
  readonly coordinator: SaveCoordinator | undefined
  readonly autosave: Autosave | undefined
  readonly draft: EditingDraft | undefined
  readonly localSave: () => LocalSaveView | undefined
  readonly baseRevision: () => number
  readonly setBaseRevision: (revision: number) => void
  readonly acquire: (intent?: AcquireIntent) => Promise<LeaseAcquisition>
  readonly acceptLease: (held: EditLease, revision: number) => void
  readonly claim: (held: EditLease) => Promise<LockClaim>
  readonly holdsLock: () => boolean
  readonly lossWithLocalEvidence: (loss: LeaseLoss) => LeaseLoss
  /** 已失效之后的定位：等待期间不再把这把锁当作编辑权，完成后放锁。 */
  readonly locateTakeover: (loss: LeaseLoss, waitMs: number) => Promise<boolean>
  readonly startSaving: (editor: EditingSessionEditor, initial: InitialSaving) => void
  readonly prepareDraft: (initial: Pick<InitialSaving, 'revision'>) => Promise<EditingDraftReady>
  /** 转交之后原会话不再销毁来源；调用方须先结束保存协调的上传所有权。 */
  readonly takeDraft: () => EditingDraft | undefined
  readonly suspendDraft: () => void
  readonly resumeDraft: () => Promise<void>
  /** 页面许可与本机栅栏核对分别约束上传，页面恢复不能跳过尚未完成的核对。 */
  readonly setSavingActive: (active: boolean) => void
  readonly discardDraftKey: () => void
  readonly stopCapturing: () => void
  readonly stopSaving: () => void
  /** 只忘记已经失效/交出的租约，本机锁可留到被本人接管的位置判明。 */
  readonly detachLease: () => void
  readonly releaseLease: () => void
  readonly releaseLock: () => void
  readonly dispose: () => void
}

const TAKEN_OVER_HERE: LeaseLoss = { kind: 'taken-over', where: 'this-browser' }

/** 锁被抢后核对确实已被取代：本地证据只改本人接管/替换，强制接管等原因原样保留。 */
function supersededLoss(loss: LeaseLoss): LeaseLoss {
  return loss.kind === 'taken-over' || (loss.kind === 'lease' && loss.reason === 'replaced') ? TAKEN_OVER_HERE : loss
}

export function createEditingSession(options: EditingSessionOptions): EditingSession {
  const { api, documentId, clock } = options
  let lease: EditLease | undefined
  let lock: LocalLock | undefined
  let coordinator: SaveCoordinator | undefined
  let autosave: Autosave | undefined
  let savingEditor: EditingSessionEditor | undefined
  let savingLease: EditLease | undefined
  let draft: EditingDraft | undefined
  let preparation: EditingDraftPreparation | undefined
  let transferDraft: (() => void) | undefined
  let keyVersion: number | null | undefined
  let sourceSerial = 0
  let draftGeneration = 0
  let savingActive = true
  let verifyFence: (() => Promise<void>) | undefined
  let stopWatchingCoordinator: (() => void) | undefined
  let stopWatchingAutosave: (() => void) | undefined
  const localWatchers: (() => void)[] = []
  let localSnapshot: LocalSaveView | undefined
  let editingBase = 0
  let disposed = false
  let connectionView = options.connection?.view()
  let needsConnectionCheck = connectionView?.available === false
  let connectionEnded = false
  let connectionGeneration = 0
  let checkingConnection = false
  let checkAgainImmediately = false
  let connectionAttempts = 0
  let connectionRetryAt = 0
  let cancelConnectionRetry: (() => void) | undefined

  function baseRevision(): number {
    return coordinator?.baseRevision() ?? editingBase
  }

  function localSave(): LocalSaveView | undefined {
    if (draft === undefined || savingEditor === undefined)
      return undefined
    const observed = draft.view()
    const previous = localSnapshot?.draft
    // WorkingDraft 的 view 是临时只读对象；按引用和完成结果比较，保持页面快照稳定。
    const unchanged = previous?.kind === observed.kind && (observed.kind !== 'working'
      || (previous.kind === 'working' && previous.ref === observed.ref && previous.summary === observed.summary && previous.local.kind === observed.local.kind))
    const content = unchanged && previous !== undefined ? previous : observed
    const next: LocalSaveView = {
      draft: content,
      storage: draft.storage(),
      coversCurrent: content.kind === 'working' && content.ref.editorSeq === savingEditor.changeSeq() && savingEditor.uncommittedInput() === 'none',
      unsaved: coordinator?.hasUnsavedWork() ?? false,
      enabled: options.localDrafts?.enabled() === true,
    }
    if (localSnapshot === undefined || (Object.keys(next) as (keyof LocalSaveView)[]).some(key => next[key] !== localSnapshot?.[key]))
      localSnapshot = next
    return localSnapshot
  }

  function stopWatchingLocal(): void {
    for (const stop of localWatchers.splice(0))
      stop()
    localSnapshot = undefined
  }

  function releaseLock(): void {
    invalidateConnection()
    suspendDraft()
    const held = lock
    lock = undefined
    held?.release()
  }

  function releaseLease(): void {
    void lease?.release()
    lease = undefined
    releaseLock()
  }

  function stopCapturing(): void {
    if (autosave === undefined)
      return
    stopWatchingAutosave?.()
    stopWatchingAutosave = undefined
    autosave.dispose()
    autosave = undefined
    options.autosave.attach?.(undefined)
  }

  function stopSaving(): void {
    stopWatchingLocal()
    invalidateConnection(coordinator !== undefined)
    draftGeneration += 1
    verifyFence = undefined
    stopCapturing()
    stopWatchingCoordinator?.()
    stopWatchingCoordinator = undefined
    coordinator?.dispose()
    coordinator = undefined
    savingEditor = undefined
    savingLease = undefined
    preparation?.dispose()
    preparation = undefined
    transferDraft = undefined
    draft = undefined
  }

  async function resumeDraft(): Promise<void> {
    if (!disposed && lock?.held() === true && lease !== undefined && options.sessionActive?.() !== false && options.localDrafts?.enabled() === true) {
      if (verifyFence !== undefined)
        await verifyFence()
      else
        await preparation?.resume()
    }
  }

  function suspendDraft(): void {
    draftGeneration += 1
    preparation?.suspend()
  }

  function syncSaving(): void {
    if (savingActive && verifyFence === undefined && !needsConnectionCheck)
      coordinator?.resume()
    else
      coordinator?.stop()
  }

  function clearConnectionRetry(): void {
    cancelConnectionRetry?.()
    cancelConnectionRetry = undefined
  }

  /** 使旧核对失效，但不断开本机来源、密钥或捕获。 */
  function invalidateConnection(recheck = true): void {
    connectionGeneration += 1
    clearConnectionRetry()
    if (recheck && options.connection !== undefined)
      needsConnectionCheck = true
    syncSaving()
  }

  function canCheckConnection(): boolean {
    return options.connection !== undefined && !disposed && !connectionEnded && savingActive
      && lease !== undefined && lease === savingLease && coordinator !== undefined && lock?.held() === true
      && options.sessionActive?.() !== false && options.connection.view().browserOnline
  }

  /** 单飞、受控退避；成功请求与旧心跳只能唤醒此入口，不能给予编辑许可。 */
  function checkConnection(): void {
    const held = lease
    const connection = options.connection
    if (held === undefined || connection === undefined || !needsConnectionCheck || !canCheckConnection() || checkingConnection || cancelConnectionRetry !== undefined)
      return
    const delay = connectionRetryAt - clock.now()
    if (delay > 0) {
      cancelConnectionRetry = clock.schedule(() => {
        cancelConnectionRetry = undefined
        checkConnection()
      }, delay)
      return
    }
    const saver = coordinator
    const source = draft
    const generation = connectionGeneration
    const networkGeneration = connection.view().generation
    const current = (): boolean => canCheckConnection() && lease === held && coordinator === saver && draft === source
      && connectionGeneration === generation && connection.view().generation === networkGeneration
    checkingConnection = true
    checkAgainImmediately = false
    connectionAttempts += 1
    void (async () => {
      try {
        const verdict = await confirmDraft(held, current)
        if (!current())
          return
        if (verdict.kind === 'superseded') {
          connectionEnded = true
          held.abandon()
          options.onLost(verdict.loss)
        }
        else if (verdict.kind === 'ended') {
          connectionEnded = true
        }
        else if (verdict.kind === 'current') {
          needsConnectionCheck = false
          connectionAttempts = 0
          connectionRetryAt = 0
          syncSaving()
        }
      }
      catch (error) {
        options.reportError(error)
      }
      finally {
        checkingConnection = false
        if (needsConnectionCheck && !checkAgainImmediately)
          connectionRetryAt = clock.now() + Math.min(2_000 * 2 ** Math.min(connectionAttempts - 1, 4), 30_000)
        checkConnection()
      }
    })()
  }

  const stopWatchingConnection = options.connection?.subscribe(() => {
    const next = options.connection?.view()
    if (next === undefined)
      return
    const previous = connectionView
    connectionView = next
    if (next.generation !== previous?.generation) {
      const alreadyChecking = needsConnectionCheck
      invalidateConnection()
      if (!next.browserOnline || previous?.browserOnline === false) {
        connectionAttempts = 0
        connectionRetryAt = clock.now()
        checkAgainImmediately = next.browserOnline
      }
      else if (!alreadyChecking) {
        connectionAttempts = 0
        connectionRetryAt = clock.now() + 2_000
      }
    }
    checkConnection()
  })

  /** 本代自己失效仍沿用 M3 的续上；一次续上后必须重新核对，不把申请回包当作当前事实。 */
  async function confirmDraft(held: EditLease, still: () => boolean = () => true): Promise<LeaseVerdict> {
    const generation = draftGeneration
    const current = (): boolean => !disposed && lease === held && lock?.held() === true && options.sessionActive?.() !== false && draftGeneration === generation && still()
    const unknown: LeaseVerdict = { kind: 'unknown', error: undefined }
    if (!current())
      return unknown
    let verdict = await held.confirm()
    if (!current())
      return unknown
    if (verdict.kind === 'ended' && verdict.loss !== undefined) {
      const outcome = await held.lose(verdict.loss, held.credentials())
      if (!current())
        return unknown
      if (outcome.kind === 'lost')
        return { kind: 'ended', loss: verdict.loss }
      if (outcome.kind === 'unknown')
        return { kind: 'unknown', error: outcome.error }
      verdict = await held.confirm()
      if (!current())
        return unknown
      // 每次只续上一轮；再次失效留给后续心跳，不能在准备中不断申请。
      if (verdict.kind === 'ended' && verdict.loss !== undefined)
        return unknown
    }
    if (verdict.kind === 'unknown' && verdict.error instanceof RequestError)
      options.session.writeProblem(verdict.error)
    return verdict
  }

  /** 保存时租约已续上就用新凭据重发至多一次；原请求标识和字节不变。 */
  async function sendSave(held: EditLease, request: SaveRequest, body: Uint8Array<ArrayBuffer>, intent: SaveSendIntent, owned: () => boolean): Promise<SaveSendResult> {
    for (let resent = false; ; resent = true) {
      // mark、排队及 lose 都可能等待。每次实际 HTTP 前重新判定，不能只依赖协调器的 stop。
      if (disposed || !owned() || !(options.connection?.view().browserOnline ?? options.autosave.page.online()))
        return { kind: 'not-sent' }
      if (intent === 'save' && (!savingActive || needsConnectionCheck || verifyFence !== undefined
        || lease !== held || lock?.held() !== true || options.sessionActive?.() === false)) {
        return { kind: 'not-sent' }
      }
      const credentials = held.credentials()
      try {
        return await api.save(documentId, request, body, credentials)
      }
      catch (error) {
        // 已失效后的固定请求只问此前有没有提交，不能借失败重新申请编辑权。
        if (intent === 'reconcile')
          throw error
        if (incompatibilityOf(error) !== undefined) {
          void held.release()
          throw error
        }
        const loss = leaseLossOf(error)
        if (loss === undefined)
          throw error
        const outcome = await held.lose(loss, credentials)
        if (outcome.kind === 'unknown')
          throw outcome.error ?? error
        if (outcome.kind === 'lost' || resent)
          throw error
      }
    }
  }

  return {
    get lease() { return lease },
    get coordinator() { return coordinator },
    get autosave() { return autosave },
    get draft() { return draft },
    localSave,
    baseRevision,
    setBaseRevision: (revision) => { editingBase = revision },
    acquire: async (intent = {}) => acquireEditLease({
      documentId,
      clientInstanceId: options.clientInstanceId,
      api: api.editLease,
      clock,
      lastActivity: options.lastActivity,
      baseRevision,
      adoptOwnRevision: (revision, source) => coordinator?.adoptOwnRevision(revision, source) ?? false,
      onLost: options.onLost,
      onSessionProblem: options.session.writeProblem,
      onIncompatible: options.onIncompatible,
      onRequest: options.onRequest,
      onRenewed: (sentAt) => {
        lock?.renewed(sentAt)
        checkConnection()
        if (verifyFence !== undefined)
          void verifyFence().catch(options.reportError)
        else
          void resumeDraft().catch(options.reportError)
      },
      onLocalKeyVersion: (version) => {
        keyVersion = version
        if (options.localDrafts?.enabled() === true)
          preparation?.observeVersion(version)
      },
    }, { retrySameUser: async () => !(await options.sameBrowser.heldHere()), ...intent }),
    acceptLease: (held, revision) => {
      lease = held
      editingBase = revision
      invalidateConnection(false)
      connectionEnded = false
      needsConnectionCheck = options.connection?.view().available === false
      connectionAttempts = 0
      connectionRetryAt = 0
      syncSaving()
    },
    claim: async (held) => {
      const claimed: LocalLock = holdLocalLock({
        browser: options.sameBrowser,
        confirm: held.confirm,
        lose: async loss => held.lose(loss, held.credentials()),
        onSuperseded: (loss) => {
          if (disposed || lock !== claimed)
            return
          held.abandon()
          options.onLost(supersededLoss(loss))
        },
        onHeldChange: (isHeld) => {
          if (disposed || lock !== claimed)
            return
          if (isHeld) {
            void resumeDraft().catch(options.reportError)
          }
          else {
            invalidateConnection()
            suspendDraft()
          }
          checkConnection()
        },
        clock,
        trace: options.trace,
      })
      lock = claimed
      return claimed.claim()
    },
    holdsLock: () => lock?.held() === true,
    prepareDraft: async (initial) => {
      const held = lease
      if (disposed || held === undefined)
        throw new Error('准备草稿前必须先接纳编辑租约')
      if (lock?.held() !== true)
        throw new Error('准备草稿前必须先取得本机锁')
      stopSaving()
      let transferred = false
      const prepared = prepareEditingDraft({
        ...options.localDrafts,
        enabled: options.localDrafts?.enabled() === true,
        key: { userId: options.userId, documentId },
        sessionId: `${options.clientInstanceId}:${held.credentials().writeEpoch}:${++sourceSerial}`,
        baseRevision: initial.revision,
        format: PAGE_CLIENT_FORMAT,
        writtenBy: options.clientInstanceId,
        clock,
        writeEpoch: () => held.credentials().writeEpoch,
        newWriterId: options.newId,
        confirm: async () => confirmDraft(held),
        still: () => !disposed || transferred,
        reportError: options.reportError,
        onSessionProblem: (error) => {
          if (error instanceof RequestError)
            options.session.writeProblem(error)
          else
            options.reportError(error)
        },
        onLost: (verdict) => {
          if (preparation !== prepared || disposed)
            return
          if (verdict.kind === 'superseded') {
            held.abandon()
            options.onLost(verdict.loss)
          }
          // ended 已由 confirmDraft 交给租约处理；其原回调负责通知，不能重复通知或绕过续上。
        },
      })
      preparation = prepared
      transferDraft = () => {
        transferred = true
      }
      if (keyVersion !== undefined)
        prepared.observeVersion(keyVersion)
      const result = await prepared.ready()
      if (preparation !== prepared || disposed) {
        prepared.dispose()
        return { kind: 'disposed' }
      }
      if (result.kind === 'ready')
        draft = result.draft
      return result
    },
    takeDraft: () => {
      const owned = draft
      if (owned === undefined)
        return undefined
      transferDraft?.()
      stopWatchingLocal()
      preparation = undefined
      transferDraft = undefined
      draft = undefined
      savingEditor = undefined
      savingLease = undefined
      invalidateConnection()
      return owned
    },
    suspendDraft,
    resumeDraft,
    setSavingActive: (active) => {
      if (savingActive !== active) {
        invalidateConnection()
        savingActive = active
        checkConnection()
      }
      syncSaving()
    },
    discardDraftKey: () => {
      if (options.sessionActive?.() === false)
        invalidateConnection()
      suspendDraft()
      if (draft !== undefined && savingEditor !== undefined) {
        try {
          takeSnapshot(savingEditor, draft, { formulasPending: !savingEditor.formulasSettled(), dedupe: false })
        }
        catch (error) {
          options.reportError(error)
        }
      }
      preparation?.discardKey()
    },
    lossWithLocalEvidence: loss => lock?.stolen() === true ? supersededLoss(loss) : loss,
    locateTakeover: async (loss, waitMs) => {
      const held = lock
      if (loss.kind !== 'taken-over' || loss.where !== 'elsewhere' || held === undefined) {
        releaseLock()
        return false
      }
      const here = await held.takenHere(clock.now() + waitMs)
      if (lock === held)
        lock = undefined
      return here
    },
    startSaving: (editor, initial) => {
      const held = lease
      if (held === undefined)
        throw new Error('建立保存前必须先接纳编辑租约')
      const source = draft
      if (source === undefined)
        throw new Error('建立保存前必须先准备工作草稿来源')
      savingEditor = editor
      savingLease = held
      let saver: SaveCoordinator
      let verifying: { readonly generation: number, readonly promise: Promise<void> } | undefined
      const ownsSaving = (): boolean => !disposed && coordinator === saver && lease === held && draft === source && lock?.held() === true && options.sessionActive?.() !== false
      const checkFence = async (): Promise<void> => {
        if (!ownsSaving())
          return
        if (verifying?.generation === draftGeneration)
          return verifying.promise
        suspendDraft()
        const generation = draftGeneration
        const current = (): boolean => ownsSaving() && generation === draftGeneration && verifyFence === checkFence
        syncSaving()
        const promise = (async () => {
          const verdict = await confirmDraft(held)
          if (!current())
            return
          if (verdict.kind === 'superseded') {
            held.abandon()
            options.onLost(verdict.loss)
            return
          }
          if (verdict.kind !== 'current')
            return
          // 部署关闭后仍须核对云端资格，但不准通过创建时开启的来源重新取钥或建宿主。
          if (options.localDrafts?.enabled() === true && !(await source.resume()))
            return
          if (!current())
            return
          verifyFence = undefined
          syncSaving()
        })()
        verifying = { generation, promise }
        try {
          await promise
        }
        finally {
          if (verifying?.generation === generation)
            verifying = undefined
        }
      }
      saver = createSaveCoordinator({
        editor,
        draft: source,
        send: async (request, body, intent) => sendSave(held, request, body, intent, () => coordinator === saver),
        baseRevision: initial.revision,
        clientInstanceId: options.clientInstanceId,
        newRequestId: options.newId,
        onUnauthenticated: options.session.saveUnauthenticated,
        onSessionStale: options.session.saveStale,
        onDraftResult: async (result) => {
          if (result.kind === 'fenced' || (result.kind === 'memory' && result.reason === 'fenced')) {
            if (disposed || coordinator !== saver || draft !== source)
              return
            verifyFence = checkFence
            syncSaving()
            await checkFence()
          }
        },
        reportError: options.reportError,
        initialSnapshotBytes: initial.snapshotBytes,
        initialFormulasPending: initial.formulasPending,
      })
      coordinator = saver
      syncSaving()
      if (initial.blocked !== undefined)
        saver.block(initial.blocked)
      stopWatchingCoordinator = saver.subscribe(options.onChange)
      // save.unsaved 可能一直为 true；每次新编辑/输入仍须立即撤掉“已完整落盘”的说法。
      localWatchers.push(source.subscribe(options.onChange), editor.onChange(options.onChange), editor.onUncommittedInputChange(options.onChange))
      const scheduler = createAutosave({
        editor,
        page: options.autosave.page,
        uploader: saver,
        clock,
        draft: source,
        initialFormulasPending: initial.formulasPending,
        tuning: options.autosave.tuning,
        observe: options.autosave.observe,
        reportError: options.reportError,
      })
      autosave = scheduler
      stopWatchingAutosave = scheduler.subscribe(options.onChange)
      options.autosave.attach?.(scheduler)
      checkConnection()
    },
    stopCapturing,
    stopSaving,
    detachLease: () => {
      lease = undefined
      invalidateConnection()
    },
    releaseLease,
    releaseLock,
    dispose: () => {
      if (disposed)
        return
      disposed = true
      stopWatchingConnection?.()
      releaseLease()
      stopSaving()
    },
  }
}
