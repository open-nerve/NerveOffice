import type { DocumentDetail, SaveContentResponse, SessionResponse } from '@nerve-office/contracts'
import type { CreateSheetEditorOptions, SheetEditor, SheetEditorLifecycle } from '../../editor/index.ts'
import type { PageLocation } from '../../shared/lib/page-location.ts'
import type { SessionChannel } from '../../shared/lib/session-channel.ts'
import type { EditorPageApi } from './editor-page.ts'
import type { SaveRequest } from './save-coordinator.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, NetworkError, setCsrfToken } from '../../shared/api/index.ts'
import { createEditorPage } from './editor-page.ts'

const DOCUMENT_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'

const ALICE: SessionResponse = {
  user: { id: '0199a2c4-1f2e-7a3b-8c4d-00000000000a', username: 'alice', displayName: '爱丽丝', systemRole: 'member' },
  personalSpace: { id: '0199a2c4-2a3b-7c4d-9e5f-00000000000a', name: '爱丽丝' },
  csrfToken: 'csrf-alice',
}
const BOB: SessionResponse = { ...ALICE, user: { ...ALICE.user, id: '0199a2c4-1f2e-7a3b-8c4d-00000000000b', username: 'bob' }, csrfToken: 'csrf-bob' }

const DETAIL: DocumentDetail = {
  id: DOCUMENT_ID,
  title: '周报',
  type: 'sheet',
  createdAt: '2026-09-27T01:00:00.000Z',
  updatedAt: '2026-09-27T02:00:00.000Z',
  spaceId: ALICE.personalSpace.id,
  space: { id: ALICE.personalSpace.id, type: 'personal', name: '爱丽丝' },
  folderId: null,
  revision: 3,
  profile: 'sheet@1',
  formatVersion: 1,
  permissions: { canEdit: true, canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: false, canCopy: true, canDelete: true },
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
  readonly api?: Partial<EditorPageApi>
  readonly createEditor?: (options: CreateSheetEditorOptions) => Promise<SheetEditor>
}

function setup(options: Setup = {}) {
  const surface = document.createElement('div')
  const chrome = document.createElement('header')
  const fake = fakeEditor()
  const page: PageLocation & { visits: string[] } = { visits: [], assign: vi.fn(), replace: url => page.visits.push(url), reload: vi.fn() }
  const { channel, fromOtherTab, listeners } = fakeChannel()
  const api: EditorPageApi = {
    session: vi.fn(async () => ALICE),
    document: vi.fn(async () => DETAIL),
    content: vi.fn(async () => ({ snapshot: '{"id":"unit-1"}', revision: 3 })),
    compress: vi.fn(async (snapshot: string) => new TextEncoder().encode(snapshot)),
    save: vi.fn(async (): Promise<SaveContentResponse> => ({ revision: 4, savedAt: '2026-09-27T03:00:00.000Z' })),
    ...options.api,
  }
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
    currentPath: () => `/documents/${DOCUMENT_ID}`,
    newId: () => `id-${++id}`,
    reportError: vi.fn(),
  })
  return { editorPage, surface, chrome, fake, page, api, createEditor, fromOtherTab, listeners }
}

afterEach(() => setCsrfToken(undefined))

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
    expect(api.save).toHaveBeenCalledWith(DOCUMENT_ID, expect.objectContaining<Partial<SaveRequest>>({ baseRevision: 3, clientInstanceId: 'id-1', requestId: 'id-2' }), expect.anything())
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
