import type { EditorPage, EditorPageLoad, EditorPageReady, EditorPageView } from './editor-page.ts'
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
  readOnly: false,
  stage: 'steady',
}
const CLEAN: SaveView = { status: 'clean', formulasPending: false, problem: undefined, conflict: undefined, canSave: true }

/** 假的编辑器页：视图由测试设定 */
function fakePage(initial: Partial<EditorPageView> = {}) {
  let view: EditorPageView = { load: READY, save: CLEAN, session: 'active', sessionProblem: undefined, confirmingSession: false, ...initial }
  const listeners = new Set<() => void>()
  const page: EditorPage = {
    view: () => view,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    load: async () => {},
    save: vi.fn(async () => {}),
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
    // 别人的个人空间里的也一样：不当成"我的空间"
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
    // 重新取到的文档详情不能分享了：入口消失，对话框留着
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
    renderChrome({ load: { kind: 'loading' }, save: undefined })
    expect(screen.getByRole('status')).toHaveTextContent('正在打开表格…')
    expect(screen.getByRole('link', { name: '我的空间' })).toHaveAttribute('href', '/')
    expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument()
  })

  it('就绪：标题、保存状态（role="status"）与保存按钮；浏览器标签页的标题', () => {
    renderChrome()
    expect(screen.getByRole('heading', { name: '周报' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('已保存到云端')
    expect(document.title).toBe('周报 - NerveOffice')
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
    fake.set({ save: { ...CLEAN, status: 'dirty' } })
    expect(screen.getByRole('status')).toHaveTextContent('有未保存的修改')
    fake.set({ save: { ...CLEAN, status: 'saving', canSave: false } })
    expect(screen.getByRole('status')).toHaveTextContent('保存中…')
    expect(screen.getByRole('button', { name: '保存' })).toHaveAttribute('aria-disabled', 'true')
    fake.set({ save: CLEAN })
    expect(screen.getByRole('status')).toHaveTextContent('已保存到云端')
    expect(screen.getByRole('button', { name: '保存' })).toHaveAttribute('aria-disabled', 'false')
  })

  it('版本冲突：说明保留本页内容，提供重新加载', () => {
    const { page } = renderChrome({ save: { ...CLEAN, status: 'conflict', canSave: false, conflict: { currentRevision: 5, source: null } } })
    expect(screen.getByRole('status')).toHaveTextContent('版本冲突')
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

  it('文档被删除、移走或失去权限之后保存（404）：说清楚存不进去了、本页的修改没有保存，需要的话先复制出来（M2 总设计 A14，M2-P6 复核 S8）', () => {
    renderChrome({ save: { ...CLEAN, status: 'failed', problem: { kind: 'request', error: new ApiError(404, 'NOT_FOUND', '请求的资源不存在或无权访问', { requestId: 'req-404' }) } } })
    expect(screen.getByRole('alert')).toHaveTextContent('保存失败：这份表格已经被删除、移走，或者你已经没有访问权限，本页的修改没有保存。需要的话先把内容复制出来。')
    expect(screen.getByText('请求标识：req-404')).toBeInTheDocument()
  })

  it('请求不合法（400 REQUEST_INVALID）是这次请求本身的问题：按错误码说明，不说成"已经被删除、移走或失去权限"（第二批 G-5）', () => {
    renderChrome({ save: { ...CLEAN, status: 'failed', problem: { kind: 'request', error: new ApiError(400, 'REQUEST_INVALID', '请求的格式或参数不合法', { requestId: 'req-400' }) } } })
    expect(screen.getByRole('alert')).toHaveTextContent('保存失败：请求的内容不合法，请检查后重试')
    expect(screen.queryByText(/已经被删除/)).toBeNull()
    expect(screen.getByText('请求标识：req-400')).toBeInTheDocument()
  })

  it('能看却不能改了（403，例如空间刚被归档）：用服务端说的原因，并说明本页的修改没有保存（M2-P6 复核 S5、S8）', () => {
    renderChrome({ save: { ...CLEAN, status: 'failed', problem: { kind: 'request', error: new ApiError(403, 'PERMISSION_DENIED', '空间已归档，只能查看') } } })
    expect(screen.getByRole('alert')).toHaveTextContent('保存失败：空间已归档，只能查看，本页的修改没有保存。需要的话先把内容复制出来。')
    expect(screen.queryByText(/你没有执行这个操作的权限/)).toBeNull()
  })

  it('失败的说明带请求标识', () => {
    renderChrome({ save: { ...CLEAN, status: 'failed', problem: { kind: 'request', error: new ApiError(500, 'INTERNAL_ERROR', 'x', { requestId: 'req-42' }) } } })
    expect(screen.getByText('请求标识：req-42')).toBeInTheDocument()
  })

  it('公式结果尚未保存：提示稍后再保存一次；保存中不提示', () => {
    const fake = renderChrome({ save: { ...CLEAN, status: 'dirty', formulasPending: true } })
    expect(screen.getByText('公式结果尚未保存，请稍后再保存一次')).toBeInTheDocument()
    fake.set({ save: { ...CLEAN, status: 'saving', formulasPending: true, canSave: false } })
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
    expect(screen.getByRole('status')).toHaveTextContent('正在确认登录状态…')
    expect(screen.getByRole('button', { name: '保存' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('button', { name: '保存' })).toHaveAttribute('aria-busy', 'true')
  })

  it.each([
    ['令牌失效', new ApiError(403, 'CSRF_TOKEN_INVALID', 'x')],
    ['登录已过期', new ApiError(401, 'SESSION_EXPIRED', 'x')],
  ])('保存得到%s、确认会话进行中：页头说明正在确认，不先提示"再保存一次"；确认之后才提示（复验 TB1）', (_case, error) => {
    const fake = renderChrome({ confirmingSession: true, save: { ...CLEAN, status: 'failed', problem: { kind: 'request', error } } })
    expect(screen.getByRole('status')).toHaveTextContent('正在确认登录状态…')
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
    renderChrome({ session: 'other-user', save: { ...CLEAN, status: 'conflict', canSave: false, conflict: { currentRevision: 5, source: null } } })
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('alert')).toHaveTextContent('别处保存了更新的版本')
    expect(screen.getByRole('alert')).toHaveTextContent('重新加载会以那个账户打开。要查看最新版本，先换回原来的账户再重新加载')
    expect(screen.getByRole('alert')).not.toHaveTextContent('可以继续保存')
  })

  it('版本冲突之后不再显示会话的提示；会话不是本人时不显示"公式结果尚未保存"（复验 SB9）', () => {
    renderChrome({ session: 'signed-out', save: { ...CLEAN, status: 'conflict', canSave: false, conflict: { currentRevision: 5, source: null } } })
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

  it('只能查看：没有保存按钮', () => {
    renderChrome({ load: { ...READY, readOnly: true } as EditorPageLoad, save: undefined })
    expect(screen.getByText('只能查看')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument()
  })
})

describe('编辑器页的载入失败', () => {
  it('内容不存在或无权访问（别人的与不存在的相同）：说明，可以回到我的空间', () => {
    renderChrome({ load: { kind: 'not-found' }, save: undefined })
    expect(screen.getByText('内容不存在，或者你没有访问权限')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '我的空间' })).toHaveAttribute('href', '/')
  })

  it.each([
    ['格式不认识', { kind: 'unsupported' } as const, '这份表格的格式比当前页面新，请刷新页面'],
    ['编辑器加载失败', { kind: 'editor-failed', error: new Error('x') } as const, '编辑器加载失败，请刷新页面重试'],
    ['请求失败', { kind: 'failed', error: new NetworkError('断网') } as const, '表格加载失败：网络连接失败，请检查网络后重试'],
  ])('%s', (_case, load, text) => {
    renderChrome({ load, save: undefined })
    expect(screen.getByRole('alert')).toHaveTextContent(text)
  })

  it('请求失败的说明带请求标识', () => {
    renderChrome({ load: { kind: 'failed', error: new ApiError(503, 'SERVICE_UNAVAILABLE', 'x', { requestId: 'req-7' }) }, save: undefined })
    expect(screen.getByText('请求标识：req-7')).toBeInTheDocument()
  })
})
