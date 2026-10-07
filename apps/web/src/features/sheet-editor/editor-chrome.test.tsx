import type { EditInterruption } from '@nerve-office/contracts'
import type { AutosaveView } from './autosave.ts'
import type { LeaseLoss } from './edit-lease.ts'
import type { EditModeState, IncomingRequest, LostMode, OpenCheckFailures, ReadingMode } from './edit-mode.ts'
import type { EditorPage, EditorPageReady, EditorPageView } from './editor-page.ts'
import type { SaveView } from './save-coordinator.ts'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ApiError, NetworkError } from '../../shared/api/index.ts'
import { apiError, installFakeApi, json } from '../../shared/testing/fake-api.test-support.ts'
import { EditorChrome } from './editor-chrome.tsx'
import { ANNOUNCEMENT_MS } from './save-indicator.ts'

const PERSONAL = { id: '0199a2c4-0000-7000-8000-0000000000a1', type: 'personal' } as const
const READY: EditorPageReady = {
  kind: 'ready',
  documentId: '0199a2c4-0000-7000-8000-0000000000d1',
  title: '周报',
  space: PERSONAL,
  accessVia: 'space',
  canShare: false,
  userId: '0199a2c4-0000-7000-8000-00000000000a',
}
const CLEAN: SaveView = { status: 'clean', formulasPending: false, problem: undefined, conflict: undefined, canSave: true, unsaved: false, unsavedEdits: false, checking: false, snapshotBytes: undefined }
const EDITING: EditModeState = { kind: 'editing' }
const READING: ReadingMode = { kind: 'reading', canEdit: true, holder: undefined, selfHolder: undefined, takeover: undefined, request: undefined, requestedElsewhere: false, canTakeOver: false, interruption: undefined, update: 'none', gone: false, notice: undefined, releaseUnconfirmed: false, blocked: undefined, formulasPending: false, damaged: undefined }
const AMY = { id: '0199a2c4-0000-7000-8000-0000000000e1', username: 'amy', displayName: '艾米' }
const COPY = {
  id: '0199a2c4-0000-7000-8000-0000000000c9',
  title: '周报（冲突副本 2026-10-04 15:30）',
  type: 'sheet',
  createdAt: '2026-10-04T07:31:00.000Z',
  updatedAt: '2026-10-04T07:31:00.000Z',
  spaceId: PERSONAL.id,
  space: PERSONAL,
  folderId: null,
  accessVia: 'space',
  revision: 1,
  profile: 'sheet@1',
  formatVersion: 1,
  sdkVersion: '1.0.1',
  formulasPending: false,
  permissions: { canEdit: true, canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: true, canCopy: true, canDelete: true, canShare: true, canTakeOver: true },
} as const

/** 失去编辑权（默认：读得到、有修改，可以另存为副本或放弃） */
function lost(loss: LeaseLoss, changes: Partial<LostMode> = {}): LostMode {
  return { kind: 'lost', loss, unsaved: true, readable: loss.kind !== 'not-found', checking: false, captureFailed: false, inputLeft: false, reopenFailed: false, copy: { kind: 'idle' }, reload: { kind: 'idle' }, ...changes }
}

/** 假的编辑器页：视图由测试设定 */
function fakePage(initial: Partial<EditorPageView> = {}) {
  let view: EditorPageView = { load: READY, mode: EDITING, save: CLEAN, autosave: undefined, session: 'active', sessionProblem: undefined, confirmingSession: false, detailProblem: undefined, detailRefreshing: false, surface: 'ready', ...initial }
  const listeners = new Set<() => void>()
  const page: EditorPage = {
    view: () => view,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    load: async () => {},
    save: vi.fn(async () => {}),
    enterEditing: vi.fn(async () => {}),
    takeOverHere: vi.fn(async () => {}),
    cancelTakeOver: vi.fn(),
    forceTakeOver: vi.fn(async () => {}),
    dismissInterruption: vi.fn(),
    requestEditing: vi.fn(async () => {}),
    cancelRequest: vi.fn(async () => {}),
    handOver: vi.fn(async () => {}),
    keepEditing: vi.fn(async () => {}),
    exitEditing: vi.fn(async () => {}),
    refreshUpdate: vi.fn(async () => {}),
    saveCopy: vi.fn(async () => {}),
    discard: vi.fn(async () => {}),
    hasUnsavedWork: () => false,
    reload: vi.fn(),
    refreshDetail: vi.fn(async () => {}),
    recheckSession: vi.fn(async () => {}),
    dispose: () => {},
  }
  return {
    page,
    set(next: Partial<EditorPageView>): void {
      view = { ...view, ...next }
      act(() => listeners.forEach(listener => listener()))
    },
  }
}

/** 页头里看得见的状态（载入中的说明、阅读与编辑、保存状态）：不是读屏的播报区（M3-P4，例行的变化只改它的文字） */
function headerStatus(): HTMLElement {
  const status = screen.getByRole('banner').querySelector<HTMLElement>('[data-slot="header-status"]')
  if (status === null)
    throw new Error('页头里没有看得见的状态')
  return status
}

/** 页头里读屏的播报区（role="status"，只播有意义的变化，M3-P4 设计 §3.9）：页头之外另有说明谁在编辑的读屏状态区 */
function announcement(): HTMLElement {
  return within(screen.getByRole('banner')).getByRole('status')
}

/** 页头之外的读屏状态区（谁在编辑、文档读不到了、另存为副本成功） */
function infoRegion(): HTMLElement {
  const region = screen.getAllByRole('status').find(element => element.dataset.slot === 'status-region')
  if (region === undefined)
    throw new Error('没有页头之外的读屏状态区')
  return region
}

function renderChrome(initial: Partial<EditorPageView> = {}, apple = false) {
  const fake = fakePage(initial)
  render(<EditorChrome page={fake.page} apple={apple} />)
  return fake
}

describe('编辑器页的页头（P4 设计 §3.7.3）', () => {
  it('就绪：返回文档所在的空间——个人空间回到首页（我的空间），团队空间回到它的空间页并显示名称', () => {
    const fake = renderChrome()
    expect(screen.getByRole('link', { name: '我的空间' })).toHaveAttribute('href', '/')
    fake.set({ load: { ...READY, space: { id: '0199a2c4-0000-7000-8000-0000000000c1', type: 'team', name: '市场部' } } })
    expect(screen.getByRole('link', { name: '市场部' })).toHaveAttribute('href', '/spaces/0199a2c4-0000-7000-8000-0000000000c1')
  })

  it('只凭单独授权打开的（accessVia 为 grant，M2-P5）：返回链接回"与我共享"，不显示所在的空间（看不到它的目录结构）', () => {
    const fake = renderChrome({ load: { ...READY, accessVia: 'grant', space: { id: '0199a2c4-0000-7000-8000-0000000000c1', type: 'team', name: '市场部' } } })
    expect(screen.getByRole('link', { name: '与我共享' })).toHaveAttribute('href', '/shared')
    expect(screen.queryByText('市场部')).toBeNull()
    fake.set({ load: { ...READY, accessVia: 'grant', space: { id: '0199a2c4-0000-7000-8000-0000000000b1', type: 'personal' } } })
    expect(screen.getByRole('link', { name: '与我共享' })).toHaveAttribute('href', '/shared')
    expect(screen.queryByRole('link', { name: '我的空间' })).toBeNull()
  })

  it('分享的入口（M2-P5）：只在能分享时（canShare）出现；打开对话框，关闭之后焦点回到入口', async () => {
    installFakeApi({ [`GET /api/documents/${READY.documentId}/grants`]: () => json(200, { items: [] }) })
    const fake = renderChrome()
    expect(screen.queryByRole('button', { name: '分享' })).toBeNull()
    fake.set({ load: { ...READY, canShare: true } })
    const entry = screen.getByRole('button', { name: '分享' })
    entry.focus()
    fireEvent.click(entry)
    const dialog = await screen.findByRole('dialog', { name: '分享「周报」' })
    expect(await within(dialog).findByText('还没有单独分享给任何人。')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '分享' }))
  })

  it('对话框里被拒绝（例如空间刚被归档）：页头重新取文档详情；入口随之消失时，关闭之后焦点交给返回链接', async () => {
    installFakeApi({ [`GET /api/documents/${READY.documentId}/grants`]: () => apiError(403, 'PERMISSION_DENIED', '空间已归档，恢复之后才能调整分享') })
    const fake = renderChrome({ load: { ...READY, canShare: true } })
    const entry = screen.getByRole('button', { name: '分享' })
    entry.focus()
    fireEvent.click(entry)
    const dialog = await screen.findByRole('dialog', { name: '分享「周报」' })
    expect(await within(dialog).findByText('空间已归档，恢复之后才能调整分享')).toBeInTheDocument()
    await waitFor(() => expect(fake.page.refreshDetail).toHaveBeenCalled())
    fake.set({ load: { ...READY, canShare: false } })
    expect(screen.queryByRole('button', { name: '分享' })).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('link', { name: '我的空间' })))
  })

  it('分享对话框里的请求得到未登录或令牌失效：交给本页的会话确认（页头随之说明）', async () => {
    installFakeApi({ [`GET /api/documents/${READY.documentId}/grants`]: () => apiError(401, 'SESSION_EXPIRED') })
    const fake = renderChrome({ load: { ...READY, canShare: true } })
    fireEvent.click(screen.getByRole('button', { name: '分享' }))
    await screen.findByRole('dialog', { name: '分享「周报」' })
    await waitFor(() => expect(fake.page.recheckSession).toHaveBeenCalled())
  })

  it('载入中：说明正在打开，页头有回到我的空间的链接（整页跳转）', () => {
    renderChrome({ load: { kind: 'loading' }, mode: undefined, save: undefined })
    expect(headerStatus()).toHaveTextContent('正在打开表格…')
    expect(screen.getByRole('link', { name: '我的空间' })).toHaveAttribute('href', '/')
    expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument()
  })

  it('读屏的播报区一直是同一个元素（role="status"，显式 aria-live，视觉隐藏）：从载入、阅读到编辑，模式的切换都往里填；看得见的状态是另一个元素', () => {
    const fake = renderChrome({ load: { kind: 'loading' }, mode: undefined, save: undefined })
    const spoken = announcement()
    expect(spoken).toHaveAttribute('aria-live', 'polite')
    expect(spoken).toHaveClass('sr-only')
    expect(headerStatus()).not.toBe(spoken)
    expect(headerStatus()).not.toHaveAttribute('role')
    fake.set({ load: READY, mode: { ...READING, canEdit: false } })
    expect(announcement()).toBe(spoken)
    expect(spoken).toHaveTextContent('只能查看')
    expect(headerStatus()).toHaveTextContent('只能查看')
    fake.set({ mode: { kind: 'entering' } })
    expect(announcement()).toBe(spoken)
    expect(spoken).toHaveTextContent('正在进入编辑…')
    fake.set({ mode: EDITING, save: CLEAN })
    expect(announcement()).toBe(spoken)
    expect(spoken).toHaveTextContent('已保存到云端')
  })

  it('编辑：标题、保存状态（role="status"）、保存与退出编辑；浏览器标签页的标题', () => {
    const { page } = renderChrome()
    expect(screen.getByRole('heading', { name: '周报' })).toBeInTheDocument()
    expect(headerStatus()).toHaveTextContent('已保存到云端')
    expect(document.title).toBe('周报 - NerveOffice')
    fireEvent.click(screen.getByRole('button', { name: '退出编辑' }))
    expect(page.exitEditing).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull()
  })

  it('保存按钮：点击保存；快捷键按平台标注', () => {
    const { page } = renderChrome()
    const button = screen.getByRole('button', { name: '保存' })
    expect(button).toHaveAttribute('aria-keyshortcuts', 'Control+S')
    expect(button).toHaveAttribute('title', '保存（Ctrl+S）')
    fireEvent.click(button)
    expect(page.save).toHaveBeenCalledOnce()
  })

  it('苹果的平台：Cmd+S', () => {
    renderChrome({}, true)
    expect(screen.getByRole('button', { name: '保存' })).toHaveAttribute('aria-keyshortcuts', 'Meta+S')
  })

  it('保存状态随状态机变化；保存中"保存"照样可按（在途时按下排一次，M3-P4 设计 §3.9），不能保存时（停住、终态）标为不可用', () => {
    const fake = renderChrome()
    fake.set({ save: { ...CLEAN, status: 'dirty', unsaved: true, unsavedEdits: true } })
    expect(headerStatus()).toHaveTextContent('有未保存的修改')
    fake.set({ save: { ...CLEAN, status: 'saving', unsaved: true, unsavedEdits: true } })
    expect(headerStatus()).toHaveTextContent('保存中…')
    const button = screen.getByRole('button', { name: '保存' })
    expect(button).toHaveAttribute('aria-disabled', 'false')
    fireEvent.click(button)
    expect(fake.page.save).toHaveBeenCalledOnce()
    fake.set({ save: CLEAN })
    expect(headerStatus()).toHaveTextContent('已保存到云端')
    fake.set({ save: { ...CLEAN, canSave: false } })
    expect(screen.getByRole('button', { name: '保存' })).toHaveAttribute('aria-disabled', 'true')
  })

  it('版本冲突：说明保留本页内容，提供重新加载', () => {
    const { page } = renderChrome({ save: { ...CLEAN, status: 'conflict', canSave: false, unsaved: true, conflict: { currentRevision: 5, source: null } } })
    expect(headerStatus()).toHaveTextContent('版本冲突')
    expect(screen.getByRole('alert')).toHaveTextContent('别处保存了更新的版本。本页的修改没有保存')
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    expect(page.reload).toHaveBeenCalledOnce()
  })

  it.each([
    ['单元格的编辑提交不了', { kind: 'cell-editing' } as const, '请先完成单元格的编辑'],
    ['超过容量上限（本页判断）', { kind: 'too-large' } as const, '表格超过容量上限（5 MiB），无法保存'],
    ['超过容量上限（服务端 413）', { kind: 'request', error: new ApiError(413, 'PAYLOAD_TOO_LARGE', '请求体解压后超过上限') } as const, '表格超过容量上限（5 MiB），无法保存'],
    // 快照不合格（M3-P3）：按违反的规则说；没有规则或不认识的规则照"格式不正确"说
    ['快照不合格（422，没有规则）', { kind: 'request', error: new ApiError(422, 'SNAPSHOT_INVALID', 'x', { requestId: 'req-9' }) } as const, '保存失败：表格内容的格式不正确'],
    ['快照不合格（422，不认识的规则）', { kind: 'request', error: new ApiError(422, 'SNAPSHOT_INVALID', 'x', { requestId: 'req-9', details: { rule: 'doc-footer' } }) } as const, '保存失败：表格内容的格式不正确'],
    ['快照不合格（422，链接）', { kind: 'request', error: new ApiError(422, 'SNAPSHOT_INVALID', 'x', { requestId: 'req-9', details: { rule: 'link-address' } }) } as const, '保存失败：表格里有不能保存的链接'],
    ['快照不合格（422，图片）', { kind: 'request', error: new ApiError(422, 'SNAPSHOT_INVALID', 'x', { requestId: 'req-9', details: { rule: 'image-source' } }) } as const, '保存失败：表格里有不能保存的图片'],
    ['快照不合格（422，保护）', { kind: 'request', error: new ApiError(422, 'SNAPSHOT_INVALID', 'x', { requestId: 'req-9', details: { rule: 'resource-not-empty' } }) } as const, '保存失败：表格里有不支持的功能的数据（例如保护）'],
    ['快照不合格（422，缩水）', { kind: 'request', error: new ApiError(422, 'SNAPSHOT_INVALID', 'x', { requestId: 'req-9', details: { rule: 'resource-missing' } }) } as const, '保存失败：表格里缺少上一版有的内容（例如批注、筛选、条件格式），为免丢失没有保存'],
    ['快照不合格（422，过于复杂）', { kind: 'request', error: new ApiError(422, 'SNAPSHOT_INVALID', 'x', { requestId: 'req-9', details: { rule: 'too-complex' } }) } as const, '保存失败：表格的内容过于复杂'],
    ['网络错误', { kind: 'request', error: new NetworkError('断网') } as const, '保存失败：网络连接失败，请检查网络后重试'],
  ])('保存没有完成：%s', (_case, problem, text) => {
    renderChrome({ save: { ...CLEAN, status: problem.kind === 'cell-editing' ? 'dirty' : 'failed', problem } })
    expect(screen.getByText(text)).toBeInTheDocument()
  })

  it('请求不合法（400 REQUEST_INVALID）是这次请求本身的问题：按错误码说明，不说成"已经被删除、移走或失去权限"（第二批 G-5）', () => {
    renderChrome({ save: { ...CLEAN, status: 'failed', problem: { kind: 'request', error: new ApiError(400, 'REQUEST_INVALID', '请求的格式或参数不合法', { requestId: 'req-400' }) } } })
    expect(screen.getByRole('alert')).toHaveTextContent('保存失败：请求的内容不合法，请检查后重试')
    expect(screen.queryByText(/已经被删除/)).toBeNull()
    expect(screen.getByText('请求标识：req-400')).toBeInTheDocument()
  })

  it('失败的说明带请求标识', () => {
    renderChrome({ save: { ...CLEAN, status: 'failed', problem: { kind: 'request', error: new ApiError(500, 'INTERNAL_ERROR', 'x', { requestId: 'req-42' }) } } })
    expect(screen.getByText('请求标识：req-42')).toBeInTheDocument()
  })

  it('公式结果尚未保存（修改都已存上，只差公式）：页头说算完之后自动保存，不另给"请稍后再保存一次"的说明', () => {
    renderChrome({ save: { ...CLEAN, status: 'dirty', formulasPending: true, unsaved: true } })
    expect(headerStatus()).toHaveTextContent('公式结果尚未保存（算完之后自动保存）')
    expect(screen.queryByText(/请稍后再保存一次/)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('别的标签页登录了另一个账户：提示不能再保存', () => {
    renderChrome({ session: 'other-user', save: { ...CLEAN, canSave: false } })
    expect(screen.getByRole('alert')).toHaveTextContent('别的标签页登录了另一个账户，本页不能再保存')
  })

  it('登录已过期或在别处退出：提示修改还在，提供在新标签页中登录的链接（本页不离开）', () => {
    renderChrome({ session: 'signed-out', save: { ...CLEAN, status: 'failed', problem: { kind: 'request', error: new ApiError(401, 'SESSION_EXPIRED', 'x') } } })
    expect(screen.getAllByRole('alert')[0]).toHaveTextContent('本页的修改还在')
    const link = screen.getByRole('link', { name: '在新标签页中登录' })
    expect(link).toHaveAttribute('href', '/login')
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('会话不是本人时，不再重复"登录已过期""请求已失效"这类失败的说明（复验 RB2）', () => {
    renderChrome({ session: 'signed-out', save: { ...CLEAN, status: 'failed', problem: { kind: 'request', error: new ApiError(401, 'SESSION_EXPIRED', 'x') } } })
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    cleanup()
    renderChrome({ session: 'other-user', save: { ...CLEAN, status: 'failed', canSave: false, problem: { kind: 'request', error: new ApiError(403, 'CSRF_TOKEN_INVALID', 'x') } } })
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('alert')).not.toHaveTextContent('请再保存一次')
  })

  it('会话是本人时的令牌失效与迟到的未登录：说明请求已失效、稍后自动重试（令牌已经换好，复验 SB1；M3-P4 自动保存随即重试）', () => {
    renderChrome({ save: { ...CLEAN, status: 'failed', problem: { kind: 'request', error: new ApiError(401, 'SESSION_EXPIRED', 'x') } } })
    expect(screen.getByRole('alert')).toHaveTextContent('保存失败：请求已失效，稍后自动重试')
  })

  it('按了保存、正在确认会话：说明正在确认，按钮不可用（复验 SB5）', () => {
    renderChrome({ confirmingSession: true })
    expect(headerStatus()).toHaveTextContent('正在确认登录状态…')
    expect(screen.getByRole('button', { name: '保存' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('button', { name: '保存' })).toHaveAttribute('aria-busy', 'true')
  })

  it.each([
    ['令牌失效', new ApiError(403, 'CSRF_TOKEN_INVALID', 'x')],
    ['登录已过期', new ApiError(401, 'SESSION_EXPIRED', 'x')],
  ])('保存得到%s、确认会话进行中：页头说明正在确认，不先说请求已失效；确认之后才说（复验 TB1）', (_case, error) => {
    const fake = renderChrome({ confirmingSession: true, save: { ...CLEAN, status: 'failed', problem: { kind: 'request', error } } })
    expect(headerStatus()).toHaveTextContent('正在确认登录状态…')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    fake.set({ confirmingSession: false })
    expect(screen.getByRole('alert')).toHaveTextContent('保存失败：请求已失效，稍后自动重试')
  })

  it('会话是本人、令牌失效之后确认会话失败：说明原因，不说"再保存一次"就好（令牌没有换成，复验 TB1）', () => {
    renderChrome({ sessionProblem: new NetworkError('断网'), save: { ...CLEAN, status: 'failed', problem: { kind: 'request', error: new ApiError(403, 'CSRF_TOKEN_INVALID', 'x') } } })
    expect(screen.getByRole('alert')).toHaveTextContent('保存失败：暂时无法确认登录状态：网络连接失败，请检查网络后重试')
    expect(screen.getByRole('alert')).not.toHaveTextContent('请求已失效')
  })

  it('版本冲突之后别的标签页换了人：冲突的说明里另说明重新加载会以那个账户打开，不说"之后可以继续保存"（复验 TB7、TB8）', () => {
    renderChrome({ session: 'other-user', save: { ...CLEAN, status: 'conflict', canSave: false, unsaved: true, conflict: { currentRevision: 5, source: null } } })
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('alert')).toHaveTextContent('别处保存了更新的版本')
    expect(screen.getByRole('alert')).toHaveTextContent('重新加载会以那个账户打开。要查看最新版本，先换回原来的账户再重新加载')
    expect(screen.getByRole('alert')).not.toHaveTextContent('可以继续保存')
  })

  it('版本冲突之后不再显示会话的提示；会话不是本人时页头说暂停保存（登录回来之后自动保存），不说公式（复验 SB9）', () => {
    renderChrome({ session: 'signed-out', save: { ...CLEAN, status: 'conflict', canSave: false, unsaved: true, conflict: { currentRevision: 5, source: null } } })
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('alert')).toHaveTextContent('别处保存了更新的版本')
    cleanup()
    renderChrome({ session: 'other-user', save: { ...CLEAN, status: 'dirty', canSave: false, formulasPending: true, unsaved: true }, autosave: { offline: false, paused: true, retrying: false, held: false } })
    expect(headerStatus()).toHaveTextContent('暂停保存：登录回来之后自动保存')
    expect(screen.queryByText(/公式结果尚未保存/)).toBeNull()
  })

  it('确认会话失败（例如断网时按了保存）：在会话的提示里说明原因（复验 RB7）', () => {
    renderChrome({ session: 'signed-out', sessionProblem: new NetworkError('断网') })
    expect(screen.getByRole('alert')).toHaveTextContent('暂时无法确认登录状态：网络连接失败，请检查网络后重试')
  })

  it('CSRF 令牌失效：说明请求已失效、稍后自动重试，不让用户刷新（刷新会丢掉修改）', () => {
    renderChrome({ save: { ...CLEAN, status: 'failed', problem: { kind: 'request', error: new ApiError(403, 'CSRF_TOKEN_INVALID', 'x') } } })
    expect(screen.getByRole('alert')).toHaveTextContent('保存失败：请求已失效，稍后自动重试')
    expect(screen.getByRole('alert')).not.toHaveTextContent('刷新')
  })

  it('保存流程本身出了意外：显示保存失败', () => {
    renderChrome({ save: { ...CLEAN, status: 'failed', problem: { kind: 'unexpected', error: new Error('SDK 出错') } } })
    expect(screen.getByRole('alert')).toHaveTextContent('保存失败：出了点问题，请稍后重试')
  })

  it('持有编辑权的页面没有人登录了、换了人：重新登录之后编辑权自动续上、修改自动保存（M3-P4），说明里这样说', () => {
    renderChrome({ save: { ...CLEAN, status: 'dirty', unsaved: true }, session: 'signed-out' })
    expect(screen.getByRole('alert')).toHaveTextContent('登录已过期或已在别处退出。本页的修改还在：请在新的标签页中用同一个账户登录，回到这里之后会自动保存')
    cleanup()
    renderChrome({ save: { ...CLEAN, status: 'dirty', unsaved: true }, session: 'other-user' })
    expect(screen.getByRole('alert')).toHaveTextContent('别的标签页登录了另一个账户，本页不能再保存。原来的账户重新登录之后会自动保存')
  })

  it('文档详情没能刷新（DEF-040）：与列表同一个说法与原因，可以重试；页头的信息照旧', () => {
    const { page } = renderChrome({ detailProblem: new ApiError(503, 'SERVICE_UNAVAILABLE', '繁忙') })
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('文档信息没能刷新，显示的还是之前的内容')
    expect(alert).toHaveTextContent('服务')
    expect(screen.getByRole('heading', { name: '周报' })).toBeInTheDocument()
    fireEvent.click(within(alert).getByRole('button', { name: '重试' }))
    expect(page.refreshDetail).toHaveBeenCalledOnce()
  })

  it('文档详情没能刷新、重试成功之后说明连同"重试"一起消失：焦点交给返回链接，不落到 body（DEF-040）', () => {
    const fake = renderChrome({ detailProblem: new ApiError(503, 'SERVICE_UNAVAILABLE', '繁忙') })
    const retry = within(screen.getByRole('alert')).getByRole('button', { name: '重试' })
    retry.focus()
    fake.set({ detailProblem: undefined })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('link', { name: '我的空间' }))
  })
})

describe('编辑器页的载入失败', () => {
  it('内容不存在或无权访问（别人的与不存在的相同）：说明，可以回到我的空间', () => {
    renderChrome({ load: { kind: 'not-found' }, mode: undefined, save: undefined })
    expect(screen.getByText('内容不存在，或者你没有访问权限')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '我的空间' })).toHaveAttribute('href', '/')
  })

  it.each([
    ['格式不认识', { kind: 'unsupported' } as const, '这份表格的格式比当前页面新，请刷新页面'],
    ['编辑器加载失败', { kind: 'editor-failed', error: new Error('x') } as const, '编辑器加载失败，请刷新页面重试'],
    ['请求失败', { kind: 'failed', error: new NetworkError('断网') } as const, '表格加载失败：网络连接失败，请检查网络后重试'],
  ])('%s', (_case, load, text) => {
    renderChrome({ load, mode: undefined, save: undefined })
    expect(screen.getByRole('alert')).toHaveTextContent(text)
  })

  it('请求失败的说明带请求标识', () => {
    renderChrome({ load: { kind: 'failed', error: new ApiError(503, 'SERVICE_UNAVAILABLE', 'x', { requestId: 'req-7' }) }, mode: undefined, save: undefined })
    expect(screen.getByText('请求标识：req-7')).toBeInTheDocument()
  })
})

describe('阅读（M3-P2 设计 §3.4：打开即阅读）', () => {
  it('能编辑：有"编辑"，点了进入编辑；没有保存与退出编辑；页头的状态是空的', () => {
    const { page } = renderChrome({ mode: READING, save: undefined })
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    expect(page.enterEditing).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
    expect(screen.queryByRole('button', { name: '退出编辑' })).toBeNull()
    expect(headerStatus()).toBeEmptyDOMElement()
  })

  it('只能查看：说"只能查看"，没有"编辑"', () => {
    renderChrome({ mode: { ...READING, canEdit: false }, save: undefined })
    expect(headerStatus()).toHaveTextContent('只能查看')
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull()
  })

  it('进入编辑中、退出编辑中、失去编辑权的过程中：页头说明正在做；进入、退出中的按钮留着、都不可用（说正在进入、正在退出），失去编辑权的过程中没有按钮', () => {
    /** 页头里的按钮：文字与是否可用 */
    const buttons = (): (string | null)[][] => within(screen.getByRole('banner')).queryAllByRole('button').map(button => [button.textContent, button.getAttribute('aria-disabled')])
    const fake = renderChrome({ mode: { kind: 'entering' }, save: undefined })
    expect(headerStatus()).toHaveTextContent('正在进入编辑…')
    expect(buttons()).toEqual([['正在进入编辑…', 'true']])
    fake.set({ mode: { kind: 'exiting', cause: 'exit' }, save: CLEAN })
    expect(headerStatus()).toHaveTextContent('正在退出编辑…')
    expect(buttons()).toEqual([['保存', 'true'], ['正在退出编辑…', 'true']])
    fake.set({ mode: { kind: 'losing', loss: { kind: 'denied', error: new ApiError(403, 'PERMISSION_DENIED', 'x') } }, save: undefined })
    expect(headerStatus()).toHaveTextContent('编辑权已失效，正在保留本页的内容…')
    expect(buttons()).toEqual([])
  })

  it('会话不是本人（没有人登录、换了人）时"编辑"不可用（点了由页面先向服务端确认，审查 A10）；正在载入最新的版本时也不可用（审查 A1）', () => {
    const fake = renderChrome({ mode: READING, save: undefined, session: 'signed-out' })
    const enter = screen.getByRole('button', { name: '编辑' })
    expect(enter).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(enter)
    expect(fake.page.enterEditing).toHaveBeenCalledOnce()
    fake.set({ session: 'other-user' })
    expect(enter).toHaveAttribute('aria-disabled', 'true')
    fake.set({ session: 'active' })
    expect(enter).toHaveAttribute('aria-disabled', 'false')
    fake.set({ mode: { ...READING, update: 'loading' } })
    expect(screen.getByRole('button', { name: '编辑' })).toHaveAttribute('aria-disabled', 'true')
  })

  it('点了"编辑"、要先向服务端确认会话（审查 A10）：确认期间"编辑"不可用、标为进行中（同一个按钮、文字不变，焦点还在它上面），页头说正在确认登录状态——与按保存时的确认相同（复验 C8）；确认之后进入编辑时才说正在进入', () => {
    const fake = renderChrome({ mode: READING, save: undefined })
    const enter = screen.getByRole('button', { name: '编辑' })
    enter.focus()
    fake.set({ confirmingSession: true })
    expect(screen.getByRole('button', { name: '编辑' })).toBe(enter)
    expect(enter).toHaveAttribute('aria-disabled', 'true')
    expect(enter).toHaveAttribute('aria-busy', 'true')
    expect(headerStatus()).toHaveTextContent('正在确认登录状态…')
    expect(document.activeElement).toBe(enter)
    // 确认是本人：随即进入编辑
    fake.set({ confirmingSession: false, mode: { kind: 'entering' } })
    expect(screen.getByRole('button', { name: '正在进入编辑…' })).toBe(enter)
    expect(headerStatus()).toHaveTextContent('正在进入编辑…')
    // 另一次：确认之后没有人登录了——不进入，"编辑"不再标为进行中（会话不是本人，仍不可用），页头不再说正在确认
    fake.set({ mode: READING, confirmingSession: true })
    fake.set({ confirmingSession: false, session: 'signed-out' })
    expect(screen.getByRole('button', { name: '编辑' })).toBe(enter)
    expect(enter).toHaveAttribute('aria-busy', 'false')
    expect(enter).toHaveAttribute('aria-disabled', 'true')
    expect(headerStatus()).toBeEmptyDOMElement()
  })

  it('有更新、正在载入：读屏状态区里也说（页头的按钮之外，审查 A6）；有人在编辑时接在后面；没有更新了随之不说', () => {
    const fake = renderChrome({ mode: { ...READING, update: 'available' }, save: undefined })
    const region = infoRegion()
    expect(region).toHaveTextContent('这份文档有更新的版本')
    fake.set({ mode: { ...READING, update: 'loading' } })
    expect(infoRegion()).toBe(region)
    expect(region).toHaveTextContent('正在载入最新的版本…')
    fake.set({ mode: { ...READING, update: 'available', holder: { holder: AMY, sameUser: false, lastActiveMinutes: 2 } } })
    expect(region).toHaveTextContent('@amy 艾米 正在编辑这份文档（最后活动 2 分钟前），你现在只能阅读 这份文档有更新的版本')
    fake.set({ mode: READING })
    expect(region).toBeEmptyDOMElement()
  })

  it('本页刚退出编辑、没能确认放掉编辑权时读到"自己在别处编辑"：如实说是本页刚退出（审查 A13），不说成另一个标签页或设备；这一页可以直接"在此编辑"', () => {
    const fake = renderChrome({ mode: { ...READING, holder: { holder: AMY, sameUser: true, lastActiveMinutes: 0 }, selfHolder: 'elsewhere', releaseUnconfirmed: true }, save: undefined })
    expect(infoRegion().textContent).toBe('本页刚退出编辑，编辑权还没能确认放掉：最多 90 秒后自动结束，这期间别人还不能编辑；这一页可以直接点"在此编辑"')
    expect(screen.getByRole('button', { name: '在此编辑' })).toBeInTheDocument()
    fake.set({ mode: { ...READING, holder: { holder: AMY, sameUser: true, lastActiveMinutes: 0 }, selfHolder: 'elsewhere', releaseUnconfirmed: false } })
    expect(infoRegion()).toHaveTextContent('你在另一台设备或浏览器上正在编辑这份文档（也可能是刚关闭、刷新过的页面）')
  })

  it('与服务端不兼容的阅读（没有"编辑"）读到"自己在别处编辑"：照样说是本页刚退出或在别处，不提"在此编辑"（M3-P3 审查 B8：停住续租之后的那次释放没送到）', () => {
    const self = { holder: AMY, sameUser: true, lastActiveMinutes: 0 }
    const fake = renderChrome({ mode: { ...READING, blocked: 'client-outdated', holder: self, selfHolder: 'elsewhere', releaseUnconfirmed: true }, save: undefined })
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull()
    expect(screen.queryByRole('button', { name: '在此编辑' })).toBeNull()
    expect(infoRegion().textContent).toBe('本页刚退出编辑，编辑权还没能确认放掉：最多 90 秒后自动结束，这期间别人还不能编辑')
    fake.set({ mode: { ...READING, blocked: 'client-outdated', holder: self, selfHolder: 'elsewhere', releaseUnconfirmed: false } })
    expect(infoRegion().textContent).toBe('你在另一台设备或浏览器上正在编辑这份文档（也可能是刚关闭、刷新过的页面），这里只能阅读')
    fake.set({ mode: { ...READING, blocked: 'client-outdated', holder: self, selfHolder: 'this-browser', releaseUnconfirmed: false } })
    expect(infoRegion().textContent).toBe('你在本浏览器的另一个标签页里正在编辑这份文档，这里只能阅读')
  })

  it('别人正在编辑：读屏状态区说明谁（人名组件，登录名在前）、最后活动几分钟之前；状态区一直在，内容变化时往里填（规范 §2.4）', () => {
    const fake = renderChrome({ load: { kind: 'loading' }, mode: undefined, save: undefined })
    const region = infoRegion()
    expect(region).toBeEmptyDOMElement()
    fake.set({ load: READY, mode: { ...READING, holder: { holder: AMY, sameUser: false, lastActiveMinutes: 3 } } })
    expect(infoRegion()).toBe(region)
    expect(region).toHaveTextContent('@amy 艾米 正在编辑这份文档（最后活动 3 分钟前），你现在只能阅读')
    expect(within(region).getByText('@amy')).toHaveAttribute('data-slot', 'person-username')
    expect(within(region).getByText('艾米').tagName).toBe('BDI')
    // 别人在编辑：没有"编辑"，同一个位置是"请求编辑"（M3-P5 设计 §3.6）
    expect(screen.getByRole('button', { name: '请求编辑' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull()
  })

  it.each([
    ['不到 1 分钟', 0, '@amy 艾米 正在编辑这份文档（最后活动不到 1 分钟前），你现在只能阅读'],
    ['服务端没给出回答的时刻', undefined, '@amy 艾米 正在编辑这份文档，你现在只能阅读'],
  ])('最后活动%s', (_case, minutes, text) => {
    renderChrome({ mode: { ...READING, holder: { holder: AMY, sameUser: false, lastActiveMinutes: minutes } }, save: undefined })
    expect(infoRegion()).toHaveTextContent(text)
  })

  it('是自己（M3-P5 设计 §3.7）：本机锁在本浏览器里有人持有时说在本浏览器的另一个标签页里、点"在此编辑"那边先保存再交出；不在本浏览器时说在另一台设备或浏览器上（也可能是刚关闭、刷新过的页面）、点了那边失去编辑权——不再建议"等 90 秒再点编辑"', () => {
    const self = { holder: AMY, sameUser: true, lastActiveMinutes: 0 }
    const fake = renderChrome({ mode: { ...READING, holder: self, selfHolder: 'this-browser' }, save: undefined })
    expect(infoRegion().textContent).toBe('你在本浏览器的另一个标签页里正在编辑这份文档。点"在此编辑"，那个标签页会先保存，再把编辑权交给这里')
    fake.set({ mode: { ...READING, holder: self, selfHolder: 'elsewhere' } })
    expect(infoRegion().textContent).toBe('你在另一台设备或浏览器上正在编辑这份文档（也可能是刚关闭、刷新过的页面）。点"在此编辑"在这里接着编辑，那边会失去编辑权，没保存的修改可以在那边另存为副本')
    expect(infoRegion()).not.toHaveTextContent('90 秒')
  })

  it('是自己：按钮一律换成"在此编辑"（同一个按钮，不是另加一个），点了交给页面的本人接管，不是"编辑"', () => {
    const fake = renderChrome({ mode: READING, save: undefined })
    const enter = screen.getByRole('button', { name: '编辑' })
    fake.set({ mode: { ...READING, holder: { holder: AMY, sameUser: true, lastActiveMinutes: 0 }, selfHolder: 'this-browser' } })
    expect(screen.getByRole('button', { name: '在此编辑' })).toBe(enter)
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull()
    expect(enter).toHaveAttribute('aria-disabled', 'false')
    fireEvent.click(enter)
    expect(fake.page.takeOverHere).toHaveBeenCalledOnce()
    expect(fake.page.enterEditing).not.toHaveBeenCalled()
    // 持有者是别人：同一个按钮是"请求编辑"（M3-P5 设计 §3.6）；没人在编辑时回到"编辑"
    fake.set({ mode: { ...READING, holder: { holder: AMY, sameUser: false, lastActiveMinutes: 0 } } })
    expect(screen.getByRole('button', { name: '请求编辑' })).toBe(enter)
    fake.set({ mode: READING })
    expect(screen.getByRole('button', { name: '编辑' })).toBe(enter)
  })

  it('没有人在编辑：读屏状态区是空的', () => {
    renderChrome({ mode: { ...READING, holder: undefined }, save: undefined })
    expect(infoRegion()).toBeEmptyDOMElement()
  })

  it('只能查看的人（查看者、归档空间）同样看到谁在编辑、最后活动几分钟之前（US-M3-04 的"其他人"），不说"你现在只能阅读"（页头已经说只能查看），没有"编辑"', () => {
    renderChrome({ mode: { ...READING, canEdit: false, holder: { holder: AMY, sameUser: false, lastActiveMinutes: 1 } }, save: undefined })
    const region = infoRegion()
    expect(region.textContent).toBe('@amy 艾米 正在编辑这份文档（最后活动 1 分钟前）')
    expect(within(region).getByText('@amy')).toHaveAttribute('data-slot', 'person-username')
    expect(within(region).getByText('艾米').tagName).toBe('BDI')
    expect(headerStatus()).toHaveTextContent('只能查看')
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull()
  })

  it('不能编辑了、读到的持有者还是自己（自己那一代随之失效，还没读到新的编辑状态）：照别人一样说谁在编辑，不提"再点编辑就能编辑"', () => {
    renderChrome({ mode: { ...READING, canEdit: false, holder: { holder: AMY, sameUser: true, lastActiveMinutes: 0 } }, save: undefined })
    expect(infoRegion().textContent).toBe('@amy 艾米 正在编辑这份文档（最后活动不到 1 分钟前）')
  })

  it('有更新：页头提示"有更新，点击刷新"，点了交给页面；正在载入时标为不可用', () => {
    const fake = renderChrome({ mode: { ...READING, update: 'available' }, save: undefined })
    fireEvent.click(screen.getByRole('button', { name: '有更新，点击刷新' }))
    expect(fake.page.refreshUpdate).toHaveBeenCalledOnce()
    fake.set({ mode: { ...READING, update: 'loading' } })
    expect(screen.getByRole('button', { name: '正在载入最新的版本…' })).toHaveAttribute('aria-disabled', 'true')
  })

  it('读不到这份文档了：说明（显示的是之前打开的内容），没有"编辑"', () => {
    renderChrome({ mode: { ...READING, gone: true, canEdit: false }, save: undefined })
    expect(infoRegion()).toHaveTextContent('你已无法访问这份文档（可能已被删除、移走，或你失去了访问权限），这里显示的是之前打开的内容')
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull()
  })

  it.each([
    ['不能编辑了（403）', { kind: 'denied', error: new ApiError(403, 'PERMISSION_DENIED', '空间已归档，只能查看') } as const, '没能进入编辑：你已没有编辑这份文档的权限（空间已归档，只能查看）'],
    ['网络', { kind: 'enter-failed', error: new NetworkError('断网') } as const, '没能进入编辑：网络连接失败，请检查网络后重试'],
    ['编辑权在建好编辑器之前失效', { kind: 'enter-lost', loss: { kind: 'lease', reason: 'revoked' } } as const, '没能进入编辑：编辑权已失效（你对这份文档的编辑权被收回了）'],
    ['以编辑方式重建失败', { kind: 'editor-failed' } as const, '编辑器没能以编辑方式打开，已回到阅读，可以再试一次'],
    ['有更新之后取不到最新的版本', { kind: 'refresh-failed', error: new NetworkError('断网') } as const, '没能载入最新的版本：网络连接失败，请检查网络后重试'],
  ])('上一次没有成功（%s）：醒目地说明', (_case, notice, text) => {
    renderChrome({ mode: { ...READING, notice }, save: undefined })
    expect(screen.getByRole('alert')).toHaveTextContent(text)
  })

  it('另存为副本成功：读屏状态区说明已另存为副本《…》，链接在新标签页打开它', () => {
    renderChrome({ mode: { ...READING, canEdit: false, notice: { kind: 'copied', document: COPY } }, save: undefined })
    expect(infoRegion()).toHaveTextContent('已另存为副本《周报（冲突副本 2026-10-04 15:30）》。')
    const link = within(infoRegion()).getByRole('link', { name: '打开副本（新标签页）' })
    expect(link).toHaveAttribute('href', `/documents/${COPY.id}`)
    expect(link).toHaveAttribute('target', '_blank')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('阅读时没有人登录了、换了人：不提修改与保存（阅读时没有要保存的，审查 B10）', () => {
    renderChrome({ mode: READING, save: undefined, session: 'signed-out' })
    expect(screen.getByRole('alert')).toHaveTextContent('登录已过期或已在别处退出。请在新的标签页中用同一个账户登录，然后回到这里继续')
    expect(screen.getByRole('alert')).not.toHaveTextContent(/修改|保存/)
    cleanup()
    renderChrome({ mode: READING, save: undefined, session: 'other-user' })
    expect(screen.getByRole('alert')).toHaveTextContent('别的标签页登录了另一个账户。原来的账户重新登录之后，这一页可以接着使用')
  })
})

describe('失去编辑权（M3-P2 设计 §3.4）', () => {
  const DENIED = new ApiError(403, 'PERMISSION_DENIED', '空间已归档，只能查看')
  const NOT_FOUND: LeaseLoss = { kind: 'not-found', error: new ApiError(404, 'NOT_FOUND', '不存在') }

  it('还读得到、有修改：页头说编辑权已失效；说明原因，给"另存为副本"与"放弃本页的修改"；没有保存按钮', () => {
    const { page } = renderChrome({ mode: lost({ kind: 'denied', error: DENIED }), save: undefined })
    expect(headerStatus()).toHaveTextContent('编辑权已失效')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('alert').textContent).toContain('编辑权已失效：你已没有编辑这份文档的权限（空间已归档，只能查看）。本页的修改没有保存：可以另存为副本，或者放弃这些修改。')
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '另存为副本' }))
    expect(page.saveCopy).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: '重新加载' })).toBeNull()
  })

  it('放弃本页的修改：先确认（确认框说清后果）；确认了交给页面，取消就不放弃', async () => {
    const { page } = renderChrome({ mode: lost({ kind: 'newer' }), save: undefined })
    fireEvent.click(screen.getByRole('button', { name: '放弃本页的修改' }))
    const dialog = await screen.findByRole('dialog', { name: '放弃本页的修改？' })
    expect(dialog).toHaveTextContent('本页没有保存的修改会被丢弃，页面改为显示服务端的最新版本')
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(page.discard).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '放弃本页的修改' }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: '放弃本页的修改？' })).getByRole('button', { name: '放弃修改' }))
    await waitFor(() => expect(page.discard).toHaveBeenCalledOnce())
  })

  it('另存为副本进行中、失败：按钮标为进行中；失败时说明原因，本页的内容还在、可以再试', () => {
    const fake = renderChrome({ mode: lost({ kind: 'newer' }, { copy: { kind: 'saving' } }), save: undefined })
    expect(screen.getByRole('button', { name: '正在另存为副本…' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('button', { name: '放弃本页的修改' })).toHaveAttribute('aria-disabled', 'true')
    fake.set({ mode: lost({ kind: 'newer' }, { copy: { kind: 'failed', error: new NetworkError('断网') } }) })
    expect(screen.getByRole('alert')).toHaveTextContent('没能另存为副本：网络连接失败，请检查网络后重试。本页的内容还在，可以再试一次')
    expect(screen.getByRole('button', { name: '另存为副本' })).toHaveAttribute('aria-disabled', 'false')
  })

  it('副本因本页过旧被拒（CLIENT_OUTDATED，再试也一样，审查 B3）：说明不能另存为副本、先把内容复制出来再重新加载；不给副本与放弃，不说"可以再试"，"重新加载"是整页的', () => {
    const outdated = new ApiError(409, 'CLIENT_OUTDATED', '页面的版本过旧')
    const { page } = renderChrome({ mode: lost({ kind: 'denied', error: DENIED }, { copy: { kind: 'refused', refusal: 'outdated', error: outdated } }), save: undefined })
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe('编辑权已失效：你已没有编辑这份文档的权限（空间已归档，只能查看）。本页的修改没有保存。页面的版本过旧，不能另存为副本。需要的话先把内容复制出来，再重新加载页面重新加载')
    expect(alert).not.toHaveTextContent('可以再试')
    expect(screen.queryByRole('button', { name: '另存为副本' })).toBeNull()
    expect(screen.queryByRole('button', { name: '放弃本页的修改' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    expect(page.reload).toHaveBeenCalledOnce()
    expect(page.discard).not.toHaveBeenCalled()
  })

  it.each([
    ['链接的规则', new ApiError(422, 'SNAPSHOT_INVALID', '快照不合格', { details: { rule: 'link-address' } }), '没能另存为副本：表格里有不能保存的链接。这份内容不能另存为副本，需要的话先把内容复制出来，或者放弃这些修改'],
    ['认不出的规则', new ApiError(422, 'SNAPSHOT_INVALID', '快照不合格', { details: { rule: 'later-rule' } }), '没能另存为副本：表格内容的格式不正确。这份内容不能另存为副本'],
    ['超过容量上限', new ApiError(413, 'PAYLOAD_TOO_LARGE', '太大'), '没能另存为副本：表格超过容量上限（5 MiB）。这份内容不能另存为副本'],
  ])('副本因内容被拒（%s，再试也一样，审查 B3）：按规则说明，不说"可以再试"；不再给副本，给放弃', (_case, error, text) => {
    renderChrome({ mode: lost({ kind: 'newer' }, { copy: { kind: 'refused', refusal: 'content', error } }), save: undefined })
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(text)
    expect(alert).toHaveTextContent('本页的修改没有保存。')
    expect(alert).not.toHaveTextContent('可以另存为副本')
    expect(alert).not.toHaveTextContent('可以再试')
    expect(screen.queryByRole('button', { name: '另存为副本' })).toBeNull()
    expect(screen.getByRole('button', { name: '放弃本页的修改' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重新加载' })).toBeNull()
  })

  it('副本被拒、编辑器又没能重新打开：不说"另存为副本照常可用"', () => {
    renderChrome({ mode: lost({ kind: 'newer' }, { reopenFailed: true, copy: { kind: 'refused', refusal: 'content', error: new ApiError(413, 'PAYLOAD_TOO_LARGE', '太大') } }), save: undefined })
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('编辑器没能重新打开，表格暂时显示不出来')
    expect(alert).not.toHaveTextContent('另存为副本照常可用')
  })

  it('正在核对结果未知的那次保存：先说明在核对，不给副本与放弃', () => {
    renderChrome({ mode: lost({ kind: 'denied', error: DENIED }, { checking: true }), save: undefined })
    expect(screen.getByRole('alert')).toHaveTextContent('正在核对最后一次保存的结果…')
    expect(screen.queryByRole('button', { name: '另存为副本' })).toBeNull()
    expect(screen.queryByRole('button', { name: '放弃本页的修改' })).toBeNull()
  })

  it('没有修改（或核对出那次保存其实已经提交）：说本页的修改都已保存，给"重新加载"（按最新的内容回到阅读）', () => {
    const { page } = renderChrome({ mode: lost({ kind: 'lease', reason: 'revoked' }, { unsaved: false }), save: undefined })
    expect(screen.getByRole('alert').textContent).toContain('编辑权已失效：你对这份文档的编辑权被收回了。本页的修改都已保存，重新加载可以看到最新的版本。')
    expect(screen.getByRole('alert')).not.toHaveTextContent('没有保存')
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    expect(page.discard).toHaveBeenCalledOnce()
    expect(page.reload).not.toHaveBeenCalled()
  })

  it('读不到了（404）、有修改：说明本页的修改不能再保存到这份文档、需要的话先复制出来；不给副本、不提重新加载，也不提登录（审查 B2）', () => {
    renderChrome({ mode: lost(NOT_FOUND), save: undefined, session: 'signed-out' })
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('alert').textContent).toBe('编辑权已失效：你已无法访问这份文档（可能已被删除、移走，或你失去了访问权限）。本页的修改没有保存，也不能再保存到这份文档，需要的话先把内容复制出来。')
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByRole('link', { name: '我的空间' })).toHaveAttribute('href', '/')
  })

  it('读不到了（404）、没有修改：只说本页的修改都已保存', () => {
    renderChrome({ mode: lost(NOT_FOUND, { unsaved: false }), save: undefined })
    expect(screen.getByRole('alert').textContent).toBe('编辑权已失效：你已无法访问这份文档（可能已被删除、移走，或你失去了访问权限）。本页的修改都已保存。')
  })

  it('另存为副本之后取最新的内容失败：说明已另存为副本（链接在新标签页打开）与没能载入的原因，可以重新加载', () => {
    const { page } = renderChrome({ mode: lost({ kind: 'newer' }, { copy: { kind: 'done', document: COPY }, reload: { kind: 'failed', error: new NetworkError('断网') } }), save: undefined })
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('已另存为副本《周报（冲突副本 2026-10-04 15:30）》。')
    expect(alert).toHaveTextContent('没能载入最新的版本：网络连接失败，请检查网络后重试')
    expect(alert).not.toHaveTextContent('本页的修改没有保存')
    expect(within(alert).getByRole('link', { name: '打开副本（新标签页）' })).toHaveAttribute('target', '_blank')
    expect(screen.queryByRole('button', { name: '另存为副本' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    expect(page.discard).toHaveBeenCalledOnce()
  })

  it('另存为副本之后按最新的内容重建失败（复验 C1）：说明已另存为副本（链接照旧）、编辑器没能重新打开、没能载入最新的版本，可以重新加载；不再给副本，不说"没有保存"', () => {
    const { page } = renderChrome({ mode: lost({ kind: 'denied', error: DENIED }, { reopenFailed: true, copy: { kind: 'done', document: COPY }, reload: { kind: 'failed', error: new Error('按最新的内容重建编辑器失败') } }), save: undefined })
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('本页的修改都已保存，重新加载可以看到最新的版本。')
    expect(alert).toHaveTextContent('编辑器没能重新打开，表格暂时显示不出来')
    expect(alert).not.toHaveTextContent('另存为副本照常可用')
    expect(alert).toHaveTextContent('已另存为副本《周报（冲突副本 2026-10-04 15:30）》。')
    expect(within(alert).getByRole('link', { name: '打开副本（新标签页）' })).toHaveAttribute('href', `/documents/${COPY.id}`)
    expect(alert).toHaveTextContent('没能载入最新的版本：出了点问题，请稍后重试')
    expect(screen.queryByRole('button', { name: '另存为副本' })).toBeNull()
    expect(screen.queryByRole('button', { name: '放弃本页的修改' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    expect(page.discard).toHaveBeenCalledOnce()
  })

  it('本页的内容没能取出（编辑器出错）：说明，需要的话先复制出来；只给整页的重新加载', () => {
    const { page } = renderChrome({ mode: lost({ kind: 'newer' }, { captureFailed: true }), save: undefined })
    expect(screen.getByRole('alert')).toHaveTextContent('本页的修改没能取出（编辑器出了问题）。需要的话先把内容复制出来，再重新加载')
    expect(screen.queryByRole('button', { name: '另存为副本' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    expect(page.reload).toHaveBeenCalledOnce()
  })

  it('编辑器没能重新打开（以只读重建失败，审查 A3）：说明表格暂时显示不出来；还读得到、有修改时说内容已经取出，副本与放弃照常给', () => {
    const { page } = renderChrome({ mode: lost({ kind: 'denied', error: DENIED }, { reopenFailed: true }), save: undefined })
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('本页的修改没有保存：可以另存为副本，或者放弃这些修改。')
    expect(alert).toHaveTextContent('编辑器没能重新打开，表格暂时显示不出来；本页的修改已经取出，另存为副本照常可用')
    fireEvent.click(screen.getByRole('button', { name: '另存为副本' }))
    expect(page.saveCopy).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: '放弃本页的修改' })).toBeInTheDocument()
  })

  it('编辑器没能重新打开、读不到了（404）、有修改：不说"先把内容复制出来"（页面上没有可复制的），只说明', () => {
    renderChrome({ mode: lost(NOT_FOUND, { reopenFailed: true }), save: undefined })
    expect(screen.getByRole('alert').textContent).toBe('编辑权已失效：你已无法访问这份文档（可能已被删除、移走，或你失去了访问权限）。本页的修改没有保存，也不能再保存到这份文档。编辑器没能重新打开，表格暂时显示不出来')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('编辑器没能重新打开、没有修改：说都已保存，给"重新加载"（按最新的内容打开）', () => {
    const { page } = renderChrome({ mode: lost({ kind: 'lease', reason: 'revoked' }, { reopenFailed: true, unsaved: false }), save: undefined })
    expect(screen.getByRole('alert')).toHaveTextContent('本页的修改都已保存，重新加载可以看到最新的版本。编辑器没能重新打开，表格暂时显示不出来')
    expect(screen.getByRole('alert')).not.toHaveTextContent('另存为副本照常可用')
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    expect(page.discard).toHaveBeenCalledOnce()
  })

  it('单元格里正在输入的那一处没能取出（审查 A4）：说明它不在本页的内容与副本里；说没有保存，副本照常给', () => {
    renderChrome({ mode: lost({ kind: 'newer' }, { inputLeft: true }), save: undefined })
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('本页的修改没有保存')
    expect(alert).toHaveTextContent('单元格里正在输入的那一处没能取出（编辑器没有提交它），本页的内容里没有它，另存为副本也不含它')
    expect(screen.getByRole('button', { name: '另存为副本' })).toBeInTheDocument()
  })

  /** 各种失效的原因都有自己的说法 */
  const LOSSES: readonly (readonly [string, LeaseLoss, string])[] = [
    ['编辑权被收回', { kind: 'lease', reason: 'revoked' }, '编辑权已失效：你对这份文档的编辑权被收回了。'],
    ['不认识的原因', { kind: 'lease', reason: undefined }, '编辑权已失效。'],
    ['不能编辑了（403，原因由服务端给出）', { kind: 'denied', error: new ApiError(403, 'PERMISSION_DENIED', '只能查看这份文档，不能编辑') }, '编辑权已失效：你已没有编辑这份文档的权限（只能查看这份文档，不能编辑）。'],
    ['续上时别人正在编辑', { kind: 'held', holder: { holder: AMY, sameUser: false, lastActiveMinutes: 2 } }, '编辑权已失效：@amy 艾米 正在编辑这份文档（最后活动 2 分钟前）。'],
    ['续上时自己在别处正在编辑', { kind: 'held', holder: { holder: AMY, sameUser: true, lastActiveMinutes: 0 } }, '编辑权已失效：你在另一个标签页或设备上正在编辑这份文档。'],
    ['续上时被占用、详情认不出', { kind: 'held', holder: undefined }, '编辑权已失效：这份文档正在别处编辑。'],
    ['续上时别处保存过更新的版本', { kind: 'newer' }, '编辑权已失效：编辑权中断期间，别处保存了更新的版本，本页不能再覆盖它。'],
    ['本人在本浏览器的另一个标签页接手了编辑（本机锁被抢，M3-P5）', { kind: 'taken-over', where: 'this-browser' }, '编辑权已失效：你在本浏览器的另一个标签页接手了编辑。本页的修改没有保存：可以另存为副本，或者放弃这些修改。'],
    ['本人在另一台设备或浏览器上接手了编辑（M3-P5：taken_over、forced 为假）', { kind: 'taken-over', where: 'elsewhere' }, '编辑权已失效：你在另一台设备或浏览器上接手了编辑。本页的修改没有保存：可以另存为副本，或者放弃这些修改。'],
    ['强制接管、还没读到接管的人（M3-P5 S8：taken_over、forced 为真；个人空间里是文档的所有者）', { kind: 'forced' }, '编辑权已失效：文档的所有者强制接管了编辑。本页的修改没有保存：可以另存为副本，或者放弃这些修改。'],
    ['强制接管、读到了接管的人（M3-P5 S8）', { kind: 'forced', by: AMY }, '编辑权已失效：文档的所有者 @amy 艾米 强制接管了编辑。本页的修改没有保存：可以另存为副本，或者放弃这些修改。'],
    ['已经交给了请求编辑的人、不知道是谁（M3-P5 S8：交出的回答没收到，之后才得知）', { kind: 'handed-over' }, '编辑权已失效：已交给请求编辑的人。本页的修改没有保存：可以另存为副本，或者放弃这些修改。'],
    ['已经交给了请求编辑的人（M3-P5 S8）', { kind: 'handed-over', to: AMY }, '编辑权已失效：已交给请求编辑的 @amy 艾米。本页的修改没有保存：可以另存为副本，或者放弃这些修改。'],
  ]

  it.each(LOSSES)('原因：%s', (_case, loss, text) => {
    renderChrome({ mode: lost(loss), save: undefined })
    expect(screen.getByRole('alert').textContent).toContain(text)
  })

  it('续上时别人正在编辑：人名经人名组件（登录名在前，显示名隔离）', () => {
    renderChrome({ mode: lost({ kind: 'held', holder: { holder: AMY, sameUser: false, lastActiveMinutes: undefined } }), save: undefined })
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('编辑权已失效：@amy 艾米 正在编辑这份文档。本页的修改没有保存')
    expect(within(alert).getByText('@amy')).toHaveAttribute('data-slot', 'person-username')
    expect(within(alert).getByText('艾米').tagName).toBe('BDI')
  })

  it('还读得到、有修改时换了人或没有人登录：另说明要先登录回来（另存为副本要用本人的登录）', () => {
    renderChrome({ mode: lost({ kind: 'newer' }), save: undefined, session: 'signed-out' })
    expect(screen.getAllByRole('alert')).toHaveLength(2)
    expect(screen.getAllByRole('alert')[1]).toHaveTextContent('登录已过期或已在别处退出。请在新的标签页中用同一个账户登录，然后回到这里继续')
  })
})

describe('模式切换与按钮消失时的焦点（审查 A2，规范 §2.4）', () => {
  function backLink(): HTMLElement {
    return screen.getByRole('link', { name: '我的空间' })
  }

  it('进入编辑中"编辑"不卸载（同一个按钮，说正在进入、标为不可用），焦点还在它上面；没有进入成功（被占用）回到阅读时照旧是它（说"请求编辑"）', () => {
    const fake = renderChrome({ mode: READING, save: undefined })
    const enter = screen.getByRole('button', { name: '编辑' })
    enter.focus()
    fake.set({ mode: { kind: 'entering' } })
    expect(screen.getByRole('button', { name: '正在进入编辑…' })).toBe(enter)
    expect(enter).toHaveAttribute('aria-disabled', 'true')
    expect(enter).toHaveAttribute('aria-busy', 'true')
    expect(document.activeElement).toBe(enter)
    // 被别人占着：同一个按钮换成"请求编辑"（M3-P5），焦点还在它上面
    fake.set({ mode: { ...READING, holder: { holder: AMY, sameUser: false, lastActiveMinutes: 0 } } })
    expect(screen.getByRole('button', { name: '请求编辑' })).toBe(enter)
    expect(enter).toHaveAttribute('aria-disabled', 'false')
    expect(document.activeElement).toBe(enter)
  })

  it('退出编辑中两个按钮都留着（"退出编辑"说正在退出），焦点还在它上面；保存失败、留在编辑时照旧是它', () => {
    const fake = renderChrome({ save: { ...CLEAN, status: 'dirty', unsaved: true } })
    const exit = screen.getByRole('button', { name: '退出编辑' })
    exit.focus()
    fake.set({ mode: { kind: 'exiting', cause: 'exit' }, save: { ...CLEAN, status: 'saving', canSave: false, unsaved: true } })
    expect(screen.getByRole('button', { name: '正在退出编辑…' })).toBe(exit)
    expect(exit).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('button', { name: '保存' })).toHaveAttribute('aria-disabled', 'true')
    expect(document.activeElement).toBe(exit)
    fake.set({ mode: EDITING, save: { ...CLEAN, status: 'failed', unsaved: true, problem: { kind: 'request', error: new NetworkError('断网') } } })
    expect(screen.getByRole('button', { name: '退出编辑' })).toBe(exit)
    expect(document.activeElement).toBe(exit)
  })

  it('"编辑"随权限消失（进入时得到 403）：焦点交给返回链接，不落到 body', async () => {
    const fake = renderChrome({ mode: READING, save: undefined })
    screen.getByRole('button', { name: '编辑' }).focus()
    fake.set({ mode: { kind: 'entering' } })
    fake.set({ mode: { ...READING, canEdit: false, notice: { kind: 'denied', error: new ApiError(403, 'PERMISSION_DENIED', '空间已归档，只能查看') } } })
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(backLink()))
  })

  it('"有更新"在载入之后消失（得知没有变化、或者已经载入）：焦点交给返回链接', async () => {
    const fake = renderChrome({ mode: { ...READING, update: 'available' }, save: undefined })
    const update = screen.getByRole('button', { name: '有更新，点击刷新' })
    update.focus()
    fake.set({ mode: { ...READING, update: 'loading' } })
    expect(document.activeElement).toBe(update)
    fake.set({ mode: READING })
    await waitFor(() => expect(document.activeElement).toBe(backLink()))
  })

  it('失去编辑权时"保存""退出编辑"随之消失：焦点交给返回链接', async () => {
    const fake = renderChrome()
    screen.getByRole('button', { name: '保存' }).focus()
    fake.set({ mode: { kind: 'losing', loss: { kind: 'denied', error: new ApiError(403, 'PERMISSION_DENIED', 'x') } }, save: undefined })
    await waitFor(() => expect(document.activeElement).toBe(backLink()))
  })

  it('副本被拒、再试也一样（审查 B3）："另存为副本"随之消失：焦点交给返回链接，不落到 body', async () => {
    const fake = renderChrome({ mode: lost({ kind: 'newer' }, { copy: { kind: 'saving' } }), save: undefined })
    screen.getByRole('button', { name: '正在另存为副本…' }).focus()
    fake.set({ mode: lost({ kind: 'newer' }, { copy: { kind: 'refused', refusal: 'outdated', error: new ApiError(409, 'CLIENT_OUTDATED', '页面的版本过旧') } }) })
    expect(screen.queryByRole('button', { name: '另存为副本' })).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(backLink()))
  })

  describe('编辑器没能重新打开（以只读重建失败，审查 A3）：焦点从销毁的编辑器落到了 body，交给失效说明里的按钮（复验 C2）', () => {
    const DENIED_LOSS: LeaseLoss = { kind: 'denied', error: new ApiError(403, 'PERMISSION_DENIED', '空间已归档，只能查看') }

    /** 焦点在编辑器里（页头之外的容器）；失去编辑权、可编辑的编辑器随之销毁，焦点落到 body */
    function loseWithFocusInEditor(fake: ReturnType<typeof renderChrome>): void {
      const editorInput = document.createElement('input')
      document.body.append(editorInput)
      editorInput.focus()
      fake.set({ mode: { kind: 'losing', loss: DENIED_LOSS }, save: undefined })
      editorInput.remove()
      expect(document.activeElement).toBe(document.body)
    }

    it('有修改：交给"另存为副本"', () => {
      const fake = renderChrome()
      loseWithFocusInEditor(fake)
      fake.set({ mode: lost(DENIED_LOSS, { reopenFailed: true }) })
      expect(document.activeElement).toBe(screen.getByRole('button', { name: '另存为副本' }))
    })

    it('没有修改：交给"重新加载"', () => {
      const fake = renderChrome()
      loseWithFocusInEditor(fake)
      fake.set({ mode: lost(DENIED_LOSS, { reopenFailed: true, unsaved: false }) })
      expect(document.activeElement).toBe(screen.getByRole('button', { name: '重新加载' }))
    })

    it('正在核对那次保存（还没有按钮）、读不到了（没有按钮）：交给返回链接', () => {
      const fake = renderChrome()
      loseWithFocusInEditor(fake)
      fake.set({ mode: lost(DENIED_LOSS, { reopenFailed: true, checking: true }) })
      expect(document.activeElement).toBe(backLink())
      cleanup()
      const gone = renderChrome()
      loseWithFocusInEditor(gone)
      gone.set({ mode: lost({ kind: 'not-found', error: new ApiError(404, 'NOT_FOUND', '不存在') }, { reopenFailed: true }) })
      expect(document.activeElement).toBe(backLink())
    })

    it('另存为副本之后按最新的内容重建又失败（复验 C1）：焦点已经在返回链接上（副本的按钮消失时交过去的），不抢', () => {
      const fake = renderChrome({ mode: lost(DENIED_LOSS), save: undefined })
      backLink().focus()
      fake.set({ mode: lost(DENIED_LOSS, { reopenFailed: true, copy: { kind: 'done', document: COPY }, reload: { kind: 'failed', error: new Error('按最新的内容重建编辑器失败') } }) })
      expect(document.activeElement).toBe(backLink())
    })

    it('以只读重建成功（重建出来的编辑器自己接焦点）：页头不动焦点', () => {
      const fake = renderChrome()
      loseWithFocusInEditor(fake)
      fake.set({ mode: lost(DENIED_LOSS) })
      expect(document.activeElement).toBe(document.body)
    })
  })

  it('焦点已经被别处接过（例如重建出来的编辑器的输入框）：不抢', async () => {
    const fake = renderChrome({ mode: READING, save: undefined })
    const elsewhere = document.createElement('input')
    document.body.append(elsewhere)
    screen.getByRole('button', { name: '编辑' }).focus()
    fake.set({ mode: { kind: 'entering' } })
    elsewhere.focus()
    fake.set({ mode: EDITING, save: CLEAN })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(document.activeElement).toBe(elsewhere)
    elsewhere.remove()
  })
})

describe('与服务端不兼容与容量（M3-P3 设计 §3.10）', () => {
  it('编辑时本页过旧（保存的状态 outdated）：页头说需要刷新；说明本页的修改没有保存、先复制出来，给"重新加载"；"保存"不可用、不说公式没保存', () => {
    const fake = renderChrome({ save: { ...CLEAN, status: 'outdated', canSave: false, unsaved: true, unsavedEdits: true, formulasPending: true } })
    expect(headerStatus()).toHaveTextContent('需要刷新')
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('页面的版本过旧，本页的修改没有保存，也不能再保存。需要的话先把内容复制出来，再重新加载页面')
    fireEvent.click(within(alert).getByRole('button', { name: '重新加载' }))
    expect(fake.page.reload).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: '保存' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.queryByText(/公式结果尚未保存/)).toBeNull()
  })

  it('编辑时本页过旧、修改都已保存：说明重新加载之后可以接着编辑', () => {
    renderChrome({ save: { ...CLEAN, status: 'outdated', canSave: false, unsaved: false } })
    expect(screen.getByRole('alert')).toHaveTextContent('页面的版本过旧，不能再保存。本页的修改都已保存，重新加载页面之后可以接着编辑')
  })

  it('编辑时本页过旧、修改都已保存，只有公式的结果没有存上（审查 B5）：单说这一句，不说"本页的修改没有保存"', () => {
    renderChrome({ save: { ...CLEAN, status: 'outdated', canSave: false, unsaved: true, unsavedEdits: false, formulasPending: true } })
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('页面的版本过旧，不能再保存。本页的修改都已保存，只是公式的结果没有存上；重新加载页面之后可以接着编辑')
    expect(alert).not.toHaveTextContent('没有保存')
  })

  it('编辑时本页过旧、正在核对结果未知的那次保存（审查 B5）：先说正在核对，不下"有没有保存"的结论；核对出其实已经提交时说都已保存', () => {
    const fake = renderChrome({ save: { ...CLEAN, status: 'outdated', canSave: false, unsaved: true, unsavedEdits: true, checking: true } })
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('页面的版本过旧，不能再保存。正在核对最后一次保存的结果…')
    expect(alert).not.toHaveTextContent('没有保存')
    fake.set({ save: { ...CLEAN, status: 'outdated', canSave: false } })
    expect(screen.getByRole('alert')).toHaveTextContent('本页的修改都已保存，重新加载页面之后可以接着编辑')
  })

  it('编辑时文档由更新的版本保存过（too-new）：页头说不能保存；只说明，不给"重新加载"（重新加载拿到的还是同一个版本）', () => {
    const fake = renderChrome({ save: { ...CLEAN, status: 'too-new', canSave: false, unsaved: true, unsavedEdits: true } })
    expect(headerStatus()).toHaveTextContent('不能保存')
    expect(screen.getByRole('alert')).toHaveTextContent('这份文档由更新的版本保存过，本页的修改不能再保存。需要的话先把内容复制出来')
    expect(screen.queryByRole('button', { name: '重新加载' })).toBeNull()
    // 核对中、只有公式的结果没存上：同样的几种说法（审查 B5）
    fake.set({ save: { ...CLEAN, status: 'too-new', canSave: false, unsaved: true, unsavedEdits: true, checking: true } })
    expect(screen.getByRole('alert')).toHaveTextContent('这份文档由更新的版本保存过，不能再保存。正在核对最后一次保存的结果…')
    fake.set({ save: { ...CLEAN, status: 'too-new', canSave: false, unsaved: true, formulasPending: true } })
    expect(screen.getByRole('alert')).toHaveTextContent('这份文档由更新的版本保存过，当前只能阅读，不能再保存。本页的修改都已保存，只是公式的结果没有存上')
  })

  it('阅读时本页过旧（申请编辑权时得知）：页头说需要刷新，不给"编辑"，说明并给"重新加载"', () => {
    const fake = renderChrome({ mode: { ...READING, blocked: 'client-outdated' }, save: undefined })
    expect(headerStatus()).toHaveTextContent('需要刷新')
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull()
    expect(screen.getByRole('alert')).toHaveTextContent('页面的版本过旧，不能进入编辑。重新加载页面之后再编辑')
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    expect(fake.page.reload).toHaveBeenCalledOnce()
  })

  it('阅读时文档由更新的版本保存过（打开时就看得出）：页头说只能查看，不给"编辑"，说明只能阅读，不提示刷新', () => {
    renderChrome({ mode: { ...READING, blocked: 'document-too-new' }, save: undefined })
    expect(headerStatus()).toHaveTextContent('只能查看')
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull()
    expect(screen.getByText('这份文档由更新的版本保存过，当前只能阅读，不能编辑')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重新加载' })).toBeNull()
  })

  it('不兼容的说明出现、"编辑"随之消失：焦点在"编辑"上时交给返回链接，不落到 body（规范 §2.4）', async () => {
    const fake = renderChrome({ mode: READING, save: undefined })
    screen.getByRole('button', { name: '编辑' }).focus()
    fake.set({ mode: { kind: 'entering' } })
    fake.set({ mode: { ...READING, blocked: 'client-outdated' } })
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('link', { name: '我的空间' })))
  })

  it('快照达到容量的 80%（US-M3-14）：一直在的读屏状态区里给一条不打断的说明（占上限的百分比）；没到、超过上限（由保存失败说明）时不说', () => {
    const fake = renderChrome({ save: { ...CLEAN, snapshotBytes: 4_400_000 } })
    expect(infoRegion()).toHaveTextContent('这份表格已用去容量上限（5 MiB）的 83%，再加内容可能就保存不了了')
    expect(screen.queryByRole('alert')).toBeNull()
    fake.set({ save: { ...CLEAN, snapshotBytes: 4_194_303 } })
    expect(infoRegion()).toHaveTextContent('')
    fake.set({ save: { ...CLEAN, snapshotBytes: 4_194_304 } })
    expect(infoRegion()).toHaveTextContent('80%')
    fake.set({ save: { ...CLEAN, snapshotBytes: 6_000_000, status: 'failed', problem: { kind: 'too-large' } } })
    expect(infoRegion()).toHaveTextContent('')
    expect(screen.getByText('表格超过容量上限（5 MiB），无法保存')).toBeInTheDocument()
  })
})

const ONLINE: AutosaveView = { offline: false, paused: false, retrying: false, held: false }
const DIRTY: SaveView = { ...CLEAN, status: 'dirty', unsaved: true, unsavedEdits: true }
const NETWORK_FAILURE: SaveView = { ...DIRTY, status: 'failed', problem: { kind: 'request', error: new NetworkError('断网') } }

const PAUSED: AutosaveView = { ...ONLINE, paused: true }

describe('编辑时页头的保存状态（M3-P4 设计 §3.9）', () => {
  it.each<[string, SaveView, AutosaveView, string, Partial<EditorPageView>]>([
    ['已保存到云端', CLEAN, ONLINE, '已保存到云端', {}],
    ['有未保存的修改', DIRTY, ONLINE, '有未保存的修改', {}],
    ['保存中', { ...DIRTY, status: 'saving' }, ONLINE, '保存中…', {}],
    ['只差公式的结果', { ...CLEAN, status: 'dirty', formulasPending: true, unsaved: true }, ONLINE, '公式结果尚未保存（算完之后自动保存）', {}],
    ['保存失败、会自动重试', NETWORK_FAILURE, { ...ONLINE, retrying: true }, '保存失败，稍后自动重试', {}],
    ['保存失败、要等新内容', NETWORK_FAILURE, ONLINE, '保存失败', {}],
    ['已离线（M3 没有本机的发件箱：不说已保存在本机）', DIRTY, { ...ONLINE, offline: true }, '已离线：修改还在本页，恢复网络之后自动保存', {}],
    ['暂停（没有人登录）', DIRTY, PAUSED, '暂停保存：登录回来之后自动保存', { session: 'signed-out' }],
    ['暂停（换了人）', DIRTY, PAUSED, '暂停保存：登录回来之后自动保存', { session: 'other-user' }],
    ['暂停（本人在登录中、正在向服务端确认会话：不说"登录回来之后"，审查 A6）', DIRTY, PAUSED, '正在确认登录状态…', {}],
    ['暂停（本人在登录中、确认会话失败：不说"登录回来之后"，审查 A6）', DIRTY, PAUSED, '暂停保存：暂时无法确认登录状态，稍后自动重试', { sessionProblem: new NetworkError('断网') }],
    ['版本冲突', { ...DIRTY, status: 'conflict', canSave: false, conflict: null }, ONLINE, '版本冲突', {}],
    ['需要刷新', { ...DIRTY, status: 'outdated', canSave: false }, ONLINE, '需要刷新', {}],
    ['不能保存', { ...DIRTY, status: 'too-new', canSave: false }, ONLINE, '不能保存', {}],
  ])('%s', (_case, save, autosave, text, view) => {
    renderChrome({ save, autosave, ...view })
    expect(headerStatus()).toHaveTextContent(text)
    expect(headerStatus().textContent).not.toMatch(/本机/)
  })

  it('读屏播暂停时按原因分开（审查 A6）：不是按保存触发的确认进行中不播；确认失败了播"暂时无法确认"；没有人登录时播"登录回来之后"', () => {
    const fake = renderChrome({ save: DIRTY, autosave: ONLINE })
    const spoken = announcement()
    fake.set({ autosave: PAUSED })
    expect(headerStatus()).toHaveTextContent('正在确认登录状态…')
    expect(spoken).toHaveTextContent('')
    fake.set({ sessionProblem: new NetworkError('断网') })
    expect(spoken).toHaveTextContent('暂停保存：暂时无法确认登录状态，稍后自动重试')
    fake.set({ session: 'signed-out' })
    expect(spoken).toHaveTextContent('暂停保存：登录回来之后自动保存')
  })

  it('读屏只播有意义的变化：例行的"有未保存的修改 → 保存中… → 已保存到云端"只改看得见的文字', () => {
    const fake = renderChrome({ save: CLEAN, autosave: ONLINE })
    const spoken = announcement()
    expect(spoken).toHaveTextContent('已保存到云端')
    for (const save of [DIRTY, { ...DIRTY, status: 'saving' } as const, CLEAN, DIRTY, { ...DIRTY, status: 'saving' } as const]) {
      fake.set({ save })
      expect(spoken).toHaveTextContent('已保存到云端')
    }
    expect(headerStatus()).toHaveTextContent('保存中…')
  })

  it('读屏播：失败（自动重试中）；重试期间（保存中）不播；重试成功回到"已保存到云端"时播（从失败恢复）', () => {
    const fake = renderChrome({ save: DIRTY, autosave: ONLINE })
    const spoken = announcement()
    fake.set({ save: NETWORK_FAILURE, autosave: { ...ONLINE, retrying: true } })
    expect(spoken).toHaveTextContent('保存失败，稍后自动重试')
    fake.set({ save: { ...NETWORK_FAILURE, status: 'saving' } })
    expect(spoken).toHaveTextContent('保存失败，稍后自动重试')
    fake.set({ save: DIRTY, autosave: ONLINE })
    expect(spoken).toHaveTextContent('保存失败，稍后自动重试')
    fake.set({ save: CLEAN })
    expect(spoken).toHaveTextContent('已保存到云端')
  })

  it('读屏播：离线与恢复（恢复之后存上时）、暂停、"公式结果尚未保存"与它的结束、终态', () => {
    const fake = renderChrome({ save: DIRTY, autosave: ONLINE })
    const spoken = announcement()
    fake.set({ autosave: { ...ONLINE, offline: true } })
    expect(spoken).toHaveTextContent('已离线：修改还在本页，恢复网络之后自动保存')
    fake.set({ autosave: ONLINE, save: { ...DIRTY, status: 'saving' } })
    expect(spoken).toHaveTextContent('已离线')
    fake.set({ save: CLEAN })
    expect(spoken).toHaveTextContent('已保存到云端')
    fake.set({ save: DIRTY, autosave: PAUSED, session: 'signed-out' })
    expect(spoken).toHaveTextContent('暂停保存：登录回来之后自动保存')
    fake.set({ save: { ...CLEAN, status: 'dirty', formulasPending: true, unsaved: true }, autosave: ONLINE, session: 'active' })
    expect(spoken).toHaveTextContent('公式结果尚未保存（算完之后自动保存）')
    fake.set({ save: CLEAN })
    expect(spoken).toHaveTextContent('已保存到云端')
    fake.set({ save: { ...DIRTY, status: 'conflict', canSave: false, conflict: null } })
    expect(spoken).toHaveTextContent('版本冲突')
  })

  it('播报区里的话 ANNOUNCEMENT_MS 之后清空（不留着过时的话）；之后同样的变化照样播', () => {
    vi.useFakeTimers()
    try {
      const fake = renderChrome({ save: DIRTY, autosave: ONLINE })
      const spoken = announcement()
      fake.set({ save: NETWORK_FAILURE, autosave: { ...ONLINE, retrying: true } })
      expect(spoken).toHaveTextContent('保存失败，稍后自动重试')
      act(() => {
        vi.advanceTimersByTime(ANNOUNCEMENT_MS)
      })
      expect(spoken).toHaveTextContent('')
      expect(headerStatus()).toHaveTextContent('保存失败，稍后自动重试')
      fake.set({ save: CLEAN, autosave: ONLINE })
      expect(spoken).toHaveTextContent('已保存到云端')
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('失败的说明在自动重试期间（保存中、原因留着）不清掉再出现：同一个元素一直在', () => {
    const fake = renderChrome({ save: NETWORK_FAILURE, autosave: { ...ONLINE, retrying: true } })
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('保存失败：网络连接失败')
    fake.set({ save: { ...NETWORK_FAILURE, status: 'saving' } })
    expect(screen.getByRole('alert')).toBe(alert)
    fake.set({ save: NETWORK_FAILURE })
    expect(screen.getByRole('alert')).toBe(alert)
  })

  it('页头的文档详情正在重新取（DEF-045）："重试"说正在重试、不可用，按钮不卸载', () => {
    const fake = renderChrome({ detailProblem: new ApiError(503, 'SERVICE_UNAVAILABLE', '繁忙') })
    const retry = within(screen.getByRole('alert')).getByRole('button', { name: '重试' })
    fake.set({ detailRefreshing: true })
    const retrying = within(screen.getByRole('alert')).getByRole('button', { name: '正在重试…' })
    expect(retrying).toBe(retry)
    expect(retrying).toHaveAttribute('aria-disabled', 'true')
  })
})

describe('阅读页的"公式待更新"（M3-P4 设计 §3.5 第 4 条）', () => {
  it('能编辑的人：一直在的读屏状态区里说明公式结果可能还没更新，进入编辑之后会自动重算并保存（不打断）', () => {
    renderChrome({ mode: { ...READING, formulasPending: true }, save: undefined })
    expect(infoRegion()).toHaveTextContent('这份表格的公式结果可能还没更新（上次保存时公式还没算完），进入编辑之后会自动重算并保存')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('查看者（与服务端不兼容的阅读同样不能进入编辑）：只说前半句', () => {
    const fake = renderChrome({ mode: { ...READING, canEdit: false, formulasPending: true }, save: undefined })
    expect(infoRegion()).toHaveTextContent(/^这份表格的公式结果可能还没更新（上次保存时公式还没算完）$/)
    fake.set({ mode: { ...READING, blocked: 'document-too-new', formulasPending: true } })
    expect(infoRegion()).not.toHaveTextContent('进入编辑之后')
  })

  it('没有标记、读不到了：不说', () => {
    const fake = renderChrome({ mode: READING, save: undefined })
    expect(infoRegion()).not.toHaveTextContent('公式结果')
    fake.set({ mode: { ...READING, gone: true, canEdit: false, formulasPending: true } })
    expect(infoRegion()).not.toHaveTextContent('公式结果')
  })
})

describe('打开自检失败的阅读（M3-P4 设计 §3.12，US-M3-15）', () => {
  /** 数据没能完整载入：截断的筛选，另有保护类的两项（同一个说法） */
  const FILTER_DAMAGED: OpenCheckFailures = [
    { kind: 'parse-threw', resource: 'SHEET_FILTER_PLUGIN', error: 'SyntaxError' },
    { kind: 'resource-emptied', resource: 'SHEET_FILTER_PLUGIN' },
    { kind: 'resource-emptied', resource: 'SHEET_RANGE_PROTECTION_PLUGIN' },
    { kind: 'resource-missing', resource: 'SHEET_WORKSHEET_PROTECTION_PLUGIN' },
  ]
  /** 编辑器没有完整载入：批注的插件没有注册（样本里的批注随之不在了） */
  const NOTE_MISSING: OpenCheckFailures = [{ kind: 'profile-missing-hook', resource: 'SHEET_NOTE_PLUGIN' }, { kind: 'resource-missing', resource: 'SHEET_NOTE_PLUGIN' }]

  function backLink(): HTMLElement {
    return screen.getByRole('link', { name: '我的空间' })
  }

  it('数据不完整、能编辑的人：没有"编辑"，页头只能查看；提示条（role="alert"）说已阻止编辑，哪些部分没能载入（同一个说法只说一次）、继续编辑会让它们丢失、已通知管理员', () => {
    renderChrome({ mode: { ...READING, damaged: FILTER_DAMAGED }, save: undefined })
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull()
    expect(headerStatus()).toHaveTextContent(/^只能查看$/)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('文档数据不完整，已阻止编辑')
    expect(alert).toHaveTextContent('部分数据没能载入（筛选、保护设置），继续编辑会让它们丢失。已通知管理员')
    expect(within(alert).queryByRole('button')).toBeNull()
    expect(infoRegion()).not.toHaveTextContent('部分数据')
  })

  it('数据不完整、查看者：不打断，一直在的读屏状态区里说显示的内容可能不完整；没有提示条', () => {
    renderChrome({ mode: { ...READING, canEdit: false, damaged: FILTER_DAMAGED }, save: undefined })
    expect(infoRegion()).toHaveTextContent(/^文档的部分数据没能载入，显示的内容可能不完整$/)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(headerStatus()).toHaveTextContent(/^只能查看$/)
  })

  it('编辑器没有完整载入（档案不全）：能编辑的人说已阻止编辑、请重新加载页面，给"重新加载"（整页）；查看者不说已阻止编辑', () => {
    const fake = renderChrome({ mode: { ...READING, damaged: NOTE_MISSING }, save: undefined })
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(/^编辑器没有完整载入，已阻止编辑。请重新加载页面重新加载$/)
    fireEvent.click(within(alert).getByRole('button', { name: '重新加载' }))
    expect(fake.page.reload).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull()
    fake.set({ mode: { ...READING, canEdit: false, damaged: NOTE_MISSING } })
    expect(screen.getByRole('alert')).toHaveTextContent(/^编辑器没有完整载入，显示的内容可能不完整。请重新加载页面重新加载$/)
    expect(infoRegion()).not.toHaveTextContent('部分数据')
  })

  it('白名单之外的资源名说成"其他数据"', () => {
    renderChrome({ mode: { ...READING, damaged: [{ kind: 'parse-swallowed', resource: 'SHEET_SOMETHING_NEW_PLUGIN' }] }, save: undefined })
    expect(screen.getByRole('alert')).toHaveTextContent('部分数据没能载入（其他数据）')
  })

  it('"公式待更新"不说进入编辑之后会重算（数据不完整的不能进入编辑）', () => {
    renderChrome({ mode: { ...READING, formulasPending: true, damaged: FILTER_DAMAGED }, save: undefined })
    expect(infoRegion()).toHaveTextContent('这份表格的公式结果可能还没更新（上次保存时公式还没算完）')
    expect(infoRegion()).not.toHaveTextContent('进入编辑之后')
  })

  it('"有更新"重建之后新版通过（damaged 清掉）：说明随之消失，"编辑"回来', () => {
    const fake = renderChrome({ mode: { ...READING, damaged: FILTER_DAMAGED }, save: undefined })
    fake.set({ mode: READING })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: '编辑' })).toBeInTheDocument()
  })

  it('"编辑"随打开自检失败消失（进入编辑时新内容没能完整载入）：焦点交给返回链接，不落到 body', async () => {
    const fake = renderChrome({ mode: READING, save: undefined })
    screen.getByRole('button', { name: '编辑' }).focus()
    fake.set({ mode: { kind: 'entering' } })
    fake.set({ mode: { ...READING, damaged: FILTER_DAMAGED } })
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(backLink()))
  })
})

describe('本人接管："在此编辑"（M3-P5 设计 §3.7、§3.11，US-M3-08）', () => {
  const SELF = { holder: AMY, sameUser: true, lastActiveMinutes: 0 }
  const HERE: ReadingMode = { ...READING, holder: SELF, selfHolder: 'this-browser' }

  /** 页头里的按钮：文字、是否可用、是否进行中 */
  function headerButtons(): (string | null)[][] {
    return within(screen.getByRole('banner')).queryAllByRole('button').map(button => [button.textContent, button.getAttribute('aria-disabled'), button.getAttribute('aria-busy')])
  }

  it('接手进行中：同一个按钮说"正在接手…"、不可用、标为进行中（不卸载，焦点还在它上面）；进展放进一直在的读屏状态区（不新插入 role="status"），刚开始时照旧说谁在编辑', () => {
    const fake = renderChrome({ mode: HERE, save: undefined })
    const button = screen.getByRole('button', { name: '在此编辑' })
    button.focus()
    const region = infoRegion()
    const statusCount = screen.getAllByRole('status').length
    fake.set({ mode: { ...HERE, takeover: { kind: 'preparing' } } })
    expect(screen.getByRole('button', { name: '正在接手…' })).toBe(button)
    expect(headerButtons()).toEqual([['正在接手…', 'true', 'true']])
    expect(region).toHaveTextContent('你在本浏览器的另一个标签页里正在编辑这份文档')
    fake.set({ mode: { ...HERE, takeover: { kind: 'asking' } } })
    expect(infoRegion()).toBe(region)
    expect(region.textContent).toBe('正在请本浏览器的另一个标签页保存并交出编辑权…')
    fake.set({ mode: { ...HERE, selfHolder: 'elsewhere', takeover: { kind: 'waiting-save' } } })
    expect(region.textContent).toBe('上一个页面的保存还在进行，稍后接手…')
    expect(screen.getAllByRole('status')).toHaveLength(statusCount)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.activeElement).toBe(button)
    fireEvent.click(button)
    // 进行中不可用：点了照样交给页面（页面挡住重复的），不改成"编辑"
    expect(fake.page.takeOverHere).toHaveBeenCalledOnce()
    // 申请之后进入编辑：同一个按钮说正在进入
    fake.set({ mode: { kind: 'entering' } })
    expect(screen.getByRole('button', { name: '正在进入编辑…' })).toBe(button)
    expect(document.activeElement).toBe(button)
  })

  it('接手进行中"有更新"不可用（刷新会让接手作废）；等人选时可以', () => {
    const fake = renderChrome({ mode: { ...HERE, update: 'available', takeover: { kind: 'asking' } }, save: undefined })
    expect(screen.getByRole('button', { name: '有更新，点击刷新' })).toHaveAttribute('aria-disabled', 'true')
    fake.set({ mode: { ...HERE, update: 'available', takeover: { kind: 'failed', reason: 'not-saved' } } })
    expect(screen.getByRole('button', { name: '有更新，点击刷新' })).toHaveAttribute('aria-disabled', 'false')
  })

  it.each([
    ['not-saved', '另一个标签页的修改没能保存，没有交出编辑权。'],
    ['conflict', '另一个标签页的修改与别处保存的版本冲突、没能保存，没有交出编辑权。'],
    ['session', '另一个标签页暂时无法确认登录状态、没能保存，没有交出编辑权。'],
    ['not-handed-over', '另一个标签页的修改都已保存，但它在把编辑权交给请求编辑的人时没能交出去，还在编辑。'],
  ] as const)('那边没能交出（%s）：说明原因与两个选择——同一个按钮换成"仍在此编辑"（可用，点了交给页面的本人接管），旁边加"取消"', (reason, text) => {
    const fake = renderChrome({ mode: { ...HERE, takeover: { kind: 'asking' } }, save: undefined })
    const button = screen.getByRole('button', { name: '正在接手…' })
    button.focus()
    fake.set({ mode: { ...HERE, takeover: { kind: 'failed', reason } } })
    expect(screen.getByRole('button', { name: '仍在此编辑' })).toBe(button)
    expect(headerButtons()).toEqual([['仍在此编辑', 'false', 'false'], ['取消', null, null]])
    expect(infoRegion().textContent).toBe(`${text}点"仍在此编辑"在这里接着编辑（那边会失去编辑权，没保存的修改可以在那边另存为副本），或者点"取消"`)
    expect(document.activeElement).toBe(button)
    fireEvent.click(button)
    expect(fake.page.takeOverHere).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(fake.page.cancelTakeOver).toHaveBeenCalledOnce()
  })

  it('选了"取消"："取消"随之消失、焦点在它上面时交给返回链接（不落到 body）；按钮回到"在此编辑"，说明回到谁在编辑', async () => {
    const fake = renderChrome({ mode: { ...HERE, takeover: { kind: 'failed', reason: 'not-saved' } }, save: undefined })
    screen.getByRole('button', { name: '取消' }).focus()
    fake.set({ mode: HERE })
    expect(screen.queryByRole('button', { name: '取消' })).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('link', { name: '我的空间' })))
    expect(screen.getByRole('button', { name: '在此编辑' })).toHaveAttribute('aria-disabled', 'false')
    expect(infoRegion()).toHaveTextContent('你在本浏览器的另一个标签页里正在编辑这份文档')
  })

  it('本页交给了本浏览器的另一个标签页：说明放进一直在的读屏状态区（不是提示条），放在最前面；之后的检查读到自己在本浏览器的另一个标签页编辑时一起说', () => {
    const fake = renderChrome({ mode: { kind: 'exiting', cause: 'handover-tab' }, save: CLEAN })
    const region = infoRegion()
    fake.set({ mode: { ...READING, notice: { kind: 'handed-over-tab' } }, save: undefined })
    expect(infoRegion()).toBe(region)
    expect(region.textContent).toBe('已交给本浏览器的另一个标签页')
    expect(screen.queryByRole('alert')).toBeNull()
    fake.set({ mode: { ...HERE, notice: { kind: 'handed-over-tab' } } })
    expect(region.textContent).toBe('已交给本浏览器的另一个标签页 你在本浏览器的另一个标签页里正在编辑这份文档。点"在此编辑"，那个标签页会先保存，再把编辑权交给这里')
  })
})

describe('离开编辑与空闲释放（M3-P5 设计 §3.10、§3.11）', () => {
  /** 页头里的按钮：文字、是否可用、是否进行中 */
  function headerButtons(): (string | null)[][] {
    return within(screen.getByRole('banner')).queryAllByRole('button').map(button => [button.textContent, button.getAttribute('aria-disabled'), button.getAttribute('aria-busy')])
  }

  it('空闲释放的过程中：页头说 10 分钟没有操作、正在保存并释放编辑权；两个按钮留着、都不可用，"退出编辑"不说正在退出（不是按了它）', () => {
    renderChrome({ mode: { kind: 'exiting', cause: 'idle' }, save: CLEAN })
    expect(headerStatus()).toHaveTextContent('10 分钟没有操作，正在保存并释放编辑权…')
    expect(headerButtons()).toEqual([['保存', 'true', 'false'], ['退出编辑', 'true', 'false']])
    expect(announcement()).toHaveTextContent('10 分钟没有操作，正在保存并释放编辑权…')
  })

  it('退出编辑的过程中："退出编辑"说正在退出、标为进行中（对照）', () => {
    renderChrome({ mode: { kind: 'exiting', cause: 'exit' }, save: CLEAN })
    expect(headerStatus()).toHaveTextContent('正在退出编辑…')
    expect(headerButtons()).toEqual([['保存', 'true', 'false'], ['正在退出编辑…', 'true', 'true']])
  })

  it.each(['handover-request', 'handover-tab'] as const)('交出的过程中（%s，S6、S7 接上）：页头说正在保存并交出编辑权', (cause) => {
    renderChrome({ mode: { kind: 'exiting', cause }, save: CLEAN })
    expect(headerStatus()).toHaveTextContent('正在保存并交出编辑权…')
    expect(headerButtons()).toEqual([['保存', 'true', 'false'], ['退出编辑', 'true', 'false']])
  })

  it('空闲释放之后：说明放进一直在的读屏状态区（不新插入 role="status"，不是提示条），放在最前面；之后的检查读到有人在编辑时一起说', () => {
    const fake = renderChrome({ mode: { kind: 'editing' }, save: CLEAN })
    const region = infoRegion()
    const statusCount = screen.getAllByRole('status').length
    fake.set({ mode: { ...READING, notice: { kind: 'idle-released' } }, save: undefined })
    expect(infoRegion()).toBe(region)
    expect(region.textContent).toBe('10 分钟没有操作，已保存并释放编辑权')
    expect(screen.getAllByRole('status')).toHaveLength(statusCount)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: '编辑' })).toBeInTheDocument()
    fake.set({ mode: { ...READING, notice: { kind: 'idle-released' }, holder: { holder: AMY, sameUser: false, lastActiveMinutes: 0 }, formulasPending: true } })
    expect(region.textContent).toBe('10 分钟没有操作，已保存并释放编辑权 @amy 艾米 正在编辑这份文档（最后活动不到 1 分钟前），你现在只能阅读 这份表格的公式结果可能还没更新（上次保存时公式还没算完），进入编辑之后会自动重算并保存')
  })

  it('空闲释放的过程中有焦点的"退出编辑"随回到阅读消失：焦点交给返回链接，不落到 body', async () => {
    const fake = renderChrome({ mode: { kind: 'editing' }, save: CLEAN })
    const exit = screen.getByRole('button', { name: '退出编辑' })
    exit.focus()
    fake.set({ mode: { kind: 'exiting', cause: 'idle' }, save: CLEAN })
    expect(document.activeElement).toBe(exit)
    fake.set({ mode: { ...READING, notice: { kind: 'idle-released' } }, save: undefined })
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('link', { name: '我的空间' })))
  })
})

describe('请求编辑与交出（M3-P5 设计 §3.6，US-M3-06）', () => {
  const BEN = { id: '0199a2c4-0000-7000-8000-0000000000e2', username: 'ben', displayName: '本' }
  /** 艾米在编辑 */
  const AMY_HOLDS = { holder: AMY, sameUser: false, lastActiveMinutes: 1 }
  const OTHERS: ReadingMode = { ...READING, holder: AMY_HOLDS }
  /** 持有者这一侧：本在请求编辑 */
  const INCOMING: IncomingRequest = { id: '0199a2c4-0000-7000-8000-0000000000f1', requester: BEN, declining: false, failure: undefined }
  const WAITING_TEXT = '已请求编辑，等待 @amy 艾米 回应。@amy 艾米 停下操作 2 分钟后会自动保存并交给你；你也可以取消请求'
  const ANNOUNCEMENT = '@ben 本 请求编辑这份文档，可以在页头下方选择"交出"或"继续编辑"'

  /** 有人请求编辑时的提示（带标题的分组） */
  function prompt(): HTMLElement {
    return screen.getByRole('group', { name: '@ben 本 请求编辑这份文档' })
  }

  describe('请求方', () => {
    it('别人在编辑时"请求编辑"，点了交给页面；同一个按钮之后说正在请求（不可用、进行中）、取消请求（可用，点了交给页面的取消）、正在取消；等待时读屏状态区说在等谁（不倒计时）', () => {
      const fake = renderChrome({ mode: OTHERS, save: undefined })
      const button = screen.getByRole('button', { name: '请求编辑' })
      fireEvent.click(button)
      expect(fake.page.requestEditing).toHaveBeenCalledOnce()
      expect(fake.page.enterEditing).not.toHaveBeenCalled()
      button.focus()
      fake.set({ mode: { ...OTHERS, request: { kind: 'sending' } } })
      expect(screen.getByRole('button', { name: '正在请求…' })).toBe(button)
      expect(button).toHaveAttribute('aria-disabled', 'true')
      expect(button).toHaveAttribute('aria-busy', 'true')
      fake.set({ mode: { ...OTHERS, request: { kind: 'waiting', holder: AMY, cancelFailure: undefined } } })
      expect(screen.getByRole('button', { name: '取消请求' })).toBe(button)
      expect(button).toHaveAttribute('aria-disabled', 'false')
      expect(button).toHaveAttribute('aria-busy', 'false')
      expect(infoRegion().textContent).toBe(WAITING_TEXT)
      expect(within(infoRegion()).getAllByText('@amy')[0]).toHaveAttribute('data-slot', 'person-username')
      fireEvent.click(button)
      expect(fake.page.cancelRequest).toHaveBeenCalledOnce()
      expect(fake.page.requestEditing).toHaveBeenCalledOnce()
      fake.set({ mode: { ...OTHERS, request: { kind: 'cancelling', holder: AMY } } })
      expect(screen.getByRole('button', { name: '正在取消…' })).toBe(button)
      expect(button).toHaveAttribute('aria-busy', 'true')
      expect(infoRegion().textContent).toBe(WAITING_TEXT)
      // 取消了：同一个按钮回到"请求编辑"，焦点一直在它上面，说明回到谁在编辑
      fake.set({ mode: OTHERS })
      expect(screen.getByRole('button', { name: '请求编辑' })).toBe(button)
      expect(document.activeElement).toBe(button)
      expect(infoRegion()).toHaveTextContent('@amy 艾米 正在编辑这份文档')
    })

    it('正在载入最新的版本时"请求编辑"不可用；等待中"取消请求"照样可用（与重建无关）', () => {
      const fake = renderChrome({ mode: { ...OTHERS, update: 'loading' }, save: undefined })
      expect(screen.getByRole('button', { name: '请求编辑' })).toHaveAttribute('aria-disabled', 'true')
      fake.set({ mode: { ...OTHERS, update: 'loading', request: { kind: 'waiting', holder: AMY, cancelFailure: undefined } } })
      expect(screen.getByRole('button', { name: '取消请求' })).toHaveAttribute('aria-disabled', 'false')
    })

    it('没人在编辑时（等待中持有者的页面不在了）：说在等正在编辑的人，不说是谁', () => {
      renderChrome({ mode: { ...READING, request: { kind: 'waiting', holder: undefined, cancelFailure: undefined } }, save: undefined })
      expect(infoRegion().textContent).toBe('已请求编辑，等待正在编辑的人回应；你也可以取消请求')
    })

    it('没取消成：说明原因（请求还在），按钮仍是"取消请求"', () => {
      renderChrome({ mode: { ...OTHERS, request: { kind: 'waiting', holder: AMY, cancelFailure: new NetworkError('断网') } }, save: undefined })
      expect(infoRegion().textContent).toBe(`${WAITING_TEXT} 没能取消请求：网络连接失败，请检查网络后重试。请求还在，可以再点"取消请求"`)
      expect(screen.getByRole('button', { name: '取消请求' })).toHaveAttribute('aria-disabled', 'false')
    })

    it('交给了本页、页面在后台（granted）：说明回到这一页时进入编辑，按钮是"取消请求"、点了就取消（审查 B7 的 C03）', () => {
      const fake = renderChrome({ mode: { ...OTHERS, request: { kind: 'granted', until: 'visible' } }, save: undefined })
      expect(infoRegion().textContent).toBe('可以进入编辑了：回到这一页时自动进入编辑')
      fireEvent.click(screen.getByRole('button', { name: '取消请求' }))
      expect(fake.page.cancelRequest).toHaveBeenCalledOnce()
      expect(fake.page.requestEditing).not.toHaveBeenCalled()
    })

    it('交给了本页、页面看得见、这一刻进入不了（会话不是本人、正在载入新的版本）：不说"回到这一页时"，说稍后自动进入（审查 B11）', () => {
      renderChrome({ mode: { ...OTHERS, request: { kind: 'granted', until: 'ready' } }, save: undefined })
      expect(infoRegion().textContent).toBe('可以进入编辑了：稍后自动进入编辑')
      expect(screen.getByRole('button', { name: '取消请求' })).toBeInTheDocument()
    })

    it('本人在别的页面、设备上发出、正在等的请求（审查 B2）：读屏状态区在谁在编辑之后说一句，按钮照旧是"请求编辑"（再点就成为发出过的页面）；本页有请求时不说', () => {
      const fake = renderChrome({ mode: { ...OTHERS, requestedElsewhere: true }, save: undefined })
      expect(infoRegion().textContent).toBe('@amy 艾米 正在编辑这份文档（最后活动 1 分钟前），你现在只能阅读 你已在别处请求编辑这份文档')
      expect(screen.getByRole('button', { name: '请求编辑' })).toHaveAttribute('aria-disabled', 'false')
      fake.set({ mode: { ...OTHERS, requestedElsewhere: true, request: { kind: 'waiting', holder: AMY, cancelFailure: undefined } } })
      expect(infoRegion().textContent).toBe(WAITING_TEXT)
    })

    it('只能查看的人：别人在编辑时没有"请求编辑"', () => {
      renderChrome({ mode: { ...OTHERS, canEdit: false }, save: undefined })
      expect(screen.queryByRole('button', { name: '请求编辑' })).toBeNull()
      expect(screen.queryByRole('button', { name: '编辑' })).toBeNull()
    })

    it.each([
      ['持有者谢绝了（不能强制接管的人另说可以请文档的所有者：个人空间里的文档，M3-P5 S8）', { kind: 'request-declined', holder: AMY }, false, '@amy 艾米 选择继续编辑，你的请求已取消。着急时可以请文档的所有者强制接管'],
      ['持有者谢绝了（能强制接管的人不另说）', { kind: 'request-declined', holder: AMY }, true, '@amy 艾米 选择继续编辑，你的请求已取消'],
      ['别人先请求了', { kind: 'request-occupied', requester: BEN }, false, '@ben 本 已在请求编辑这份文档，你的请求没有发出'],
      ['编辑权刚交给了别人（留到何时：服务端的时刻按页面的时区写成 HH:mm）', { kind: 'reserved', reservedFor: BEN, reservedUntil: new Date(2026, 9, 7, 15, 3, 20).toISOString() }, false, '编辑权刚交给了 @ben 本，留到 15:03'],
      ['请求失效了（也可能是在别的页面取消了，审查 B2）', { kind: 'request-gone' }, false, '你的编辑请求已经失效（可能在别的页面取消了，或者正在编辑的人换了），可以重新请求编辑'],
      ['等待中空闲满 10 分钟', { kind: 'request-idle' }, false, '你 10 分钟没有操作，已取消编辑请求'],
      ['交给了请求编辑的人（人按的）', { kind: 'handed-over', to: BEN, auto: false }, false, '已保存并把编辑权交给了 @ben 本'],
      ['交给了请求编辑的人（空闲满 2 分钟自动交出）', { kind: 'handed-over', to: BEN, auto: true }, false, '你 2 分钟没有操作，已保存并把编辑权交给了 @ben 本'],
    ] as const)('%s：说明放进一直在的读屏状态区（不是提示条），放在最前面', (_case, notice, canTakeOver, text) => {
      const fake = renderChrome({ mode: { kind: 'exiting', cause: 'exit' }, save: CLEAN })
      const region = infoRegion()
      fake.set({ mode: { ...READING, canTakeOver, notice }, save: undefined })
      expect(infoRegion()).toBe(region)
      expect(region.textContent).toBe(text)
      expect(screen.queryByRole('alert')).toBeNull()
      // 之后的检查读到谁在编辑时一起说，结束的说明在前
      fake.set({ mode: { ...OTHERS, canTakeOver, notice } })
      expect(region.textContent).toBe(`${text} @amy 艾米 正在编辑这份文档（最后活动 1 分钟前），你现在只能阅读`)
    })

    it.each([
      ['不能编辑了（403）', { kind: 'request-denied', error: new ApiError(403, 'PERMISSION_DENIED', '空间已归档，只能查看') }, '没能请求编辑：你已没有编辑这份文档的权限（空间已归档，只能查看）'],
      ['网络', { kind: 'request-failed', error: new NetworkError('断网') }, '没能请求编辑：网络连接失败，请检查网络后重试'],
    ] as const)('没能请求编辑（%s）：提示条说明原因', (_case, notice, text) => {
      renderChrome({ mode: { ...OTHERS, notice }, save: undefined })
      expect(screen.getByRole('alert')).toHaveTextContent(text)
    })
  })

  describe('持有者', () => {
    it('有人请求编辑：页头下面一个带标题的分组（名字是"[人名] 请求编辑这份文档"），一行静态说明与"交出""继续编辑"——不是对话框、不是提示条；出现时焦点不动；读屏的那一句在一直在的读屏状态区里（只有它时视觉隐藏）', () => {
      const fake = renderChrome()
      const region = infoRegion()
      const save = screen.getByRole('button', { name: '保存' })
      save.focus()
      fake.set({ mode: { kind: 'editing', request: INCOMING } })
      const group = prompt()
      expect(group).toHaveTextContent('你停下操作 2 分钟后会自动保存并交给对方')
      expect(within(group).getByText('@ben')).toHaveAttribute('data-slot', 'person-username')
      expect(within(group).getAllByRole('button').map(button => button.textContent)).toEqual(['交出', '继续编辑'])
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(screen.queryByRole('alert')).toBeNull()
      expect(group.closest('[role="status"]')).toBeNull()
      expect(document.activeElement).toBe(save)
      expect(infoRegion()).toBe(region)
      expect(region.textContent).toBe(ANNOUNCEMENT)
      expect(region).toHaveClass('sr-only')
      fireEvent.click(within(group).getByRole('button', { name: '交出' }))
      expect(fake.page.handOver).toHaveBeenCalledOnce()
      fireEvent.click(within(group).getByRole('button', { name: '继续编辑' }))
      expect(fake.page.keepEditing).toHaveBeenCalledOnce()
    })

    it('读屏状态区里请求的那一句与别的说明（容量）在一起时照常显示（不视觉隐藏）', () => {
      renderChrome({ mode: { kind: 'editing', request: INCOMING }, save: { ...CLEAN, snapshotBytes: 4_400_000 } })
      expect(infoRegion()).not.toHaveClass('sr-only')
      expect(infoRegion().textContent).toMatch(/^@ben 本 请求编辑这份文档.* 这份表格已用去容量上限/)
    })

    it('谢绝进行中："继续编辑"标为进行中、两个按钮都不可用（焦点不丢）；没成时说明原因、按钮可用', () => {
      const fake = renderChrome({ mode: { kind: 'editing', request: INCOMING } })
      const keep = within(prompt()).getByRole('button', { name: '继续编辑' })
      keep.focus()
      fake.set({ mode: { kind: 'editing', request: { ...INCOMING, declining: true } } })
      expect(keep).toHaveAttribute('aria-busy', 'true')
      expect(keep).toHaveAttribute('aria-disabled', 'true')
      expect(within(prompt()).getByRole('button', { name: '交出' })).toHaveAttribute('aria-disabled', 'true')
      expect(document.activeElement).toBe(keep)
      fake.set({ mode: { kind: 'editing', request: { ...INCOMING, failure: { action: 'decline', error: new NetworkError('断网') } } } })
      expect(prompt()).toHaveTextContent('没能回复请求：网络连接失败，请检查网络后重试。可以再点"继续编辑"')
      expect(keep).toHaveAttribute('aria-disabled', 'false')
      fake.set({ mode: { kind: 'editing', request: { ...INCOMING, failure: { action: 'handover', error: new NetworkError('断网') } } } })
      expect(prompt()).toHaveTextContent('没能交出编辑权：网络连接失败，请检查网络后重试。请求还在，可以再点"交出"')
    })

    it('正在确认会话（按了"交出"或"继续编辑"之后先确认）：两个按钮都不可用，确认完了恢复（审查 B7 的 C05）', () => {
      const fake = renderChrome({ mode: { kind: 'editing', request: INCOMING }, confirmingSession: true })
      const hand = within(prompt()).getByRole('button', { name: '交出' })
      const keep = within(prompt()).getByRole('button', { name: '继续编辑' })
      expect(hand).toHaveAttribute('aria-disabled', 'true')
      expect(keep).toHaveAttribute('aria-disabled', 'true')
      fake.set({ confirmingSession: false })
      expect(hand).toHaveAttribute('aria-disabled', 'false')
      expect(keep).toHaveAttribute('aria-disabled', 'false')
    })

    it('交出的过程中（exiting、handover-request）：提示留着、"交出"说正在交出（不可用、进行中），焦点还在它上面，页头说正在保存并交出；回到阅读之后提示消失、焦点交给返回链接，读屏状态区说交给了谁', async () => {
      const fake = renderChrome({ mode: { kind: 'editing', request: INCOMING } })
      const handOver = within(prompt()).getByRole('button', { name: '交出' })
      handOver.focus()
      fake.set({ mode: { kind: 'exiting', cause: 'handover-request', request: INCOMING } })
      expect(within(prompt()).getByRole('button', { name: '正在交出…' })).toBe(handOver)
      expect(handOver).toHaveAttribute('aria-disabled', 'true')
      expect(handOver).toHaveAttribute('aria-busy', 'true')
      expect(within(prompt()).getByRole('button', { name: '继续编辑' })).toHaveAttribute('aria-disabled', 'true')
      expect(headerStatus()).toHaveTextContent('正在保存并交出编辑权…')
      expect(document.activeElement).toBe(handOver)
      fake.set({ mode: { ...READING, notice: { kind: 'handed-over', to: BEN, auto: false } }, save: undefined })
      expect(screen.queryByRole('group')).toBeNull()
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('link', { name: '我的空间' })))
      expect(infoRegion().textContent).toBe('已保存并把编辑权交给了 @ben 本')
    })

    it('退出编辑的过程中有请求在等：提示留着、按钮都不可用，"交出"不说正在交出（按的是退出）', () => {
      renderChrome({ mode: { kind: 'exiting', cause: 'exit', request: INCOMING } })
      expect(within(prompt()).getByRole('button', { name: '交出' })).toHaveAttribute('aria-busy', 'false')
      expect(within(prompt()).getByRole('button', { name: '交出' })).toHaveAttribute('aria-disabled', 'true')
    })

    it('请求方取消了：提示消失，读屏状态区（照常显示）说一句', () => {
      const fake = renderChrome({ mode: { kind: 'editing', request: INCOMING } })
      fake.set({ mode: { kind: 'editing', request: undefined, notice: { kind: 'request-withdrawn', requester: BEN } } })
      expect(screen.queryByRole('group')).toBeNull()
      expect(infoRegion().textContent).toBe('@ben 本 已取消请求')
      expect(infoRegion()).not.toHaveClass('sr-only')
    })
  })
})

describe('强制接管（M3-P5 设计 §3.8、§3.11，US-M3-09）', () => {
  const BEN = { id: '0199a2c4-0000-7000-8000-0000000000e2', username: 'ben', displayName: '本' }
  /** 艾米在编辑（最后活动 3 分钟前） */
  const AMY_HOLDS = { holder: AMY, sameUser: false, lastActiveMinutes: 3 }
  /** 能强制接管的人在阅读，艾米在编辑 */
  const ADMIN: ReadingMode = { ...READING, canTakeOver: true, holder: AMY_HOLDS }
  /** 团队空间里的文档（能强制接管的是空间管理员） */
  const TEAM: EditorPageReady = { ...READY, space: { id: '0199a2c4-0000-7000-8000-0000000000c1', type: 'team', name: '市场部' } }
  const DAMAGED: OpenCheckFailures = [{ kind: 'resource-missing', resource: 'SHEET_FILTER_PLUGIN' }]

  function forceButton(): HTMLElement {
    return screen.getByRole('button', { name: '强制接管' })
  }

  async function confirmDialog(): Promise<HTMLElement> {
    return screen.findByRole('dialog', { name: '强制接管编辑？' })
  }

  it('能强制接管、别人在编辑："请求编辑"旁边有"强制接管"（outline）；不能强制接管、正在编辑的是自己、没人在编辑、请求编辑或"在此编辑"进行中、不能编辑、读不到了、不兼容、数据不完整时没有', () => {
    const fake = renderChrome({ mode: ADMIN, save: undefined })
    expect(within(screen.getByRole('banner')).getAllByRole('button').map(button => button.textContent)).toEqual(['请求编辑', '强制接管'])
    expect(forceButton()).toHaveAttribute('data-variant', 'outline')
    const without: readonly ReadingMode[] = [
      { ...ADMIN, canTakeOver: false },
      { ...ADMIN, holder: { ...AMY_HOLDS, sameUser: true } },
      { ...ADMIN, holder: undefined },
      { ...ADMIN, request: { kind: 'waiting', holder: AMY, cancelFailure: undefined } },
      { ...ADMIN, request: { kind: 'sending' } },
      { ...ADMIN, takeover: { kind: 'asking' } },
      { ...ADMIN, canEdit: false },
      { ...ADMIN, gone: true },
      { ...ADMIN, blocked: 'client-outdated' },
      { ...ADMIN, damaged: DAMAGED },
    ]
    for (const mode of without) {
      fake.set({ mode })
      expect(screen.queryByRole('button', { name: '强制接管' }), JSON.stringify(mode)).toBeNull()
    }
    fake.set({ mode: ADMIN })
    expect(forceButton()).toBeVisible()
  })

  it('正在载入最新的版本、正在确认会话、会话不是本人时：不可用，点了不打开确认框', () => {
    const fake = renderChrome({ mode: { ...ADMIN, update: 'loading' }, save: undefined })
    for (const next of [{}, { mode: ADMIN, confirmingSession: true }, { confirmingSession: false, session: 'signed-out' as const }]) {
      fake.set(next)
      expect(forceButton()).toHaveAttribute('aria-disabled', 'true')
      fireEvent.click(forceButton())
      expect(screen.queryByRole('dialog')).toBeNull()
    }
    expect(fake.page.forceTakeOver).not.toHaveBeenCalled()
  })

  it('点了先确认：标题、说明（他是谁、最后活动多久之前，强制接管会结束他的编辑权、他没保存的修改不会写进来、可以另存为副本、记入审计）、醒目的确认；取消就不接管，焦点回到"强制接管"', async () => {
    const { page } = renderChrome({ mode: ADMIN, save: undefined })
    const force = forceButton()
    force.focus()
    fireEvent.click(force)
    const dialog = await confirmDialog()
    expect(dialog).toHaveTextContent('@amy \u2068艾米\u2069 正在编辑（最后活动 3 分钟前）。强制接管会立即结束对方的编辑权：对方还没保存的修改不会写进这份文档，可以在自己的页面上另存为副本。这次操作会记入审计。')
    expect(within(dialog).getByRole('button', { name: '强制接管' })).toHaveAttribute('data-variant', 'destructive')
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(page.forceTakeOver).not.toHaveBeenCalled()
    await waitFor(() => expect(document.activeElement).toBe(force))
  })

  it('最后活动多久不知道（服务端没给回答的时刻）：说明里不说', async () => {
    renderChrome({ mode: { ...ADMIN, holder: { ...AMY_HOLDS, lastActiveMinutes: undefined } }, save: undefined })
    fireEvent.click(forceButton())
    expect((await confirmDialog()).textContent).toContain('@amy \u2068艾米\u2069 正在编辑。强制接管会')
  })

  it('确认：确认框关掉、aria-hidden 解除、焦点交还给"强制接管"之后才交给页面——进入编辑与没成功时的说明都写在那之后（规范 §2.4）', async () => {
    const fake = renderChrome({ mode: ADMIN, save: undefined })
    const force = forceButton()
    const seen: { readonly dialog: boolean, readonly hidden: boolean, readonly focused: boolean }[] = []
    vi.mocked(fake.page.forceTakeOver).mockImplementation(async () => {
      seen.push({ dialog: screen.queryByRole('dialog') !== null, hidden: force.closest('[aria-hidden="true"]') !== null, focused: document.activeElement === force })
    })
    force.focus()
    fireEvent.click(force)
    fireEvent.click(within(await confirmDialog()).getByRole('button', { name: '强制接管' }))
    await waitFor(() => expect(fake.page.forceTakeOver).toHaveBeenCalledOnce())
    expect(seen).toEqual([{ dialog: false, hidden: false, focused: true }])
  })

  it('点按钮时焦点不在按钮上（WebKit 点按钮不给焦点，打开时焦点在 body）：关掉之后焦点交给"强制接管"，不留在 body', async () => {
    const fake = renderChrome({ mode: ADMIN, save: undefined })
    ;(document.activeElement as HTMLElement | null)?.blur()
    fireEvent.click(forceButton())
    fireEvent.click(within(await confirmDialog()).getByRole('button', { name: '强制接管' }))
    await waitFor(() => expect(fake.page.forceTakeOver).toHaveBeenCalledOnce())
    expect(document.activeElement).toBe(forceButton())
  })

  it('"强制接管"在确认框开着时随检查消失了（例如他刚退出编辑）：确认之后焦点交给返回链接（不落到 body），照样交给页面', async () => {
    const fake = renderChrome({ mode: ADMIN, save: undefined })
    const force = forceButton()
    force.focus()
    fireEvent.click(force)
    const dialog = await confirmDialog()
    fake.set({ mode: { ...ADMIN, holder: undefined } })
    fireEvent.click(within(dialog).getByRole('button', { name: '强制接管' }))
    await waitFor(() => expect(fake.page.forceTakeOver).toHaveBeenCalledOnce())
    expect(document.activeElement).toBe(screen.getByRole('link', { name: '我的空间' }))
  })

  it('强制接管的进入编辑中：只留"强制接管"、说正在接管（同一个按钮，不可用、进行中），焦点还在它上面；没成功、它还在时焦点还在它上面；它随权限消失时交给返回链接', async () => {
    const fake = renderChrome({ mode: ADMIN, save: undefined })
    const force = forceButton()
    force.focus()
    fake.set({ mode: { kind: 'entering', forced: true } })
    expect(screen.getByRole('button', { name: '正在接管…' })).toBe(force)
    expect(force).toHaveAttribute('aria-disabled', 'true')
    expect(force).toHaveAttribute('aria-busy', 'true')
    expect(within(screen.getByRole('banner')).getAllByRole('button').map(button => button.textContent)).toEqual(['正在接管…'])
    expect(headerStatus()).toHaveTextContent('正在进入编辑…')
    expect(document.activeElement).toBe(force)
    fireEvent.click(force)
    expect(screen.queryByRole('dialog')).toBeNull()
    fake.set({ mode: { ...ADMIN, notice: { kind: 'force-failed', error: new NetworkError('断网') } } })
    expect(forceButton()).toBe(force)
    expect(document.activeElement).toBe(force)
    expect(screen.getByRole('alert')).toHaveTextContent('没能强制接管：网络连接失败，请检查网络后重试')
    fake.set({ mode: { kind: 'entering', forced: true } })
    fake.set({ mode: { ...ADMIN, canTakeOver: false, notice: { kind: 'force-denied', error: new ApiError(403, 'PERMISSION_DENIED', '只有空间管理员能强制接管这份文档的编辑') } } })
    expect(screen.queryByRole('button', { name: '强制接管' })).toBeNull()
    expect(screen.getByRole('alert')).toHaveTextContent('没能强制接管：只有空间管理员能强制接管这份文档的编辑')
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('link', { name: '我的空间' })))
  })

  it('普通的进入编辑中没有"强制接管"', () => {
    renderChrome({ mode: { kind: 'entering' }, save: undefined })
    expect(screen.queryByRole('button', { name: /接管/ })).toBeNull()
    expect(screen.getByRole('button', { name: '正在进入编辑…' })).toBeVisible()
  })

  it('保留期内强制接管被挡：读屏状态区说编辑权刚交给了谁、留到几点（服务端的时刻按页面的时区）、这期间不能强制接管', () => {
    renderChrome({ mode: { ...READING, canTakeOver: true, notice: { kind: 'reserved', reservedFor: BEN, reservedUntil: new Date(2026, 9, 7, 15, 3, 20).toISOString(), forced: true } }, save: undefined })
    expect(infoRegion().textContent).toBe('编辑权刚交给了 @ben 本，留到 15:03，这期间不能强制接管')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('被强制接管：团队空间说空间管理员（读到了接管的人就带上，人名经人名组件），个人空间说文档的所有者', () => {
    const fake = renderChrome({ load: TEAM, mode: lost({ kind: 'forced', by: BEN }), save: undefined })
    expect(screen.getByRole('alert').textContent).toContain('编辑权已失效：空间管理员 @ben 本 强制接管了编辑。本页的修改没有保存：可以另存为副本，或者放弃这些修改。')
    expect(within(screen.getByRole('alert')).getByText('@ben')).toHaveAttribute('data-slot', 'person-username')
    fake.set({ mode: lost({ kind: 'forced' }) })
    expect(screen.getByRole('alert').textContent).toContain('编辑权已失效：空间管理员强制接管了编辑。')
    fake.set({ load: READY })
    expect(screen.getByRole('alert').textContent).toContain('编辑权已失效：文档的所有者强制接管了编辑。')
  })

  it('团队空间里谢绝了：不能强制接管的人另说可以请空间管理员强制接管', () => {
    renderChrome({ load: TEAM, mode: { ...READING, notice: { kind: 'request-declined', holder: AMY } }, save: undefined })
    expect(infoRegion().textContent).toBe('@amy 艾米 选择继续编辑，你的请求已取消。着急时可以请空间管理员强制接管')
  })
})

describe('异常中断的提醒（M3-P5 设计 §3.5、§3.11，US-M3-10）', () => {
  const BEN = { id: '0199a2c4-0000-7000-8000-0000000000e2', username: 'ben', displayName: '本' }
  /** 别人（本）的那一代在今天 14:32 异常中断（按页面的时区） */
  const OTHERS: EditInterruption = { holder: BEN, endedAt: new Date(2026, 9, 7, 14, 32, 10).toISOString(), sameUser: false }
  /** 自己的那一代在 09:05 异常中断 */
  const OWN: EditInterruption = { holder: AMY, endedAt: new Date(2026, 9, 7, 9, 5).toISOString(), sameUser: true }
  const OTHERS_TEXT = '上一位编辑者 @ben 本 的会话在 14:32 异常中断，可能还有未同步的修改'
  const OWN_TEXT = '你上一次的编辑在 09:05 异常中断（例如页面被关闭、断网或电脑休眠），那时还没保存的修改可能没有存上'
  const INCOMING: IncomingRequest = { id: '0199a2c4-0000-7000-8000-0000000000f1', requester: BEN, declining: false, failure: undefined }

  function notice(): HTMLElement {
    const element = document.querySelector<HTMLElement>('[data-slot="interruption-notice"]')
    if (element === null)
      throw new Error('没有异常中断的说明')
    return element
  }

  it('进入编辑时带着提醒：页头下面一条不打断的说明（不是 alert、不是新插入的 status）与"知道了"；出现时焦点不动；同一句话在一直在的读屏状态区里（只有它时视觉隐藏）', () => {
    const fake = renderChrome()
    const region = infoRegion()
    const save = screen.getByRole('button', { name: '保存' })
    save.focus()
    fake.set({ mode: { kind: 'editing', interruption: OTHERS } })
    expect(notice()).toHaveTextContent(OTHERS_TEXT)
    expect(within(notice()).getByText('@ben')).toHaveAttribute('data-slot', 'person-username')
    expect(within(notice()).getByRole('button', { name: '知道了' })).toBeVisible()
    expect(notice().closest('[role]')).toBeNull()
    expect(notice().querySelector('[role="status"], [role="alert"]')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.activeElement).toBe(save)
    expect(infoRegion()).toBe(region)
    expect(region.textContent).toBe(OTHERS_TEXT)
    expect(region).toHaveClass('sr-only')
  })

  it('"知道了"交给页面；说明消失之后焦点交给返回链接（不落到 body），读屏状态区随之清空', async () => {
    const fake = renderChrome({ mode: { kind: 'editing', interruption: OTHERS } })
    const dismiss = within(notice()).getByRole('button', { name: '知道了' })
    dismiss.focus()
    fireEvent.click(dismiss)
    expect(fake.page.dismissInterruption).toHaveBeenCalledOnce()
    fake.set({ mode: { kind: 'editing', interruption: undefined } })
    expect(document.querySelector('[data-slot="interruption-notice"]')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('link', { name: '我的空间' })))
    expect(infoRegion().textContent).toBe('')
  })

  it('自己的那一代：说你上一次的编辑异常中断；与请求的那一句都在时读屏状态区同样视觉隐藏，有别的说明（容量）时照常显示', () => {
    const fake = renderChrome({ mode: { kind: 'editing', interruption: OWN } })
    expect(notice()).toHaveTextContent(OWN_TEXT)
    fake.set({ mode: { kind: 'editing', interruption: OWN, request: INCOMING } })
    expect(infoRegion().textContent).toBe(`${OWN_TEXT} @ben 本 请求编辑这份文档，可以在页头下方选择"交出"或"继续编辑"`)
    expect(infoRegion()).toHaveClass('sr-only')
    fake.set({ save: { ...CLEAN, snapshotBytes: 4_400_000 } })
    expect(infoRegion()).not.toHaveClass('sr-only')
    expect(infoRegion().textContent).toMatch(/^你上一次的编辑在 09:05 异常中断/)
  })

  it('离开编辑的过程中说明留着；回到阅读之后消失', () => {
    const fake = renderChrome({ mode: { kind: 'exiting', cause: 'exit', interruption: OTHERS } })
    expect(notice()).toHaveTextContent(OTHERS_TEXT)
    fake.set({ mode: READING, save: undefined })
    expect(document.querySelector('[data-slot="interruption-notice"]')).toBeNull()
  })

  it('异常中断的时刻离午夜不到 30 分钟（这时"现在"可能已经是第二天）：带日期', () => {
    renderChrome({ mode: { kind: 'editing', interruption: { ...OTHERS, endedAt: new Date(2026, 9, 6, 23, 50).toISOString() } } })
    expect(notice()).toHaveTextContent('上一位编辑者 @ben 本 的会话在 10月6日 23:50 异常中断，可能还有未同步的修改')
  })

  it('阅读时（没人在编辑）：别人的那一代异常中断的说明在读屏状态区里（照常显示），没有页头下面的说明', () => {
    renderChrome({ mode: { ...READING, interruption: OTHERS }, save: undefined })
    expect(infoRegion().textContent).toBe(OTHERS_TEXT)
    expect(infoRegion()).not.toHaveClass('sr-only')
    expect(document.querySelector('[data-slot="interruption-notice"]')).toBeNull()
  })
})
