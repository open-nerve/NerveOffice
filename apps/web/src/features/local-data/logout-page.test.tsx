import type { LogoutFlowOptions } from '../../shared/local-drafts/logout-flow.ts'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PageLocationContext } from '../../shared/lib/page-location.ts'
import { createLogoutFlow } from '../../shared/local-drafts/logout-flow.ts'
import { LogoutContent } from './logout-page.tsx'

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PERMIT = { userId: USER, generation: '00000000-0000-4000-8000-000000000011' }
const CLEANUP = { userId: USER, generation: '00000000-0000-4000-8000-000000000012', cause: 'logout' as const }
const SESSION: LogoutFlowOptions['session'] = { user: { id: USER, username: 'alice', displayName: '甲', systemRole: 'member' }, personalSpace: { id: USER, name: '甲' }, csrfToken: 'original-csrf', features: { localDraftsEnabled: true } }
function fixture(patch: Partial<LogoutFlowOptions> = {}) {
  const options: LogoutFlowOptions = {
    session: SESSION,
    permit: PERMIT,
    inventory: { load: async () => ({ kind: 'listed', entries: [{ documentId: USER, title: '离线预算', updatedAt: 1000, mirrorOnly: false }], incomplete: false }), dispose: vi.fn() },
    cleanup: { beginUser: vi.fn<LogoutFlowOptions['cleanup']['beginUser']>(async () => ({ kind: 'clearing', permit: CLEANUP })), removeUser: vi.fn<LogoutFlowOptions['cleanup']['removeUser']>(async () => ({ kind: 'cleared', pending: [] })) },
    qualify: async () => 'active',
    stopped: vi.fn(),
    requestLogout: vi.fn(async () => {}),
    clearCache: vi.fn(),
    still: () => true,
    ...patch,
  }
  const flow = createLogoutFlow(options)
  const page = { assign: vi.fn(), replace: vi.fn(), reload: vi.fn() }
  render(<PageLocationContext value={page}><LogoutContent flow={flow} session={SESSION} /></PageLocationContext>)
  return { flow, options, page }
}

describe('明确退出预览与两种结果', () => {
  it('本机时间超出日期可表示范围时仍能预览和取消，不使退出页崩溃', async () => {
    const t = fixture({ inventory: { load: async () => ({ kind: 'listed', entries: [{ documentId: USER, updatedAt: Number.MAX_SAFE_INTEGER, mirrorOnly: false }], incomplete: false }), dispose: vi.fn() } })
    await act(async () => t.flow.preview())
    expect(screen.getByText('本机时间无法确认')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument()
  })
  it('预览账户和草稿；取消仅离开，确认才清理和退出', async () => {
    const t = fixture()
    await act(async () => t.flow.preview())
    expect(screen.getByText('离线预算')).toBeInTheDocument()
    expect(screen.getByText(/@alice/)).toBeInTheDocument()
    expect(t.options.cleanup.beginUser).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(t.page.assign).toHaveBeenCalledWith('/')
    expect(t.options.requestLogout).not.toHaveBeenCalled()
  })
  it('明确确认并完成两侧后才整页到登录；确认按钮消失时焦点交给标题', async () => {
    const t = fixture()
    await act(async () => t.flow.preview())
    const confirm = screen.getByRole('button', { name: '清理本机草稿并退出' })
    confirm.focus()
    fireEvent.click(confirm)
    await waitFor(() => expect(t.page.replace).toHaveBeenCalledExactlyOnceWith('/login'))
    expect(t.options.requestLogout).toHaveBeenCalledExactlyOnceWith(SESSION)
    expect(screen.queryByText('离线预算')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '退出登录' })).toHaveFocus()
  })
  it('清理未完成即使 pending 为空也如实显示，服务器已退出只重试本机', async () => {
    const cleanup: LogoutFlowOptions['cleanup'] = { beginUser: vi.fn<LogoutFlowOptions['cleanup']['beginUser']>(async () => ({ kind: 'clearing', permit: CLEANUP })), removeUser: vi.fn().mockResolvedValueOnce({ kind: 'pending', pending: [] }).mockResolvedValue({ kind: 'cleared', pending: [] }) }
    const t = fixture({ cleanup })
    await act(async () => t.flow.preview())
    fireEvent.click(screen.getByRole('button', { name: '清理本机草稿并退出' }))
    expect(await screen.findByText('服务器上的登录已结束。')).toBeInTheDocument()
    expect(screen.getByText(/本机数据尚未全部清理/)).toBeInTheDocument()
    expect(t.page.replace).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '重试未完成步骤' }))
    await waitFor(() => expect(t.page.replace).toHaveBeenCalledWith('/login'))
    expect(t.options.requestLogout).toHaveBeenCalledTimes(1)
    expect(cleanup.beginUser).toHaveBeenCalledTimes(1)
  })
  it('网络未知保留结果与原确认，不能宣称退出完成', async () => {
    const t = fixture({ requestLogout: vi.fn(async () => {
      throw new Error('network')
    }) })
    await act(async () => t.flow.preview())
    fireEvent.click(screen.getByRole('button', { name: '清理本机草稿并退出' }))
    expect(await screen.findByText(/尚未确认服务器上的登录是否结束/)).toBeInTheDocument()
    expect(screen.getByText('本机数据已清理。')).toBeInTheDocument()
    expect(t.page.replace).not.toHaveBeenCalled()
  })
  it('不能列完整时明确提醒可能还有草稿；失效即隐藏旧账户和标题，只能重新预览', async () => {
    const t = fixture({ inventory: { load: async () => ({ kind: 'unavailable', reason: 'storage' }), dispose: vi.fn() } })
    await act(async () => t.flow.preview())
    expect(screen.getByText(/可能还有未列出的草稿/)).toBeInTheDocument()
    act(() => t.flow.dispose())
    expect(screen.queryByText(/@alice/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '清理本机草稿并退出' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重新预览当前账户' }))
    expect(t.page.reload).toHaveBeenCalledTimes(1)
    expect(t.options.cleanup.beginUser).not.toHaveBeenCalled()
  })
})
