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
  revision: 3,
  profile: 'sheet@1',
  formatVersion: 1,
  permissions: { canEdit: true },
}

/** 假的编辑器：生命周期可以推进，保存用到的能力都是最简单的实现 */
function fakeEditor(stage: SheetEditorLifecycle = 'rendered') {
  let current = stage
  const lifecycleListeners = new Set<(stage: SheetEditorLifecycle) => void>()
  const editor: SheetEditor = {
    unitId: 'unit-1',
    changeSeq: () => 0,
    onChange: () => () => {},
    lifecycle: () => current,
    onLifecycle: (listener) => {
      lifecycleListeners.add(listener)
      return () => lifecycleListeners.delete(listener)
    },
    isCellEditing: () => false,
    commitCellEditing: async () => true,
    settleFormulas: async () => 'settled',
    capture: () => '{"id":"unit-1"}',
    setEditable: vi.fn(),
    dispose: vi.fn(),
  }
  return {
    editor,
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
  const fake = fakeEditor()
  const page: PageLocation & { visits: string[] } = { visits: [], assign: vi.fn(), replace: url => page.visits.push(url), reload: vi.fn() }
  const { channel, fromOtherTab, listeners } = fakeChannel()
  const api: EditorPageApi = {
    session: vi.fn(async () => ALICE),
    document: vi.fn(async () => DETAIL),
    content: vi.fn(async () => ({ snapshot: '{"id":"unit-1"}', revision: 3 })),
    save: vi.fn(async (): Promise<SaveContentResponse> => ({ revision: 4, savedAt: '2026-09-27T03:00:00.000Z' })),
    ...options.api,
  }
  const createEditor = vi.fn(options.createEditor ?? (async () => fake.editor))
  let id = 0
  const editorPage = createEditorPage({
    documentId: 'documentId' in options ? options.documentId : DOCUMENT_ID,
    surface,
    api,
    createEditor,
    page,
    sessionChannel: channel,
    currentPath: () => `/documents/${DOCUMENT_ID}`,
    newId: () => `id-${++id}`,
    reportError: vi.fn(),
  })
  return { editorPage, surface, fake, page, api, createEditor, fromOtherTab, listeners }
}

afterEach(() => setCsrfToken(undefined))

describe('编辑器页的载入（P4 设计 §3.7.1）', () => {
  it('先确认会话，再读取元数据与内容，创建编辑器；就绪之后可以保存，基准是内容的修订号', async () => {
    const { editorPage, surface, api, createEditor, fake } = setup()
    expect(surface.dataset.editorState).toBeUndefined()
    const loading = editorPage.load()
    expect(surface.dataset.editorState).toBe('loading')
    await loading
    expect(api.session).toHaveBeenCalledOnce()
    expect(api.document).toHaveBeenCalledWith(DOCUMENT_ID)
    expect(api.content).toHaveBeenCalledWith(DOCUMENT_ID)
    expect(createEditor).toHaveBeenCalledWith({ container: surface, snapshot: '{"id":"unit-1"}' })
    expect(editorPage.view()).toMatchObject({ load: { kind: 'ready', title: '周报', readOnly: false, stage: 'rendered' }, save: { status: 'clean' }, session: 'active' })
    expect(surface.dataset.editorState).toBe('ready')

    fake.enter('steady')
    expect(surface.dataset.editorState).toBe('steady')
    expect(editorPage.view().load).toMatchObject({ stage: 'steady' })

    await editorPage.save()
    expect(api.save).toHaveBeenCalledWith(DOCUMENT_ID, expect.objectContaining<Partial<SaveRequest>>({ baseRevision: 3, clientInstanceId: 'id-1', requestId: 'id-2' }))
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

  it('只能查看：编辑器设为只读，不能保存', async () => {
    const { editorPage, fake } = setup({ api: { document: async () => ({ ...DETAIL, permissions: { canEdit: false } }) } })
    await editorPage.load()
    expect(fake.editor.setEditable).toHaveBeenCalledWith(false)
    expect(editorPage.view()).toMatchObject({ load: { kind: 'ready', readOnly: true }, save: undefined })
    expect(editorPage.hasUnsavedWork()).toBe(false)
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

  it('保存得到登录已过期：不整页跳转（修改留着），暂停保存，提示在别处登录；本人登录回来之后再保存成功', async () => {
    let expired = true
    const { editorPage, page, api } = setup({
      api: { save: async () => expired ? Promise.reject(new ApiError(401, 'SESSION_EXPIRED', '已过期')) : ({ revision: 4, savedAt: '2026-09-27T03:00:00.000Z' }) },
    })
    await editorPage.load()
    await editorPage.save()
    expect(page.visits).toEqual([])
    expect(editorPage.view()).toMatchObject({ session: 'signed-out', save: { status: 'failed' } })

    expired = false
    vi.mocked(api.session).mockResolvedValueOnce(ALICE)
    await editorPage.save()
    expect(editorPage.view()).toMatchObject({ session: 'active', save: { status: 'clean' } })
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
