import type { AcquiredEditLease, CreatedDocument, DocumentEditor, RenewedEditLease, SaveContentResponse } from '@nerve-office/contracts'
import type { EditorAccess, SheetEditor, SheetEditorLifecycle, SheetViewState } from '../../editor/index.ts'
import type { EditLeaseApi } from './edit-lease.ts'
import type { EditMode, EditModeApi, EditModeOptions, EditModeState, LostMode, ReadingMode } from './edit-mode.ts'
import type { FetchedEditStatus, LoadedContent } from './editor-api.ts'
import { EDIT_LEASE_HEARTBEAT_SECONDS } from '@nerve-office/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, NetworkError } from '../../shared/api/index.ts'
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
const ACQUIRED: AcquiredEditLease = { token: TOKEN, writeEpoch: 7, revision: 3, source: null, expiresAt: '2026-10-04T03:01:30.000Z', interruption: null }
const RENEWED: RenewedEditLease = { expiresAt: '2026-10-04T03:01:40.000Z' }
const SAVED: SaveContentResponse = { revision: 4, savedAt: '2026-10-04T03:00:00.000Z' }
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
  disposed: boolean
  cellEditing: boolean
  failCapture: boolean
  edit: (value: string) => void
  enter: (stage: SheetEditorLifecycle) => void
}

/** 第 n 个编辑器给出的视图状态：重建时交给下一个 */
function viewStateOf(index: number): SheetViewState {
  return { sheetId: `sheet-${index}`, topLeft: { row: index * 10, column: index }, selection: undefined }
}

function fakeFactory() {
  const created: FakeEditor[] = []
  /** 下一次创建的结果：默认立即成功；hold 时由测试放行，fail 时失败 */
  let next: 'ok' | 'fail' | { readonly gate: Promise<void> } = 'ok'
  const createEditor = vi.fn(async (options: { snapshot: string, access: EditorAccess, viewState?: SheetViewState | undefined }) => {
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
    const fake: FakeEditor = {
      access: options.access,
      snapshot: options.snapshot,
      viewState: options.viewState,
      index: created.length,
      disposed: false,
      cellEditing: false,
      failCapture: false,
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
        settleFormulas: async () => 'settled',
        capture: vi.fn(() => {
          if (fake.failCapture)
            throw new Error('SDK 出错')
          return snapshotOf(value)
        }),
        viewState: () => fake.disposed ? undefined : viewStateOf(fake.index),
        dispose: vi.fn(() => {
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
  permissions: { canEdit: true, canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: true, canCopy: true, canDelete: true, canShare: true },
} as const

/** 服务端回答编辑状态的时刻：与申请被占用时的回答同一个时刻，最后活动几分钟之前两边算出来一样 */
const ANSWERED_AT = '2026-10-04T03:03:10.000Z'

function status(revision: number, editor: DocumentEditor | null = null, canEdit = true): FetchedEditStatus {
  return { status: { revision, editor, canEdit }, serverTime: Date.parse(ANSWERED_AT) }
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

interface Setup {
  readonly api?: Partial<Omit<EditModeApi, 'editLease'>>
  readonly editLease?: Partial<EditLeaseApi>
  readonly now?: () => Date
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
    editLease,
  } satisfies EditModeApi
  const hooks = { saveUnauthenticated: vi.fn(), saveStale: vi.fn(), writeProblem: vi.fn(), readProblem: vi.fn() }
  const reportError = vi.fn()
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
    reportError,
  }
  const mode = createEditMode(modeOptions)
  modes.push(mode)
  return { mode, factory, time, page, api, editLease, hooks, reportError }
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
    expect(outcome).toEqual({ kind: 'opened', entered: false })
    expect(context.factory.created.map(fake => [fake.access, fake.snapshot, fake.viewState])).toEqual([['read', LOADED.snapshot, undefined]])
    expect(readingOf(context.mode)).toEqual({ kind: 'reading', canEdit: true, holder: undefined, update: 'none', gone: false, notice: undefined, releaseUnconfirmed: false })
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
    expect(outcome).toEqual({ kind: 'opened', entered: true })
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
    expect(outcome).toEqual({ kind: 'opened', entered: false })
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
    expect(await opening).toEqual({ kind: 'opened', entered: false })
    expect(context.factory.created.map(fake => [fake.access, fake.snapshot])).toEqual([['read', LOADED.snapshot]])
    expect(readingOf(context.mode)).toMatchObject({ canEdit: true, notice: { kind: 'enter-failed', error } })
    context.editLease.acquire.mockResolvedValueOnce(ACQUIRED)
    await context.mode.enter()
    expect(modeOf(context.mode).kind).toBe('editing')
  })

  it('?edit=new 申请时令牌失效：交给页面确认会话，以只读打开并说明', async () => {
    const error = new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效')
    const context = setup({ editLease: { acquire: async () => Promise.reject(error) } })
    expect(await context.mode.open({ ...LOADED, canEdit: true }, { enterEdit: true })).toEqual({ kind: 'opened', entered: false })
    expect(context.hooks.writeProblem).toHaveBeenCalledExactlyOnceWith(error)
    expect(readingOf(context.mode)).toMatchObject({ notice: { kind: 'enter-failed', error } })
  })

  it('?edit=new 申请得到的修订号比载入的新、取服务端的内容失败（网络）：释放刚取得的编辑权，以只读打开载入的内容并说明（审查 A11）', async () => {
    const context = setup({ editLease: { acquire: async () => ({ ...ACQUIRED, revision: 5 }) }, api: { contentIfChanged: async () => Promise.reject(new NetworkError('断网')) } })
    expect(await context.mode.open({ ...LOADED, canEdit: true }, { enterEdit: true })).toEqual({ kind: 'opened', entered: false })
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
    expect(writer.editor.capture).toHaveBeenCalledOnce()
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
    vi.mocked(writer.editor.dispose).mockImplementation(() => {
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
    writer.failCapture = true
    loseOnNextHeartbeat(context, DENIED)
    await context.time.advance(HEARTBEAT_MS)
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
    expect(context.api.conflictCopy).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, { requestId: expect.stringMatching(/^[\da-f-]{36}$/) as unknown, title: '周报（冲突副本 2026-10-04 15:30）' }, expect.anything())
    expect(context.api.content).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID)
    expect(context.factory.last()).toMatchObject({ access: 'read', snapshot: snapshotOf('最新的') })
    expect(readingOf(context.mode)).toMatchObject({ canEdit: false, notice: { kind: 'copied', document: { ...COPY, replayed: false } } })
    expect(context.mode.hasUnsavedWork()).toBe(false)
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

  it('确定被拒绝：说明原因，内容留着，可以再试；再试换新的 requestId', async () => {
    const context = await lostWithChanges()
    context.api.conflictCopy.mockRejectedValueOnce(new ApiError(422, 'SNAPSHOT_INVALID', '快照不合格'))
    await context.mode.saveCopy()
    expect(lostOf(context.mode).copy).toMatchObject({ kind: 'failed' })
    await context.mode.saveCopy()
    const [first, second] = context.api.conflictCopy.mock.calls.map(call => call[1].requestId)
    expect(second).not.toBe(first)
    expect(modeOf(context.mode).kind).toBe('reading')
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
