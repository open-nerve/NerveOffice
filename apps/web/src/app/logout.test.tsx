import type { SessionResponse } from '@nerve-office/contracts'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { setApiSession } from '../shared/api/index.ts'
import { apiError, installFakeApi, json } from '../shared/testing/fake-api.test-support.ts'
import { renderApp } from './render-app.test-support.tsx'

const SESSION: SessionResponse = { user: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', username: 'alice', displayName: '甲', systemRole: 'member' }, personalSpace: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: '甲' }, csrfToken: 'original-token', features: { localDraftsEnabled: true } }

describe('公开退出页的真实请求组装', () => {
  it('进入只查询实际当前会话，没有旧工作区；确认后固定 CSRF，存储不可用如实留在结果页', async () => {
    const api = installFakeApi({ 'GET /api/auth/session': () => json(200, SESSION), 'POST /api/auth/logout': () => new Response(null, { status: 204 }) })
    const app = renderApp('/logout')
    const confirm = await screen.findByRole('button', { name: '清理本机草稿并退出' })
    expect(api.requests.map(request => request.key)).toEqual(['GET /api/auth/session'])
    expect(screen.queryByRole('heading', { name: '我的空间' })).not.toBeInTheDocument()
    app.queryClient.setQueryData(['old-workspace'], { title: '旧空间标题' })
    fireEvent.click(confirm)
    expect(await screen.findByText('服务器上的登录已结束。')).toBeInTheDocument()
    await waitFor(() => expect(app.queryClient.getQueryData(['old-workspace'])).toBeUndefined())
    expect(screen.getByText(/未能确认本机草稿的清理资格/)).toBeInTheDocument()
    expect(screen.queryByText(/@alice/)).not.toBeInTheDocument()
    expect(app.page.visits).toEqual([])
    expect(api.requests.find(request => request.key === 'POST /api/auth/logout')?.headers['x-csrf-token']).toBe('original-token')
  })

  it('退出 401 只确认原会话结束，禁止查询新登录或换用新令牌再发一次', async () => {
    const api = installFakeApi({ 'GET /api/auth/session': () => json(200, SESSION), 'POST /api/auth/logout': () => apiError(401, 'SESSION_EXPIRED') })
    renderApp('/logout')
    fireEvent.click(await screen.findByRole('button', { name: '清理本机草稿并退出' }))
    expect(await screen.findByText('服务器上的登录已结束。')).toBeInTheDocument()
    expect(api.requests.map(request => request.key)).toEqual(['GET /api/auth/session', 'POST /api/auth/logout'])
  })

  it('CSRF 变化即结束旧确认，不自动采纳新登录；重试入口必须重新预览', async () => {
    const api = installFakeApi({ 'GET /api/auth/session': () => json(200, SESSION), 'POST /api/auth/logout': () => apiError(403, 'CSRF_TOKEN_INVALID') })
    const app = renderApp('/logout')
    fireEvent.click(await screen.findByRole('button', { name: '清理本机草稿并退出' }))
    const restart = await screen.findByRole('button', { name: '重新预览当前账户' })
    expect(api.requests.map(request => request.key)).toEqual(['GET /api/auth/session', 'POST /api/auth/logout'])
    expect(screen.queryByText(/@alice/)).not.toBeInTheDocument()
    fireEvent.click(restart)
    expect(app.page.visits).toEqual(['reload'])
  })

  it('同一人新登录也立即撤下旧预览，不自动退出', async () => {
    const api = installFakeApi({ 'GET /api/auth/session': () => json(200, SESSION) })
    renderApp('/logout')
    await screen.findByRole('button', { name: '清理本机草稿并退出' })
    act(() => setApiSession({ ...SESSION, csrfToken: 'new-token' }))
    expect(await screen.findByRole('button', { name: '重新预览当前账户' })).toBeInTheDocument()
    expect(screen.queryByText(/@alice/)).not.toBeInTheDocument()
    expect(api.requests.map(request => request.key)).toEqual(['GET /api/auth/session'])
  })
})
