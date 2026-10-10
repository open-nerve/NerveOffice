// 编辑会话拥有的资源（M4-P2 S1）：租约、本机锁、保存协调与自动保存。
// 页面管理模式和编辑器槽位，这里管理资源的建立与释放。停捕获不等于销毁保存协调：失去编辑权时，
// 在途保存与结果未知的重放仍要由协调器收尾。已交出/失效时 detachLease，不再次发释放请求。
import type { PendingEditRequest, SaveContentResponse } from '@nerve-office/contracts'
import type { ApiError } from '../../shared/api/index.ts'
import type { Autosave, AutosaveEditor, AutosaveEvent, AutosavePage, AutosaveTuning } from './autosave.ts'
import type { Incompatibility } from './client-format.ts'
import type { AcquireIntent, EditLease, EditLeaseApi, LeaseAcquisition, LeaseClock, LeaseLoss } from './edit-lease.ts'
import type { LeaseCredentials } from './editor-api.ts'
import type { HandoverTrace } from './handover-trace.ts'
import type { LocalLock, LockClaim } from './local-lock.ts'
import type { SameBrowser } from './same-browser.ts'
import type { CompressSnapshot, SaveCoordinator, SaveEditor, SaveRequest } from './save-coordinator.ts'
import type { WorkingDraft } from './working-draft.ts'
import { createAutosave } from './autosave.ts'
import { incompatibilityOf, PAGE_CLIENT_FORMAT } from './client-format.ts'
import { acquireEditLease, leaseLossOf } from './edit-lease.ts'
import { holdLocalLock } from './local-lock.ts'
import { createMemoryWorkingDraft } from './memory-working-draft.ts'
import { createSaveCoordinator } from './save-coordinator.ts'

/** 只需要捕获与保存能力，不持有或销毁编辑器的 UI。 */
export type EditingSessionEditor = AutosaveEditor & SaveEditor

export interface EditingSessionOptions {
  readonly documentId: string
  readonly clientInstanceId: string
  readonly api: {
    readonly editLease: EditLeaseApi
    readonly compress: CompressSnapshot
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
    readonly digest: (snapshot: string) => Promise<string>
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
}

export interface InitialSaving {
  readonly revision: number
  readonly snapshotBytes: number
  readonly formulasPending: boolean
  readonly blocked: Incompatibility | undefined
}

export interface EditingSession {
  readonly lease: EditLease | undefined
  readonly coordinator: SaveCoordinator | undefined
  readonly autosave: Autosave | undefined
  readonly draft: WorkingDraft | undefined
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
  let draft: WorkingDraft | undefined
  let stopWatchingCoordinator: (() => void) | undefined
  let stopWatchingAutosave: (() => void) | undefined
  let editingBase = 0
  let disposed = false

  function baseRevision(): number {
    return coordinator?.baseRevision() ?? editingBase
  }

  function releaseLock(): void {
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
    stopCapturing()
    stopWatchingCoordinator?.()
    stopWatchingCoordinator = undefined
    coordinator?.dispose()
    coordinator = undefined
    draft?.dispose()
    draft = undefined
  }

  /** 保存时租约已续上就用新凭据重发至多一次；原请求标识和字节不变。 */
  async function sendSave(held: EditLease, request: SaveRequest, body: Uint8Array<ArrayBuffer>): Promise<SaveContentResponse> {
    for (let resent = false; ; resent = true) {
      const credentials = held.credentials()
      try {
        return await api.save(documentId, request, body, credentials)
      }
      catch (error) {
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
      onRenewed: sentAt => lock?.renewed(sentAt),
    }, { retrySameUser: async () => !(await options.sameBrowser.heldHere()), ...intent }),
    acceptLease: (held, revision) => {
      lease = held
      editingBase = revision
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
        clock,
        trace: options.trace,
      })
      lock = claimed
      return claimed.claim()
    },
    holdsLock: () => lock?.held() === true,
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
      const source = createMemoryWorkingDraft({ sessionId: `${options.clientInstanceId}:${held.credentials().writeEpoch}`, initialDraftSeq: 0, baseRevision: initial.revision, format: PAGE_CLIENT_FORMAT, writtenBy: options.clientInstanceId, reportError: options.reportError, reason: 'disabled' })
      draft = source
      const saver = createSaveCoordinator({
        editor,
        draft: source,
        send: async (request, body) => sendSave(held, request, body),
        baseRevision: initial.revision,
        clientInstanceId: options.clientInstanceId,
        newRequestId: options.newId,
        onUnauthenticated: options.session.saveUnauthenticated,
        onSessionStale: options.session.saveStale,
        reportError: options.reportError,
        initialSnapshotBytes: initial.snapshotBytes,
        initialFormulasPending: initial.formulasPending,
      })
      coordinator = saver
      if (initial.blocked !== undefined)
        saver.block(initial.blocked)
      stopWatchingCoordinator = saver.subscribe(options.onChange)
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
    },
    stopCapturing,
    stopSaving,
    detachLease: () => { lease = undefined },
    releaseLease,
    releaseLock,
    dispose: () => {
      if (disposed)
        return
      disposed = true
      releaseLease()
      stopSaving()
    },
  }
}
