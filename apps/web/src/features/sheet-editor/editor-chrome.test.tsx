import type { LeaseLoss } from './edit-lease.ts'
import type { EditModeState, LostMode, ReadingMode } from './edit-mode.ts'
import type { EditorPage, EditorPageReady, EditorPageView } from './editor-page.ts'
import type { SaveView } from './save-coordinator.ts'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ApiError, NetworkError } from '../../shared/api/index.ts'
import { apiError, installFakeApi, json } from '../../shared/testing/fake-api.test-support.ts'
import { EditorChrome } from './editor-chrome.tsx'

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
const CLEAN: SaveView = { status: 'clean', formulasPending: false, problem: undefined, conflict: undefined, canSave: true, unsaved: false }
const EDITING: EditModeState = { kind: 'editing' }
const READING: ReadingMode = { kind: 'reading', canEdit: true, holder: undefined, update: 'none', gone: false, notice: undefined, releaseUnconfirmed: false }
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
  permissions: { canEdit: true, canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: true, canCopy: true, canDelete: true, canShare: true },
} as const

/** 失去编辑权（默认：读得到、有修改，可以另存为副本或放弃） */
function lost(loss: LeaseLoss, changes: Partial<LostMode> = {}): LostMode {
  return { kind: 'lost', loss, unsaved: true, readable: loss.kind !== 'not-found', checking: false, captureFailed: false, inputLeft: false, reopenFailed: false, copy: { kind: 'idle' }, reload: { kind: 'idle' }, ...changes }
}

/** 假的编辑器页：视图由测试设定 */
function fakePage(initial: Partial<EditorPageView> = {}) {
  let view: EditorPageView = { load: READY, mode: EDITING, save: CLEAN, session: 'active', sessionProblem: undefined, confirmingSession: false, detailProblem: undefined, surface: 'ready', ...initial }
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

/** 页头里的状态（载入中的说明、阅读与编辑、保存状态）：页头之外另有说明谁在编辑的读屏状态区 */
function headerStatus(): HTMLElement {
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

  it('页头的状态一直是同一个元素（role="status"，显式 aria-live）：从载入、阅读到编辑都往里填，读屏随之播报', () => {
    const fake = renderChrome({ load: { kind: 'loading' }, mode: undefined, save: undefined })
    const status = headerStatus()
    expect(status).toHaveAttribute('aria-live', 'polite')
    fake.set({ load: READY, mode: { ...READING, canEdit: false } })
    expect(headerStatus()).toBe(status)
    expect(status).toHaveTextContent('只能查看')
    fake.set({ mode: { kind: 'entering' } })
    expect(headerStatus()).toBe(status)
    expect(status).toHaveTextContent('正在进入编辑…')
    fake.set({ mode: EDITING, save: CLEAN })
    expect(headerStatus()).toBe(status)
    expect(status).toHaveTextContent('已保存到云端')
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

  it('保存状态随状态机变化；保存中按钮标为不可用（aria-disabled），焦点不丢', () => {
    const fake = renderChrome()
    fake.set({ save: { ...CLEAN, status: 'dirty', unsaved: true } })
    expect(headerStatus()).toHaveTextContent('有未保存的修改')
    fake.set({ save: { ...CLEAN, status: 'saving', canSave: false, unsaved: true } })
    expect(headerStatus()).toHaveTextContent('保存中…')
    expect(screen.getByRole('button', { name: '保存' })).toHaveAttribute('aria-disabled', 'true')
    fake.set({ save: CLEAN })
    expect(headerStatus()).toHaveTextContent('已保存到云端')
    expect(screen.getByRole('button', { name: '保存' })).toHaveAttribute('aria-disabled', 'false')
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
    ['快照不合格（422）', { kind: 'request', error: new ApiError(422, 'SNAPSHOT_INVALID', 'x', { requestId: 'req-9' }) } as const, '保存失败：表格内容的格式不正确，无法保存'],
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

  it('公式结果尚未保存：提示稍后再保存一次；保存中不提示', () => {
    const fake = renderChrome({ save: { ...CLEAN, status: 'dirty', formulasPending: true, unsaved: true } })
    expect(screen.getByText('公式结果尚未保存，请稍后再保存一次')).toBeInTheDocument()
    fake.set({ save: { ...CLEAN, status: 'saving', formulasPending: true, canSave: false, unsaved: true } })
    expect(screen.queryByText('公式结果尚未保存，请稍后再保存一次')).not.toBeInTheDocument()
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

  it('会话是本人时的令牌失效与迟到的未登录：提示再保存一次（令牌已经换好，复验 SB1）', () => {
    renderChrome({ save: { ...CLEAN, status: 'failed', problem: { kind: 'request', error: new ApiError(401, 'SESSION_EXPIRED', 'x') } } })
    expect(screen.getByRole('alert')).toHaveTextContent('保存失败：请求已失效，请再保存一次')
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
  ])('保存得到%s、确认会话进行中：页头说明正在确认，不先提示"再保存一次"；确认之后才提示（复验 TB1）', (_case, error) => {
    const fake = renderChrome({ confirmingSession: true, save: { ...CLEAN, status: 'failed', problem: { kind: 'request', error } } })
    expect(headerStatus()).toHaveTextContent('正在确认登录状态…')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    fake.set({ confirmingSession: false })
    expect(screen.getByRole('alert')).toHaveTextContent('保存失败：请求已失效，请再保存一次')
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

  it('版本冲突之后不再显示会话的提示；会话不是本人时不显示"公式结果尚未保存"（复验 SB9）', () => {
    renderChrome({ session: 'signed-out', save: { ...CLEAN, status: 'conflict', canSave: false, unsaved: true, conflict: { currentRevision: 5, source: null } } })
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('alert')).toHaveTextContent('别处保存了更新的版本')
    cleanup()
    renderChrome({ session: 'other-user', save: { ...CLEAN, status: 'dirty', canSave: false, formulasPending: true } })
    expect(screen.queryByText('公式结果尚未保存，请稍后再保存一次')).not.toBeInTheDocument()
  })

  it('确认会话失败（例如断网时按了保存）：在会话的提示里说明原因（复验 RB7）', () => {
    renderChrome({ session: 'signed-out', sessionProblem: new NetworkError('断网') })
    expect(screen.getByRole('alert')).toHaveTextContent('暂时无法确认登录状态：网络连接失败，请检查网络后重试')
  })

  it('CSRF 令牌失效：提示再保存一次，不让用户刷新（刷新会丢掉修改）', () => {
    renderChrome({ save: { ...CLEAN, status: 'failed', problem: { kind: 'request', error: new ApiError(403, 'CSRF_TOKEN_INVALID', 'x') } } })
    expect(screen.getByRole('alert')).toHaveTextContent('保存失败：请求已失效，请再保存一次')
    expect(screen.getByRole('alert')).not.toHaveTextContent('刷新')
  })

  it('保存流程本身出了意外：显示保存失败', () => {
    renderChrome({ save: { ...CLEAN, status: 'failed', problem: { kind: 'unexpected', error: new Error('SDK 出错') } } })
    expect(screen.getByRole('alert')).toHaveTextContent('保存失败：出了点问题，请稍后重试')
  })

  it('持有编辑权的页面没有人登录了、换了人：重新登录之后编辑权自动续上，照旧说"回到这里保存""原来的账户重新登录之后可以继续保存"', () => {
    renderChrome({ save: { ...CLEAN, status: 'dirty', unsaved: true }, session: 'signed-out' })
    expect(screen.getByRole('alert')).toHaveTextContent('登录已过期或已在别处退出。本页的修改还在：请在新的标签页中用同一个账户登录，然后回到这里保存')
    cleanup()
    renderChrome({ save: { ...CLEAN, status: 'dirty', unsaved: true }, session: 'other-user' })
    expect(screen.getByRole('alert')).toHaveTextContent('别的标签页登录了另一个账户，本页不能再保存。原来的账户重新登录之后可以继续保存')
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
    fake.set({ mode: { kind: 'exiting' }, save: CLEAN })
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

  it('本页刚退出编辑、没能确认放掉编辑权时读到"自己在别处编辑"：如实说是本页刚退出（审查 A13），不说成另一个标签页或设备', () => {
    const fake = renderChrome({ mode: { ...READING, holder: { holder: AMY, sameUser: true, lastActiveMinutes: 0 }, releaseUnconfirmed: true }, save: undefined })
    expect(infoRegion().textContent).toBe('本页刚退出编辑，编辑权还没能确认放掉：最多 90 秒后自动结束，这期间别人还不能编辑；这一页可以直接再点"编辑"')
    fake.set({ mode: { ...READING, holder: { holder: AMY, sameUser: true, lastActiveMinutes: 0 }, releaseUnconfirmed: false } })
    expect(infoRegion()).toHaveTextContent('你在另一个标签页或设备上正在编辑这份文档')
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
    // 仍然可以点"编辑"（被占用时留在阅读、说明谁在编辑）
    expect(screen.getByRole('button', { name: '编辑' })).toBeInTheDocument()
  })

  it.each([
    ['不到 1 分钟', 0, '@amy 艾米 正在编辑这份文档（最后活动不到 1 分钟前），你现在只能阅读'],
    ['服务端没给出回答的时刻', undefined, '@amy 艾米 正在编辑这份文档，你现在只能阅读'],
  ])('最后活动%s', (_case, minutes, text) => {
    renderChrome({ mode: { ...READING, holder: { holder: AMY, sameUser: false, lastActiveMinutes: minutes } }, save: undefined })
    expect(infoRegion()).toHaveTextContent(text)
  })

  it('是自己（在另一个标签页或设备上）：说明在别处正在编辑；刚关闭或刷新过那个页面时，那边的编辑权最多 90 秒后自动结束（审查 B7）', () => {
    renderChrome({ mode: { ...READING, holder: { holder: AMY, sameUser: true, lastActiveMinutes: 0 } }, save: undefined })
    expect(infoRegion().textContent).toBe('你在另一个标签页或设备上正在编辑这份文档，这里只能阅读。要是刚刚关闭或刷新过那个页面，那边的编辑权最多 90 秒后自动结束，到时再点"编辑"就能编辑')
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
    ['续上时自己在别处正在编辑', { kind: 'held', holder: { holder: AMY, sameUser: true, lastActiveMinutes: 0 } }, '编辑权已失效：你在另一个标签页或设备上正在编辑这份文档（要是刚刚关闭或刷新过那个页面，那边的编辑权最多 90 秒后自动结束，到时再点"编辑"就能编辑）。'],
    ['续上时被占用、详情认不出', { kind: 'held', holder: undefined }, '编辑权已失效：这份文档正在别处编辑。'],
    ['续上时别处保存过更新的版本', { kind: 'newer' }, '编辑权已失效：编辑权中断期间，别处保存了更新的版本，本页不能再覆盖它。'],
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

  it('进入编辑中"编辑"不卸载（同一个按钮，说正在进入、标为不可用），焦点还在它上面；没有进入成功（被占用）回到阅读时照旧是它', () => {
    const fake = renderChrome({ mode: READING, save: undefined })
    const enter = screen.getByRole('button', { name: '编辑' })
    enter.focus()
    fake.set({ mode: { kind: 'entering' } })
    expect(screen.getByRole('button', { name: '正在进入编辑…' })).toBe(enter)
    expect(enter).toHaveAttribute('aria-disabled', 'true')
    expect(enter).toHaveAttribute('aria-busy', 'true')
    expect(document.activeElement).toBe(enter)
    fake.set({ mode: { ...READING, holder: { holder: AMY, sameUser: false, lastActiveMinutes: 0 } } })
    expect(screen.getByRole('button', { name: '编辑' })).toBe(enter)
    expect(enter).toHaveAttribute('aria-disabled', 'false')
    expect(document.activeElement).toBe(enter)
  })

  it('退出编辑中两个按钮都留着（"退出编辑"说正在退出），焦点还在它上面；保存失败、留在编辑时照旧是它', () => {
    const fake = renderChrome({ save: { ...CLEAN, status: 'dirty', unsaved: true } })
    const exit = screen.getByRole('button', { name: '退出编辑' })
    exit.focus()
    fake.set({ mode: { kind: 'exiting' }, save: { ...CLEAN, status: 'saving', canSave: false, unsaved: true } })
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
