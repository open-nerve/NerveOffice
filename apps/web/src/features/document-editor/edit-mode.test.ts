// 编辑模式的通用核心（M6-P1 S8 spec §1.3、§1.4、§1.7）：用不带任何表格成员的假编辑器（只有会话层要的保存、槽位与打开自检）与空扩展，
// 核对核心自己能走通打开、进入、保存、退出、交接回应、失去编辑权、刷新与卸载；再核对扩展的各个挂点在原来调用表格代码的位置、按原来的先后被调用。
// 表格的全部行为（核心加表格的扩展）由 sheet-editor/sheet-edit-mode.test.ts 覆盖
import type { AcquiredEditLease, CreatedDocument, EditRequestOutcome, HandedOverEditLease, RenewedEditLease, SaveContentResponse } from '@nerve-office/contracts'
import type { AutosavePage, AutosaveTuning } from './autosave.ts'
import type { ActionTarget, EditMode, EditModeApi, EditModeExtension, EditModeHost, EditModeState, ModeEditor, StableContext } from './edit-mode.ts'
import type { FetchedEditStatus, LoadedContent } from './editor-api.ts'
import type { SlotCreateInput } from './editor-slot.ts'
import type { OpenCheck, OpenCheckContext } from './open-check-report.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PAGE_CLIENT_FORMAT } from '../../shared/api/client-format.ts'
import { ApiError } from '../../shared/api/index.ts'
import { gunzipBytes } from '../../shared/outbox/draft-codec.ts'
import { fakeLeaseClock, settle } from '../../shared/outbox/fake-lease-clock.test-support.ts'
import { DEFAULT_AUTOSAVE_LIMITS } from './autosave.ts'
import { HEARTBEAT_MS } from './edit-lease.ts'
import { createEditMode } from './edit-mode.ts'
import { memoryIssuedRequest } from './issued-request.test-support.ts'
import { fakeBrowser } from './same-browser.test-support.ts'
import { channelNameOf, sameBrowserFor } from './same-browser.ts'

// 捕获之后的压缩与内容哈希固定为恰好晚一个宏任务、同步算出的同一结果（真实的 gzip 与 SHA-256）：用例按"settle 之后已经上传"写，
// 不随机器的负载时过时不过。理由与写法同 sheet-editor/sheet-edit-mode.test.ts 的开头
vi.mock('../../shared/outbox/draft-codec.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../shared/outbox/draft-codec.ts')>()
  const { gzipSync } = await import('node:zlib')
  const { createHash } = await import('node:crypto')
  const macrotask = async (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
  return {
    ...original,
    gzipBytes: async (bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> => {
      await macrotask()
      return new Uint8Array(gzipSync(bytes))
    },
    sha256Hex: async (bytes: Uint8Array<ArrayBuffer>): Promise<string> => {
      await macrotask()
      return createHash('sha256').update(bytes).digest('hex')
    },
  }
})

const DOCUMENT_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'
const PAGE_ID = '0199a2c4-1f2e-7a3b-8c4d-00000000aaaa'
/** 本浏览器里的另一个标签页（交接请求的发出方） */
const TAB_B = '0199a2c4-1f2e-7a3b-8c4d-00000000bbbb'
const REQUEST_ID = '0199a2c4-1f2e-7a3b-8c4d-0000000000f1'
const USER_ID = '0199a2c4-1f2e-7a3b-8c4d-0000000000e1'
const CHANNEL = channelNameOf(DOCUMENT_ID)
const TOKEN = 'L'.repeat(43)

/** 快照：正文就是 body 这一项（假的编辑器原样捕获） */
function textOf(body: string): string {
  return JSON.stringify({ body })
}

const LOADED = { snapshot: textOf('载入的'), revision: 3 }
const ACQUIRED: AcquiredEditLease = { token: TOKEN, writeEpoch: 7, revision: 3, source: null, expiresAt: '2026-11-21T03:01:30.000Z', interruption: null, formulasPending: false }
const RENEWED: RenewedEditLease = { expiresAt: '2026-11-21T03:01:40.000Z', request: null, localKeyVersion: null }
const SAVED: SaveContentResponse = { revision: 4, savedAt: '2026-11-21T03:00:00.000Z', unchanged: false }
const DENIED = new ApiError(403, 'PERMISSION_DENIED', '空间已归档，只能查看')
const REQUEST_PENDING: EditRequestOutcome = { kind: 'pending', id: REQUEST_ID, requestedAt: '2026-11-21T03:01:00.000Z', expiresAt: '2026-11-21T03:11:00.000Z', holder: { holder: { id: '0199a2c4-1f2e-7a3b-8c4d-0000000000e2', username: 'ben', displayName: '本' }, lastActiveAt: '2026-11-21T03:00:00.000Z', sameUser: false, sameSession: false } }

/** 另存为副本得到的新文档 */
const COPY: CreatedDocument = {
  id: '0199a2c4-1f2e-7a3b-8c4d-0000000000c1',
  title: '周报（冲突副本 2026-11-21 15:30）',
  type: 'doc',
  createdAt: '2026-11-21T07:31:00.000Z',
  updatedAt: '2026-11-21T07:31:00.000Z',
  spaceId: '0199a2c4-1f2e-7a3b-8c4d-0000000000aa',
  space: { id: '0199a2c4-1f2e-7a3b-8c4d-0000000000aa', type: 'personal' },
  folderId: null,
  accessVia: 'space',
  revision: 1,
  profile: 'doc@1',
  formatVersion: 1,
  sdkVersion: '1.0.1',
  formulasPending: false,
  permissions: { canEdit: true, canViewHistory: true, canClearHistory: true, canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: true, canCopy: true, canDelete: true, canShare: true, canTakeOver: true },
  replayed: false,
}

function status(revision: number): FetchedEditStatus {
  return { status: { revision, editor: null, canEdit: true, canTakeOver: false, formulasPending: false, request: null, reservation: null, interruption: null }, serverTime: Date.parse('2026-11-21T03:03:10.000Z') }
}

/** 编辑器的生命周期的阶段、视图状态与创建的选项：都是这个文件自己的，与表格无关 */
type Stage = 'rendered' | 'steady'
interface View {
  readonly index: number
}
/** 扩展给出的创建选项：只有一个标记，核对扩展的 enterOptions 原样交给工厂 */
interface Options {
  readonly pending?: true
}
/** 扩展并进视图的：空扩展没有 */
interface Extra {
  readonly extra?: string
}

/** 只有会话层要的保存、槽位与打开自检，没有任何表格成员（CSV、工作表名、公式的模式与 Worker 故障） */
type TestEditor = ModeEditor<View | undefined, Stage>
type TestHost = EditModeHost<TestEditor, Stage, Options>
type TestInput = SlotCreateInput<View | undefined> & Options

interface FakeEditor {
  readonly editor: TestEditor
  /** 工厂收到的：快照、访问方式、视图状态与扩展给的选项 */
  readonly input: TestInput
  disposed: boolean
  /** 改一处：正文换成 body，修改序号加一 */
  readonly edit: (body: string) => void
}

function listen(listeners: Set<() => void>) {
  return (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
}

/** 编辑器的工厂：events 里记下销毁（与扩展的挂点排先后） */
function fakeFactory(events: string[]) {
  const created: FakeEditor[] = []
  let gate: Promise<void> | undefined
  let check: OpenCheck = { ok: true }
  const createEditor = vi.fn(async (input: TestInput): Promise<TestEditor> => {
    const waiting = gate
    gate = undefined
    if (waiting !== undefined)
      await waiting
    const index = created.length
    let content = input.snapshot
    let seq = 0
    const changes = new Set<() => void>()
    const fake: FakeEditor = {
      input,
      disposed: false,
      editor: {
        changeSeq: () => seq,
        onChange: listen(changes),
        uncommittedInput: () => 'none',
        onUncommittedInputChange: listen(new Set()),
        formulasSettled: () => true,
        onFormulaProgress: listen(new Set()),
        composing: () => false,
        onCompositionChange: listen(new Set()),
        isCellEditing: () => false,
        commitCellEditing: async () => true,
        settlePanels: async () => {},
        settleFormulas: async () => 'settled',
        capture: () => content,
        viewState: () => fake.disposed ? undefined : { index },
        dispose: async () => {
          fake.disposed = true
          events.push(`editor-dispose:${index}`)
        },
        // 阶段一直是 rendered：没有变化要通知
        lifecycle: () => 'rendered',
        onLifecycle: () => () => {},
        openCheck: check,
      },
      edit: (body) => {
        content = textOf(body)
        seq += 1
        changes.forEach(listener => listener())
      },
    }
    created.push(fake)
    return fake.editor
  })
  return {
    createEditor,
    created,
    last: (): FakeEditor => {
      const fake = created.at(-1)
      if (fake === undefined)
        throw new Error('还没有创建编辑器')
      return fake
    },
    /** 下一次创建停在中途，直到 release */
    holdNext: () => {
      let release: () => void = () => {}
      gate = new Promise<void>((resolve) => {
        release = resolve
      })
      return { release }
    },
    /** 之后新建的编辑器的打开自检 */
    checkWith: (next: OpenCheck) => {
      check = next
    },
  }
}

const NO_EXTRA: Extra = {}

/** 空扩展：什么也不做，没有自己的视图项（P2 的文字文档就是这样） */
function emptyExtension(): EditModeExtension<Options, Extra> {
  return {
    onNotify: () => {},
    afterCreate: () => {},
    blocksActions: () => false,
    view: () => NO_EXTRA,
    cancel: () => {},
    dispose: () => {},
    enterOptions: () => ({}),
    savingPending: flag => flag,
  }
}

interface Setup {
  readonly editLease?: Partial<Pick<EditModeApi['editLease'], 'acquire' | 'renew' | 'release'>>
  readonly api?: Partial<Pick<EditModeApi, 'content' | 'contentIfChanged' | 'editStatus' | 'save'>>
  readonly browser?: ReturnType<typeof fakeBrowser>
  /** 扩展的工厂：默认是空扩展。events 与编辑器的销毁共用（排先后） */
  readonly extension?: (host: TestHost, events: string[]) => EditModeExtension<Options, Extra>
}

const modes: EditMode<Stage, Extra>[] = []

afterEach(() => {
  for (const mode of modes.splice(0))
    mode.dispose()
})

function setup(options: Setup = {}) {
  const events: string[] = []
  const factory = fakeFactory(events)
  const time = fakeLeaseClock()
  const browser = options.browser ?? fakeBrowser()
  let id = 0
  const editLease = {
    acquire: vi.fn(options.editLease?.acquire ?? (async (): Promise<AcquiredEditLease> => ACQUIRED)),
    renew: vi.fn(options.editLease?.renew ?? (async (): Promise<RenewedEditLease> => RENEWED)),
    release: vi.fn(options.editLease?.release ?? (async (): Promise<void> => {})),
    handOver: vi.fn(async (): Promise<HandedOverEditLease> => {
      throw new Error('本文件的用例不交给请求编辑的人')
    }),
    decline: vi.fn(async (): Promise<void> => {}),
  }
  const api = {
    content: vi.fn(options.api?.content ?? (async (): Promise<LoadedContent> => ({ snapshot: textOf('最新的'), revision: 9 }))),
    contentIfChanged: vi.fn(options.api?.contentIfChanged ?? (async (): Promise<LoadedContent> => ({ snapshot: textOf('服务端的'), revision: 5 }))),
    editStatus: vi.fn(options.api?.editStatus ?? (async (): Promise<FetchedEditStatus> => status(3))),
    save: vi.fn(options.api?.save ?? (async (): Promise<SaveContentResponse> => SAVED)),
    conflictCopy: vi.fn(async (): Promise<CreatedDocument> => COPY),
    reportOpenCheck: vi.fn(async (): Promise<void> => {}),
    editLease,
    editRequest: {
      send: vi.fn(async (): Promise<EditRequestOutcome> => REQUEST_PENDING),
      renew: vi.fn(async (): Promise<EditRequestOutcome> => REQUEST_PENDING),
      cancel: vi.fn(async (): Promise<void> => {}),
    },
  } satisfies EditModeApi
  const page: AutosavePage = { visible: () => true, online: () => true, sessionWritable: () => true, onChange: () => () => {} }
  // 定时的上传暂停（与表格的用例一样）：按保存、退出与交出时才上传
  const tuning: AutosaveTuning = { limits: () => DEFAULT_AUTOSAVE_LIMITS, held: () => true, onChange: () => () => {} }
  let host: TestHost | undefined
  const mode = createEditMode<TestEditor, View | undefined, Stage, Options, Extra>({
    documentId: DOCUMENT_ID,
    clientInstanceId: PAGE_ID,
    userId: USER_ID,
    api,
    createEditor: factory.createEditor,
    defaultOptions: {},
    extension: (given) => {
      host = given
      return options.extension?.(given, events) ?? emptyExtension()
    },
    clock: time.clock,
    visibility: { hidden: () => false, onChange: () => () => {} },
    lastActivity: () => time.now(),
    newId: () => `0199a2c4-1f2e-7a3b-8c4d-${String(++id).padStart(12, '0')}`,
    now: () => new Date(2026, 10, 21, 15, 30, 12),
    title: () => '周报',
    session: { saveUnauthenticated: vi.fn(), saveStale: vi.fn(), writeProblem: vi.fn(), readProblem: vi.fn() },
    autosave: { page, tuning },
    sameBrowser: sameBrowserFor(DOCUMENT_ID, browser.tab('this')),
    pendingSave: { write: vi.fn(), read: vi.fn(() => undefined), clear: vi.fn() },
    issuedRequest: memoryIssuedRequest(DOCUMENT_ID).marker,
    reportError: vi.fn(),
  })
  modes.push(mode)
  return {
    mode,
    factory,
    time,
    browser,
    api,
    editLease,
    events,
    /** 核心交给扩展的一面（构造时给出） */
    host: (): TestHost => {
      if (host === undefined)
        throw new Error('核心没有调用扩展的工厂')
      return host
    },
  }
}

type Context = ReturnType<typeof setup>

function modeOf(context: Context): EditModeState {
  return context.mode.view().mode
}

async function opened(context: Context): Promise<void> {
  await context.mode.open({ ...LOADED, canEdit: true }, { enterEdit: false })
  await settle()
}

async function editing(context: Context): Promise<void> {
  await opened(context)
  await context.mode.enter()
  expect(modeOf(context).kind).toBe('editing')
}

/** 上传过的正文（解压之后） */
async function savedSnapshots(context: Context): Promise<string[]> {
  return Promise.all(context.api.save.mock.calls.map(async ([, , body]) => new TextDecoder().decode(await gunzipBytes(body))))
}

/** 本浏览器的另一个标签页请求交接（"在此编辑"） */
function requestHandover(browser: ReturnType<typeof fakeBrowser>): void {
  sameBrowserFor(DOCUMENT_ID, browser.tab('B')).post({ type: 'handover-request', requestId: REQUEST_ID, documentId: DOCUMENT_ID, from: TAB_B, userId: USER_ID })
}

function postedTypes(browser: ReturnType<typeof fakeBrowser>): string[] {
  return browser.posted(CHANNEL).map(message => (message as { readonly type: string }).type)
}

describe('编辑模式的通用核心：不带表格成员的编辑器与空扩展（M6-P1 S8 spec §1.3）', () => {
  it('打开：以只读创建、显示载入的内容，进入阅读；工厂只收到快照、访问方式与视图状态；视图只有通用的五项', async () => {
    const context = setup()
    const outcome = await context.mode.open({ ...LOADED, canEdit: true }, { enterEdit: false })
    expect(outcome).toEqual({ kind: 'opened', entered: false, damaged: false })
    expect(context.factory.created.map(fake => fake.input)).toEqual([{ access: 'read', snapshot: LOADED.snapshot, viewState: undefined }])
    expect(Object.keys(context.factory.last().input).sort()).toEqual(['access', 'snapshot', 'viewState'])
    expect(modeOf(context)).toMatchObject({ kind: 'reading', canEdit: true, update: 'none', gone: false, damaged: undefined })
    expect(Object.keys(context.mode.view()).sort()).toEqual(['autosave', 'localSave', 'mode', 'save', 'surface'])
    expect(context.mode.view()).toMatchObject({ surface: 'rendered', save: undefined })
    await settle()
    expect(context.api.editStatus).toHaveBeenCalledWith(DOCUMENT_ID)
  })

  it('打开自检失败：只能阅读（damaged），上报失败清单（每次创建至多一次）', async () => {
    const context = setup()
    const failures: [{ kind: 'resource-missing', resource: string }] = [{ kind: 'resource-missing', resource: 'DOC_HYPER_LINK_PLUGIN' }]
    context.factory.checkWith({ ok: false, failures })
    expect(await context.mode.open({ ...LOADED, canEdit: true }, { enterEdit: false })).toEqual({ kind: 'opened', entered: false, damaged: true })
    expect(modeOf(context)).toMatchObject({ kind: 'reading', damaged: failures })
    expect(context.api.reportOpenCheck).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, { revision: 3, access: 'read', trigger: 'open', failures, ...PAGE_CLIENT_FORMAT })
    await context.mode.enter()
    expect(context.editLease.acquire).not.toHaveBeenCalled()
  })

  it('进入编辑、保存、退出：以可编辑重建并交上视图状态；保存本页捕获的内容（带上令牌与代次）；退出时释放编辑权、以只读重建保存的内容', async () => {
    const context = setup()
    await opened(context)
    await context.mode.enter()
    const writer = context.factory.last()
    expect(writer.input).toEqual({ access: 'edit', snapshot: LOADED.snapshot, viewState: { index: 0 } })
    expect(context.mode.view()).toMatchObject({ mode: { kind: 'editing' }, save: { status: 'clean' } })
    writer.edit('改过的')
    await context.mode.save()
    expect(context.api.save).toHaveBeenCalledWith(DOCUMENT_ID, expect.objectContaining({ baseRevision: 3, clientInstanceId: PAGE_ID }), expect.anything(), { token: TOKEN, writeEpoch: 7 })
    expect(await savedSnapshots(context)).toEqual([textOf('改过的')])
    await context.mode.exit()
    expect(context.editLease.release).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, TOKEN)
    expect(writer.disposed).toBe(true)
    expect(context.factory.last().input).toEqual({ access: 'read', snapshot: textOf('改过的'), viewState: { index: 1 } })
    expect(modeOf(context)).toMatchObject({ kind: 'reading', canEdit: true, notice: undefined, releaseUnconfirmed: false })
    expect(context.mode.view().save).toBeUndefined()
  })

  it('交接回应：本浏览器的另一个标签页请求交接时同步回 ack，先保存再交出（不释放，只放弃这一代），回到阅读、说明交给了另一个标签页', async () => {
    const browser = fakeBrowser()
    const context = setup({ browser })
    await editing(context)
    context.factory.last().edit('交出之前改的')
    requestHandover(browser)
    await vi.waitFor(() => expect(modeOf(context).kind).toBe('reading'))
    expect(postedTypes(browser)).toEqual(['handover-request', 'handover-ack', 'handover-done'])
    expect(await savedSnapshots(context)).toEqual([textOf('交出之前改的')])
    expect(context.editLease.release).not.toHaveBeenCalled()
    expect(modeOf(context)).toMatchObject({ kind: 'reading', notice: { kind: 'handed-over-tab' } })
  })

  it('失去编辑权：续租得知不能编辑了（403），捕获本页的内容、以只读重建显示它，给副本；另存为副本之后按最新的内容回到阅读', async () => {
    const context = setup()
    await editing(context)
    const writer = context.factory.last()
    writer.edit('本页的')
    context.editLease.renew.mockRejectedValue(DENIED)
    await context.time.advance(HEARTBEAT_MS)
    await settle()
    expect(writer.disposed).toBe(true)
    expect(context.factory.last().input).toMatchObject({ access: 'read', snapshot: textOf('本页的') })
    expect(modeOf(context)).toEqual({ kind: 'lost', loss: { kind: 'denied', error: DENIED }, unsaved: true, readable: true, checking: false, captureFailed: false, inputLeft: false, reopenFailed: false, copy: { kind: 'idle' }, reload: { kind: 'idle' } })
    expect(context.mode.hasUnsavedWork()).toBe(true)
    await context.mode.saveCopy()
    expect(context.api.conflictCopy).toHaveBeenCalledOnce()
    expect(context.factory.last().input).toMatchObject({ access: 'read', snapshot: textOf('最新的') })
    expect(modeOf(context)).toMatchObject({ kind: 'reading', notice: { kind: 'copied', document: COPY } })
    expect(context.mode.hasUnsavedWork()).toBe(false)
  })

  it('有更新：按条件读取取新的版本，以只读重建并交上视图状态', async () => {
    const context = setup({ api: { editStatus: async () => status(5) } })
    await opened(context)
    expect(modeOf(context)).toMatchObject({ kind: 'reading', update: 'available' })
    await context.mode.refresh()
    expect(context.api.contentIfChanged).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, 3)
    expect(context.factory.last().input).toEqual({ access: 'read', snapshot: textOf('服务端的'), viewState: { index: 0 } })
    expect(modeOf(context)).toMatchObject({ kind: 'reading', update: 'none' })
  })

  it('卸载：尽力释放编辑权、销毁编辑器，之后不再续租、不再通知', async () => {
    const context = setup()
    await editing(context)
    const writer = context.factory.last()
    const listener = vi.fn()
    context.mode.subscribe(listener)
    context.mode.dispose()
    await settle()
    expect(context.editLease.release).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, TOKEN)
    expect(writer.disposed).toBe(true)
    await context.time.advance(HEARTBEAT_MS * 2)
    expect(context.editLease.renew).not.toHaveBeenCalled()
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('扩展的挂点（M6-P1 S8 spec §1.4、§1.6）', () => {
  it('blocksActions：编辑时、阅读（不在按新的版本重建）时挡住各个入口，交接请求回 busy；不挡时照常', async () => {
    const browser = fakeBrowser()
    let blocking = false
    const context = setup({ browser, api: { editStatus: async () => status(5) }, extension: () => ({ ...emptyExtension(), blocksActions: () => blocking }) })
    await opened(context)
    expect(modeOf(context)).toMatchObject({ kind: 'reading', update: 'available' })
    blocking = true
    await context.mode.enter()
    await context.mode.takeOver()
    await context.mode.forceTakeOver()
    await context.mode.requestEdit()
    await context.mode.refresh()
    expect(context.editLease.acquire).not.toHaveBeenCalled()
    expect(context.api.editRequest.send).not.toHaveBeenCalled()
    expect(context.api.contentIfChanged).not.toHaveBeenCalled()
    expect(modeOf(context)).toMatchObject({ kind: 'reading', update: 'available', takeover: undefined, request: undefined })
    blocking = false
    await context.mode.enter()
    expect(modeOf(context).kind).toBe('editing')
    context.factory.last().edit('甲')
    blocking = true
    await context.mode.save()
    await context.mode.exit()
    requestHandover(browser)
    await settle()
    expect(context.api.save).not.toHaveBeenCalled()
    expect(modeOf(context).kind).toBe('editing')
    expect(postedTypes(browser)).toEqual(['handover-request', 'handover-busy'])
    blocking = false
    await context.mode.exit()
    expect(await savedSnapshots(context)).toEqual([textOf('甲')])
    expect(modeOf(context).kind).toBe('reading')
  })

  it('cancel：会话变了时撤销（会话已经换好、会话代次已经加一），之后才通知；会话没变时不撤销；页面隐藏时先记下隐藏再撤销', async () => {
    let target: ActionTarget<TestEditor> | undefined
    const context = setup({
      extension: (host, events) => ({
        ...emptyExtension(),
        onNotify: () => events.push('notify'),
        cancel: () => events.push(`cancel:${host.session()}:${String(host.hidden())}:${String(target?.current())}`),
      }),
    })
    await opened(context)
    target = context.host().actionTarget()
    expect(target?.current()).toBe(true)
    context.events.length = 0
    context.mode.setSession('active')
    expect(context.events.filter(event => event.startsWith('cancel'))).toEqual([])
    context.events.length = 0
    context.mode.setSession('signed-out')
    expect(context.events[0]).toBe('cancel:signed-out:false:false')
    expect(context.events).toContain('notify')
    // 回到本人：会话是本人了，之前取的目标仍然不算数（会话代次在撤销之前已经加一）
    context.events.length = 0
    context.mode.setSession('active')
    expect(context.events[0]).toBe('cancel:active:false:false')
    expect(context.host().actionTarget()?.current()).toBe(true)
    context.events.length = 0
    context.mode.releaseOnHide()
    expect(context.events.filter(event => event.startsWith('cancel'))).toEqual(['cancel:active:true:false'])
  })

  it('dispose：卸载时先记下已卸载、再调扩展的 dispose，最后清空槽位（编辑器在它之后销毁）；只调一次', async () => {
    const context = setup({ extension: (host, events) => ({ ...emptyExtension(), dispose: () => events.push(`dispose:${String(host.disposed())}`) }) })
    await opened(context)
    context.mode.dispose()
    context.mode.dispose()
    expect(context.events).toEqual(['dispose:true', 'editor-dispose:0'])
  })

  it('afterCreate：每次创建之后、这件事还在时调用，带这一次创建的输入（打开方式、起因与修订号）；卸载之后迟到的创建不调用', async () => {
    const created: OpenCheckContext[] = []
    const context = setup({
      editLease: { acquire: async () => ({ ...ACQUIRED, revision: 5 }) },
      api: { save: async () => ({ ...SAVED, revision: 6 }), editStatus: async () => status(6) },
      extension: () => ({ ...emptyExtension(), afterCreate: input => created.push(input) }),
    })
    await opened(context)
    await context.mode.enter()
    context.factory.last().edit('改')
    await context.mode.exit()
    expect(created).toEqual([
      { access: 'read', trigger: 'open', revision: 3 },
      { access: 'edit', trigger: 'enter', revision: 5 },
      { access: 'read', trigger: 'exit', revision: 6 },
    ])
    const late: OpenCheckContext[] = []
    const another = setup({ extension: () => ({ ...emptyExtension(), afterCreate: input => late.push(input) }) })
    const gate = another.factory.holdNext()
    const opening = another.mode.open({ ...LOADED, canEdit: true }, { enterEdit: false })
    await settle()
    another.mode.dispose()
    gate.release()
    await opening
    expect(late).toEqual([])
  })

  it('onNotify：每次通知先调它（之后才算视图、通知监听者）；稳定状态交出本页的打开方式与修订号，过渡状态交出 undefined', async () => {
    const seen: (StableContext | undefined)[] = []
    const context = setup({
      extension: (_host, events) => ({
        ...emptyExtension(),
        onNotify: (stable) => {
          events.push('extension')
          seen.push(stable())
        },
      }),
    })
    context.mode.subscribe(() => context.events.push('listener'))
    await opened(context)
    expect(context.events[0]).toBe('extension')
    expect(seen[0]).toBeUndefined()
    expect(seen.at(-1)).toEqual({ access: 'read', revision: 3 })
    seen.length = 0
    await context.mode.enter()
    expect(seen).toContain(undefined)
    expect(seen.at(-1)).toEqual({ access: 'edit', revision: 3 })
    context.factory.last().edit('甲')
    await context.mode.save()
    expect(seen.at(-1)).toEqual({ access: 'edit', revision: 4 })
    // 监听者的每一次都紧跟在同一次通知里扩展的那一次之后（这个扩展自己不嵌套通知）
    expect(context.events).toContain('listener')
    context.events.forEach((event, index) => {
      if (event === 'listener')
        expect(context.events[index - 1]).toBe('extension')
    })
  })

  it('view：扩展的视图并进核心的视图；交出另一个对象时通知监听者，交出同一个对象时不通知（按引用比较）', async () => {
    let extra: Extra = { extra: '甲' }
    const context = setup({ extension: () => ({ ...emptyExtension(), view: () => extra }) })
    await opened(context)
    expect(context.mode.view()).toMatchObject({ extra: '甲', mode: { kind: 'reading' } })
    const listener = vi.fn()
    context.mode.subscribe(listener)
    context.host().notify()
    expect(listener).not.toHaveBeenCalled()
    extra = { extra: '乙' }
    context.host().notify()
    expect(listener).toHaveBeenCalledOnce()
    expect(context.mode.view().extra).toBe('乙')
    extra = { extra: '乙' }
    context.host().notify()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('enterOptions 与 savingPending：进入编辑时按申请带回的"公式待更新"取创建的选项（原样交给工厂）与保存的状态机的初值', async () => {
    const enterOptions = vi.fn((pending: boolean): Options => pending ? { pending: true } : {})
    // 与标记相反：核对核心用的是扩展交回的，不是标记本身
    const savingPending = vi.fn((flag: boolean) => !flag)
    const context = setup({ editLease: { acquire: async () => ({ ...ACQUIRED, formulasPending: true }) }, extension: () => ({ ...emptyExtension(), enterOptions, savingPending }) })
    await opened(context)
    await context.mode.enter()
    expect(enterOptions).toHaveBeenCalledExactlyOnceWith(true)
    expect(context.factory.last().input).toEqual({ access: 'edit', snapshot: LOADED.snapshot, viewState: { index: 0 }, pending: true })
    expect(savingPending).toHaveBeenCalledExactlyOnceWith(true)
    expect(context.mode.view().save?.formulasPending).toBe(false)
    await context.mode.exit()
    expect(modeOf(context).kind).toBe('reading')
    context.editLease.acquire.mockResolvedValue(ACQUIRED)
    await context.mode.enter()
    expect(enterOptions).toHaveBeenLastCalledWith(false)
    expect(Object.keys(context.factory.last().input).sort()).toEqual(['access', 'snapshot', 'viewState'])
    expect(savingPending).toHaveBeenLastCalledWith(false)
    expect(context.mode.view().save?.formulasPending).toBe(true)
  })

  it('actionTarget：阅读、编辑时交出接上的编辑器、模式与新文档判断要用的事实；开始了别的事、页面隐藏之后不再算数；没有编辑器时没有', async () => {
    const context = setup()
    expect(context.host().actionTarget()).toBeUndefined()
    await opened(context)
    const reading = context.host().actionTarget()
    expect(reading).toMatchObject({ editor: context.factory.last().editor, mode: 'reading', snapshot: LOADED.snapshot })
    expect([reading?.current(), reading?.writable(), reading?.formulasPending()]).toEqual([true, true, false])
    await context.mode.enter()
    expect(reading?.current()).toBe(false)
    const target = context.host().actionTarget()
    expect(target).toMatchObject({ editor: context.factory.last().editor, mode: 'editing' })
    expect([target?.current(), target?.revision(), target?.unsaved()]).toEqual([true, 3, false])
    context.factory.last().edit('甲')
    expect(target?.unsaved()).toBe(true)
    await context.mode.save()
    expect([target?.current(), target?.revision(), target?.unsaved()]).toEqual([true, 4, false])
    context.mode.releaseOnHide()
    expect(target?.current()).toBe(false)
  })

  it('context：扩展判断能不能接着做用的事实（代次、打开方式、会话是不是本人、允许与否、修订号），与原来公式恢复的取法相同', async () => {
    const context = setup()
    await opened(context)
    const reading = context.host().context()
    expect(reading).toMatchObject({ access: 'read', active: true, allowed: true, revision: 3 })
    await context.mode.enter()
    const entered = context.host().context()
    expect(entered).toMatchObject({ access: 'edit', active: true, allowed: true, revision: 3 })
    // 进入编辑是新的一件事：代次前进了
    expect(entered.generation).toBeGreaterThan(reading.generation)
    context.mode.setSession('other-user')
    expect(context.host().context()).toMatchObject({ generation: entered.generation, access: 'edit', active: false, allowed: true })
    context.mode.releaseOnHide()
    expect(context.host().context()).toMatchObject({ allowed: false })
  })
})
