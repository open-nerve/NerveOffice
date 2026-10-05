import type { AcquiredEditLease, CreatedDocument, DocumentEditor, OpenCheckFailure, RenewedEditLease, SaveContentResponse } from '@nerve-office/contracts'
import type { EditorAccess, OpenCheck, SheetEditor, SheetEditorLifecycle, SheetViewState } from '../../editor/index.ts'
import type { Autosave, AutosaveLimits, AutosavePage, AutosaveTuning } from './autosave.ts'
import type { EditLeaseApi } from './edit-lease.ts'
import type { EditMode, EditModeApi, EditModeOptions, EditModeState, LostMode, ReadingMode } from './edit-mode.ts'
import type { FetchedEditStatus, LoadedContent } from './editor-api.ts'
import { EDIT_LEASE_HEARTBEAT_SECONDS, EDIT_LEASE_TTL_SECONDS } from '@nerve-office/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, NetworkError } from '../../shared/api/index.ts'
import { DEFAULT_AUTOSAVE_LIMITS } from './autosave.ts'
import { PAGE_CLIENT_FORMAT } from './client-format.ts'
import { createEditMode, EXIT_RELEASE_WAIT_MS } from './edit-mode.ts'
import { CONTENT_UNCHANGED } from './editor-api.ts'
import { fakeLeaseClock, settle } from './fake-lease-clock.test-support.ts'
import { READING_CHECK_INTERVAL_MS } from './reading-checks.ts'

const DOCUMENT_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'
const PAGE_ID = '0199a2c4-1f2e-7a3b-8c4d-00000000aaaa'
const AMY = { id: '0199a2c4-1f2e-7a3b-8c4d-0000000000e1', username: 'amy', displayName: '艾米' }

/** 快照：本页的内容就是 v 这一项（假的编辑器按它捕获） */
function snapshotOf(value: string): string {
  return JSON.stringify({ id: 'unit-1', v: value })
}

const LOADED = { snapshot: snapshotOf('载入的'), revision: 3 }
const TOKEN = 'L'.repeat(43)
const ACQUIRED: AcquiredEditLease = { token: TOKEN, writeEpoch: 7, revision: 3, source: null, expiresAt: '2026-10-04T03:01:30.000Z', interruption: null, formulasPending: false }
const RENEWED: RenewedEditLease = { expiresAt: '2026-10-04T03:01:40.000Z' }
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
  permissions: { canEdit: true, canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: true, canCopy: true, canDelete: true, canShare: true },
} as const

/** 服务端回答编辑状态的时刻：与申请被占用时的回答同一个时刻，最后活动几分钟之前两边算出来一样 */
const ANSWERED_AT = '2026-10-04T03:03:10.000Z'

function status(revision: number, editor: DocumentEditor | null = null, canEdit = true): FetchedEditStatus {
  return { status: { revision, editor, canEdit, formulasPending: false }, serverTime: Date.parse(ANSWERED_AT) }
}

/** 艾米在编辑（最后活动 3 分钟前） */
const AMY_EDITING: DocumentEditor = { holder: AMY, lastActiveAt: '2026-10-04T03:00:00.000Z', sameUser: false }

/** 自己在编辑（编辑状态里是同一个人：另一个标签页，或者本页没能确认放掉的那一代） */
const SELF_EDITING: DocumentEditor = { holder: AMY, lastActiveAt: '2026-10-04T03:03:00.000Z', sameUser: true }

/** 申请时被艾米占用 */
const HELD_BY_AMY = new ApiError(409, 'EDIT_LEASE_HELD', '别人正在编辑', { details: AMY_EDITING, serverTime: Date.parse(ANSWERED_AT) })

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
  } satisfies EditModeApi
  const hooks = { saveUnauthenticated: vi.fn(), saveStale: vi.fn(), writeProblem: vi.fn(), readProblem: vi.fn() }
  const reportError = vi.fn()
  const autosave = fakeAutosave(options.autosave !== 'running')
  const modeOptions: EditModeOptions = {
    documentId: DOCUMENT_ID,
    clientInstanceId: PAGE_ID,
    api,
    createEditor: factory.createEditor,
    clock: time.clock,
    visibility: page.visibility,
    lastActivity: () => time.now(),
    newId: () => `0199a2c4-1f2e-7a3b-8c4d-${String(++id).padStart(12, '0')}`,
    now: options.now ?? (() => new Date(2026, 9, 4, 15, 30, 12)),
    title: () => '周报',
    session: hooks,
    autosave: { page: autosave.page, digest: async snapshot => `sha:${snapshot}`, tuning: autosave.tuning, attach: autosave.attach },
    reportError,
  }
  const mode = createEditMode(modeOptions)
  modes.push(mode)
  return { mode, factory, time, page, api, editLease, hooks, reportError, autosave }
}

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
    expect(readingOf(context.mode)).toEqual({ kind: 'reading', canEdit: true, holder: undefined, update: 'none', gone: false, notice: undefined, releaseUnconfirmed: false, formulasPending: false })
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
    await context.mode.exit()
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
    context.editLease.acquire.mockRejectedValue(new ApiError(409, 'EDIT_LEASE_HELD', '自己在别处编辑', { details: SELF_EDITING, serverTime: Date.parse(ANSWERED_AT) }))
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
    await context.mode.discard()
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

  it('离开阅读时停掉检查的计时器：进入编辑之后只剩编辑权的心跳', async () => {
    const context = setup()
    await opened(context)
    expect(context.time.pending()).toBe(1)
    await context.mode.enter()
    expect(modeOf(context.mode).kind).toBe('editing')
    // 自动保存建起来时立即看一次（M3-P4）：没有要捕获、要上传的，之后不再排计时器
    await context.time.advance(0)
    expect(context.time.pending()).toBe(1)
    await context.time.advance(HEARTBEAT_MS)
    expect(context.editLease.renew).toHaveBeenCalledOnce()
    expect(context.time.pending()).toBe(1)
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
  it('保存得到可以续上的失效（到期）：放掉手里那一代、重新申请，续上之后用新的编辑权重发这一次（requestId 不变），保存成功', async () => {
    const next = { ...ACQUIRED, token: 'M'.repeat(43), writeEpoch: 8 }
    const context = setup()
    await editing(context)
    context.editLease.acquire.mockResolvedValueOnce(next)
    context.api.save.mockRejectedValueOnce(new ApiError(409, 'EDIT_LEASE_LOST', '编辑权已失效', { details: { reason: 'expired' } }))
    context.factory.last().edit('甲')
    await context.mode.save()
    expect(context.editLease.release).toHaveBeenCalledWith(DOCUMENT_ID, TOKEN)
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
    return { status: { revision, editor: null, canEdit: true, formulasPending }, serverTime: Date.parse(ANSWERED_AT) }
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
