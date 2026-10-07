import type { AcquiredEditLease, CreatedDocument, DocumentDetail, RenewedEditLease, SaveContentResponse, SessionResponse } from '@nerve-office/contracts'
import type { EditorAccess, OpenCheck, SheetEditor, SheetEditorLifecycle, SheetViewState } from '../../editor/index.ts'
import type { PageLocation } from '../../shared/lib/page-location.ts'
import type { SessionChannel } from '../../shared/lib/session-channel.ts'
import type { Autosave, AutosaveTuning } from './autosave.ts'
import type { EditLeaseApi } from './edit-lease.ts'
import type { EditModeState } from './edit-mode.ts'
import type { FetchedEditStatus, LoadedContent } from './editor-api.ts'
import type { EditorPage, EditorPageApi } from './editor-page.ts'
import type { MarkerStorage } from './pending-save-marker.ts'
import type { SameBrowser } from './same-browser.ts'
import type { SaveRequest } from './save-coordinator.ts'
import { EDIT_IDLE_RELEASE_SECONDS, EDIT_LEASE_IDLE_RECLAIM_SECONDS } from '@nerve-office/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, NetworkError, setCsrfToken } from '../../shared/api/index.ts'
import { DEFAULT_AUTOSAVE_LIMITS } from './autosave.ts'
import { CONTENT_UNCHANGED } from './editor-api.ts'
import { createEditorPage } from './editor-page.ts'
import { fakeLeaseClock, settle } from './fake-lease-clock.test-support.ts'
import { keyOf, pendingSaveMarker } from './pending-save-marker.ts'
import { fakeBrowser } from './same-browser.test-support.ts'
import { lockNameOf, sameBrowserFor } from './same-browser.ts'

const DOCUMENT_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'

const ALICE: SessionResponse = {
  user: { id: '0199a2c4-1f2e-7a3b-8c4d-00000000000a', username: 'alice', displayName: '爱丽丝', systemRole: 'member' },
  personalSpace: { id: '0199a2c4-2a3b-7c4d-9e5f-00000000000a', name: '爱丽丝' },
  csrfToken: 'csrf-alice',
}
const BOB: SessionResponse = { ...ALICE, user: { ...ALICE.user, id: '0199a2c4-1f2e-7a3b-8c4d-00000000000b', username: 'bob' }, csrfToken: 'csrf-bob' }

/** 申请到的编辑租约：修订号与载入的内容相同（3） */
const TOKEN = 'L'.repeat(43)
const ACQUIRED: AcquiredEditLease = { token: TOKEN, writeEpoch: 7, revision: 3, source: null, expiresAt: '2026-09-27T03:01:30.000Z', interruption: null, formulasPending: false }
const RENEWED: RenewedEditLease = { expiresAt: '2026-09-27T03:01:40.000Z', request: null }
/** 保存带上的编辑租约 */
const CREDENTIALS = { token: TOKEN, writeEpoch: 7 }
/** 续上时申请到的下一代（修订号没变：期间没人保存过） */
const NEXT_TOKEN = 'M'.repeat(43)
const NEXT_LEASE: AcquiredEditLease = { ...ACQUIRED, token: NEXT_TOKEN, writeEpoch: 8 }
const NEXT_CREDENTIALS = { token: NEXT_TOKEN, writeEpoch: 8 }

/** 另存为副本得到的新文档 */
const COPY_ID = '0199a2c4-1f2e-7a3b-8c4d-0000000000c1'

/** 打开自检失败（M3-P4）：编辑器没有完整载入（批注的插件没有注册） */
const NOTE_MISSING = { ok: false, failures: [{ kind: 'profile-missing-hook', resource: 'SHEET_NOTE_PLUGIN' }] } as const satisfies OpenCheck

const DETAIL: DocumentDetail = {
  id: DOCUMENT_ID,
  title: '周报',
  type: 'sheet',
  createdAt: '2026-09-27T01:00:00.000Z',
  updatedAt: '2026-09-27T02:00:00.000Z',
  spaceId: ALICE.personalSpace.id,
  space: { id: ALICE.personalSpace.id, type: 'personal' },
  folderId: null,
  accessVia: 'space',
  revision: 3,
  profile: 'sheet@1',
  formatVersion: 1,
  sdkVersion: '1.0.1',
  formulasPending: false,
  permissions: { canEdit: true, canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: false, canCopy: true, canDelete: true, canShare: false, canTakeOver: false },
}

/** 假的编辑器：生命周期可以推进，保存用到的能力都是最简单的实现；记下谁在订阅修改（每次新建都是新的一个，第一个由用例先拿到） */
function fakeEditor(stage: SheetEditorLifecycle = 'rendered') {
  let current = stage
  const lifecycleListeners = new Set<(stage: SheetEditorLifecycle) => void>()
  const changeListeners = new Set<() => void>()
  const editor: SheetEditor = {
    unitId: 'unit-1',
    changeSeq: () => 0,
    onChange: (listener) => {
      changeListeners.add(listener)
      return () => changeListeners.delete(listener)
    },
    lifecycle: () => current,
    onLifecycle: (listener) => {
      lifecycleListeners.add(listener)
      return () => lifecycleListeners.delete(listener)
    },
    isCellEditing: () => false,
    hasPendingCellInput: () => false,
    onCellEditingChange: () => () => {},
    commitCellEditing: async () => true,
    settleFormulas: async () => 'settled',
    formulasSettled: () => true,
    onFormulaProgress: () => () => {},
    composing: () => false,
    onCompositionChange: () => () => {},
    settlePanels: async () => {},
    capture: () => '{"id":"unit-1"}',
    viewState: () => undefined,
    openCheck: { ok: true },
    dispose: vi.fn(async () => {}),
  }
  return {
    editor,
    changeListeners,
    enter(next: SheetEditorLifecycle): void {
      current = next
      lifecycleListeners.forEach(listener => listener(next))
    },
  }
}

/** 标签页之间的会话消息：测试调用 announce 模拟别的标签页 */
function fakeChannel() {
  const listeners = new Set<() => void>()
  const channel: SessionChannel = {
    announce: () => {},
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close: () => {},
  }
  return { channel, fromOtherTab: () => listeners.forEach(listener => listener()), listeners }
}

/**
 * 本页的键盘、鼠标操作（组装处给出 trackActivity：只认可信事件，测试里派发的 DOM 事件一律不可信）：fire 模拟一次操作；
 * subscribedAt 记下订阅那一刻容器的状态（订阅要在交互屏障之前，那时容器还没有状态）
 */
function fakeActivity(surface: HTMLElement) {
  const listeners = new Set<() => void>()
  const record: { subscribedAt: string | undefined | null } = { subscribedAt: null }
  return {
    activity: {
      subscribe: (listener: () => void) => {
        record.subscribedAt = surface.dataset.editorState
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    fire: () => listeners.forEach(listener => listener()),
    listeners,
    record,
  }
}

/** 内存里的 localStorage（记号用） */
function memoryStorage(): MarkerStorage & { readonly items: Map<string, string> } {
  const items = new Map<string, string>()
  return {
    items,
    getItem: key => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value)
    },
    removeItem: (key) => {
      items.delete(key)
    },
  }
}

/** 可以设的开关（页面的可见性、联网）：变了时同步通知 */
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

/** 测试构建的自动保存控制的样子：默认暂停定时的上传（与 E2E 的夹具一样）；记下交来的调度 */
function fakeAutosaveControl() {
  let held = true
  const listeners = new Set<() => void>()
  const tuning: AutosaveTuning = {
    limits: () => DEFAULT_AUTOSAVE_LIMITS,
    held: () => held,
    onChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const attached: (Autosave | undefined)[] = []
  return {
    hooks: { tuning, attach: (autosave: Autosave | undefined) => attached.push(autosave) },
    current: (): Autosave | undefined => attached.at(-1),
    release: () => {
      held = false
      listeners.forEach(listener => listener())
    },
  }
}

/** 编辑器页交给适配层的创建参数 */
interface CreateOptions {
  readonly container: HTMLElement
  readonly snapshot: string
  readonly access: EditorAccess
  readonly viewState?: SheetViewState | undefined
  readonly recalculate?: boolean
  readonly pageUi: Node
}

interface Setup {
  readonly documentId?: string | undefined
  /** 本页这次加载的标识与 requestId 的生成：默认 id-1、id-2……；冲突的详情要按契约解析时换成 UUID 的写法 */
  readonly newId?: () => string
  readonly api?: Partial<Omit<EditorPageApi, 'editLease'>>
  readonly editLease?: Partial<EditLeaseApi>
  readonly createEditor?: (options: CreateOptions) => Promise<SheetEditor>
  /**
   * 地址带 ?edit=new。默认带：载入之后能编辑就直接申请、以可编辑创建——与 P1 的"能编辑就打开即申请"是同一条路，
   * 会话、保存与编辑权的用例都在编辑时进行；打开即阅读的用例传 false
   */
  readonly editIntent?: boolean
}

/** 这个用例建过的页面：用例结束时卸载，留下的交互屏障与窗口上的监听不影响下一个用例 */
const pages: { dispose: () => void }[] = []

function setup(options: Setup = {}) {
  const surface = document.createElement('div')
  const chrome = document.createElement('header')
  const fake = fakeEditor()
  /** 新建过的编辑器：第一个是 fake，之后（重建）每次新建一个 */
  const fakes: ReturnType<typeof fakeEditor>[] = []
  const page: PageLocation & { visits: string[] } = { visits: [], assign: vi.fn(), replace: url => page.visits.push(url), reload: vi.fn() }
  const { channel, fromOtherTab, listeners } = fakeChannel()
  const time = fakeLeaseClock()
  const editLease = {
    acquire: vi.fn(options.editLease?.acquire ?? (async (): Promise<AcquiredEditLease> => ACQUIRED)),
    renew: vi.fn(options.editLease?.renew ?? (async (): Promise<RenewedEditLease> => RENEWED)),
    release: vi.fn(options.editLease?.release ?? (async (): Promise<void> => {})),
  }
  const overrides = options.api ?? {}
  const api = {
    session: vi.fn(overrides.session ?? (async () => ALICE)),
    document: vi.fn(overrides.document ?? (async () => DETAIL)),
    content: vi.fn(overrides.content ?? (async (): Promise<LoadedContent> => ({ snapshot: '{"id":"unit-1"}', revision: 3 }))),
    contentIfChanged: vi.fn(overrides.contentIfChanged ?? (async (): Promise<LoadedContent | typeof CONTENT_UNCHANGED> => CONTENT_UNCHANGED)),
    editStatus: vi.fn(overrides.editStatus ?? (async (): Promise<FetchedEditStatus> => ({ status: { revision: 3, editor: null, canEdit: true, canTakeOver: false, formulasPending: false, request: null, reservation: null, interruption: null }, serverTime: undefined }))),
    compress: vi.fn(overrides.compress ?? (async (snapshot: string) => new TextEncoder().encode(snapshot))),
    save: vi.fn(overrides.save ?? (async (): Promise<SaveContentResponse> => ({ revision: 4, savedAt: '2026-09-27T03:00:00.000Z', unchanged: false }))),
    conflictCopy: vi.fn(overrides.conflictCopy ?? (async (): Promise<CreatedDocument> => ({ ...DETAIL, id: COPY_ID, title: '周报（冲突副本 2026-10-04 15:30）', revision: 1, replayed: false }))),
    reportOpenCheck: vi.fn(overrides.reportOpenCheck ?? (async (): Promise<void> => {})),
    editLease,
  } satisfies EditorPageApi
  const createEditor = vi.fn(options.createEditor ?? (async () => {
    const next = fakes.length === 0 ? fake : fakeEditor()
    fakes.push(next)
    return next.editor
  }))
  const editIntent = { requested: options.editIntent ?? true, clear: vi.fn() }
  const hidden = fakeSwitch(false)
  const online = fakeSwitch(true)
  const autosave = fakeAutosaveControl()
  const activity = fakeActivity(surface)
  const browser = fakeBrowser()
  const storage = memoryStorage()
  /** 编辑器页按文档建的锁与频道（M3-P5）：卸载时关掉 */
  const sameBrowsers: SameBrowser[] = []
  let id = 0
  const editorPage = createEditorPage({
    documentId: 'documentId' in options ? options.documentId : DOCUMENT_ID,
    surface,
    chrome,
    api,
    createEditor,
    page,
    sessionChannel: channel,
    clock: time.clock,
    visibility: { hidden: hidden.get, onChange: hidden.onChange },
    network: { online: online.get, onChange: online.onChange },
    activity: activity.activity,
    sameBrowser: (documentId) => {
      const opened = sameBrowserFor(documentId, browser.tab('page'))
      const close = vi.fn(opened.close)
      const tracked = { ...opened, close }
      sameBrowsers.push(tracked)
      return tracked
    },
    pendingSave: documentId => pendingSaveMarker(documentId, { storage: () => storage, now: () => Date.UTC(2026, 9, 7, 3, 0, 0) }),
    digest: async snapshot => `sha:${snapshot}`,
    autosaveControl: autosave.hooks,
    editIntent,
    currentPath: () => `/documents/${DOCUMENT_ID}`,
    newId: options.newId ?? (() => `id-${++id}`),
    now: () => new Date(2026, 9, 4, 15, 30),
    reportError: vi.fn(),
  })
  pages.push(editorPage)
  return { editorPage, surface, chrome, fake, fakes, page, api, editLease, time, createEditor, fromOtherTab, listeners, editIntent, hidden, online, autosave, activity, browser, storage, sameBrowsers }
}

/** 查看者读到的编辑状态：不能编辑 */
async function VIEWER_STATUS(): Promise<FetchedEditStatus> {
  return { status: { revision: 3, editor: null, canEdit: false, canTakeOver: false, formulasPending: false, request: null, reservation: null, interruption: null }, serverTime: undefined }
}

/** 阅读与编辑的状态 */
function modeOf(editorPage: EditorPage): EditModeState | undefined {
  return editorPage.view().mode
}

afterEach(() => {
  for (const page of pages.splice(0))
    page.dispose()
  setCsrfToken(undefined)
})

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

const UNAUTHENTICATED = new ApiError(401, 'UNAUTHENTICATED', '请先登录')

describe('就绪之前页头之外的交互一律拦下（Codex 评审 CX1，独立复验 N1）', () => {
  /** 在 parent 里的一个元素上派发一次用户输入：返回事件是否被拦下（默认行为取消、元素上的监听收不到） */
  function interact(parent: HTMLElement, type: string): { prevented: boolean, reached: boolean } {
    const inner = document.createElement('div')
    parent.append(inner)
    let reached = false
    inner.addEventListener(type, () => {
      reached = true
    })
    const event = new Event(type, { bubbles: true, cancelable: true })
    inner.dispatchEvent(event)
    inner.remove()
    return { prevented: event.defaultPrevented, reached }
  }

  const BLOCKED = { prevented: true, reached: false }
  const OPEN = { prevented: false, reached: true }

  /** 页头、容器与 Univer 挂在 body 下的浮层都放进文档：事件才会经过窗口 */
  function attach(...elements: HTMLElement[]): HTMLElement {
    const overlay = document.createElement('div')
    document.body.append(...elements, overlay)
    return overlay
  }

  afterEach(() => {
    document.body.replaceChildren()
  })

  it('载入期间，容器与 body 下的浮层里的点击、悬停、键入、输入法、粘贴与拖放都拦下，页头照常', async () => {
    const creating = deferred<SheetEditor>()
    const { editorPage, surface, chrome, fake, createEditor } = setup({ createEditor: async () => creating.promise })
    const overlay = attach(chrome, surface)
    const loading = editorPage.load()
    // 编辑器已经在创建（表格画出来之后可以被点到、浮层可以弹出的那段时间）
    await vi.waitFor(() => expect(createEditor).toHaveBeenCalled())
    for (const type of ['mousedown', 'mousemove', 'dblclick', 'contextmenu', 'keydown', 'beforeinput', 'compositionstart', 'paste', 'drop']) {
      expect(interact(surface, type), type).toEqual(BLOCKED)
      expect(interact(overlay, type), type).toEqual(BLOCKED)
    }
    expect(interact(chrome, 'click')).toEqual(OPEN)
    creating.resolve(fake.editor)
    await loading
    expect(interact(surface, 'keydown')).toEqual(OPEN)
    expect(interact(overlay, 'mousedown')).toEqual(OPEN)
  })

  it('撤掉屏障之前保存状态机已经在订阅修改：放开之后的每一处修改都有人接着', async () => {
    const { editorPage, surface, chrome, fake } = setup()
    attach(chrome, surface)
    // 页面在撤掉屏障（进入 ready）之前读一次编辑器的阶段：这时屏障仍在、保存状态机应当已经建好
    let listeningBeforeRelease: boolean | undefined
    let blockedBeforeRelease: boolean | undefined
    const lifecycle = fake.editor.lifecycle
    Object.assign(fake.editor, {
      lifecycle: () => {
        listeningBeforeRelease = fake.changeListeners.size > 0
        blockedBeforeRelease = interact(surface, 'keydown').prevented
        return lifecycle()
      },
    })
    await editorPage.load()
    expect(listeningBeforeRelease).toBe(true)
    expect(blockedBeforeRelease).toBe(true)
    expect(interact(surface, 'keydown')).toEqual(OPEN)
  })

  it('编辑器加载失败、页面卸载：都撤掉屏障', async () => {
    const failed = setup({ createEditor: async () => Promise.reject(new Error('就绪超时')) })
    attach(failed.chrome, failed.surface)
    await failed.editorPage.load()
    expect(failed.surface.hidden).toBe(true)
    expect(interact(failed.surface, 'keydown')).toEqual(OPEN)

    const creating = deferred<SheetEditor>()
    const unloaded = setup({ createEditor: async () => creating.promise })
    attach(unloaded.chrome, unloaded.surface)
    const loading = unloaded.editorPage.load()
    await vi.waitFor(() => expect(unloaded.createEditor).toHaveBeenCalled())
    expect(interact(unloaded.surface, 'keydown')).toEqual(BLOCKED)
    unloaded.editorPage.dispose()
    expect(interact(unloaded.surface, 'keydown')).toEqual(OPEN)
    creating.resolve(unloaded.fake.editor)
    await loading
  })

  it('只能查看的文档同样：载入期间拦下输入，就绪之后放开（M2-P3 设计 §3.5）', async () => {
    const creating = deferred<SheetEditor>()
    const { editorPage, surface, chrome, fake, createEditor } = setup({
      api: { document: async () => ({ ...DETAIL, permissions: { ...DETAIL.permissions, canEdit: false } }) },
      createEditor: async () => creating.promise,
    })
    attach(chrome, surface)
    const loading = editorPage.load()
    await vi.waitFor(() => expect(createEditor).toHaveBeenCalled())
    expect(interact(surface, 'keydown')).toEqual(BLOCKED)
    creating.resolve(fake.editor)
    await loading
    expect(interact(surface, 'keydown')).toEqual(OPEN)
  })
})

describe('编辑器页的载入（P4 设计 §3.7.1）', () => {
  it('打开即阅读（M3-P2 设计 §3.4）：先确认会话，再读取元数据与内容，以只读创建编辑器；能编辑时进入阅读、有"编辑"，不申请编辑权', async () => {
    const { editorPage, surface, api, createEditor, fake, editLease, editIntent, chrome } = setup({ editIntent: false })
    expect(surface.dataset.editorState).toBeUndefined()
    const loading = editorPage.load()
    expect(surface.dataset.editorState).toBe('loading')
    await loading
    expect(api.session).toHaveBeenCalledOnce()
    expect(api.document).toHaveBeenCalledWith(DOCUMENT_ID)
    expect(api.content).toHaveBeenCalledWith(DOCUMENT_ID)
    expect(createEditor).toHaveBeenCalledExactlyOnceWith({ container: surface, pageUi: chrome, snapshot: '{"id":"unit-1"}', access: 'read' })
    expect(editorPage.view()).toMatchObject({ load: { kind: 'ready', title: '周报' }, mode: { kind: 'reading', canEdit: true }, save: undefined, session: 'active' })
    expect(editLease.acquire).not.toHaveBeenCalled()
    expect(editIntent.clear).not.toHaveBeenCalled()
    expect(surface.dataset.editorState).toBe('ready')
    fake.enter('steady')
    expect(surface.dataset.editorState).toBe('steady')
  })

  it('新建的表格（?edit=new）：载入之后直接申请、以可编辑创建，进入之后去掉地址里的标记；就绪之后可以保存，基准是内容的修订号', async () => {
    const { editorPage, surface, api, createEditor, fake, editIntent, chrome } = setup()
    await editorPage.load()
    expect(createEditor).toHaveBeenCalledExactlyOnceWith({ container: surface, pageUi: chrome, snapshot: '{"id":"unit-1"}', access: 'edit' })
    expect(editorPage.view()).toMatchObject({ load: { kind: 'ready', title: '周报' }, mode: { kind: 'editing' }, save: { status: 'clean' }, session: 'active' })
    expect(editIntent.clear).toHaveBeenCalledOnce()
    expect(surface.dataset.editorState).toBe('ready')
    fake.enter('steady')
    expect(surface.dataset.editorState).toBe('steady')

    await editorPage.save()
    expect(api.save).toHaveBeenCalledWith(DOCUMENT_ID, expect.objectContaining<Partial<SaveRequest>>({ baseRevision: 3, clientInstanceId: 'id-1', requestId: 'id-2' }), expect.anything(), CREDENTIALS)
  })

  it.each([
    ['NOT_FOUND', new ApiError(404, 'NOT_FOUND', '不存在')],
    ['地址里的 id 不合法（REQUEST_INVALID）', new ApiError(400, 'REQUEST_INVALID', '参数不合法')],
  ])('%s：内容不存在或无权访问，不创建编辑器', async (_case, error) => {
    const { editorPage, surface, createEditor } = setup({ api: { content: async () => Promise.reject(error) } })
    await editorPage.load()
    expect(editorPage.view().load).toEqual({ kind: 'not-found' })
    expect(createEditor).not.toHaveBeenCalled()
    expect(surface.dataset.editorState).toBe('failed')
    expect(surface.hidden).toBe(true)
  })

  it('地址不是编辑器页的写法：直接显示内容不存在，不请求', async () => {
    const { editorPage, api } = setup({ documentId: undefined })
    await editorPage.load()
    expect(editorPage.view().load).toEqual({ kind: 'not-found' })
    expect(api.session).not.toHaveBeenCalled()
  })

  it.each([
    ['档案', { profile: 'sheet@2' }],
    ['格式版本', { formatVersion: 2 }],
  ])('%s不认识：不进入编辑，不改写', async (_case, change) => {
    const { editorPage, createEditor } = setup({ api: { document: async () => ({ ...DETAIL, ...change }) } })
    await editorPage.load()
    expect(editorPage.view().load).toEqual({ kind: 'unsupported' })
    expect(createEditor).not.toHaveBeenCalled()
  })

  it.each([
    ['比本页的 SDK 新', '9.9.9'],
    ['认不出的写法', 'nightly'],
  ])('文档记录的 SDK 版本%s（服务端回滚之后，M3-P3）：照常以只读打开，只能阅读（blocked），不直接进入编辑、不申请编辑权', async (_case, sdkVersion) => {
    const { editorPage, createEditor, api } = setup({ api: { document: async () => ({ ...DETAIL, sdkVersion }) }, editIntent: true })
    await editorPage.load()
    expect(editorPage.view().load).toMatchObject({ kind: 'ready' })
    expect(editorPage.view().mode).toMatchObject({ kind: 'reading', blocked: 'document-too-new' })
    expect(createEditor).toHaveBeenCalledOnce()
    expect(api.editLease.acquire).not.toHaveBeenCalled()
  })

  it('文档记录的 SDK 版本比本页旧（升级之后的存量）：照常打开，?edit=new 直接进入编辑', async () => {
    const { editorPage } = setup({ api: { document: async () => ({ ...DETAIL, sdkVersion: '0.9.0' }) } })
    await editorPage.load()
    expect(editorPage.view().mode).toMatchObject({ kind: 'editing' })
  })

  it.each([
    ['会话', { session: async () => Promise.reject(new ApiError(401, 'UNAUTHENTICATED', '请先登录')) }, `/login?from=%2Fdocuments%2F${DOCUMENT_ID}`],
    ['内容', { content: async () => Promise.reject(new ApiError(401, 'SESSION_EXPIRED', '已过期')) }, `/login?from=%2Fdocuments%2F${DOCUMENT_ID}&reason=expired`],
  ])('读取%s时未登录：整页转到登录页，登录之后回到这里', async (_case, api, target) => {
    const { editorPage, page } = setup({ api })
    await editorPage.load()
    expect(page.visits).toEqual([target])
    expect(editorPage.view().load).toEqual({ kind: 'loading' })
  })

  it('网络错误：载入失败，可以刷新重试', async () => {
    const error = new NetworkError('断网')
    const { editorPage } = setup({ api: { document: async () => Promise.reject(error) } })
    await editorPage.load()
    expect(editorPage.view().load).toEqual({ kind: 'failed', error })
  })

  it('编辑器加载失败：显示失败，不进入编辑', async () => {
    const error = new Error('Worker 起不来')
    const { editorPage, surface } = setup({ createEditor: async () => Promise.reject(error), editIntent: false })
    await editorPage.load()
    expect(editorPage.view()).toMatchObject({ load: { kind: 'editor-failed' }, save: undefined })
    expect(surface.dataset.editorState).toBe('failed')
  })

  it('只能查看：以只读创建编辑器（M2-P3 设计 §3.5），不建保存状态机，不能保存；?edit=new 也不申请、不去掉标记', async () => {
    const { editorPage, surface, api, createEditor, editLease, editIntent, chrome } = setup({ api: { document: async () => ({ ...DETAIL, permissions: { ...DETAIL.permissions, canEdit: false } }), editStatus: VIEWER_STATUS } })
    await editorPage.load()
    expect(createEditor).toHaveBeenCalledExactlyOnceWith({ container: surface, pageUi: chrome, snapshot: '{"id":"unit-1"}', access: 'read' })
    expect(editorPage.view()).toMatchObject({ load: { kind: 'ready' }, mode: { kind: 'reading', canEdit: false }, save: undefined })
    expect(editLease.acquire).not.toHaveBeenCalled()
    expect(editIntent.clear).not.toHaveBeenCalled()
    expect(editorPage.hasUnsavedWork()).toBe(false)
    await editorPage.save()
    expect(api.compress).not.toHaveBeenCalled()
    expect(api.save).not.toHaveBeenCalled()
  })

  it('?edit=new、新建的编辑器打开自检失败（M3-P4 设计 §3.12）：释放编辑权、以只读重建，只能阅读（damaged）；去掉地址里的标记（刷新不再"先取后放"一次）；两个编辑器各上报一次', async () => {
    const { editorPage, createEditor, editLease, editIntent, api } = setup({ createEditor: async () => ({ ...fakeEditor().editor, openCheck: NOTE_MISSING }) })
    await editorPage.load()
    expect(createEditor.mock.calls.map(call => call[0].access)).toEqual(['edit', 'read'])
    expect(editLease.release).toHaveBeenCalledOnce()
    expect(editorPage.view()).toMatchObject({ load: { kind: 'ready' }, mode: { kind: 'reading', canEdit: true, damaged: NOTE_MISSING.failures }, save: undefined })
    expect(editIntent.clear).toHaveBeenCalledOnce()
    expect(api.reportOpenCheck.mock.calls.map(call => [call[0], call[1].access, call[1].trigger])).toEqual([[DOCUMENT_ID, 'edit', 'enter'], [DOCUMENT_ID, 'read', 'enter']])
    expect(api.save).not.toHaveBeenCalled()
  })

  it('打开即阅读、打开自检失败：只能阅读（damaged），地址里没有标记时不去动它', async () => {
    const { editorPage, editIntent, editLease } = setup({ editIntent: false, createEditor: async () => ({ ...fakeEditor().editor, openCheck: NOTE_MISSING }) })
    await editorPage.load()
    expect(editorPage.view()).toMatchObject({ load: { kind: 'ready' }, mode: { kind: 'reading', damaged: NOTE_MISSING.failures } })
    expect(editLease.acquire).not.toHaveBeenCalled()
    expect(editIntent.clear).not.toHaveBeenCalled()
  })

  it('载入期间页面已经卸载：创建出的编辑器立即销毁', async () => {
    let resolve: ((editor: SheetEditor) => void) | undefined
    const fake = fakeEditor()
    const { editorPage } = setup({ editIntent: false, createEditor: async () => new Promise((settle) => {
      resolve = settle
    }) })
    const loading = editorPage.load()
    await vi.waitFor(() => expect(resolve).toBeDefined())
    editorPage.dispose()
    resolve?.(fake.editor)
    await loading
    expect(fake.editor.dispose).toHaveBeenCalledOnce()
  })
})

describe('编辑器页的会话（P4 设计 §3.7.3，审查 B1）', () => {
  it('别的标签页登录的是同一个人：换上新的令牌，照常保存', async () => {
    const { editorPage, api, fromOtherTab } = setup()
    await editorPage.load()
    vi.mocked(api.session).mockResolvedValueOnce({ ...ALICE, csrfToken: 'csrf-new' })
    fromOtherTab()
    await vi.waitFor(() => expect(api.session).toHaveBeenCalledTimes(2))
    expect(editorPage.view().session).toBe('active')
    expect(editorPage.view().save?.canSave).toBe(true)
  })

  it('别的标签页换了人：停止保存，不自动重新加载；原来的人登录回来之后恢复', async () => {
    const { editorPage, api, page, fromOtherTab } = setup()
    await editorPage.load()
    vi.mocked(api.session).mockResolvedValueOnce(BOB)
    fromOtherTab()
    await vi.waitFor(() => expect(editorPage.view().session).toBe('other-user'))
    expect(editorPage.view().save?.canSave).toBe(false)
    expect(page.visits).toEqual([])
    vi.mocked(api.session).mockResolvedValueOnce(BOB)
    await editorPage.save()
    expect(api.save).not.toHaveBeenCalled()

    vi.mocked(api.session).mockResolvedValueOnce({ ...ALICE, csrfToken: 'csrf-back' })
    fromOtherTab()
    await vi.waitFor(() => expect(editorPage.view().session).toBe('active'))
    expect(editorPage.view().save?.canSave).toBe(true)
    await editorPage.save()
    expect(api.save).toHaveBeenCalledOnce()
  })

  it('别的标签页退出了：暂停保存（修改留着）；本人在别处重新登录之后恢复', async () => {
    const { editorPage, api, page, fromOtherTab } = setup()
    await editorPage.load()
    vi.mocked(api.session).mockRejectedValueOnce(new ApiError(401, 'UNAUTHENTICATED', '请先登录'))
    fromOtherTab()
    await vi.waitFor(() => expect(editorPage.view().session).toBe('signed-out'))
    expect(page.visits).toEqual([])
    vi.mocked(api.session).mockResolvedValueOnce(ALICE)
    fromOtherTab()
    await vi.waitFor(() => expect(editorPage.view().session).toBe('active'))
  })

  it('暂停保存时按保存：先向服务端确认；本人已经在别处登录（消息没收到）就照常保存，否则不发请求', async () => {
    const { editorPage, api, fromOtherTab } = setup()
    await editorPage.load()
    vi.mocked(api.session).mockRejectedValueOnce(new ApiError(401, 'UNAUTHENTICATED', '请先登录'))
    fromOtherTab()
    await vi.waitFor(() => expect(editorPage.view().session).toBe('signed-out'))

    vi.mocked(api.session).mockRejectedValueOnce(new ApiError(401, 'UNAUTHENTICATED', '请先登录'))
    await editorPage.save()
    expect(api.save).not.toHaveBeenCalled()
    expect(editorPage.view().session).toBe('signed-out')

    vi.mocked(api.session).mockResolvedValueOnce(ALICE)
    await editorPage.save()
    expect(editorPage.view().session).toBe('active')
    expect(api.save).toHaveBeenCalledOnce()
  })

  it('确认会话时网络失败：页面照常', async () => {
    const { editorPage, api, fromOtherTab } = setup()
    await editorPage.load()
    vi.mocked(api.session).mockRejectedValueOnce(new NetworkError('断网'))
    fromOtherTab()
    await vi.waitFor(() => expect(api.session).toHaveBeenCalledTimes(2))
    expect(editorPage.view().session).toBe('active')
  })

  it('确认会话因为断网失败之后（别的标签页的消息触发，审查 A6）：自动保存暂停；恢复联网、回到前台时立即再确认，是本人就恢复', async () => {
    const { editorPage, api, fromOtherTab, online, hidden } = setup()
    await editorPage.load()
    vi.mocked(api.session).mockRejectedValueOnce(new NetworkError('断网'))
    fromOtherTab()
    await vi.waitFor(() => expect(editorPage.view().sessionProblem).toBeInstanceOf(NetworkError))
    expect(editorPage.view()).toMatchObject({ session: 'active', autosave: { paused: true } })
    const checks = vi.mocked(api.session).mock.calls.length
    // 断网、恢复联网：立即再确认（这一次仍然失败）
    vi.mocked(api.session).mockRejectedValueOnce(new NetworkError('断网'))
    online.set(false)
    expect(api.session).toHaveBeenCalledTimes(checks)
    online.set(true)
    await vi.waitFor(() => expect(api.session).toHaveBeenCalledTimes(checks + 1))
    await vi.waitFor(() => expect(editorPage.view().sessionProblem).toBeInstanceOf(NetworkError))
    // 切到后台、回到前台：立即再确认，这一次是本人：自动保存恢复
    hidden.set(true)
    expect(api.session).toHaveBeenCalledTimes(checks + 1)
    hidden.set(false)
    await vi.waitFor(() => expect(editorPage.view().sessionProblem).toBeUndefined())
    expect(api.session).toHaveBeenCalledTimes(checks + 2)
    expect(editorPage.view()).toMatchObject({ session: 'active', autosave: { paused: false } })
    // 确认过了：之后恢复联网、回到前台不再确认
    online.set(false)
    online.set(true)
    hidden.set(true)
    hidden.set(false)
    await settle()
    expect(api.session).toHaveBeenCalledTimes(checks + 2)
  })

  it('确认会话失败之后按自动保存的退避定时再确认（2、4、8……秒，审查 A6）；确认是本人之后不再定时', async () => {
    const { editorPage, api, fromOtherTab, time } = setup()
    await editorPage.load()
    vi.mocked(api.session).mockRejectedValue(new NetworkError('断网'))
    fromOtherTab()
    await vi.waitFor(() => expect(editorPage.view().sessionProblem).toBeInstanceOf(NetworkError))
    const checks = vi.mocked(api.session).mock.calls.length
    await time.advance(1999)
    expect(api.session).toHaveBeenCalledTimes(checks)
    await time.advance(1)
    expect(api.session).toHaveBeenCalledTimes(checks + 1)
    await time.advance(3999)
    expect(api.session).toHaveBeenCalledTimes(checks + 1)
    await time.advance(1)
    expect(api.session).toHaveBeenCalledTimes(checks + 2)
    vi.mocked(api.session).mockResolvedValue(ALICE)
    await time.advance(8000)
    expect(api.session).toHaveBeenCalledTimes(checks + 3)
    expect(editorPage.view()).toMatchObject({ session: 'active', sessionProblem: undefined, autosave: { paused: false } })
    await time.advance(120_000)
    expect(api.session).toHaveBeenCalledTimes(checks + 3)
  })

  it('确认有了结果之后退避清零（复验 C3）：之后再遇到确认失败，又从 2 秒起定时再确认', async () => {
    const { editorPage, api, fromOtherTab, time } = setup()
    await editorPage.load()
    vi.mocked(api.session).mockRejectedValue(new NetworkError('断网'))
    fromOtherTab()
    await vi.waitFor(() => expect(editorPage.view().sessionProblem).toBeInstanceOf(NetworkError))
    // 第一轮：2、4 秒之后各再确认一次（都失败），8 秒之后的那一次是本人
    await time.advance(6000)
    vi.mocked(api.session).mockResolvedValue(ALICE)
    await time.advance(8000)
    expect(editorPage.view().sessionProblem).toBeUndefined()
    // 第二轮：又一次确认失败，第一次定时再确认仍在 2 秒之后（不接着第一轮的 16 秒）
    vi.mocked(api.session).mockRejectedValue(new NetworkError('断网'))
    fromOtherTab()
    await vi.waitFor(() => expect(editorPage.view().sessionProblem).toBeInstanceOf(NetworkError))
    const checks = vi.mocked(api.session).mock.calls.length
    await time.advance(1999)
    expect(api.session).toHaveBeenCalledTimes(checks)
    await time.advance(1)
    expect(api.session).toHaveBeenCalledTimes(checks + 1)
  })

  it('续租一直得到令牌失效（例如网关剥掉了 CSRF 的请求头）、确认会话一直是本人（复验 C1）：只有第一次确认之后立即续租，之后按心跳的节奏——续租与确认都不按网络往返的速度连着发', async () => {
    const csrf = new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效')
    const { editorPage, api, editLease, time } = setup()
    await editorPage.load()
    expect(modeOf(editorPage)?.kind).toBe('editing')
    // 每个请求一个来回（50 毫秒）
    const renewedAt: number[] = []
    const confirmedAt: number[] = []
    editLease.renew.mockImplementation(async () => {
      renewedAt.push(time.now())
      return new Promise<RenewedEditLease>((_resolve, reject) => time.clock.schedule(() => reject(csrf), 50))
    })
    vi.mocked(api.session).mockImplementation(async () => {
      confirmedAt.push(time.now())
      return new Promise<SessionResponse>(resolve => time.clock.schedule(() => resolve(ALICE), 50))
    })
    const start = time.now()
    await time.advance(30_000)
    // 10 秒的心跳被拒 → 确认（10.05）→ 立即再续（10.1）仍被拒 → 确认（10.15）→ 按心跳：20.2 秒被拒 → 确认（20.25）→ 30.3 秒
    expect(renewedAt.map(at => at - start)).toEqual([10_000, 10_100, 20_200])
    expect(confirmedAt.map(at => at - start)).toEqual([10_050, 10_150, 20_250])
    expect(editorPage.view()).toMatchObject({ session: 'active', mode: { kind: 'editing' } })
  })

  it('保存得到 CSRF_TOKEN_INVALID：向服务端确认会话，换了人就停止保存', async () => {
    const { editorPage, api } = setup({ api: { save: async () => Promise.reject(new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效')) } })
    await editorPage.load()
    vi.mocked(api.session).mockResolvedValueOnce(BOB)
    await editorPage.save()
    await vi.waitFor(() => expect(editorPage.view().session).toBe('other-user'))
  })

  it('保存得到登录已过期：向服务端确认，没有人登录就暂停保存（不整页跳转，修改留着）；本人登录回来之后失败的说明清掉，再保存成功', async () => {
    let expired = true
    const { editorPage, page, api, fromOtherTab } = setup({
      api: { save: async () => expired ? Promise.reject(new ApiError(401, 'SESSION_EXPIRED', '已过期')) : ({ revision: 4, savedAt: '2026-09-27T03:00:00.000Z', unchanged: false }) },
    })
    await editorPage.load()
    vi.mocked(api.session).mockRejectedValueOnce(new ApiError(401, 'SESSION_EXPIRED', '已过期'))
    await editorPage.save()
    await vi.waitFor(() => expect(editorPage.view().session).toBe('signed-out'))
    expect(page.visits).toEqual([])
    expect(editorPage.view().save).toMatchObject({ status: 'failed', problem: { kind: 'request' } })

    // 本人在别处登录（消息送到）：会话恢复，"登录已过期"的说明不再成立（复验 RB2）
    expired = false
    vi.mocked(api.session).mockResolvedValueOnce(ALICE)
    fromOtherTab()
    await vi.waitFor(() => expect(editorPage.view().session).toBe('active'))
    expect(editorPage.view().save).toMatchObject({ status: 'clean', problem: undefined })
    await editorPage.save()
    expect(editorPage.view()).toMatchObject({ session: 'active', save: { status: 'clean' } })
  })

  it('确认会话进行中按保存：等确认结束再按结果保存，这次保存不会丢（复验 RB1）', async () => {
    const { editorPage, api, fromOtherTab } = setup()
    await editorPage.load()
    vi.mocked(api.session).mockRejectedValueOnce(UNAUTHENTICATED)
    fromOtherTab()
    await vi.waitFor(() => expect(editorPage.view().session).toBe('signed-out'))

    const check = deferred<SessionResponse>()
    vi.mocked(api.session).mockReturnValueOnce(check.promise)
    fromOtherTab()
    const saving = editorPage.save()
    check.resolve(ALICE)
    await saving
    expect(api.session).toHaveBeenCalledTimes(3)
    expect(api.save).toHaveBeenCalledOnce()
  })

  it('保存得到 CSRF_TOKEN_INVALID、确认还没结束时又按保存：等确认换上新的令牌之后再发，等待期间说明正在确认（复验 RB1、SB3、SB5）', async () => {
    const calls: string[] = []
    const save = vi.fn(async (): Promise<SaveContentResponse> => {
      calls.push('save')
      if (calls.filter(call => call === 'save').length === 1)
        throw new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效')
      return { revision: 4, savedAt: '2026-09-27T03:00:00.000Z', unchanged: false }
    })
    const { editorPage, api } = setup({ api: { save } })
    await editorPage.load()
    const check = deferred<SessionResponse>()
    vi.mocked(api.session).mockImplementationOnce(async () => {
      calls.push('check')
      const session = await check.promise
      calls.push('checked')
      return session
    })
    await editorPage.save()
    expect(editorPage.view().save?.status).toBe('failed')
    await vi.waitFor(() => expect(calls).toContain('check'))
    const again = editorPage.save()
    await vi.waitFor(() => expect(editorPage.view().confirmingSession).toBe(true))
    expect(save).toHaveBeenCalledOnce()
    check.resolve({ ...ALICE, csrfToken: 'csrf-new' })
    await again
    expect(calls).toEqual(['save', 'check', 'checked', 'save'])
    expect(editorPage.view()).toMatchObject({ session: 'active', confirmingSession: false, save: { status: 'clean', problem: undefined } })
  })

  it('一直是未登录、确认的原因变了：页面随之刷新，不留着过时的"网络连接失败"（复验 SB2）', async () => {
    const { editorPage, api, fromOtherTab } = setup()
    await editorPage.load()
    vi.mocked(api.session).mockRejectedValueOnce(UNAUTHENTICATED)
    fromOtherTab()
    await vi.waitFor(() => expect(editorPage.view().session).toBe('signed-out'))
    vi.mocked(api.session).mockRejectedValueOnce(new NetworkError('断网'))
    fromOtherTab()
    await vi.waitFor(() => expect(editorPage.view().sessionProblem).toBeInstanceOf(NetworkError))
    // 由别的标签页的消息触发，不经过保存：保存结束时的刷新不会掩盖确认本身漏掉的刷新（复验 TB2）
    vi.mocked(api.session).mockRejectedValueOnce(UNAUTHENTICATED)
    fromOtherTab()
    await vi.waitFor(() => expect(editorPage.view().sessionProblem).toBeUndefined())
    expect(editorPage.view().session).toBe('signed-out')
  })

  it('会话是本人、保存得到 CSRF 失效：确认进行中说明正在确认，先不显示失败；确认是本人之后再显示（复验 TB1）', async () => {
    const { editorPage, api } = setup({ api: { save: async () => Promise.reject(new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效')) } })
    await editorPage.load()
    const check = deferred<SessionResponse>()
    vi.mocked(api.session).mockReturnValueOnce(check.promise)
    await editorPage.save()
    expect(editorPage.view()).toMatchObject({ session: 'active', confirmingSession: true, save: { status: 'failed' } })
    check.resolve({ ...ALICE, csrfToken: 'csrf-new' })
    await vi.waitFor(() => expect(editorPage.view().confirmingSession).toBe(false))
    expect(editorPage.view()).toMatchObject({ session: 'active', sessionProblem: undefined, save: { status: 'failed', problem: { kind: 'request' } } })
  })

  it('会话是本人、保存得到登录已过期：确认进行中说明正在确认，先不显示失败；确认得到未登录之后暂停保存（复验 TB1、UB2）', async () => {
    const { editorPage, api } = setup({ api: { save: async () => Promise.reject(new ApiError(401, 'SESSION_EXPIRED', '已过期')) } })
    await editorPage.load()
    const check = deferred<SessionResponse>()
    vi.mocked(api.session).mockReturnValueOnce(check.promise)
    await editorPage.save()
    expect(editorPage.view()).toMatchObject({ session: 'active', confirmingSession: true, save: { status: 'failed' } })
    check.reject(new ApiError(401, 'SESSION_EXPIRED', '已过期'))
    await vi.waitFor(() => expect(editorPage.view().confirmingSession).toBe(false))
    expect(editorPage.view().session).toBe('signed-out')
  })

  it('保存得到 CSRF 失效、确认失败：再按保存先确认，又失败时不带着旧的令牌再发；确认成功之后才发（复验 UB1）', async () => {
    const calls: string[] = []
    const save = vi.fn(async (): Promise<SaveContentResponse> => {
      calls.push('save')
      if (calls.filter(call => call === 'save').length === 1)
        throw new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效')
      return { revision: 4, savedAt: '2026-09-27T03:00:00.000Z', unchanged: false }
    })
    const { editorPage, api } = setup({ api: { save } })
    await editorPage.load()
    const failCheck = async (): Promise<SessionResponse> => {
      calls.push('check')
      throw new ApiError(500, 'INTERNAL_ERROR', '出错了')
    }
    // 确认在途时又按了保存，确认失败：这次不发
    const check = deferred<SessionResponse>()
    vi.mocked(api.session).mockImplementationOnce(async () => {
      calls.push('check')
      return check.promise
    })
    await editorPage.save()
    const waiting = editorPage.save()
    check.reject(new ApiError(500, 'INTERNAL_ERROR', '出错了'))
    await waiting
    // 确认失败之后再按保存：先确认，又失败，同样不发
    vi.mocked(api.session).mockImplementationOnce(failCheck)
    await editorPage.save()
    expect(calls).toEqual(['save', 'check', 'check'])
    expect(editorPage.view()).toMatchObject({ session: 'active', confirmingSession: false, save: { status: 'failed' } })
    expect(editorPage.view().sessionProblem).toBeInstanceOf(ApiError)
    // 确认成功（换上新的令牌）之后才发
    vi.mocked(api.session).mockImplementationOnce(async () => {
      calls.push('check')
      return { ...ALICE, csrfToken: 'csrf-new' }
    })
    await editorPage.save()
    expect(calls).toEqual(['save', 'check', 'check', 'check', 'save'])
    expect(editorPage.view()).toMatchObject({ sessionProblem: undefined, save: { status: 'clean' } })
  })

  it('令牌失效之前就开始的那轮确认成功了，也不算令牌已经换好：之后的确认失败时照样不发（复验 VB1）', async () => {
    const pending = deferred<SaveContentResponse>()
    const save = vi.fn(async (): Promise<SaveContentResponse> => pending.promise)
    const { editorPage, api, fromOtherTab } = setup({ api: { save } })
    await editorPage.load()
    const saving = editorPage.save()
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce())
    // 别的标签页的消息先引起一轮确认；这时保存得到令牌失效，要求再确认一轮
    const early = deferred<SessionResponse>()
    vi.mocked(api.session).mockReturnValueOnce(early.promise).mockRejectedValueOnce(new ApiError(500, 'INTERNAL_ERROR', '出错了'))
    fromOtherTab()
    pending.reject(new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效'))
    await saving
    early.resolve(ALICE)
    await vi.waitFor(() => expect(api.session).toHaveBeenCalledTimes(3))
    await vi.waitFor(() => expect(editorPage.view().confirmingSession).toBe(false))
    // 再按保存：先确认，又失败，不发
    vi.mocked(api.session).mockRejectedValueOnce(new ApiError(500, 'INTERNAL_ERROR', '出错了'))
    await editorPage.save()
    expect(api.session).toHaveBeenCalledTimes(4)
    expect(save).toHaveBeenCalledOnce()
  })

  it('保存在途、别的标签页的消息触发的确认也在途，保存得到令牌失效：在途的那次结束之后再确认一轮（它可能早于令牌失效，复验 UB3）', async () => {
    const pending = deferred<SaveContentResponse>()
    const { editorPage, api, fromOtherTab } = setup({ api: { save: vi.fn(async () => pending.promise) } })
    await editorPage.load()
    const saving = editorPage.save()
    await vi.waitFor(() => expect(api.save).toHaveBeenCalledOnce())
    const first = deferred<SessionResponse>()
    const second = deferred<SessionResponse>()
    vi.mocked(api.session).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    fromOtherTab()
    pending.reject(new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效'))
    await saving
    expect(editorPage.view().confirmingSession).toBe(true)
    first.resolve({ ...ALICE, csrfToken: 'csrf-1' })
    await vi.waitFor(() => expect(api.session).toHaveBeenCalledTimes(3))
    expect(editorPage.view().confirmingSession).toBe(true)
    second.resolve({ ...ALICE, csrfToken: 'csrf-2' })
    await vi.waitFor(() => expect(editorPage.view().confirmingSession).toBe(false))
    expect(editorPage.view()).toMatchObject({ session: 'active', save: { status: 'failed', problem: { kind: 'request' } } })
  })

  it('保存得到 CSRF 失效、确认时断网：记下确认失败的原因（令牌没有换成）；再按保存先确认，换上新的令牌再发（复验 TB1）', async () => {
    const calls: string[] = []
    const save = vi.fn(async (): Promise<SaveContentResponse> => {
      calls.push('save')
      if (calls.filter(call => call === 'save').length === 1)
        throw new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效')
      return { revision: 4, savedAt: '2026-09-27T03:00:00.000Z', unchanged: false }
    })
    const { editorPage, api } = setup({ api: { save } })
    await editorPage.load()
    vi.mocked(api.session).mockImplementationOnce(async () => {
      calls.push('check')
      throw new NetworkError('断网')
    })
    await editorPage.save()
    await vi.waitFor(() => expect(editorPage.view().sessionProblem).toBeInstanceOf(NetworkError))
    expect(editorPage.view()).toMatchObject({ session: 'active', confirmingSession: false, save: { status: 'failed' } })

    vi.mocked(api.session).mockImplementationOnce(async () => {
      calls.push('check')
      return { ...ALICE, csrfToken: 'csrf-new' }
    })
    await editorPage.save()
    expect(calls).toEqual(['save', 'check', 'check', 'save'])
    expect(editorPage.view()).toMatchObject({ session: 'active', sessionProblem: undefined, save: { status: 'clean', problem: undefined } })
  })

  it('保存中再按保存（M3-P4 设计 §3.4、§3.9，取代复验 TB9 的"不做任何事"）：会话不必确认时不说正在确认；在途的结束之后立即再存一次', async () => {
    const pending = deferred<SaveContentResponse>()
    const save = vi.fn<EditorPageApi['save']>(async () => pending.promise)
    const { editorPage, api } = setup({ api: { save } })
    await editorPage.load()
    const saving = editorPage.save()
    await vi.waitFor(() => expect(api.save).toHaveBeenCalledOnce())
    const again = editorPage.save()
    expect(editorPage.view()).toMatchObject({ confirmingSession: false, save: { status: 'saving', canSave: true } })
    save.mockResolvedValueOnce({ revision: 5, savedAt: '2026-09-27T03:00:01.000Z', unchanged: true })
    pending.resolve({ revision: 4, savedAt: '2026-09-27T03:00:00.000Z', unchanged: false })
    await Promise.all([saving, again])
    expect(api.save).toHaveBeenCalledTimes(2)
  })

  it('保存中、同时有确认在途时再按保存：先等确认（页头说正在确认：这一次真的在等它），确认是本人之后排在在途的后面再存一次', async () => {
    const pending = deferred<SaveContentResponse>()
    const save = vi.fn<EditorPageApi['save']>(async () => pending.promise)
    const { editorPage, api, fromOtherTab } = setup({ api: { save } })
    await editorPage.load()
    const saving = editorPage.save()
    await vi.waitFor(() => expect(api.save).toHaveBeenCalledOnce())
    const check = deferred<SessionResponse>()
    vi.mocked(api.session).mockReturnValueOnce(check.promise)
    fromOtherTab()
    const again = editorPage.save()
    expect(editorPage.view()).toMatchObject({ confirmingSession: true, save: { status: 'saving' } })
    check.resolve(ALICE)
    save.mockResolvedValueOnce({ revision: 5, savedAt: '2026-09-27T03:00:01.000Z', unchanged: true })
    pending.resolve({ revision: 4, savedAt: '2026-09-27T03:00:00.000Z', unchanged: false })
    await Promise.all([saving, again])
    expect(api.save).toHaveBeenCalledTimes(2)
    expect(editorPage.view()).toMatchObject({ confirmingSession: false, save: { status: 'clean' } })
  })

  it('按保存时要等会话的确认（审查 A1）：按下的这一刻就提交开着的单元格编辑，确认期间才开始的输入不提交；确认是本人之后才上传', async () => {
    const cell = { open: true }
    const created = fakeEditor()
    const commitCellEditing = vi.fn(async () => {
      cell.open = false
      return true
    })
    const editor: SheetEditor = { ...created.editor, isCellEditing: () => cell.open, commitCellEditing }
    const { editorPage, api, fromOtherTab } = setup({ createEditor: async () => editor })
    await editorPage.load()
    const check = deferred<SessionResponse>()
    vi.mocked(api.session).mockReturnValueOnce(check.promise)
    fromOtherTab()
    const saving = editorPage.save()
    expect(commitCellEditing).toHaveBeenCalledOnce()
    expect(editorPage.view()).toMatchObject({ confirmingSession: true })
    // 确认期间点了另一格开始键入
    cell.open = true
    await settle()
    expect(api.save).not.toHaveBeenCalled()
    check.resolve(ALICE)
    await saving
    expect(api.save).toHaveBeenCalledOnce()
    expect(commitCellEditing).toHaveBeenCalledOnce()
  })

  it('保存得到未登录、向服务端确认时断网：按没有人登录显示，给出登录的入口（复验 SB4）', async () => {
    const { editorPage, api } = setup({ api: { save: async () => Promise.reject(new ApiError(401, 'SESSION_EXPIRED', '已过期')) } })
    await editorPage.load()
    vi.mocked(api.session).mockRejectedValueOnce(new NetworkError('断网'))
    await editorPage.save()
    await vi.waitFor(() => expect(editorPage.view().session).toBe('signed-out'))
    expect(editorPage.view().sessionProblem).toBeInstanceOf(NetworkError)
  })

  it('本人、CSRF 失效触发的确认在途时按保存，等待期间页面卸载了：不再捕获与上传（复验 SB6、TB4）', async () => {
    const save = vi.fn(async (): Promise<SaveContentResponse> => Promise.reject(new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效')))
    const { editorPage, api, fake } = setup({ api: { save } })
    await editorPage.load()
    const check = deferred<SessionResponse>()
    vi.mocked(api.session).mockReturnValueOnce(check.promise)
    await editorPage.save()
    expect(editorPage.view()).toMatchObject({ session: 'active', confirmingSession: true })
    const capture = vi.spyOn(fake.editor, 'capture')
    const again = editorPage.save()
    editorPage.dispose()
    check.resolve({ ...ALICE, csrfToken: 'csrf-new' })
    await again
    expect(capture).not.toHaveBeenCalled()
    expect(save).toHaveBeenCalledOnce()
  })

  it('等确认期间页面卸载了：不再捕获与上传（复验 SB6）', async () => {
    const { editorPage, api, fromOtherTab, fake } = setup()
    await editorPage.load()
    vi.mocked(api.session).mockRejectedValueOnce(UNAUTHENTICATED)
    fromOtherTab()
    await vi.waitFor(() => expect(editorPage.view().session).toBe('signed-out'))
    const check = deferred<SessionResponse>()
    vi.mocked(api.session).mockReturnValueOnce(check.promise)
    const capture = vi.spyOn(fake.editor, 'capture')
    const saving = editorPage.save()
    editorPage.dispose()
    check.resolve(ALICE)
    await saving
    expect(capture).not.toHaveBeenCalled()
    expect(api.save).not.toHaveBeenCalled()
  })

  it('创建编辑器期间别的标签页换了人：保存状态机一建好就停住（复验 RB3）', async () => {
    const creating = deferred<SheetEditor>()
    const { editorPage, api, fake, fromOtherTab } = setup({ createEditor: async () => creating.promise })
    const loading = editorPage.load()
    await vi.waitFor(() => expect(api.content).toHaveBeenCalledOnce())
    vi.mocked(api.session).mockResolvedValueOnce(BOB)
    fromOtherTab()
    await vi.waitFor(() => expect(editorPage.view().session).toBe('other-user'))
    creating.resolve(fake.editor)
    await loading
    expect(editorPage.view().save?.canSave).toBe(false)
  })

  it('换了人之后另一个人也退出了：按没有人登录处理，提示在新标签页中登录（复验 RB7）', async () => {
    const { editorPage, api, fromOtherTab } = setup()
    await editorPage.load()
    vi.mocked(api.session).mockResolvedValueOnce(BOB)
    fromOtherTab()
    await vi.waitFor(() => expect(editorPage.view().session).toBe('other-user'))
    vi.mocked(api.session).mockRejectedValueOnce(UNAUTHENTICATED)
    fromOtherTab()
    await vi.waitFor(() => expect(editorPage.view().session).toBe('signed-out'))
  })

  it('本人已在别处重新登录之后，之前那次保存迟到的"未登录"回包：确认之后仍是本人，不暂停保存（复验 RB7）', async () => {
    const pending = deferred<SaveContentResponse>()
    const { editorPage, api } = setup({ api: { save: vi.fn(async () => pending.promise) } })
    await editorPage.load()
    const saving = editorPage.save()
    await vi.waitFor(() => expect(api.save).toHaveBeenCalledOnce())
    vi.mocked(api.session).mockResolvedValueOnce({ ...ALICE, csrfToken: 'csrf-fresh' })
    pending.reject(new ApiError(401, 'SESSION_EXPIRED', '已过期'))
    await saving
    await vi.waitFor(() => expect(api.session).toHaveBeenCalledTimes(2))
    // 一直是本人：这次保存没有成功要让用户看到（页头提示再保存一次，令牌已经换好，复验 SB1）
    expect(editorPage.view()).toMatchObject({ session: 'active', save: { status: 'failed', problem: { kind: 'request' } } })
  })

  it('暂停保存时按保存、确认会话网络失败：说明确认失败的原因，不发保存的请求；之后确认成功时清掉（复验 RB7）', async () => {
    const { editorPage, api, fromOtherTab } = setup()
    await editorPage.load()
    vi.mocked(api.session).mockRejectedValueOnce(UNAUTHENTICATED)
    fromOtherTab()
    await vi.waitFor(() => expect(editorPage.view().session).toBe('signed-out'))
    const offline = new NetworkError('断网')
    vi.mocked(api.session).mockRejectedValueOnce(offline)
    await editorPage.save()
    expect(api.save).not.toHaveBeenCalled()
    expect(editorPage.view()).toMatchObject({ session: 'signed-out', sessionProblem: offline })
    vi.mocked(api.session).mockResolvedValueOnce(ALICE)
    await editorPage.save()
    expect(editorPage.view()).toMatchObject({ session: 'active', sessionProblem: undefined })
  })

  it('载入时还不知道本页的用户就收到了会话消息：知道之后再确认一次（复验 RB7）', async () => {
    const first = deferred<SessionResponse>()
    const { editorPage, api, fromOtherTab } = setup()
    vi.mocked(api.session).mockReturnValueOnce(first.promise)
    const loading = editorPage.load()
    fromOtherTab()
    vi.mocked(api.session).mockRejectedValueOnce(UNAUTHENTICATED)
    first.resolve(ALICE)
    await loading
    await vi.waitFor(() => expect(editorPage.view().session).toBe('signed-out'))
  })

  it('卸载之后不再处理别的标签页的消息，销毁编辑器', async () => {
    const { editorPage, fake, listeners } = setup()
    await editorPage.load()
    editorPage.dispose()
    expect(listeners.size).toBe(0)
    expect(fake.editor.dispose).toHaveBeenCalledOnce()
  })

  it('重新加载：整页', async () => {
    const { editorPage, page } = setup()
    editorPage.reload()
    expect(page.reload).toHaveBeenCalledOnce()
  })
})

describe('页头的文档详情（M2-P5：只凭授权时返回"与我共享"、分享的入口）', () => {
  it('就绪时带着页头要的东西：文档 id、看得到它的途径、能不能分享、看这一页的人', async () => {
    const { editorPage } = setup({ api: { document: async () => ({ ...DETAIL, accessVia: 'grant', permissions: { ...DETAIL.permissions, canShare: true } }) } })
    await editorPage.load()
    expect(editorPage.view().load).toEqual({ kind: 'ready', documentId: DOCUMENT_ID, title: '周报', space: DETAIL.space, accessVia: 'grant', canShare: true, userId: ALICE.user.id })
  })

  it('refreshDetail：重新取文档详情，更新标题、所在的空间、途径与能不能分享；编辑时能不能编辑不变（保存时由服务端再判断）', async () => {
    const document = vi.fn(async (): Promise<DocumentDetail> => ({ ...DETAIL, permissions: { ...DETAIL.permissions, canShare: true } }))
    const { editorPage } = setup({ api: { document } })
    await editorPage.load()
    document.mockResolvedValueOnce({ ...DETAIL, title: '新标题', space: { id: '0199a2c4-0000-7000-8000-0000000000c1', type: 'team', name: '市场部' }, permissions: { ...DETAIL.permissions, canEdit: false, canShare: false } })
    await editorPage.refreshDetail()
    expect(editorPage.view().load).toMatchObject({ kind: 'ready', title: '新标题', space: { type: 'team', name: '市场部' }, canShare: false })
    expect(modeOf(editorPage)).toEqual({ kind: 'editing' })
  })

  it('refreshDetail 时阅读：能不能编辑随之更新（"编辑"随之出现或消失）', async () => {
    const document = vi.fn(async (): Promise<DocumentDetail> => DETAIL)
    const { editorPage } = setup({ api: { document }, editIntent: false })
    await editorPage.load()
    document.mockResolvedValueOnce({ ...DETAIL, permissions: { ...DETAIL.permissions, canEdit: false } })
    await editorPage.refreshDetail()
    expect(modeOf(editorPage)).toMatchObject({ kind: 'reading', canEdit: false })
  })

  it('refreshDetail 没能刷新（DEF-040）：页头留着之前的信息，说明没能刷新（原因）；再刷新成功时说明消失', async () => {
    const document = vi.fn(async (): Promise<DocumentDetail> => ({ ...DETAIL, permissions: { ...DETAIL.permissions, canShare: true } }))
    const { editorPage } = setup({ api: { document } })
    await editorPage.load()
    const busy = new ApiError(503, 'SERVICE_UNAVAILABLE', '繁忙')
    document.mockRejectedValueOnce(busy)
    await editorPage.refreshDetail()
    expect(editorPage.view()).toMatchObject({ load: { title: '周报', canShare: true }, detailProblem: busy })
    await editorPage.refreshDetail()
    expect(editorPage.view().detailProblem).toBeUndefined()
  })

  it('refreshDetail 时看不到了（404：已经删除、移走，或者自己被移出、授权被取消）：不再能分享；别的失败页头不变；未登录交给会话的确认', async () => {
    const document = vi.fn(async (): Promise<DocumentDetail> => ({ ...DETAIL, permissions: { ...DETAIL.permissions, canShare: true } }))
    const { editorPage, api } = setup({ api: { document } })
    await editorPage.load()
    document.mockRejectedValueOnce(new ApiError(503, 'SERVICE_UNAVAILABLE', '繁忙'))
    await editorPage.refreshDetail()
    expect(editorPage.view().load).toMatchObject({ canShare: true })
    document.mockRejectedValueOnce(UNAUTHENTICATED)
    const sessionChecks = vi.mocked(api.session).mock.calls.length
    await editorPage.refreshDetail()
    await vi.waitFor(() => expect(vi.mocked(api.session).mock.calls.length).toBeGreaterThan(sessionChecks))
    document.mockRejectedValueOnce(new ApiError(404, 'NOT_FOUND', '不存在'))
    await editorPage.refreshDetail()
    expect(editorPage.view().load).toMatchObject({ kind: 'ready', canShare: false })
  })

  it('还没就绪、或者已经卸载：refreshDetail 什么也不做', async () => {
    const { editorPage, api } = setup()
    await editorPage.refreshDetail()
    expect(api.document).not.toHaveBeenCalled()
    await editorPage.load()
    editorPage.dispose()
    await editorPage.refreshDetail()
    expect(api.document).toHaveBeenCalledTimes(1)
  })
})

const AMY = { id: '0199a2c4-1f2e-7a3b-8c4d-00000000000c', username: 'amy', displayName: '艾米' }

/** 申请被占用：持有者是别人（艾米）或者自己；serverTime 是服务端回答的时刻（响应头 Date） */
function heldBy(sameUser: boolean, serverTime?: number): ApiError {
  const holder = sameUser ? { id: ALICE.user.id, username: ALICE.user.username, displayName: ALICE.user.displayName } : AMY
  return new ApiError(409, 'EDIT_LEASE_HELD', '别人正在编辑这份文档', { details: { holder, lastActiveAt: '2026-09-27T02:55:00.000Z', sameUser, sameSession: false, canTakeOver: false, request: null }, serverTime })
}

function leaseLost(reason: string): ApiError {
  return new ApiError(409, 'EDIT_LEASE_LOST', '编辑权已失效，本次操作没有生效', { details: { reason } })
}

describe('编辑权（M3-P1 设计 §3.4.7）', () => {
  it('能编辑：载入元数据与内容之后申请（本页这次加载的标识，保存也带着它），取得了按可编辑创建；保存带上令牌与代次；每 10 秒续租', async () => {
    const { editorPage, api, editLease, createEditor, surface, time, chrome } = setup()
    await editorPage.load()
    expect(editLease.acquire).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, 'id-1')
    expect(editLease.acquire.mock.invocationCallOrder[0]).toBeGreaterThan(Math.max(...vi.mocked(api.content).mock.invocationCallOrder))
    expect(createEditor).toHaveBeenCalledExactlyOnceWith({ container: surface, pageUi: chrome, snapshot: '{"id":"unit-1"}', access: 'edit' })
    expect(editorPage.view()).toMatchObject({ mode: { kind: 'editing' }, save: { canSave: true } })
    await editorPage.save()
    expect(api.save).toHaveBeenCalledWith(DOCUMENT_ID, expect.objectContaining<Partial<SaveRequest>>({ clientInstanceId: 'id-1' }), expect.anything(), CREDENTIALS)
    await time.advance(10_000)
    expect(editLease.renew).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, TOKEN, 10)
    await time.advance(10_000)
    expect(editLease.renew).toHaveBeenCalledTimes(2)
  })

  it('续租上报距离本页最后一次键盘、鼠标操作的秒数：操作由组装处给出的来源记下（trackActivity：窗口的捕获阶段、只认可信事件）；订阅挂在交互屏障之前', async () => {
    const { editorPage, editLease, time, activity } = setup()
    await editorPage.load()
    // 订阅时容器还没有状态：交互屏障（setSurface('loading')）在它之后才挂上，载入期间被拦下的输入也算有操作
    expect(activity.record.subscribedAt).toBeUndefined()
    await time.advance(4_000)
    activity.fire()
    await time.advance(6_000)
    expect(editLease.renew).toHaveBeenLastCalledWith(DOCUMENT_ID, TOKEN, 6)
    activity.fire()
    await time.advance(10_000)
    expect(editLease.renew).toHaveBeenLastCalledWith(DOCUMENT_ID, TOKEN, 10)
    // 页面里派发的事件（不可信）不经这个来源：不算有操作，空闲照样往上加
    window.dispatchEvent(new Event('keydown'))
    await time.advance(10_000)
    expect(editLease.renew).toHaveBeenLastCalledWith(DOCUMENT_ID, TOKEN, 20)
  })

  it('申请得到的修订号比载入的内容新（这期间有人保存过）：按条件读取（本页的修订号）取服务端的内容，按它创建，以它的修订号作保存的基准', async () => {
    const contentIfChanged = vi.fn<EditorPageApi['contentIfChanged']>().mockResolvedValueOnce({ snapshot: '{"id":"unit-1","v":5}', revision: 5 })
    const { editorPage, api, createEditor, surface, chrome } = setup({ api: { content: async () => ({ snapshot: '{"id":"unit-1","v":3}', revision: 3 }), contentIfChanged }, editLease: { acquire: vi.fn(async () => ({ ...ACQUIRED, revision: 5 })) } })
    await editorPage.load()
    expect(contentIfChanged).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, 3)
    expect(createEditor).toHaveBeenCalledExactlyOnceWith({ container: surface, pageUi: chrome, snapshot: '{"id":"unit-1","v":5}', access: 'edit' })
    await editorPage.save()
    expect(api.save).toHaveBeenCalledWith(DOCUMENT_ID, expect.objectContaining<Partial<SaveRequest>>({ baseRevision: 5 }), expect.anything(), CREDENTIALS)
  })

  it('修订号相同：不重新载入', async () => {
    const { editorPage, api } = setup()
    await editorPage.load()
    expect(api.content).toHaveBeenCalledOnce()
    expect(api.contentIfChanged).not.toHaveBeenCalled()
  })

  it('重新载入内容失败（网络）：释放已经取得的编辑权，以只读打开载入的内容，说明没能进入编辑（与"编辑"时相同，审查 A11）；地址里的标记留着', async () => {
    const { editorPage, editLease, createEditor, surface, editIntent, chrome } = setup({ api: { contentIfChanged: async () => Promise.reject(new NetworkError('断网')) }, editLease: { acquire: vi.fn(async () => ({ ...ACQUIRED, revision: 4 })) } })
    await editorPage.load()
    expect(editLease.release).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, TOKEN)
    expect(createEditor).toHaveBeenCalledExactlyOnceWith({ container: surface, pageUi: chrome, snapshot: '{"id":"unit-1"}', access: 'read', viewState: undefined })
    expect(editorPage.view()).toMatchObject({ load: { kind: 'ready' }, mode: { kind: 'reading', canEdit: true, notice: { kind: 'enter-failed' } }, save: undefined })
    expect(editIntent.clear).not.toHaveBeenCalled()
  })

  it('别人正在编辑：按只读创建，页头说明持有者与最后活动几分钟之前（按服务端的时间算）；没有保存，不续租；地址里的标记留着', async () => {
    const serverTime = Date.UTC(2026, 8, 27, 3, 2, 30)
    const editStatus = async (): Promise<FetchedEditStatus> => ({ status: { revision: 3, editor: { holder: AMY, lastActiveAt: '2026-09-27T02:55:00.000Z', sameUser: false, sameSession: false }, canEdit: true, canTakeOver: false, formulasPending: false, request: null, reservation: null, interruption: null }, serverTime })
    const { editorPage, editLease, createEditor, surface, time, editIntent, chrome } = setup({ api: { editStatus }, editLease: { acquire: vi.fn(async () => Promise.reject(heldBy(false, serverTime))) } })
    await editorPage.load()
    await settle()
    expect(createEditor).toHaveBeenCalledExactlyOnceWith({ container: surface, pageUi: chrome, snapshot: '{"id":"unit-1"}', access: 'read' })
    expect(editorPage.view()).toMatchObject({
      load: { kind: 'ready' },
      save: undefined,
      mode: { kind: 'reading', canEdit: true, holder: { holder: AMY, sameUser: false, lastActiveMinutes: 7 } },
    })
    expect(editIntent.clear).not.toHaveBeenCalled()
    expect(editorPage.hasUnsavedWork()).toBe(false)
    await time.advance(60_000)
    expect(editLease.acquire).toHaveBeenCalledOnce()
    expect(editLease.renew).not.toHaveBeenCalled()
    editorPage.dispose()
    expect(editLease.release).not.toHaveBeenCalled()
  })

  it('自己在别处正在编辑（例如刷新时旧页面的释放还没到，P1 设计 §7）：隔一小会儿再试，旧页面的释放到了就取得', async () => {
    const acquire = vi.fn<EditLeaseApi['acquire']>().mockRejectedValueOnce(heldBy(true)).mockResolvedValueOnce(ACQUIRED)
    const { editorPage, createEditor, surface, time, chrome } = setup({ editLease: { acquire } })
    const loading = editorPage.load()
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce())
    await time.advance(500)
    await loading
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(createEditor).toHaveBeenCalledExactlyOnceWith({ container: surface, pageUi: chrome, snapshot: '{"id":"unit-1"}', access: 'edit' })
    expect(modeOf(editorPage)).toEqual({ kind: 'editing' })
  })

  it('自己在别处正在编辑、再试几次仍被占用：按只读，说明是自己', async () => {
    const acquire = vi.fn(async () => Promise.reject(heldBy(true)))
    const editStatus = async (): Promise<FetchedEditStatus> => ({ status: { revision: 3, editor: { holder: { id: ALICE.user.id, username: ALICE.user.username, displayName: ALICE.user.displayName }, lastActiveAt: '2026-09-27T02:55:00.000Z', sameUser: true, sameSession: false }, canEdit: true, canTakeOver: false, formulasPending: false, request: null, reservation: null, interruption: null }, serverTime: undefined })
    const { editorPage, createEditor, time } = setup({ editLease: { acquire }, api: { editStatus } })
    const loading = editorPage.load()
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce())
    await time.advance(1_500)
    await loading
    expect(acquire).toHaveBeenCalledTimes(4)
    expect(createEditor).toHaveBeenCalledWith(expect.objectContaining({ access: 'read' }))
    expect(modeOf(editorPage)).toMatchObject({ kind: 'reading', holder: { sameUser: true } })
  })

  it('申请时刚失去编辑权（403）：按只读打开，不说明谁在编辑，没有"编辑"', async () => {
    const editStatus = async (): Promise<FetchedEditStatus> => ({ status: { revision: 3, editor: null, canEdit: false, canTakeOver: false, formulasPending: false, request: null, reservation: null, interruption: null }, serverTime: undefined })
    const { editorPage, createEditor } = setup({ api: { editStatus }, editLease: { acquire: vi.fn(async () => Promise.reject(new ApiError(403, 'PERMISSION_DENIED', '只能查看这份文档，不能保存'))) } })
    await editorPage.load()
    expect(createEditor).toHaveBeenCalledWith(expect.objectContaining({ access: 'read' }))
    expect(editorPage.view()).toMatchObject({ load: { kind: 'ready' }, save: undefined, mode: { kind: 'reading', canEdit: false, holder: undefined } })
  })

  it('申请时读不到了（404）：与读取元数据、内容失败相同，不创建编辑器', async () => {
    const { editorPage, createEditor } = setup({ editLease: { acquire: vi.fn(async () => Promise.reject(new ApiError(404, 'NOT_FOUND', '不存在'))) } })
    await editorPage.load()
    expect(editorPage.view().load).toMatchObject({ kind: 'not-found' })
    expect(createEditor).not.toHaveBeenCalled()
  })

  it('申请的结果未知（回包丢了，服务端其实已经批给了本页）：隔一小会儿用同一个标识再试一次，取得就照常编辑，不留下没人用的一代（审查 B7）', async () => {
    const acquire = vi.fn<EditLeaseApi['acquire']>().mockRejectedValueOnce(new NetworkError('断网')).mockResolvedValueOnce(ACQUIRED)
    const { editorPage, createEditor, surface, time, chrome } = setup({ editLease: { acquire } })
    const loading = editorPage.load()
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce())
    await time.advance(500)
    await loading
    expect(acquire.mock.calls).toEqual([[DOCUMENT_ID, 'id-1'], [DOCUMENT_ID, 'id-1']])
    expect(createEditor).toHaveBeenCalledExactlyOnceWith({ container: surface, pageUi: chrome, snapshot: '{"id":"unit-1"}', access: 'edit' })
    expect(modeOf(editorPage)).toEqual({ kind: 'editing' })
  })

  it.each([
    ['结果未知、再试一次仍然未知（网络）', new NetworkError('断网')],
    ['服务端出错（5xx）', new ApiError(503, 'SERVICE_UNAVAILABLE', '繁忙')],
  ])('申请的%s：内容已经读到、文档本身没有问题——以只读打开，说明没能进入编辑（与"编辑"时相同，审查 A11），不整页加载失败；地址里的标记留着', async (_case, error) => {
    const acquire = vi.fn(async () => Promise.reject(error))
    const { editorPage, createEditor, surface, time, editIntent, chrome } = setup({ editLease: { acquire } })
    const loading = editorPage.load()
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce())
    await time.advance(500)
    await loading
    expect(createEditor).toHaveBeenCalledExactlyOnceWith({ container: surface, pageUi: chrome, snapshot: '{"id":"unit-1"}', access: 'read', viewState: undefined })
    expect(editorPage.view()).toMatchObject({ load: { kind: 'ready' }, mode: { kind: 'reading', canEdit: true, notice: { kind: 'enter-failed', error } } })
    expect(surface.dataset.editorState).toBe('ready')
    expect(editIntent.clear).not.toHaveBeenCalled()
  })

  it('申请时未登录：整页转到登录页', async () => {
    const { editorPage, page } = setup({ editLease: { acquire: vi.fn(async () => Promise.reject(new ApiError(401, 'SESSION_EXPIRED', '已过期'))) } })
    await editorPage.load()
    expect(page.visits).toEqual([`/login?from=%2Fdocuments%2F${DOCUMENT_ID}&reason=expired`])
  })

  it('只能查看：不申请编辑权', async () => {
    const { editorPage, editLease } = setup({ api: { document: async () => ({ ...DETAIL, permissions: { ...DETAIL.permissions, canEdit: false } }), editStatus: VIEWER_STATUS } })
    await editorPage.load()
    expect(editLease.acquire).not.toHaveBeenCalled()
    expect(modeOf(editorPage)).toMatchObject({ kind: 'reading', canEdit: false })
  })

  it.each([
    ['编辑权被收回（EDIT_LEASE_LOST）', leaseLost('revoked'), { kind: 'lease', reason: 'revoked' }],
    ['读不到了（404）', new ApiError(404, 'NOT_FOUND', '不存在'), { kind: 'not-found' }],
    ['不能编辑了（403）', new ApiError(403, 'PERMISSION_DENIED', '空间已归档，只能查看'), { kind: 'denied' }],
  ])('续租得知失去访问或编辑权（%s）：不续上，停止保存，转入失去编辑权、记下来源；离开提示照旧按有没有未保存的修改', async (_case, error, loss) => {
    const { editorPage, api, editLease, fake, time } = setup({ editLease: { renew: vi.fn(async () => Promise.reject(error)) } })
    await editorPage.load()
    Object.assign(fake.editor, { changeSeq: () => 1 })
    fake.changeListeners.forEach(listener => listener())
    await time.advance(10_000)
    await settle()
    expect(editorPage.view()).toMatchObject({ mode: { kind: 'lost', loss, unsaved: true }, save: undefined })
    expect(editorPage.hasUnsavedWork()).toBe(true)
    await editorPage.save()
    expect(api.compress).not.toHaveBeenCalled()
    expect(api.save).not.toHaveBeenCalled()
    await time.advance(60_000)
    expect(editLease.renew).toHaveBeenCalledOnce()
  })

  it('失效之后会话回到本人：保存仍然停着', async () => {
    const { editorPage, api, fromOtherTab, time } = setup({ editLease: { renew: vi.fn(async () => Promise.reject(leaseLost('revoked'))) } })
    await editorPage.load()
    await time.advance(10_000)
    await settle()
    expect(modeOf(editorPage)).toMatchObject({ kind: 'lost' })
    vi.mocked(api.session).mockResolvedValueOnce(BOB).mockResolvedValueOnce(ALICE)
    fromOtherTab()
    await vi.waitFor(() => expect(editorPage.view().session).toBe('other-user'))
    fromOtherTab()
    await vi.waitFor(() => expect(editorPage.view().session).toBe('active'))
    await editorPage.save()
    expect(api.save).not.toHaveBeenCalled()
  })

  it('保存得到编辑权被收回（EDIT_LEASE_LOST）：与续租失效同一个处理（不续上，停止保存与续租），保存显示失败', async () => {
    const { editorPage, editLease, time } = setup({ api: { save: async () => Promise.reject(leaseLost('revoked')) } })
    await editorPage.load()
    await editorPage.save()
    await settle()
    expect(editorPage.view()).toMatchObject({ mode: { kind: 'lost', loss: { kind: 'lease', reason: 'revoked' } }, save: undefined })
    expect(editLease.acquire).toHaveBeenCalledOnce()
    await time.advance(60_000)
    expect(editLease.renew).not.toHaveBeenCalled()
  })

  it.each([
    ['404（读不到了）', new ApiError(404, 'NOT_FOUND', '不存在'), 'not-found'],
    ['403（不能编辑了）', new ApiError(403, 'PERMISSION_DENIED', '只能查看这份文档，不能编辑'), 'denied'],
  ])('保存得到 %s：与续租得知同一个处理——转为失效（心跳先发现还是保存先发现，界面一样）', async (_case, error, kind) => {
    const { editorPage, editLease, time } = setup({ api: { save: async () => Promise.reject(error) } })
    await editorPage.load()
    await editorPage.save()
    await settle()
    expect(editorPage.view()).toMatchObject({ mode: { kind: 'lost', loss: { kind, error } }, save: undefined })
    expect(editLease.acquire).toHaveBeenCalledOnce()
    await time.advance(60_000)
    expect(editLease.renew).not.toHaveBeenCalled()
  })

  it('保存得到 400（请求不合法）：是这次请求本身的问题，不算编辑权失效——仍在编辑，不续上、不释放（审查 B5，第二批 G-5）', async () => {
    const invalid = new ApiError(400, 'REQUEST_INVALID', '请求的格式或参数不合法')
    const { editorPage, editLease } = setup({ api: { save: async () => Promise.reject(invalid) } })
    await editorPage.load()
    await editorPage.save()
    expect(editorPage.view()).toMatchObject({ mode: { kind: 'editing' }, save: { status: 'failed', canSave: true, problem: { kind: 'request', error: invalid } } })
    expect(editLease.acquire).toHaveBeenCalledOnce()
    expect(editLease.release).not.toHaveBeenCalled()
  })

  it('保存一直得到可以续上的失效、续上一直成功（例如代理吞掉了令牌的请求头）：至多重发一次——保存 2 次、申请 3 次，以失败交回，不形成请求风暴（审查 B4）', async () => {
    const lost = leaseLost('session')
    let saves = 0
    // 第三次起改为断网：去掉"至多重发一次"的变异不至于无限循环、卡死测试进程，照样被下面的断言抓到
    const save = vi.fn<EditorPageApi['save']>(async () => Promise.reject(++saves <= 2 ? lost : new NetworkError('断网')))
    let generation = 0
    const acquire = vi.fn(async (): Promise<AcquiredEditLease> => {
      generation += 1
      return { ...ACQUIRED, token: String.fromCharCode(64 + generation).repeat(43), writeEpoch: 6 + generation }
    })
    const { editorPage, editLease } = setup({ api: { save }, editLease: { acquire } })
    await editorPage.load()
    await editorPage.save()
    expect(save).toHaveBeenCalledTimes(2)
    expect(editLease.acquire).toHaveBeenCalledTimes(3)
    expect(save.mock.calls.map(call => call[3])).toEqual([{ token: 'A'.repeat(43), writeEpoch: 7 }, { token: 'B'.repeat(43), writeEpoch: 8 }])
    expect(editorPage.view()).toMatchObject({ mode: { kind: 'editing' }, save: { status: 'failed', problem: { kind: 'request', error: lost } } })
  })

  it('保存得到可以续上的失效（到期）：放掉手里那一代、重新申请，续上之后用新的编辑权重发这一次（requestId 不变），保存成功，不出现失效的说明', async () => {
    const save = vi.fn<EditorPageApi['save']>()
      .mockRejectedValueOnce(leaseLost('expired'))
      .mockResolvedValueOnce({ revision: 4, savedAt: '2026-09-27T03:00:00.000Z', unchanged: false })
    const { editorPage, editLease } = setup({ api: { save } })
    await editorPage.load()
    editLease.acquire.mockResolvedValueOnce(NEXT_LEASE)
    await editorPage.save()
    expect(editLease.release).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, TOKEN)
    expect(editLease.release.mock.invocationCallOrder[0]).toBeLessThan(editLease.acquire.mock.invocationCallOrder[1] ?? 0)
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[0]?.[3]).toEqual(CREDENTIALS)
    expect(save.mock.calls[1]?.[3]).toEqual(NEXT_CREDENTIALS)
    expect(save.mock.calls[1]?.[1].requestId).toBe(save.mock.calls[0]?.[1].requestId)
    expect(editorPage.view()).toMatchObject({ mode: { kind: 'editing' }, save: { status: 'clean', problem: undefined } })
  })

  it('保存得到可以续上的失效、续上时修订号变了（别处保存过）：不覆盖——放掉刚申请到的，按失效处理（newer），不重发', async () => {
    const save = vi.fn(async (): Promise<SaveContentResponse> => Promise.reject(leaseLost('replaced')))
    const { editorPage, editLease } = setup({ api: { save } })
    await editorPage.load()
    editLease.acquire.mockResolvedValueOnce({ ...NEXT_LEASE, revision: 4 })
    await editorPage.save()
    expect(save).toHaveBeenCalledOnce()
    expect(editLease.release).toHaveBeenLastCalledWith(DOCUMENT_ID, NEXT_TOKEN)
    await settle()
    expect(editorPage.view()).toMatchObject({ mode: { kind: 'lost', loss: { kind: 'newer' } }, save: undefined })
  })

  it('保存得到可以续上的失效、续上时网络错误：保存按网络错误说明失败，编辑权的状态不变；再按保存时续上并保存成功', async () => {
    const save = vi.fn<EditorPageApi['save']>()
      .mockRejectedValueOnce(leaseLost('expired'))
      .mockRejectedValueOnce(leaseLost('released'))
      .mockResolvedValueOnce({ revision: 4, savedAt: '2026-09-27T03:00:00.000Z', unchanged: false })
    const { editorPage, editLease } = setup({ api: { save } })
    await editorPage.load()
    const offline = new NetworkError('断网')
    editLease.acquire.mockRejectedValueOnce(offline)
    await editorPage.save()
    expect(editorPage.view()).toMatchObject({ mode: { kind: 'editing' }, save: { status: 'failed', problem: { kind: 'request', error: offline } } })
    editLease.acquire.mockResolvedValueOnce(NEXT_LEASE)
    await editorPage.save()
    expect(save).toHaveBeenCalledTimes(3)
    expect(save.mock.calls[2]?.[3]).toEqual(NEXT_CREDENTIALS)
    expect(editorPage.view()).toMatchObject({ mode: { kind: 'editing' }, save: { status: 'clean' } })
  })

  it('续租得知中断（到期）：放掉手里那一代、重新申请，修订号没变就续上，不出现失效的说明；之后的保存与续租带新的令牌与代次', async () => {
    const { editorPage, api, editLease, time } = setup({ editLease: { renew: vi.fn<EditLeaseApi['renew']>().mockRejectedValueOnce(leaseLost('expired')).mockResolvedValue(RENEWED) } })
    await editorPage.load()
    editLease.acquire.mockResolvedValueOnce(NEXT_LEASE)
    await time.advance(10_000)
    expect(editLease.release).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, TOKEN)
    // 续上的申请带本页的空闲秒数（M3-P5 设计 §3.5）
    expect(editLease.acquire).toHaveBeenLastCalledWith(DOCUMENT_ID, 'id-1', { idleSeconds: 10 })
    expect(editorPage.view()).toMatchObject({ mode: { kind: 'editing' }, save: { canSave: true } })
    await editorPage.save()
    expect(api.save).toHaveBeenLastCalledWith(DOCUMENT_ID, expect.anything(), expect.anything(), NEXT_CREDENTIALS)
    await time.advance(10_000)
    expect(editLease.renew).toHaveBeenLastCalledWith(DOCUMENT_ID, NEXT_TOKEN, expect.any(Number))
  })

  it('本页一次保存结果未知（其实已经提交）之后，心跳得知编辑权到期：续上时认出期间的那一版是本页自己的，以它为基准接着保存（审查 B1）', async () => {
    const save = vi.fn<EditorPageApi['save']>()
      .mockRejectedValueOnce(new NetworkError('断网'))
      .mockResolvedValueOnce({ revision: 5, savedAt: '2026-09-27T03:00:00.000Z', unchanged: false })
    const { editorPage, editLease, fake, time } = setup({ api: { save }, editLease: { renew: vi.fn<EditLeaseApi['renew']>().mockRejectedValueOnce(leaseLost('expired')).mockResolvedValue(RENEWED) } })
    await editorPage.load()
    Object.assign(fake.editor, { changeSeq: () => 1 })
    fake.changeListeners.forEach(listener => listener())
    await editorPage.save()
    expect(editorPage.view().save).toMatchObject({ status: 'failed' })
    editLease.acquire.mockResolvedValueOnce({ ...NEXT_LEASE, revision: 4, source: { clientInstanceId: 'id-1', localSeq: 1 } })
    await time.advance(10_000)
    expect(editorPage.view()).toMatchObject({ mode: { kind: 'editing' }, save: { status: 'clean', problem: undefined } })
    await editorPage.save()
    expect(save).toHaveBeenLastCalledWith(DOCUMENT_ID, expect.objectContaining<Partial<SaveRequest>>({ baseRevision: 4 }), expect.anything(), NEXT_CREDENTIALS)
    expect(editorPage.view().save).toMatchObject({ status: 'clean' })
  })

  it('本页一次保存结果未知之后，下一次保存先得知编辑权到期：续上时认出是本页自己的，重发得到的冲突来源也是它——换上新的基准再发，保存成功（审查 B1）', async () => {
    // 冲突的详情按契约解析：本页的标识要是 UUID 的写法
    let ids = 0
    const newId = (): string => `0199a2c4-1f2e-4a3b-8c4d-${String(++ids).padStart(12, '0')}`
    const pageId = '0199a2c4-1f2e-4a3b-8c4d-000000000001'
    const own = { clientInstanceId: pageId, localSeq: 1 }
    const save = vi.fn<EditorPageApi['save']>()
      .mockRejectedValueOnce(new NetworkError('断网'))
      .mockRejectedValueOnce(leaseLost('expired'))
      .mockRejectedValueOnce(new ApiError(409, 'DOCUMENT_REVISION_CONFLICT', '别处保存了更新的版本', { details: { currentRevision: 4, source: own } }))
      .mockResolvedValueOnce({ revision: 5, savedAt: '2026-09-27T03:00:00.000Z', unchanged: false })
    const { editorPage, editLease, fake } = setup({ api: { save }, newId })
    await editorPage.load()
    Object.assign(fake.editor, { changeSeq: () => 1 })
    fake.changeListeners.forEach(listener => listener())
    await editorPage.save()
    Object.assign(fake.editor, { changeSeq: () => 2 })
    fake.changeListeners.forEach(listener => listener())
    editLease.acquire.mockResolvedValueOnce({ ...NEXT_LEASE, revision: 4, source: own })
    await editorPage.save()
    expect(save).toHaveBeenCalledTimes(4)
    // 第三次是用新的一代重发第二次（同一个请求），第四次换上新的基准、新的 requestId
    expect(save.mock.calls[2]?.[1]).toEqual(save.mock.calls[1]?.[1])
    expect(save.mock.calls[2]?.[3]).toEqual(NEXT_CREDENTIALS)
    expect(save.mock.calls[3]?.[1]).toMatchObject({ baseRevision: 4, localSeq: 2 })
    expect(save.mock.calls[3]?.[1].requestId).not.toBe(save.mock.calls[1]?.[1].requestId)
    expect(editorPage.view()).toMatchObject({ mode: { kind: 'editing' }, save: { status: 'clean', conflict: undefined } })
  })

  it('在途的保存其实已经提交，这时心跳得知编辑权中断（session）、续上认出了它；随后它自己的回包断网：不说保存失败，已保存到云端；再按保存以认出的那一版为基准（复验 C3）', async () => {
    const pending = deferred<SaveContentResponse>()
    const save = vi.fn<EditorPageApi['save']>().mockReturnValueOnce(pending.promise).mockResolvedValue({ revision: 5, savedAt: '2026-09-27T03:00:00.000Z', unchanged: false })
    const renew = vi.fn<EditLeaseApi['renew']>().mockRejectedValueOnce(leaseLost('session')).mockResolvedValue(RENEWED)
    const { editorPage, editLease, fake, time } = setup({ api: { save }, editLease: { renew } })
    await editorPage.load()
    Object.assign(fake.editor, { changeSeq: () => 1 })
    fake.changeListeners.forEach(listener => listener())
    const saving = editorPage.save()
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce())
    editLease.acquire.mockResolvedValueOnce({ ...NEXT_LEASE, revision: 4, source: { clientInstanceId: 'id-1', localSeq: 1 } })
    await time.advance(10_000)
    await vi.waitFor(() => expect(editLease.acquire).toHaveBeenCalledTimes(2))
    expect(editorPage.view()).toMatchObject({ mode: { kind: 'editing' }, save: { status: 'saving', unsaved: false } })
    pending.reject(new NetworkError('断网'))
    await saving
    expect(editorPage.view()).toMatchObject({ mode: { kind: 'editing' }, save: { status: 'clean', problem: undefined, unsaved: false } })
    expect(editorPage.hasUnsavedWork()).toBe(false)
    expect(save).toHaveBeenCalledOnce()
    await editorPage.save()
    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenLastCalledWith(DOCUMENT_ID, expect.objectContaining<Partial<SaveRequest>>({ baseRevision: 4 }), expect.anything(), NEXT_CREDENTIALS)
    expect(editorPage.view().save).toMatchObject({ status: 'clean' })
  })

  it('续上时比较的是服务端确认过的最新修订：本页保存过（修订号 4），申请得到 4 就续上，得到 5 就是别处保存过', async () => {
    const renew = vi.fn<EditLeaseApi['renew']>().mockRejectedValueOnce(leaseLost('stale')).mockResolvedValue(RENEWED)
    const { editorPage, editLease, time } = setup({ editLease: { renew } })
    await editorPage.load()
    await editorPage.save()
    editLease.acquire.mockResolvedValueOnce({ ...NEXT_LEASE, revision: 4 })
    await time.advance(10_000)
    expect(modeOf(editorPage)).toEqual({ kind: 'editing' })
    renew.mockRejectedValueOnce(leaseLost('stale'))
    editLease.acquire.mockResolvedValueOnce({ ...NEXT_LEASE, token: 'P'.repeat(43), revision: 5 })
    await time.advance(10_000)
    await settle()
    expect(modeOf(editorPage)).toMatchObject({ kind: 'lost', loss: { kind: 'newer' } })
  })

  it('续上时被占用：按失效处理，说明谁在编辑（最后活动按服务端的时间算）', async () => {
    const { editorPage, editLease, time } = setup({ editLease: { renew: vi.fn(async () => Promise.reject(leaseLost('replaced'))) } })
    await editorPage.load()
    editLease.acquire.mockRejectedValueOnce(heldBy(false, Date.UTC(2026, 8, 27, 3, 0, 0)))
    await time.advance(10_000)
    await settle()
    expect(editorPage.view()).toMatchObject({ mode: { kind: 'lost', loss: { kind: 'held', holder: { holder: AMY, sameUser: false, lastActiveMinutes: 5 } } }, save: undefined })
  })

  it.each(['idle', 'expired'])('人走开 12 分钟之后续租得知中断（%s；休眠、断网回来时服务端给的是到期）：不续上；本页再有键盘、鼠标操作时续上（审查 B8）', async (reason) => {
    // 服务端的说法：上报的空闲到了回收阈值就算中断
    const renew = vi.fn<EditLeaseApi['renew']>(async (_documentId, _token, idleSeconds) => idleSeconds >= EDIT_LEASE_IDLE_RECLAIM_SECONDS ? Promise.reject(leaseLost(reason)) : RENEWED)
    const { editorPage, editLease, time, activity, online } = setup({ editLease: { renew } })
    await editorPage.load()
    // 人走开之后断网：10 分钟时的空闲释放这一轮做不了（存不上、放不掉，M3-P5），编辑权留到服务端兜底回收
    online.set(false)
    await time.advance(EDIT_LEASE_IDLE_RECLAIM_SECONDS * 1000)
    await time.advance(300_000)
    expect(editLease.acquire).toHaveBeenCalledOnce()
    expect(editLease.release).not.toHaveBeenCalled()
    expect(modeOf(editorPage)).toEqual({ kind: 'editing' })
    const renewals = renew.mock.calls.length
    editLease.acquire.mockResolvedValueOnce(NEXT_LEASE)
    online.set(true)
    activity.fire()
    await vi.waitFor(() => expect(editLease.acquire).toHaveBeenCalledTimes(2))
    await time.advance(10_000)
    expect(renew).toHaveBeenCalledTimes(renewals + 1)
    expect(renew).toHaveBeenLastCalledWith(DOCUMENT_ID, NEXT_TOKEN, 10)
  })

  it('创建编辑器期间续租得知编辑权被收回：建好之后随即失去编辑权（捕获、以只读重建），不能保存', async () => {
    const creating = deferred<SheetEditor>()
    const { editorPage, fake, createEditor, time, api } = setup({ createEditor: async () => creating.promise, editLease: { renew: vi.fn(async () => Promise.reject(leaseLost('revoked'))) } })
    const loading = editorPage.load()
    await vi.waitFor(() => expect(createEditor).toHaveBeenCalled())
    await time.advance(10_000)
    creating.resolve(fake.editor)
    await loading
    await settle()
    expect(editorPage.view()).toMatchObject({ load: { kind: 'ready' }, mode: { kind: 'lost', loss: { kind: 'lease', reason: 'revoked' } }, save: undefined })
    expect(createEditor.mock.calls.map(call => call[0].access)).toEqual(['edit', 'read'])
    await editorPage.save()
    expect(api.save).not.toHaveBeenCalled()
  })

  it('创建编辑器期间续租得知中断（到期）：续上（比较的是载入的内容的修订号），建好之后照常保存，带新的编辑权', async () => {
    const creating = deferred<SheetEditor>()
    const { editorPage, api, fake, createEditor, editLease, time } = setup({ createEditor: async () => creating.promise, editLease: { renew: vi.fn<EditLeaseApi['renew']>().mockRejectedValueOnce(leaseLost('expired')).mockResolvedValue(RENEWED) } })
    const loading = editorPage.load()
    await vi.waitFor(() => expect(createEditor).toHaveBeenCalled())
    editLease.acquire.mockResolvedValueOnce(NEXT_LEASE)
    await time.advance(10_000)
    creating.resolve(fake.editor)
    await loading
    expect(editorPage.view()).toMatchObject({ mode: { kind: 'editing' }, save: { canSave: true } })
    await editorPage.save()
    expect(api.save).toHaveBeenLastCalledWith(DOCUMENT_ID, expect.anything(), expect.anything(), NEXT_CREDENTIALS)
  })

  it('会话不是本人时暂停续租、不续上；回到本人时立即续租一次，登录换过的租约得知失效（session）随即续上，接着保存', async () => {
    const { editorPage, api, editLease, fromOtherTab, time } = setup()
    await editorPage.load()
    vi.mocked(api.session).mockResolvedValueOnce(BOB)
    fromOtherTab()
    await vi.waitFor(() => expect(editorPage.view().session).toBe('other-user'))
    await time.advance(60_000)
    expect(editLease.renew).not.toHaveBeenCalled()
    expect(editLease.acquire).toHaveBeenCalledOnce()
    editLease.renew.mockRejectedValueOnce(leaseLost('session'))
    editLease.acquire.mockResolvedValueOnce(NEXT_LEASE)
    vi.mocked(api.session).mockResolvedValueOnce({ ...ALICE, csrfToken: 'csrf-again' })
    fromOtherTab()
    await vi.waitFor(() => expect(editLease.acquire).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(editorPage.view()).toMatchObject({ session: 'active', mode: { kind: 'editing' }, save: { canSave: true } }))
    await editorPage.save()
    expect(api.save).toHaveBeenLastCalledWith(DOCUMENT_ID, expect.anything(), expect.anything(), NEXT_CREDENTIALS)
  })

  it('申请期间别的标签页换了人：取得之后先暂停续租（不带着别人的登录续租）；原来的人回来时恢复（审查 B6）', async () => {
    const acquiring = deferred<AcquiredEditLease>()
    const { editorPage, api, editLease, fromOtherTab, time } = setup({ editLease: { acquire: vi.fn(async () => acquiring.promise) } })
    const loading = editorPage.load()
    await vi.waitFor(() => expect(editLease.acquire).toHaveBeenCalledOnce())
    vi.mocked(api.session).mockResolvedValueOnce(BOB)
    fromOtherTab()
    await vi.waitFor(() => expect(editorPage.view().session).toBe('other-user'))
    acquiring.resolve(ACQUIRED)
    await loading
    await time.advance(60_000)
    expect(editLease.renew).not.toHaveBeenCalled()
    vi.mocked(api.session).mockResolvedValueOnce(ALICE)
    fromOtherTab()
    await vi.waitFor(() => expect(editLease.renew).toHaveBeenCalledOnce())
    expect(editorPage.view()).toMatchObject({ session: 'active', mode: { kind: 'editing' }, save: { canSave: true } })
  })

  it('没有人登录时同样暂停；回到本人、租约仍然有效（同一个登录）：照常续租与保存', async () => {
    const { editorPage, api, editLease, fromOtherTab, time } = setup()
    await editorPage.load()
    vi.mocked(api.session).mockRejectedValueOnce(UNAUTHENTICATED)
    fromOtherTab()
    await vi.waitFor(() => expect(editorPage.view().session).toBe('signed-out'))
    await time.advance(30_000)
    expect(editLease.renew).not.toHaveBeenCalled()
    vi.mocked(api.session).mockResolvedValueOnce(ALICE)
    fromOtherTab()
    await vi.waitFor(() => expect(editLease.renew).toHaveBeenCalledOnce())
    expect(editorPage.view()).toMatchObject({ session: 'active', mode: { kind: 'editing' }, save: { canSave: true } })
    await time.advance(10_000)
    expect(editLease.renew).toHaveBeenCalledTimes(2)
  })

  it('按保存时等会话的确认连同编辑权的核对（与续上）有了结果：登录换过，续上之后用新的编辑权发保存', async () => {
    const save = vi.fn<EditorPageApi['save']>()
      .mockRejectedValueOnce(new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效'))
      .mockResolvedValueOnce({ revision: 4, savedAt: '2026-09-27T03:00:00.000Z', unchanged: false })
    const { editorPage, api, editLease } = setup({ api: { save } })
    await editorPage.load()
    const check = deferred<SessionResponse>()
    vi.mocked(api.session).mockReturnValueOnce(check.promise)
    editLease.renew.mockRejectedValueOnce(leaseLost('session'))
    editLease.acquire.mockResolvedValueOnce(NEXT_LEASE)
    await editorPage.save()
    const again = editorPage.save()
    check.resolve({ ...ALICE, csrfToken: 'csrf-new' })
    await again
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[1]?.[3]).toEqual(NEXT_CREDENTIALS)
    expect(editLease.renew).toHaveBeenCalledOnce()
    expect(editorPage.view()).toMatchObject({ session: 'active', mode: { kind: 'editing' }, save: { status: 'clean' } })
  })

  it('按保存时会话的确认要等编辑权的核对有了结果才算结束：恢复续租的回答回来之前不发保存；登录换过，续上之后用新的编辑权只发一次（审查 B6）', async () => {
    const { editorPage, api, editLease, fromOtherTab } = setup()
    await editorPage.load()
    vi.mocked(api.session).mockRejectedValueOnce(UNAUTHENTICATED)
    fromOtherTab()
    await vi.waitFor(() => expect(editorPage.view().session).toBe('signed-out'))
    // 本人在别处重新登录了（消息没收到）：按保存时先确认，是本人就恢复续租——续租的回答还没回来
    const renewal = deferred<RenewedEditLease>()
    editLease.renew.mockReturnValueOnce(renewal.promise)
    editLease.acquire.mockResolvedValueOnce(NEXT_LEASE)
    vi.mocked(api.session).mockResolvedValueOnce({ ...ALICE, csrfToken: 'csrf-again' })
    const saving = editorPage.save()
    await vi.waitFor(() => expect(editLease.renew).toHaveBeenCalledOnce())
    await settle()
    await settle()
    expect(api.save).not.toHaveBeenCalled()
    // 登录换过：租约随登录失效，续上之后才发保存
    renewal.reject(leaseLost('session'))
    await saving
    expect(api.save).toHaveBeenCalledOnce()
    expect(api.save).toHaveBeenLastCalledWith(DOCUMENT_ID, expect.anything(), expect.anything(), NEXT_CREDENTIALS)
  })

  it('续租得到未登录：向服务端确认会话（不显示"正在确认"），没有人登录就暂停续租', async () => {
    const { editorPage, api, editLease, time } = setup({ editLease: { renew: vi.fn(async () => Promise.reject(new ApiError(401, 'SESSION_EXPIRED', '已过期'))) } })
    await editorPage.load()
    vi.mocked(api.session).mockRejectedValueOnce(new ApiError(401, 'SESSION_EXPIRED', '已过期'))
    await time.advance(10_000)
    await vi.waitFor(() => expect(editorPage.view().session).toBe('signed-out'))
    expect(editorPage.view().confirmingSession).toBe(false)
    await time.advance(60_000)
    expect(editLease.renew).toHaveBeenCalledOnce()
  })

  it('续租得到 CSRF 失效、确认得知换了人：停止保存，不再续租', async () => {
    const { editorPage, api, editLease, time } = setup({ editLease: { renew: vi.fn(async () => Promise.reject(new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效'))) } })
    await editorPage.load()
    vi.mocked(api.session).mockResolvedValueOnce(BOB)
    await time.advance(10_000)
    await vi.waitFor(() => expect(editorPage.view().session).toBe('other-user'))
    expect(editorPage.view().save?.canSave).toBe(false)
    await time.advance(60_000)
    expect(editLease.renew).toHaveBeenCalledOnce()
  })

  it('页面隐藏、关闭（pagehide）：尽力释放编辑权，停止续租；之后卸载不再释放', async () => {
    const { editorPage, editLease, time } = setup()
    await editorPage.load()
    window.dispatchEvent(new Event('pagehide'))
    expect(editLease.release).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, TOKEN)
    await time.advance(60_000)
    expect(editLease.renew).not.toHaveBeenCalled()
    editorPage.dispose()
    expect(editLease.release).toHaveBeenCalledOnce()
  })

  it('卸载：尽力释放编辑权，停止计时器与监听', async () => {
    const { editorPage, editLease, time } = setup()
    await editorPage.load()
    editorPage.dispose()
    expect(editLease.release).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, TOKEN)
    expect(time.pending()).toBe(0)
    window.dispatchEvent(new Event('pagehide'))
    expect(editLease.release).toHaveBeenCalledOnce()
  })

  it('载入期间页面卸载了（编辑权已经取得，编辑器还在创建）：随即释放；创建出的编辑器立即销毁', async () => {
    const creating = deferred<SheetEditor>()
    const { editorPage, fake, editLease, createEditor } = setup({ createEditor: async () => creating.promise })
    const loading = editorPage.load()
    await vi.waitFor(() => expect(createEditor).toHaveBeenCalled())
    editorPage.dispose()
    expect(editLease.release).toHaveBeenCalledOnce()
    creating.resolve(fake.editor)
    await loading
    expect(fake.editor.dispose).toHaveBeenCalledOnce()
    expect(editLease.release).toHaveBeenCalledOnce()
  })

  it('申请期间页面卸载了：取得之后随即释放，不创建编辑器', async () => {
    const acquiring = deferred<AcquiredEditLease>()
    const { editorPage, editLease, createEditor } = setup({ editLease: { acquire: vi.fn(async () => acquiring.promise) } })
    const loading = editorPage.load()
    await vi.waitFor(() => expect(editLease.acquire).toHaveBeenCalled())
    editorPage.dispose()
    acquiring.resolve(ACQUIRED)
    await loading
    expect(editLease.release).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, TOKEN)
    expect(createEditor).not.toHaveBeenCalled()
  })

  it('编辑器加载失败：释放已经取得的编辑权', async () => {
    const { editorPage, editLease, time } = setup({ createEditor: async () => Promise.reject(new Error('就绪超时')) })
    await editorPage.load()
    expect(editorPage.view()).toMatchObject({ load: { kind: 'editor-failed' }, save: undefined })
    expect(editLease.release).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, TOKEN)
    expect(time.pending()).toBe(0)
  })
})

describe('阅读与编辑的切换（M3-P2 设计 §3.1、§3.4）', () => {
  /** 在容器里的一个元素上派发一次键入：返回是否被交互屏障拦下 */
  function blocked(surface: HTMLElement): boolean {
    const inner = document.createElement('div')
    surface.append(inner)
    const event = new Event('keydown', { bubbles: true, cancelable: true })
    inner.dispatchEvent(event)
    inner.remove()
    return event.defaultPrevented
  }

  afterEach(() => {
    document.body.replaceChildren()
  })

  it('进入编辑：申请与新建编辑器期间挂着交互屏障（容器的状态是 loading），以可编辑重建之后撤掉', async () => {
    const acquiring = deferred<AcquiredEditLease>()
    const { editorPage, surface, chrome, createEditor } = setup({ editIntent: false, editLease: { acquire: vi.fn(async () => acquiring.promise) } })
    document.body.append(chrome, surface)
    await editorPage.load()
    expect(blocked(surface)).toBe(false)
    const entering = editorPage.enterEditing()
    expect(modeOf(editorPage)).toEqual({ kind: 'entering' })
    expect(surface.dataset.editorState).toBe('loading')
    expect(blocked(surface)).toBe(true)
    acquiring.resolve(ACQUIRED)
    await entering
    expect(createEditor.mock.calls.map(call => call[0].access)).toEqual(['read', 'edit'])
    expect(editorPage.view()).toMatchObject({ mode: { kind: 'editing' }, save: { status: 'clean' } })
    expect(surface.dataset.editorState).toBe('ready')
    expect(blocked(surface)).toBe(false)
  })

  it('退出编辑的过程中（保存、等释放）挂着交互屏障：可编辑的编辑器还在，保存之后、捕获之前的键入进不去（退出在捕获之后不再核对修改序号，审查 A5）', async () => {
    const releasing = deferred<undefined>()
    const { editorPage, surface, chrome, editLease } = setup({ editLease: { release: vi.fn(async () => releasing.promise) } })
    document.body.append(chrome, surface)
    await editorPage.load()
    expect(blocked(surface)).toBe(false)
    const exiting = editorPage.exitEditing()
    await vi.waitFor(() => expect(editLease.release).toHaveBeenCalled())
    expect(modeOf(editorPage)).toEqual({ kind: 'exiting', cause: 'exit' })
    expect(editorPage.view().surface).toBe('loading')
    expect(blocked(surface)).toBe(true)
    releasing.resolve(undefined)
    await exiting
    expect(modeOf(editorPage)).toMatchObject({ kind: 'reading' })
    expect(blocked(surface)).toBe(false)
  })

  it('失去编辑权的过程中（等在途的保存，可编辑的编辑器还在）挂着交互屏障；有了结果、以只读重建之后撤掉', async () => {
    const reply = deferred<SaveContentResponse>()
    const { editorPage, surface, chrome, fake, api, time } = setup({ api: { save: vi.fn(async () => reply.promise) }, editLease: { renew: vi.fn(async () => Promise.reject(new ApiError(403, 'PERMISSION_DENIED', '只能查看'))) } })
    document.body.append(chrome, surface)
    await editorPage.load()
    Object.assign(fake.editor, { changeSeq: () => 1 })
    fake.changeListeners.forEach(listener => listener())
    const saving = editorPage.save()
    await vi.waitFor(() => expect(api.save).toHaveBeenCalled())
    await time.advance(10_000)
    expect(modeOf(editorPage)).toMatchObject({ kind: 'losing' })
    expect(blocked(surface)).toBe(true)
    reply.resolve({ revision: 4, savedAt: '2026-09-27T03:00:00.000Z', unchanged: false })
    await saving
    await settle()
    expect(modeOf(editorPage)).toMatchObject({ kind: 'lost', unsaved: false })
    expect(blocked(surface)).toBe(false)
  })

  it('失去编辑权之后以只读重建失败（审查 A3）：页面照常（页头、说明与副本），容器按 failed 隐藏、撤掉屏障——不是整页的"编辑器加载失败"', async () => {
    let calls = 0
    const fake = fakeEditor()
    const { editorPage, surface, chrome, time } = setup({
      createEditor: async () => {
        calls += 1
        if (calls > 1)
          throw new Error('Worker 起不来')
        return fake.editor
      },
      editLease: { renew: vi.fn(async () => Promise.reject(new ApiError(403, 'PERMISSION_DENIED', '只能查看'))) },
    })
    document.body.append(chrome, surface)
    await editorPage.load()
    Object.assign(fake.editor, { changeSeq: () => 1 })
    fake.changeListeners.forEach(listener => listener())
    await time.advance(10_000)
    await settle()
    expect(editorPage.view()).toMatchObject({ load: { kind: 'ready' }, mode: { kind: 'lost', reopenFailed: true, unsaved: true }, surface: 'failed' })
    expect(surface.hidden).toBe(true)
    expect(blocked(surface)).toBe(false)
    expect(editorPage.hasUnsavedWork()).toBe(true)
  })

  it('失去编辑权之后另存为副本、按最新的内容重建又失败（复验 C1）：页面照常——说明已另存为副本、可以重新加载，不是整页的"编辑器加载失败"；容器按 failed 隐藏、撤掉屏障', async () => {
    let calls = 0
    const fake = fakeEditor()
    const { editorPage, surface, chrome, time, api } = setup({
      createEditor: async () => {
        calls += 1
        if (calls > 1)
          throw new Error('Worker 起不来')
        return fake.editor
      },
      editLease: { renew: vi.fn(async () => Promise.reject(new ApiError(403, 'PERMISSION_DENIED', '只能查看'))) },
    })
    document.body.append(chrome, surface)
    await editorPage.load()
    Object.assign(fake.editor, { changeSeq: () => 1 })
    fake.changeListeners.forEach(listener => listener())
    await time.advance(10_000)
    await settle()
    await editorPage.saveCopy()
    expect(api.conflictCopy).toHaveBeenCalledOnce()
    expect(editorPage.view()).toMatchObject({
      load: { kind: 'ready' },
      mode: { kind: 'lost', reopenFailed: true, copy: { kind: 'done', document: { id: COPY_ID } }, reload: { kind: 'failed' } },
      surface: 'failed',
    })
    expect(surface.hidden).toBe(true)
    expect(blocked(surface)).toBe(false)
    expect(editorPage.hasUnsavedWork()).toBe(false)
  })

  it('会话不是本人时点"编辑"：先向服务端确认，还是别人就不申请、留在阅读（审查 A10）；确认是本人了（消息没送到）就照常进入', async () => {
    const { editorPage, api, editLease, fromOtherTab } = setup({ editIntent: false })
    await editorPage.load()
    vi.mocked(api.session).mockResolvedValueOnce(BOB)
    fromOtherTab()
    await vi.waitFor(() => expect(editorPage.view().session).toBe('other-user'))
    vi.mocked(api.session).mockResolvedValueOnce(BOB)
    await editorPage.enterEditing()
    expect(api.session).toHaveBeenCalledTimes(3)
    expect(editLease.acquire).not.toHaveBeenCalled()
    expect(modeOf(editorPage)).toMatchObject({ kind: 'reading', notice: undefined })
    await editorPage.enterEditing()
    expect(api.session).toHaveBeenCalledTimes(4)
    expect(editLease.acquire).toHaveBeenCalledOnce()
    expect(modeOf(editorPage)).toEqual({ kind: 'editing' })
  })

  it('上一次确认会话失败（断网）时点"编辑"：先向服务端确认，确认期间仍在阅读、confirmingSession 为真（页头说正在确认登录状态，"编辑"不可用，复验 C8）；确认是本人之后清掉、随即进入编辑', async () => {
    const { editorPage, api, editLease, fromOtherTab } = setup({ editIntent: false })
    await editorPage.load()
    vi.mocked(api.session).mockRejectedValueOnce(new NetworkError('断网'))
    fromOtherTab()
    await vi.waitFor(() => expect(editorPage.view().sessionProblem).toBeInstanceOf(NetworkError))
    expect(editorPage.view()).toMatchObject({ session: 'active', confirmingSession: false })
    const answer = deferred<SessionResponse>()
    vi.mocked(api.session).mockImplementationOnce(async () => answer.promise)
    const entering = editorPage.enterEditing()
    await settle()
    expect(editorPage.view()).toMatchObject({ mode: { kind: 'reading' }, confirmingSession: true })
    expect(editLease.acquire).not.toHaveBeenCalled()
    answer.resolve(ALICE)
    await entering
    expect(editorPage.view()).toMatchObject({ mode: { kind: 'editing' }, confirmingSession: false, sessionProblem: undefined })
    expect(editLease.acquire).toHaveBeenCalledOnce()
  })

  it('会话是本人、没有在途的确认：点"编辑"在点下去的这一刻就进入"正在进入编辑"（不先确认会话）', async () => {
    const acquiring = deferred<AcquiredEditLease>()
    const { editorPage, api } = setup({ editIntent: false, editLease: { acquire: vi.fn(async () => acquiring.promise) } })
    await editorPage.load()
    const entering = editorPage.enterEditing()
    expect(modeOf(editorPage)).toEqual({ kind: 'entering' })
    expect(api.session).toHaveBeenCalledOnce()
    acquiring.resolve(ACQUIRED)
    await entering
  })

  it('退出编辑：会话是本人时先保存、释放、以只读重建，回到阅读', async () => {
    const { editorPage, fake, api, editLease, createEditor } = setup()
    await editorPage.load()
    Object.assign(fake.editor, { changeSeq: () => 1 })
    fake.changeListeners.forEach(listener => listener())
    await editorPage.exitEditing()
    expect(api.save).toHaveBeenCalledOnce()
    expect(editLease.release).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, TOKEN)
    expect(createEditor.mock.calls.map(call => call[0].access)).toEqual(['edit', 'read'])
    expect(editorPage.view()).toMatchObject({ mode: { kind: 'reading', canEdit: true }, save: undefined })
  })

  it('退出编辑时会话不是本人（换了人）：先向服务端确认，还是别人就不保存、不退出（留在编辑，修改留着）', async () => {
    const { editorPage, api, editLease, fromOtherTab } = setup()
    await editorPage.load()
    vi.mocked(api.session).mockResolvedValueOnce(BOB)
    fromOtherTab()
    await vi.waitFor(() => expect(editorPage.view().session).toBe('other-user'))
    vi.mocked(api.session).mockResolvedValueOnce(BOB)
    await editorPage.exitEditing()
    expect(api.save).not.toHaveBeenCalled()
    expect(editLease.release).not.toHaveBeenCalled()
    expect(modeOf(editorPage)).toEqual({ kind: 'editing' })
  })

  it('重建失败（退出编辑时以只读重建出错）：按编辑器加载失败说明，容器隐藏', async () => {
    let calls = 0
    const fake = fakeEditor()
    const { editorPage, surface } = setup({ createEditor: async () => {
      calls += 1
      if (calls > 1)
        throw new Error('Worker 起不来')
      return fake.editor
    } })
    await editorPage.load()
    await editorPage.exitEditing()
    expect(editorPage.view().load).toMatchObject({ kind: 'editor-failed' })
    expect(surface.dataset.editorState).toBe('failed')
    expect(surface.hidden).toBe(true)
  })

  it('失去编辑权之后另存为副本：上传本页的内容，成功之后按最新的内容回到阅读，说明已另存为副本', async () => {
    const { editorPage, fake, api, time } = setup({ editLease: { renew: vi.fn(async () => Promise.reject(new ApiError(403, 'PERMISSION_DENIED', '只能查看'))) } })
    await editorPage.load()
    Object.assign(fake.editor, { changeSeq: () => 1 })
    fake.changeListeners.forEach(listener => listener())
    await time.advance(10_000)
    await settle()
    expect(modeOf(editorPage)).toMatchObject({ kind: 'lost', unsaved: true, readable: true })
    await editorPage.saveCopy()
    expect(api.conflictCopy).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, { requestId: expect.stringMatching(/^id-\d+$/) as unknown, title: '周报（冲突副本 2026-10-04 15:30）', formulasPending: false }, expect.anything())
    expect(modeOf(editorPage)).toMatchObject({ kind: 'reading', notice: { kind: 'copied', document: { id: COPY_ID } } })
  })

  it('失去编辑权之后放弃、文档已经读不到了（404）：显示内容不存在', async () => {
    const { editorPage, fake, api, time } = setup({ editLease: { renew: vi.fn(async () => Promise.reject(new ApiError(403, 'PERMISSION_DENIED', '只能查看'))) } })
    await editorPage.load()
    Object.assign(fake.editor, { changeSeq: () => 1 })
    fake.changeListeners.forEach(listener => listener())
    await time.advance(10_000)
    await settle()
    vi.mocked(api.content).mockRejectedValueOnce(new ApiError(404, 'NOT_FOUND', '不存在'))
    await editorPage.discard()
    expect(editorPage.view().load).toEqual({ kind: 'not-found' })
  })

  it('有更新，点击刷新：交给阅读与编辑的状态机（条件读取、重建为阅读）', async () => {
    const { editorPage, api, createEditor } = setup({ editIntent: false, api: {
      editStatus: async () => ({ status: { revision: 5, editor: null, canEdit: true, canTakeOver: false, formulasPending: false, request: null, reservation: null, interruption: null }, serverTime: undefined }),
      contentIfChanged: async () => ({ snapshot: '{"id":"unit-1","v":5}', revision: 5 }),
    } })
    await editorPage.load()
    await settle()
    expect(modeOf(editorPage)).toMatchObject({ kind: 'reading', update: 'available' })
    await editorPage.refreshUpdate()
    expect(api.contentIfChanged).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, 3)
    expect(createEditor.mock.calls.map(call => [call[0].access, call[0].snapshot])).toEqual([['read', '{"id":"unit-1"}'], ['read', '{"id":"unit-1","v":5}']])
    expect(modeOf(editorPage)).toMatchObject({ kind: 'reading', update: 'none' })
  })
})

describe('自动保存要的页面信号（M3-P4 设计 §3.10）', () => {
  /** 本页的修改：假的编辑器的修改序号前进一处，通知订阅者 */
  function edit(fake: ReturnType<typeof fakeEditor>, seq: number): void {
    Object.assign(fake.editor, { changeSeq: () => seq })
    fake.changeListeners.forEach(listener => listener())
  }

  it('编辑时页面的视图带自动保存这一侧的状态；联网与否随 online、offline 变（离线时不上传，恢复时立即上传）', async () => {
    const { editorPage, fake, api, online, autosave, time } = setup()
    await editorPage.load()
    autosave.release()
    expect(editorPage.view().autosave).toEqual({ offline: false, paused: false, retrying: false, held: false })
    online.set(false)
    expect(editorPage.view().autosave?.offline).toBe(true)
    edit(fake, 1)
    await time.advance(20_000)
    expect(api.save).not.toHaveBeenCalled()
    online.set(true)
    await time.advance(0)
    await vi.waitFor(() => expect(api.save).toHaveBeenCalledOnce())
    expect(editorPage.view().autosave?.offline).toBe(false)
  })

  it('切到后台：在 visibilitychange 的同步段里就捕获并发出上传（不靠计时器，暂停定时的上传时也照常）', async () => {
    const { editorPage, fake, api, hidden } = setup()
    await editorPage.load()
    edit(fake, 1)
    hidden.set(true)
    await vi.waitFor(() => expect(api.save).toHaveBeenCalledOnce())
  })

  it('会话不是本人、令牌已知失效、会话的确认在途：暂停（不发）；确认是本人之后恢复', async () => {
    const { editorPage, api, fromOtherTab } = setup()
    await editorPage.load()
    const check = deferred<SessionResponse>()
    vi.mocked(api.session).mockReturnValueOnce(check.promise)
    fromOtherTab()
    expect(editorPage.view().autosave?.paused).toBe(true)
    check.resolve(ALICE)
    await vi.waitFor(() => expect(editorPage.view().autosave?.paused).toBe(false))
    vi.mocked(api.session).mockResolvedValueOnce(BOB)
    fromOtherTab()
    await vi.waitFor(() => expect(editorPage.view().session).toBe('other-user'))
    expect(editorPage.view().autosave?.paused).toBe(true)
  })

  it('保存得到令牌失效：已知失效期间暂停，确认（换上新的令牌）之后恢复', async () => {
    const save = vi.fn<EditorPageApi['save']>(async () => Promise.reject(new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效')))
    const { editorPage, api } = setup({ api: { save } })
    await editorPage.load()
    const check = deferred<SessionResponse>()
    vi.mocked(api.session).mockReturnValueOnce(check.promise)
    await editorPage.save()
    expect(editorPage.view().autosave?.paused).toBe(true)
    check.resolve(ALICE)
    await vi.waitFor(() => expect(editorPage.view().autosave?.paused).toBe(false))
  })

  it('pagehide 时有保存在途：不释放编辑权（让租约到期，免得那次保存被拒）；没有在途的保存时照旧释放', async () => {
    const pending = deferred<SaveContentResponse>()
    const save = vi.fn<EditorPageApi['save']>(async () => pending.promise)
    const { editorPage, editLease } = setup({ api: { save } })
    await editorPage.load()
    const saving = editorPage.save()
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce())
    window.dispatchEvent(new Event('pagehide'))
    expect(editLease.release).not.toHaveBeenCalled()
    pending.resolve({ revision: 4, savedAt: '2026-09-27T03:00:00.000Z', unchanged: false })
    await saving
    window.dispatchEvent(new Event('pagehide'))
    expect(editLease.release).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, TOKEN)
  })

  it('新建编辑器时交上容器与页面自己的界面（页头）：组合输入与面板防抖的输入在页头里的不算', async () => {
    const { editorPage, createEditor, surface, chrome } = setup()
    await editorPage.load()
    expect(createEditor).toHaveBeenCalledWith(expect.objectContaining({ container: surface, pageUi: chrome, access: 'edit' }))
  })

  it('测试构建的控制拿到当前的调度：进入编辑时交来，退出编辑之后交回 undefined', async () => {
    const { editorPage, autosave } = setup()
    await editorPage.load()
    expect(typeof autosave.current()?.flush).toBe('function')
    await editorPage.exitEditing()
    expect(autosave.current()).toBeUndefined()
  })
})

describe('阅读页的"公式待更新"与详情的刷新（M3-P4 设计 §3.5 第 4 条，DEF-045）', () => {
  it('载入时详情带着标记、与载入的内容是同一版：阅读里带着它', async () => {
    const { editorPage } = setup({ editIntent: false, api: { document: async () => ({ ...DETAIL, formulasPending: true }), editStatus: async () => ({ status: { revision: 3, editor: null, canEdit: true, canTakeOver: false, formulasPending: true, request: null, reservation: null, interruption: null }, serverTime: undefined }) } })
    await editorPage.load()
    expect(modeOf(editorPage)).toMatchObject({ kind: 'reading', formulasPending: true })
  })

  it('详情与载入的内容不是同一版（并行读取之间有人保存过）：不套用', async () => {
    const { editorPage } = setup({ editIntent: false, api: { document: async () => ({ ...DETAIL, revision: 4, formulasPending: true }) } })
    await editorPage.load()
    expect(modeOf(editorPage)).toMatchObject({ kind: 'reading', formulasPending: false })
  })

  it('重新取文档详情的过程中：detailRefreshing 为真，有了结果（成功或失败）之后为假', async () => {
    const fetching = deferred<DocumentDetail>()
    const document = vi.fn<EditorPageApi['document']>(async () => DETAIL)
    const { editorPage } = setup({ api: { document } })
    await editorPage.load()
    expect(editorPage.view().detailRefreshing).toBe(false)
    document.mockReturnValueOnce(fetching.promise)
    const refreshing = editorPage.refreshDetail()
    expect(editorPage.view().detailRefreshing).toBe(true)
    fetching.reject(new ApiError(503, 'SERVICE_UNAVAILABLE', '繁忙'))
    await refreshing
    expect(editorPage.view().detailRefreshing).toBe(false)
    expect(editorPage.view().detailProblem).toBeInstanceOf(ApiError)
  })
})

describe('交接规则的页面接线（M3-P5 设计 §3.1、§3.7、§3.9）', () => {
  /** 在容器里的一个元素上派发一次键入：返回是否被交互屏障拦下 */
  function blocked(surface: HTMLElement): boolean {
    const inner = document.createElement('div')
    surface.append(inner)
    const event = new Event('keydown', { bubbles: true, cancelable: true })
    inner.dispatchEvent(event)
    inner.remove()
    return event.defaultPrevented
  }

  afterEach(() => {
    document.body.replaceChildren()
  })

  const IDLE_MS = EDIT_IDLE_RELEASE_SECONDS * 1000

  it('进入编辑之后持有这份文档的本机锁；退出编辑之后放下；卸载时关掉这份文档的交接频道', async () => {
    const { editorPage, browser, sameBrowsers } = setup()
    await editorPage.load()
    expect(modeOf(editorPage)?.kind).toBe('editing')
    expect(browser.holderOf(lockNameOf(DOCUMENT_ID))).toBe('page')
    await editorPage.exitEditing()
    await settle()
    expect(browser.holderOf(lockNameOf(DOCUMENT_ID))).toBeUndefined()
    expect(sameBrowsers).toHaveLength(1)
    editorPage.dispose()
    expect(sameBrowsers[0]?.close).toHaveBeenCalledOnce()
  })

  it('本浏览器的另一个标签页抢走了锁：本页立即失去编辑权（不等心跳），说明是本人在本浏览器的另一个标签页接手', async () => {
    const { editorPage, browser, editLease } = setup()
    await editorPage.load()
    await sameBrowserFor(DOCUMENT_ID, browser.tab('other')).steal()
    await vi.waitFor(() => expect(modeOf(editorPage)).toMatchObject({ kind: 'lost', loss: { kind: 'taken-over', where: 'this-browser' } }))
    expect(editLease.renew).not.toHaveBeenCalled()
    expect(editLease.release).not.toHaveBeenCalled()
  })

  it('空闲满 10 分钟：先挂交互屏障再保存（等面板时已经拦着），不向服务端确认会话（按"不必先确认就能写"），释放、回到阅读并说明', async () => {
    const { editorPage, surface, chrome, fake, api, editLease, time } = setup()
    document.body.append(chrome, surface)
    await editorPage.load()
    expect(blocked(surface)).toBe(false)
    const sessionChecks = api.session.mock.calls.length
    const barrierAtSettle: boolean[] = []
    Object.assign(fake.editor, {
      settlePanels: async () => {
        barrierAtSettle.push(blocked(surface))
      },
    })
    await time.advance(IDLE_MS)
    await vi.waitFor(() => expect(modeOf(editorPage)).toMatchObject({ kind: 'reading', notice: { kind: 'idle-released' } }))
    expect(barrierAtSettle).toEqual([true])
    expect(editLease.release).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, TOKEN)
    expect(api.session).toHaveBeenCalledTimes(sessionChecks)
    expect(blocked(surface)).toBe(false)
  })

  it('有操作就推后：本页的操作（注入的来源）让空闲从那一刻重新算', async () => {
    const { editorPage, time, activity } = setup()
    await editorPage.load()
    await time.advance(IDLE_MS - 60_000)
    activity.fire()
    await time.advance(IDLE_MS - 1)
    expect(modeOf(editorPage)?.kind).toBe('editing')
    await time.advance(1)
    await vi.waitFor(() => expect(modeOf(editorPage)).toMatchObject({ kind: 'reading', notice: { kind: 'idle-released' } }))
  })

  it('确认会话进行中（"不必先确认就能写"为假）：这一轮不释放、不发确认，过一个心跳周期再看', async () => {
    const check = deferred<SessionResponse>()
    const { editorPage, api, time, fromOtherTab, editLease } = setup()
    await editorPage.load()
    api.session.mockImplementationOnce(async () => check.promise)
    fromOtherTab()
    await time.advance(IDLE_MS)
    expect(modeOf(editorPage)?.kind).toBe('editing')
    expect(editLease.release).not.toHaveBeenCalled()
    check.resolve(ALICE)
    await settle()
    await time.advance(10_000)
    await vi.waitFor(() => expect(modeOf(editorPage)).toMatchObject({ kind: 'reading', notice: { kind: 'idle-released' } }))
  })

  /** 本页的标识与 requestId 按 UUID 的写法（交接频道的消息按契约解析） */
  function uuids(): () => string {
    let next = 0
    return () => `0199a2c4-1f2e-7a3b-8c4d-${String(++next).padStart(12, '0')}`
  }

  it('"在此编辑"（M3-P5 设计 §3.7）：与"编辑"同一个会话确认——会话不是本人时先向服务端确认，还是别人就不申请；确认是本人之后以本人接管申请（锁空着：不发交接请求）', async () => {
    const self = { holder: ALICE.user, lastActiveAt: '2026-09-27T03:00:00.000Z', sameUser: true, sameSession: false }
    const { editorPage, api, editLease, fromOtherTab, browser } = setup({ editIntent: false, newId: uuids(), api: { editStatus: async () => ({ status: { revision: 3, editor: self, canEdit: true, canTakeOver: false, formulasPending: false, request: null, reservation: null, interruption: null }, serverTime: undefined }) } })
    await editorPage.load()
    await vi.waitFor(() => expect(modeOf(editorPage)).toMatchObject({ kind: 'reading', holder: { sameUser: true }, selfHolder: 'elsewhere' }))
    vi.mocked(api.session).mockResolvedValueOnce(BOB)
    fromOtherTab()
    await vi.waitFor(() => expect(editorPage.view().session).toBe('other-user'))
    vi.mocked(api.session).mockResolvedValueOnce(BOB)
    await editorPage.takeOverHere()
    expect(editLease.acquire).not.toHaveBeenCalled()
    await editorPage.takeOverHere()
    expect(editLease.acquire).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, '0199a2c4-1f2e-7a3b-8c4d-000000000001', { takeover: 'self' })
    expect(modeOf(editorPage)).toEqual({ kind: 'editing' })
    expect(browser.posted(`nerve-office:doc:${DOCUMENT_ID}`)).toEqual([])
  })

  it('交接请求只理会载入时确认的用户的（同一个浏览器里本来就同一个人，另一个账户的不理）：本人的请求回 ack、先保存再交出、发 done，回到阅读并说明', async () => {
    const { editorPage, browser } = setup({ newId: uuids() })
    await editorPage.load()
    expect(modeOf(editorPage)?.kind).toBe('editing')
    const other = sameBrowserFor(DOCUMENT_ID, browser.tab('other'))
    const replies: string[] = []
    other.subscribe(message => replies.push(message.type))
    other.post({ type: 'handover-request', requestId: '0199a2c4-1f2e-7a3b-8c4d-0000000000f1', documentId: DOCUMENT_ID, from: '0199a2c4-1f2e-7a3b-8c4d-00000000bbbb', userId: BOB.user.id })
    await settle()
    expect(replies).toEqual([])
    expect(modeOf(editorPage)?.kind).toBe('editing')
    other.post({ type: 'handover-request', requestId: '0199a2c4-1f2e-7a3b-8c4d-0000000000f2', documentId: DOCUMENT_ID, from: '0199a2c4-1f2e-7a3b-8c4d-00000000bbbb', userId: ALICE.user.id })
    await vi.waitFor(() => expect(replies).toEqual(['handover-ack', 'handover-done']))
    await vi.waitFor(() => expect(modeOf(editorPage)).toMatchObject({ kind: 'reading', notice: { kind: 'handed-over-tab' } }))
    expect(browser.holderOf(lockNameOf(DOCUMENT_ID))).toBeUndefined()
  })

  it('页面关闭（pagehide）：放下本机锁；有保存在途时不释放编辑权、在 localStorage 记下记号，没有在途的不记', async () => {
    const pending = deferred<SaveContentResponse>()
    const save = vi.fn<EditorPageApi['save']>(async () => pending.promise)
    const { editorPage, editLease, browser, storage } = setup({ api: { save } })
    await editorPage.load()
    const saving = editorPage.save()
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce())
    window.dispatchEvent(new Event('pagehide'))
    await settle()
    expect(browser.holderOf(lockNameOf(DOCUMENT_ID))).toBeUndefined()
    expect(editLease.release).not.toHaveBeenCalled()
    expect(JSON.parse(storage.items.get(keyOf(DOCUMENT_ID)) ?? 'null')).toEqual({ v: 1, at: Date.UTC(2026, 9, 7, 3, 0, 0), revision: 3 })
    pending.resolve({ revision: 4, savedAt: '2026-09-27T03:00:00.000Z', unchanged: false })
    await saving
    storage.items.clear()
    window.dispatchEvent(new Event('pagehide'))
    expect(editLease.release).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, TOKEN)
    expect(storage.items.size).toBe(0)
  })
})
