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
const CLEAN: SaveView = { status: 'clean', formulasPending: false, problem: undefined, conflict: undefined, canSave: true, unsaved: false }

/** 假的编辑器页：视图由测试设定 */
function fakePage(initial: Partial<EditorPageView> = {}) {
  let view: EditorPageView = { load: READY, save: CLEAN, editing: { kind: 'editing' }, session: 'active', sessionProblem: undefined, confirmingSession: false, ...initial }
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

/** 页头里的状态（载入中的说明、保存状态）：页头之外另有说明谁在编辑的读屏状态区 */
function headerStatus(): HTMLElement {
  return within(screen.getByRole('banner')).getByRole('status')
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
    expect(headerStatus()).toHaveTextContent('正在打开表格…')
    expect(screen.getByRole('link', { name: '我的空间' })).toHaveAttribute('href', '/')
    expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument()
  })

  it('就绪：标题、保存状态（role="status"）与保存按钮；浏览器标签页的标题', () => {
    renderChrome()
    expect(screen.getByRole('heading', { name: '周报' })).toBeInTheDocument()
    expect(headerStatus()).toHaveTextContent('已保存到云端')
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

  it('文档被删除、移走或失去权限之后保存（404，保存与续租同样转为失效，M3-P1）：说清楚无法访问了、本页的修改没有保存，需要的话先复制出来；不提供、也不承诺重新加载——读不到了，重新加载只会显示"内容不存在"，页头的返回链接照常在（审查 B2；M2 总设计 A14，M2-P6 复核 S8）', () => {
    const error = new ApiError(404, 'NOT_FOUND', '请求的资源不存在或无权访问', { requestId: 'req-404' })
    renderChrome({ save: { ...CLEAN, status: 'failed', canSave: false, problem: { kind: 'request', error }, unsaved: true }, editing: { kind: 'lost', loss: { kind: 'not-found', error } } })
    expect(headerStatus()).toHaveTextContent('编辑权已失效')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('alert').textContent).toBe('编辑权已失效：你已无法访问这份文档（可能已被删除、移走，或你失去了访问权限）。本页的修改没有保存，需要的话先把内容复制出来。')
    expect(screen.queryByRole('button', { name: '重新加载' })).toBeNull()
    expect(screen.getByRole('link', { name: '我的空间' })).toHaveAttribute('href', '/')
    expect(screen.queryByText(/保存失败/)).toBeNull()
  })

  it.each([
    ['心跳先得知（保存的状态是已保存）', { ...CLEAN, canSave: false }],
    ['没有修改时按了保存、保存先得知（保存的状态是失败）', { ...CLEAN, status: 'failed', canSave: false, problem: { kind: 'request', error: new ApiError(404, 'NOT_FOUND', '不存在') } }],
  ] as const)('读不到了（404）、本页没有未保存的内容（%s）：只说本页的修改都已保存，不提重新加载（审查 B2、B3）', (_case, save) => {
    renderChrome({ save, editing: { kind: 'lost', loss: { kind: 'not-found', error: new ApiError(404, 'NOT_FOUND', '不存在') } } })
    expect(screen.getByRole('alert').textContent).toBe('编辑权已失效：你已无法访问这份文档（可能已被删除、移走，或你失去了访问权限）。本页的修改都已保存。')
    expect(screen.queryByRole('button', { name: '重新加载' })).toBeNull()
  })

  it('请求不合法（400 REQUEST_INVALID）是这次请求本身的问题：按错误码说明，不说成"已经被删除、移走或失去权限"（第二批 G-5）', () => {
    renderChrome({ save: { ...CLEAN, status: 'failed', problem: { kind: 'request', error: new ApiError(400, 'REQUEST_INVALID', '请求的格式或参数不合法', { requestId: 'req-400' }) } } })
    expect(screen.getByRole('alert')).toHaveTextContent('保存失败：请求的内容不合法，请检查后重试')
    expect(screen.queryByText(/已经被删除/)).toBeNull()
    expect(screen.getByText('请求标识：req-400')).toBeInTheDocument()
  })

  it('能看却不能改了（403，例如空间刚被归档；保存与续租同样转为失效，M3-P1）：说没有编辑的权限、带上服务端说的原因，并说明本页的修改没有保存；重新加载能以只读看到最新的版本，提供它（M2-P6 复核 S5、S8）', () => {
    const error = new ApiError(403, 'PERMISSION_DENIED', '空间已归档，只能查看')
    renderChrome({ save: { ...CLEAN, status: 'failed', canSave: false, problem: { kind: 'request', error }, unsaved: true }, editing: { kind: 'lost', loss: { kind: 'denied', error } } })
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('alert')).toHaveTextContent('编辑权已失效：你已没有编辑这份文档的权限（空间已归档，只能查看）。本页的修改没有保存，需要的话先把内容复制出来，再重新加载。')
    expect(screen.getByRole('button', { name: '重新加载' })).toBeInTheDocument()
    expect(screen.queryByText(/你没有执行这个操作的权限/)).toBeNull()
  })

  it('能看却不能改了（403）、本页没有修改：心跳先得知与按了保存才得知，说法一样——只看本页有没有未保存的内容，不看保存的状态（审查 B3）', () => {
    const error = new ApiError(403, 'PERMISSION_DENIED', '空间已归档，只能查看')
    const lost = { kind: 'lost', loss: { kind: 'denied', error } } as const
    renderChrome({ save: { ...CLEAN, canSave: false }, editing: lost })
    const heartbeatFirst = screen.getByRole('alert').textContent
    cleanup()
    renderChrome({ save: { ...CLEAN, status: 'failed', canSave: false, problem: { kind: 'request', error } }, editing: lost })
    expect(screen.getByRole('alert').textContent).toBe(heartbeatFirst)
    expect(screen.getByRole('alert')).toHaveTextContent('编辑权已失效：你已没有编辑这份文档的权限（空间已归档，只能查看）。本页的修改都已保存，重新加载可以看到最新的版本。')
    expect(screen.getByRole('alert')).not.toHaveTextContent('没有保存')
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

describe('编辑权（M3-P1 设计 §3.4.7）', () => {
  const AMY = { id: '0199a2c4-0000-7000-8000-0000000000e1', username: 'amy', displayName: '艾米' }
  const VIEWING: Partial<EditorPageView> = { load: { ...READY, readOnly: true }, save: undefined }

  /** 页头之外说明谁在编辑的读屏状态区 */
  function editingRegion(): HTMLElement {
    const region = screen.getAllByRole('status').find(element => element.dataset.slot === 'status-region')
    if (region === undefined)
      throw new Error('没有说明谁在编辑的读屏状态区')
    return region
  }

  it('别人正在编辑：说明谁（人名组件，登录名在前）在编辑、最后活动几分钟之前，只能阅读；读屏状态区载入时就在，就绪时往里填（规范 §2.4）', () => {
    const fake = renderChrome({ load: { kind: 'loading' }, save: undefined, editing: { kind: 'none' } })
    const region = editingRegion()
    expect(region).toBeEmptyDOMElement()
    fake.set({ ...VIEWING, editing: { kind: 'elsewhere', holder: { holder: AMY, sameUser: false, lastActiveMinutes: 3 } } })
    expect(editingRegion()).toBe(region)
    expect(region).toHaveTextContent('@amy 艾米 正在编辑这份文档（最后活动 3 分钟前），你现在只能阅读')
    expect(within(region).getByText('@amy')).toHaveAttribute('data-slot', 'person-username')
    expect(within(region).getByText('艾米').tagName).toBe('BDI')
    expect(screen.getByText('只能查看')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument()
  })

  it.each([
    ['不到 1 分钟', 0, '@amy 艾米 正在编辑这份文档（最后活动不到 1 分钟前），你现在只能阅读'],
    ['服务端没给出回答的时刻', undefined, '@amy 艾米 正在编辑这份文档，你现在只能阅读'],
  ])('最后活动%s', (_case, minutes, text) => {
    renderChrome({ ...VIEWING, editing: { kind: 'elsewhere', holder: { holder: AMY, sameUser: false, lastActiveMinutes: minutes } } })
    expect(editingRegion()).toHaveTextContent(text)
  })

  it('是自己（在另一个标签页或设备上）：说明在别处正在编辑，这里只能阅读；刚关闭或刷新过那个页面时，那边的编辑权最多一分半钟后自动结束（审查 B7）', () => {
    renderChrome({ ...VIEWING, editing: { kind: 'elsewhere', holder: { holder: AMY, sameUser: true, lastActiveMinutes: 0 } } })
    expect(editingRegion().textContent).toBe('你在另一个标签页或设备上正在编辑这份文档，这里只能阅读。要是刚刚关闭或刷新过那个页面，那边的编辑权最多一分半钟后自动结束，到时重新加载这一页就能编辑')
  })

  it('服务端给的详情认不出：通用的说法', () => {
    renderChrome({ ...VIEWING, editing: { kind: 'elsewhere', holder: undefined } })
    expect(editingRegion()).toHaveTextContent('这份文档正在别处编辑，你现在只能阅读')
  })

  it('持有编辑权或只能查看：读屏状态区是空的', () => {
    renderChrome()
    expect(editingRegion()).toBeEmptyDOMElement()
  })

  const DIRTY: SaveView = { ...CLEAN, status: 'dirty', canSave: false, unsaved: true }
  /** 重新加载还看得到这份文档的来源：说明之后提供重新加载 */
  const RELOADABLE_LOSSES = [
    ['编辑权被收回', { kind: 'lease', reason: 'revoked' } as const, '编辑权已失效：你对这份文档的编辑权被收回了。本页的修改没有保存，需要的话先把内容复制出来，再重新加载。'],
    ['不认识的原因', { kind: 'lease', reason: undefined } as const, '编辑权已失效。本页的修改没有保存，需要的话先把内容复制出来，再重新加载。'],
    ['不能编辑了（403，原因由服务端给出）', { kind: 'denied', error: new ApiError(403, 'PERMISSION_DENIED', '只能查看这份文档，不能编辑') } as const, '编辑权已失效：你已没有编辑这份文档的权限（只能查看这份文档，不能编辑）。本页的修改没有保存，需要的话先把内容复制出来，再重新加载。'],
    ['续上时别人正在编辑', { kind: 'held', holder: { holder: AMY, sameUser: false, lastActiveMinutes: 2 } } as const, '编辑权已失效：@amy 艾米 正在编辑这份文档（最后活动 2 分钟前）。本页的修改没有保存，需要的话先把内容复制出来，再重新加载。'],
    ['续上时自己在别处正在编辑', { kind: 'held', holder: { holder: AMY, sameUser: true, lastActiveMinutes: 0 } } as const, '编辑权已失效：你在另一个标签页或设备上正在编辑这份文档（要是刚刚关闭或刷新过那个页面，那边的编辑权最多一分半钟后自动结束，到时重新加载这一页就能编辑）。本页的修改没有保存，需要的话先把内容复制出来，再重新加载。'],
    ['续上时被占用、详情认不出', { kind: 'held', holder: undefined } as const, '编辑权已失效：这份文档正在别处编辑。本页的修改没有保存，需要的话先把内容复制出来，再重新加载。'],
    ['续上时别处保存过更新的版本', { kind: 'newer' } as const, '编辑权已失效：编辑权中断期间，别处保存了更新的版本，本页不能再覆盖它。本页的修改没有保存，需要的话先把内容复制出来，再重新加载。'],
  ] as const
  /** 读不到这份文档了（404）：重新加载只会显示"内容不存在"，不提供它（审查 B2） */
  const NOT_FOUND_LOSS = { kind: 'not-found', error: new ApiError(404, 'NOT_FOUND', '不存在') } as const
  it.each(RELOADABLE_LOSSES)('编辑权失效（%s）：保存状态说编辑权已失效，说明原因与本页的修改没有保存，提供重新加载', (_case, loss, text) => {
    const { page } = renderChrome({ save: DIRTY, editing: { kind: 'lost', loss } })
    expect(headerStatus()).toHaveTextContent('编辑权已失效')
    expect(screen.getByRole('alert')).toHaveTextContent(text)
    expect(screen.getByRole('button', { name: '保存' })).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    expect(page.reload).toHaveBeenCalledOnce()
  })

  it('编辑权失效（读不到了，404）：说明原因与本页的修改没有保存，需要的话先复制出来；不提供重新加载（审查 B2）', () => {
    renderChrome({ save: DIRTY, editing: { kind: 'lost', loss: NOT_FOUND_LOSS } })
    expect(headerStatus()).toHaveTextContent('编辑权已失效')
    expect(screen.getByRole('alert').textContent).toBe('编辑权已失效：你已无法访问这份文档（可能已被删除、移走，或你失去了访问权限）。本页的修改没有保存，需要的话先把内容复制出来。')
    expect(screen.queryByRole('button', { name: '重新加载' })).toBeNull()
    expect(screen.getByRole('button', { name: '保存' })).toHaveAttribute('aria-disabled', 'true')
  })

  it('读不到了（404）之后换了人：同样不提重新加载（不说"重新加载会以那个账户打开"）', () => {
    renderChrome({ session: 'other-user', save: DIRTY, editing: { kind: 'lost', loss: NOT_FOUND_LOSS } })
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('alert')).not.toHaveTextContent('重新加载')
  })

  it('续上时别人正在编辑：人名经人名组件（登录名在前，显示名隔离）', () => {
    renderChrome({ save: DIRTY, editing: { kind: 'lost', loss: { kind: 'held', holder: { holder: AMY, sameUser: false, lastActiveMinutes: undefined } } } })
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('编辑权已失效：@amy 艾米 正在编辑这份文档。本页的修改没有保存')
    expect(within(alert).getByText('@amy')).toHaveAttribute('data-slot', 'person-username')
    expect(within(alert).getByText('艾米').tagName).toBe('BDI')
  })

  it('每种来源都有自己的说法', () => {
    const losses = [...RELOADABLE_LOSSES.map(([, loss]) => loss), NOT_FOUND_LOSS]
    const shown = new Set<string>()
    for (const loss of losses) {
      renderChrome({ save: DIRTY, editing: { kind: 'lost', loss } })
      shown.add(screen.getByRole('alert').textContent)
      cleanup()
    }
    expect(shown.size).toBe(losses.length)
  })

  it('编辑权失效、本页的修改都已保存：不说"没有保存"', () => {
    renderChrome({ save: { ...CLEAN, canSave: false }, editing: { kind: 'lost', loss: { kind: 'lease', reason: 'revoked' } } })
    expect(screen.getByRole('alert')).toHaveTextContent('编辑权已失效：你对这份文档的编辑权被收回了。本页的修改都已保存，重新加载可以看到最新的版本。')
    expect(screen.getByRole('alert')).not.toHaveTextContent('没有保存')
  })

  it('编辑权失效之后只显示这一条：会话的提示、保存失败、版本冲突与"公式结果尚未保存"都不再成立', () => {
    const lost = { kind: 'lost', loss: { kind: 'newer' } } as const
    renderChrome({ session: 'signed-out', save: { ...DIRTY, status: 'failed', formulasPending: true, problem: { kind: 'request', error: new ApiError(409, 'EDIT_LEASE_LOST', 'x') } }, editing: lost })
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('alert')).toHaveTextContent('编辑权已失效：编辑权中断期间，别处保存了更新的版本')
    expect(screen.queryByText(/公式结果尚未保存/)).toBeNull()
    cleanup()
    renderChrome({ save: { ...DIRTY, status: 'conflict', conflict: { currentRevision: 5, source: null } }, editing: { kind: 'lost', loss: { kind: 'lease', reason: 'revoked' } } })
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('alert')).not.toHaveTextContent('别处保存了更新的版本')
  })

  it('编辑权失效之后换了人：另说明重新加载会以那个账户打开（复验 TB8 的做法）', () => {
    renderChrome({ session: 'other-user', save: DIRTY, editing: { kind: 'lost', loss: { kind: 'lease', reason: 'revoked' } } })
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('alert')).toHaveTextContent('别的标签页登录了另一个账户，重新加载会以那个账户打开')
  })

  it('持有编辑权的页面没有人登录了、换了人：重新登录之后编辑权自动续上，照旧说"回到这里保存""原来的账户重新登录之后可以继续保存"', () => {
    renderChrome({ save: DIRTY, session: 'signed-out' })
    expect(screen.getByRole('alert')).toHaveTextContent('登录已过期或已在别处退出。本页的修改还在：请在新的标签页中用同一个账户登录，然后回到这里保存')
    expect(screen.getByRole('link', { name: '在新标签页中登录' })).toBeInTheDocument()
    cleanup()
    renderChrome({ save: DIRTY, session: 'other-user' })
    expect(screen.getByRole('alert')).toHaveTextContent('别的标签页登录了另一个账户，本页不能再保存。原来的账户重新登录之后可以继续保存')
  })

  it.each([
    ['只能查看的页面', VIEWING],
    ['别处正在编辑、只能阅读的页面', { ...VIEWING, editing: { kind: 'elsewhere', holder: { holder: AMY, sameUser: false, lastActiveMinutes: 3 } } }],
  ] as const)('%s没有人登录了、换了人：不提修改与保存（只读的页面没有修改，也不能保存，审查 B10）', (_case, view) => {
    renderChrome({ ...view, session: 'signed-out' })
    expect(screen.getByRole('alert')).toHaveTextContent('登录已过期或已在别处退出。请在新的标签页中用同一个账户登录，然后回到这里继续')
    expect(screen.getByRole('alert')).not.toHaveTextContent(/修改|保存/)
    expect(screen.getByRole('link', { name: '在新标签页中登录' })).toBeInTheDocument()
    cleanup()
    renderChrome({ ...view, session: 'other-user' })
    expect(screen.getByRole('alert')).toHaveTextContent('别的标签页登录了另一个账户。原来的账户重新登录之后，这一页可以接着使用')
    expect(screen.getByRole('alert')).not.toHaveTextContent(/修改|保存/)
  })
})
