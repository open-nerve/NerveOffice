// 通用的编辑器页（M6-P1 S8 spec §2.10）：用不带任何表格成员的假编辑器与假装配，挂在表格以外的类型（doc）上，核对：
// - 通用页面自己能走通载入、阅读、进入与退出编辑、卸载，视图照抄编辑模式视图里扩展的部分；
// - 载入详情之后按类型选装配：没有装配、档案不符、格式版本不在列表里，都进入“格式不受支持”，不建扩展、编辑器与恢复；
// - 装配的档案注入到编辑权与请求编辑的请求、草稿、打开自检的上报与恢复的可读判定（载入之后只用选中的那一个，404 之后用装配表里全部的）；
// - 页面扩展的各个挂点在原来调用表格代码的位置、按原来的先后被调用（S8 spec §2.4、§2.9）。
// 表格的全部页面行为（通用页面加表格的装配）由 sheet-editor/sheet-editor-page.test.ts 覆盖
import type { AcquiredEditLease, CreatedDocument, DocumentDetail, DocumentType, EditRequestOutcome, HandedOverEditLease, RenewedEditLease, SaveContentResponse, SessionResponse } from '@nerve-office/contracts'
import type { PageClientFormat } from '../../shared/api/client-format.ts'
import type { RecoveryReader } from '../../shared/local-drafts/recovery-reader.ts'
import type { AutosaveTuning } from './autosave.ts'
import type { EditMode, EditModeExtension, EditModeHost, ModeEditor } from './edit-mode.ts'
import type { FetchedEditStatus, LoadedContent } from './editor-api.ts'
import type { EditorPage, EditorPageApi, EditorPageAssembly, EditorPageBindings, EditorPageExtension, EditorPageHost } from './editor-page.ts'
import type { SlotCreateInput } from './editor-slot.ts'
import type { OpenCheck } from './open-check-report.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clientFormatOf } from '../../shared/api/client-format.ts'
import { ApiError, setCsrfToken } from '../../shared/api/index.ts'
import { gzipBytes } from '../../shared/outbox/draft-codec.ts'
import { sampleMeta } from '../../shared/outbox/draft-record.test-support.ts'
import { fakeLeaseClock, settle } from '../../shared/outbox/fake-lease-clock.test-support.ts'
import { DEFAULT_AUTOSAVE_LIMITS } from './autosave.ts'
import { createEditMode } from './edit-mode.ts'
import { createEditorPage } from './editor-page.ts'
import { memoryIssuedRequest } from './issued-request.test-support.ts'
import { fakeBrowser } from './same-browser.test-support.ts'
import { sameBrowserFor } from './same-browser.ts'

const DOCUMENT_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'
const TOKEN = 'L'.repeat(43)
/** 装配的档案：文字文档的（页面不知道它是哪一类，只按装配取） */
const DOC_FORMAT = clientFormatOf('doc')
const SHEET_FORMAT = clientFormatOf('sheet')

const ALICE: SessionResponse = {
  user: { id: '0199a2c4-1f2e-7a3b-8c4d-00000000000a', username: 'alice', displayName: '爱丽丝', systemRole: 'member' },
  personalSpace: { id: '0199a2c4-2a3b-7c4d-9e5f-00000000000a', name: '爱丽丝' },
  csrfToken: 'csrf-alice',
  features: { localDraftsEnabled: true },
}

const DETAIL: DocumentDetail = {
  id: DOCUMENT_ID,
  title: '周记',
  type: 'doc',
  createdAt: '2026-11-21T01:00:00.000Z',
  updatedAt: '2026-11-21T02:00:00.000Z',
  spaceId: ALICE.personalSpace.id,
  space: { id: ALICE.personalSpace.id, type: 'personal' },
  folderId: null,
  accessVia: 'space',
  revision: 3,
  profile: 'doc@1',
  formatVersion: 1,
  sdkVersion: '1.0.1',
  formulasPending: false,
  permissions: { canEdit: true, canViewHistory: true, canClearHistory: false, canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: false, canCopy: true, canDelete: true, canShare: false, canTakeOver: true },
}

/** 快照：正文就是 body 这一项（假的编辑器原样捕获） */
function textOf(body: string): string {
  return JSON.stringify({ body })
}

const LOADED: LoadedContent = { snapshot: textOf('载入的'), revision: 3 }
const ACQUIRED: AcquiredEditLease = { token: TOKEN, writeEpoch: 7, revision: 3, source: null, expiresAt: '2026-11-21T03:01:30.000Z', interruption: null, formulasPending: false }
const RENEWED: RenewedEditLease = { expiresAt: '2026-11-21T03:01:40.000Z', request: null, localKeyVersion: null }
const SAVED: SaveContentResponse = { revision: 4, savedAt: '2026-11-21T03:00:00.000Z', unchanged: false }
const HANDED_OVER: HandedOverEditLease = { reservedFor: { id: '0199a2c4-1f2e-7a3b-8c4d-00000000000b', username: 'bob', displayName: '鲍勃' }, reservedUntil: '2026-11-21T03:03:00.000Z' }
const REQUEST_PENDING: EditRequestOutcome = { kind: 'pending', id: '0199a2c4-1f2e-7a3b-8c4d-0000000000f1', requestedAt: '2026-11-21T03:01:00.000Z', expiresAt: '2026-11-21T03:11:00.000Z', holder: { holder: HANDED_OVER.reservedFor, lastActiveAt: '2026-11-21T03:00:00.000Z', sameUser: false, sameSession: false } }

function status(revision: number): FetchedEditStatus {
  return { status: { revision, editor: null, canEdit: true, canTakeOver: true, formulasPending: false, request: null, reservation: null, interruption: null }, serverTime: undefined }
}

/** 编辑器的生命周期的阶段、视图状态与创建的选项：都是这个文件自己的，与表格无关 */
type Stage = 'rendered' | 'steady'
interface View {
  readonly index: number
}
type Options = Record<never, never>
/** 编辑模式视图里扩展的部分（表格的是 formulaRecovery） */
interface Extra {
  readonly marker?: string
}
/** 图片输入操作的状态：页面只看失败、而且原因是没有权限 */
type ImageState = { readonly kind: 'done' } | { readonly kind: 'failed', readonly reason: 'permission' | 'other' }
/** 装配交给页面使用方的成员：只有一个标记（核对 page.extension() 取到的就是选中的那一个） */
interface Members {
  readonly type: DocumentType
}

/** 只有会话层要的保存、槽位与打开自检，没有任何表格成员 */
type TestEditor = ModeEditor<View | undefined, Stage>
type TestInput = SlotCreateInput<View | undefined> & Options & EditorPageBindings<ImageState>

interface FakeEditor {
  readonly editor: TestEditor
  /** 工厂收到的：页面绑定的、槽位给的 */
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

function fakeFactory() {
  const created: FakeEditor[] = []
  let check: OpenCheck = { ok: true }
  const createEditor = vi.fn(async (input: TestInput): Promise<TestEditor> => {
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
        },
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
    /** 之后新建的编辑器的打开自检 */
    checkWith: (next: OpenCheck) => {
      check = next
    },
  }
}

/** 页面在 7 个入口里转给编辑模式的动作：替换成只记下调用的假件（核对挡住时没有转过去） */
const MODE_ACTIONS = ['enter', 'takeOver', 'forceTakeOver', 'requestEdit', 'handOver', 'decline', 'exit'] as const
type ModeAction = (typeof MODE_ACTIONS)[number]

interface AssemblySetup {
  /** 页面扩展的“挡住动作”与“挂屏障”：默认都不挡 */
  readonly blocksActions?: () => boolean
  readonly blocksInput?: () => boolean
  /** 页面扩展隐藏、卸载时（核对先后） */
  readonly onHide?: (host: EditorPageHost) => void
  readonly onDispose?: (host: EditorPageHost) => void
  /** 页面扩展的环境变了时（核对会话钩子里的先后） */
  readonly onEnvironment?: (host: EditorPageHost) => void
  /** 编辑模式在 7 个入口里的动作换成只记下调用的假件 */
  readonly stubActions?: boolean
}

/**
 * 假的装配（挂在 type 上，档案是 clientFormatOf(type)）：页面扩展的挂点记进 events；编辑模式是会话层的通用核心加一个只有视图的扩展，
 * 它的 view() 与通知也记进 events（核对页面算视图与通知的先后）
 */
function fakeAssembly(type: DocumentType, events: string[], setup: AssemblySetup = {}) {
  const factory = fakeFactory()
  const hosts: EditorPageHost[] = []
  const modeHosts: EditModeHost<TestEditor, Stage, Options>[] = []
  const actions = new Map<ModeAction, ReturnType<typeof vi.fn>>()
  let extra: Extra = { marker: '扩展的视图' }
  const blocksActions = vi.fn(() => setup.blocksActions?.() ?? false)
  const assembly: EditorPageAssembly<Members, Extra, ImageState> = {
    format: clientFormatOf(type),
    assemble: (host) => {
      events.push('assemble')
      hosts.push(host)
      const extension: EditorPageExtension & Members = {
        environmentChanged: () => {
          events.push('environmentChanged')
          setup.onEnvironment?.(host)
        },
        blocksActions,
        blocksInput: () => setup.blocksInput?.() ?? false,
        hide: () => {
          events.push('hide')
          setup.onHide?.(host)
        },
        dispose: () => {
          events.push('dispose')
          setup.onDispose?.(host)
        },
        type,
      }
      return {
        extension,
        createMode: ({ bindEditor, ...options }) => {
          events.push('createMode')
          const modeExtension = (given: EditModeHost<TestEditor, Stage, Options>): EditModeExtension<Options, Extra> => {
            modeHosts.push(given)
            return { onNotify: () => {}, afterCreate: () => {}, blocksActions: () => false, view: () => extra, cancel: () => {}, dispose: () => {}, enterOptions: () => ({}), savingPending: flag => flag }
          }
          const mode = createEditMode<TestEditor, View | undefined, Stage, Options, Extra>({ ...options, createEditor: bindEditor(factory.createEditor), defaultOptions: {}, extension: modeExtension })
          const observed: EditMode<Stage, Extra> = {
            ...mode,
            view: () => {
              events.push('mode-view')
              return mode.view()
            },
          }
          if (setup.stubActions !== true)
            return observed
          const stubs = Object.fromEntries(MODE_ACTIONS.map((action) => {
            const stub = vi.fn(async () => {})
            actions.set(action, stub)
            return [action, stub]
          }))
          return { ...observed, ...stubs }
        },
      }
    },
  }
  return {
    assembly,
    factory,
    hosts,
    blocksActions,
    /** 编辑模式在这个入口里的动作（stubActions 时） */
    action: (name: ModeAction) => {
      const stub = actions.get(name)
      if (stub === undefined)
        throw new Error(`编辑模式的 ${name} 没有换成假件`)
      return stub
    },
    /** 换掉编辑模式视图里扩展的部分，经核心通知（核心按引用比较，变了才通知页面） */
    setExtra: (next: Extra) => {
      extra = next
      const host = modeHosts.at(-1)
      if (host === undefined)
        throw new Error('编辑模式还没有建')
      host.notify()
    },
  }
}

/** 可以设的开关（联网）：变了时同步通知 */
function fakeSwitch(initial: boolean) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    onChange: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set: (next: boolean) => {
      value = next
      listeners.forEach(listener => listener())
    },
  }
}

/** 没有本机草稿的读取（多数用例） */
function absentReader(): RecoveryReader {
  return {
    observe: async () => ({ kind: 'observed', observation: { key: { userId: ALICE.user.id, documentId: DOCUMENT_ID }, id: 'absent' }, record: { kind: 'absent' }, writer: undefined }),
    refreshKey: async () => ({ kind: 'failed', error: { name: 'UnexpectedRefresh', message: '无草稿不需刷新密钥' } }),
    remove: async () => ({ kind: 'absent' }),
    notices: async () => ({ kind: 'notices', notices: [] }),
    clearNotice: async () => ({ kind: 'absent' }),
    dispose: () => {},
  }
}

/** 本机有一份草稿（档案是 format，基于服务端的第 3 版、没有在途的保存）：可读时可以恢复 */
async function draftReader(format: PageClientFormat) {
  const key = { userId: ALICE.user.id, documentId: DOCUMENT_ID }
  const snapshot = textOf('本机的修改')
  const meta = sampleMeta({ ...key, format, baseRevision: 3, writeEpoch: 6, draftSeq: 37, inFlight: null, updatedAt: new Date(2026, 10, 21, 15, 0).getTime(), rawBytes: new TextEncoder().encode(snapshot).byteLength })
  const gzip = await gzipBytes(new TextEncoder().encode(snapshot))
  const observed = { kind: 'observed' as const, observation: { key, id: 'draft' }, record: { kind: 'draft' as const, meta, gzip }, writer: undefined }
  const remove = vi.fn<RecoveryReader['remove']>().mockResolvedValue({ kind: 'removed', mirror: { kind: 'removed' } })
  const reader: RecoveryReader = {
    observe: async () => observed,
    refreshKey: async () => observed,
    remove,
    notices: async () => ({ kind: 'notices', notices: [] }),
    clearNotice: async () => ({ kind: 'cleared' }),
    dispose: () => {},
  }
  return { reader, remove }
}

interface Setup extends AssemblySetup {
  readonly api?: Partial<Pick<EditorPageApi, 'document' | 'content' | 'editStatus'>>
  /** 装配表里另加的类型（只给档案，不会被选中） */
  readonly others?: readonly DocumentType[]
  readonly reader?: () => RecoveryReader
  /** 地址带 ?edit=new：载入之后直接进入编辑。默认不带（打开即阅读） */
  readonly editIntent?: boolean
}

/** 这个用例建过的页面：用例结束时卸载 */
const pages: { dispose: () => void }[] = []

afterEach(() => {
  for (const page of pages.splice(0))
    page.dispose()
  setCsrfToken(undefined)
})

function setup(options: Setup = {}) {
  const events: string[] = []
  const doc = fakeAssembly('doc', events, options)
  const assemblies: Partial<Record<DocumentType, EditorPageAssembly<Members, Extra, ImageState>>> = { doc: doc.assembly }
  for (const other of options.others ?? []) {
    assemblies[other] = {
      format: clientFormatOf(other),
      assemble: () => {
        throw new Error(`不该选中 ${other} 的装配`)
      },
    }
  }
  const surface = document.createElement('div')
  const chrome = document.createElement('header')
  const time = fakeLeaseClock()
  const online = fakeSwitch(true)
  const editLease = {
    acquire: vi.fn(async (): Promise<AcquiredEditLease> => ACQUIRED),
    renew: vi.fn(async (): Promise<RenewedEditLease> => RENEWED),
    release: vi.fn(async (): Promise<void> => {}),
    handOver: vi.fn(async (): Promise<HandedOverEditLease> => HANDED_OVER),
    decline: vi.fn(async (): Promise<void> => {}),
  }
  const editRequest = {
    send: vi.fn(async (): Promise<EditRequestOutcome> => REQUEST_PENDING),
    renew: vi.fn(async (): Promise<EditRequestOutcome> => REQUEST_PENDING),
    cancel: vi.fn(async (): Promise<void> => {}),
  }
  const overrides = options.api ?? {}
  const api = {
    session: vi.fn(async (): Promise<SessionResponse> => ALICE),
    document: vi.fn(overrides.document ?? (async (): Promise<DocumentDetail> => DETAIL)),
    content: vi.fn(overrides.content ?? (async (): Promise<LoadedContent> => LOADED)),
    contentIfChanged: vi.fn(async (): Promise<LoadedContent> => LOADED),
    editStatus: vi.fn(overrides.editStatus ?? (async (): Promise<FetchedEditStatus> => status(3))),
    save: vi.fn<EditorPageApi['save']>(async () => SAVED),
    conflictCopy: vi.fn(async (): Promise<CreatedDocument> => ({ ...DETAIL, id: '0199a2c4-1f2e-7a3b-8c4d-0000000000c1', revision: 1, replayed: false })),
    reportOpenCheck: vi.fn(async (): Promise<void> => {}),
    // 编辑权与请求编辑按档案取：记下页面给的档案
    editLease: vi.fn((_format: PageClientFormat) => editLease),
    editRequest: vi.fn((_format: PageClientFormat) => editRequest),
  } satisfies EditorPageApi
  const tuning: AutosaveTuning = { limits: () => DEFAULT_AUTOSAVE_LIMITS, held: () => true, onChange: () => () => {} }
  const browser = fakeBrowser()
  const page: EditorPage<Members, Extra, ImageState> = createEditorPage({
    localDrafts: { supported: () => false },
    recoveryReader: options.reader ?? absentReader,
    documentId: DOCUMENT_ID,
    surface,
    chrome,
    api,
    assemblies,
    page: { assign: vi.fn(), replace: vi.fn(), reload: vi.fn() },
    sessionChannel: { announce: () => {}, subscribe: () => () => {}, close: () => {} },
    clock: time.clock,
    visibility: { hidden: () => false, onChange: () => () => {} },
    network: { online: online.get, onChange: online.onChange },
    activity: { subscribe: () => () => {} },
    sameBrowser: documentId => sameBrowserFor(documentId, browser.tab('page')),
    pendingSave: () => ({ write: vi.fn(), read: vi.fn(() => undefined), clear: vi.fn() }),
    issuedRequest: () => memoryIssuedRequest(DOCUMENT_ID).marker,
    autosaveControl: { tuning },
    editIntent: { requested: options.editIntent ?? false, clear: vi.fn() },
    currentPath: () => `/documents/${DOCUMENT_ID}`,
    newId: () => crypto.randomUUID(),
    now: () => new Date(2026, 10, 21, 15, 30),
    reportError: vi.fn(),
  })
  pages.push(page)
  return { page, doc, events, surface, chrome, api, editLease, editRequest, online, time }
}

describe('通用页面自己走通（S8 spec §2.10）', () => {
  it('载入、阅读、进入与退出编辑、卸载：编辑器只有会话层要的能力，页面绑定容器、页面界面、图片的读取许可与三个回调', async () => {
    const h = setup()
    expect(h.page.extension()).toBeUndefined()
    await h.page.load()
    expect(h.page.view().load).toMatchObject({ kind: 'ready', documentId: DOCUMENT_ID, title: '周记', userId: ALICE.user.id })
    expect(h.page.view().mode).toMatchObject({ kind: 'reading', canEdit: true })
    expect(h.page.view().surface).toBe('ready')
    expect(h.surface.dataset.editorState).toBe('ready')
    expect(h.page.extension()).toMatchObject({ type: 'doc' })
    // 工厂收到的：槽位给的（快照、访问方式、视图状态）加上页面的绑定（容器、页面界面、图片的读取许可与三个回调），没有别的
    const reading = h.doc.factory.last().input
    expect(Object.keys(reading).sort()).toEqual(['access', 'container', 'imageAccess', 'onImageFailure', 'onImageOperation', 'onImageOperationFailure', 'pageUi', 'snapshot', 'viewState'])
    expect(reading).toMatchObject({ access: 'read', snapshot: LOADED.snapshot, viewState: undefined, container: h.surface, pageUi: h.chrome })
    expect(reading.imageAccess).toMatchObject({ owner: ALICE.user.id })
    expect([reading.onImageFailure, reading.onImageOperation, reading.onImageOperationFailure].map(callback => typeof callback)).toEqual(['function', 'function', 'function'])

    await h.page.enterEditing()
    expect(h.editLease.acquire).toHaveBeenCalledOnce()
    expect(h.page.view().mode?.kind).toBe('editing')
    expect(h.doc.factory.last().input).toMatchObject({ access: 'edit', container: h.surface, pageUi: h.chrome })
    h.doc.factory.last().edit('改过的')
    await settle()
    await h.page.exitEditing()
    expect(h.api.save).toHaveBeenCalledOnce()
    expect(h.editLease.release).toHaveBeenCalledOnce()
    expect(h.page.view().mode?.kind).toBe('reading')
    expect(h.doc.factory.created).toHaveLength(3)

    h.page.dispose()
    expect(h.doc.factory.last().disposed).toBe(true)
    expect(h.events.filter(event => event === 'dispose')).toHaveLength(1)
  })

  it('视图照抄编辑模式视图里扩展的部分：编辑模式建好之前没有这一项，之后随它变', async () => {
    const h = setup()
    expect(h.page.view()).not.toHaveProperty('marker')
    await h.page.load()
    expect(h.page.view().marker).toBe('扩展的视图')
    const listener = vi.fn()
    h.page.subscribe(listener)
    h.doc.setExtra({ marker: '换过的' })
    expect(h.page.view().marker).toBe('换过的')
    expect(listener).toHaveBeenCalled()
  })
})

describe('载入之后按类型选装配（S8 spec §2.3）', () => {
  it.each<[string, Partial<DocumentDetail>]>([
    ['这一类没有装配', { type: 'sheet', profile: 'sheet@1' }],
    ['响应里没见过的类型', { type: 'unknown' }],
    ['档案不是装配的档案', { profile: 'doc@2' }],
    ['档案是别的类型的', { profile: 'sheet@1' }],
    ['格式版本不在平台的列表里', { formatVersion: 2 }],
  ])('%s：格式不受支持，不建扩展、编辑器与恢复', async (_case, change) => {
    const observe = vi.fn(absentReader().observe)
    const h = setup({ others: [], reader: () => ({ ...absentReader(), observe }), api: { document: async () => ({ ...DETAIL, ...change }) } })
    await h.page.load()
    expect(h.page.view().load).toEqual({ kind: 'unsupported' })
    expect(h.page.view().surface).toBe('failed')
    expect(h.events).toEqual([])
    expect(h.page.extension()).toBeUndefined()
    expect(h.doc.factory.createEditor).not.toHaveBeenCalled()
    expect(h.api.editLease).not.toHaveBeenCalled()
    expect(observe).not.toHaveBeenCalled()
  })

  it('三条都成立才选中：类型有装配、档案等于装配的档案、格式版本在列表里；装配表里别的类型不建', async () => {
    const h = setup({ others: ['sheet'] })
    await h.page.load()
    expect(h.page.view().load.kind).toBe('ready')
    expect(h.events[0]).toBe('assemble')
    expect(h.events.filter(event => event === 'assemble')).toHaveLength(1)
    expect(h.events.filter(event => event === 'createMode')).toHaveLength(1)
    expect(h.page.extension()).toMatchObject({ type: 'doc' })
  })
})

describe('装配的档案注入（S8 spec §2.6、§2.7）', () => {
  it('编辑权与请求编辑的请求在建编辑模式时按装配的档案各取一次；编辑模式用的就是取到的那一组', async () => {
    const h = setup({ api: { editStatus: async () => ({ ...status(3), status: { ...status(3).status, editor: REQUEST_PENDING.holder } }) } })
    await h.page.load()
    expect(h.api.editLease).toHaveBeenCalledExactlyOnceWith(DOC_FORMAT)
    expect(h.api.editRequest).toHaveBeenCalledExactlyOnceWith(DOC_FORMAT)
    await vi.waitFor(() => expect(h.page.view().mode).toMatchObject({ kind: 'reading', holder: { holder: { username: 'bob' } } }))
    await h.page.requestEditing()
    expect(h.editRequest.send).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID)
  })

  it('草稿：保存请求带装配的档案', async () => {
    const h = setup({ editIntent: true })
    await h.page.load()
    expect(h.page.view().mode?.kind).toBe('editing')
    h.doc.factory.last().edit('改过的')
    await settle()
    await h.page.save()
    expect(h.api.save).toHaveBeenCalledOnce()
    expect(h.api.save.mock.calls[0]?.[1]).toMatchObject({ format: DOC_FORMAT })
  })

  it('打开自检的上报带装配的档案', async () => {
    const h = setup()
    const failures = [{ kind: 'resource-missing', resource: 'DOC_NOTE_PLUGIN' }] as const
    h.doc.factory.checkWith({ ok: false, failures })
    await h.page.load()
    expect(h.api.reportOpenCheck).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, { revision: 3, access: 'read', trigger: 'open', failures, ...DOC_FORMAT })
  })

  it.each([
    ['选中的装配的档案', 'restore', DOC_FORMAT],
    ['装配表里别的类型的档案', 'preserve', SHEET_FORMAT],
  ] as const)('载入之后的可读判定只用选中的装配的档案：%s的草稿 → %s', async (_case, decision, format) => {
    const r = await draftReader(format)
    const h = setup({ others: ['sheet'], reader: () => r.reader })
    await h.page.load()
    await vi.waitFor(() => expect(h.page.view().recovery?.decision?.kind).toBe(decision))
    if (decision === 'preserve')
      expect(h.page.view().recovery?.decision).toEqual({ kind: 'preserve', reason: 'newer-format' })
    expect(r.remove).not.toHaveBeenCalled()
  })

  it.each([
    ['装配表里有这一类', 'restore', ['sheet']],
    ['装配表里没有这一类', 'preserve', []],
  ] as const)('404 之后：第一次判定与档案无关（读不到就删），清理失败之后重试问编辑状态，可读判定用装配表里全部的档案（%s → %s）', async (_case, decision, others) => {
    const r = await draftReader(SHEET_FORMAT)
    r.remove.mockResolvedValueOnce({ kind: 'quota' })
    const h = setup({ others, reader: () => r.reader, api: { document: async () => {
      throw new ApiError(404, 'NOT_FOUND', '暂时读不到')
    } } })
    await h.page.load()
    expect(h.page.view().load.kind).toBe('not-found')
    expect(r.remove).toHaveBeenCalledOnce()
    expect(h.events).toEqual([])
    await h.page.retryRecovery()
    expect(h.api.editStatus).toHaveBeenCalledOnce()
    expect(h.page.view().recovery?.decision?.kind).toBe(decision)
    expect(r.remove).toHaveBeenCalledOnce()
  })
})

describe('页面扩展的挂点（S8 spec §2.4、§2.9）', () => {
  it('environmentChanged 在 update 里、算视图之前，页面的监听者之后才收到通知', async () => {
    const h = setup()
    await h.page.load()
    h.page.subscribe(() => h.events.push('listener'))
    h.events.length = 0
    const refreshing = h.page.refreshDetail()
    expect(h.events).toEqual(['environmentChanged', 'mode-view', 'listener'])
    await refreshing
  })

  it('会话钩子（以保存得到令牌失效为例）：身份代次先加一、再调 environmentChanged，之后才记下令牌失效', async () => {
    const seen: { gate: boolean | undefined, writeReady: boolean }[] = []
    let gate: (() => boolean) | undefined
    const h = setup({ editIntent: true, onEnvironment: (host) => {
      if (gate !== undefined)
        seen.push({ gate: gate(), writeReady: host.writeReady() })
    } })
    await h.page.load()
    gate = h.doc.hosts[0]?.actionGate()
    expect(gate?.()).toBe(true)
    h.api.save.mockRejectedValueOnce(new ApiError(403, 'CSRF_TOKEN_INVALID', '令牌失效'))
    h.doc.factory.last().edit('改过的')
    await settle()
    await h.page.save()
    await settle()
    const stale = seen.findIndex(entry => entry.gate === false)
    expect(seen[stale]).toEqual({ gate: false, writeReady: true })
    expect(seen.slice(0, stale).every(entry => entry.gate === true)).toBe(true)
  })

  it.each(['enterEditing', 'takeOverHere', 'forceTakeOver', 'requestEditing', 'handOver', 'keepEditing', 'exitEditing'] as const)('%s：第一句先问扩展挡不挡（在页面自己的判断之前）；挡住时不转给编辑模式', async (entry) => {
    const editing = entry === 'handOver' || entry === 'keepEditing' || entry === 'exitEditing'
    const target: ModeAction = ({ enterEditing: 'enter', takeOverHere: 'takeOver', forceTakeOver: 'forceTakeOver', requestEditing: 'requestEdit', handOver: 'handOver', keepEditing: 'decline', exitEditing: 'exit' } as const)[entry]
    let blocks = false
    const h = setup({ editIntent: editing, stubActions: true, blocksActions: () => blocks })
    await h.page.load()
    expect(h.page.view().mode?.kind).toBe(editing ? 'editing' : 'reading')
    // 断网时页面自己的判断会先返回：挡不挡照样先问
    h.online.set(false)
    const asked = h.doc.blocksActions.mock.calls.length
    await h.page[entry]()
    expect(h.doc.blocksActions.mock.calls.length).toBe(asked + 1)
    expect(h.doc.action(target)).not.toHaveBeenCalled()
    h.online.set(true)
    blocks = true
    await h.page[entry]()
    expect(h.doc.action(target)).not.toHaveBeenCalled()
    blocks = false
    await h.page[entry]()
    expect(h.doc.action(target)).toHaveBeenCalledOnce()
  })

  it('blocksInput 为真时挂上交互屏障（容器 loading），为假时撤掉；与切换中、正在新建同在一处判断', async () => {
    let blocks = false
    const h = setup({ blocksInput: () => blocks })
    document.body.append(h.chrome, h.surface)
    try {
      await h.page.load()
      expect(h.page.view().surface).toBe('ready')
      blocks = true
      h.doc.setExtra({ marker: '挡住输入' })
      expect(h.page.view().surface).toBe('loading')
      expect(h.surface.dataset.editorState).toBe('loading')
      const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
      h.surface.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
      blocks = false
      h.doc.setExtra({ marker: '放开' })
      expect(h.page.view().surface).toBe('ready')
    }
    finally {
      document.body.replaceChildren()
    }
  })

  it('pagehide：先记下已隐藏，再调扩展的 hide（第一件），之后才暂停图片、恢复与交出编辑权', async () => {
    const seen: { gate?: boolean | undefined, images?: boolean, released?: number } = {}
    let images: (() => boolean) | undefined
    let released: (() => number) | undefined
    const h = setup({ editIntent: true, onHide: (host) => {
      seen.gate = host.actionGate()?.()
      seen.images = images?.()
      seen.released = released?.()
    } })
    await h.page.load()
    expect(h.page.view().mode?.kind).toBe('editing')
    const access = h.doc.factory.last().input.imageAccess
    images = () => access?.current() !== undefined
    released = () => h.editLease.release.mock.calls.length
    expect(h.doc.hosts[0]?.actionGate()?.()).toBe(true)
    window.dispatchEvent(new Event('pagehide'))
    expect(h.events.filter(event => event === 'hide')).toEqual(['hide'])
    expect(seen).toEqual({ gate: false, images: true, released: 0 })
    expect(access?.current()).toBeUndefined()
    expect(h.editLease.release).toHaveBeenCalledOnce()
  })

  it('卸载：先记下已卸载，再调扩展的 dispose（第一件），之后才销毁图片、恢复与编辑模式', async () => {
    const seen: { active?: boolean, images?: boolean, editor?: boolean } = {}
    let probe: (() => void) | undefined
    const h = setup({ onDispose: (host) => {
      seen.active = host.sessionActive()
      probe?.()
    } })
    await h.page.load()
    const fake = h.doc.factory.last()
    const access = fake.input.imageAccess
    probe = () => {
      seen.images = access?.current() !== undefined
      seen.editor = fake.disposed
    }
    expect(h.doc.hosts[0]?.sessionActive()).toBe(true)
    h.page.dispose()
    expect(seen).toEqual({ active: false, images: true, editor: false })
    expect(access?.current()).toBeUndefined()
    expect(fake.disposed).toBe(true)
  })

  it('载入期间页面已经隐藏：选中装配、建好扩展之后立即 hide', async () => {
    let resolve: (detail: DocumentDetail) => void = () => {}
    const h = setup({ api: { document: async () => new Promise<DocumentDetail>((done) => {
      resolve = done
    }) } })
    const loading = h.page.load()
    await vi.waitFor(() => expect(h.api.document).toHaveBeenCalledOnce())
    window.dispatchEvent(new Event('pagehide'))
    expect(h.events).toEqual([])
    resolve(DETAIL)
    await loading
    expect(h.events.slice(0, 2)).toEqual(['assemble', 'hide'])
  })
})
