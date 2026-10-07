import type { AcquiredEditInterruption, AcquiredEditLease, CreatedDocument, DocumentEditor, EditInterruption, EditRequestOutcome, EditStatus, HandedOverEditLease, OpenCheckFailure, PendingEditRequest, RenewedEditLease, SaveContentResponse } from '@nerve-office/contracts'
import type { EditorAccess, OpenCheck, SheetEditor, SheetEditorLifecycle, SheetViewState } from '../../editor/index.ts'
import type { Autosave, AutosaveLimits, AutosavePage, AutosaveTuning } from './autosave.ts'
import type { EditLeaseApi } from './edit-lease.ts'
import type { EditMode, EditModeApi, EditModeOptions, EditModeState, LostMode, ReadingMode } from './edit-mode.ts'
import type { FetchedEditStatus, LoadedContent } from './editor-api.ts'
import type { HandoverTrace, HandoverTraceEvent } from './handover-trace.ts'
import type { PendingSaveMarker } from './pending-save-marker.ts'
import type { FakeBrowser } from './same-browser.test-support.ts'
import type { HeldLock, SameBrowser } from './same-browser.ts'
import { EDIT_HANDOVER_IDLE_SECONDS, EDIT_IDLE_RELEASE_SECONDS, EDIT_LEASE_HEARTBEAT_SECONDS, EDIT_LEASE_IDLE_RECLAIM_SECONDS, EDIT_LEASE_TTL_SECONDS, EDIT_PENDING_SAVE_WAIT_MS, EDIT_REQUEST_RENEW_SECONDS, EDIT_TAB_HANDOVER_ACK_MS, EDIT_TAB_HANDOVER_DONE_MS } from '@nerve-office/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, NetworkError } from '../../shared/api/index.ts'
import { DEFAULT_AUTOSAVE_LIMITS } from './autosave.ts'
import { PAGE_CLIENT_FORMAT } from './client-format.ts'
import { SAME_USER_RETRIES, SAME_USER_RETRY_DELAY_MS } from './edit-lease.ts'
import { createEditMode, EXIT_RELEASE_WAIT_MS, IDLE_RECHECK_MS } from './edit-mode.ts'
import { CONTENT_UNCHANGED } from './editor-api.ts'
import { fakeLeaseClock, settle } from './fake-lease-clock.test-support.ts'
import { memoryIssuedRequest } from './issued-request.test-support.ts'
import { READING_CHECK_INTERVAL_MS } from './reading-checks.ts'
import { fakeBrowser } from './same-browser.test-support.ts'
import { channelNameOf, lockNameOf, sameBrowserFor } from './same-browser.ts'
import { PENDING_SAVE_POLL_MS, TAB_HANDOVER_BUSY_RETRY_MS } from './self-takeover.ts'

const DOCUMENT_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'
const PAGE_ID = '0199a2c4-1f2e-7a3b-8c4d-00000000aaaa'
const AMY = { id: '0199a2c4-1f2e-7a3b-8c4d-0000000000e1', username: 'amy', displayName: '艾米' }
/** 请求编辑的人（M3-P5） */
const BEN = { id: '0199a2c4-1f2e-7a3b-8c4d-0000000000e2', username: 'ben', displayName: '本' }
/** 交出之后留给请求方到这个时刻（服务端的） */
const RESERVED_UNTIL = '2026-10-04T03:05:00.000Z'

/** 快照：本页的内容就是 v 这一项（假的编辑器按它捕获） */
function snapshotOf(value: string): string {
  return JSON.stringify({ id: 'unit-1', v: value })
}

const LOADED = { snapshot: snapshotOf('载入的'), revision: 3 }
const TOKEN = 'L'.repeat(43)
const ACQUIRED: AcquiredEditLease = { token: TOKEN, writeEpoch: 7, revision: 3, source: null, expiresAt: '2026-10-04T03:01:30.000Z', interruption: null, formulasPending: false }
const RENEWED: RenewedEditLease = { expiresAt: '2026-10-04T03:01:40.000Z', request: null }
const SAVED: SaveContentResponse = { revision: 4, savedAt: '2026-10-04T03:00:00.000Z', unchanged: false }
const DENIED = new ApiError(403, 'PERMISSION_DENIED', '空间已归档，只能查看')
const GONE = new ApiError(404, 'NOT_FOUND', '不存在')
const HEARTBEAT_MS = EDIT_LEASE_HEARTBEAT_SECONDS * 1000

/** 由测试决定何时完成的 Promise */
function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

/** 一个假的编辑器：内容是 v，修改一次序号加一；记下创建时的打开方式、快照与视图状态，销毁与否 */
interface FakeEditor {
  readonly editor: SheetEditor
  readonly access: EditorAccess
  readonly snapshot: string
  readonly viewState: SheetViewState | undefined
  readonly index: number
  /** 创建时要求了强制全量重算（M3-P4） */
  readonly recalculate: boolean | undefined
  disposed: boolean
  cellEditing: boolean
  failCapture: boolean
  /** 公式的结果收齐了没有（settleFormulas 与 formulasSettled 的回答）：默认收齐 */
  formulasSettled: boolean
  edit: (value: string) => void
  enter: (stage: SheetEditorLifecycle) => void
  /** 公式收齐与否变了（发出公式进度的信号） */
  settle: (settled: boolean) => void
}

/** 第 n 个编辑器给出的视图状态：重建时交给下一个 */
function viewStateOf(index: number): SheetViewState {
  return { sheetId: `sheet-${index}`, topLeft: { row: index * 10, column: index }, selection: undefined }
}

/** 新建的编辑器的打开自检的结果按打开方式与快照给出（默认通过） */
type CheckOf = (options: { readonly access: EditorAccess, readonly snapshot: string }) => OpenCheck

function fakeFactory() {
  const created: FakeEditor[] = []
  /** 下一次创建的结果：默认立即成功；hold 时由测试放行，fail 时失败 */
  let next: 'ok' | 'fail' | { readonly gate: Promise<void> } = 'ok'
  let checkOf: CheckOf = () => ({ ok: true })
  const createEditor = vi.fn(async (options: { snapshot: string, access: EditorAccess, viewState?: SheetViewState | undefined, recalculate?: boolean }) => {
    const plan = next
    next = 'ok'
    if (plan === 'fail')
      throw new Error('编辑器加载失败')
    if (typeof plan === 'object')
      await plan.gate
    let value = (JSON.parse(options.snapshot) as { v: string }).v
    let seq = 0
    let stage: SheetEditorLifecycle = 'rendered'
    const changeListeners = new Set<() => void>()
    const lifecycleListeners = new Set<(stage: SheetEditorLifecycle) => void>()
    const progressListeners = new Set<() => void>()
    const fake: FakeEditor = {
      access: options.access,
      snapshot: options.snapshot,
      viewState: options.viewState,
      index: created.length,
      recalculate: options.recalculate,
      disposed: false,
      cellEditing: false,
      failCapture: false,
      formulasSettled: true,
      editor: {
        unitId: 'unit-1',
        changeSeq: () => seq,
        onChange: (listener) => {
          changeListeners.add(listener)
          return () => changeListeners.delete(listener)
        },
        lifecycle: () => stage,
        onLifecycle: (listener) => {
          lifecycleListeners.add(listener)
          return () => lifecycleListeners.delete(listener)
        },
        isCellEditing: () => !fake.disposed && fake.cellEditing,
        hasPendingCellInput: () => !fake.disposed && fake.cellEditing,
        onCellEditingChange: () => () => {},
        commitCellEditing: vi.fn(async () => {
          if (fake.cellEditing) {
            fake.cellEditing = false
            seq += 1
            changeListeners.forEach(listener => listener())
          }
          return true
        }),
        settleFormulas: vi.fn(async () => fake.formulasSettled ? 'settled' as const : 'timeout' as const),
        formulasSettled: () => fake.formulasSettled,
        onFormulaProgress: (listener) => {
          progressListeners.add(listener)
          return () => progressListeners.delete(listener)
        },
        composing: () => false,
        onCompositionChange: () => () => {},
        settlePanels: vi.fn(async () => {}),
        capture: vi.fn(() => {
          if (fake.failCapture)
            throw new Error('SDK 出错')
          return snapshotOf(value)
        }),
        viewState: () => fake.disposed ? undefined : viewStateOf(fake.index),
        openCheck: checkOf(options),
        dispose: vi.fn(async () => {
          fake.disposed = true
        }),
      },
      edit: (text) => {
        value = text
        seq += 1
        changeListeners.forEach(listener => listener())
      },
      enter: (nextStage) => {
        stage = nextStage
        lifecycleListeners.forEach(listener => listener(nextStage))
      },
      settle: (settled) => {
        fake.formulasSettled = settled
        progressListeners.forEach(listener => listener())
      },
    }
    created.push(fake)
    return fake.editor
  })
  return {
    createEditor,
    created,
    /** 最后一个编辑器 */
    last: (): FakeEditor => {
      const fake = created.at(-1)
      if (fake === undefined)
        throw new Error('还没有创建编辑器')
      return fake
    },
    failNext: () => {
      next = 'fail'
    },
    /** 下一次创建停在中途，直到 release */
    holdNext: () => {
      const gate = deferred<void>()
      next = { gate: gate.promise }
      return { release: () => gate.resolve() }
    },
    /** 之后新建的编辑器的打开自检按它给出（M3-P4） */
    checkWith: (next: CheckOf) => {
      checkOf = next
    },
  }
}

/** 另存为副本得到的新文档 */
const COPY = {
  id: '0199a2c4-1f2e-7a3b-8c4d-0000000000c1',
  title: '周报（冲突副本 2026-10-04 15:30）',
  type: 'sheet',
  createdAt: '2026-10-04T07:31:00.000Z',
  updatedAt: '2026-10-04T07:31:00.000Z',
  spaceId: '0199a2c4-1f2e-7a3b-8c4d-0000000000aa',
  space: { id: '0199a2c4-1f2e-7a3b-8c4d-0000000000aa', type: 'personal' },
  folderId: null,
  accessVia: 'space',
  revision: 1,
  profile: 'sheet@1',
  formatVersion: 1,
  sdkVersion: '1.0.1',
  formulasPending: false,
  permissions: { canEdit: true, canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: true, canCopy: true, canDelete: true, canShare: true, canTakeOver: true },
} as const

/** 服务端回答编辑状态的时刻：与申请被占用时的回答同一个时刻，最后活动几分钟之前两边算出来一样 */
const ANSWERED_AT = '2026-10-04T03:03:10.000Z'

function status(revision: number, editor: DocumentEditor | null = null, canEdit = true): FetchedEditStatus {
  return { status: { revision, editor, canEdit, canTakeOver: false, formulasPending: false, request: null, reservation: null, interruption: null }, serverTime: Date.parse(ANSWERED_AT) }
}

/** 艾米在编辑（最后活动 3 分钟前） */
const AMY_EDITING: DocumentEditor = { holder: AMY, lastActiveAt: '2026-10-04T03:00:00.000Z', sameUser: false, sameSession: false }

/** 自己在编辑（编辑状态里是同一个人：另一个标签页，或者本页没能确认放掉的那一代） */
const SELF_EDITING: DocumentEditor = { holder: AMY, lastActiveAt: '2026-10-04T03:03:00.000Z', sameUser: true, sameSession: false }

/** 请求编辑在等艾米回应（M3-P5） */
const REQUEST_PENDING: EditRequestOutcome = { kind: 'pending', id: '0199a2c4-1f2e-7a3b-8c4d-0000000000f1', requestedAt: '2026-10-04T03:01:00.000Z', expiresAt: '2026-10-04T03:11:00.000Z', holder: AMY_EDITING }

/** 申请时被艾米占用 */
const HELD_BY_AMY = new ApiError(409, 'EDIT_LEASE_HELD', '别人正在编辑', { details: { ...AMY_EDITING, canTakeOver: false, request: null }, serverTime: Date.parse(ANSWERED_AT) })

function fakeVisibility() {
  let hidden = false
  const listeners = new Set<() => void>()
  return {
    visibility: {
      hidden: () => hidden,
      onChange: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    set: (next: boolean) => {
      hidden = next
      listeners.forEach(listener => listener())
    },
  }
}

/**
 * 自动保存要的页面一侧与测试构建的控制的样子（M3-P4）：可见、联网、会话可写可设；默认暂停定时的上传（与 E2E 的夹具一样），
 * 现有的用例按"按保存才上传"的语义成立，要自动上传的用例放开（release）
 */
function fakeAutosave(held: boolean) {
  const state = { visible: true, online: true, writable: true, held, limits: DEFAULT_AUTOSAVE_LIMITS }
  const pageListeners = new Set<() => void>()
  const tuningListeners = new Set<() => void>()
  const page: AutosavePage = {
    visible: () => state.visible,
    online: () => state.online,
    sessionWritable: () => state.writable,
    onChange: (listener) => {
      pageListeners.add(listener)
      return () => pageListeners.delete(listener)
    },
  }
  const tuning: AutosaveTuning = {
    limits: () => state.limits,
    held: () => state.held,
    onChange: (listener) => {
      tuningListeners.add(listener)
      return () => tuningListeners.delete(listener)
    },
  }
  const attached: (Autosave | undefined)[] = []
  return {
    page,
    tuning,
    attach: vi.fn((autosave: Autosave | undefined) => {
      attached.push(autosave)
    }),
    /** 交给控制的调度，按先后（去掉时是 undefined） */
    attached,
    current: (): Autosave | undefined => attached.at(-1),
    setPage(patch: Partial<Pick<typeof state, 'visible' | 'online' | 'writable'>>): void {
      Object.assign(state, patch)
      pageListeners.forEach(listener => listener())
    },
    release(): void {
      state.held = false
      tuningListeners.forEach(listener => listener())
    },
    setLimits(patch: Partial<AutosaveLimits>): void {
      state.limits = { ...state.limits, ...patch }
      tuningListeners.forEach(listener => listener())
    },
  }
}

interface Setup {
  readonly api?: Partial<Omit<EditModeApi, 'editLease'>>
  readonly editLease?: Partial<EditLeaseApi>
  readonly now?: () => Date
  /** 定时的自动保存放开（默认暂停） */
  readonly autosave?: 'held' | 'running'
  /**
   * 本页最后一次键盘、鼠标操作：默认一直是"现在"（人一直在，空闲释放不会到点）；manual 时停在打开的那一刻，由用例的 act 记下操作
   * （空闲释放的用例，M3-P5）
   */
  readonly activity?: 'now' | 'manual'
  /** 同一个浏览器（几个标签页共用锁与频道，M3-P5）：默认每个用例一个；本页在里面叫 this */
  readonly browser?: FakeBrowser
  /** 换掉本页的锁与频道（要控制拿锁的时机时） */
  readonly sameBrowser?: SameBrowser
  /** 本页的标识（同一个浏览器里的另一个标签页另给一个，M3-P5） */
  readonly clientInstanceId?: string
  /** 本页的用户（默认艾米） */
  readonly userId?: string
  /** 本页在同一个浏览器里叫什么（fakeBrowser 的标签页名，默认 this） */
  readonly tab?: string
  /** 测试构建的观察钩子（M3-P5 S8）：默认不给 */
  readonly trace?: HandoverTrace
}

const modes: EditMode[] = []

function setup(options: Setup = {}) {
  const factory = fakeFactory()
  const time = fakeLeaseClock()
  const page = fakeVisibility()
  let id = 0
  const editLease = {
    acquire: vi.fn(options.editLease?.acquire ?? (async (): Promise<AcquiredEditLease> => ACQUIRED)),
    renew: vi.fn(options.editLease?.renew ?? (async (): Promise<RenewedEditLease> => RENEWED)),
    release: vi.fn(options.editLease?.release ?? (async (): Promise<void> => {})),
    handOver: vi.fn(options.editLease?.handOver ?? (async (): Promise<HandedOverEditLease> => ({ reservedFor: BEN, reservedUntil: RESERVED_UNTIL }))),
    decline: vi.fn(options.editLease?.decline ?? (async (): Promise<void> => {})),
  }
  const overrides = options.api ?? {}
  const api = {
    content: vi.fn(overrides.content ?? (async (): Promise<LoadedContent> => ({ snapshot: snapshotOf('最新的'), revision: 9 }))),
    contentIfChanged: vi.fn(overrides.contentIfChanged ?? (async (): Promise<LoadedContent | typeof CONTENT_UNCHANGED> => ({ snapshot: snapshotOf('服务端的'), revision: 5 }))),
    editStatus: vi.fn(overrides.editStatus ?? (async (): Promise<FetchedEditStatus> => status(3))),
    compress: vi.fn(overrides.compress ?? (async (snapshot: string) => new TextEncoder().encode(snapshot))),
    save: vi.fn(overrides.save ?? (async (): Promise<SaveContentResponse> => SAVED)),
    conflictCopy: vi.fn(overrides.conflictCopy ?? (async (): Promise<CreatedDocument> => ({ ...COPY, replayed: false }))),
    reportOpenCheck: vi.fn(overrides.reportOpenCheck ?? (async (): Promise<void> => {})),
    editLease,
    editRequest: {
      send: vi.fn(overrides.editRequest?.send ?? (async (): Promise<EditRequestOutcome> => REQUEST_PENDING)),
      renew: vi.fn(overrides.editRequest?.renew ?? (async (): Promise<EditRequestOutcome> => REQUEST_PENDING)),
      cancel: vi.fn(overrides.editRequest?.cancel ?? (async (): Promise<void> => {})),
    },
  } satisfies EditModeApi
  const hooks = { saveUnauthenticated: vi.fn(), saveStale: vi.fn(), writeProblem: vi.fn(), readProblem: vi.fn() }
  const reportError = vi.fn()
  const autosave = fakeAutosave(options.autosave !== 'running')
  const browser = options.browser ?? fakeBrowser()
  const marker = { write: vi.fn<PendingSaveMarker['write']>(), read: vi.fn<PendingSaveMarker['read']>(() => undefined), clear: vi.fn<PendingSaveMarker['clear']>() }
  /** 这一页发出过的请求编辑的记号（审查 B2）：每个"标签页"一份 */
  const issued = memoryIssuedRequest(DOCUMENT_ID)
  let lastActive = time.now()
  const modeOptions: EditModeOptions = {
    documentId: DOCUMENT_ID,
    clientInstanceId: options.clientInstanceId ?? PAGE_ID,
    userId: options.userId ?? AMY.id,
    api,
    createEditor: factory.createEditor,
    clock: time.clock,
    visibility: page.visibility,
    lastActivity: options.activity === 'manual' ? () => lastActive : () => time.now(),
    newId: () => `0199a2c4-1f2e-7a3b-8c4d-${String(++id).padStart(12, '0')}`,
    now: options.now ?? (() => new Date(2026, 9, 4, 15, 30, 12)),
    title: () => '周报',
    session: hooks,
    autosave: { page: autosave.page, digest: async snapshot => `sha:${snapshot}`, tuning: autosave.tuning, attach: autosave.attach },
    sameBrowser: options.sameBrowser ?? sameBrowserFor(DOCUMENT_ID, browser.tab(options.tab ?? 'this')),
    pendingSave: marker,
    issuedRequest: issued.marker,
    reportError,
    ...(options.trace === undefined ? {} : { trace: options.trace }),
  }
  const mode = createEditMode(modeOptions)
  modes.push(mode)
  return {
    mode,
    factory,
    time,
    page,
    api,
    editLease,
    hooks,
    reportError,
    autosave,
    browser,
    marker,
    issued,
    /** 本页有一次键盘、鼠标操作（activity 为 manual 时）：记下时刻，交给编辑模式 */
    act: () => {
      lastActive = time.now()
      mode.noteActivity()
    },
  }
}

/** 这份文档的本机锁现在在哪个标签页手里 */
const LOCK = lockNameOf(DOCUMENT_ID)

afterEach(() => {
  for (const mode of modes.splice(0))
    mode.dispose()
})

function modeOf(mode: EditMode): EditModeState {
  return mode.view().mode
}

function readingOf(mode: EditMode): ReadingMode {
  const current = modeOf(mode)
  if (current.kind !== 'reading')
    throw new Error(`现在不是阅读：${current.kind}`)
  return current
}

function lostOf(mode: EditMode): LostMode {
  const current = modeOf(mode)
  if (current.kind !== 'lost')
    throw new Error(`现在不是失去编辑权：${current.kind}`)
  return current
}

/** 打开并进入阅读（能编辑） */
async function opened(context: ReturnType<typeof setup>, canEdit = true): Promise<void> {
  await context.mode.open({ ...LOADED, canEdit }, { enterEdit: false })
  await settle()
}

/** 打开、进入编辑 */
async function editing(context: ReturnType<typeof setup>): Promise<void> {
  await opened(context)
  await context.mode.enter()
  expect(modeOf(context.mode).kind).toBe('editing')
}

describe('打开（M3-P2 设计 §3.4：打开即阅读）', () => {
  it('以只读创建、显示载入的内容，进入阅读（能编辑时有"编辑"）；进入阅读时立即读一次编辑状态', async () => {
    const context = setup()
    const outcome = await context.mode.open({ ...LOADED, canEdit: true }, { enterEdit: false })
    expect(outcome).toEqual({ kind: 'opened', entered: false, damaged: false })
    expect(context.factory.created.map(fake => [fake.access, fake.snapshot, fake.viewState])).toEqual([['read', LOADED.snapshot, undefined]])
    expect(readingOf(context.mode)).toEqual({ kind: 'reading', canEdit: true, canTakeOver: false, holder: undefined, requestedElsewhere: false, update: 'none', gone: false, notice: undefined, releaseUnconfirmed: false, formulasPending: false })
    expect(context.mode.view()).toMatchObject({ surface: 'rendered', save: undefined })
    expect(context.editLease.acquire).not.toHaveBeenCalled()
    await settle()
    expect(context.api.editStatus).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID)
  })

  it('新建期间 surface 是 creating（页面挂着交互屏障），建好之后随编辑器的生命周期', async () => {
    const context = setup()
    const gate = context.factory.holdNext()
    const opening = context.mode.open({ ...LOADED, canEdit: true }, { enterEdit: false })
    await settle()
    expect(context.mode.view()).toMatchObject({ mode: { kind: 'opening' }, surface: 'creating' })
    gate.release()
    await opening
    expect(context.mode.view().surface).toBe('rendered')
    context.factory.last().enter('steady')
    expect(context.mode.view().surface).toBe('steady')
  })

  it('只能查看：阅读，没有"编辑"', async () => {
    const context = setup({ api: { editStatus: async () => status(3, null, false) } })
    await opened(context, false)
    expect(readingOf(context.mode).canEdit).toBe(false)
  })

  it('编辑器建不起来：editor-failed（上报）', async () => {
    const context = setup()
    context.factory.failNext()
    const outcome = await context.mode.open({ ...LOADED, canEdit: true }, { enterEdit: false })
    expect(outcome.kind).toBe('editor-failed')
    expect(modeOf(context.mode).kind).toBe('failed')
    expect(context.reportError).toHaveBeenCalledOnce()
  })

  it('新建的表格（?edit=new）而且能编辑：直接申请、以可编辑创建（只建一次，不先建只读的），进入编辑', async () => {
    const context = setup()
    const outcome = await context.mode.open({ ...LOADED, canEdit: true }, { enterEdit: true })
    expect(outcome).toEqual({ kind: 'opened', entered: true, damaged: false })
    expect(context.editLease.acquire).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, PAGE_ID)
    expect(context.factory.created.map(fake => [fake.access, fake.snapshot])).toEqual([['edit', LOADED.snapshot]])
    expect(modeOf(context.mode).kind).toBe('editing')
    expect(context.mode.view().save?.status).toBe('clean')
  })

  it('?edit=new 但不能编辑：不申请，照常阅读', async () => {
    const context = setup()
    await context.mode.open({ ...LOADED, canEdit: false }, { enterEdit: true })
    expect(context.editLease.acquire).not.toHaveBeenCalled()
    expect(context.factory.last().access).toBe('read')
  })

  it('?edit=new 但被占用：以只读创建，说明谁在编辑', async () => {
    const context = setup({ editLease: { acquire: async () => Promise.reject(HELD_BY_AMY) }, api: { editStatus: async () => status(3, AMY_EDITING) } })
    const outcome = await context.mode.open({ ...LOADED, canEdit: true }, { enterEdit: true })
    expect(outcome).toEqual({ kind: 'opened', entered: false, damaged: false })
    expect(context.factory.last().access).toBe('read')
    expect(readingOf(context.mode).holder).toEqual({ holder: AMY, sameUser: false, lastActiveMinutes: 3 })
  })

  it('?edit=new 但刚失去编辑权（403）：以只读创建，没有"编辑"，说明原因', async () => {
    const context = setup({ editLease: { acquire: async () => Promise.reject(DENIED) }, api: { editStatus: async () => status(3, null, false) } })
    await context.mode.open({ ...LOADED, canEdit: true }, { enterEdit: true })
    expect(context.factory.last().access).toBe('read')
    expect(readingOf(context.mode)).toMatchObject({ canEdit: false, notice: { kind: 'denied', error: DENIED } })
  })

  it.each([
    ['读不到了（404）', GONE],
    ['未登录', new ApiError(401, 'SESSION_EXPIRED', '登录已过期')],
  ])('?edit=new 申请时%s：与读取元数据、内容失败相同（load-failed），不创建编辑器', async (_case, error) => {
    const context = setup({ editLease: { acquire: async () => Promise.reject(error) } })
    const opening = context.mode.open({ ...LOADED, canEdit: true }, { enterEdit: true })
    await context.time.advance(1_000)
    expect(await opening).toEqual({ kind: 'load-failed', error })
    expect(context.factory.created).toEqual([])
  })

  it.each([
    ['网络（再试一次之后仍然未知）', new NetworkError('断网')],
    ['服务端出错（5xx）', new ApiError(503, 'SERVICE_UNAVAILABLE', '繁忙')],
  ])('?edit=new 申请时%s：内容已经读到——以只读打开载入的内容，说明没能进入编辑（与"编辑"时相同，审查 A11），可以再点"编辑"', async (_case, error) => {
    const context = setup({ editLease: { acquire: async () => Promise.reject(error) } })
    const opening = context.mode.open({ ...LOADED, canEdit: true }, { enterEdit: true })
    await context.time.advance(1_000)
    expect(await opening).toEqual({ kind: 'opened', entered: false, damaged: false })
    expect(context.factory.created.map(fake => [fake.access, fake.snapshot])).toEqual([['read', LOADED.snapshot]])
    expect(readingOf(context.mode)).toMatchObject({ canEdit: true, notice: { kind: 'enter-failed', error } })
    context.editLease.acquire.mockResolvedValueOnce(ACQUIRED)
    await context.mode.enter()
    expect(modeOf(context.mode).kind).toBe('editing')
  })

  it('?edit=new 申请时令牌失效：交给页面确认会话，以只读打开并说明', async () => {
    const error = new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效')
    const context = setup({ editLease: { acquire: async () => Promise.reject(error) } })
    expect(await context.mode.open({ ...LOADED, canEdit: true }, { enterEdit: true })).toEqual({ kind: 'opened', entered: false, damaged: false })
    expect(context.hooks.writeProblem).toHaveBeenCalledExactlyOnceWith(error)
    expect(readingOf(context.mode)).toMatchObject({ notice: { kind: 'enter-failed', error } })
  })

  it('?edit=new 申请得到的修订号比载入的新、取服务端的内容失败（网络）：释放刚取得的编辑权，以只读打开载入的内容并说明（审查 A11）', async () => {
    const context = setup({ editLease: { acquire: async () => ({ ...ACQUIRED, revision: 5 }) }, api: { contentIfChanged: async () => Promise.reject(new NetworkError('断网')) } })
    expect(await context.mode.open({ ...LOADED, canEdit: true }, { enterEdit: true })).toEqual({ kind: 'opened', entered: false, damaged: false })
    expect(context.editLease.release).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, TOKEN)
    expect(context.factory.created.map(fake => [fake.access, fake.snapshot])).toEqual([['read', LOADED.snapshot]])
    expect(readingOf(context.mode).notice).toMatchObject({ kind: 'enter-failed' })
  })

  it('?edit=new 申请得到的修订号比载入的新、取服务端的内容时读不到了（404）：与载入失败相同', async () => {
    const context = setup({ editLease: { acquire: async () => ({ ...ACQUIRED, revision: 5 }) }, api: { contentIfChanged: async () => Promise.reject(GONE) } })
    expect(await context.mode.open({ ...LOADED, canEdit: true }, { enterEdit: true })).toEqual({ kind: 'load-failed', error: GONE })
    expect(context.factory.created).toEqual([])
  })

  it('?edit=new 申请得到的修订号比载入的新（这期间有人保存过）：按条件读取取服务端的内容，以它创建，它是保存的基准', async () => {
    const context = setup({ editLease: { acquire: async () => ({ ...ACQUIRED, revision: 5 }) } })
    await context.mode.open({ ...LOADED, canEdit: true }, { enterEdit: true })
    expect(context.api.contentIfChanged).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, 3)
    expect(context.factory.last().snapshot).toBe(snapshotOf('服务端的'))
    context.factory.last().edit('改')
    await context.mode.save()
    expect(context.api.save).toHaveBeenCalledWith(DOCUMENT_ID, expect.objectContaining({ baseRevision: 5 }), expect.anything(), { token: TOKEN, writeEpoch: 7 })
  })
})

describe('进入编辑（M3-P2 设计 §3.4）', () => {
  it('申请到、修订号等于本页的：用本页的内容（不读内容），重建为可编辑并交上视图状态；之后保存以这一修订为基准、带上令牌与代次', async () => {
    const context = setup()
    await opened(context)
    const reader = context.factory.last()
    await context.mode.enter()
    expect(context.api.contentIfChanged).not.toHaveBeenCalled()
    expect(reader.disposed).toBe(true)
    const writer = context.factory.last()
    expect([writer.access, writer.snapshot, writer.viewState]).toEqual(['edit', LOADED.snapshot, viewStateOf(0)])
    expect(context.mode.view()).toMatchObject({ mode: { kind: 'editing' }, save: { status: 'clean' } })
    writer.edit('甲')
    await context.mode.save()
    expect(context.api.save).toHaveBeenCalledWith(DOCUMENT_ID, expect.objectContaining({ baseRevision: 3, clientInstanceId: PAGE_ID, snapshot: snapshotOf('甲') }), expect.anything(), { token: TOKEN, writeEpoch: 7 })
  })

  it('申请到、修订号与本页的不同：按条件读取（If-None-Match 是本页的修订号）取服务端的内容，以它重建，它是保存的基准', async () => {
    const context = setup({ editLease: { acquire: async () => ({ ...ACQUIRED, revision: 5 }) } })
    await opened(context)
    await context.mode.enter()
    expect(context.api.contentIfChanged).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, 3)
    expect(context.factory.last()).toMatchObject({ access: 'edit', snapshot: snapshotOf('服务端的') })
    context.factory.last().edit('改')
    await context.mode.save()
    expect(context.api.save).toHaveBeenCalledWith(DOCUMENT_ID, expect.objectContaining({ baseRevision: 5 }), expect.anything(), expect.anything())
  })

  it('进入编辑中：申请期间状态是 entering（页面挂屏障、说明正在进入），只读的编辑器还在', async () => {
    const answer = deferred<AcquiredEditLease>()
    const context = setup({ editLease: { acquire: async () => answer.promise } })
    await opened(context)
    const entering = context.mode.enter()
    expect(modeOf(context.mode).kind).toBe('entering')
    expect(context.factory.last().disposed).toBe(false)
    answer.resolve(ACQUIRED)
    await entering
    expect(modeOf(context.mode).kind).toBe('editing')
  })

  it('别人正在编辑：留在阅读，说明谁在编辑（最后活动按服务端的时间算），不重建', async () => {
    const context = setup({ editLease: { acquire: async () => Promise.reject(HELD_BY_AMY) } })
    await opened(context)
    context.api.editStatus.mockResolvedValue(status(3, AMY_EDITING))
    await context.mode.enter()
    expect(readingOf(context.mode)).toMatchObject({ canEdit: true, holder: { holder: AMY, sameUser: false, lastActiveMinutes: 3 }, notice: undefined })
    expect(context.factory.created).toHaveLength(1)
  })

  it('别人正在编辑：谁在编辑用的是申请时服务端的回答（编辑状态还没读回来时也有）', async () => {
    const context = setup({ editLease: { acquire: async () => Promise.reject(HELD_BY_AMY) } })
    await opened(context)
    context.api.editStatus.mockImplementation(async () => deferred<FetchedEditStatus>().promise)
    await context.mode.enter()
    expect(readingOf(context.mode).holder).toEqual({ holder: AMY, sameUser: false, lastActiveMinutes: 3 })
  })

  it('不能编辑了（403）：留在阅读，"编辑"消失，说明服务端的原因', async () => {
    const context = setup({ editLease: { acquire: async () => Promise.reject(DENIED) } })
    await opened(context)
    context.api.editStatus.mockResolvedValue(status(3, null, false))
    await context.mode.enter()
    await settle()
    expect(readingOf(context.mode)).toMatchObject({ canEdit: false, notice: { kind: 'denied', error: DENIED } })
    expect(context.factory.created).toHaveLength(1)
  })

  it('读不到了（404）：说明文档已不可访问，没有"编辑"', async () => {
    const context = setup({ editLease: { acquire: async () => Promise.reject(GONE) } })
    await opened(context)
    context.api.editStatus.mockRejectedValue(GONE)
    await context.mode.enter()
    await settle()
    expect(readingOf(context.mode)).toMatchObject({ gone: true, canEdit: false })
  })

  it('网络（再试一次之后仍然未知）：留在阅读，说明没能进入编辑，可以再试', async () => {
    const context = setup({ editLease: { acquire: async () => Promise.reject(new NetworkError('断网')) } })
    await opened(context)
    const entering = context.mode.enter()
    await context.time.advance(1_000)
    await entering
    expect(readingOf(context.mode)).toMatchObject({ canEdit: true, notice: { kind: 'enter-failed' } })
    context.editLease.acquire.mockResolvedValueOnce(ACQUIRED)
    await context.mode.enter()
    expect(modeOf(context.mode).kind).toBe('editing')
  })

  it('未登录或令牌失效：交给页面确认会话，留在阅读', async () => {
    const error = new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效')
    const context = setup({ editLease: { acquire: async () => Promise.reject(error) } })
    await opened(context)
    await context.mode.enter()
    expect(context.hooks.writeProblem).toHaveBeenCalledExactlyOnceWith(error)
    expect(readingOf(context.mode).notice).toEqual({ kind: 'enter-failed', error })
  })

  it('以可编辑重建失败：释放刚取得的编辑权，以只读重建同一份内容，回到阅读并说明（可以再试）', async () => {
    const context = setup()
    await opened(context)
    context.factory.failNext()
    await context.mode.enter()
    expect(context.editLease.release).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, TOKEN)
    expect(context.factory.created.map(fake => fake.access)).toEqual(['read', 'read'])
    expect(readingOf(context.mode)).toMatchObject({ canEdit: true, notice: { kind: 'editor-failed' } })
    expect(context.reportError).toHaveBeenCalledOnce()
  })

  it('以可编辑重建失败、以只读重建也失败：failed（页面说明编辑器加载失败）', async () => {
    const context = setup()
    await opened(context)
    context.factory.failNext()
    const plain = context.factory.createEditor.getMockImplementation()
    context.factory.createEditor.mockImplementationOnce(async () => Promise.reject(new Error('又失败')))
    context.factory.createEditor.mockImplementationOnce(async () => Promise.reject(new Error('还失败')))
    void plain
    await context.mode.enter()
    expect(modeOf(context.mode).kind).toBe('failed')
  })

  it('取服务端的内容失败：释放刚取得的编辑权，留在阅读并说明', async () => {
    const context = setup({ editLease: { acquire: async () => ({ ...ACQUIRED, revision: 5 }) }, api: { contentIfChanged: async () => Promise.reject(new NetworkError('断网')) } })
    await opened(context)
    await context.mode.enter()
    expect(context.editLease.release).toHaveBeenCalledOnce()
    expect(readingOf(context.mode).notice).toMatchObject({ kind: 'enter-failed' })
    expect(context.factory.created).toHaveLength(1)
  })

  it('取内容期间编辑权失效（续租得知被收回）：放弃进入，留在阅读，说明编辑权已失效', async () => {
    const content = deferred<LoadedContent>()
    const context = setup({
      editLease: { acquire: async () => ({ ...ACQUIRED, revision: 5 }), renew: async () => Promise.reject(new ApiError(409, 'EDIT_LEASE_LOST', '编辑权已失效', { details: { reason: 'revoked' } })) },
      api: { contentIfChanged: async () => content.promise },
    })
    await opened(context)
    const entering = context.mode.enter()
    await context.time.advance(HEARTBEAT_MS)
    expect(readingOf(context.mode).notice).toEqual({ kind: 'enter-lost', loss: { kind: 'lease', reason: 'revoked' } })
    content.resolve({ snapshot: snapshotOf('服务端的'), revision: 5 })
    await entering
    expect(context.factory.created).toHaveLength(1)
    expect(modeOf(context.mode).kind).toBe('reading')
  })

  it('新建可编辑的编辑器期间编辑权失效：建好之后随即失去编辑权（捕获、以只读重建）', async () => {
    const context = setup({ editLease: { renew: async () => Promise.reject(new ApiError(409, 'EDIT_LEASE_LOST', '编辑权已失效', { details: { reason: 'revoked' } })) } })
    await opened(context)
    const gate = context.factory.holdNext()
    const entering = context.mode.enter()
    await context.time.advance(HEARTBEAT_MS)
    expect(context.mode.view().surface).toBe('creating')
    gate.release()
    await entering
    await settle()
    expect(context.factory.created.map(fake => fake.access)).toEqual(['read', 'edit', 'read'])
    expect(lostOf(context.mode)).toMatchObject({ loss: { kind: 'lease', reason: 'revoked' }, unsaved: false })
  })
})

describe('退出编辑（M3-P2 设计 §3.4）', () => {
  it('没有修改：不保存；捕获 → 释放（等它的结果）→ 以只读重建捕获的内容、交上视图状态；回到阅读', async () => {
    const answer = deferred<undefined>()
    const context = setup({ editLease: { release: async () => answer.promise } })
    await editing(context)
    const writer = context.factory.last()
    const exiting = context.mode.exit()
    await settle()
    expect(modeOf(context.mode).kind).toBe('exiting')
    expect(context.api.save).not.toHaveBeenCalled()
    expect(context.editLease.release).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, TOKEN)
    // 释放回来之前不重建
    expect(context.factory.created).toHaveLength(2)
    answer.resolve(undefined)
    await exiting
    expect(writer.disposed).toBe(true)
    expect(context.factory.last()).toMatchObject({ access: 'read', snapshot: LOADED.snapshot, viewState: viewStateOf(1) })
    expect(readingOf(context.mode)).toMatchObject({ canEdit: true, notice: undefined, releaseUnconfirmed: false })
    expect(context.mode.view().save).toBeUndefined()
  })

  it('有修改：先保存，存上了再退出；阅读的内容是捕获的、修订号是保存之后的（之后"有更新"按它比较）', async () => {
    const context = setup()
    await editing(context)
    context.factory.last().edit('乙')
    await context.mode.exit()
    expect(context.api.save).toHaveBeenCalledOnce()
    expect(context.factory.last()).toMatchObject({ access: 'read', snapshot: snapshotOf('乙') })
    context.api.editStatus.mockResolvedValue(status(4))
    await context.time.advance(READING_CHECK_INTERVAL_MS)
    expect(readingOf(context.mode).update).toBe('none')
    context.api.editStatus.mockResolvedValue(status(5))
    await context.time.advance(READING_CHECK_INTERVAL_MS)
    expect(readingOf(context.mode).update).toBe('available')
  })

  it('保存失败：留在编辑（说明由保存的状态给出），不释放、不重建', async () => {
    const context = setup({ api: { save: async () => Promise.reject(new NetworkError('断网')) } })
    await editing(context)
    context.factory.last().edit('乙')
    await context.mode.exit()
    expect(modeOf(context.mode).kind).toBe('editing')
    expect(context.mode.view().save?.status).toBe('failed')
    expect(context.editLease.release).not.toHaveBeenCalled()
    expect(context.factory.last().access).toBe('edit')
  })

  it('正在编辑的单元格：退出时随保存一起提交', async () => {
    const context = setup()
    await editing(context)
    const writer = context.factory.last()
    writer.cellEditing = true
    await context.mode.exit()
    expect(writer.editor.commitCellEditing).toHaveBeenCalledOnce()
    expect(context.api.save).toHaveBeenCalledOnce()
    expect(modeOf(context.mode).kind).toBe('reading')
  })

  it('退出的重建阶段（释放之后、只读的编辑器建好之前，surface 为 creating）：保存的状态还在——页头的"保存""正在退出编辑…"不卸载（审查 A2，复验 C5）；换好编辑器之后才去掉', async () => {
    const context = setup()
    await editing(context)
    const gate = context.factory.holdNext()
    const exiting = context.mode.exit()
    await settle()
    expect(context.editLease.release).toHaveBeenCalledOnce()
    expect(context.mode.view()).toMatchObject({ mode: { kind: 'exiting' }, surface: 'creating', save: { status: 'clean' } })
    gate.release()
    await exiting
    expect(context.mode.view()).toMatchObject({ mode: { kind: 'reading' }, surface: 'rendered', save: undefined })
  })

  it('释放的结果未知（网络错误）：照样退出（租约 90 秒内自行到期）；阅读里记下本页那一代没能确认放掉（审查 A13）', async () => {
    const context = setup({ editLease: { release: async () => Promise.reject(new NetworkError('断网')) } })
    await editing(context)
    // 服务端还记着本页那一代（释放没送到）：回到阅读时随即的那一次检查读到"自己在编辑"
    context.api.editStatus.mockResolvedValue(status(3, SELF_EDITING))
    await context.mode.exit()
    await settle()
    expect(readingOf(context.mode)).toMatchObject({ canEdit: true, releaseUnconfirmed: true })
  })

  it('释放迟迟没有回答：至多等 EXIT_RELEASE_WAIT_MS 就照样退出、以只读重建，阅读里记下那一代没能确认放掉（审查 A7）', async () => {
    const context = setup({ editLease: { release: async () => new Promise<void>(() => {}) } })
    await editing(context)
    // 服务端还记着本页那一代（释放没送到）
    context.api.editStatus.mockResolvedValue(status(3, SELF_EDITING))
    const exiting = context.mode.exit()
    await settle()
    expect(context.editLease.release).toHaveBeenCalledOnce()
    await context.time.advance(EXIT_RELEASE_WAIT_MS - 1)
    expect(modeOf(context.mode).kind).toBe('exiting')
    expect(context.factory.created).toHaveLength(2)
    await context.time.advance(1)
    await exiting
    expect(readingOf(context.mode)).toMatchObject({ canEdit: true, releaseUnconfirmed: true })
    expect(context.factory.last()).toMatchObject({ access: 'read', disposed: false })
  })

  it('释放在时限之内有了回答：不等满时限，计时器随之取消', async () => {
    const answer = deferred<undefined>()
    const context = setup({ editLease: { release: async () => answer.promise } })
    await editing(context)
    const exiting = context.mode.exit()
    await context.time.advance(EXIT_RELEASE_WAIT_MS / 2)
    answer.resolve(undefined)
    await exiting
    await settle()
    expect(readingOf(context.mode).releaseUnconfirmed).toBe(false)
    // 只剩阅读时检查的计时器：等释放的那个已经取消
    expect(context.time.pending()).toBe(1)
  })

  it('没能确认放掉之后：读到的持有者是自己时留着这个记号（页面按"本页刚退出"说明）；读到没有人在编辑了随之清掉（审查 A13）', async () => {
    const context = setup({ editLease: { release: async () => Promise.reject(new NetworkError('断网')) } })
    await editing(context)
    context.api.editStatus.mockResolvedValue(status(3, SELF_EDITING))
    await context.mode.exit()
    await settle()
    expect(readingOf(context.mode)).toMatchObject({ releaseUnconfirmed: true, holder: { sameUser: true } })
    context.api.editStatus.mockResolvedValue(status(3))
    await context.time.advance(READING_CHECK_INTERVAL_MS)
    expect(readingOf(context.mode)).toMatchObject({ releaseUnconfirmed: false, holder: undefined })
  })

  it('没能确认放掉之后再点"编辑"被占用：占着的不是本页（本页那一代还在时同一个标识照样取得），记号清掉', async () => {
    const context = setup({ editLease: { release: async () => Promise.reject(new NetworkError('断网')) } })
    await editing(context)
    context.api.editStatus.mockResolvedValue(status(3, SELF_EDITING))
    await context.mode.exit()
    await settle()
    context.editLease.acquire.mockRejectedValue(new ApiError(409, 'EDIT_LEASE_HELD', '自己在别处编辑', { details: { ...SELF_EDITING, canTakeOver: false, request: null }, serverTime: Date.parse(ANSWERED_AT) }))
    const entering = context.mode.enter()
    await context.time.advance(5_000)
    await entering
    expect(readingOf(context.mode)).toMatchObject({ releaseUnconfirmed: false, holder: { sameUser: true } })
  })

  it('没能确认放掉的记号有时限（复验 C4）：本页不再续租，那一代至多一个有效期就到期——到期之前一直读到自己时留着；到期的那一刻立即读一次（不等 30 秒的节奏），之后读到的自己不是本页那一代，记号清掉、不再回来', async () => {
    const context = setup({ editLease: { release: async () => Promise.reject(new NetworkError('断网')) } })
    await editing(context)
    context.api.editStatus.mockResolvedValue(status(3, SELF_EDITING))
    await context.mode.exit()
    await settle()
    expect(readingOf(context.mode)).toMatchObject({ releaseUnconfirmed: true, holder: { sameUser: true } })
    // 退出 10 秒之后页面隐藏又回到前台：检查的节奏改成 10、40、70、100 秒……，与到期的时刻（90 秒）错开
    await context.time.advance(10_000)
    context.page.set(true)
    context.page.set(false)
    await context.time.advance(EDIT_LEASE_TTL_SECONDS * 1000 - 10_000 - 1)
    expect(readingOf(context.mode).releaseUnconfirmed).toBe(true)
    const before = context.api.editStatus.mock.calls.length
    await context.time.advance(1)
    expect(context.api.editStatus).toHaveBeenCalledTimes(before + 1)
    expect(readingOf(context.mode)).toMatchObject({ releaseUnconfirmed: false, holder: { sameUser: true } })
    // 复验者的探针 P2：之后 10 分钟一直读到自己，记号不再回来
    await context.time.advance(10 * 60_000)
    expect(readingOf(context.mode).releaseUnconfirmed).toBe(false)
  })

  it('没能确认放掉之后又进入编辑、再退出（又没能确认）：到期从后一次退出算，前一次的计时作废（复验 C4）', async () => {
    const context = setup({ editLease: { release: async () => Promise.reject(new NetworkError('断网')) } })
    await editing(context)
    context.api.editStatus.mockResolvedValue(status(3, SELF_EDITING))
    await context.mode.exit()
    await settle()
    await context.time.advance(60_000)
    await context.mode.enter()
    expect(modeOf(context.mode).kind).toBe('editing')
    await context.mode.exit()
    await settle()
    expect(readingOf(context.mode).releaseUnconfirmed).toBe(true)
    // 前一次退出之后 90 秒（后一次之后 30 秒）：留着
    await context.time.advance(30_000)
    expect(readingOf(context.mode).releaseUnconfirmed).toBe(true)
    // 后一次退出之后 90 秒：清掉
    await context.time.advance(60_000)
    expect(readingOf(context.mode).releaseUnconfirmed).toBe(false)
  })

  it('前一次没能确认放掉的那一代已经到期，之后又进入编辑、再退出（又没能确认）：记号重新算起，到期之前留着（复验 C4）', async () => {
    const context = setup({ editLease: { release: async () => Promise.reject(new NetworkError('断网')) } })
    await editing(context)
    context.api.editStatus.mockResolvedValue(status(3, SELF_EDITING))
    await context.mode.exit()
    await settle()
    await context.time.advance(EDIT_LEASE_TTL_SECONDS * 1000)
    expect(readingOf(context.mode).releaseUnconfirmed).toBe(false)
    await context.mode.enter()
    expect(modeOf(context.mode).kind).toBe('editing')
    await context.mode.exit()
    await settle()
    expect(readingOf(context.mode).releaseUnconfirmed).toBe(true)
    await context.time.advance(EDIT_LEASE_TTL_SECONDS * 1000 - 1)
    expect(readingOf(context.mode).releaseUnconfirmed).toBe(true)
    await context.time.advance(1)
    expect(readingOf(context.mode).releaseUnconfirmed).toBe(false)
  })

  it('没能确认放掉之后页面卸载：那一代到期的计时随之取消', async () => {
    const context = setup({ editLease: { release: async () => Promise.reject(new NetworkError('断网')) } })
    await editing(context)
    await context.mode.exit()
    await settle()
    // 阅读时检查的计时与那一代到期的计时
    expect(context.time.pending()).toBe(2)
    context.mode.dispose()
    expect(context.time.pending()).toBe(0)
  })

  it('有保存在途：等它有了结果再看要不要保存；存上了就退出，不重复保存', async () => {
    const reply = deferred<SaveContentResponse>()
    const context = setup({ api: { save: async () => reply.promise } })
    await editing(context)
    context.factory.last().edit('丙')
    const saving = context.mode.save()
    await settle()
    const exiting = context.mode.exit()
    await settle()
    expect(context.factory.created).toHaveLength(2)
    reply.resolve(SAVED)
    await saving
    await exiting
    expect(context.api.save).toHaveBeenCalledOnce()
    expect(modeOf(context.mode).kind).toBe('reading')
  })

  it('捕获出错：留在编辑，上报', async () => {
    const context = setup()
    await editing(context)
    context.factory.last().failCapture = true
    await context.mode.exit()
    expect(modeOf(context.mode).kind).toBe('editing')
    expect(context.reportError).toHaveBeenCalledOnce()
    expect(context.editLease.release).not.toHaveBeenCalled()
  })
})

/** 让编辑权在下一次心跳时失效（续租回 403/404/EDIT_LEASE_LOST 一类，续不上） */
function loseOnNextHeartbeat(context: ReturnType<typeof setup>, error: unknown): void {
  context.editLease.renew.mockImplementation(async () => Promise.reject(error))
}

describe('失去编辑权（M3-P2 设计 §3.4）', () => {
  it('还读得到（403）、有修改：停止保存 → 捕获本页的内容 → 以只读重建、显示本页的内容并交上视图状态；给副本与放弃', async () => {
    const context = setup()
    await editing(context)
    const writer = context.factory.last()
    writer.edit('本页的')
    loseOnNextHeartbeat(context, DENIED)
    await context.time.advance(HEARTBEAT_MS)
    await settle()
    // 自动保存在修改停下 1 秒时捕获过一次（暂停的是定时的上传，捕获照常，M3-P4），失去编辑权时再捕获一次本页的内容
    expect(writer.editor.capture).toHaveBeenCalledTimes(2)
    expect(writer.disposed).toBe(true)
    expect(context.factory.last()).toMatchObject({ access: 'read', snapshot: snapshotOf('本页的'), viewState: viewStateOf(1) })
    expect(lostOf(context.mode)).toEqual({ kind: 'lost', loss: { kind: 'denied', error: DENIED }, unsaved: true, readable: true, checking: false, captureFailed: false, inputLeft: false, reopenFailed: false, copy: { kind: 'idle' }, reload: { kind: 'idle' } })
    expect(context.mode.hasUnsavedWork()).toBe(true)
    // 保存停住：之后的保存不发
    await context.mode.save()
    expect(context.api.save).not.toHaveBeenCalled()
  })

  it('捕获在销毁可编辑的编辑器之前（显示的是本页的内容，不是服务端的）；正在编辑的单元格先提交', async () => {
    const context = setup()
    await editing(context)
    const writer = context.factory.last()
    writer.cellEditing = true
    const order: string[] = []
    vi.mocked(writer.editor.commitCellEditing).mockImplementation(async () => {
      order.push('commit')
      writer.cellEditing = false
      return true
    })
    vi.mocked(writer.editor.capture).mockImplementation(() => {
      order.push('capture')
      return snapshotOf('本页的')
    })
    vi.mocked(writer.editor.dispose).mockImplementation(async () => {
      order.push('dispose')
      writer.disposed = true
    })
    loseOnNextHeartbeat(context, DENIED)
    await context.time.advance(HEARTBEAT_MS)
    await settle()
    expect(order).toEqual(['commit', 'capture', 'dispose'])
    expect(context.factory.last().snapshot).toBe(snapshotOf('本页的'))
    expect(context.api.content).not.toHaveBeenCalled()
  })

  it('读不到了（404）、有修改：显示本页的内容并说明，不给副本（不核对、不重新加载）；离开时仍提示', async () => {
    const context = setup()
    await editing(context)
    context.factory.last().edit('本页的')
    loseOnNextHeartbeat(context, GONE)
    await context.time.advance(HEARTBEAT_MS)
    await settle()
    expect(lostOf(context.mode)).toMatchObject({ readable: false, unsaved: true })
    expect(context.factory.last().snapshot).toBe(snapshotOf('本页的'))
    await context.mode.saveCopy()
    await context.mode.discard()
    expect(context.api.conflictCopy).not.toHaveBeenCalled()
    expect(context.api.content).not.toHaveBeenCalled()
    expect(context.mode.hasUnsavedWork()).toBe(true)
  })

  it('没有修改：unsaved 为假（只给重新加载）', async () => {
    const context = setup()
    await editing(context)
    loseOnNextHeartbeat(context, new ApiError(409, 'EDIT_LEASE_LOST', '编辑权已失效', { details: { reason: 'revoked' } }))
    await context.time.advance(HEARTBEAT_MS)
    await settle()
    expect(lostOf(context.mode)).toMatchObject({ unsaved: false, readable: true })
    expect(context.mode.hasUnsavedWork()).toBe(false)
  })

  it('保存先得知（403）：同样转入失去编辑权，保存失败的说明随之不再显示（页头只说失效）', async () => {
    const context = setup({ api: { save: async () => Promise.reject(DENIED) } })
    await editing(context)
    context.factory.last().edit('本页的')
    await context.mode.save()
    await settle()
    expect(lostOf(context.mode)).toMatchObject({ loss: { kind: 'denied' }, unsaved: true })
    expect(context.mode.view().save).toBeUndefined()
  })

  it('有一次结果未知的保存、还读得到：给副本之前先原样重发它；其实已经提交（拿到原来的结果）——按已保存处理，不给副本', async () => {
    const context = setup()
    await editing(context)
    context.factory.last().edit('本页的')
    context.api.save.mockRejectedValueOnce(new NetworkError('断网'))
    await context.mode.save()
    const first = context.api.save.mock.calls[0]
    const replay = deferred<SaveContentResponse>()
    context.api.save.mockImplementationOnce(async () => replay.promise)
    loseOnNextHeartbeat(context, DENIED)
    await context.time.advance(HEARTBEAT_MS)
    await settle()
    expect(lostOf(context.mode)).toMatchObject({ checking: true, unsaved: true })
    // 核对完之前不给副本
    await context.mode.saveCopy()
    expect(context.api.conflictCopy).not.toHaveBeenCalled()
    expect(context.api.save.mock.calls[1]?.[1]).toEqual(first?.[1])
    replay.resolve(SAVED)
    await settle()
    expect(lostOf(context.mode)).toMatchObject({ checking: false, unsaved: false })
  })

  it('结果未知的保存、原样重发被拒绝（它没有提交）：仍是没有保存，给副本', async () => {
    const context = setup()
    await editing(context)
    context.factory.last().edit('本页的')
    context.api.save.mockRejectedValueOnce(new NetworkError('断网'))
    await context.mode.save()
    context.api.save.mockRejectedValueOnce(DENIED)
    loseOnNextHeartbeat(context, DENIED)
    await context.time.advance(HEARTBEAT_MS)
    await settle()
    expect(lostOf(context.mode)).toMatchObject({ checking: false, unsaved: true })
    expect(context.api.save).toHaveBeenCalledTimes(2)
  })

  it('读不到了（404）时不核对结果未知的保存（重放也要求能访问），照样说没有保存', async () => {
    const context = setup()
    await editing(context)
    context.factory.last().edit('本页的')
    context.api.save.mockRejectedValueOnce(new NetworkError('断网'))
    await context.mode.save()
    loseOnNextHeartbeat(context, GONE)
    await context.time.advance(HEARTBEAT_MS)
    await settle()
    expect(context.api.save).toHaveBeenCalledOnce()
    expect(lostOf(context.mode)).toMatchObject({ readable: false, checking: false, unsaved: true })
  })

  it('捕获出错：编辑器留着（还能复制出来），不自动重建，不给副本', async () => {
    const context = setup()
    await editing(context)
    const writer = context.factory.last()
    writer.edit('本页的')
    // 自动保存的定时捕获先照常做了（M3-P4），之后 SDK 才开始出错：失去编辑权时的捕获出错
    await context.time.advance(1_000)
    expect(writer.editor.capture).toHaveBeenCalledOnce()
    writer.failCapture = true
    loseOnNextHeartbeat(context, DENIED)
    await context.time.advance(HEARTBEAT_MS - 1_000)
    await settle()
    expect(lostOf(context.mode)).toMatchObject({ captureFailed: true, unsaved: true })
    expect(context.mode.hasUnsavedWork()).toBe(true)
    expect(writer.disposed).toBe(false)
    expect(context.factory.created).toHaveLength(2)
    await context.mode.saveCopy()
    expect(context.api.conflictCopy).not.toHaveBeenCalled()
    expect(context.reportError).toHaveBeenCalledOnce()
  })

  it('捕获出错、本页没有没保存的修改：照实说没有（离开时不提示）', async () => {
    const context = setup()
    await editing(context)
    const writer = context.factory.last()
    writer.failCapture = true
    loseOnNextHeartbeat(context, DENIED)
    await context.time.advance(HEARTBEAT_MS)
    await settle()
    expect(lostOf(context.mode)).toMatchObject({ captureFailed: true, unsaved: false })
    expect(context.mode.hasUnsavedWork()).toBe(false)
  })

  it('有一次保存在途：先等它有了结果再算有没有没保存的——它存上了就是都已保存（不给副本，审查 A5）', async () => {
    const reply = deferred<SaveContentResponse>()
    const context = setup({ api: { save: async () => reply.promise } })
    await editing(context)
    context.factory.last().edit('本页的')
    const saving = context.mode.save()
    await settle()
    loseOnNextHeartbeat(context, DENIED)
    await context.time.advance(HEARTBEAT_MS)
    expect(modeOf(context.mode).kind).toBe('losing')
    reply.resolve(SAVED)
    await saving
    await settle()
    expect(lostOf(context.mode)).toMatchObject({ unsaved: false, checking: false })
    expect(context.mode.hasUnsavedWork()).toBe(false)
  })

  it('有一次保存在途、它被确定拒绝（没有存上）：等它之后算作没有保存，给副本', async () => {
    const reply = deferred<SaveContentResponse>()
    const context = setup({ api: { save: async () => reply.promise } })
    await editing(context)
    context.factory.last().edit('本页的')
    const saving = context.mode.save()
    await settle()
    loseOnNextHeartbeat(context, DENIED)
    await context.time.advance(HEARTBEAT_MS)
    reply.reject(new ApiError(422, 'SNAPSHOT_INVALID', '快照不合格'))
    await saving
    await settle()
    expect(lostOf(context.mode)).toMatchObject({ unsaved: true, checking: false })
  })

  it('离开提示：失去编辑权的过程中（捕获、等在途的保存、以只读重建）一律提示；有了结果之后按本页还有没有没保存的', async () => {
    const context = setup()
    await editing(context)
    const gate = context.factory.holdNext()
    loseOnNextHeartbeat(context, DENIED)
    await context.time.advance(HEARTBEAT_MS)
    expect(modeOf(context.mode).kind).toBe('losing')
    expect(context.mode.hasUnsavedWork()).toBe(true)
    gate.release()
    await settle()
    expect(lostOf(context.mode).unsaved).toBe(false)
    expect(context.mode.hasUnsavedWork()).toBe(false)
  })

  it('以只读重建失败（审查 A3）：留在失去编辑权、记下编辑器没能重新打开，没有编辑器；离开照样提示，副本照常给（上传捕获的内容），之后按最新的内容回到阅读', async () => {
    const context = setup()
    await editing(context)
    context.factory.last().edit('本页的')
    context.factory.failNext()
    loseOnNextHeartbeat(context, DENIED)
    await context.time.advance(HEARTBEAT_MS)
    await settle()
    expect(lostOf(context.mode)).toMatchObject({ reopenFailed: true, unsaved: true, readable: true, captureFailed: false })
    expect(context.mode.view().surface).toBe('none')
    expect(context.factory.created.filter(fake => !fake.disposed)).toEqual([])
    expect(context.reportError).toHaveBeenCalledOnce()
    expect(context.mode.hasUnsavedWork()).toBe(true)
    await context.mode.saveCopy()
    expect(context.api.conflictCopy).toHaveBeenCalledOnce()
    expect(context.api.compress).toHaveBeenLastCalledWith(snapshotOf('本页的'))
    expect(readingOf(context.mode).notice).toMatchObject({ kind: 'copied' })
    expect(context.factory.last()).toMatchObject({ access: 'read', snapshot: snapshotOf('最新的'), disposed: false })
  })

  it('以只读重建失败之后编辑器一直建不起来（复验 C1）：另存为副本成功、按最新的内容重建又失败——留在失去编辑权，副本的说明照旧（copy 为 done），编辑器没能重新打开、可以重新加载；离开不再提示（内容在副本里）', async () => {
    const context = setup()
    await editing(context)
    context.factory.last().edit('本页的')
    context.factory.failNext()
    loseOnNextHeartbeat(context, DENIED)
    await context.time.advance(HEARTBEAT_MS)
    await settle()
    expect(lostOf(context.mode)).toMatchObject({ reopenFailed: true, unsaved: true })
    // 建不起来的原因还在（例如公式 Worker 的脚本加载不了）：下一次创建同样失败
    context.factory.failNext()
    await context.mode.saveCopy()
    expect(context.api.conflictCopy).toHaveBeenCalledOnce()
    expect(lostOf(context.mode)).toMatchObject({ copy: { kind: 'done', document: { id: COPY.id } }, reopenFailed: true, reload: { kind: 'failed' } })
    expect(context.mode.view().surface).toBe('none')
    expect(context.mode.hasUnsavedWork()).toBe(false)
    expect(context.reportError).toHaveBeenCalledTimes(2)
  })

  it('以只读重建失败、本页没有修改：照实说都已保存，可以按最新的内容重新打开（放弃即重新加载）', async () => {
    const context = setup()
    await editing(context)
    context.factory.failNext()
    loseOnNextHeartbeat(context, DENIED)
    await context.time.advance(HEARTBEAT_MS)
    await settle()
    expect(lostOf(context.mode)).toMatchObject({ reopenFailed: true, unsaved: false })
    expect(context.mode.hasUnsavedWork()).toBe(false)
    // 不能编辑了（403）：之后的编辑状态里同样不能编辑
    context.api.editStatus.mockResolvedValue(status(3, null, false))
    await context.mode.discard()
    await settle()
    expect(readingOf(context.mode)).toMatchObject({ canEdit: false })
    expect(context.mode.view().surface).toBe('rendered')
  })

  it('单元格里的输入提交不了（commitCellEditing 返回 false，审查 A4）：捕获里没有它——算作没有保存、记下没取出的输入，离开时提示，副本照常给', async () => {
    const context = setup()
    await editing(context)
    const writer = context.factory.last()
    writer.cellEditing = true
    vi.mocked(writer.editor.commitCellEditing).mockResolvedValue(false)
    loseOnNextHeartbeat(context, DENIED)
    await context.time.advance(HEARTBEAT_MS)
    await settle()
    expect(lostOf(context.mode)).toMatchObject({ unsaved: true, inputLeft: true, captureFailed: false, reopenFailed: false })
    expect(context.mode.hasUnsavedWork()).toBe(true)
    await context.mode.saveCopy()
    expect(context.api.conflictCopy).toHaveBeenCalledOnce()
  })

  it('提交不了的输入、另有一次结果未知的保存核对出其实已经提交：仍算没有保存（那次输入不在任何一次保存里）', async () => {
    const context = setup()
    await editing(context)
    const writer = context.factory.last()
    writer.edit('本页的')
    context.api.save.mockRejectedValueOnce(new NetworkError('断网'))
    await context.mode.save()
    writer.cellEditing = true
    vi.mocked(writer.editor.commitCellEditing).mockResolvedValue(false)
    loseOnNextHeartbeat(context, DENIED)
    await context.time.advance(HEARTBEAT_MS)
    await settle()
    expect(context.api.save).toHaveBeenCalledTimes(2)
    expect(lostOf(context.mode)).toMatchObject({ checking: false, unsaved: true, inputLeft: true })
  })

  it('退出编辑的过程中失去编辑权（保存得到 403）：转入失去编辑权，不再接着退出', async () => {
    const context = setup({ api: { save: async () => Promise.reject(DENIED) } })
    await editing(context)
    context.factory.last().edit('本页的')
    await context.mode.exit()
    await settle()
    expect(lostOf(context.mode)).toMatchObject({ unsaved: true })
    expect(context.editLease.release).not.toHaveBeenCalled()
  })
})

describe('另存为副本与放弃（M3-P2 设计 §3.2、§3.4）', () => {
  async function lostWithChanges(options: Setup = {}): Promise<ReturnType<typeof setup>> {
    const context = setup(options)
    await editing(context)
    context.factory.last().edit('本页的')
    loseOnNextHeartbeat(context, DENIED)
    await context.time.advance(HEARTBEAT_MS)
    await settle()
    return context
  }

  it('另存为副本：上传捕获的本页内容，标题是原标题加"（冲突副本 失效时的时间）"；成功之后按服务端的最新内容（全文）重建为阅读，说明已另存为副本', async () => {
    const context = await lostWithChanges()
    context.api.editStatus.mockResolvedValue(status(9, null, false))
    await context.mode.saveCopy()
    await settle()
    expect(context.api.compress).toHaveBeenLastCalledWith(snapshotOf('本页的'))
    // 捕获时公式已经收齐（假的编辑器）：副本不带"公式待更新"（M3-P3）
    expect(context.api.conflictCopy).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, { requestId: expect.stringMatching(/^[\da-f-]{36}$/) as unknown, title: '周报（冲突副本 2026-10-04 15:30）', formulasPending: false }, expect.anything())
    expect(context.api.content).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID)
    expect(context.factory.last()).toMatchObject({ access: 'read', snapshot: snapshotOf('最新的') })
    expect(readingOf(context.mode)).toMatchObject({ canEdit: false, notice: { kind: 'copied', document: { ...COPY, replayed: false } } })
    expect(context.mode.hasUnsavedWork()).toBe(false)
  })

  it.each([
    ['公式还没收齐：带上', false, true],
    ['公式收齐了：不带', true, false],
  ])('副本的"公式待更新"（M3-P3 设计 §3.8，审查 B6）：按失去编辑权那一刻公式收齐没有（不等）——%s', async (_case, settled, pending) => {
    const context = setup()
    await editing(context)
    const writer = context.factory.last()
    writer.edit('本页的')
    writer.formulasSettled = settled
    loseOnNextHeartbeat(context, DENIED)
    await context.time.advance(HEARTBEAT_MS)
    await settle()
    expect(writer.editor.settleFormulas).toHaveBeenLastCalledWith(0)
    await context.mode.saveCopy()
    expect(context.api.conflictCopy).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, expect.objectContaining({ formulasPending: pending }), expect.anything())
  })

  it('副本的标题里的时间是失去编辑权的那一刻，不是点"另存为副本"的那一刻（审查 A5）', async () => {
    let now = new Date(2026, 9, 4, 15, 30, 12)
    const context = await lostWithChanges({ now: () => now })
    now = new Date(2026, 9, 4, 16, 45, 0)
    await context.mode.saveCopy()
    expect(context.api.conflictCopy).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, expect.objectContaining({ title: '周报（冲突副本 2026-10-04 15:30）' }), expect.anything())
  })

  it('另存为副本进行中：再点不重复上传', async () => {
    const reply = deferred<CreatedDocument>()
    const context = await lostWithChanges({ api: { conflictCopy: async () => reply.promise } })
    const saving = context.mode.saveCopy()
    await settle()
    expect(lostOf(context.mode).copy).toEqual({ kind: 'saving' })
    await context.mode.saveCopy()
    reply.resolve({ ...COPY, replayed: false })
    await saving
    expect(context.api.conflictCopy).toHaveBeenCalledOnce()
  })

  it('确定被拒绝、再试可能成功（请求标识被占用）：说明原因，内容留着，可以再试；再试换新的 requestId', async () => {
    const context = await lostWithChanges()
    context.api.conflictCopy.mockRejectedValueOnce(new ApiError(409, 'REQUEST_ID_CONFLICT', '请求已失效'))
    await context.mode.saveCopy()
    expect(lostOf(context.mode).copy).toMatchObject({ kind: 'failed' })
    await context.mode.saveCopy()
    const [first, second] = context.api.conflictCopy.mock.calls.map(call => call[1].requestId)
    expect(second).not.toBe(first)
    expect(modeOf(context.mode).kind).toBe('reading')
  })

  it('本页过旧（CLIENT_OUTDATED：服务端对副本同样拦旧页面）：再试也一样——记为被拒（outdated），不再上传，内容留着、离开照样提示（审查 B3）', async () => {
    const context = await lostWithChanges()
    const outdated = new ApiError(409, 'CLIENT_OUTDATED', '页面的版本过旧', { details: { reason: 'build' } })
    context.api.conflictCopy.mockRejectedValueOnce(outdated)
    await context.mode.saveCopy()
    expect(lostOf(context.mode)).toMatchObject({ copy: { kind: 'refused', refusal: 'outdated', error: outdated }, unsaved: true })
    await context.mode.saveCopy()
    expect(context.api.conflictCopy).toHaveBeenCalledOnce()
    expect(context.mode.hasUnsavedWork()).toBe(true)
    expect(context.hooks.writeProblem).not.toHaveBeenCalled()
  })

  it.each([
    ['内容不合规则（SNAPSHOT_INVALID）', new ApiError(422, 'SNAPSHOT_INVALID', '快照不合格', { details: { rule: 'link-address' } })],
    ['超过容量上限（PAYLOAD_TOO_LARGE）', new ApiError(413, 'PAYLOAD_TOO_LARGE', '太大')],
  ])('%s：捕获的内容不会再变，再试也一样——记为被拒（content），不再上传；还能放弃本页的修改（审查 B3）', async (_case, error) => {
    const context = await lostWithChanges()
    context.api.conflictCopy.mockRejectedValueOnce(error)
    await context.mode.saveCopy()
    expect(lostOf(context.mode).copy).toEqual({ kind: 'refused', refusal: 'content', error })
    await context.mode.saveCopy()
    expect(context.api.conflictCopy).toHaveBeenCalledOnce()
    expect(context.mode.hasUnsavedWork()).toBe(true)
    await context.mode.discard()
    expect(readingOf(context.mode)).toMatchObject({ notice: undefined })
    expect(context.mode.hasUnsavedWork()).toBe(false)
  })

  it('结果未知：再试沿用同一个 requestId（服务端只建一份）；读不到（404，取锁之前被移走的竞态）同样留着内容、可以再试', async () => {
    const context = await lostWithChanges()
    context.api.conflictCopy.mockRejectedValueOnce(new NetworkError('断网'))
    await context.mode.saveCopy()
    expect(lostOf(context.mode).copy).toMatchObject({ kind: 'failed' })
    context.api.conflictCopy.mockRejectedValueOnce(GONE)
    await context.mode.saveCopy()
    expect(lostOf(context.mode)).toMatchObject({ copy: { kind: 'failed', error: GONE }, unsaved: true })
    const ids = context.api.conflictCopy.mock.calls.map(call => call[1].requestId)
    expect(ids[1]).toBe(ids[0])
  })

  it('未登录或令牌失效：交给页面确认会话，留着内容', async () => {
    const context = await lostWithChanges()
    const error = new ApiError(401, 'SESSION_EXPIRED', '登录已过期')
    context.api.conflictCopy.mockRejectedValueOnce(error)
    await context.mode.saveCopy()
    expect(context.hooks.writeProblem).toHaveBeenCalledExactlyOnceWith(error)
    expect(lostOf(context.mode).copy).toMatchObject({ kind: 'failed' })
  })

  it('副本建好之后取最新的内容失败：留在这里（副本已经建好、说明照旧），可以重新加载', async () => {
    const context = await lostWithChanges({ api: { content: async () => Promise.reject(new NetworkError('断网')) } })
    await context.mode.saveCopy()
    expect(lostOf(context.mode)).toMatchObject({ copy: { kind: 'done' }, reload: { kind: 'failed' } })
    expect(context.mode.hasUnsavedWork()).toBe(false)
    context.api.content.mockResolvedValueOnce({ snapshot: snapshotOf('最新的'), revision: 9 })
    await context.mode.discard()
    expect(readingOf(context.mode).notice).toMatchObject({ kind: 'copied' })
  })

  it('副本建好之后按最新的内容重建失败（复验 C1）：留在这里——副本的说明与链接照旧，编辑器没能重新打开（没有编辑器），可以重新加载；再失败照样留着，建得起来时回到阅读、说明已另存为副本', async () => {
    const context = await lostWithChanges()
    context.factory.failNext()
    await context.mode.saveCopy()
    expect(lostOf(context.mode)).toMatchObject({ copy: { kind: 'done', document: { id: COPY.id } }, reopenFailed: true, reload: { kind: 'failed' } })
    expect(context.mode.view().surface).toBe('none')
    expect(context.factory.created.filter(fake => !fake.disposed)).toEqual([])
    expect(context.mode.hasUnsavedWork()).toBe(false)
    context.factory.failNext()
    await context.mode.discard()
    expect(lostOf(context.mode)).toMatchObject({ copy: { kind: 'done', document: { id: COPY.id } }, reopenFailed: true, reload: { kind: 'failed' } })
    await context.mode.discard()
    expect(readingOf(context.mode).notice).toMatchObject({ kind: 'copied', document: { id: COPY.id } })
    expect(context.factory.last()).toMatchObject({ access: 'read', snapshot: snapshotOf('最新的'), disposed: false })
    expect(context.api.conflictCopy).toHaveBeenCalledOnce()
  })

  it('没有副本（放弃本页的修改）时按最新的内容重建失败：本页的内容本来就不要了，按编辑器加载失败说明（failed）', async () => {
    const context = await lostWithChanges()
    context.factory.failNext()
    await context.mode.discard()
    expect(modeOf(context.mode).kind).toBe('failed')
    expect(context.mode.hasUnsavedWork()).toBe(false)
    expect(context.api.conflictCopy).not.toHaveBeenCalled()
  })

  it('放弃本页的修改：按服务端的最新内容（全文读取，不用条件读取：本页的内容不是服务端的哪一版）重建为阅读；失效的原因是不能编辑了，没有"编辑"', async () => {
    const context = await lostWithChanges()
    // 编辑状态的回答晚一点到：先看重建时按失效的原因给的
    const answer = deferred<FetchedEditStatus>()
    context.api.editStatus.mockImplementation(async () => answer.promise)
    await context.mode.discard()
    expect(context.api.content).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID)
    expect(context.api.contentIfChanged).not.toHaveBeenCalled()
    expect(context.factory.last()).toMatchObject({ access: 'read', snapshot: snapshotOf('最新的') })
    expect(readingOf(context.mode)).toMatchObject({ notice: undefined, canEdit: false })
  })

  it('放弃时读不到了（404）：内容不存在（unavailable）', async () => {
    const context = await lostWithChanges({ api: { content: async () => Promise.reject(GONE) } })
    await context.mode.discard()
    expect(modeOf(context.mode).kind).toBe('unavailable')
  })

  it('放弃时网络失败：留在这里，说明原因，可以再试', async () => {
    const context = await lostWithChanges({ api: { content: async () => Promise.reject(new NetworkError('断网')) } })
    await context.mode.discard()
    expect(lostOf(context.mode).reload).toMatchObject({ kind: 'failed' })
  })

  it('续上时别人正在编辑（held）之后放弃：阅读里说明谁在编辑，可以再点"编辑"', async () => {
    const context = setup()
    await editing(context)
    context.editLease.renew.mockRejectedValue(new ApiError(409, 'EDIT_LEASE_LOST', '编辑权已失效', { details: { reason: 'expired' } }))
    context.editLease.acquire.mockRejectedValue(HELD_BY_AMY)
    await context.time.advance(HEARTBEAT_MS)
    await settle()
    context.api.editStatus.mockResolvedValue(status(9, AMY_EDITING))
    await context.mode.discard()
    await settle()
    expect(readingOf(context.mode)).toMatchObject({ canEdit: true, holder: { holder: AMY, sameUser: false, lastActiveMinutes: 3 } })
  })
})

describe('阅读时的检查（US-M3-05）', () => {
  it('每 30 秒读一次编辑状态：修订号比本页新时提示有更新；持有者、最后活动与能否编辑随之更新', async () => {
    const context = setup()
    await opened(context)
    expect(context.api.editStatus).toHaveBeenCalledOnce()
    context.api.editStatus.mockResolvedValue(status(4, AMY_EDITING, false))
    await context.time.advance(READING_CHECK_INTERVAL_MS - 1)
    expect(context.api.editStatus).toHaveBeenCalledOnce()
    await context.time.advance(1)
    expect(context.api.editStatus).toHaveBeenCalledTimes(2)
    expect(readingOf(context.mode)).toMatchObject({ update: 'available', canEdit: false, holder: { holder: AMY, sameUser: false, lastActiveMinutes: 3 } })
    context.api.editStatus.mockResolvedValue(status(4))
    await context.time.advance(READING_CHECK_INTERVAL_MS)
    expect(readingOf(context.mode)).toMatchObject({ canEdit: true, holder: undefined, update: 'available' })
  })

  it('页面隐藏时暂停（不读），回到前台立即读一次，之后照常每 30 秒', async () => {
    const context = setup()
    await opened(context)
    context.page.set(true)
    await context.time.advance(READING_CHECK_INTERVAL_MS * 3)
    expect(context.api.editStatus).toHaveBeenCalledOnce()
    context.page.set(false)
    await settle()
    expect(context.api.editStatus).toHaveBeenCalledTimes(2)
    await context.time.advance(READING_CHECK_INTERVAL_MS)
    expect(context.api.editStatus).toHaveBeenCalledTimes(3)
  })

  it('会话不是本人时暂停，回到本人时立即读一次', async () => {
    const context = setup()
    await opened(context)
    context.mode.setSession('signed-out')
    await context.time.advance(READING_CHECK_INTERVAL_MS * 2)
    expect(context.api.editStatus).toHaveBeenCalledOnce()
    context.mode.setSession('active')
    await settle()
    expect(context.api.editStatus).toHaveBeenCalledTimes(2)
  })

  it('读编辑状态的请求在途时页面隐藏：它回来之后不再排下一次，回到前台才读', async () => {
    const context = setup()
    await opened(context)
    const answering = deferred<FetchedEditStatus>()
    context.api.editStatus.mockImplementationOnce(async () => answering.promise)
    await context.time.advance(READING_CHECK_INTERVAL_MS)
    expect(context.api.editStatus).toHaveBeenCalledTimes(2)
    context.page.set(true)
    answering.resolve(status(3))
    await settle()
    await context.time.advance(READING_CHECK_INTERVAL_MS * 3)
    expect(context.api.editStatus).toHaveBeenCalledTimes(2)
    context.page.set(false)
    await settle()
    expect(context.api.editStatus).toHaveBeenCalledTimes(3)
  })

  it('读编辑状态的请求在途时进入编辑：它回来之后不再排下一次，编辑时不读', async () => {
    const context = setup()
    await opened(context)
    const answering = deferred<FetchedEditStatus>()
    context.api.editStatus.mockImplementationOnce(async () => answering.promise)
    await context.time.advance(READING_CHECK_INTERVAL_MS)
    expect(context.api.editStatus).toHaveBeenCalledTimes(2)
    await context.mode.enter()
    expect(modeOf(context.mode).kind).toBe('editing')
    answering.resolve(status(3))
    await settle()
    await context.time.advance(READING_CHECK_INTERVAL_MS * 3)
    expect(context.api.editStatus).toHaveBeenCalledTimes(2)
  })

  it('离开阅读时停掉检查的计时器：进入编辑之后只剩编辑权的心跳（与空闲释放的截止时刻，M3-P5）', async () => {
    const context = setup()
    await opened(context)
    expect(context.time.pending()).toBe(1)
    const reads = context.api.editStatus.mock.calls.length
    await context.mode.enter()
    expect(modeOf(context.mode).kind).toBe('editing')
    // 自动保存建起来时立即看一次（M3-P4）：没有要捕获、要上传的，之后不再排计时器
    await context.time.advance(0)
    expect(context.time.pending()).toBe(2)
    await context.time.advance(HEARTBEAT_MS)
    expect(context.editLease.renew).toHaveBeenCalledOnce()
    expect(context.time.pending()).toBe(2)
    await context.time.advance(READING_CHECK_INTERVAL_MS)
    expect(context.api.editStatus).toHaveBeenCalledTimes(reads)
  })

  it('编辑时不读编辑状态；退出编辑回到阅读时立即读一次', async () => {
    const context = setup()
    await editing(context)
    const before = context.api.editStatus.mock.calls.length
    await context.time.advance(READING_CHECK_INTERVAL_MS * 3)
    expect(context.api.editStatus).toHaveBeenCalledTimes(before)
    await context.mode.exit()
    await settle()
    expect(context.api.editStatus).toHaveBeenCalledTimes(before + 1)
  })

  it('读不到了（404）：说明已不可访问，没有"编辑"；之后照常检查，恢复访问时随之恢复', async () => {
    const context = setup({ api: { editStatus: async () => Promise.reject(GONE) } })
    await opened(context)
    expect(readingOf(context.mode)).toMatchObject({ gone: true, canEdit: false })
    context.api.editStatus.mockResolvedValue(status(3))
    await context.time.advance(READING_CHECK_INTERVAL_MS)
    expect(readingOf(context.mode)).toMatchObject({ gone: false, canEdit: true })
  })

  it('未登录：交给页面确认会话；网络等失败：下一次照常再试', async () => {
    const unauthenticated = new ApiError(401, 'SESSION_EXPIRED', '登录已过期')
    const context = setup({ api: { editStatus: async () => Promise.reject(unauthenticated) } })
    await opened(context)
    expect(context.hooks.readProblem).toHaveBeenCalledExactlyOnceWith(unauthenticated)
    context.api.editStatus.mockRejectedValue(new NetworkError('断网'))
    await context.time.advance(READING_CHECK_INTERVAL_MS)
    context.api.editStatus.mockResolvedValue(status(3))
    await context.time.advance(READING_CHECK_INTERVAL_MS)
    expect(context.api.editStatus).toHaveBeenCalledTimes(3)
    expect(readingOf(context.mode).gone).toBe(false)
  })

  it('又能编辑了：进入编辑时的"不能编辑了"随之不再说', async () => {
    const context = setup({ editLease: { acquire: async () => Promise.reject(DENIED) } })
    await opened(context)
    context.api.editStatus.mockResolvedValue(status(3, null, false))
    await context.mode.enter()
    await settle()
    expect(readingOf(context.mode).notice).toMatchObject({ kind: 'denied' })
    context.api.editStatus.mockResolvedValue(status(3, null, true))
    await context.time.advance(READING_CHECK_INTERVAL_MS)
    expect(readingOf(context.mode)).toMatchObject({ canEdit: true, notice: undefined })
  })
})

describe('有更新，点击刷新（US-M3-05，DEF-017）', () => {
  async function withUpdate(options: Setup = {}): Promise<ReturnType<typeof setup>> {
    const context = setup({ ...options, api: { editStatus: async () => status(5), ...options.api } })
    await opened(context)
    expect(readingOf(context.mode).update).toBe('available')
    return context
  }

  it('按条件读取（If-None-Match 是本页的修订号）取新的版本，重建为阅读并交上视图状态；之后以新的修订号比较', async () => {
    const context = await withUpdate()
    await context.mode.refresh()
    expect(context.api.contentIfChanged).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, 3)
    expect(context.factory.last()).toMatchObject({ access: 'read', snapshot: snapshotOf('服务端的'), viewState: viewStateOf(0) })
    expect(readingOf(context.mode).update).toBe('none')
    await context.time.advance(READING_CHECK_INTERVAL_MS)
    expect(readingOf(context.mode).update).toBe('none')
  })

  it('服务端说没有变化（304）：不重建，提示消失', async () => {
    const context = await withUpdate({ api: { contentIfChanged: async () => CONTENT_UNCHANGED } })
    await context.mode.refresh()
    expect(context.factory.created).toHaveLength(1)
    expect(readingOf(context.mode).update).toBe('none')
  })

  it('取不到（网络）：说明原因，提示留着可以再试；读不到了（404）：说明已不可访问', async () => {
    const context = await withUpdate({ api: { contentIfChanged: async () => Promise.reject(new NetworkError('断网')) } })
    await context.mode.refresh()
    expect(readingOf(context.mode)).toMatchObject({ update: 'available', notice: { kind: 'refresh-failed' } })
    context.api.contentIfChanged.mockRejectedValueOnce(GONE)
    await context.mode.refresh()
    expect(readingOf(context.mode)).toMatchObject({ gone: true, update: 'none', canEdit: false })
  })

  it('没有更新时点不了', async () => {
    const context = setup()
    await opened(context)
    await context.mode.refresh()
    expect(context.api.contentIfChanged).not.toHaveBeenCalled()
  })

  it('重建期间的检查：update 留着 loading（重建完了以新的修订号为准）；收尾用当时的阅读状态——检查读到的持有者、能不能编辑留着（审查 A1、A9）', async () => {
    const context = await withUpdate()
    const gate = context.factory.holdNext()
    const refreshing = context.mode.refresh()
    await settle()
    expect(context.mode.view().surface).toBe('creating')
    context.api.editStatus.mockResolvedValue(status(5, AMY_EDITING, true))
    await context.time.advance(READING_CHECK_INTERVAL_MS)
    expect(readingOf(context.mode)).toMatchObject({ update: 'loading', holder: { holder: AMY } })
    gate.release()
    await refreshing
    expect(readingOf(context.mode)).toMatchObject({ update: 'none', holder: { holder: AMY, sameUser: false }, canEdit: true })
  })

  it('取内容期间的检查读到不能编辑了：收尾照样不能编辑', async () => {
    const content = deferred<LoadedContent>()
    const context = await withUpdate({ api: { contentIfChanged: async () => content.promise } })
    const refreshing = context.mode.refresh()
    context.api.editStatus.mockResolvedValue(status(5, null, false))
    await context.time.advance(READING_CHECK_INTERVAL_MS)
    expect(readingOf(context.mode)).toMatchObject({ update: 'loading', canEdit: false })
    content.resolve({ snapshot: snapshotOf('服务端的'), revision: 5 })
    await refreshing
    expect(readingOf(context.mode)).toMatchObject({ update: 'none', canEdit: false })
  })
})

describe('有更新、正在载入时点"编辑"（审查 A1：两次重建叠在同一个容器里）', () => {
  /** 阅读、有更新（修订 5），点了刷新、停在取内容或重建；申请编辑权的结果由用例给出 */
  async function refreshingWith(acquire: () => Promise<AcquiredEditLease>, hold: 'content' | 'rebuild') {
    const content = deferred<LoadedContent>()
    const context = setup({
      api: { editStatus: async () => status(5), contentIfChanged: async () => hold === 'content' ? content.promise : { snapshot: snapshotOf('服务端的'), revision: 5 } },
      editLease: { acquire },
    })
    await opened(context)
    expect(readingOf(context.mode).update).toBe('available')
    const gate = hold === 'rebuild' ? context.factory.holdNext() : undefined
    const refreshing = context.mode.refresh()
    await settle()
    expect(readingOf(context.mode).update).toBe('loading')
    expect(context.mode.view().surface).toBe(hold === 'rebuild' ? 'creating' : 'rendered')
    return {
      context,
      finish: async () => {
        content.resolve({ snapshot: snapshotOf('服务端的'), revision: 5 })
        gate?.release()
        await refreshing
        await settle()
      },
    }
  }

  it.each([
    ['取内容阶段、本来能取得编辑权', 'content', async () => ACQUIRED],
    ['取内容阶段、本来会被占用（H1）', 'content', async () => Promise.reject(HELD_BY_AMY)],
    ['取内容阶段、本来不能编辑了（H1b）', 'content', async () => Promise.reject(DENIED)],
    ['重建阶段、本来能取得编辑权（H2）', 'rebuild', async () => ({ ...ACQUIRED, revision: 5 })],
    ['重建阶段、本来会被占用（H2b）', 'rebuild', async () => Promise.reject(HELD_BY_AMY)],
  ] as const)('%s：不进入（不申请），刷新照常完成——只建了一个新的只读编辑器，"有更新"不卡在载入中；之后照常能进入编辑', async (_case, hold, acquire) => {
    const { context, finish } = await refreshingWith(acquire, hold)
    await context.mode.enter()
    expect(context.editLease.acquire).not.toHaveBeenCalled()
    expect(readingOf(context.mode).update).toBe('loading')
    await finish()
    expect(readingOf(context.mode)).toMatchObject({ update: 'none', canEdit: true })
    expect(context.factory.created.map(fake => [fake.access, fake.disposed])).toEqual([['read', true], ['read', false]])
    expect(context.mode.view().surface).toBe('rendered')
    // 之后的检查照常：没有新的版本就不提示
    await context.time.advance(READING_CHECK_INTERVAL_MS)
    expect(readingOf(context.mode).update).toBe('none')
    context.editLease.acquire.mockResolvedValueOnce({ ...ACQUIRED, revision: 5 })
    await context.mode.enter()
    expect(modeOf(context.mode).kind).toBe('editing')
    expect(context.factory.created.filter(fake => !fake.disposed).map(fake => fake.access)).toEqual(['edit'])
  })
})

describe('阅读时检查的旧结果（审查 A9）', () => {
  it('阅读时有一次检查在途，进入编辑又退出：回到阅读之后立即读的那一次为准，在途的那次回来时丢弃（不套用过时的持有者与能否编辑）', async () => {
    const context = setup()
    await opened(context)
    const stale = deferred<FetchedEditStatus>()
    context.api.editStatus.mockImplementationOnce(async () => stale.promise)
    await context.time.advance(READING_CHECK_INTERVAL_MS)
    expect(context.api.editStatus).toHaveBeenCalledTimes(2)
    await context.mode.enter()
    await context.mode.exit()
    await settle()
    expect(context.api.editStatus).toHaveBeenCalledTimes(3)
    expect(readingOf(context.mode)).toMatchObject({ canEdit: true, holder: undefined })
    stale.resolve(status(3, AMY_EDITING, false))
    await settle()
    expect(readingOf(context.mode)).toMatchObject({ canEdit: true, holder: undefined })
    // 之后照常每 30 秒一次（只有一个计时器）
    expect(context.time.pending()).toBe(1)
  })
})

describe('会话与编辑权', () => {
  it('换了人：停住保存；没有人登录：不停（按保存会先确认）；都暂停续租。回到本人：恢复保存', async () => {
    const context = setup()
    await editing(context)
    context.factory.last().edit('甲')
    context.mode.setSession('other-user')
    expect(context.mode.view().save?.canSave).toBe(false)
    await context.time.advance(HEARTBEAT_MS * 2)
    expect(context.editLease.renew).not.toHaveBeenCalled()
    context.mode.setSession('active')
    expect(context.mode.view().save?.canSave).toBe(true)
    context.mode.setSession('signed-out')
    expect(context.mode.view().save?.canSave).toBe(true)
  })

  it('页面确认是本人之后恢复续租：立即续租一次', async () => {
    const context = setup()
    await editing(context)
    context.mode.setSession('signed-out')
    context.mode.setSession('active')
    await context.mode.resumeLease()
    expect(context.editLease.renew).toHaveBeenCalledOnce()
  })

  it('页面隐藏、关闭：尽力释放编辑权；卸载时同样释放，销毁编辑器', async () => {
    const context = setup()
    await editing(context)
    const writer = context.factory.last()
    context.mode.releaseOnHide()
    expect(context.editLease.release).toHaveBeenCalledOnce()
    context.mode.dispose()
    expect(writer.disposed).toBe(true)
    expect(context.editLease.release).toHaveBeenCalledOnce()
  })

  it('页头的详情刷新得知能不能编辑变了：阅读时随之更新', async () => {
    const context = setup()
    await opened(context)
    context.mode.updateCanEdit(false)
    expect(readingOf(context.mode).canEdit).toBe(false)
  })
})

describe('编辑时的保存与编辑权（M3-P1 的接入，原在编辑器页）', () => {
  it('保存得到可以续上的失效（到期）：重新申请（到期的那一代谁看都是空着的，不先放，M3-P5 审查 A3），续上之后用新的编辑权重发这一次（requestId 不变），保存成功', async () => {
    const next = { ...ACQUIRED, token: 'M'.repeat(43), writeEpoch: 8 }
    const context = setup()
    await editing(context)
    context.editLease.acquire.mockResolvedValueOnce(next)
    context.api.save.mockRejectedValueOnce(new ApiError(409, 'EDIT_LEASE_LOST', '编辑权已失效', { details: { reason: 'expired' } }))
    context.factory.last().edit('甲')
    await context.mode.save()
    expect(context.editLease.release).not.toHaveBeenCalled()
    expect(context.editLease.acquire).toHaveBeenCalledTimes(2)
    const [first, second] = context.api.save.mock.calls
    expect(second?.[1].requestId).toBe(first?.[1].requestId)
    expect(second?.[3]).toEqual({ token: next.token, writeEpoch: 8 })
    expect(context.mode.view()).toMatchObject({ mode: { kind: 'editing' }, save: { status: 'clean' } })
  })

  it('保存一直得到可以续上的失效、续上一直成功：至多重发一次（保存 2 次），以失败交回，不形成请求风暴（审查 B4）', async () => {
    const context = setup()
    await editing(context)
    context.api.save.mockRejectedValue(new ApiError(409, 'EDIT_LEASE_LOST', '编辑权已失效', { details: { reason: 'replaced' } }))
    context.factory.last().edit('甲')
    await context.mode.save()
    expect(context.api.save).toHaveBeenCalledTimes(2)
    expect(context.mode.view().save?.status).toBe('failed')
  })

  it('续上时比较的是服务端确认过的最新修订：本页保存过（修订号 4），续上时申请得到 4 就续上', async () => {
    const context = setup()
    await editing(context)
    context.factory.last().edit('甲')
    await context.mode.save()
    context.editLease.renew.mockRejectedValueOnce(new ApiError(409, 'EDIT_LEASE_LOST', '编辑权已失效', { details: { reason: 'expired' } }))
    context.editLease.acquire.mockResolvedValueOnce({ ...ACQUIRED, revision: 4, token: 'N'.repeat(43), writeEpoch: 9 })
    await context.time.advance(HEARTBEAT_MS)
    await settle()
    expect(modeOf(context.mode).kind).toBe('editing')
  })

  it('续上时修订号变了（别处保存过）：不覆盖，转入失去编辑权（newer），可以另存为副本', async () => {
    const context = setup()
    await editing(context)
    context.factory.last().edit('甲')
    context.editLease.renew.mockRejectedValueOnce(new ApiError(409, 'EDIT_LEASE_LOST', '编辑权已失效', { details: { reason: 'expired' } }))
    context.editLease.acquire.mockResolvedValueOnce({ ...ACQUIRED, revision: 6, token: 'N'.repeat(43), writeEpoch: 9 })
    await context.time.advance(HEARTBEAT_MS)
    await settle()
    expect(lostOf(context.mode)).toMatchObject({ loss: { kind: 'newer' }, unsaved: true, readable: true })
  })

  it('保存得到未登录、令牌失效：交给页面确认会话', async () => {
    const context = setup()
    await editing(context)
    context.factory.last().edit('甲')
    context.api.save.mockRejectedValueOnce(new ApiError(401, 'SESSION_EXPIRED', '登录已过期'))
    await context.mode.save()
    expect(context.hooks.saveUnauthenticated).toHaveBeenCalledOnce()
    context.api.save.mockRejectedValueOnce(new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效'))
    await context.mode.save()
    expect(context.hooks.saveStale).toHaveBeenCalledOnce()
  })

  it('离开提示：编辑时按保存的状态机；进入编辑中没有修改', async () => {
    const context = setup()
    await opened(context)
    expect(context.mode.hasUnsavedWork()).toBe(false)
    const answer = deferred<AcquiredEditLease>()
    context.editLease.acquire.mockImplementationOnce(async () => answer.promise)
    const entering = context.mode.enter()
    expect(modeOf(context.mode).kind).toBe('entering')
    expect(context.mode.hasUnsavedWork()).toBe(false)
    answer.resolve(ACQUIRED)
    await entering
    expect(context.mode.hasUnsavedWork()).toBe(false)
    context.factory.last().edit('甲')
    expect(context.mode.hasUnsavedWork()).toBe(true)
  })

  it('离开提示：退出编辑中还在保存时有；保存完、等释放与重建的时候没有（内容都已存上，审查 A7）', async () => {
    const reply = deferred<SaveContentResponse>()
    const answer = deferred<undefined>()
    const context = setup({ api: { save: async () => reply.promise }, editLease: { release: async () => answer.promise } })
    await editing(context)
    context.factory.last().edit('甲')
    const exiting = context.mode.exit()
    await settle()
    expect(modeOf(context.mode).kind).toBe('exiting')
    expect(context.mode.hasUnsavedWork()).toBe(true)
    reply.resolve(SAVED)
    await settle()
    expect(context.editLease.release).toHaveBeenCalledOnce()
    expect(modeOf(context.mode).kind).toBe('exiting')
    expect(context.mode.hasUnsavedWork()).toBe(false)
    answer.resolve(undefined)
    await exiting
    expect(modeOf(context.mode).kind).toBe('reading')
  })
})

describe('与服务端不兼容（M3-P3 设计 §3.5、§3.10）', () => {
  const OUTDATED = new ApiError(409, 'CLIENT_OUTDATED', '页面的版本过旧', { details: { reason: 'format' } })

  it('打开时就看得出文档比本页新（blocked）：只能阅读，不给"编辑"（进入编辑什么也不做）；?edit=new 也不直接进入；检查读到能编辑也不恢复', async () => {
    const context = setup()
    await context.mode.open({ ...LOADED, canEdit: true }, { enterEdit: true, blocked: 'document-too-new' })
    await settle()
    expect(readingOf(context.mode)).toMatchObject({ canEdit: true, blocked: 'document-too-new' })
    expect(context.factory.created.map(fake => fake.access)).toEqual(['read'])
    await context.mode.enter()
    expect(context.editLease.acquire).not.toHaveBeenCalled()
    await context.time.advance(READING_CHECK_INTERVAL_MS)
    expect(context.api.editStatus).toHaveBeenCalledTimes(2)
    expect(readingOf(context.mode).blocked).toBe('document-too-new')
  })

  it.each([
    ['CLIENT_OUTDATED', 'client-outdated'],
    ['DOCUMENT_TOO_NEW', 'document-too-new'],
  ] as const)('申请编辑权得到 %s：留在阅读并说明（blocked %s），不再给"编辑"，不重建编辑器', async (code, kind) => {
    const context = setup({ editLease: { acquire: async () => Promise.reject(new ApiError(409, code, '不兼容')) } })
    await opened(context)
    await context.mode.enter()
    expect(readingOf(context.mode)).toMatchObject({ blocked: kind, notice: undefined })
    expect(context.factory.created).toHaveLength(1)
    await context.mode.enter()
    expect(context.editLease.acquire).toHaveBeenCalledOnce()
    expect(context.hooks.writeProblem).not.toHaveBeenCalled()
  })

  it('编辑时保存得到 CLIENT_OUTDATED：保存的状态是"需要刷新"（终态），放掉编辑权、停止续租；编辑器留着（本页的修改还能复制），离开照样提示', async () => {
    const context = setup({ api: { save: async () => Promise.reject(OUTDATED) } })
    await editing(context)
    context.factory.last().edit('本页的修改')
    await context.mode.save()
    await settle()
    expect(context.mode.view()).toMatchObject({ mode: { kind: 'editing' }, save: { status: 'outdated', canSave: false, unsaved: true } })
    expect(context.editLease.release).toHaveBeenCalledOnce()
    await context.time.advance(HEARTBEAT_MS * 3)
    expect(context.editLease.renew).not.toHaveBeenCalled()
    expect(context.factory.last().disposed).toBe(false)
    expect(context.mode.hasUnsavedWork()).toBe(true)
    // 再按保存不发请求
    await context.mode.save()
    expect(context.api.save).toHaveBeenCalledOnce()
  })

  it('编辑时心跳得到 CLIENT_OUTDATED（服务端升级了）：保存的状态同样转入"需要刷新"、放掉编辑权；之后按保存不发请求', async () => {
    const context = setup({ editLease: { renew: async () => Promise.reject(OUTDATED) } })
    await editing(context)
    await context.time.advance(HEARTBEAT_MS)
    await settle()
    expect(context.mode.view().save).toMatchObject({ status: 'outdated', canSave: false })
    expect(context.editLease.release).toHaveBeenCalledOnce()
    context.factory.last().edit('本页的修改')
    await context.mode.save()
    expect(context.api.save).not.toHaveBeenCalled()
  })

  it('心跳得知过旧时有一次结果未知的保存：原样重发它一次（重放先于拦截旧客户端），其实已经提交时说修改都已保存、离开不再提示（审查 B5）', async () => {
    const context = setup({ editLease: { renew: async () => Promise.reject(OUTDATED) } })
    await editing(context)
    context.factory.last().edit('本页的修改')
    context.api.save.mockRejectedValueOnce(new NetworkError('断网'))
    await context.mode.save()
    expect(context.mode.view().save).toMatchObject({ status: 'failed', unsaved: true })
    await context.time.advance(HEARTBEAT_MS)
    await settle()
    expect(context.api.save).toHaveBeenCalledTimes(2)
    expect(context.api.save.mock.calls[1]?.[1]).toEqual(context.api.save.mock.calls[0]?.[1])
    expect(context.mode.view().save).toMatchObject({ status: 'outdated', checking: false, unsaved: false, problem: undefined })
    expect(context.mode.hasUnsavedWork()).toBe(false)
  })

  it('正在以可编辑重建时心跳就得知不兼容：建好之后保存的状态随即是"需要刷新"', async () => {
    const context = setup({ editLease: { renew: async () => Promise.reject(OUTDATED) } })
    await opened(context)
    const gate = context.factory.holdNext()
    const entering = context.mode.enter()
    await settle()
    await context.time.advance(HEARTBEAT_MS)
    gate.release()
    await entering
    expect(context.mode.view()).toMatchObject({ mode: { kind: 'editing' }, save: { status: 'outdated', canSave: false } })
  })

  it('不兼容之后退出编辑（本页的修改都已保存）：回到阅读，照样带着说明、不给"编辑"；停住续租时那次释放送到了，不说那一代还在', async () => {
    const context = setup({ editLease: { renew: async () => Promise.reject(OUTDATED) } })
    await editing(context)
    await context.time.advance(HEARTBEAT_MS)
    await context.mode.exit()
    await settle()
    expect(readingOf(context.mode)).toMatchObject({ blocked: 'client-outdated', releaseUnconfirmed: false })
    expect(context.editLease.release).toHaveBeenCalledOnce()
  })

  it('心跳得知过旧、停住续租时放掉那一代的请求没送到：之后退出编辑，阅读里如实记下那一代没能确认放掉（审查 B8），不再发释放', async () => {
    // 编辑状态里的持有者是自己（本页那一代还在）：记号留着
    const context = setup({ editLease: { renew: async () => Promise.reject(OUTDATED), release: async () => Promise.reject(new NetworkError('断网')) }, api: { editStatus: async () => status(3, SELF_EDITING) } })
    await editing(context)
    await context.time.advance(HEARTBEAT_MS)
    await context.mode.exit()
    await settle()
    expect(readingOf(context.mode)).toMatchObject({ blocked: 'client-outdated', releaseUnconfirmed: true })
    expect(context.editLease.release).toHaveBeenCalledOnce()
  })

  it('80% 的提示：进入编辑时按载入的内容先算一次大小（与服务端解压后的字节同一个口径），保存之后换成那次捕获的', async () => {
    const context = setup()
    await editing(context)
    expect(context.mode.view().save?.snapshotBytes).toBe(new TextEncoder().encode(LOADED.snapshot).byteLength)
    context.factory.last().edit('长一些的修改内容')
    await context.mode.save()
    expect(context.mode.view().save?.snapshotBytes).toBe(new TextEncoder().encode(snapshotOf('长一些的修改内容')).byteLength)
  })
})

/** 保存请求里的那一项（api.save 的第二个参数） */
function savedRequests(context: ReturnType<typeof setup>) {
  return context.api.save.mock.calls.map(([, request]) => request)
}

describe('自动保存的接线（M3-P4 设计 §3.10）', () => {
  it('进入编辑：先建保存的状态机、再建自动保存的调度、再接上编辑器（建调度时交互屏障还挂着）；调度交给测试构建的控制', async () => {
    const context = setup()
    await opened(context)
    const surfaces: string[] = []
    context.autosave.attach.mockImplementation(() => {
      surfaces.push(context.mode.view().surface)
    })
    await context.mode.enter()
    expect(surfaces).toEqual(['creating'])
    expect(context.autosave.attach).toHaveBeenCalledOnce()
    const attached = context.autosave.attach.mock.calls[0]?.[0]
    expect([typeof attached?.flush, typeof attached?.saved]).toEqual(['function', 'function'])
    expect(context.mode.view()).toMatchObject({ mode: { kind: 'editing' }, autosave: { offline: false, paused: false, retrying: false, held: true } })
  })

  it('放开定时的自动保存：修改停下 2 秒之后自动上传（不经保存按钮），请求与按保存的一样', async () => {
    const context = setup({ autosave: 'running' })
    await editing(context)
    context.factory.last().edit('甲')
    await context.time.advance(1_999)
    expect(context.api.save).not.toHaveBeenCalled()
    await context.time.advance(1)
    await settle()
    expect(savedRequests(context)).toMatchObject([{ baseRevision: 3, localSeq: 1, snapshot: snapshotOf('甲'), formulasPending: false }])
    expect(context.mode.view().save?.status).toBe('clean')
  })

  it('暂停（测试构建的控制）时定时的不发；保存按钮照常上传', async () => {
    const context = setup()
    await editing(context)
    context.factory.last().edit('甲')
    await context.time.advance(20_000)
    expect(context.api.save).not.toHaveBeenCalled()
    await context.mode.save()
    expect(savedRequests(context)).toMatchObject([{ snapshot: snapshotOf('甲') }])
  })

  it('保存按钮不去重：内容与确认过的相同也上传（给用户一个"强制同步"，服务端只写回执）', async () => {
    const context = setup()
    await editing(context)
    context.factory.last().edit('甲')
    await context.mode.save()
    await context.mode.save()
    expect(savedRequests(context).map(request => request?.snapshot)).toEqual([snapshotOf('甲'), snapshotOf('甲')])
  })

  it('保存中再按：在途的结束之后立即再存一次，连按只排一次', async () => {
    const context = setup()
    await editing(context)
    const reply = deferred<SaveContentResponse>()
    context.api.save.mockImplementationOnce(async () => reply.promise)
    context.factory.last().edit('甲')
    const first = context.mode.save()
    await settle()
    expect(context.mode.view().save).toMatchObject({ status: 'saving', canSave: true })
    context.factory.last().edit('乙')
    const second = context.mode.save()
    const third = context.mode.save()
    reply.resolve(SAVED)
    await Promise.all([first, second, third])
    expect(savedRequests(context).map(request => request?.snapshot)).toEqual([snapshotOf('甲'), snapshotOf('乙')])
  })

  it('按保存要先确认会话，确认期间开始了退出（复验 C4）：确认之后这次按下不另外上传——退出自己存', async () => {
    const context = setup()
    await editing(context)
    const reply = deferred<SaveContentResponse>()
    context.api.save.mockImplementationOnce(async () => reply.promise)
    context.factory.last().edit('甲')
    const confirmed = deferred<boolean>()
    const saving = context.mode.save(async () => confirmed.promise)
    const exiting = context.mode.exit()
    await settle()
    expect(modeOf(context.mode).kind).toBe('exiting')
    confirmed.resolve(true)
    await settle()
    reply.resolve(SAVED)
    await Promise.all([saving, exiting])
    expect(savedRequests(context).map(request => request?.snapshot)).toEqual([snapshotOf('甲')])
  })

  it('带"公式待更新"进入编辑（申请的响应）：以强制全量重算重建；保存的状态机以它起步（离开会提示）；公式收齐之后补存，请求不带标记', async () => {
    const context = setup({ autosave: 'running', editLease: { acquire: async () => ({ ...ACQUIRED, formulasPending: true }) } })
    await opened(context)
    await context.mode.enter()
    const writer = context.factory.last()
    expect(writer).toMatchObject({ access: 'edit', recalculate: true })
    // 重算还在进行（适配层在看到强制重算的那一轮之前不算收齐）
    writer.settle(false)
    // 修改都已存上，只差公式的结果（页头"公式结果尚未保存"，save-indicator.ts）
    expect(context.mode.view().save).toMatchObject({ status: 'dirty', formulasPending: true, unsaved: true, unsavedEdits: false })
    expect(context.mode.hasUnsavedWork()).toBe(true)
    await context.time.advance(5_000)
    expect(context.api.save).not.toHaveBeenCalled()
    writer.settle(true)
    await context.time.advance(0)
    await settle()
    expect(savedRequests(context)).toMatchObject([{ baseRevision: 3, localSeq: 0, formulasPending: false }])
    expect(context.mode.view().save).toMatchObject({ status: 'clean', formulasPending: false, unsaved: false })
    expect(context.mode.hasUnsavedWork()).toBe(false)
  })

  it('不带标记进入编辑：不强制重算（创建参数里没有 recalculate）', async () => {
    const context = setup()
    await editing(context)
    expect(context.factory.last().recalculate).toBeUndefined()
    expect(context.mode.view().save?.formulasPending).toBe(false)
  })

  it('失去编辑权开始时立即去掉自动保存（交给控制的是 undefined）：之后到点的定时也不再捕获、上传', async () => {
    const context = setup({ autosave: 'running' })
    await editing(context)
    const writer = context.factory.last()
    loseOnNextHeartbeat(context, DENIED)
    await context.time.advance(HEARTBEAT_MS - 500)
    writer.edit('甲')
    await context.time.advance(500)
    await settle()
    expect(modeOf(context.mode).kind).toBe('lost')
    expect(context.autosave.attached.at(-1)).toBeUndefined()
    const captures = vi.mocked(writer.editor.capture).mock.calls.length
    await context.time.advance(20_000)
    expect(vi.mocked(writer.editor.capture).mock.calls.length).toBe(captures)
    expect(context.api.save).not.toHaveBeenCalled()
  })

  it('失去编辑权时先等面板里防抖中的改动写进模型，再提交单元格、捕获（副本里才有它）', async () => {
    const context = setup()
    await editing(context)
    const writer = context.factory.last()
    const order: string[] = []
    vi.mocked(writer.editor.settlePanels).mockImplementation(async () => {
      order.push('panels')
    })
    vi.mocked(writer.editor.capture).mockImplementation(() => {
      order.push('capture')
      return snapshotOf('本页的')
    })
    loseOnNextHeartbeat(context, DENIED)
    await context.time.advance(HEARTBEAT_MS)
    await settle()
    expect(order).toEqual(['panels', 'capture'])
  })

  it('退出编辑：有没存的就立即上传一次（先等面板、提交单元格、等公式），之后才释放编辑权、以只读重建', async () => {
    const context = setup()
    await editing(context)
    const writer = context.factory.last()
    writer.edit('甲')
    await context.mode.exit()
    expect(vi.mocked(writer.editor.settlePanels)).toHaveBeenCalled()
    expect(savedRequests(context)).toMatchObject([{ snapshot: snapshotOf('甲'), formulasPending: false }])
    expect(readingOf(context.mode)).toMatchObject({ canEdit: true, formulasPending: false })
    expect(context.editLease.release).toHaveBeenCalledOnce()
  })

  it('退出编辑：先等面板的防抖——之前没有别的修改、只有面板里还没写进模型的改动时，它写进来之后照样上传再退出', async () => {
    const context = setup()
    await editing(context)
    const writer = context.factory.last()
    // 批注浮层里刚键入的字：SDK 的防抖到点时才写进模型（这里在等面板时写进来）
    vi.mocked(writer.editor.settlePanels).mockImplementationOnce(async () => {
      writer.edit('批注')
    })
    await context.mode.exit()
    expect(savedRequests(context)).toMatchObject([{ snapshot: snapshotOf('批注') }])
    expect(modeOf(context.mode).kind).toBe('reading')
  })

  it('退出编辑：都已存上时不上传；去重——内容与确认过的相同（改了又撤销）就不发', async () => {
    const context = setup()
    await editing(context)
    const writer = context.factory.last()
    writer.edit('甲')
    await context.mode.save()
    writer.edit('乙')
    writer.edit('甲')
    await context.mode.exit()
    expect(savedRequests(context).map(request => request?.snapshot)).toEqual([snapshotOf('甲')])
    expect(modeOf(context.mode).kind).toBe('reading')
  })

  it('退出编辑时公式没收齐：存上带标记的那一份、留在编辑，调度恢复——收齐之后自动补存', async () => {
    const context = setup({ autosave: 'running' })
    await editing(context)
    const writer = context.factory.last()
    writer.edit('甲')
    writer.formulasSettled = false
    await context.mode.exit()
    expect(modeOf(context.mode).kind).toBe('editing')
    expect(savedRequests(context)).toMatchObject([{ snapshot: snapshotOf('甲'), formulasPending: true }])
    expect(context.editLease.release).not.toHaveBeenCalled()
    writer.settle(true)
    // 补捕获之后照上传的规则：距最后一次修改满 2 秒才传
    await context.time.advance(2_000)
    await settle()
    expect(savedRequests(context)).toMatchObject([{ formulasPending: true }, { snapshot: snapshotOf('甲'), formulasPending: false }])
    expect(context.mode.view().save?.formulasPending).toBe(false)
  })

  it('退出的过程中调度挂起：定时的捕获与上传都不做（退出用的那一次是立即上传）；这期间到的修改（迟到的自动行高等）留到退出没成功、恢复之后再存', async () => {
    const context = setup({ autosave: 'running' })
    await editing(context)
    const writer = context.factory.last()
    const reply = deferred<SaveContentResponse>()
    context.api.save.mockImplementationOnce(async () => reply.promise)
    writer.edit('甲')
    const exiting = context.mode.exit()
    await settle()
    const captures = vi.mocked(writer.editor.capture).mock.calls.length
    writer.edit('甲乙')
    await context.time.advance(20_000)
    expect(vi.mocked(writer.editor.capture).mock.calls.length).toBe(captures)
    expect(context.api.save).toHaveBeenCalledOnce()
    reply.resolve(SAVED)
    await exiting
    // 退出用的那一份不含迟到的修改：留在编辑，调度恢复，按规则存上它
    expect(modeOf(context.mode).kind).toBe('editing')
    await context.time.advance(2_000)
    await settle()
    expect(savedRequests(context).map(request => request?.snapshot)).toEqual([snapshotOf('甲'), snapshotOf('甲乙')])
  })

  it('退出的过程中（立即上传在途）切到后台：调度挂起，不另起一次上传', async () => {
    const context = setup({ autosave: 'running' })
    await editing(context)
    const writer = context.factory.last()
    const reply = deferred<SaveContentResponse>()
    context.api.save.mockImplementationOnce(async () => reply.promise)
    writer.edit('甲')
    const exiting = context.mode.exit()
    await settle()
    writer.edit('甲乙')
    context.autosave.setPage({ visible: false })
    await settle()
    expect(context.api.save).toHaveBeenCalledOnce()
    reply.resolve(SAVED)
    await exiting
  })
})

describe('页面关闭时的编辑权（M3-P4 设计 §3.4）', () => {
  it('有保存在途：不释放（让租约到期，免得释放先提交、那次保存被拒）；在途的结束之后照旧释放', async () => {
    const context = setup()
    await editing(context)
    const reply = deferred<SaveContentResponse>()
    context.api.save.mockImplementationOnce(async () => reply.promise)
    context.factory.last().edit('甲')
    const saving = context.mode.save()
    await settle()
    context.mode.releaseOnHide()
    expect(context.editLease.release).not.toHaveBeenCalled()
    reply.resolve(SAVED)
    await saving
    context.mode.releaseOnHide()
    expect(context.editLease.release).toHaveBeenCalledOnce()
  })

  it('没有在途的保存：立即释放（结果不管）', async () => {
    const context = setup()
    await editing(context)
    context.mode.releaseOnHide()
    expect(context.editLease.release).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, TOKEN)
  })
})

describe('阅读页的"公式待更新"（M3-P4 设计 §3.5 第 4 条）', () => {
  function flagged(revision: number, formulasPending: boolean): FetchedEditStatus {
    return { status: { revision, editor: null, canEdit: true, canTakeOver: false, formulasPending, request: null, reservation: null, interruption: null }, serverTime: Date.parse(ANSWERED_AT) }
  }

  it('载入时详情带着标记：阅读里说明；之后的检查读到本页这一版的标记随之更新', async () => {
    const context = setup({ api: { editStatus: async () => flagged(3, true) } })
    await context.mode.open({ ...LOADED, canEdit: true, formulasPending: true }, { enterEdit: false })
    await settle()
    expect(readingOf(context.mode).formulasPending).toBe(true)
    context.api.editStatus.mockResolvedValue(flagged(3, false))
    await context.time.advance(READING_CHECK_INTERVAL_MS)
    expect(readingOf(context.mode).formulasPending).toBe(false)
  })

  it('检查读到更新的一版（有更新）：那一版的标记不套在本页显示的这一版上；"有更新"重建之后按那一版的', async () => {
    const context = setup({ api: { editStatus: async () => flagged(3, false), contentIfChanged: async () => ({ snapshot: snapshotOf('新的'), revision: 5 }) } })
    await opened(context)
    context.api.editStatus.mockResolvedValue(flagged(5, true))
    await context.time.advance(READING_CHECK_INTERVAL_MS)
    expect(readingOf(context.mode)).toMatchObject({ update: 'available', formulasPending: false })
    await context.mode.refresh()
    expect(readingOf(context.mode)).toMatchObject({ update: 'none', formulasPending: true })
  })

  it('补存的内容与上一版相同（服务端只清标记、修订号不变）之后退出：回到阅读不带标记，载入时记下的这一版的标记作废', async () => {
    const context = setup({ autosave: 'running', editLease: { acquire: async () => ({ ...ACQUIRED, formulasPending: true }) }, api: { editStatus: async () => flagged(3, true), save: async () => ({ ...SAVED, revision: 3, unchanged: true }) } })
    await context.mode.open({ ...LOADED, canEdit: true, formulasPending: true }, { enterEdit: false })
    await settle()
    await context.mode.enter()
    await context.time.advance(0)
    await settle()
    expect(savedRequests(context)).toMatchObject([{ formulasPending: false }])
    // 检查要等一会儿才回来：退出之后的阅读先按本页的结果说
    context.api.editStatus.mockImplementation(async () => new Promise(() => {}))
    await context.mode.exit()
    expect(readingOf(context.mode)).toMatchObject({ formulasPending: false })
  })

  it('进入编辑重算、补存之后退出：回到阅读不带标记（之后的检查读到的也是不带的那一版）', async () => {
    const context = setup({ autosave: 'running', editLease: { acquire: async () => ({ ...ACQUIRED, formulasPending: true }) }, api: { editStatus: async () => flagged(3, true) } })
    await context.mode.open({ ...LOADED, canEdit: true, formulasPending: true }, { enterEdit: false })
    await settle()
    await context.mode.enter()
    // 公式收齐（假的编辑器一开始就收齐）：补捕获、上传，服务端清掉标记、修订号 4
    await context.time.advance(0)
    await settle()
    expect(savedRequests(context)).toMatchObject([{ formulasPending: false }])
    context.api.editStatus.mockResolvedValue(flagged(4, false))
    await context.mode.exit()
    expect(readingOf(context.mode).formulasPending).toBe(false)
    await settle()
    expect(readingOf(context.mode).formulasPending).toBe(false)
  })
})

describe('打开自检（M3-P4 设计 §3.11–§3.13，US-M3-15）', () => {
  /** 数据没能完整载入：截断的筛选（解析抛错、加载之后变空） */
  const FILTER_FAILURES: readonly [OpenCheckFailure, ...OpenCheckFailure[]] = [{ kind: 'parse-threw', resource: 'SHEET_FILTER_PLUGIN', error: 'SyntaxError' }, { kind: 'resource-emptied', resource: 'SHEET_FILTER_PLUGIN' }]
  const FILTER_BROKEN: OpenCheck = { ok: false, failures: FILTER_FAILURES }
  /** 编辑器没有完整载入：批注的插件没有注册 */
  const NOTE_FAILURES: readonly [OpenCheckFailure, ...OpenCheckFailure[]] = [{ kind: 'profile-missing-hook', resource: 'SHEET_NOTE_PLUGIN' }]
  const NOTE_MISSING: OpenCheck = { ok: false, failures: NOTE_FAILURES }
  const OUTDATED = new ApiError(409, 'CLIENT_OUTDATED', '页面的版本过旧', { details: { reason: 'format' } })

  /** 上报过的（打开方式、起因、修订号），按先后 */
  function reports(context: ReturnType<typeof setup>): (readonly [string, string, number])[] {
    return context.api.reportOpenCheck.mock.calls.map(([, report]) => [report.access, report.trigger, report.revision] as const)
  }

  it('打开：只读的编辑器自检失败——阅读带上失败清单（damaged），能不能编辑照旧；结果的 damaged 为真；上报一次（只读、open、载入的修订号、本页的构建与格式）', async () => {
    const context = setup()
    context.factory.checkWith(() => FILTER_BROKEN)
    const outcome = await context.mode.open({ ...LOADED, canEdit: true }, { enterEdit: false })
    expect(outcome).toEqual({ kind: 'opened', entered: false, damaged: true })
    expect(readingOf(context.mode)).toMatchObject({ canEdit: true, damaged: FILTER_FAILURES, notice: undefined })
    expect(context.api.reportOpenCheck).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, { revision: 3, access: 'read', trigger: 'open', failures: FILTER_FAILURES, ...PAGE_CLIENT_FORMAT })
  })

  it('打开时通过：没有 damaged，不上报', async () => {
    const context = setup()
    await opened(context)
    expect(readingOf(context.mode).damaged).toBeUndefined()
    expect(context.api.reportOpenCheck).not.toHaveBeenCalled()
  })

  it('自检失败的阅读不进入编辑（不申请编辑权）；30 秒的检查读到能编辑、页头的详情说能编辑都不恢复', async () => {
    const context = setup()
    context.factory.checkWith(() => FILTER_BROKEN)
    await opened(context)
    await context.mode.enter()
    expect(context.editLease.acquire).not.toHaveBeenCalled()
    context.api.editStatus.mockResolvedValue(status(3, null, true))
    await context.time.advance(READING_CHECK_INTERVAL_MS)
    context.mode.updateCanEdit(false)
    context.mode.updateCanEdit(true)
    expect(readingOf(context.mode)).toMatchObject({ canEdit: true, damaged: FILTER_FAILURES })
    await context.mode.enter()
    expect(context.editLease.acquire).not.toHaveBeenCalled()
    expect(context.api.reportOpenCheck).toHaveBeenCalledOnce()
  })

  it('?edit=new：可编辑的编辑器自检失败（先取后放）——不建保存的状态机与调度，释放刚取得的编辑权，以只读重建同一份内容、以 damaged 进入阅读；两个编辑器各报一次；之后没有任何保存', async () => {
    const context = setup({ autosave: 'running' })
    context.factory.checkWith(() => NOTE_MISSING)
    const outcome = await context.mode.open({ ...LOADED, canEdit: true }, { enterEdit: true })
    expect(outcome).toEqual({ kind: 'opened', entered: false, damaged: true })
    expect(context.editLease.acquire).toHaveBeenCalledOnce()
    expect(context.editLease.release).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, TOKEN)
    expect(context.factory.created.map(fake => [fake.access, fake.snapshot, fake.disposed])).toEqual([['edit', LOADED.snapshot, true], ['read', LOADED.snapshot, false]])
    expect(context.autosave.attached).toEqual([])
    expect(context.mode.view()).toMatchObject({ save: undefined, autosave: undefined, surface: 'rendered' })
    expect(readingOf(context.mode)).toMatchObject({ canEdit: true, damaged: NOTE_FAILURES, notice: undefined, update: 'none' })
    expect(reports(context)).toEqual([['edit', 'enter', 3], ['read', 'enter', 3]])
    // 失败的编辑器绝不保存：它上面的修改没有人接着（没有保存的状态机、没有调度），时间过去也没有保存请求
    context.factory.created[0]?.edit('不该存的')
    await context.time.advance(60_000)
    expect(context.api.save).not.toHaveBeenCalled()
    expect(context.mode.hasUnsavedWork()).toBe(false)
  })

  it('"编辑"：申请得到更新的修订号、新内容自检失败——释放，以只读重建新内容（显示的就是它），damaged；"公式待更新"按申请时服务端说的', async () => {
    const context = setup({ editLease: { acquire: async () => ({ ...ACQUIRED, revision: 5, formulasPending: true }) } })
    await opened(context)
    context.factory.checkWith(({ snapshot }) => (snapshot === snapshotOf('服务端的') ? FILTER_BROKEN : { ok: true }))
    await context.mode.enter()
    expect(context.editLease.release).toHaveBeenCalledOnce()
    expect(context.factory.created.map(fake => [fake.access, fake.snapshot])).toEqual([['read', LOADED.snapshot], ['edit', snapshotOf('服务端的')], ['read', snapshotOf('服务端的')]])
    expect(readingOf(context.mode)).toMatchObject({ damaged: FILTER_FAILURES, update: 'none', notice: undefined, formulasPending: true })
    expect(reports(context)).toEqual([['edit', 'enter', 5], ['read', 'enter', 5]])
    // 显示的是新内容：之后的检查读到 5 不提示有更新
    context.api.editStatus.mockResolvedValue(status(5))
    await context.time.advance(READING_CHECK_INTERVAL_MS)
    expect(readingOf(context.mode).update).toBe('none')
  })

  it('"编辑"：可编辑的自检失败而只读的通过（两次不一致）——仍按可编辑时的清单阻止编辑，不来回"先取后放"', async () => {
    const context = setup()
    await opened(context)
    context.factory.checkWith(({ access }) => (access === 'edit' ? FILTER_BROKEN : { ok: true }))
    await context.mode.enter()
    expect(readingOf(context.mode).damaged).toEqual(FILTER_FAILURES)
    expect(reports(context)).toEqual([['edit', 'enter', 3]])
    await context.mode.enter()
    expect(context.editLease.acquire).toHaveBeenCalledOnce()
  })

  it('以可编辑重建失败、回退的只读的自检也失败：不说"可以再试"（没有"编辑"），按只读的清单说明', async () => {
    const context = setup()
    await opened(context)
    context.factory.failNext()
    context.factory.checkWith(() => FILTER_BROKEN)
    await context.mode.enter()
    expect(readingOf(context.mode)).toMatchObject({ notice: undefined, damaged: FILTER_FAILURES })
    expect(reports(context)).toEqual([['read', 'enter', 3]])
  })

  it('新建可编辑的编辑器期间续租得知与服务端不兼容、它的自检又失败：回到阅读时带上不兼容（blocked）与 damaged', async () => {
    const context = setup({ editLease: { renew: async () => Promise.reject(OUTDATED) } })
    await opened(context)
    const gate = context.factory.holdNext()
    context.factory.checkWith(({ access }) => (access === 'edit' ? FILTER_BROKEN : { ok: true }))
    const entering = context.mode.enter()
    await settle()
    await context.time.advance(HEARTBEAT_MS)
    gate.release()
    await entering
    expect(readingOf(context.mode)).toMatchObject({ blocked: 'client-outdated', damaged: FILTER_FAILURES })
  })

  it('退出编辑：以只读重建刚存下的内容，自检失败——以 damaged 阅读，上报（exit、保存之后的修订号）', async () => {
    const context = setup()
    await editing(context)
    context.factory.last().edit('改了')
    context.factory.checkWith(() => FILTER_BROKEN)
    await context.mode.exit()
    await settle()
    expect(readingOf(context.mode)).toMatchObject({ damaged: FILTER_FAILURES })
    expect(reports(context)).toEqual([['read', 'exit', 4]])
  })

  it('"有更新"：按新内容的结果覆盖——之前失败、新版通过时恢复（damaged 清掉）；新版失败时换成新版的清单', async () => {
    const context = setup({ api: { editStatus: async () => status(5) } })
    context.factory.checkWith(() => FILTER_BROKEN)
    await opened(context)
    context.factory.checkWith(() => ({ ok: true }))
    await context.mode.refresh()
    expect(readingOf(context.mode)).toMatchObject({ damaged: undefined, update: 'none' })
    context.api.editStatus.mockResolvedValue(status(6))
    context.api.contentIfChanged.mockResolvedValue({ snapshot: snapshotOf('第六版'), revision: 6 })
    await context.time.advance(READING_CHECK_INTERVAL_MS)
    context.factory.checkWith(() => NOTE_MISSING)
    await context.mode.refresh()
    expect(readingOf(context.mode).damaged).toEqual(NOTE_FAILURES)
    expect(reports(context)).toEqual([['read', 'open', 3], ['read', 'refresh', 6]])
  })

  it('失去编辑权之后以只读重建的自检失败：只上报（lost），失去编辑权之后的选项不变（副本照常给）；副本之后按最新的内容重建、又失败：以 damaged 阅读、上报（reload）', async () => {
    const context = setup()
    await editing(context)
    context.factory.last().edit('本页的')
    context.factory.checkWith(() => FILTER_BROKEN)
    loseOnNextHeartbeat(context, DENIED)
    await context.time.advance(HEARTBEAT_MS)
    await settle()
    expect(lostOf(context.mode)).toMatchObject({ unsaved: true, readable: true, reopenFailed: false, captureFailed: false, copy: { kind: 'idle' } })
    expect(reports(context)).toEqual([['read', 'lost', 3]])
    await context.mode.saveCopy()
    expect(context.api.conflictCopy).toHaveBeenCalledOnce()
    expect(readingOf(context.mode)).toMatchObject({ damaged: FILTER_FAILURES, notice: { kind: 'copied' } })
    expect(reports(context)).toEqual([['read', 'lost', 3], ['read', 'reload', 9]])
  })

  it('会话不是本人时不上报：自检照样失败、只能阅读', async () => {
    const context = setup()
    context.mode.setSession('other-user')
    context.factory.checkWith(() => FILTER_BROKEN)
    await opened(context)
    expect(readingOf(context.mode).damaged).toEqual(FILTER_FAILURES)
    expect(context.api.reportOpenCheck).not.toHaveBeenCalled()
  })

  it('上报失败（网络）：不看结果、不重试，也不当作页面错误（没有没处理的拒绝）', async () => {
    const context = setup()
    let calls = 0
    // 不经 vi.fn：它会接住返回的 Promise（记下 settledResults），没处理的拒绝就看不出来了
    Object.assign(context.api, {
      reportOpenCheck: async (): Promise<void> => {
        calls += 1
        throw new NetworkError('断网')
      },
    })
    context.factory.checkWith(() => FILTER_BROKEN)
    await opened(context)
    await context.time.advance(60_000)
    expect(calls).toBe(1)
    expect(context.reportError).not.toHaveBeenCalled()
  })
})

/** 一个 Promise 此刻兑现了没有（让排着的回调先执行完） */
async function settledNow(promise: Promise<unknown>): Promise<boolean> {
  let done = false
  void promise.then(() => {
    done = true
  })
  await settle()
  return done
}

/** 本浏览器里的另一个标签页抢走这份文档的锁（它取得了服务端批准的新的一代） */
async function stealFromAnotherTab(context: ReturnType<typeof setup>): Promise<HeldLock> {
  const taken = await sameBrowserFor(DOCUMENT_ID, context.browser.tab('other')).steal()
  await settle()
  return taken
}

/** 编辑权失效（EDIT_LEASE_LOST）的错误 */
function leaseLost(reason: string): ApiError {
  return new ApiError(409, 'EDIT_LEASE_LOST', '编辑权已失效', { details: { reason } })
}

describe('本机锁（M3-P5 设计 §3.1：先服务端、后本机锁）', () => {
  it('服务端批准之后才拿锁：申请被占用时不碰锁；锁空着时进入编辑就拿（ifAvailable），本浏览器里看得到', async () => {
    const context = setup({ editLease: { acquire: async () => Promise.reject(HELD_BY_AMY) }, api: { editStatus: async () => status(3, AMY_EDITING) } })
    const other = await sameBrowserFor(DOCUMENT_ID, context.browser.tab('other')).tryHold()
    await opened(context)
    await context.mode.enter()
    expect(readingOf(context.mode).holder?.holder).toEqual(AMY)
    expect(context.browser.holderOf(LOCK)).toBe('other')
    expect(await settledNow(other?.stolen ?? Promise.reject(new Error('没拿到')))).toBe(false)
    other?.release()
    await settle()
    context.editLease.acquire.mockResolvedValueOnce(ACQUIRED)
    await context.mode.enter()
    expect(modeOf(context.mode).kind).toBe('editing')
    expect(context.browser.holderOf(LOCK)).toBe('this')
  })

  it('被本浏览器的别的标签页占着：服务端批给了本页（那边的租约必然已经失效），就抢——那边的句柄随即兑现 stolen；?edit=new 直接进入时也一样', async () => {
    const context = setup()
    const other = await sameBrowserFor(DOCUMENT_ID, context.browser.tab('other')).tryHold()
    await editing(context)
    expect(context.browser.holderOf(LOCK)).toBe('this')
    expect(await settledNow(other?.stolen ?? Promise.reject(new Error('没拿到')))).toBe(true)

    const created = setup()
    const elsewhere = await sameBrowserFor(DOCUMENT_ID, created.browser.tab('other')).tryHold()
    await created.mode.open({ ...LOADED, canEdit: true }, { enterEdit: true })
    expect(created.browser.holderOf(LOCK)).toBe('this')
    expect(await settledNow(elsewhere?.stolen ?? Promise.reject(new Error('没拿到')))).toBe(true)
  })

  it('拿锁期间这一代已经失效（进入的途中续租得知编辑权被收回）：拿到的锁随即放掉——回到阅读的这一页不一直持有本机锁（审查 B7 的 M05）', async () => {
    const browser = fakeBrowser()
    const real = sameBrowserFor(DOCUMENT_ID, browser.tab('this'))
    const gate = deferred<void>()
    const context = setup({ browser, sameBrowser: { ...real, tryHold: async () => {
      await gate.promise
      return real.tryHold()
    } }, editLease: { renew: async () => Promise.reject(new ApiError(409, 'EDIT_LEASE_LOST', '编辑权已失效', { details: { reason: 'revoked' } })) } })
    await opened(context)
    const entering = context.mode.enter()
    await settle()
    expect(modeOf(context.mode).kind).toBe('entering')
    // 拿锁还停着：这期间心跳得知编辑权被收回，放弃进入、回到阅读
    await context.time.advance(HEARTBEAT_MS)
    expect(readingOf(context.mode).notice).toEqual({ kind: 'enter-lost', loss: { kind: 'lease', reason: 'revoked' } })
    gate.resolve()
    await entering
    await settle()
    expect(browser.holderOf(LOCK)).toBeUndefined()
    expect(modeOf(context.mode).kind).toBe('reading')
  })

  it('退出编辑：服务端的释放有了结果之后才放锁（S6 的交接以等锁为信号）；回到阅读时锁空着', async () => {
    const answer = deferred<undefined>()
    const context = setup({ editLease: { release: async () => answer.promise } })
    await editing(context)
    const exiting = context.mode.exit()
    await settle()
    expect(context.editLease.release).toHaveBeenCalledOnce()
    expect(context.browser.holderOf(LOCK)).toBe('this')
    answer.resolve(undefined)
    await exiting
    await settle()
    expect(modeOf(context.mode).kind).toBe('reading')
    expect(context.browser.holderOf(LOCK)).toBeUndefined()
  })

  it('退出编辑没有成功（保存失败、留在编辑）：锁留着', async () => {
    const context = setup({ api: { save: async () => Promise.reject(new NetworkError('断网')) } })
    await editing(context)
    context.factory.last().edit('乙')
    await context.mode.exit()
    expect(modeOf(context.mode).kind).toBe('editing')
    expect(context.browser.holderOf(LOCK)).toBe('this')
  })

  it.each([
    ['以可编辑重建失败', (context: ReturnType<typeof setup>) => context.factory.failNext()],
    ['可编辑的编辑器打开自检失败', (context: ReturnType<typeof setup>) => context.factory.checkWith(({ access }) => (access === 'edit' ? { ok: false, failures: [{ kind: 'resource-emptied', resource: 'SHEET_NOTE_PLUGIN' }] } : { ok: true }))],
  ])('没能进入编辑（%s）：放锁（与释放编辑权一起）', async (_case, arrange) => {
    const context = setup()
    await opened(context)
    arrange(context)
    await context.mode.enter()
    expect(modeOf(context.mode).kind).toBe('reading')
    expect(context.editLease.release).toHaveBeenCalledOnce()
    await settle()
    expect(context.browser.holderOf(LOCK)).toBeUndefined()
  })

  it('没能进入编辑（申请之后取服务端的内容失败）：放锁', async () => {
    const context = setup({ editLease: { acquire: async () => ({ ...ACQUIRED, revision: 5 }) }, api: { contentIfChanged: async () => Promise.reject(new NetworkError('断网')) } })
    await opened(context)
    await context.mode.enter()
    expect(readingOf(context.mode).notice).toMatchObject({ kind: 'enter-failed' })
    await settle()
    expect(context.browser.holderOf(LOCK)).toBeUndefined()
  })

  it('失去编辑权（续租得知被收回）：放锁', async () => {
    const context = setup({ editLease: { renew: async () => Promise.reject(leaseLost('revoked')) } })
    await editing(context)
    await context.time.advance(HEARTBEAT_MS)
    await settle()
    expect(lostOf(context.mode).loss).toEqual({ kind: 'lease', reason: 'revoked' })
    expect(context.browser.holderOf(LOCK)).toBeUndefined()
  })

  it('卸载：放锁', async () => {
    const context = setup()
    await editing(context)
    context.mode.dispose()
    await settle()
    expect(context.browser.holderOf(LOCK)).toBeUndefined()
  })

  it('拿锁的过程中这一代不用了（期间卸载）：拿到的锁随即放掉', async () => {
    const granted = deferred<HeldLock | undefined>()
    const release = vi.fn()
    const sameBrowser: SameBrowser = {
      tryHold: async () => granted.promise,
      steal: async () => ({ release: vi.fn(), stolen: new Promise<void>(() => {}) }),
      heldHere: async () => false,
      untilFree: async () => false,
      post: () => {},
      subscribe: () => () => {},
      close: () => {},
    }
    const context = setup({ sameBrowser })
    await opened(context)
    const entering = context.mode.enter()
    await settle()
    context.mode.dispose()
    granted.resolve({ release, stolen: new Promise<void>(() => {}) })
    await entering
    expect(release).toHaveBeenCalledOnce()
  })

  it('编辑时锁被本浏览器的另一个标签页抢走：立即失去编辑权（taken-over、this-browser），不再问服务端（不续租、不放、不再申请）；本页的修改给副本与放弃', async () => {
    const context = setup()
    await editing(context)
    context.factory.last().edit('甲')
    await stealFromAnotherTab(context)
    expect(lostOf(context.mode)).toMatchObject({ loss: { kind: 'taken-over', where: 'this-browser' }, unsaved: true, readable: true, checking: false })
    expect(context.factory.last()).toMatchObject({ access: 'read', snapshot: snapshotOf('甲') })
    await context.time.advance(HEARTBEAT_MS * 6)
    expect(context.editLease.renew).not.toHaveBeenCalled()
    expect(context.editLease.release).not.toHaveBeenCalled()
    expect(context.editLease.acquire).toHaveBeenCalledOnce()
    expect(context.mode.hasUnsavedWork()).toBe(true)
    await context.mode.saveCopy()
    expect(context.api.conflictCopy).toHaveBeenCalledOnce()
    expect(readingOf(context.mode)).toMatchObject({ canEdit: true, notice: { kind: 'copied' } })
  })

  it('被抢时没有修改：失去编辑权，修改都已保存（不给副本）', async () => {
    const context = setup()
    await editing(context)
    await stealFromAnotherTab(context)
    expect(lostOf(context.mode)).toMatchObject({ loss: { kind: 'taken-over', where: 'this-browser' }, unsaved: false })
    expect(context.mode.hasUnsavedWork()).toBe(false)
  })

  it('退出编辑的过程中（还没释放）被抢：同样转入失去编辑权，不再接着退出、不释放', async () => {
    const reply = deferred<SaveContentResponse>()
    const context = setup()
    await editing(context)
    context.api.save.mockImplementationOnce(async () => reply.promise)
    context.factory.last().edit('甲')
    const exiting = context.mode.exit()
    await settle()
    expect(modeOf(context.mode)).toEqual({ kind: 'exiting', cause: 'exit' })
    await stealFromAnotherTab(context)
    expect(modeOf(context.mode).kind).toBe('losing')
    reply.reject(leaseLost('replaced'))
    await exiting
    await settle()
    expect(lostOf(context.mode)).toMatchObject({ loss: { kind: 'taken-over', where: 'this-browser' }, unsaved: true })
    expect(context.editLease.release).not.toHaveBeenCalled()
    expect(context.editLease.acquire).toHaveBeenCalledOnce()
  })

  it('已经放下的锁后来才说被抢（上一次编辑的那一把）：不算，这一次的编辑照常', async () => {
    const handles: { readonly release: ReturnType<typeof vi.fn>, steal: () => void }[] = []
    const sameBrowser: SameBrowser = {
      tryHold: async () => {
        let steal: () => void = () => {}
        const stolen = new Promise<void>((resolve) => {
          steal = resolve
        })
        const handle = { release: vi.fn(), steal, stolen }
        handles.push(handle)
        return handle
      },
      steal: async () => ({ release: vi.fn(), stolen: new Promise<void>(() => {}) }),
      heldHere: async () => false,
      untilFree: async () => false,
      post: () => {},
      subscribe: () => () => {},
      close: () => {},
    }
    const context = setup({ sameBrowser })
    await editing(context)
    await context.mode.exit()
    expect(handles[0]?.release).toHaveBeenCalledOnce()
    await context.mode.enter()
    expect(modeOf(context.mode).kind).toBe('editing')
    handles[0]?.steal()
    await settle()
    expect(modeOf(context.mode).kind).toBe('editing')
    // 这一次的那一把被抢才算
    handles[1]?.steal()
    await settle()
    expect(lostOf(context.mode).loss).toEqual({ kind: 'taken-over', where: 'this-browser' })
  })

  it('离开编辑之后被抢不算（锁已经放下）', async () => {
    const context = setup()
    await editing(context)
    await context.mode.exit()
    await stealFromAnotherTab(context)
    expect(modeOf(context.mode).kind).toBe('reading')
  })

  it('进入编辑的途中被抢（申请之后、取内容时）：放弃进入，留在阅读并说明；不释放（那一代已被取代），之后也不续租', async () => {
    const fetching = deferred<LoadedContent>()
    const context = setup({ editLease: { acquire: async () => ({ ...ACQUIRED, revision: 5 }) }, api: { contentIfChanged: async () => fetching.promise } })
    await opened(context)
    const entering = context.mode.enter()
    await settle()
    expect(context.browser.holderOf(LOCK)).toBe('this')
    await stealFromAnotherTab(context)
    expect(readingOf(context.mode).notice).toEqual({ kind: 'enter-lost', loss: { kind: 'taken-over', where: 'this-browser' } })
    fetching.resolve({ snapshot: snapshotOf('服务端的'), revision: 5 })
    await entering
    expect(modeOf(context.mode).kind).toBe('reading')
    expect(context.factory.created.map(fake => fake.access)).toEqual(['read'])
    await context.time.advance(HEARTBEAT_MS * 3)
    expect(context.editLease.renew).not.toHaveBeenCalled()
    expect(context.editLease.release).not.toHaveBeenCalled()
  })

  it('以可编辑重建的过程中被抢：建好之后随即失去编辑权', async () => {
    const context = setup()
    await opened(context)
    const gate = context.factory.holdNext()
    const entering = context.mode.enter()
    await settle()
    await stealFromAnotherTab(context)
    gate.release()
    await entering
    await settle()
    expect(lostOf(context.mode).loss).toEqual({ kind: 'taken-over', where: 'this-browser' })
    expect(context.editLease.release).not.toHaveBeenCalled()
  })
})

describe('页面关闭（pagehide）时的本机锁与记号（M3-P5 设计 §3.1、§3.7 的 R1）', () => {
  it('有保存在途：放锁，不释放编辑权（M3-P4），记下记号——基准是本页确认过的最新修订', async () => {
    const reply = deferred<SaveContentResponse>()
    const context = setup()
    await editing(context)
    context.api.save.mockImplementationOnce(async () => reply.promise)
    context.factory.last().edit('甲')
    const saving = context.mode.save()
    await settle()
    context.mode.releaseOnHide()
    await settle()
    expect(context.browser.holderOf(LOCK)).toBeUndefined()
    expect(context.editLease.release).not.toHaveBeenCalled()
    expect(context.marker.write).toHaveBeenCalledExactlyOnceWith(3)
    reply.resolve(SAVED)
    await saving
  })

  it('没有在途的保存：放锁、释放编辑权，不记记号', async () => {
    const context = setup()
    await editing(context)
    context.mode.releaseOnHide()
    await settle()
    expect(context.browser.holderOf(LOCK)).toBeUndefined()
    expect(context.editLease.release).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, TOKEN)
    expect(context.marker.write).not.toHaveBeenCalled()
  })

  it('已经失去编辑权（lost）而保存的结果还未知、重发还在途：不记记号——这一代服务端已经不认，那次保存不可能再提交，新页面不必白等（审查 B12）', async () => {
    const context = setup()
    await editing(context)
    context.api.save.mockRejectedValueOnce(new NetworkError('请求被取消'))
    context.factory.last().edit('甲')
    await context.mode.save()
    await settle()
    // 编辑权失效（下一次心跳得知被收回）：转为失去编辑权，先原样重发结果未知的那一次（停住）
    const replay = deferred<SaveContentResponse>()
    context.api.save.mockImplementationOnce(async () => replay.promise)
    context.editLease.renew.mockRejectedValue(new ApiError(409, 'EDIT_LEASE_LOST', '编辑权已失效', { details: { reason: 'revoked' } }))
    await context.time.advance(HEARTBEAT_MS)
    await settle()
    expect(lostOf(context.mode).checking).toBe(true)
    context.mode.releaseOnHide()
    await settle()
    expect(context.marker.write).not.toHaveBeenCalled()
    expect(context.editLease.release).not.toHaveBeenCalled()
    replay.resolve(SAVED)
  })

  it('保存的结果未知（WebKit 在刷新、离开一开始就取消在途的请求，之后才派发 pagehide）：同样不释放、记下记号——那次保存可能已经送到服务端', async () => {
    const context = setup()
    await editing(context)
    context.api.save.mockRejectedValueOnce(new NetworkError('请求被取消'))
    context.factory.last().edit('甲')
    await context.mode.save()
    await settle()
    context.mode.releaseOnHide()
    await settle()
    expect(context.browser.holderOf(LOCK)).toBeUndefined()
    expect(context.editLease.release).not.toHaveBeenCalled()
    expect(context.marker.write).toHaveBeenCalledExactlyOnceWith(3)
  })
})

describe('离开编辑（leaveEditing）：退出照旧，空闲释放（US-M3-07，M3-P5 设计 §3.9）', () => {
  const IDLE_MS = EDIT_IDLE_RELEASE_SECONDS * 1000

  /** 编辑器每次等面板时的状态（离开编辑一律先挂屏障：begin(exiting) 在等面板与 flush 之前） */
  function recordModesAtSettle(context: ReturnType<typeof setup>): string[] {
    const seen: string[] = []
    vi.mocked(context.factory.last().editor.settlePanels).mockImplementation(async () => {
      const current = modeOf(context.mode)
      seen.push(current.kind === 'exiting' ? `exiting:${current.cause}` : current.kind)
    })
    return seen
  }

  it('退出编辑：状态带原因（exit）；等面板、flush（提交单元格、等面板）都在 begin(exiting) 之后——页面先挂上交互屏障', async () => {
    const context = setup()
    await editing(context)
    const seen = recordModesAtSettle(context)
    context.factory.last().edit('乙')
    const exiting = context.mode.exit()
    expect(modeOf(context.mode)).toEqual({ kind: 'exiting', cause: 'exit' })
    await exiting
    expect(seen).toEqual(['exiting:exit', 'exiting:exit'])
    expect(readingOf(context.mode).notice).toBeUndefined()
  })

  it('空闲满 10 分钟：先挂屏障（exiting、idle）、立即上传，存上了再释放、放锁，以只读重建本页的内容，阅读里说明；之后不再计时', async () => {
    const context = setup({ activity: 'manual' })
    await editing(context)
    const seen = recordModesAtSettle(context)
    context.factory.last().edit('甲')
    await context.time.advance(IDLE_MS - 1)
    expect(modeOf(context.mode).kind).toBe('editing')
    expect(context.api.save).not.toHaveBeenCalled()
    const modes: string[] = []
    context.mode.subscribe(() => modes.push(modeOf(context.mode).kind))
    await context.time.advance(1)
    await settle()
    expect(modes.find(kind => kind !== 'editing')).toBe('exiting')
    expect(seen).toEqual(['exiting:idle', 'exiting:idle'])
    expect(context.api.save).toHaveBeenCalledOnce()
    expect(context.editLease.release).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, TOKEN)
    expect(readingOf(context.mode)).toMatchObject({ canEdit: true, notice: { kind: 'idle-released' }, releaseUnconfirmed: false, formulasPending: false })
    expect(context.factory.last()).toMatchObject({ access: 'read', snapshot: snapshotOf('甲') })
    expect(context.mode.view().save).toBeUndefined()
    expect(context.browser.holderOf(LOCK)).toBeUndefined()
    // 阅读时只剩阅读的检查
    await context.time.advance(IDLE_MS)
    expect(context.editLease.release).toHaveBeenCalledOnce()
  })

  it('没有修改时空闲满 10 分钟：不上传，直接释放、回到阅读', async () => {
    const context = setup({ activity: 'manual' })
    await editing(context)
    await context.time.advance(IDLE_MS)
    await settle()
    expect(context.api.save).not.toHaveBeenCalled()
    expect(readingOf(context.mode).notice).toEqual({ kind: 'idle-released' })
  })

  it('起点取进入编辑的时刻：打开很久之后才进入编辑（最后一次操作在进入之前），从进入的那一刻起满 10 分钟才释放', async () => {
    const context = setup({ activity: 'manual' })
    await opened(context)
    await context.time.advance(IDLE_MS * 2)
    await context.mode.enter()
    expect(modeOf(context.mode).kind).toBe('editing')
    await context.time.advance(IDLE_MS - 1)
    expect(modeOf(context.mode).kind).toBe('editing')
    await context.time.advance(1)
    await settle()
    expect(readingOf(context.mode).notice).toEqual({ kind: 'idle-released' })
  })

  it('其间有操作：从最后一次操作重新算', async () => {
    const context = setup({ activity: 'manual' })
    await editing(context)
    await context.time.advance(4 * 60_000)
    context.act()
    await context.time.advance(IDLE_MS - 1)
    expect(modeOf(context.mode).kind).toBe('editing')
    await context.time.advance(1)
    await settle()
    expect(readingOf(context.mode).notice).toEqual({ kind: 'idle-released' })
  })

  it('公式没收齐也释放：带"公式待更新"上传（下一个进入编辑的人强制重算），阅读里说明公式结果可能还没更新（退出编辑这时留在编辑）', async () => {
    const context = setup({ activity: 'manual' })
    await editing(context)
    const writer = context.factory.last()
    writer.formulasSettled = false
    writer.edit('甲')
    await context.time.advance(IDLE_MS)
    await settle()
    expect(context.api.save).toHaveBeenCalledOnce()
    expect(context.api.save.mock.calls[0]?.[1]).toMatchObject({ formulasPending: true })
    expect(modeOf(context.mode).kind).toBe('reading')
    expect(readingOf(context.mode)).toMatchObject({ notice: { kind: 'idle-released' }, formulasPending: true })
  })

  it('保存失败：留在编辑（不释放、不重建、锁留着，说明由保存的状态给出），过一个心跳周期再看；存得上之后释放', async () => {
    const context = setup({ activity: 'manual', api: { save: async () => Promise.reject(new NetworkError('断网')) } })
    await editing(context)
    context.factory.last().edit('甲')
    await context.time.advance(IDLE_MS)
    await settle()
    expect(modeOf(context.mode).kind).toBe('editing')
    expect(context.mode.view().save?.status).toBe('failed')
    expect(context.api.save).toHaveBeenCalledOnce()
    expect(context.editLease.release).not.toHaveBeenCalled()
    expect(context.factory.last().access).toBe('edit')
    expect(context.browser.holderOf(LOCK)).toBe('this')
    await context.time.advance(IDLE_RECHECK_MS - 1)
    expect(context.api.save).toHaveBeenCalledOnce()
    context.api.save.mockResolvedValue(SAVED)
    await context.time.advance(1)
    await settle()
    expect(context.api.save).toHaveBeenCalledTimes(2)
    expect(readingOf(context.mode).notice).toEqual({ kind: 'idle-released' })
  })

  it('再也存不上的（版本冲突）：留在编辑，不再试（服务端 12 分钟兜底）', async () => {
    const context = setup({ activity: 'manual', api: { save: async () => Promise.reject(new ApiError(409, 'DOCUMENT_REVISION_CONFLICT', '别处保存了更新的版本', { details: { currentRevision: 9, source: null } })) } })
    await editing(context)
    context.factory.last().edit('甲')
    await context.time.advance(IDLE_MS)
    await settle()
    expect(context.mode.view().save?.status).toBe('conflict')
    expect(context.api.save).toHaveBeenCalledOnce()
    // 之后不再开始新的一轮（版本冲突之后保存的状态机不再发请求，看不到上传：看有没有再离开编辑、再等面板）
    const modes: string[] = []
    context.mode.subscribe(() => modes.push(modeOf(context.mode).kind))
    const settles = vi.mocked(context.factory.last().editor.settlePanels).mock.calls.length
    await context.time.advance(IDLE_RECHECK_MS * 6)
    expect(modes).not.toContain('exiting')
    expect(vi.mocked(context.factory.last().editor.settlePanels).mock.calls.length).toBe(settles)
    expect(modeOf(context.mode).kind).toBe('editing')
    expect(context.editLease.release).not.toHaveBeenCalled()
  })

  it.each([
    ['会话不可写（不主动向服务端确认）', { writable: false }, { writable: true }],
    ['没联网', { online: false }, { online: true }],
  ] as const)('%s：这一轮不释放、也不开始离开（不挂屏障、不上传）；过一个心跳周期再看，恢复之后释放', async (_case, bad, good) => {
    const context = setup({ activity: 'manual' })
    await editing(context)
    context.factory.last().edit('甲')
    context.autosave.setPage(bad)
    const modes: string[] = []
    context.mode.subscribe(() => modes.push(modeOf(context.mode).kind))
    await context.time.advance(IDLE_MS)
    await settle()
    expect(modes).not.toContain('exiting')
    expect(context.api.save).not.toHaveBeenCalled()
    expect(context.editLease.release).not.toHaveBeenCalled()
    context.autosave.setPage(good)
    await context.time.advance(IDLE_RECHECK_MS)
    await settle()
    expect(context.api.save).toHaveBeenCalledOnce()
    expect(readingOf(context.mode).notice).toEqual({ kind: 'idle-released' })
  })

  it('开始之后、上传之前会话变差（等面板的时候）：flush 按"不必先确认就能写"不上传、也不向服务端确认，这一轮不释放', async () => {
    const context = setup({ activity: 'manual' })
    await editing(context)
    context.factory.last().edit('甲')
    const gate = deferred<undefined>()
    vi.mocked(context.factory.last().editor.settlePanels).mockImplementationOnce(async () => gate.promise)
    await context.time.advance(IDLE_MS)
    await settle()
    expect(modeOf(context.mode)).toEqual({ kind: 'exiting', cause: 'idle' })
    context.autosave.setPage({ writable: false })
    gate.resolve(undefined)
    await settle()
    await settle()
    expect(context.api.save).not.toHaveBeenCalled()
    expect(context.hooks.writeProblem).not.toHaveBeenCalled()
    expect(modeOf(context.mode).kind).toBe('editing')
    expect(context.editLease.release).not.toHaveBeenCalled()
  })

  it('轮到上传时会话已经变差（skipped 的 session，M3-P4 交接单）：算没存上，留在编辑——修改本来都已存上、只差公式也一样', async () => {
    const context = setup({ activity: 'manual', editLease: { acquire: async () => ({ ...ACQUIRED, formulasPending: true }) } })
    await editing(context)
    const gate = deferred<undefined>()
    // 第一次是离开编辑自己等面板，第二次是 flush 按下时的准备：停在这里，期间会话变差
    vi.mocked(context.factory.last().editor.settlePanels).mockImplementationOnce(async () => {}).mockImplementationOnce(async () => gate.promise)
    await context.time.advance(IDLE_MS)
    await settle()
    expect(modeOf(context.mode)).toEqual({ kind: 'exiting', cause: 'idle' })
    context.autosave.setPage({ writable: false })
    gate.resolve(undefined)
    await settle()
    await settle()
    expect(context.api.save).not.toHaveBeenCalled()
    expect(modeOf(context.mode).kind).toBe('editing')
    expect(context.editLease.release).not.toHaveBeenCalled()
  })

  it('回到前台时（Safari 隐藏之后计时器停止）按隐藏之前的操作算：满 10 分钟就在可见性的通知里开始空闲释放、停止续上——回来时的第一下操作不把过期的编辑权续上，存好之后释放', async () => {
    // 隐藏期间心跳停了，服务端那边已经到期
    const context = setup({ activity: 'manual', editLease: { renew: async () => Promise.reject(leaseLost('expired')) } })
    await editing(context)
    context.page.set(true)
    context.time.elapse(IDLE_MS + 60_000)
    context.page.set(false)
    expect(modeOf(context.mode)).toEqual({ kind: 'exiting', cause: 'idle' })
    // 回来时的第一下鼠标移动；之后停在暂停里的计时器恢复（心跳得知到期）
    context.act()
    await context.time.advance(0)
    await settle()
    expect(context.editLease.acquire).toHaveBeenCalledOnce()
    expect(context.editLease.release).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, TOKEN)
    expect(readingOf(context.mode).notice).toEqual({ kind: 'idle-released' })
  })

  it('与人不在（dormant）不冲突：服务端兜底回收之后空闲释放照样一轮轮地试；试的过程中人回来不把编辑权续上，这一轮没成之后才续上，接着编辑', async () => {
    const renew = vi.fn<EditLeaseApi['renew']>(async (_documentId, _token, idleSeconds) => idleSeconds >= EDIT_LEASE_IDLE_RECLAIM_SECONDS ? Promise.reject(leaseLost('idle')) : RENEWED)
    const context = setup({ activity: 'manual', api: { save: async () => Promise.reject(new NetworkError('断网')) }, editLease: { renew } })
    await editing(context)
    context.factory.last().edit('甲')
    // 10 分钟时空闲释放没存上；12 分钟时服务端回收，本页的空闲也满了 12 分钟：人不在，不续上
    await context.time.advance(EDIT_LEASE_IDLE_RECLAIM_SECONDS * 1000 + HEARTBEAT_MS)
    await settle()
    expect(renew).toHaveBeenLastCalledWith(DOCUMENT_ID, TOKEN, expect.any(Number))
    expect(context.editLease.acquire).toHaveBeenCalledOnce()
    expect(modeOf(context.mode).kind).toBe('editing')
    // 下一轮空闲释放停在上传上：这期间人回来了
    const reply = deferred<SaveContentResponse>()
    context.api.save.mockImplementationOnce(async () => reply.promise)
    await context.time.advance(IDLE_RECHECK_MS)
    await settle()
    expect(modeOf(context.mode)).toEqual({ kind: 'exiting', cause: 'idle' })
    context.act()
    await settle()
    expect(context.editLease.acquire).toHaveBeenCalledOnce()
    // 这一轮没存上：留在编辑，人在——随即续上（按空闲回收的那一代谁看都是空着的，不先放，直接申请新的一代，M3-P5 审查 A3）
    context.editLease.acquire.mockResolvedValueOnce({ ...ACQUIRED, token: 'M'.repeat(43), writeEpoch: 8 })
    reply.reject(new NetworkError('断网'))
    await settle()
    await settle()
    expect(modeOf(context.mode).kind).toBe('editing')
    expect(context.editLease.release).not.toHaveBeenCalled()
    expect(context.editLease.acquire).toHaveBeenCalledTimes(2)
    expect(context.editLease.acquire).toHaveBeenLastCalledWith(DOCUMENT_ID, PAGE_ID, { idleSeconds: 0 })
    // 人在：之后不再空闲释放，修改存得上时照常保存
    context.api.save.mockResolvedValue(SAVED)
    await context.mode.save()
    expect(context.api.save).toHaveBeenLastCalledWith(DOCUMENT_ID, expect.anything(), expect.anything(), { token: 'M'.repeat(43), writeEpoch: 8 })
    await context.time.advance(IDLE_RECHECK_MS * 3)
    expect(modeOf(context.mode).kind).toBe('editing')
  })

  it('空闲释放的过程中失去编辑权（续租得知被收回）：转入失去编辑权，不再接着释放', async () => {
    const reply = deferred<SaveContentResponse>()
    const context = setup({ activity: 'manual', editLease: { renew: async () => Promise.reject(leaseLost('revoked')) } })
    await editing(context)
    context.api.save.mockImplementationOnce(async () => reply.promise)
    context.factory.last().edit('甲')
    // 隐藏期间计时器不走（第一次心跳还没发）：回到前台时已满 10 分钟，开始空闲释放；之后恢复的心跳得知被收回
    context.page.set(true)
    context.time.elapse(IDLE_MS)
    context.page.set(false)
    expect(modeOf(context.mode)).toEqual({ kind: 'exiting', cause: 'idle' })
    await context.time.advance(0)
    await settle()
    expect(modeOf(context.mode).kind).toBe('losing')
    reply.reject(leaseLost('revoked'))
    await settle()
    await settle()
    expect(lostOf(context.mode).loss).toEqual({ kind: 'lease', reason: 'revoked' })
    expect(context.editLease.release).not.toHaveBeenCalled()
  })
})

describe('本人接管："在此编辑"（M3-P5 设计 §3.7，US-M3-08）', () => {
  const TAB_A = PAGE_ID
  const TAB_B = '0199a2c4-1f2e-7a3b-8c4d-00000000bbbb'
  const CHANNEL = channelNameOf(DOCUMENT_ID)
  /** 申请被自己占着（另一个标签页或设备上的那一代） */
  const HELD_BY_SELF = new ApiError(409, 'EDIT_LEASE_HELD', '你在别处正在编辑', { details: { ...SELF_EDITING, canTakeOver: false, request: null }, serverTime: Date.parse(ANSWERED_AT) })
  /** 记号的时刻按页面的墙上时间（setup 的 now） */
  const WALL = new Date(2026, 9, 4, 15, 30, 12).getTime()

  /**
   * 同一个浏览器里的两个标签页（共用锁与频道，各有各的接口与时钟）：A 在编辑、改了一处（没存：测试里定时的自动保存暂停）；B 在阅读，
   * 读到自己在编辑。deafA：A 收不到交接频道的消息（冻结、暂停、卡住，或者载入的是不认识这个协议的页面；E2E 用注入吞掉）
   */
  async function twoTabs(options: { readonly a?: Setup, readonly b?: Setup, readonly deafA?: boolean } = {}) {
    const browser = fakeBrowser()
    const real = sameBrowserFor(DOCUMENT_ID, browser.tab('A'))
    const a = setup({ ...options.a, browser, tab: 'A', clientInstanceId: TAB_A, ...(options.deafA === true ? { sameBrowser: { ...real, subscribe: () => () => {} } } : {}) })
    await editing(a)
    a.factory.last().edit('A 的修改')
    const b = setup({ ...options.b, api: { editStatus: async () => status(3, SELF_EDITING), ...options.b?.api }, browser, tab: 'B', clientInstanceId: TAB_B })
    await opened(b)
    await settle()
    return { browser, a, b }
  }

  /** 交接频道上发过的消息的类型，按先后 */
  function postedTypes(browser: FakeBrowser): string[] {
    return browser.posted(CHANNEL).map(message => (message as { readonly type: string }).type)
  }

  /** 等交接频道上发过 count 条消息（请求在看过本机锁之后才发，回应经频道在下一个宏任务里送到） */
  async function untilPosted(browser: FakeBrowser, count: number): Promise<void> {
    await vi.waitFor(() => expect(browser.posted(CHANNEL).length).toBeGreaterThanOrEqual(count))
    await settle()
  }

  /** 这份文档的本机锁有几个在排队等（"在此编辑"等那边做完时排着一个） */
  async function waitingForLock(browser: FakeBrowser): Promise<number> {
    const snapshot = await browser.tab('probe').locks?.query() as { readonly pending?: readonly unknown[] } | undefined
    return snapshot?.pending?.length ?? 0
  }

  /** 本浏览器里另一个标签页发来的交接请求（请求方一侧不经编辑模式，直接发） */
  function requestFrom(browser: FakeBrowser, requestId: string, userId = AMY.id): SameBrowser {
    const tab = sameBrowserFor(DOCUMENT_ID, browser.tab('B'))
    tab.post({ type: 'handover-request', requestId, documentId: DOCUMENT_ID, from: TAB_B, userId })
    return tab
  }

  const REQUEST_1 = '0199a2c4-1f2e-7a3b-8c4d-0000000000f1'
  const REQUEST_2 = '0199a2c4-1f2e-7a3b-8c4d-0000000000f2'

  describe('阅读时分清自己在哪里编辑', () => {
    it('持有者是自己：本机锁在本浏览器里有人持有时是本浏览器的另一个标签页，没人持有时是别处；持有者不是自己时没有', async () => {
      const { a, b } = await twoTabs()
      expect(readingOf(b.mode)).toMatchObject({ holder: { sameUser: true }, selfHolder: 'this-browser', takeover: undefined })
      // A 放了锁（退出编辑），而编辑状态里还是自己（例如 A 的释放没送到）：别处
      await a.mode.exit()
      await b.time.advance(READING_CHECK_INTERVAL_MS)
      expect(readingOf(b.mode)).toMatchObject({ holder: { sameUser: true }, selfHolder: 'elsewhere' })
      b.api.editStatus.mockResolvedValue(status(3, AMY_EDITING))
      await b.time.advance(READING_CHECK_INTERVAL_MS)
      expect(readingOf(b.mode)).toMatchObject({ holder: { sameUser: false }, selfHolder: undefined })
    })

    it('点"编辑"之后才得知被自己占着（409、sameUser）：锁被本浏览器的标签页持有时不再试（只申请一次），回到阅读、是本浏览器的另一个标签页', async () => {
      // B 读到的编辑状态还是"没人在编辑"（30 秒一次，过时了）：仍是"编辑"
      const { b } = await twoTabs({ b: { api: { editStatus: async () => status(3) }, editLease: { acquire: async () => Promise.reject(HELD_BY_SELF) } } })
      expect(readingOf(b.mode).holder).toBeUndefined()
      b.api.editStatus.mockResolvedValue(status(3, SELF_EDITING))
      await b.mode.enter()
      expect(b.editLease.acquire).toHaveBeenCalledOnce()
      expect(readingOf(b.mode)).toMatchObject({ holder: { sameUser: true }, selfHolder: 'this-browser', takeover: undefined })
      await settle()
      expect(readingOf(b.mode)).toMatchObject({ holder: { sameUser: true }, selfHolder: 'this-browser' })
      expect(b.editLease.acquire).toHaveBeenCalledOnce()
    })

    it('点"编辑"被自己占着、锁空着（另一台设备上的那一代，或者刷新时旧页面的释放晚到）：照旧隔 500 毫秒再试，仍被占着就回到阅读、是别处', async () => {
      const context = setup({ editLease: { acquire: async () => Promise.reject(HELD_BY_SELF) } })
      await opened(context)
      context.api.editStatus.mockResolvedValue(status(3, SELF_EDITING))
      const entering = context.mode.enter()
      await context.time.advance(SAME_USER_RETRY_DELAY_MS * SAME_USER_RETRIES)
      await entering
      expect(context.editLease.acquire).toHaveBeenCalledTimes(SAME_USER_RETRIES + 1)
      expect(readingOf(context.mode)).toMatchObject({ holder: { sameUser: true }, selfHolder: 'elsewhere' })
    })

    it('?edit=new 直接进入时被自己占着、锁被本浏览器的标签页持有：同样不再试，照常以只读打开、是本浏览器的另一个标签页', async () => {
      const browser = fakeBrowser()
      await sameBrowserFor(DOCUMENT_ID, browser.tab('A')).tryHold()
      const context = setup({ browser, editLease: { acquire: async () => Promise.reject(HELD_BY_SELF) }, api: { editStatus: async () => status(3, SELF_EDITING) } })
      expect(await context.mode.open({ ...LOADED, canEdit: true }, { enterEdit: true })).toEqual({ kind: 'opened', entered: false, damaged: false })
      expect(context.editLease.acquire).toHaveBeenCalledOnce()
      expect(readingOf(context.mode)).toMatchObject({ holder: { sameUser: true }, selfHolder: 'this-browser' })
    })
  })

  describe('锁在本浏览器里没人持有：立即本人接管（跨设备、刚关闭或刷新过的页面、孤儿租约）', () => {
    it('以本人接管申请（不发交接请求、不等），拿锁（锁空着）、以可编辑重建；接手之后清掉记号', async () => {
      const context = setup({ api: { editStatus: async () => status(3, SELF_EDITING) } })
      await opened(context)
      expect(readingOf(context.mode).selfHolder).toBe('elsewhere')
      await context.mode.takeOver()
      expect(context.editLease.acquire).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, PAGE_ID, { takeover: 'self' })
      expect(modeOf(context.mode).kind).toBe('editing')
      expect(context.browser.holderOf(LOCK)).toBe('this')
      expect(context.browser.posted(CHANNEL)).toEqual([])
      expect(context.marker.clear).toHaveBeenCalledOnce()
    })

    it('刷新时在途的保存（R1）：记号在 30 秒内——先说明在等，立即、之后每 2 秒读一次编辑状态；修订号比记号里的新了（那次保存提交了）才以本人接管申请', async () => {
      const context = setup({ api: { editStatus: async () => status(3, SELF_EDITING) } })
      context.marker.read.mockReturnValue({ at: WALL - 1_000, revision: 3 })
      await opened(context)
      const polls = context.api.editStatus.mock.calls.length
      const taking = context.mode.takeOver()
      await settle()
      expect(readingOf(context.mode).takeover).toEqual({ kind: 'waiting-save' })
      expect(context.api.editStatus.mock.calls.length).toBe(polls + 1)
      await context.time.advance(PENDING_SAVE_POLL_MS * 2)
      expect(context.api.editStatus.mock.calls.length).toBe(polls + 3)
      expect(context.editLease.acquire).not.toHaveBeenCalled()
      context.api.editStatus.mockResolvedValue(status(4, SELF_EDITING))
      await context.time.advance(PENDING_SAVE_POLL_MS)
      await taking
      expect(context.editLease.acquire).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, PAGE_ID, { takeover: 'self' })
      expect(modeOf(context.mode).kind).toBe('editing')
      expect(context.marker.clear).toHaveBeenCalledOnce()
    })

    it('记号的那次保存一直没提交：到 30 秒（从记号的时刻算）也接手；记号已经过了 30 秒时不等', async () => {
      const context = setup({ api: { editStatus: async () => status(3, SELF_EDITING) } })
      context.marker.read.mockReturnValue({ at: WALL - 10_000, revision: 3 })
      await opened(context)
      const taking = context.mode.takeOver()
      await context.time.advance(EDIT_PENDING_SAVE_WAIT_MS - 10_000 - 1)
      expect(context.editLease.acquire).not.toHaveBeenCalled()
      expect(readingOf(context.mode).takeover).toEqual({ kind: 'waiting-save' })
      await context.time.advance(1)
      await taking
      expect(context.editLease.acquire).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, PAGE_ID, { takeover: 'self' })

      const stale = setup({ api: { editStatus: async () => status(3, SELF_EDITING) } })
      stale.marker.read.mockReturnValue({ at: WALL - EDIT_PENDING_SAVE_WAIT_MS, revision: 3 })
      await opened(stale)
      await stale.mode.takeOver()
      expect(stale.editLease.acquire).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, PAGE_ID, { takeover: 'self' })
      expect(modeOf(stale.mode).kind).toBe('editing')
    })

    it('接手被别人占着（期间别人申请了）：回到阅读，说明谁在编辑，不再接手；记号不清', async () => {
      const context = setup({ api: { editStatus: async () => status(3, SELF_EDITING) }, editLease: { acquire: async () => Promise.reject(HELD_BY_AMY) } })
      await opened(context)
      await context.mode.takeOver()
      expect(readingOf(context.mode)).toMatchObject({ holder: { holder: AMY, sameUser: false }, selfHolder: undefined, takeover: undefined })
      expect(context.marker.clear).not.toHaveBeenCalled()
    })

    it('接手的申请失败（网络）：回到阅读并说明，可以再点；不能编辑了（403）同样说明', async () => {
      const context = setup({ api: { editStatus: async () => status(3, SELF_EDITING) }, editLease: { acquire: async () => Promise.reject(new ApiError(400, 'REQUEST_INVALID', 'x')) } })
      await opened(context)
      await context.mode.takeOver()
      expect(readingOf(context.mode)).toMatchObject({ takeover: undefined, notice: { kind: 'enter-failed' } })
      context.editLease.acquire.mockRejectedValue(DENIED)
      await context.mode.takeOver()
      expect(readingOf(context.mode)).toMatchObject({ takeover: undefined, canEdit: false, notice: { kind: 'denied' } })
    })
  })

  describe('锁被本浏览器的标签页持有：请它先保存再交出', () => {
    it('B 发交接请求、说正在请它交出；A 同步回 ack，先挡住输入保存，存上了不释放（只放弃这一代，审查 B4）、放锁、发 done、回到阅读（已交给本浏览器的另一个标签页）；B 等那边做完才以本人接管申请（服务端换代，槽从来不空），取最新的内容进入编辑', async () => {
      const { browser, a, b } = await twoTabs({ b: { api: { contentIfChanged: async () => ({ snapshot: snapshotOf('A 的修改'), revision: 4 }) } } })
      const order: string[] = []
      const panels = deferred<void>()
      const atSettle: string[] = []
      vi.mocked(a.factory.last().editor.settlePanels).mockImplementation(async () => {
        const current = modeOf(a.mode)
        atSettle.push(current.kind === 'exiting' ? `exiting:${current.cause}` : current.kind)
        await panels.promise
      })
      a.api.save.mockImplementation(async () => {
        order.push('A 保存')
        return SAVED
      })
      a.editLease.release.mockImplementation(async () => {
        order.push('A 释放')
      })
      b.editLease.acquire.mockImplementation(async () => {
        order.push('B 申请')
        return { ...ACQUIRED, revision: 4 }
      })
      const taking = b.mode.takeOver()
      await untilPosted(browser, 2)
      // 回应在保存之前就到了（消息的处理里同步回）
      expect(postedTypes(browser)).toEqual(['handover-request', 'handover-ack'])
      expect(browser.posted(CHANNEL)[1]).toMatchObject({ requestId: (browser.posted(CHANNEL)[0] as { readonly requestId: string }).requestId, from: TAB_A, state: 'editing' })
      expect(readingOf(b.mode).takeover).toEqual({ kind: 'asking' })
      expect(modeOf(a.mode)).toEqual({ kind: 'exiting', cause: 'handover-tab' })
      panels.resolve()
      await taking
      expect(atSettle[0]).toBe('exiting:handover-tab')
      expect(order).toEqual(['A 保存', 'B 申请'])
      expect(a.editLease.release).not.toHaveBeenCalled()
      expect(postedTypes(browser)).toEqual(['handover-request', 'handover-ack', 'handover-done'])
      expect(b.editLease.acquire).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, TAB_B, { takeover: 'self' })
      expect(modeOf(b.mode).kind).toBe('editing')
      expect(b.factory.last()).toMatchObject({ access: 'edit', snapshot: snapshotOf('A 的修改') })
      expect(browser.holderOf(LOCK)).toBe('B')
      expect(readingOf(a.mode)).toMatchObject({ notice: { kind: 'handed-over-tab' }, releaseUnconfirmed: false })
      expect(a.factory.last()).toMatchObject({ access: 'read', snapshot: snapshotOf('A 的修改') })
      expect(b.marker.clear).toHaveBeenCalledOnce()
      // A 那一代不再续租（放弃了：B 的本人接管结束它）
      const renewals = a.editLease.renew.mock.calls.length
      await a.time.advance(HEARTBEAT_MS * 3)
      expect(a.editLease.renew).toHaveBeenCalledTimes(renewals)
    })

    it('A 公式没收齐也交出（带"公式待更新"上传）：与空闲释放同一规则（退出编辑这时会留在编辑）', async () => {
      const { a, b } = await twoTabs()
      a.factory.last().formulasSettled = false
      await b.mode.takeOver()
      expect(a.api.save.mock.calls[0]?.[1]).toMatchObject({ formulasPending: true })
      expect(readingOf(a.mode)).toMatchObject({ notice: { kind: 'handed-over-tab' }, formulasPending: true })
      expect(modeOf(b.mode).kind).toBe('editing')
    })

    it('A 交给标签页时不发释放（审查 B4：先释放、再申请之间等待中的请求方会抢进来）：B 一次本人接管就换了代；A 不说"本页那一代可能还在"（B 随即接手）', async () => {
      const { a, b } = await twoTabs()
      // 交出之后 A 读到的持有者是自己（B 接手的那一代）
      a.api.editStatus.mockResolvedValue(status(3, SELF_EDITING))
      await b.mode.takeOver()
      expect(a.editLease.release).not.toHaveBeenCalled()
      expect(b.editLease.acquire.mock.calls).toEqual([[DOCUMENT_ID, TAB_B, { takeover: 'self' }]])
      expect(modeOf(b.mode).kind).toBe('editing')
      await settle()
      expect(readingOf(a.mode)).toMatchObject({ notice: { kind: 'handed-over-tab' }, releaseUnconfirmed: false, holder: { sameUser: true }, selfHolder: 'this-browser' })
    })

    it('A 那边有请求在等（乙在请求编辑）：交给标签页时不交给请求方、不释放；B 本人接管之后请求随新的一代沿用（下一次心跳带来它）', async () => {
      const incoming: PendingEditRequest = { id: '0199a2c4-1f2e-7a3b-8c4d-0000000000f9', requester: BEN, requestedAt: '2026-10-04T03:01:00.000Z' }
      const { a, b } = await twoTabs({ b: { editLease: { renew: async () => ({ ...RENEWED, request: incoming }) } } })
      a.editLease.renew.mockResolvedValue({ ...RENEWED, request: incoming })
      a.act()
      await a.time.advance(HEARTBEAT_MS)
      expect(modeOf(a.mode)).toMatchObject({ kind: 'editing', request: { id: incoming.id } })
      await b.mode.takeOver()
      expect(a.editLease.handOver).not.toHaveBeenCalled()
      expect(a.editLease.release).not.toHaveBeenCalled()
      expect(b.editLease.acquire).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, TAB_B, { takeover: 'self' })
      b.act()
      await b.time.advance(HEARTBEAT_MS)
      expect(modeOf(b.mode)).toMatchObject({ kind: 'editing', request: { id: incoming.id, requester: BEN } })
    })

    it('A 做完之后、B 申请之前别人申请了：回到阅读，说明谁在编辑', async () => {
      const { b } = await twoTabs({ b: { editLease: { acquire: async () => Promise.reject(HELD_BY_AMY) } } })
      await b.mode.takeOver()
      expect(b.editLease.acquire).toHaveBeenCalledOnce()
      expect(readingOf(b.mode)).toMatchObject({ holder: { holder: AMY, sameUser: false }, takeover: undefined })
    })

    it.each([
      ['保存失败（断网）', (context: ReturnType<typeof setup>) => context.api.save.mockRejectedValue(new NetworkError('断网')), 'not-saved'],
      ['版本冲突', (context: ReturnType<typeof setup>) => context.api.save.mockRejectedValue(new ApiError(409, 'DOCUMENT_REVISION_CONFLICT', '别处保存了更新的版本', { details: { currentRevision: 9, source: null } })), 'conflict'],
      ['会话不可写（不主动向服务端确认）', (context: ReturnType<typeof setup>) => context.autosave.setPage({ writable: false }), 'session'],
    ] as const)('A 没存上（%s）：留在编辑（锁留着），发 failed 与原因；B 说明原因、等人选，不申请', async (_case, arrange, reason) => {
      const { browser, a, b } = await twoTabs()
      arrange(a)
      await b.mode.takeOver()
      expect(readingOf(b.mode).takeover).toEqual({ kind: 'failed', reason })
      expect(b.editLease.acquire).not.toHaveBeenCalled()
      expect(modeOf(a.mode).kind).toBe('editing')
      expect(browser.holderOf(LOCK)).toBe('A')
      expect(a.editLease.release).not.toHaveBeenCalled()
      expect(postedTypes(browser)).toEqual(['handover-request', 'handover-ack', 'handover-failed'])
      expect(browser.posted(CHANNEL)[2]).toMatchObject({ reason })
    })

    it('A 没存上之后选"仍在此编辑"：本人接管、拿锁时抢（不再请它交出），A 随即失去编辑权（本浏览器的另一个标签页接手了），没存上的修改给副本', async () => {
      const { browser, a, b } = await twoTabs()
      a.api.save.mockRejectedValue(new NetworkError('断网'))
      await b.mode.takeOver()
      expect(readingOf(b.mode).takeover).toEqual({ kind: 'failed', reason: 'not-saved' })
      await b.mode.takeOver()
      expect(b.editLease.acquire).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, TAB_B, { takeover: 'self' })
      expect(modeOf(b.mode).kind).toBe('editing')
      expect(browser.holderOf(LOCK)).toBe('B')
      await settle()
      expect(lostOf(a.mode)).toMatchObject({ loss: { kind: 'taken-over', where: 'this-browser' }, unsaved: true })
      expect(postedTypes(browser)).toEqual(['handover-request', 'handover-ack', 'handover-failed'])
    })

    it('A 没存上之后选"取消"：回到阅读（不再接手），可以再点"在此编辑"；A 照常编辑', async () => {
      const { a, b } = await twoTabs()
      a.api.save.mockRejectedValue(new NetworkError('断网'))
      await b.mode.takeOver()
      b.mode.cancelTakeOver()
      expect(readingOf(b.mode)).toMatchObject({ takeover: undefined, holder: { sameUser: true }, selfHolder: 'this-browser' })
      expect(b.editLease.acquire).not.toHaveBeenCalled()
      expect(modeOf(a.mode).kind).toBe('editing')
    })

    it('3 秒内没有回应（A 冻结、暂停、卡住）：本人接管、拿锁时抢——恰好 3 秒，之前不申请；A 随即失去编辑权、给副本', async () => {
      const { browser, a, b } = await twoTabs({ deafA: true })
      const taking = b.mode.takeOver()
      await untilPosted(browser, 1)
      expect(readingOf(b.mode).takeover).toEqual({ kind: 'asking' })
      await b.time.advance(EDIT_TAB_HANDOVER_ACK_MS - 1)
      expect(b.editLease.acquire).not.toHaveBeenCalled()
      await b.time.advance(1)
      await taking
      expect(b.editLease.acquire).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, TAB_B, { takeover: 'self' })
      expect(modeOf(b.mode).kind).toBe('editing')
      expect(browser.holderOf(LOCK)).toBe('B')
      await settle()
      expect(lostOf(a.mode)).toMatchObject({ loss: { kind: 'taken-over', where: 'this-browser' }, unsaved: true })
      expect(postedTypes(browser)).toEqual(['handover-request'])
    })

    it('回应了、到 20 秒还没做完（保存一直没回来）：本人接管并抢锁——回应之后不按 3 秒算，做完之前不申请；A 随即失去编辑权，不再释放', async () => {
      const reply = deferred<SaveContentResponse>()
      const { browser, a, b } = await twoTabs()
      a.api.save.mockImplementation(async () => reply.promise)
      const taking = b.mode.takeOver()
      await untilPosted(browser, 2)
      expect(postedTypes(browser)).toEqual(['handover-request', 'handover-ack'])
      await b.time.advance(EDIT_TAB_HANDOVER_DONE_MS - 1)
      expect(b.editLease.acquire).not.toHaveBeenCalled()
      expect(modeOf(a.mode)).toEqual({ kind: 'exiting', cause: 'handover-tab' })
      await b.time.advance(1)
      await taking
      expect(b.editLease.acquire).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, TAB_B, { takeover: 'self' })
      await settle()
      expect(modeOf(a.mode).kind).toBe('losing')
      reply.resolve(SAVED)
      await settle()
      await settle()
      expect(lostOf(a.mode).loss).toEqual({ kind: 'taken-over', where: 'this-browser' })
      expect(a.editLease.release).not.toHaveBeenCalled()
      expect(postedTypes(browser)).toEqual(['handover-request', 'handover-ack'])
    })

    it('A 正在进入编辑（拿到了锁、编辑器还没建好）：回 busy；B 隔一会儿再请求，A 进入了就照常交出', async () => {
      const browser = fakeBrowser()
      const a = setup({ browser, tab: 'A', clientInstanceId: TAB_A })
      await opened(a)
      const gate = a.factory.holdNext()
      const entering = a.mode.enter()
      await settle()
      expect(modeOf(a.mode).kind).toBe('entering')
      expect(browser.holderOf(LOCK)).toBe('A')
      const b = setup({ api: { editStatus: async () => status(3, SELF_EDITING) }, browser, tab: 'B', clientInstanceId: TAB_B })
      await opened(b)
      const taking = b.mode.takeOver()
      await untilPosted(browser, 2)
      expect(postedTypes(browser)).toEqual(['handover-request', 'handover-busy'])
      gate.release()
      await entering
      expect(modeOf(a.mode).kind).toBe('editing')
      await b.time.advance(TAB_HANDOVER_BUSY_RETRY_MS)
      await taking
      expect(postedTypes(browser)).toEqual(['handover-request', 'handover-busy', 'handover-request', 'handover-ack', 'handover-done'])
      expect(modeOf(b.mode).kind).toBe('editing')
      expect(readingOf(a.mode).notice).toEqual({ kind: 'handed-over-tab' })
    })

    it('A 正在退出编辑：回 ack（exiting）、照常退出（释放），退出完了发 done，B 随即以本人接管申请（A 那一代已经释放：服务端按普通的取得）', async () => {
      const reply = deferred<SaveContentResponse>()
      const { browser, a, b } = await twoTabs()
      a.api.save.mockImplementation(async () => reply.promise)
      const exiting = a.mode.exit()
      await settle()
      const taking = b.mode.takeOver()
      await untilPosted(browser, 2)
      expect(browser.posted(CHANNEL)[1]).toMatchObject({ type: 'handover-ack', state: 'exiting' })
      reply.resolve(SAVED)
      await exiting
      await taking
      expect(postedTypes(browser)).toEqual(['handover-request', 'handover-ack', 'handover-done'])
      expect(readingOf(a.mode).notice).toBeUndefined()
      expect(a.editLease.release).toHaveBeenCalledOnce()
      expect(b.editLease.acquire).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, TAB_B, { takeover: 'self' })
      expect(modeOf(b.mode).kind).toBe('editing')
    })

    it('A 正在交给请求编辑的人、没交出去（请求已经不在）：修改都已存上，发 failed 的原因是没交出去（not-handed-over），不说没存上（审查 B11）', async () => {
      const incoming: PendingEditRequest = { id: '0199a2c4-1f2e-7a3b-8c4d-0000000000f9', requester: BEN, requestedAt: '2026-10-04T03:01:00.000Z' }
      const reply = deferred<SaveContentResponse>()
      const { browser, a, b } = await twoTabs()
      a.editLease.renew.mockResolvedValue({ ...RENEWED, request: incoming })
      await a.time.advance(HEARTBEAT_MS)
      expect(modeOf(a.mode)).toMatchObject({ kind: 'editing', request: { id: incoming.id } })
      a.api.save.mockImplementation(async () => reply.promise)
      a.editLease.handOver.mockRejectedValue(new ApiError(409, 'EDIT_REQUEST_GONE', '请求已不在'))
      const handing = a.mode.handOver()
      await settle()
      expect(modeOf(a.mode)).toMatchObject({ kind: 'exiting', cause: 'handover-request' })
      const taking = b.mode.takeOver()
      await untilPosted(browser, 2)
      expect(browser.posted(CHANNEL)[1]).toMatchObject({ type: 'handover-ack', state: 'exiting' })
      reply.resolve(SAVED)
      await handing
      await taking
      expect(modeOf(a.mode).kind).toBe('editing')
      expect(postedTypes(browser)).toEqual(['handover-request', 'handover-ack', 'handover-failed'])
      expect(browser.posted(CHANNEL)[2]).toMatchObject({ reason: 'not-handed-over' })
      expect(readingOf(b.mode).takeover).toEqual({ kind: 'failed', reason: 'not-handed-over' })
    })

    it('A 正在退出编辑、没退出成（保存失败）：发 failed，B 说明原因、等人选', async () => {
      const reply = deferred<SaveContentResponse>()
      const { browser, a, b } = await twoTabs()
      a.api.save.mockImplementation(async () => reply.promise)
      const exiting = a.mode.exit()
      await settle()
      const taking = b.mode.takeOver()
      await untilPosted(browser, 2)
      reply.reject(new NetworkError('断网'))
      await exiting
      await taking
      expect(postedTypes(browser)).toEqual(['handover-request', 'handover-ack', 'handover-failed'])
      expect(readingOf(b.mode).takeover).toEqual({ kind: 'failed', reason: 'not-saved' })
      expect(modeOf(a.mode).kind).toBe('editing')
    })

    it('B 接手进行中：再点不再开始一次；"编辑"、"有更新"不做事；卸载时撤下等待（之后不申请）', async () => {
      const { browser, b } = await twoTabs({ deafA: true, b: { api: { editStatus: async () => status(5, SELF_EDITING) } } })
      await b.time.advance(READING_CHECK_INTERVAL_MS)
      expect(readingOf(b.mode).update).toBe('available')
      void b.mode.takeOver()
      await untilPosted(browser, 1)
      await b.mode.takeOver()
      await b.mode.enter()
      await b.mode.refresh()
      expect(postedTypes(browser)).toEqual(['handover-request'])
      expect(b.api.contentIfChanged).not.toHaveBeenCalled()
      expect(readingOf(b.mode).takeover).toEqual({ kind: 'asking' })
      expect(await waitingForLock(browser)).toBe(1)
      b.mode.dispose()
      await settle()
      expect(await waitingForLock(browser)).toBe(0)
      await b.time.advance(EDIT_TAB_HANDOVER_DONE_MS)
      expect(b.editLease.acquire).not.toHaveBeenCalled()
    })

    it('接手进行中取消：不再等，之后不申请', async () => {
      const { browser, b } = await twoTabs({ deafA: true })
      const taking = b.mode.takeOver()
      await untilPosted(browser, 1)
      expect(readingOf(b.mode).takeover).toEqual({ kind: 'asking' })
      expect(await waitingForLock(browser)).toBe(1)
      b.mode.cancelTakeOver()
      await taking
      expect(readingOf(b.mode).takeover).toBeUndefined()
      expect(await waitingForLock(browser)).toBe(0)
      await b.time.advance(EDIT_TAB_HANDOVER_DONE_MS)
      expect(b.editLease.acquire).not.toHaveBeenCalled()
    })
  })

  describe('旧标签页回应交接请求：只理会同一个人的、自己确实还持有锁的', () => {
    it('别人的请求（用户不是本页的）：不理，照常编辑', async () => {
      const browser = fakeBrowser()
      const context = setup({ browser, tab: 'A' })
      await editing(context)
      requestFrom(browser, REQUEST_1, '0199a2c4-1f2e-7a3b-8c4d-0000000000e2')
      await settle()
      expect(postedTypes(browser)).toEqual(['handover-request'])
      expect(modeOf(context.mode).kind).toBe('editing')
    })

    it('阅读时、进入编辑还在申请时（还没拿到锁）：不理（不回 busy）', async () => {
      const acquiring = deferred<AcquiredEditLease>()
      const browser = fakeBrowser()
      const context = setup({ browser, tab: 'A', editLease: { acquire: async () => acquiring.promise } })
      await opened(context)
      requestFrom(browser, REQUEST_1)
      await settle()
      const entering = context.mode.enter()
      await settle()
      expect(modeOf(context.mode).kind).toBe('entering')
      requestFrom(browser, REQUEST_2)
      await settle()
      expect(postedTypes(browser)).toEqual(['handover-request', 'handover-request'])
      acquiring.resolve(ACQUIRED)
      await entering
    })

    it('恢复之后迟到的请求（锁已经被抢：先收到被抢，再收到请求）：已经失去编辑权，不理', async () => {
      const browser = fakeBrowser()
      const context = setup({ browser, tab: 'A' })
      await editing(context)
      context.factory.last().edit('甲')
      // B 没收到回应、本人接管成功、抢了锁（A 冻结时）；A 恢复之后先处理被抢
      await sameBrowserFor(DOCUMENT_ID, browser.tab('B')).steal()
      await settle()
      expect(lostOf(context.mode).loss).toEqual({ kind: 'taken-over', where: 'this-browser' })
      requestFrom(browser, REQUEST_1)
      await settle()
      expect(postedTypes(browser)).toEqual(['handover-request'])
      expect(context.editLease.release).not.toHaveBeenCalled()
    })

    it('恢复之后迟到的请求（另一种先后：先处理请求、开始交出，再收到被抢）：转为失去编辑权，不再接着交出——不保存、不释放、不发 done', async () => {
      const browser = fakeBrowser()
      const context = setup({ browser, tab: 'A' })
      await editing(context)
      context.factory.last().edit('甲')
      const panels = deferred<void>()
      vi.mocked(context.factory.last().editor.settlePanels).mockImplementation(async () => panels.promise)
      requestFrom(browser, REQUEST_1)
      await settle()
      expect(modeOf(context.mode)).toEqual({ kind: 'exiting', cause: 'handover-tab' })
      await sameBrowserFor(DOCUMENT_ID, browser.tab('B')).steal()
      await settle()
      expect(modeOf(context.mode).kind).toBe('losing')
      panels.resolve()
      await settle()
      await settle()
      expect(lostOf(context.mode)).toMatchObject({ loss: { kind: 'taken-over', where: 'this-browser' }, unsaved: true })
      expect(context.api.save).not.toHaveBeenCalled()
      expect(context.editLease.release).not.toHaveBeenCalled()
      expect(postedTypes(browser)).toEqual(['handover-request', 'handover-ack'])
      // 之后放弃、再进入、再退出：那个请求早已作废，不再回答它
      vi.mocked(context.factory.last().editor.settlePanels).mockImplementation(async () => {})
      await context.mode.discard()
      await settle()
      await context.mode.enter()
      expect(modeOf(context.mode).kind).toBe('editing')
      await context.mode.exit()
      expect(modeOf(context.mode).kind).toBe('reading')
      expect(postedTypes(browser)).toEqual(['handover-request', 'handover-ack'])
    })

    it('正在交出时又来一个请求（两个标签页都点了"在此编辑"）：都回 ack，交出之后都告诉 done', async () => {
      const browser = fakeBrowser()
      const context = setup({ browser, tab: 'A' })
      await editing(context)
      const panels = deferred<void>()
      vi.mocked(context.factory.last().editor.settlePanels).mockImplementation(async () => panels.promise)
      requestFrom(browser, REQUEST_1)
      await settle()
      requestFrom(browser, REQUEST_2)
      await settle()
      panels.resolve()
      await settle()
      await settle()
      expect(browser.posted(CHANNEL).map(message => [(message as { readonly type: string }).type, (message as { readonly requestId: string }).requestId])).toEqual([
        ['handover-request', REQUEST_1],
        ['handover-ack', REQUEST_1],
        ['handover-request', REQUEST_2],
        ['handover-ack', REQUEST_2],
        ['handover-done', REQUEST_1],
        ['handover-done', REQUEST_2],
      ])
      expect(readingOf(context.mode).notice).toEqual({ kind: 'handed-over-tab' })
    })
  })

  describe('跨设备被接管（续租或保存得到 taken_over）', () => {
    const takenOver = (forced: boolean): ApiError => new ApiError(409, 'EDIT_LEASE_LOST', '编辑权已失效', { details: { reason: 'taken_over', forced } })

    it('心跳得到 taken_over、forced 为假：不续上（不释放、不再申请），失去编辑权（本人在另一台设备或浏览器上接手），本页的修改给副本', async () => {
      const context = setup()
      await editing(context)
      context.factory.last().edit('甲')
      loseOnNextHeartbeat(context, takenOver(false))
      await context.time.advance(HEARTBEAT_MS)
      await settle()
      expect(lostOf(context.mode)).toMatchObject({ loss: { kind: 'taken-over', where: 'elsewhere' }, unsaved: true, readable: true })
      expect(context.editLease.acquire).toHaveBeenCalledOnce()
      expect(context.editLease.release).not.toHaveBeenCalled()
      await context.mode.saveCopy()
      expect(context.api.conflictCopy).toHaveBeenCalledOnce()
    })

    it('保存得到 taken_over：同样不续上、不重发，失去编辑权；forced 为真时是强制接管', async () => {
      const context = setup({ api: { save: async () => Promise.reject(takenOver(true)) } })
      await editing(context)
      context.factory.last().edit('甲')
      await context.mode.save()
      await settle()
      expect(lostOf(context.mode).loss).toEqual({ kind: 'forced' })
      expect(context.api.save).toHaveBeenCalledOnce()
      expect(context.editLease.acquire).toHaveBeenCalledOnce()
    })
  })
})

describe('请求编辑与交出（M3-P5 设计 §3.6，US-M3-06）', () => {
  const HANDOVER_MS = EDIT_HANDOVER_IDLE_SECONDS * 1000
  const REQUEST_ID = '0199a2c4-1f2e-7a3b-8c4d-0000000000f1'
  const OTHER_REQUEST_ID = '0199a2c4-1f2e-7a3b-8c4d-0000000000f2'
  /** 心跳带来的请求：本在请求编辑 */
  const INCOMING: PendingEditRequest = { id: REQUEST_ID, requester: BEN, requestedAt: '2026-10-04T03:01:00.000Z' }
  /** 编辑时状态里的这个请求（没在谢绝、没有失败） */
  const SHOWN = { id: REQUEST_ID, requester: BEN, declining: false, failure: undefined }

  /** 之后的心跳都带来这个请求（null：没有请求） */
  function heartbeatsCarry(context: ReturnType<typeof setup>, request: PendingEditRequest | null): void {
    context.editLease.renew.mockResolvedValue({ ...RENEWED, request })
  }

  /** 编辑时的状态（不是编辑时抛错） */
  function editingOf(mode: EditMode): Extract<EditModeState, { kind: 'editing' }> {
    const current = modeOf(mode)
    if (current.kind !== 'editing')
      throw new Error(`现在不是编辑：${current.kind}`)
    return current
  }

  /** 按先后记下每次状态变化时的状态 */
  function recordModes(context: ReturnType<typeof setup>): EditModeState[] {
    const seen: EditModeState[] = []
    context.mode.subscribe(() => seen.push(modeOf(context.mode)))
    return seen
  }

  /** 编辑、人有操作（不满 2 分钟），之后的心跳带来请求：提示出现 */
  async function prompted(context: ReturnType<typeof setup>): Promise<void> {
    await editing(context)
    heartbeatsCarry(context, INCOMING)
    context.act()
    await context.time.advance(HEARTBEAT_MS)
    expect(editingOf(context.mode).request).toEqual(SHOWN)
  }

  describe('持有者：心跳带来的请求', () => {
    it('本页有操作（不满 2 分钟）：记下请求、显示提示（编辑的状态带着它）——不交出、不挂屏障（还是编辑，编辑器不换）', async () => {
      const context = setup({ activity: 'manual' })
      await prompted(context)
      expect(modeOf(context.mode)).toEqual({ kind: 'editing', request: SHOWN, notice: undefined })
      expect(context.editLease.handOver).not.toHaveBeenCalled()
      expect(context.factory.created).toHaveLength(2)
      expect(context.factory.last().access).toBe('edit')
      // 下一次心跳带来同一个请求：不重复处理
      const before = context.mode.view().mode
      await context.time.advance(HEARTBEAT_MS)
      expect(context.mode.view().mode).toBe(before)
    })

    it('本页已空闲满 2 分钟时心跳带来请求：随即交出——同一步里挂上屏障（不显示提示）；先保存再交出（带令牌与请求的标识），停止续租（不发释放）、放锁，以只读重建，阅读里说明交给了谁（2 分钟没有操作）', async () => {
      const context = setup({ activity: 'manual' })
      await editing(context)
      context.factory.last().edit('甲')
      await context.time.advance(HANDOVER_MS)
      const seen = recordModes(context)
      heartbeatsCarry(context, INCOMING)
      await context.time.advance(HEARTBEAT_MS)
      await settle()
      expect(seen.some(state => state.kind === 'editing' && state.request !== undefined)).toBe(false)
      expect(seen[0]).toMatchObject({ kind: 'exiting', cause: 'handover-request' })
      expect(context.api.save).toHaveBeenCalledOnce()
      expect(context.editLease.handOver).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, TOKEN, REQUEST_ID)
      expect(context.api.save.mock.invocationCallOrder[0]).toBeLessThan(context.editLease.handOver.mock.invocationCallOrder[0] ?? 0)
      expect(context.editLease.release).not.toHaveBeenCalled()
      expect(readingOf(context.mode)).toMatchObject({ notice: { kind: 'handed-over', to: BEN, auto: true }, request: undefined, releaseUnconfirmed: false })
      expect(context.factory.last()).toMatchObject({ access: 'read', snapshot: snapshotOf('甲') })
      expect(context.browser.holderOf(LOCK)).toBeUndefined()
      // 这一代已经结束：不再续租
      const renewals = context.editLease.renew.mock.calls.length
      await context.time.advance(HEARTBEAT_MS * 3)
      expect(context.editLease.renew).toHaveBeenCalledTimes(renewals)
    })

    it('请求到达时本页已空闲满 2 分钟、会话却不可写（不主动向服务端确认）：不开始离开，只显示提示；会话恢复之后过一个心跳周期再看、交出（审查 B7 的 M18）', async () => {
      const context = setup({ activity: 'manual' })
      await editing(context)
      context.factory.last().edit('甲')
      await context.time.advance(HANDOVER_MS)
      context.autosave.setPage({ writable: false })
      const seen = recordModes(context)
      heartbeatsCarry(context, INCOMING)
      await context.time.advance(HEARTBEAT_MS)
      await settle()
      expect(editingOf(context.mode).request).toEqual(SHOWN)
      // 不开始离开（不挂屏障、不上传）：只显示提示
      expect(seen.some(state => state.kind === 'exiting')).toBe(false)
      expect(context.editLease.handOver).not.toHaveBeenCalled()
      expect(context.api.save).not.toHaveBeenCalled()
      context.autosave.setPage({ writable: true })
      await context.time.advance(IDLE_RECHECK_MS)
      await settle()
      expect(context.editLease.handOver).toHaveBeenCalledOnce()
      expect(readingOf(context.mode).notice).toEqual({ kind: 'handed-over', to: BEN, auto: true })
    })

    it('空闲的起点取进入编辑的时刻：打开很久之后才进入编辑、请求随即到了也不交出（显示提示）；从进入的那一刻起满 2 分钟才交出', async () => {
      const context = setup({ activity: 'manual' })
      await opened(context)
      await context.time.advance(HANDOVER_MS * 3)
      await context.mode.enter()
      heartbeatsCarry(context, INCOMING)
      await context.time.advance(HEARTBEAT_MS)
      expect(editingOf(context.mode).request).toEqual(SHOWN)
      await context.time.advance(HANDOVER_MS - HEARTBEAT_MS - 1)
      expect(modeOf(context.mode).kind).toBe('editing')
      await context.time.advance(1)
      await settle()
      expect(readingOf(context.mode).notice).toEqual({ kind: 'handed-over', to: BEN, auto: true })
    })

    it('提示在的时候：其间有操作就从最后一次操作重新算；一旦空闲满 2 分钟同样先保存再交出', async () => {
      const context = setup({ activity: 'manual' })
      await prompted(context)
      await context.time.advance(60_000)
      context.act()
      await context.time.advance(HANDOVER_MS - 1)
      expect(modeOf(context.mode).kind).toBe('editing')
      expect(context.editLease.handOver).not.toHaveBeenCalled()
      await context.time.advance(1)
      await settle()
      expect(context.editLease.handOver).toHaveBeenCalledOnce()
      expect(readingOf(context.mode).notice).toEqual({ kind: 'handed-over', to: BEN, auto: true })
    })

    it('回到前台时（Safari 隐藏之后计时器停止）按隐藏之前的操作算：满 2 分钟就在可见性的通知里开始交出', async () => {
      const context = setup({ activity: 'manual' })
      await prompted(context)
      context.page.set(true)
      context.time.elapse(HANDOVER_MS)
      context.page.set(false)
      expect(modeOf(context.mode)).toMatchObject({ kind: 'exiting', cause: 'handover-request' })
      await settle()
      await settle()
      expect(readingOf(context.mode).notice).toEqual({ kind: 'handed-over', to: BEN, auto: true })
    })

    it('"交出"（人按的）：先挂屏障（exiting、handover-request，提示留着）再等面板、上传；存上了交出，阅读里说明交给了谁（不说没有操作）；公式没收齐也交出（带"公式待更新"）', async () => {
      const context = setup({ activity: 'manual' })
      await prompted(context)
      const writer = context.factory.last()
      writer.formulasSettled = false
      writer.edit('甲')
      const seenAtSettle: EditModeState[] = []
      vi.mocked(writer.editor.settlePanels).mockImplementation(async () => {
        seenAtSettle.push(modeOf(context.mode))
      })
      const handing = context.mode.handOver()
      expect(modeOf(context.mode)).toEqual({ kind: 'exiting', cause: 'handover-request', request: SHOWN })
      await handing
      await settle()
      expect(seenAtSettle[0]).toMatchObject({ kind: 'exiting', cause: 'handover-request' })
      expect(context.api.save.mock.calls[0]?.[1]).toMatchObject({ formulasPending: true })
      expect(context.editLease.handOver).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, TOKEN, REQUEST_ID)
      expect(readingOf(context.mode)).toMatchObject({ notice: { kind: 'handed-over', to: BEN, auto: false }, formulasPending: true })
    })

    it('交出时请求已经不在（EDIT_REQUEST_GONE）：留在编辑（不释放、锁留着、照常续租），提示消失，说明请求方取消了；之后不再自动交出', async () => {
      const context = setup({ activity: 'manual', editLease: { handOver: async () => Promise.reject(new ApiError(409, 'EDIT_REQUEST_GONE', '请求已不在')) } })
      await prompted(context)
      heartbeatsCarry(context, null)
      await context.mode.handOver()
      await settle()
      expect(modeOf(context.mode)).toEqual({ kind: 'editing', request: undefined, notice: { kind: 'request-withdrawn', requester: BEN } })
      expect(context.editLease.release).not.toHaveBeenCalled()
      expect(context.browser.holderOf(LOCK)).toBe('this')
      expect(context.factory.last().access).toBe('edit')
      const renewals = context.editLease.renew.mock.calls.length
      await context.time.advance(HANDOVER_MS * 2)
      expect(context.editLease.renew.mock.calls.length).toBeGreaterThan(renewals)
      expect(context.editLease.handOver).toHaveBeenCalledOnce()
      expect(modeOf(context.mode).kind).toBe('editing')
    })

    it.each(['handed_over', 'replaced'])('交出得到 EDIT_LEASE_LOST（%s：回包丢了之后的重试、请求方已经接手）：当作交出完成', async (reason) => {
      const context = setup({ activity: 'manual', editLease: { handOver: async () => Promise.reject(leaseLost(reason)) } })
      await prompted(context)
      await context.mode.handOver()
      await settle()
      expect(readingOf(context.mode).notice).toEqual({ kind: 'handed-over', to: BEN, auto: false })
      expect(context.editLease.release).not.toHaveBeenCalled()
      expect(context.editLease.acquire).toHaveBeenCalledOnce()
    })

    it('交出得到别的失效（被本人在别处接手）：按失去编辑权处理，不续上；本页的修改都已存上（不给副本）', async () => {
      const takenOver = new ApiError(409, 'EDIT_LEASE_LOST', '编辑权已失效', { details: { reason: 'taken_over', forced: false } })
      const context = setup({ activity: 'manual', editLease: { handOver: async () => Promise.reject(takenOver) } })
      await prompted(context)
      context.factory.last().edit('甲')
      await context.mode.handOver()
      await settle()
      await settle()
      expect(lostOf(context.mode)).toMatchObject({ loss: { kind: 'taken-over', where: 'elsewhere' }, unsaved: false })
      expect(context.api.save).toHaveBeenCalledOnce()
      expect(context.editLease.acquire).toHaveBeenCalledOnce()
      expect(context.editLease.release).not.toHaveBeenCalled()
    })

    it('交出没有结果（网络）：留在编辑，提示里说明原因、请求照旧在；自动交出的过一个心跳周期再试', async () => {
      const failure = new NetworkError('断网')
      const context = setup({ activity: 'manual', editLease: { handOver: async () => Promise.reject(failure) } })
      await prompted(context)
      // 提示出现在最后一次操作之后 10 秒：再过 1 分 50 秒空闲满 2 分钟
      await context.time.advance(HANDOVER_MS - HEARTBEAT_MS)
      await settle()
      expect(editingOf(context.mode).request).toEqual({ ...SHOWN, failure: { action: 'handover', error: failure } })
      expect(context.editLease.handOver).toHaveBeenCalledOnce()
      expect(context.editLease.release).not.toHaveBeenCalled()
      await context.time.advance(IDLE_RECHECK_MS - 1)
      expect(context.editLease.handOver).toHaveBeenCalledOnce()
      context.editLease.handOver.mockResolvedValue({ reservedFor: BEN, reservedUntil: RESERVED_UNTIL })
      await context.time.advance(1)
      await settle()
      expect(context.editLease.handOver).toHaveBeenCalledTimes(2)
      expect(readingOf(context.mode).notice).toEqual({ kind: 'handed-over', to: BEN, auto: true })
    })

    it('交出迟迟没有回答：至多等 EXIT_RELEASE_WAIT_MS，留在编辑、说明原因（没有在时限之内得到回答）', async () => {
      const answer = deferred<HandedOverEditLease>()
      const context = setup({ activity: 'manual', editLease: { handOver: async () => answer.promise } })
      await prompted(context)
      const handing = context.mode.handOver()
      await settle()
      await context.time.advance(EXIT_RELEASE_WAIT_MS - 1)
      expect(modeOf(context.mode).kind).toBe('exiting')
      await context.time.advance(1)
      await handing
      const failure = editingOf(context.mode).request?.failure
      expect(failure?.action).toBe('handover')
      expect(failure?.error).toBeInstanceOf(NetworkError)
    })

    it('交出得到会话类失败（令牌失效）：交给页面确认会话，留在编辑、说明原因', async () => {
      const stale = new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效')
      const context = setup({ activity: 'manual', editLease: { handOver: async () => Promise.reject(stale) } })
      await prompted(context)
      await context.mode.handOver()
      await settle()
      expect(context.hooks.writeProblem).toHaveBeenCalledExactlyOnceWith(stale)
      expect(editingOf(context.mode).request?.failure).toEqual({ action: 'handover', error: stale })
    })

    it('没存上（保存失败）：留在编辑、不交出（说明由保存的状态给出），请求照旧在；自动交出的过一个心跳周期再试，存得上之后交出', async () => {
      const context = setup({ activity: 'manual', api: { save: async () => Promise.reject(new NetworkError('断网')) } })
      await prompted(context)
      context.factory.last().edit('甲')
      await context.time.advance(HANDOVER_MS)
      await settle()
      expect(editingOf(context.mode).request).toEqual(SHOWN)
      expect(context.mode.view().save?.status).toBe('failed')
      expect(context.editLease.handOver).not.toHaveBeenCalled()
      expect(context.editLease.release).not.toHaveBeenCalled()
      context.api.save.mockResolvedValue(SAVED)
      await context.time.advance(IDLE_RECHECK_MS)
      await settle()
      expect(context.editLease.handOver).toHaveBeenCalledOnce()
      expect(readingOf(context.mode).notice).toEqual({ kind: 'handed-over', to: BEN, auto: true })
    })

    it('再也存不上（版本冲突）：留在编辑，不再自动试（提示留着）', async () => {
      const context = setup({ activity: 'manual', api: { save: async () => Promise.reject(new ApiError(409, 'DOCUMENT_REVISION_CONFLICT', '别处保存了更新的版本', { details: { currentRevision: 9, source: null } })) } })
      await prompted(context)
      context.factory.last().edit('甲')
      await context.time.advance(HANDOVER_MS)
      await settle()
      expect(context.mode.view().save?.status).toBe('conflict')
      const saves = context.api.save.mock.calls.length
      const seen = recordModes(context)
      await context.time.advance(IDLE_RECHECK_MS * 3)
      expect(seen.filter(state => state.kind === 'exiting')).toEqual([])
      expect(context.api.save).toHaveBeenCalledTimes(saves)
      expect(editingOf(context.mode).request).toEqual(SHOWN)
    })

    it.each([
      ['会话不可写', { writable: false }],
      ['没联网', { online: false }],
    ] as const)('%s时自动交出不开始（不挂屏障、不上传），一个心跳周期之后再看', async (_case, patch) => {
      const context = setup({ activity: 'manual' })
      await prompted(context)
      context.factory.last().edit('甲')
      context.autosave.setPage(patch)
      const seen = recordModes(context)
      await context.time.advance(HANDOVER_MS)
      await settle()
      expect(seen.filter(state => state.kind === 'exiting')).toEqual([])
      expect(context.api.save).not.toHaveBeenCalled()
      context.autosave.setPage({ writable: true, online: true })
      await context.time.advance(IDLE_RECHECK_MS)
      await settle()
      expect(readingOf(context.mode).notice).toEqual({ kind: 'handed-over', to: BEN, auto: true })
    })

    it('"继续编辑"：谢绝（带令牌与请求的标识），进行中按钮不可用（declining）；成了提示消失，之后迟到的心跳带回同一个请求也不再显示，不再自动交出', async () => {
      const answer = deferred<void>()
      const context = setup({ activity: 'manual', editLease: { decline: async () => answer.promise } })
      await prompted(context)
      const declining = context.mode.decline()
      expect(editingOf(context.mode).request).toEqual({ ...SHOWN, declining: true })
      answer.resolve()
      await declining
      expect(context.editLease.decline).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, TOKEN, REQUEST_ID)
      expect(editingOf(context.mode)).toMatchObject({ request: undefined, notice: undefined })
      // 谢绝之前发出的心跳迟到，还带着它：不再显示
      await context.time.advance(HEARTBEAT_MS)
      expect(editingOf(context.mode).request).toBeUndefined()
      await context.time.advance(HANDOVER_MS * 2)
      expect(context.editLease.handOver).not.toHaveBeenCalled()
      expect(modeOf(context.mode).kind).toBe('editing')
    })

    it('谢绝期间心跳说请求不在了（谢绝已经提交）：不说"已取消请求"，等谢绝的结果', async () => {
      const answer = deferred<void>()
      const context = setup({ activity: 'manual', editLease: { decline: async () => answer.promise } })
      await prompted(context)
      const declining = context.mode.decline()
      heartbeatsCarry(context, null)
      await context.time.advance(HEARTBEAT_MS)
      expect(editingOf(context.mode)).toMatchObject({ request: { declining: true }, notice: undefined })
      answer.resolve()
      await declining
      expect(editingOf(context.mode)).toMatchObject({ request: undefined, notice: undefined })
    })

    it('谢绝没成（网络）：提示留着、说明原因，可以再按；会话类失败交给页面确认会话', async () => {
      const failure = new NetworkError('断网')
      const context = setup({ activity: 'manual', editLease: { decline: async () => Promise.reject(failure) } })
      await prompted(context)
      await context.mode.decline()
      expect(editingOf(context.mode).request).toEqual({ ...SHOWN, failure: { action: 'decline', error: failure } })
      const stale = new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效')
      context.editLease.decline.mockRejectedValueOnce(stale)
      await context.mode.decline()
      expect(context.hooks.writeProblem).toHaveBeenCalledExactlyOnceWith(stale)
      context.editLease.decline.mockResolvedValueOnce(undefined)
      await context.mode.decline()
      expect(editingOf(context.mode).request).toBeUndefined()
    })

    it('谢绝时得知这一代失效、续上了：用现在的编辑权再谢绝一次', async () => {
      const context = setup({ activity: 'manual' })
      await prompted(context)
      context.editLease.decline.mockRejectedValueOnce(leaseLost('expired'))
      context.editLease.acquire.mockResolvedValueOnce({ ...ACQUIRED, token: 'M'.repeat(43), writeEpoch: 8 })
      await context.mode.decline()
      expect(context.editLease.decline.mock.calls.map(call => call[1])).toEqual([TOKEN, 'M'.repeat(43)])
      expect(editingOf(context.mode).request).toBeUndefined()
    })

    it('请求方取消了（心跳不再带来它）：提示消失，说明一句；之后不再自动交出。之后又来了新的请求：说明消失、提示换成新的', async () => {
      const context = setup({ activity: 'manual' })
      await prompted(context)
      heartbeatsCarry(context, null)
      await context.time.advance(HEARTBEAT_MS)
      expect(editingOf(context.mode)).toEqual({ kind: 'editing', request: undefined, notice: { kind: 'request-withdrawn', requester: BEN } })
      await context.time.advance(HANDOVER_MS * 2)
      expect(context.editLease.handOver).not.toHaveBeenCalled()
      context.act()
      heartbeatsCarry(context, { ...INCOMING, id: OTHER_REQUEST_ID, requester: AMY })
      await context.time.advance(HEARTBEAT_MS)
      expect(editingOf(context.mode)).toEqual({ kind: 'editing', request: { ...SHOWN, id: OTHER_REQUEST_ID, requester: AMY }, notice: undefined })
    })

    it('进入编辑的过程中心跳就带来了请求：进入之后按编辑时的规则处理（显示提示）', async () => {
      const context = setup({ activity: 'manual', editLease: { renew: async () => ({ ...RENEWED, request: INCOMING }) } })
      await opened(context)
      context.act()
      const hold = context.factory.holdNext()
      const entering = context.mode.enter()
      await settle()
      await context.time.advance(HEARTBEAT_MS)
      expect(modeOf(context.mode).kind).toBe('entering')
      context.act()
      hold.release()
      await entering
      expect(editingOf(context.mode).request).toEqual(SHOWN)
      // 计时照常：从进入编辑（与最后一次操作中较晚的那个）起空闲满 2 分钟就交出
      await context.time.advance(HANDOVER_MS)
      await settle()
      expect(readingOf(context.mode).notice).toEqual({ kind: 'handed-over', to: BEN, auto: true })
    })

    it('退出编辑的过程中心跳带来请求、退出没成（公式没收齐）留在编辑（审查 B3，探针 B-P1）：按请求刚到处理——显示提示、开始 2 分钟的计时，一直没有操作就自动交出', async () => {
      const gate = deferred<SaveContentResponse>()
      const context = setup({ activity: 'manual', api: { save: async () => gate.promise } })
      await editing(context)
      const writer = context.factory.last()
      writer.formulasSettled = false
      writer.edit('甲')
      context.act()
      const exiting = context.mode.exit()
      await settle()
      expect(modeOf(context.mode)).toMatchObject({ kind: 'exiting', cause: 'exit' })
      // 退出的保存还在途：这期间的心跳带来请求（只记下）
      heartbeatsCarry(context, INCOMING)
      await context.time.advance(HEARTBEAT_MS)
      gate.resolve(SAVED)
      await exiting
      await settle()
      expect(editingOf(context.mode).request).toEqual(SHOWN)
      expect(context.editLease.handOver).not.toHaveBeenCalled()
      // 人一直没有操作：从最后一次操作起满 2 分钟就自动交出（之前没有计时，要等到 10 分钟的空闲释放）
      await context.time.advance(HANDOVER_MS)
      await settle()
      expect(context.editLease.handOver).toHaveBeenCalledOnce()
      expect(readingOf(context.mode).notice).toEqual({ kind: 'handed-over', to: BEN, auto: true })
    })

    it('同上，留在编辑的那一刻本页已空闲满 2 分钟、会话可写：随即自动交出（同一步里开始离开，不等计时）', async () => {
      const gate = deferred<SaveContentResponse>()
      const context = setup({ activity: 'manual', api: { save: async () => gate.promise } })
      await editing(context)
      const writer = context.factory.last()
      writer.formulasSettled = false
      writer.edit('甲')
      await context.time.advance(HANDOVER_MS)
      const exiting = context.mode.exit()
      await settle()
      heartbeatsCarry(context, INCOMING)
      await context.time.advance(HEARTBEAT_MS)
      const seen = recordModes(context)
      gate.resolve(SAVED)
      await exiting
      // 留在编辑的那一步里就开始交出（时间没有再走）：退出 → 留在编辑 → 交出
      const kinds = seen.map(state => state.kind === 'exiting' ? `exiting:${state.cause}` : state.kind)
      expect(kinds.filter((kind, index) => kind !== kinds[index - 1])).toEqual(['exiting:exit', 'editing', 'exiting:handover-request'])
      await settle()
      await settle()
      expect(context.editLease.handOver).toHaveBeenCalledOnce()
      expect(readingOf(context.mode).notice).toEqual({ kind: 'handed-over', to: BEN, auto: true })
    })

    it('新的一代：之前那一代（没能进入编辑时）记下的请求不再算，之后的心跳带来的才算', async () => {
      const content = deferred<LoadedContent>()
      const context = setup({ activity: 'manual', api: { contentIfChanged: async () => content.promise }, editLease: { acquire: async () => ({ ...ACQUIRED, revision: 4 }), renew: async () => ({ ...RENEWED, request: INCOMING }) } })
      await opened(context)
      context.act()
      // 申请得到更新的修订号、取内容的时候心跳带来了请求，之后取内容失败：没能进入编辑
      const entering = context.mode.enter()
      await settle()
      await context.time.advance(HEARTBEAT_MS)
      content.reject(new NetworkError('断网'))
      await entering
      expect(readingOf(context.mode).notice?.kind).toBe('enter-failed')
      // 再进入（新的一代）：还没有心跳带来请求，不显示提示
      context.api.contentIfChanged.mockResolvedValue({ snapshot: snapshotOf('服务端的'), revision: 4 })
      heartbeatsCarry(context, null)
      context.act()
      await context.mode.enter()
      expect(editingOf(context.mode)).toMatchObject({ request: undefined, notice: undefined })
    })
  })

  describe('退出、空闲释放与页面关闭时有请求在等：用交出代替释放', () => {
    it('退出编辑：存上了就交出（不释放），阅读里说明交给了谁', async () => {
      const context = setup({ activity: 'manual' })
      await prompted(context)
      context.factory.last().edit('甲')
      await context.mode.exit()
      expect(context.api.save).toHaveBeenCalledOnce()
      expect(context.editLease.handOver).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, TOKEN, REQUEST_ID)
      expect(context.editLease.release).not.toHaveBeenCalled()
      expect(readingOf(context.mode)).toMatchObject({ notice: { kind: 'handed-over', to: BEN, auto: false }, releaseUnconfirmed: false })
      expect(context.browser.holderOf(LOCK)).toBeUndefined()
    })

    it.each([
      ['请求刚取消（EDIT_REQUEST_GONE）', new ApiError(409, 'EDIT_REQUEST_GONE', '请求已不在')],
      ['交出没有结果（网络）', new NetworkError('断网')],
    ])('退出编辑时%s：照常释放，回到阅读不另说明', async (_case, error) => {
      const context = setup({ activity: 'manual', editLease: { handOver: async () => Promise.reject(error) } })
      await prompted(context)
      await context.mode.exit()
      expect(context.editLease.handOver).toHaveBeenCalledOnce()
      expect(context.editLease.release).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, TOKEN)
      expect(readingOf(context.mode)).toMatchObject({ notice: undefined, releaseUnconfirmed: false })
    })

    it('正在谢绝时退出：不交出（人刚选了继续编辑），照常释放', async () => {
      const answer = deferred<void>()
      const context = setup({ activity: 'manual', editLease: { decline: async () => answer.promise } })
      await prompted(context)
      void context.mode.decline()
      await context.mode.exit()
      expect(context.editLease.handOver).not.toHaveBeenCalled()
      expect(context.editLease.release).toHaveBeenCalledOnce()
      answer.resolve()
    })

    it('页面关闭：保存不忙时用 keepalive 的交出代替释放（不看结果），这一代随即停止续租', async () => {
      const context = setup({ activity: 'manual' })
      await prompted(context)
      context.mode.releaseOnHide()
      await settle()
      expect(context.editLease.handOver).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, TOKEN, REQUEST_ID)
      expect(context.editLease.release).not.toHaveBeenCalled()
      expect(context.browser.holderOf(LOCK)).toBeUndefined()
      const renewals = context.editLease.renew.mock.calls.length
      await context.time.advance(HEARTBEAT_MS * 3)
      expect(context.editLease.renew).toHaveBeenCalledTimes(renewals)
    })

    it('页面关闭时用交出代替了释放：观察钩子记下 page-hide（handed-over）', async () => {
      const events: HandoverTraceEvent[] = []
      const context = setup({ activity: 'manual', trace: event => events.push(event) })
      await prompted(context)
      context.mode.releaseOnHide()
      await settle()
      expect(events.filter(event => event.kind === 'page-hide')).toEqual([{ kind: 'page-hide', at: context.time.now(), action: 'handed-over', busy: false, unknown: false }])
    })

    it('页面关闭时交出失败也不抛出（不留下没处理的拒绝）', async () => {
      const context = setup({ activity: 'manual', editLease: { handOver: async () => Promise.reject(new NetworkError('断网')) } })
      await prompted(context)
      context.mode.releaseOnHide()
      await settle()
      expect(context.editLease.handOver).toHaveBeenCalledOnce()
    })

    it('页面关闭时保存在途（或者结果未知）：不释放、也不交出，记下记号（P4、R1 照旧）', async () => {
      const reply = deferred<SaveContentResponse>()
      const context = setup({ activity: 'manual', api: { save: async () => reply.promise } })
      await prompted(context)
      context.factory.last().edit('甲')
      const saving = context.mode.save()
      await settle()
      context.mode.releaseOnHide()
      await settle()
      expect(context.editLease.handOver).not.toHaveBeenCalled()
      expect(context.editLease.release).not.toHaveBeenCalled()
      expect(context.marker.write).toHaveBeenCalledOnce()
      reply.resolve(SAVED)
      await saving
    })

    it('交给本浏览器的另一个标签页时有请求在等：不交出、也不释放（只放弃这一代，审查 B4：那边是同一个人，以本人接管换代，请求随新的一代沿用）', async () => {
      const browser = fakeBrowser()
      const context = setup({ activity: 'manual', browser, tab: 'A' })
      await prompted(context)
      const tab = sameBrowserFor(DOCUMENT_ID, browser.tab('B'))
      tab.post({ type: 'handover-request', requestId: OTHER_REQUEST_ID, documentId: DOCUMENT_ID, from: '0199a2c4-1f2e-7a3b-8c4d-00000000bbbb', userId: AMY.id })
      await settle()
      await settle()
      await settle()
      expect(context.editLease.handOver).not.toHaveBeenCalled()
      expect(context.editLease.release).not.toHaveBeenCalled()
      expect(readingOf(context.mode).notice).toEqual({ kind: 'handed-over-tab' })
    })
  })

  describe('请求方：请求编辑', () => {
    const REQUEST_RENEW_MS = EDIT_REQUEST_RENEW_SECONDS * 1000
    /** 艾米在编辑时打开、读到她在编辑（能编辑） */
    async function readingWhileAmyEdits(context: ReturnType<typeof setup>): Promise<void> {
      await opened(context)
      expect(readingOf(context.mode).holder?.holder).toEqual(AMY)
    }
    const amyEdits = { editStatus: async () => status(3, AMY_EDITING) }
    /** 本人的请求发出的时刻（服务端给的；同一个人再发只续期，时刻不变） */
    const MY_REQUESTED_AT = '2026-10-04T03:01:00.000Z'
    /** 编辑状态里有本人的请求（刷新之前发出的，或者本人在别的页面、设备上发出的） */
    function statusWithMyRequest(requestedAt = MY_REQUESTED_AT): FetchedEditStatus {
      const fetched = status(3, AMY_EDITING)
      return { ...fetched, status: { ...fetched.status, request: { requester: AMY, requestedAt, mine: true } } }
    }
    /** 编辑状态里有留给本人的保留（请求交出之后转成的），没人在编辑 */
    function statusWithMyReservation(): FetchedEditStatus {
      const fetched = status(3)
      return { ...fetched, status: { ...fetched.status, reservation: { reservedFor: AMY, reservedUntil: RESERVED_UNTIL, mine: true } } }
    }

    it('发出：阅读里先是正在请求、再是等待（等艾米）；之后每 5 秒续期（后台请求），不另发出', async () => {
      const context = setup({ api: amyEdits })
      await readingWhileAmyEdits(context)
      const sending = context.mode.requestEdit()
      expect(readingOf(context.mode).request).toEqual({ kind: 'sending' })
      await sending
      expect(readingOf(context.mode).request).toEqual({ kind: 'waiting', holder: AMY, cancelFailure: undefined })
      expect(context.api.editRequest.send).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID)
      await context.time.advance(REQUEST_RENEW_MS)
      expect(context.api.editRequest.renew).toHaveBeenCalledOnce()
      expect(context.editLease.acquire).not.toHaveBeenCalled()
    })

    it('交给了本页（reserved）、页面看得见：以普通申请（不带接管方式）进入编辑；空闲释放从进入的那一刻重新算', async () => {
      const context = setup({ api: amyEdits, activity: 'manual' })
      await readingWhileAmyEdits(context)
      await context.time.advance(EDIT_IDLE_RELEASE_SECONDS * 1000 - 60_000)
      context.act()
      await context.mode.requestEdit()
      context.api.editRequest.renew.mockResolvedValue({ kind: 'reserved', reservedUntil: RESERVED_UNTIL })
      await context.time.advance(REQUEST_RENEW_MS)
      await settle()
      expect(context.editLease.acquire).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, PAGE_ID)
      expect(modeOf(context.mode).kind).toBe('editing')
      // 10 分钟从进入编辑算起
      await context.time.advance(EDIT_IDLE_RELEASE_SECONDS * 1000 - 1)
      expect(modeOf(context.mode).kind).toBe('editing')
    })

    it('交给了本页、页面在后台：不进入（阅读里是 granted），回到前台才进入', async () => {
      const context = setup({ api: amyEdits })
      await readingWhileAmyEdits(context)
      await context.mode.requestEdit()
      context.page.set(true)
      context.api.editRequest.renew.mockResolvedValue({ kind: 'free' })
      await context.time.advance(REQUEST_RENEW_MS)
      expect(readingOf(context.mode).request).toEqual({ kind: 'granted', until: 'visible' })
      expect(context.editLease.acquire).not.toHaveBeenCalled()
      context.page.set(false)
      await settle()
      expect(context.editLease.acquire).toHaveBeenCalledOnce()
      expect(modeOf(context.mode).kind).toBe('editing')
    })

    it('交给了本页时正在按新的版本重建（"有更新"）：重建完了再进入', async () => {
      const content = deferred<LoadedContent>()
      const context = setup({ api: { editStatus: async () => status(5, AMY_EDITING), contentIfChanged: async () => content.promise } })
      await readingWhileAmyEdits(context)
      await context.mode.requestEdit()
      const refreshing = context.mode.refresh()
      expect(readingOf(context.mode).update).toBe('loading')
      context.api.editRequest.renew.mockResolvedValue({ kind: 'reserved', reservedUntil: RESERVED_UNTIL })
      await context.time.advance(REQUEST_RENEW_MS)
      expect(context.editLease.acquire).not.toHaveBeenCalled()
      expect(readingOf(context.mode).request).toEqual({ kind: 'granted', until: 'ready' })
      content.resolve({ snapshot: snapshotOf('服务端的'), revision: 5 })
      await refreshing
      await settle()
      expect(context.editLease.acquire).toHaveBeenCalledOnce()
    })

    it('交给了本页时这一页已经不能进入编辑（检查读到不能编辑了）：不申请，请求作罢、尽力取消（清掉留给本页的保留）', async () => {
      const context = setup({ api: amyEdits })
      await readingWhileAmyEdits(context)
      await context.mode.requestEdit()
      context.api.editStatus.mockResolvedValue(status(3, AMY_EDITING, false))
      await context.time.advance(READING_CHECK_INTERVAL_MS)
      expect(readingOf(context.mode).canEdit).toBe(false)
      context.api.editRequest.renew.mockResolvedValue({ kind: 'reserved', reservedUntil: RESERVED_UNTIL })
      await context.time.advance(REQUEST_RENEW_MS)
      expect(context.editLease.acquire).not.toHaveBeenCalled()
      expect(context.api.editRequest.cancel).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID)
      expect(readingOf(context.mode).request).toBeUndefined()
    })

    it('交给了本页、申请时被别人抢先（保留期过了别人先申请）：回到阅读，说明谁在编辑，请求结束', async () => {
      const context = setup({ api: amyEdits, editLease: { acquire: async () => Promise.reject(HELD_BY_AMY) } })
      await readingWhileAmyEdits(context)
      await context.mode.requestEdit()
      context.api.editRequest.renew.mockResolvedValue({ kind: 'free' })
      await context.time.advance(REQUEST_RENEW_MS)
      await settle()
      expect(readingOf(context.mode)).toMatchObject({ request: undefined, holder: { holder: AMY } })
      await context.time.advance(REQUEST_RENEW_MS * 2)
      expect(context.api.editRequest.renew).toHaveBeenCalledOnce()
    })

    it('持有者谢绝了：结束，阅读里说明谁谢绝了；能不能强制接管随阅读的状态（页面据此另说可以请空间管理员）', async () => {
      const context = setup({ api: amyEdits })
      await readingWhileAmyEdits(context)
      await context.mode.requestEdit()
      context.api.editRequest.renew.mockResolvedValue({ kind: 'declined', id: REQUEST_ID, holder: AMY_EDITING })
      await context.time.advance(REQUEST_RENEW_MS)
      expect(readingOf(context.mode)).toMatchObject({ request: undefined, notice: { kind: 'request-declined', holder: AMY }, canTakeOver: false })
    })

    it('正在编辑的是自己（self）：改走"在此编辑"（本人接管的流程开始）', async () => {
      const context = setup({ api: amyEdits })
      await readingWhileAmyEdits(context)
      context.api.editRequest.send.mockResolvedValueOnce({ kind: 'self', holder: SELF_EDITING })
      await context.mode.requestEdit()
      await vi.waitFor(() => expect(context.editLease.acquire).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, PAGE_ID, { takeover: 'self' }))
    })

    it('别人先请求了（occupied）、编辑权刚交给了别人（reservedForOther）、请求不在了（gone）：结束并说明', async () => {
      const context = setup({ api: amyEdits })
      await readingWhileAmyEdits(context)
      context.api.editRequest.send.mockResolvedValueOnce({ kind: 'occupied', requester: BEN, requestedAt: '2026-10-04T03:00:00.000Z' })
      await context.mode.requestEdit()
      expect(readingOf(context.mode)).toMatchObject({ request: undefined, notice: { kind: 'request-occupied', requester: BEN } })
      context.api.editRequest.send.mockResolvedValueOnce({ kind: 'reservedForOther', reservedFor: BEN, reservedUntil: RESERVED_UNTIL })
      await context.mode.requestEdit()
      expect(readingOf(context.mode)).toMatchObject({ request: undefined, holder: undefined, notice: { kind: 'reserved', reservedFor: BEN, reservedUntil: RESERVED_UNTIL } })
      await context.mode.requestEdit()
      context.api.editRequest.renew.mockResolvedValueOnce({ kind: 'gone', holder: null })
      await context.time.advance(REQUEST_RENEW_MS)
      expect(readingOf(context.mode)).toMatchObject({ request: undefined, notice: { kind: 'request-gone' } })
    })

    it.each([
      ['不能编辑了（403）', DENIED, { canEdit: false, notice: { kind: 'request-denied', error: DENIED } }],
      ['网络', new NetworkError('断网'), { canEdit: true, notice: { kind: 'request-failed' } }],
      ['本页过旧', new ApiError(409, 'CLIENT_OUTDATED', '页面的版本过旧'), { blocked: 'client-outdated', notice: undefined }],
      ['读不到了（404）', GONE, { gone: true, canEdit: false }],
    ] as const)('发出失败（%s）：与申请编辑权的失败同一个口径', async (_case, error, expected) => {
      const context = setup({ api: amyEdits })
      await readingWhileAmyEdits(context)
      context.api.editRequest.send.mockRejectedValueOnce(error)
      await context.mode.requestEdit()
      expect(readingOf(context.mode)).toMatchObject({ request: undefined, ...expected })
    })

    it('发出得到会话类失败：交给页面确认会话，说明没能请求编辑', async () => {
      const stale = new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效')
      const context = setup({ api: amyEdits })
      await readingWhileAmyEdits(context)
      context.api.editRequest.send.mockRejectedValueOnce(stale)
      await context.mode.requestEdit()
      expect(context.hooks.writeProblem).toHaveBeenCalledExactlyOnceWith(stale)
      expect(readingOf(context.mode).notice).toEqual({ kind: 'request-failed', error: stale })
    })

    it('与"在此编辑"互斥：请求进行中"编辑""在此编辑"不做事；接手进行中不发出请求', async () => {
      const context = setup({ api: amyEdits })
      await readingWhileAmyEdits(context)
      await context.mode.requestEdit()
      await context.mode.enter()
      await context.mode.takeOver()
      expect(context.editLease.acquire).not.toHaveBeenCalled()
      expect(readingOf(context.mode).takeover).toBeUndefined()
      await context.mode.cancelRequest()
      // 接手进行中（"在此编辑"刚开始，还在看锁）：不发出请求
      const other = setup({ api: { editStatus: async () => status(3, SELF_EDITING) } })
      await opened(other)
      const taking = other.mode.takeOver()
      expect(readingOf(other.mode).takeover).toEqual({ kind: 'preparing' })
      await other.mode.requestEdit()
      expect(other.api.editRequest.send).not.toHaveBeenCalled()
      other.mode.cancelTakeOver()
      await taking
    })

    it('取消请求：阅读里先是正在取消、再是没有请求（不另说明）；不再续期', async () => {
      const context = setup({ api: amyEdits })
      await readingWhileAmyEdits(context)
      await context.mode.requestEdit()
      const cancelling = context.mode.cancelRequest()
      expect(readingOf(context.mode).request).toEqual({ kind: 'cancelling', holder: AMY })
      await cancelling
      expect(readingOf(context.mode)).toMatchObject({ request: undefined, notice: undefined })
      expect(context.api.editRequest.cancel).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID)
      await context.time.advance(REQUEST_RENEW_MS * 2)
      expect(context.api.editRequest.renew).not.toHaveBeenCalled()
    })

    it('等待中空闲满 10 分钟：取消请求，阅读里说明', async () => {
      const context = setup({ api: amyEdits, activity: 'manual' })
      await readingWhileAmyEdits(context)
      context.act()
      await context.mode.requestEdit()
      await context.time.advance(EDIT_IDLE_RELEASE_SECONDS * 1000)
      expect(context.api.editRequest.cancel).toHaveBeenCalledOnce()
      expect(readingOf(context.mode)).toMatchObject({ request: undefined, notice: { kind: 'request-idle' } })
    })

    it('等待中编辑器建不起来（"有更新"重建失败）：撤回请求（DELETE），不再续期——交出之后保留期里谁都进不来的那种空等不会有（审查 B7 的 M51）', async () => {
      const context = setup({ api: { editStatus: async () => status(5, AMY_EDITING) } })
      await readingWhileAmyEdits(context)
      expect(readingOf(context.mode).update).toBe('available')
      await context.mode.requestEdit()
      expect(readingOf(context.mode).request?.kind).toBe('waiting')
      context.factory.failNext()
      await context.mode.refresh()
      expect(modeOf(context.mode).kind).toBe('failed')
      expect(context.api.editRequest.cancel).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID)
      await context.time.advance(REQUEST_RENEW_MS * 3)
      expect(context.api.editRequest.renew).not.toHaveBeenCalled()
    })

    it('页面关闭：等待中的请求尽力取消（DELETE）', async () => {
      const context = setup({ api: amyEdits })
      await readingWhileAmyEdits(context)
      await context.mode.requestEdit()
      context.mode.releaseOnHide()
      expect(context.api.editRequest.cancel).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID)
      await context.time.advance(REQUEST_RENEW_MS * 2)
      expect(context.api.editRequest.renew).not.toHaveBeenCalled()
    })

    it('会话不是本人：不续期；回到本人时立即续期一次', async () => {
      const context = setup({ api: amyEdits })
      await readingWhileAmyEdits(context)
      await context.mode.requestEdit()
      context.mode.setSession('other-user')
      await context.time.advance(REQUEST_RENEW_MS * 3)
      expect(context.api.editRequest.renew).not.toHaveBeenCalled()
      context.mode.setSession('active')
      await settle()
      expect(context.api.editRequest.renew).toHaveBeenCalledOnce()
    })

    it('页面确认会话照常是本人（一直是本人，例如续期得到令牌失效之后的确认）：不让请求方立即续期，续期照它自己的节奏（审查 B1）', async () => {
      const context = setup({ api: amyEdits })
      await readingWhileAmyEdits(context)
      await context.mode.requestEdit()
      context.mode.setSession('active')
      context.mode.setSession('active')
      await settle()
      expect(context.api.editRequest.renew).not.toHaveBeenCalled()
      await context.time.advance(REQUEST_RENEW_MS)
      expect(context.api.editRequest.renew).toHaveBeenCalledOnce()
    })

    it('刷新之后恢复等待：编辑状态里有本人的请求而本页没在等，这一页发出过它（记号对得上，刷新时撤回没送到）——不另发出，直接等待、立即续期', async () => {
      const context = setup({ api: { editStatus: async () => statusWithMyRequest() } })
      context.issued.marker.write(MY_REQUESTED_AT)
      await opened(context)
      await settle()
      expect(readingOf(context.mode).request).toEqual({ kind: 'waiting', holder: AMY, cancelFailure: undefined })
      expect(context.api.editRequest.send).not.toHaveBeenCalled()
      expect(context.api.editRequest.renew).toHaveBeenCalledOnce()
    })

    it('不恢复的：检查发出之后请求的进展变过（刚取消，那次检查读到的已经过时）；不能编辑的阅读', async () => {
      const answer = deferred<FetchedEditStatus>()
      const context = setup({ api: amyEdits })
      await readingWhileAmyEdits(context)
      await context.mode.requestEdit()
      context.api.editStatus.mockReturnValueOnce(answer.promise)
      await context.time.advance(READING_CHECK_INTERVAL_MS)
      await context.mode.cancelRequest()
      answer.resolve(statusWithMyRequest())
      await settle()
      expect(readingOf(context.mode).request).toBeUndefined()
      const viewer = setup({ api: { editStatus: async () => ({ ...statusWithMyRequest(), status: { ...statusWithMyRequest().status, canEdit: false } }) } })
      await opened(viewer, false)
      await settle()
      expect(readingOf(viewer.mode).request).toBeUndefined()
    })

    it('发出（等待）时在这一页记下它（服务端给的发出时刻）；请求结束（取消）时清掉，撤回（页面关闭）时不清（刷新之后照它恢复）', async () => {
      const context = setup({ api: amyEdits })
      await readingWhileAmyEdits(context)
      await context.mode.requestEdit()
      expect(context.issued.marker.read()).toEqual({ requestedAt: MY_REQUESTED_AT })
      await context.mode.cancelRequest()
      expect(context.issued.marker.read()).toBeUndefined()
      await context.mode.requestEdit()
      context.mode.releaseOnHide()
      expect(context.api.editRequest.cancel).toHaveBeenCalledTimes(2)
      expect(context.issued.marker.read()).toBeDefined()
    })

    it('本人在别的页面、设备上发出、正在等的请求（审查 B2，探针 B-P3）：这一页不恢复等待，阅读里说一句；它关掉（pagehide）不撤回那个请求', async () => {
      const context = setup({ api: { editStatus: async () => statusWithMyRequest() } })
      await opened(context)
      await settle()
      expect(readingOf(context.mode)).toMatchObject({ request: undefined, requestedElsewhere: true })
      expect(context.api.editRequest.renew).not.toHaveBeenCalled()
      context.mode.releaseOnHide()
      expect(context.api.editRequest.cancel).not.toHaveBeenCalled()
    })

    it('同上（探针 B-P3b）：这一页只是开着、10 分钟没有操作，不空闲取消（不撤掉别处的请求），也不续期', async () => {
      const context = setup({ activity: 'manual', api: { editStatus: async () => statusWithMyRequest() } })
      await opened(context)
      await settle()
      await context.time.advance(EDIT_IDLE_RELEASE_SECONDS * 1000 + 10_000)
      await settle()
      expect(context.api.editRequest.cancel).not.toHaveBeenCalled()
      expect(context.api.editRequest.renew).not.toHaveBeenCalled()
      expect(readingOf(context.mode)).toMatchObject({ request: undefined, requestedElsewhere: true, notice: undefined })
    })

    it('同上：在这一页再点"请求编辑"照常发出（服务端只续期），这一页随之成为发出过的页面——等待、不再说在别处请求了', async () => {
      const context = setup({ api: { editStatus: async () => statusWithMyRequest() } })
      await opened(context)
      await settle()
      await context.mode.requestEdit()
      expect(context.api.editRequest.send).toHaveBeenCalledOnce()
      expect(readingOf(context.mode)).toMatchObject({ request: { kind: 'waiting' }, requestedElsewhere: false })
      expect(context.issued.marker.read()).toBeDefined()
    })

    it('记号对不上（这一页发出的那一次已经不在了，现在是别处的另一次请求）：不恢复、说在别处请求了，清掉记号；读不到本人的请求时同样清掉', async () => {
      const context = setup({ api: { editStatus: async () => statusWithMyRequest('2026-10-04T03:05:00.000Z') } })
      context.issued.marker.write(MY_REQUESTED_AT)
      await opened(context)
      await settle()
      expect(readingOf(context.mode)).toMatchObject({ request: undefined, requestedElsewhere: true })
      expect(context.issued.marker.read()).toBeUndefined()

      const gone = setup({ api: amyEdits })
      gone.issued.marker.write(MY_REQUESTED_AT)
      await opened(gone)
      await settle()
      expect(readingOf(gone.mode)).toMatchObject({ request: undefined, requestedElsewhere: false })
      expect(gone.issued.marker.read()).toBeUndefined()
    })

    it('留给本人的保留（请求交出之后转成的）：只有发出过请求的那一页恢复、自动进入编辑；别的页面不进入、也不说在别处请求（点"编辑"照常申请）', async () => {
      const issuer = setup({ api: { editStatus: async () => statusWithMyReservation() } })
      issuer.api.editRequest.renew.mockResolvedValue({ kind: 'reserved', reservedUntil: RESERVED_UNTIL })
      issuer.issued.marker.write(undefined)
      await opened(issuer)
      await settle()
      await settle()
      expect(issuer.api.editRequest.renew).toHaveBeenCalledOnce()
      expect(modeOf(issuer.mode).kind).toBe('editing')
      expect(issuer.issued.marker.read()).toBeUndefined()

      const other = setup({ api: { editStatus: async () => statusWithMyReservation() } })
      await opened(other)
      await settle()
      expect(readingOf(other.mode)).toMatchObject({ request: undefined, requestedElsewhere: false })
      expect(other.api.editRequest.renew).not.toHaveBeenCalled()
      expect(other.editLease.acquire).not.toHaveBeenCalled()
    })

    it('"编辑"时编辑权刚交给了别人（EDIT_LEASE_RESERVED）：留在阅读，说明交给了谁、留到何时（没人占着）', async () => {
      const reserved = new ApiError(409, 'EDIT_LEASE_RESERVED', '编辑权刚交给了别人', { details: { reservedFor: BEN, reservedUntil: RESERVED_UNTIL } })
      const context = setup({ editLease: { acquire: async () => Promise.reject(reserved) } })
      await opened(context)
      await context.mode.enter()
      expect(readingOf(context.mode)).toMatchObject({ holder: undefined, notice: { kind: 'reserved', reservedFor: BEN, reservedUntil: RESERVED_UNTIL } })
    })

    it('EDIT_LEASE_RESERVED 的详情认不出：照没能进入编辑说明', async () => {
      const reserved = new ApiError(409, 'EDIT_LEASE_RESERVED', '编辑权刚交给了别人', { details: { reservedFor: 'x' } })
      const context = setup({ editLease: { acquire: async () => Promise.reject(reserved) } })
      await opened(context)
      await context.mode.enter()
      expect(readingOf(context.mode).notice).toEqual({ kind: 'enter-failed', error: reserved })
    })

    it('打开时取详情里的"能不能强制接管"，之后随编辑状态更新', async () => {
      const context = setup()
      await context.mode.open({ ...LOADED, canEdit: true, canTakeOver: true }, { enterEdit: false })
      expect(readingOf(context.mode).canTakeOver).toBe(true)
      await settle()
      expect(readingOf(context.mode).canTakeOver).toBe(false)
    })
  })
})

/** 能强制接管的人看到的编辑状态（M3-P5 S8）：canTakeOver 为真 */
function adminStatus(revision: number, editor: DocumentEditor | null = null, patch: Partial<EditStatus> = {}): FetchedEditStatus {
  const plain = status(revision, editor)
  return { ...plain, status: { ...plain.status, canTakeOver: true, ...patch } }
}

/** 能强制接管的人打开、在阅读（默认艾米在编辑） */
async function adminReading(options: Setup = {}, editor: DocumentEditor | null = AMY_EDITING): Promise<ReturnType<typeof setup>> {
  const context = setup({ ...options, api: { editStatus: async () => adminStatus(3, editor), ...options.api } })
  await context.mode.open({ ...LOADED, canEdit: true, canTakeOver: true }, { enterEdit: false })
  await settle()
  return context
}

/** 本在请求编辑（心跳带来的待回应的请求） */
const BEN_REQUEST: PendingEditRequest = { id: '0199a2c4-1f2e-7a3b-8c4d-0000000000f1', requester: BEN, requestedAt: '2026-10-04T03:01:00.000Z' }

describe('强制接管（M3-P5 设计 §3.8，US-M3-09）', () => {
  const RESERVED = new ApiError(409, 'EDIT_LEASE_RESERVED', '编辑权刚交给了别人', { details: { reservedFor: BEN, reservedUntil: RESERVED_UNTIL } })
  const TAKEOVER_DENIED = new ApiError(403, 'PERMISSION_DENIED', '只有空间管理员能强制接管这份文档的编辑')

  it('能强制接管、别人在编辑：以 takeover: \'force\' 申请（只申请一次），进入编辑的过程中状态带 forced（页头的"强制接管"留着），取得了就拿锁、以可编辑重建，进入编辑', async () => {
    const answer = deferred<AcquiredEditLease>()
    const context = await adminReading({ editLease: { acquire: async () => answer.promise } })
    expect(readingOf(context.mode)).toMatchObject({ canTakeOver: true, holder: { holder: AMY, sameUser: false } })
    const taking = context.mode.forceTakeOver()
    expect(modeOf(context.mode)).toEqual({ kind: 'entering', forced: true })
    answer.resolve(ACQUIRED)
    await taking
    expect(context.editLease.acquire).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, PAGE_ID, { takeover: 'force' })
    expect(modeOf(context.mode).kind).toBe('editing')
    expect(context.factory.last().access).toBe('edit')
    expect(context.browser.holderOf(LOCK)).toBe('this')
  })

  it('"编辑"进入编辑的过程中状态不带 forced', async () => {
    const answer = deferred<AcquiredEditLease>()
    const context = await adminReading({ editLease: { acquire: async () => answer.promise } }, null)
    const entering = context.mode.enter()
    expect(modeOf(context.mode)).toEqual({ kind: 'entering' })
    answer.resolve(ACQUIRED)
    await entering
  })

  it.each([
    ['不能强制接管（编辑者）', { canTakeOver: false }, AMY_EDITING],
    ['正在编辑的是自己（走"在此编辑"：同一个浏览器里先请那边交出）', {}, SELF_EDITING],
    ['不能编辑了', { canEdit: false }, AMY_EDITING],
  ] as const)('%s：不申请', async (_case, patch, editor) => {
    const context = setup({ api: { editStatus: async () => adminStatus(3, editor, patch) } })
    await context.mode.open({ ...LOADED, canEdit: true, canTakeOver: true }, { enterEdit: false })
    await settle()
    await context.mode.forceTakeOver()
    expect(context.editLease.acquire).not.toHaveBeenCalled()
    expect(modeOf(context.mode).kind).toBe('reading')
  })

  it('请求编辑在等（与请求编辑互斥）、正在按新的版本重建时：不申请', async () => {
    const context = await adminReading()
    await context.mode.requestEdit()
    expect(readingOf(context.mode).request?.kind).toBe('waiting')
    await context.mode.forceTakeOver()
    expect(context.editLease.acquire).not.toHaveBeenCalled()
    await context.mode.cancelRequest()
    const content = deferred<LoadedContent>()
    context.api.editStatus.mockResolvedValue(adminStatus(5, AMY_EDITING))
    context.api.contentIfChanged.mockImplementation(async () => content.promise)
    await context.time.advance(READING_CHECK_INTERVAL_MS)
    const refreshing = context.mode.refresh()
    expect(readingOf(context.mode).update).toBe('loading')
    await context.mode.forceTakeOver()
    expect(context.editLease.acquire).not.toHaveBeenCalled()
    content.resolve({ snapshot: snapshotOf('服务端的'), revision: 5 })
    await refreshing
  })

  it('"在此编辑"进行中（与本人接管互斥）：不申请', async () => {
    const context = await adminReading()
    // 记号说刷新之前有一次保存在途（30 秒之内）："在此编辑"先等它
    context.marker.read.mockReturnValue({ at: new Date(2026, 9, 4, 15, 30, 11).getTime(), revision: 3 })
    const taking = context.mode.takeOver()
    await settle()
    expect(readingOf(context.mode).takeover).toEqual({ kind: 'waiting-save' })
    await context.mode.forceTakeOver()
    expect(context.editLease.acquire).not.toHaveBeenCalled()
    context.mode.cancelTakeOver()
    await taking
  })

  it('强制接管得到 403：这一页自己撤掉"强制接管"（canTakeOver 为假），不等随后的检查（检查迟迟不回来时也一样；审查 B7 的 M31）', async () => {
    const context = await adminReading({ editLease: { acquire: async () => Promise.reject(TAKEOVER_DENIED) } })
    context.api.editStatus.mockReturnValue(new Promise<FetchedEditStatus>(() => {}))
    await context.mode.forceTakeOver()
    await settle()
    expect(readingOf(context.mode)).toMatchObject({ canTakeOver: false, notice: { kind: 'force-denied', error: TAKEOVER_DENIED } })
  })

  it('不能强制接管了（403：例如刚被降为编辑者）：回到阅读，说明没能强制接管与服务端的原因，不再给"强制接管"（canTakeOver 为假），能不能编辑照旧、由随后的检查更新；之后的检查读到又能强制接管时说明随之去掉', async () => {
    const context = await adminReading({ editLease: { acquire: async () => Promise.reject(TAKEOVER_DENIED) } })
    context.api.editStatus.mockResolvedValue(adminStatus(3, AMY_EDITING, { canTakeOver: false }))
    await context.mode.forceTakeOver()
    expect(readingOf(context.mode)).toMatchObject({ canEdit: true, canTakeOver: false, holder: { holder: AMY }, notice: { kind: 'force-denied', error: TAKEOVER_DENIED } })
    // 回到阅读时立即检查一次：仍不能强制接管，说明留着
    await settle()
    expect(readingOf(context.mode)).toMatchObject({ canTakeOver: false, notice: { kind: 'force-denied' } })
    context.api.editStatus.mockResolvedValue(adminStatus(3, AMY_EDITING))
    await context.time.advance(READING_CHECK_INTERVAL_MS)
    expect(readingOf(context.mode)).toMatchObject({ canTakeOver: true, notice: undefined })
  })

  it('"编辑"得到 403 仍是原来的说法（不能编辑了），不是强制接管的', async () => {
    const context = await adminReading({ editLease: { acquire: async () => Promise.reject(DENIED) } }, null)
    context.api.editStatus.mockResolvedValue(adminStatus(3, null, { canEdit: false, canTakeOver: false }))
    await context.mode.enter()
    expect(readingOf(context.mode)).toMatchObject({ canEdit: false, notice: { kind: 'denied', error: DENIED } })
  })

  it('编辑权刚交给了别人、还在保留期内（EDIT_LEASE_RESERVED，保留期内强制接管同样被挡）：回到阅读，说明留给了谁、留到何时、是强制接管时得到的（没人占着）', async () => {
    const context = await adminReading({ editLease: { acquire: async () => Promise.reject(RESERVED) } })
    // 回到阅读时的检查读到的是那时的样子：没人在编辑（编辑权留给了本）
    context.api.editStatus.mockResolvedValue(adminStatus(3, null))
    await context.mode.forceTakeOver()
    expect(readingOf(context.mode)).toMatchObject({ holder: undefined, canTakeOver: true, notice: { kind: 'reserved', reservedFor: BEN, reservedUntil: RESERVED_UNTIL, forced: true } })
    // "编辑"得到的同一个回答不带 forced
    const plain = await adminReading({ editLease: { acquire: async () => Promise.reject(RESERVED) } }, null)
    await plain.mode.enter()
    expect(readingOf(plain.mode).notice).toEqual({ kind: 'reserved', reservedFor: BEN, reservedUntil: RESERVED_UNTIL })
  })

  it('没有成功（网络，再试一次之后仍然未知）：回到阅读，说明没能强制接管（可以再试），"强制接管"照旧；再按就进入编辑', async () => {
    const failure = new NetworkError('断网')
    const context = await adminReading({ editLease: { acquire: async () => Promise.reject(failure) } })
    const taking = context.mode.forceTakeOver()
    await context.time.advance(1_000)
    await taking
    expect(readingOf(context.mode)).toMatchObject({ canTakeOver: true, holder: { holder: AMY }, notice: { kind: 'force-failed', error: failure } })
    context.editLease.acquire.mockResolvedValueOnce(ACQUIRED)
    await context.mode.forceTakeOver()
    expect(modeOf(context.mode).kind).toBe('editing')
  })

  it('未登录或令牌失效：交给页面确认会话，说明没能强制接管', async () => {
    const error = new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效')
    const context = await adminReading({ editLease: { acquire: async () => Promise.reject(error) } })
    await context.mode.forceTakeOver()
    expect(context.hooks.writeProblem).toHaveBeenCalledExactlyOnceWith(error)
    expect(readingOf(context.mode).notice).toEqual({ kind: 'force-failed', error })
  })

  it('被占用（详情说是别人）：回到阅读、说明谁在编辑（没有别的说明）', async () => {
    const context = await adminReading({ editLease: { acquire: async () => Promise.reject(HELD_BY_AMY) } })
    await context.mode.forceTakeOver()
    expect(readingOf(context.mode)).toMatchObject({ holder: { holder: AMY, sameUser: false }, notice: undefined })
  })
})

describe('被强制接管与已经交出（M3-P5 设计 §3.6、§3.8）', () => {
  const FORCED = new ApiError(409, 'EDIT_LEASE_LOST', '编辑权已失效', { details: { reason: 'taken_over', forced: true } })
  /** 接管的人：组长 */
  const LEAD = { id: '0199a2c4-1f2e-7a3b-8c4d-0000000000e3', username: 'lead', displayName: '组长' }
  const LEAD_EDITING: DocumentEditor = { holder: LEAD, lastActiveAt: '2026-10-04T03:03:00.000Z', sameUser: false, sameSession: false }

  it('心跳得到 taken_over、forced 为真：不续上（不释放、不再申请），失去编辑权（forced）；读一次编辑状态，正在编辑的是别人就是接管的人；本页的修改给副本', async () => {
    const context = setup()
    await editing(context)
    context.factory.last().edit('甲')
    const reads = context.api.editStatus.mock.calls.length
    context.api.editStatus.mockResolvedValue(status(3, LEAD_EDITING))
    loseOnNextHeartbeat(context, FORCED)
    await context.time.advance(HEARTBEAT_MS)
    await settle()
    expect(lostOf(context.mode)).toMatchObject({ loss: { kind: 'forced', by: LEAD }, unsaved: true, readable: true })
    expect(context.api.editStatus.mock.calls.length).toBe(reads + 1)
    expect(context.editLease.acquire).toHaveBeenCalledOnce()
    expect(context.editLease.release).not.toHaveBeenCalled()
    await context.mode.saveCopy()
    expect(context.api.conflictCopy).toHaveBeenCalledOnce()
  })

  it('接管的人在失去编辑权的说明出来之后才读到：随即补上，另存为副本的进展照旧', async () => {
    const answer = deferred<FetchedEditStatus>()
    const copy = deferred<CreatedDocument>()
    const context = setup({ api: { conflictCopy: async () => copy.promise } })
    await editing(context)
    context.factory.last().edit('甲')
    context.api.editStatus.mockImplementation(async () => answer.promise)
    loseOnNextHeartbeat(context, FORCED)
    await context.time.advance(HEARTBEAT_MS)
    await settle()
    expect(lostOf(context.mode).loss).toEqual({ kind: 'forced' })
    const saving = context.mode.saveCopy()
    await settle()
    expect(lostOf(context.mode).copy).toEqual({ kind: 'saving' })
    answer.resolve(status(3, LEAD_EDITING))
    await settle()
    expect(lostOf(context.mode)).toMatchObject({ loss: { kind: 'forced', by: LEAD }, copy: { kind: 'saving' } })
    copy.resolve({ ...COPY, replayed: false })
    await saving
  })

  it.each([
    ['读不到编辑状态', async (): Promise<FetchedEditStatus> => Promise.reject(new NetworkError('断网'))],
    ['没人在编辑', async (): Promise<FetchedEditStatus> => status(3)],
    ['正在编辑的是自己（不会是接管的人）', async (): Promise<FetchedEditStatus> => status(3, SELF_EDITING)],
  ])('%s：不补接管的人（只说空间管理员强制接管了编辑）', async (_case, read) => {
    const context = setup()
    await editing(context)
    context.api.editStatus.mockImplementation(read)
    loseOnNextHeartbeat(context, FORCED)
    await context.time.advance(HEARTBEAT_MS)
    await settle()
    await settle()
    expect(lostOf(context.mode).loss).toEqual({ kind: 'forced' })
  })

  it('别的失效不读编辑状态', async () => {
    const context = setup()
    await editing(context)
    const reads = context.api.editStatus.mock.calls.length
    loseOnNextHeartbeat(context, DENIED)
    await context.time.advance(HEARTBEAT_MS)
    await settle()
    expect(lostOf(context.mode).loss).toEqual({ kind: 'denied', error: DENIED })
    expect(context.api.editStatus.mock.calls.length).toBe(reads)
  })

  it('交出的回答没收到、留在编辑，下一次心跳才得知已经交出（handed_over）：不续上，失去编辑权，交给的是还在等的那个请求的人；本页的修改都已存上', async () => {
    const context = setup({ activity: 'manual', editLease: { handOver: async () => Promise.reject(new NetworkError('断网')) } })
    await editing(context)
    context.factory.last().edit('甲')
    context.editLease.renew.mockResolvedValue({ ...RENEWED, request: BEN_REQUEST })
    context.act()
    await context.time.advance(HEARTBEAT_MS)
    await context.mode.handOver()
    await settle()
    expect(modeOf(context.mode)).toMatchObject({ kind: 'editing', request: { id: BEN_REQUEST.id, failure: { action: 'handover' } } })
    loseOnNextHeartbeat(context, leaseLost('handed_over'))
    await context.time.advance(HEARTBEAT_MS)
    await settle()
    expect(lostOf(context.mode)).toMatchObject({ loss: { kind: 'handed-over', to: BEN }, unsaved: false })
    expect(context.editLease.acquire).toHaveBeenCalledOnce()
  })

  it('已经交出、不知道交给了谁（没有在等的请求）：照样不续上，说法里不带人', async () => {
    const context = setup()
    await editing(context)
    loseOnNextHeartbeat(context, leaseLost('handed_over'))
    await context.time.advance(HEARTBEAT_MS)
    await settle()
    expect(lostOf(context.mode).loss).toEqual({ kind: 'handed-over' })
    expect(context.editLease.acquire).toHaveBeenCalledOnce()
  })
})

describe('异常中断的提醒（M3-P5 设计 §3.5、§3.11，US-M3-10）', () => {
  /** 别人（本）的那一代异常中断 */
  const OTHERS: AcquiredEditInterruption = { holder: BEN, endedAt: '2026-10-04T02:58:00.000Z', sameUser: false, samePage: false }
  /** 自己（艾米）在别的标签页或设备上的那一代异常中断 */
  const OWN: AcquiredEditInterruption = { holder: AMY, endedAt: '2026-10-04T02:55:00.000Z', sameUser: true, samePage: false }

  function editingInterruption(mode: EditMode): EditInterruption | undefined {
    const current = modeOf(mode)
    if (current.kind !== 'editing' && current.kind !== 'exiting')
      throw new Error(`现在不是编辑：${current.kind}`)
    return current.interruption
  }

  it('点"编辑"的申请带回提醒：进入编辑之后编辑的状态带着它（别人的、自己的都是）；"知道了"之后去掉', async () => {
    for (const interruption of [OTHERS, OWN]) {
      const context = setup({ editLease: { acquire: async () => ({ ...ACQUIRED, interruption }) } })
      await editing(context)
      expect(editingInterruption(context.mode)).toEqual(interruption)
      context.mode.dismissInterruption()
      expect(modeOf(context.mode)).toEqual({ kind: 'editing', request: undefined, notice: undefined, interruption: undefined })
    }
  })

  it('申请没带提醒：没有', async () => {
    const context = setup()
    await editing(context)
    expect(editingInterruption(context.mode)).toBeUndefined()
  })

  it('点"编辑"的申请带回的提醒说的是本页自己那一代（samePage：例如退出时释放没送到、到期之后本页再进入编辑）：不显示，交接日志里记成没带提醒', async () => {
    const events: HandoverTraceEvent[] = []
    const context = setup({ trace: event => events.push(event), editLease: { acquire: async () => ({ ...ACQUIRED, interruption: { ...OWN, samePage: true } }) } })
    await editing(context)
    expect(editingInterruption(context.mode)).toBeUndefined()
    expect(events.find(event => event.kind === 'acquire-result')).toMatchObject({ result: 'acquired', interruption: false })
  })

  it('离开编辑的过程中留着（"知道了"照样能按）；回到阅读之后没有，再进入编辑时按那一次申请的', async () => {
    const release = deferred<undefined>()
    const context = setup({ editLease: { acquire: async () => ({ ...ACQUIRED, interruption: OTHERS }), release: async () => release.promise } })
    await editing(context)
    const exiting = context.mode.exit()
    await settle()
    expect(modeOf(context.mode)).toMatchObject({ kind: 'exiting', cause: 'exit', interruption: OTHERS })
    context.mode.dismissInterruption()
    expect(modeOf(context.mode)).toMatchObject({ kind: 'exiting', interruption: undefined })
    release.resolve(undefined)
    await exiting
    expect(modeOf(context.mode).kind).toBe('reading')
    context.editLease.acquire.mockResolvedValueOnce(ACQUIRED)
    await context.mode.enter()
    expect(editingInterruption(context.mode)).toBeUndefined()
  })

  it('没离开成（保存失败，留在编辑）：提醒还在', async () => {
    const context = setup({ editLease: { acquire: async () => ({ ...ACQUIRED, interruption: OTHERS }) }, api: { save: async () => Promise.reject(new ApiError(422, 'SNAPSHOT_INVALID', 'x')) } })
    await editing(context)
    context.factory.last().edit('甲')
    await context.mode.exit()
    await settle()
    expect(editingInterruption(context.mode)).toEqual(OTHERS)
  })

  it('失去编辑权时去掉', async () => {
    const context = setup({ editLease: { acquire: async () => ({ ...ACQUIRED, interruption: OTHERS }) } })
    await editing(context)
    loseOnNextHeartbeat(context, DENIED)
    await context.time.advance(HEARTBEAT_MS)
    await settle()
    expect(lostOf(context.mode).kind).toBe('lost')
    context.mode.dismissInterruption()
    expect(lostOf(context.mode).kind).toBe('lost')
  })

  it('续上的申请带回提醒（编辑权中断之后，上一代就是本页自己）：不显示——续上不经用户发起的申请', async () => {
    const context = setup()
    await editing(context)
    context.editLease.acquire.mockResolvedValueOnce({ ...ACQUIRED, token: 'M'.repeat(43), writeEpoch: 8, interruption: OWN })
    loseOnNextHeartbeat(context, leaseLost('expired'))
    await context.time.advance(HEARTBEAT_MS)
    await settle()
    expect(context.editLease.acquire).toHaveBeenCalledTimes(2)
    expect(context.editLease.acquire).toHaveBeenLastCalledWith(DOCUMENT_ID, PAGE_ID, expect.objectContaining({ idleSeconds: expect.any(Number) as number }))
    expect(modeOf(context.mode)).toMatchObject({ kind: 'editing' })
    expect(editingInterruption(context.mode)).toBeUndefined()
  })

  it('"在此编辑"、请求被批准之后的自动进入、?edit=new、强制接管的申请带回的同样显示（都是用户发起的申请）', async () => {
    const self = setup({ api: { editStatus: async () => status(3, SELF_EDITING) }, editLease: { acquire: async () => ({ ...ACQUIRED, interruption: OWN }) } })
    await opened(self)
    await self.mode.takeOver()
    expect(editingInterruption(self.mode)).toEqual(OWN)

    const granted = setup({ api: { editStatus: async () => status(3, AMY_EDITING) }, editLease: { acquire: async () => ({ ...ACQUIRED, interruption: OTHERS }) } })
    granted.api.editRequest.send.mockResolvedValue({ kind: 'free' })
    await opened(granted)
    await granted.mode.requestEdit()
    await settle()
    expect(editingInterruption(granted.mode)).toEqual(OTHERS)

    const created = setup({ editLease: { acquire: async () => ({ ...ACQUIRED, interruption: OTHERS }) } })
    await created.mode.open({ ...LOADED, canEdit: true }, { enterEdit: true })
    expect(editingInterruption(created.mode)).toEqual(OTHERS)

    const forced = await adminReading({ editLease: { acquire: async () => ({ ...ACQUIRED, interruption: OTHERS }) } })
    await forced.mode.forceTakeOver()
    expect(editingInterruption(forced.mode)).toEqual(OTHERS)
  })

  it('以可编辑重建失败、回到阅读：提醒不留到下一次', async () => {
    const context = setup({ editLease: { acquire: async () => ({ ...ACQUIRED, interruption: OTHERS }) } })
    await opened(context)
    context.factory.failNext()
    await context.mode.enter()
    expect(readingOf(context.mode).notice).toEqual({ kind: 'editor-failed' })
    context.editLease.acquire.mockResolvedValueOnce(ACQUIRED)
    await context.mode.enter()
    expect(editingInterruption(context.mode)).toBeUndefined()
  })

  it('阅读时带着别人的那一代的提醒、点"编辑"却被占用（期间别人进入了编辑）：回到阅读时提醒随之去掉（有人在编辑了），说谁在编辑', async () => {
    const context = setup({ api: { editStatus: async () => ({ ...status(3), status: { ...status(3).status, interruption: OTHERS } }) }, editLease: { acquire: async () => Promise.reject(HELD_BY_AMY) } })
    await opened(context)
    expect(readingOf(context.mode).interruption).toEqual(OTHERS)
    context.api.editStatus.mockImplementation(async () => deferred<FetchedEditStatus>().promise)
    await context.mode.enter()
    expect(readingOf(context.mode)).toMatchObject({ holder: { holder: AMY }, interruption: undefined })
  })

  it('阅读时编辑状态里有别人的那一代异常中断的提醒（没人在编辑）：阅读的状态带着它；是自己的那一代时不带；之后读到没有了随之去掉；读不到了时没有', async () => {
    const context = setup({ api: { editStatus: async () => ({ ...status(3), status: { ...status(3).status, interruption: OTHERS } }) } })
    await opened(context)
    expect(readingOf(context.mode).interruption).toEqual(OTHERS)
    context.api.editStatus.mockResolvedValue({ ...status(3), status: { ...status(3).status, interruption: OWN } })
    await context.time.advance(READING_CHECK_INTERVAL_MS)
    expect(readingOf(context.mode).interruption).toBeUndefined()
    context.api.editStatus.mockResolvedValue({ ...status(3), status: { ...status(3).status, interruption: OTHERS } })
    await context.time.advance(READING_CHECK_INTERVAL_MS)
    expect(readingOf(context.mode).interruption).toEqual(OTHERS)
    context.api.editStatus.mockResolvedValue(status(3))
    await context.time.advance(READING_CHECK_INTERVAL_MS)
    expect(readingOf(context.mode).interruption).toBeUndefined()
    context.api.editStatus.mockResolvedValue({ ...status(3), status: { ...status(3).status, interruption: OTHERS } })
    await context.time.advance(READING_CHECK_INTERVAL_MS)
    context.api.editStatus.mockRejectedValue(GONE)
    await context.time.advance(READING_CHECK_INTERVAL_MS)
    expect(readingOf(context.mode)).toMatchObject({ gone: true, interruption: undefined })
  })
})

describe('测试构建的观察钩子（M3-P5 设计 §3.13）', () => {
  /** 记下报来的事件（只留种类与几样要核对的字段） */
  function recorder() {
    const events: HandoverTraceEvent[] = []
    return { events, trace: vi.fn<HandoverTrace>(event => events.push(event)), kinds: () => events.map(event => event.kind) }
  }

  it('"编辑"、离开编辑：申请（触发的操作、接管方式）、结果（带没带提醒）、进入编辑、开始离开、离开的结果，时刻按单调的时钟', async () => {
    const { events, trace, kinds } = recorder()
    const context = setup({ trace, editLease: { acquire: async () => ({ ...ACQUIRED, interruption: { holder: BEN, endedAt: '2026-10-04T02:58:00.000Z', sameUser: false, samePage: false } }) } })
    await editing(context)
    await context.mode.exit()
    expect(kinds()).toEqual(['acquire', 'acquire-result', 'entered', 'leave', 'left'])
    expect(events[0]).toEqual({ kind: 'acquire', at: context.time.now(), trigger: 'enter', takeover: null })
    expect(events[1]).toEqual({ kind: 'acquire-result', at: context.time.now(), result: 'acquired', interruption: true, code: null })
    expect(events[3]).toEqual({ kind: 'leave', at: context.time.now(), cause: 'exit' })
    expect(events[4]).toEqual({ kind: 'left', at: context.time.now(), cause: 'exit', outcome: 'reading' })
  })

  it('申请失败带错误码；强制接管带 force；没离开成是 stayed', async () => {
    const { events, trace } = recorder()
    const context = await adminReading({ trace, editLease: { acquire: async () => Promise.reject(HELD_BY_AMY) } })
    await context.mode.forceTakeOver()
    expect(events).toEqual([
      { kind: 'acquire', at: expect.any(Number) as number, trigger: 'force', takeover: 'force' },
      { kind: 'acquire-result', at: expect.any(Number) as number, result: 'held', interruption: false, code: null },
    ])
    events.length = 0
    context.editLease.acquire.mockRejectedValueOnce(DENIED)
    await context.mode.forceTakeOver()
    expect(events.at(-1)).toEqual({ kind: 'acquire-result', at: expect.any(Number) as number, result: 'failed', interruption: false, code: 'PERMISSION_DENIED' })

    const stayed = recorder()
    const editingContext = setup({ trace: stayed.trace, api: { save: async () => Promise.reject(new ApiError(422, 'SNAPSHOT_INVALID', 'x')) } })
    await editing(editingContext)
    editingContext.factory.last().edit('甲')
    await editingContext.mode.exit()
    await settle()
    expect(stayed.events.at(-1)).toEqual({ kind: 'left', at: expect.any(Number) as number, cause: 'exit', outcome: 'stayed' })
  })

  it('锁被本浏览器的另一个标签页抢走：lock-stolen', async () => {
    const { kinds, trace } = recorder()
    const context = setup({ trace })
    await editing(context)
    await sameBrowserFor(DOCUMENT_ID, context.browser.tab('other')).steal()
    await settle()
    expect(kinds()).toContain('lock-stolen')
    expect(lostOf(context.mode).loss).toEqual({ kind: 'taken-over', where: 'this-browser' })
  })

  it('同一个浏览器的交接：请求方报"在此编辑"开始、锁在本浏览器、发出请求、收到 ack、锁空了（或 done）、申请与进入；回应方报回应、开始离开、告诉它做完了、离开的结果', async () => {
    const browser = fakeBrowser()
    const a = recorder()
    const b = recorder()
    const tabA = setup({ browser, tab: 'A', trace: a.trace })
    await editing(tabA)
    const tabB = setup({ browser, tab: 'B', clientInstanceId: '0199a2c4-1f2e-7a3b-8c4d-00000000bbbb', trace: b.trace, api: { editStatus: async () => status(3, SELF_EDITING) } })
    await opened(tabB)
    await settle()
    a.events.length = 0
    await tabB.mode.takeOver()
    await settle()
    expect(modeOf(tabB.mode).kind).toBe('editing')
    // 回应（ack、done）与锁空了谁先到不定（假的频道在下一个宏任务里送到，那边存上、放锁更快时请求方先看到锁空了、不再收回应）：
    // 收到回应的写法另由 self-takeover 的单元测试核对
    const bKinds = b.kinds()
    expect(bKinds.slice(0, 3)).toEqual(['takeover-start', 'takeover-locate', 'handover-request'])
    expect(bKinds.slice(-3)).toEqual(['acquire', 'acquire-result', 'entered'])
    expect(bKinds.some(kind => kind === 'handover-lock-free' || kind === 'handover-reply')).toBe(true)
    expect(b.events.find(event => event.kind === 'takeover-locate')).toMatchObject({ here: true })
    // 那边做完之后以本人接管申请（那边不释放，审查 B4）
    expect(b.events.find(event => event.kind === 'acquire')).toMatchObject({ trigger: 'take-over', takeover: 'self' })
    expect(a.kinds()).toEqual(['handover-answer', 'leave', 'handover-finish', 'left'])
    expect(a.events[0]).toMatchObject({ answer: 'ack', state: 'editing' })
    expect(a.events[2]).toMatchObject({ outcome: 'done', reason: null })
  })

  it('请求编辑：发出的结果、续期的结果、编辑权交给了本页（页面看不看得见）、开始进入', async () => {
    const { events, trace, kinds } = recorder()
    const context = setup({ trace, api: { editStatus: async () => status(3, AMY_EDITING) } })
    await opened(context)
    await context.mode.requestEdit()
    context.api.editRequest.renew.mockResolvedValueOnce(REQUEST_PENDING).mockResolvedValueOnce({ kind: 'reserved', reservedUntil: RESERVED_UNTIL })
    await context.time.advance(EDIT_REQUEST_RENEW_SECONDS * 1000)
    await context.time.advance(EDIT_REQUEST_RENEW_SECONDS * 1000)
    await settle()
    expect(kinds()).toEqual(expect.arrayContaining(['request-sent', 'request-renewed', 'request-granted', 'request-enter', 'acquire', 'entered']))
    expect(events.find(event => event.kind === 'request-sent')).toMatchObject({ outcome: 'pending' })
    expect(events.filter(event => event.kind === 'request-renewed').map(event => event.kind === 'request-renewed' ? event.outcome : '')).toEqual(['pending', 'reserved'])
    expect(events.find(event => event.kind === 'request-granted')).toMatchObject({ visible: true })
    expect(events.find(event => event.kind === 'acquire')).toMatchObject({ trigger: 'granted', takeover: null })
  })

  it('页面关闭（pagehide）：记下走了哪一支与那一刻保存的样子——保存在途（kept、busy）、结果未知（kept、unknown：WebKit 刷新时先取消在途的请求）、释放（released）、不在编辑（idle）', async () => {
    const pageHides = (events: readonly HandoverTraceEvent[]): HandoverTraceEvent[] => events.filter(event => event.kind === 'page-hide')
    const inFlight = recorder()
    const reply = deferred<SaveContentResponse>()
    const busy = setup({ trace: inFlight.trace })
    await editing(busy)
    busy.api.save.mockImplementationOnce(async () => reply.promise)
    busy.factory.last().edit('甲')
    const saving = busy.mode.save()
    await settle()
    busy.mode.releaseOnHide()
    expect(pageHides(inFlight.events)).toEqual([{ kind: 'page-hide', at: busy.time.now(), action: 'kept', busy: true, unknown: false }])
    reply.resolve(SAVED)
    await saving

    const cancelled = recorder()
    const unknown = setup({ trace: cancelled.trace })
    await editing(unknown)
    unknown.api.save.mockRejectedValueOnce(new NetworkError('请求被取消'))
    unknown.factory.last().edit('甲')
    await unknown.mode.save()
    await settle()
    unknown.mode.releaseOnHide()
    expect(pageHides(cancelled.events)).toEqual([{ kind: 'page-hide', at: unknown.time.now(), action: 'kept', busy: false, unknown: true }])

    const quiet = recorder()
    const released = setup({ trace: quiet.trace })
    await editing(released)
    released.mode.releaseOnHide()
    expect(pageHides(quiet.events)).toEqual([{ kind: 'page-hide', at: released.time.now(), action: 'released', busy: false, unknown: false }])

    const idle = recorder()
    const reading = setup({ trace: idle.trace })
    await opened(reading)
    reading.mode.releaseOnHide()
    expect(pageHides(idle.events)).toEqual([{ kind: 'page-hide', at: reading.time.now(), action: 'idle', busy: false, unknown: false }])
    expect(reading.editLease.release).not.toHaveBeenCalled()
  })

  it('观察者出错：交给 reportError，交接照常', async () => {
    const failure = new Error('观察者出错')
    const context = setup({ trace: () => {
      throw failure
    } })
    await editing(context)
    expect(modeOf(context.mode).kind).toBe('editing')
    expect(context.reportError).toHaveBeenCalledWith(failure)
  })

  it('不给观察者（生产）：什么也不记，照常', async () => {
    const context = setup()
    await editing(context)
    expect(modeOf(context.mode).kind).toBe('editing')
    expect(context.reportError).not.toHaveBeenCalled()
  })
})
