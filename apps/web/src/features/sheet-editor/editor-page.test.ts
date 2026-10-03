import type { AcquiredEditLease, DocumentDetail, RenewedEditLease, SaveContentResponse, SessionResponse } from '@nerve-office/contracts'
import type { CreateSheetEditorOptions, SheetEditor, SheetEditorLifecycle } from '../../editor/index.ts'
import type { PageLocation } from '../../shared/lib/page-location.ts'
import type { SessionChannel } from '../../shared/lib/session-channel.ts'
import type { EditLeaseApi } from './edit-lease.ts'
import type { EditorPageApi } from './editor-page.ts'
import type { SaveRequest } from './save-coordinator.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, NetworkError, setCsrfToken } from '../../shared/api/index.ts'
import { createEditorPage } from './editor-page.ts'
import { fakeLeaseClock } from './fake-lease-clock.test-support.ts'

const DOCUMENT_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'

const ALICE: SessionResponse = {
  user: { id: '0199a2c4-1f2e-7a3b-8c4d-00000000000a', username: 'alice', displayName: '爱丽丝', systemRole: 'member' },
  personalSpace: { id: '0199a2c4-2a3b-7c4d-9e5f-00000000000a', name: '爱丽丝' },
  csrfToken: 'csrf-alice',
}
const BOB: SessionResponse = { ...ALICE, user: { ...ALICE.user, id: '0199a2c4-1f2e-7a3b-8c4d-00000000000b', username: 'bob' }, csrfToken: 'csrf-bob' }

/** 申请到的编辑租约：修订号与载入的内容相同（3） */
const TOKEN = 'L'.repeat(43)
const ACQUIRED: AcquiredEditLease = { token: TOKEN, writeEpoch: 7, revision: 3, expiresAt: '2026-09-27T03:01:30.000Z', interruption: null }
const RENEWED: RenewedEditLease = { expiresAt: '2026-09-27T03:01:40.000Z' }
/** 保存带上的编辑租约 */
const CREDENTIALS = { token: TOKEN, writeEpoch: 7 }

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
  permissions: { canEdit: true, canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: false, canCopy: true, canDelete: true, canShare: false },
}

/** 假的编辑器：生命周期可以推进，保存用到的能力都是最简单的实现；记下谁在订阅修改 */
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
    capture: () => '{"id":"unit-1"}',
    dispose: vi.fn(),
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

interface Setup {
  readonly documentId?: string | undefined
  readonly api?: Partial<Omit<EditorPageApi, 'editLease'>>
  readonly editLease?: Partial<EditLeaseApi>
  readonly createEditor?: (options: CreateSheetEditorOptions) => Promise<SheetEditor>
}

/** 这个用例建过的页面：用例结束时卸载，留下的交互屏障与窗口上的监听不影响下一个用例 */
const pages: { dispose: () => void }[] = []

function setup(options: Setup = {}) {
  const surface = document.createElement('div')
  const chrome = document.createElement('header')
  const fake = fakeEditor()
  const page: PageLocation & { visits: string[] } = { visits: [], assign: vi.fn(), replace: url => page.visits.push(url), reload: vi.fn() }
  const { channel, fromOtherTab, listeners } = fakeChannel()
  const time = fakeLeaseClock()
  const editLease = {
    acquire: vi.fn(options.editLease?.acquire ?? (async (): Promise<AcquiredEditLease> => ACQUIRED)),
    renew: vi.fn(options.editLease?.renew ?? (async (): Promise<RenewedEditLease> => RENEWED)),
    release: vi.fn(options.editLease?.release ?? ((): void => {})),
  }
  const api = {
    session: vi.fn(async () => ALICE),
    document: vi.fn(async () => DETAIL),
    content: vi.fn(async () => ({ snapshot: '{"id":"unit-1"}', revision: 3 })),
    compress: vi.fn(async (snapshot: string) => new TextEncoder().encode(snapshot)),
    save: vi.fn(async (): Promise<SaveContentResponse> => ({ revision: 4, savedAt: '2026-09-27T03:00:00.000Z' })),
    ...options.api,
    editLease,
  } satisfies EditorPageApi
  const createEditor = vi.fn(options.createEditor ?? (async () => fake.editor))
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
    currentPath: () => `/documents/${DOCUMENT_ID}`,
    newId: () => `id-${++id}`,
    reportError: vi.fn(),
  })
  pages.push(editorPage)
  return { editorPage, surface, chrome, fake, page, api, editLease, time, createEditor, fromOtherTab, listeners }
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
  it('先确认会话，再读取元数据与内容，以可编辑创建编辑器；就绪之后可以保存，基准是内容的修订号', async () => {
    const { editorPage, surface, api, createEditor, fake } = setup()
    expect(surface.dataset.editorState).toBeUndefined()
    const loading = editorPage.load()
    expect(surface.dataset.editorState).toBe('loading')
    await loading
    expect(api.session).toHaveBeenCalledOnce()
    expect(api.document).toHaveBeenCalledWith(DOCUMENT_ID)
    expect(api.content).toHaveBeenCalledWith(DOCUMENT_ID)
    expect(createEditor).toHaveBeenCalledExactlyOnceWith({ container: surface, snapshot: '{"id":"unit-1"}', access: 'edit' })
    expect(editorPage.view()).toMatchObject({ load: { kind: 'ready', title: '周报', readOnly: false, stage: 'rendered' }, save: { status: 'clean' }, session: 'active' })
    expect(surface.dataset.editorState).toBe('ready')

    fake.enter('steady')
    expect(surface.dataset.editorState).toBe('steady')
    expect(editorPage.view().load).toMatchObject({ stage: 'steady' })

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
    const { editorPage, surface } = setup({ createEditor: async () => Promise.reject(error) })
    await editorPage.load()
    expect(editorPage.view()).toMatchObject({ load: { kind: 'editor-failed', error }, save: undefined })
    expect(surface.dataset.editorState).toBe('failed')
  })

  it('只能查看：以只读创建编辑器（M2-P3 设计 §3.5），不建保存状态机，不能保存', async () => {
    const { editorPage, surface, api, createEditor } = setup({ api: { document: async () => ({ ...DETAIL, permissions: { ...DETAIL.permissions, canEdit: false } }) } })
    await editorPage.load()
    expect(createEditor).toHaveBeenCalledExactlyOnceWith({ container: surface, snapshot: '{"id":"unit-1"}', access: 'read' })
    expect(editorPage.view()).toMatchObject({ load: { kind: 'ready', readOnly: true }, save: undefined })
    expect(editorPage.hasUnsavedWork()).toBe(false)
    await editorPage.save()
    expect(api.compress).not.toHaveBeenCalled()
    expect(api.save).not.toHaveBeenCalled()
  })

  it('载入期间页面已经卸载：创建出的编辑器立即销毁', async () => {
    let resolve: ((editor: SheetEditor) => void) | undefined
    const fake = fakeEditor()
    const { editorPage } = setup({ createEditor: async () => new Promise((settle) => {
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
      api: { save: async () => expired ? Promise.reject(new ApiError(401, 'SESSION_EXPIRED', '已过期')) : ({ revision: 4, savedAt: '2026-09-27T03:00:00.000Z' }) },
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
      return { revision: 4, savedAt: '2026-09-27T03:00:00.000Z' }
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
      return { revision: 4, savedAt: '2026-09-27T03:00:00.000Z' }
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
      return { revision: 4, savedAt: '2026-09-27T03:00:00.000Z' }
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

  it('保存中、同时有确认在途时再按保存：不做任何事，仍是"保存中"，不说明正在确认（复验 TB9）', async () => {
    const pending = deferred<SaveContentResponse>()
    const { editorPage, api, fromOtherTab } = setup({ api: { save: vi.fn(async () => pending.promise) } })
    await editorPage.load()
    const saving = editorPage.save()
    await vi.waitFor(() => expect(api.save).toHaveBeenCalledOnce())
    const check = deferred<SessionResponse>()
    vi.mocked(api.session).mockReturnValueOnce(check.promise)
    fromOtherTab()
    const again = editorPage.save()
    expect(editorPage.view()).toMatchObject({ confirmingSession: false, save: { status: 'saving' } })
    check.resolve(ALICE)
    pending.resolve({ revision: 4, savedAt: '2026-09-27T03:00:00.000Z' })
    await Promise.all([saving, again])
    expect(api.save).toHaveBeenCalledOnce()
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
  it('就绪时带着页头要的东西：文档 id、看得到它的途径、能不能分享、看这一页的人；编辑器的阶段变化时沿用', async () => {
    const { editorPage, fake } = setup({ api: { document: async () => ({ ...DETAIL, accessVia: 'grant', permissions: { ...DETAIL.permissions, canShare: true } }) } })
    await editorPage.load()
    expect(editorPage.view().load).toMatchObject({ kind: 'ready', documentId: DOCUMENT_ID, title: '周报', accessVia: 'grant', canShare: true, userId: ALICE.user.id })
    fake.enter('steady')
    expect(editorPage.view().load).toMatchObject({ stage: 'steady', accessVia: 'grant', canShare: true })
  })

  it('refreshDetail：重新取文档详情，更新标题、所在的空间、途径与能不能分享；能不能编辑与编辑器的阶段不变，之后的阶段变化也沿用新的', async () => {
    const document = vi.fn(async (): Promise<DocumentDetail> => ({ ...DETAIL, permissions: { ...DETAIL.permissions, canShare: true } }))
    const { editorPage, fake } = setup({ api: { document } })
    await editorPage.load()
    document.mockResolvedValueOnce({ ...DETAIL, title: '新标题', space: { id: '0199a2c4-0000-7000-8000-0000000000c1', type: 'team', name: '市场部' }, permissions: { ...DETAIL.permissions, canEdit: false, canShare: false } })
    await editorPage.refreshDetail()
    expect(editorPage.view().load).toMatchObject({ kind: 'ready', title: '新标题', space: { type: 'team', name: '市场部' }, canShare: false, readOnly: false, stage: 'rendered' })
    fake.enter('steady')
    expect(editorPage.view().load).toMatchObject({ title: '新标题', canShare: false, stage: 'steady' })
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
  return new ApiError(409, 'EDIT_LEASE_HELD', '别人正在编辑这份文档', { details: { holder, lastActiveAt: '2026-09-27T02:55:00.000Z', sameUser }, serverTime })
}

function leaseLost(reason: string): ApiError {
  return new ApiError(409, 'EDIT_LEASE_LOST', '编辑权已失效，本次操作没有生效', { details: { reason } })
}

describe('编辑权（M3-P1 设计 §3.4.7）', () => {
  it('能编辑：载入元数据与内容之后申请（本页这次加载的标识，保存也带着它），取得了按可编辑创建；保存带上令牌与代次；每 10 秒续租', async () => {
    const { editorPage, api, editLease, createEditor, surface, time } = setup()
    await editorPage.load()
    expect(editLease.acquire).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, 'id-1')
    expect(editLease.acquire.mock.invocationCallOrder[0]).toBeGreaterThan(Math.max(...vi.mocked(api.content).mock.invocationCallOrder))
    expect(createEditor).toHaveBeenCalledExactlyOnceWith({ container: surface, snapshot: '{"id":"unit-1"}', access: 'edit' })
    expect(editorPage.view()).toMatchObject({ editing: { kind: 'editing' }, load: { readOnly: false }, save: { canSave: true } })
    await editorPage.save()
    expect(api.save).toHaveBeenCalledWith(DOCUMENT_ID, expect.objectContaining<Partial<SaveRequest>>({ clientInstanceId: 'id-1' }), expect.anything(), CREDENTIALS)
    await time.advance(10_000)
    expect(editLease.renew).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, TOKEN, 10)
    await time.advance(10_000)
    expect(editLease.renew).toHaveBeenCalledTimes(2)
  })

  it('续租上报距离本页最后一次键盘、鼠标操作的秒数：操作在窗口的捕获阶段记下', async () => {
    const { editorPage, editLease, time } = setup()
    await editorPage.load()
    await time.advance(4_000)
    window.dispatchEvent(new Event('keydown'))
    await time.advance(6_000)
    expect(editLease.renew).toHaveBeenLastCalledWith(DOCUMENT_ID, TOKEN, 6)
    window.dispatchEvent(new Event('pointerdown'))
    await time.advance(10_000)
    expect(editLease.renew).toHaveBeenLastCalledWith(DOCUMENT_ID, TOKEN, 10)
  })

  it('申请得到的修订号比载入的内容新（这期间有人保存过）：重新载入一次内容，按新的内容创建，以它的修订号作保存的基准', async () => {
    const content = vi.fn<EditorPageApi['content']>()
      .mockResolvedValueOnce({ snapshot: '{"id":"unit-1","v":3}', revision: 3 })
      .mockResolvedValueOnce({ snapshot: '{"id":"unit-1","v":5}', revision: 5 })
    const { editorPage, api, createEditor, surface } = setup({ api: { content }, editLease: { acquire: vi.fn(async () => ({ ...ACQUIRED, revision: 5 })) } })
    await editorPage.load()
    expect(content).toHaveBeenCalledTimes(2)
    expect(createEditor).toHaveBeenCalledExactlyOnceWith({ container: surface, snapshot: '{"id":"unit-1","v":5}', access: 'edit' })
    await editorPage.save()
    expect(api.save).toHaveBeenCalledWith(DOCUMENT_ID, expect.objectContaining<Partial<SaveRequest>>({ baseRevision: 5 }), expect.anything(), CREDENTIALS)
  })

  it('修订号相同：不重新载入', async () => {
    const { editorPage, api } = setup()
    await editorPage.load()
    expect(api.content).toHaveBeenCalledOnce()
  })

  it('重新载入内容失败：与载入失败相同，释放已经取得的编辑权', async () => {
    const content = vi.fn<EditorPageApi['content']>()
      .mockResolvedValueOnce({ snapshot: '{"id":"unit-1"}', revision: 3 })
      .mockRejectedValueOnce(new NetworkError('断网'))
    const { editorPage, editLease, createEditor, time } = setup({ api: { content }, editLease: { acquire: vi.fn(async () => ({ ...ACQUIRED, revision: 4 })) } })
    await editorPage.load()
    expect(editorPage.view()).toMatchObject({ load: { kind: 'failed' }, editing: { kind: 'none' } })
    expect(createEditor).not.toHaveBeenCalled()
    expect(editLease.release).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, TOKEN)
    expect(time.pending()).toBe(0)
  })

  it('别人正在编辑：按只读创建，页头说明持有者与最后活动几分钟之前（按服务端的时间算）；没有保存，不续租', async () => {
    const serverTime = Date.UTC(2026, 8, 27, 3, 2, 30)
    const { editorPage, editLease, createEditor, surface, time } = setup({ editLease: { acquire: vi.fn(async () => Promise.reject(heldBy(false, serverTime))) } })
    await editorPage.load()
    expect(createEditor).toHaveBeenCalledExactlyOnceWith({ container: surface, snapshot: '{"id":"unit-1"}', access: 'read' })
    expect(editorPage.view()).toMatchObject({
      load: { kind: 'ready', readOnly: true },
      save: undefined,
      editing: { kind: 'elsewhere', holder: { holder: AMY, sameUser: false, lastActiveMinutes: 7 } },
    })
    expect(editorPage.hasUnsavedWork()).toBe(false)
    await time.advance(60_000)
    expect(editLease.acquire).toHaveBeenCalledOnce()
    expect(editLease.renew).not.toHaveBeenCalled()
    editorPage.dispose()
    expect(editLease.release).not.toHaveBeenCalled()
  })

  it('自己在别处正在编辑（例如刷新时旧页面的释放还没到，P1 设计 §7）：隔一小会儿再试，旧页面的释放到了就取得', async () => {
    const acquire = vi.fn<EditLeaseApi['acquire']>().mockRejectedValueOnce(heldBy(true)).mockResolvedValueOnce(ACQUIRED)
    const { editorPage, createEditor, surface, time } = setup({ editLease: { acquire } })
    const loading = editorPage.load()
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce())
    await time.advance(500)
    await loading
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(createEditor).toHaveBeenCalledExactlyOnceWith({ container: surface, snapshot: '{"id":"unit-1"}', access: 'edit' })
    expect(editorPage.view().editing).toEqual({ kind: 'editing' })
  })

  it('自己在别处正在编辑、再试几次仍被占用：按只读，说明是自己', async () => {
    const acquire = vi.fn(async () => Promise.reject(heldBy(true)))
    const { editorPage, createEditor, time } = setup({ editLease: { acquire } })
    const loading = editorPage.load()
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce())
    await time.advance(1_500)
    await loading
    expect(acquire).toHaveBeenCalledTimes(4)
    expect(createEditor).toHaveBeenCalledWith(expect.objectContaining({ access: 'read' }))
    expect(editorPage.view().editing).toMatchObject({ kind: 'elsewhere', holder: { sameUser: true } })
  })

  it('申请时刚失去编辑权（403）：按只读打开，不说明谁在编辑', async () => {
    const { editorPage, createEditor } = setup({ editLease: { acquire: vi.fn(async () => Promise.reject(new ApiError(403, 'PERMISSION_DENIED', '只能查看这份文档，不能保存'))) } })
    await editorPage.load()
    expect(createEditor).toHaveBeenCalledWith(expect.objectContaining({ access: 'read' }))
    expect(editorPage.view()).toMatchObject({ load: { kind: 'ready', readOnly: true }, save: undefined, editing: { kind: 'none' } })
  })

  it.each([
    ['读不到了（404）', new ApiError(404, 'NOT_FOUND', '不存在'), { kind: 'not-found' }],
    ['网络错误', new NetworkError('断网'), { kind: 'failed' }],
  ])('申请时%s：与读取元数据、内容失败相同，不创建编辑器', async (_case, error, load) => {
    const { editorPage, createEditor } = setup({ editLease: { acquire: vi.fn(async () => Promise.reject(error)) } })
    await editorPage.load()
    expect(editorPage.view().load).toMatchObject(load)
    expect(createEditor).not.toHaveBeenCalled()
  })

  it('申请时未登录：整页转到登录页', async () => {
    const { editorPage, page } = setup({ editLease: { acquire: vi.fn(async () => Promise.reject(new ApiError(401, 'SESSION_EXPIRED', '已过期'))) } })
    await editorPage.load()
    expect(page.visits).toEqual([`/login?from=%2Fdocuments%2F${DOCUMENT_ID}&reason=expired`])
  })

  it('只能查看：不申请编辑权', async () => {
    const { editorPage, editLease } = setup({ api: { document: async () => ({ ...DETAIL, permissions: { ...DETAIL.permissions, canEdit: false } }) } })
    await editorPage.load()
    expect(editLease.acquire).not.toHaveBeenCalled()
    expect(editorPage.view().editing).toEqual({ kind: 'none' })
  })

  it.each([
    ['被接手（EDIT_LEASE_LOST）', leaseLost('replaced'), { kind: 'lease', reason: 'replaced' }],
    ['读不到了（404）', new ApiError(404, 'NOT_FOUND', '不存在'), { kind: 'not-found' }],
    ['不能编辑了（403）', new ApiError(403, 'PERMISSION_DENIED', '空间已归档，只能查看'), { kind: 'denied' }],
  ])('续租得知编辑权失效（%s）：停止保存，记下来源；离开提示照旧按有没有未保存的修改', async (_case, error, loss) => {
    const { editorPage, api, editLease, fake, time } = setup({ editLease: { renew: vi.fn(async () => Promise.reject(error)) } })
    await editorPage.load()
    Object.assign(fake.editor, { changeSeq: () => 1 })
    fake.changeListeners.forEach(listener => listener())
    await time.advance(10_000)
    expect(editorPage.view()).toMatchObject({ editing: { kind: 'lost', loss }, save: { canSave: false, status: 'dirty' } })
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
    expect(editorPage.view().editing).toMatchObject({ kind: 'lost' })
    vi.mocked(api.session).mockResolvedValueOnce(BOB).mockResolvedValueOnce(ALICE)
    fromOtherTab()
    await vi.waitFor(() => expect(editorPage.view().session).toBe('other-user'))
    fromOtherTab()
    await vi.waitFor(() => expect(editorPage.view().session).toBe('active'))
    expect(editorPage.view().save?.canSave).toBe(false)
  })

  it('保存得到 EDIT_LEASE_LOST：与续租失效同一个处理（停止保存与续租），保存显示失败', async () => {
    const { editorPage, editLease, time } = setup({ api: { save: async () => Promise.reject(leaseLost('replaced')) } })
    await editorPage.load()
    await editorPage.save()
    expect(editorPage.view()).toMatchObject({ editing: { kind: 'lost', loss: { kind: 'lease', reason: 'replaced' } }, save: { status: 'failed', canSave: false } })
    await time.advance(60_000)
    expect(editLease.renew).not.toHaveBeenCalled()
  })

  it('保存得到 404：照旧按保存失败说明，编辑权的状态不变（续租随后得知）', async () => {
    const { editorPage } = setup({ api: { save: async () => Promise.reject(new ApiError(404, 'NOT_FOUND', '不存在')) } })
    await editorPage.load()
    await editorPage.save()
    expect(editorPage.view()).toMatchObject({ editing: { kind: 'editing' }, save: { status: 'failed', canSave: true } })
  })

  it('创建编辑器期间续租得知失效：保存状态机一建好就停住', async () => {
    const creating = deferred<SheetEditor>()
    const { editorPage, fake, createEditor, time } = setup({ createEditor: async () => creating.promise, editLease: { renew: vi.fn(async () => Promise.reject(leaseLost('expired'))) } })
    const loading = editorPage.load()
    await vi.waitFor(() => expect(createEditor).toHaveBeenCalled())
    await time.advance(10_000)
    expect(editorPage.view().editing).toMatchObject({ kind: 'lost' })
    creating.resolve(fake.editor)
    await loading
    expect(editorPage.view()).toMatchObject({ load: { kind: 'ready', readOnly: false }, save: { canSave: false } })
  })

  it('会话不是本人时暂停续租；回到本人时立即续租一次，登录换过的租约得知失效（session），保存停住', async () => {
    const { editorPage, api, editLease, fromOtherTab, time } = setup()
    await editorPage.load()
    vi.mocked(api.session).mockResolvedValueOnce(BOB)
    fromOtherTab()
    await vi.waitFor(() => expect(editorPage.view().session).toBe('other-user'))
    await time.advance(60_000)
    expect(editLease.renew).not.toHaveBeenCalled()
    editLease.renew.mockRejectedValueOnce(leaseLost('session'))
    vi.mocked(api.session).mockResolvedValueOnce({ ...ALICE, csrfToken: 'csrf-again' })
    fromOtherTab()
    await vi.waitFor(() => expect(editorPage.view().editing).toMatchObject({ kind: 'lost', loss: { kind: 'lease', reason: 'session' } }))
    expect(editLease.renew).toHaveBeenCalledOnce()
    expect(editorPage.view()).toMatchObject({ session: 'active', save: { canSave: false } })
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
    expect(editorPage.view()).toMatchObject({ session: 'active', editing: { kind: 'editing' }, save: { canSave: true } })
    await time.advance(10_000)
    expect(editLease.renew).toHaveBeenCalledTimes(2)
  })

  it('按保存时等会话的确认连同编辑权的核对有了结果：登录换过、编辑权随之失效时不发保存', async () => {
    const save = vi.fn(async (): Promise<SaveContentResponse> => Promise.reject(new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效')))
    const { editorPage, api, editLease } = setup({ api: { save } })
    await editorPage.load()
    const check = deferred<SessionResponse>()
    vi.mocked(api.session).mockReturnValueOnce(check.promise)
    editLease.renew.mockRejectedValueOnce(leaseLost('session'))
    await editorPage.save()
    const again = editorPage.save()
    check.resolve({ ...ALICE, csrfToken: 'csrf-new' })
    await again
    expect(save).toHaveBeenCalledOnce()
    expect(editLease.renew).toHaveBeenCalledOnce()
    expect(editorPage.view()).toMatchObject({ session: 'active', editing: { kind: 'lost', loss: { reason: 'session' } } })
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
    expect(editorPage.view()).toMatchObject({ load: { kind: 'editor-failed' }, editing: { kind: 'none' } })
    expect(editLease.release).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, TOKEN)
    expect(time.pending()).toBe(0)
  })
})
