// 左侧导航的团队空间：留着之前的列表、刷新却失败了时说明没能刷新、可以重试（Codex 对抗评审 CX5）；第一次就没取到时说明加载失败、可以重试。
// 重试成功、说明连同"重试"一起消失时焦点交给一直在的"团队空间"标题，不落到 body（规范 §2.4）。
import type { SessionResponse, SpaceListResponse } from '@nerve-office/contracts'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { apiError, installFakeApi, inTurn, json } from '../../shared/testing/fake-api.test-support.ts'
import { sessionQueryOptions } from '../auth/index.ts'
import { SpaceNav } from './space-nav.tsx'
import { spacesQueryOptions } from './spaces-api.ts'

const SESSION: SessionResponse = {
  user: { id: '0199a2c4-1f2e-7a3b-8c4d-00000000000a', username: 'alice', displayName: '爱丽丝', systemRole: 'member' },
  personalSpace: { id: '0199a2c4-2a3b-7c4d-9e5f-00000000000a', name: '爱丽丝' },
  csrfToken: 'csrf-alice',
}

const PERMISSIONS = { canCreateDocuments: true, canCreateFolders: true, canViewMembers: true, canManageMembers: false, canRename: false, canPurgeTrash: false }

function teamSpace(id: string, name: string): SpaceListResponse['items'][number] {
  return { id, type: 'team', name, status: 'active', visibleToAll: false, role: 'editor', permissions: PERMISSIONS }
}

const BEFORE: SpaceListResponse = { items: [teamSpace('0199a2c4-0000-7000-8000-0000000000b1', '市场部')] }
const AFTER: SpaceListResponse = { items: [teamSpace('0199a2c4-0000-7000-8000-0000000000b1', '市场部'), teamSpace('0199a2c4-0000-7000-8000-0000000000b2', '研发部')] }

/** 导航（缓存里已经有了团队空间的列表时 cached 为真），之后的请求由测试给出 */
function renderNav(cached = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } })
  client.setQueryData(sessionQueryOptions().queryKey, SESSION)
  if (cached)
    client.setQueryData(spacesQueryOptions().queryKey, BEFORE)
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SpaceNav />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return client
}

describe('左侧导航的团队空间（M2-P2 设计 §3.10）', () => {
  it('留着之前的列表、刷新却失败了：说明没能刷新、之前的照常显示；按"重试"成功之后说明消失，焦点交给"团队空间"这个标题（不落到 body）', async () => {
    installFakeApi({ 'GET /api/spaces': inTurn(() => apiError(503, 'SERVICE_UNAVAILABLE', '服务暂时不可用'), () => json(200, AFTER)) })
    const client = renderNav()
    expect(screen.getByRole('link', { name: '市场部' })).toBeInTheDocument()
    await act(async () => client.refetchQueries({ queryKey: spacesQueryOptions().queryKey }))
    const problem = await screen.findByRole('alert')
    expect(problem).toHaveTextContent('没能刷新')
    expect(screen.getByRole('link', { name: '市场部' })).toBeInTheDocument()
    const retry = within(problem).getByRole('button', { name: '重试' })
    retry.focus()
    fireEvent.click(retry)
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.getByRole('link', { name: '研发部' })).toBeInTheDocument()
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: '团队空间' }))
  })

  it('第一次就没取到：说明加载失败、可以重试；重试期间说明与"重试"留着（同一个按钮，不可用、说正在重试），焦点还在它上面；取到之后说明消失，焦点交给"团队空间"这个标题（不落到 body，规范 §2.4）', async () => {
    let answer: (response: Response) => void = () => {}
    const retried = new Promise<Response>((resolve) => {
      answer = resolve
    })
    installFakeApi({ 'GET /api/spaces': inTurn(() => apiError(503, 'SERVICE_UNAVAILABLE', '服务暂时不可用'), async () => retried) })
    renderNav(false)
    const problem = await screen.findByRole('alert')
    expect(problem).toHaveTextContent('空间列表加载失败')
    const retry = within(problem).getByRole('button', { name: '重试' })
    retry.focus()
    fireEvent.click(retry)
    await waitFor(() => expect(retry).toHaveTextContent('正在重试…'))
    expect(screen.getByRole('alert')).toBe(problem)
    expect(retry).toHaveAttribute('aria-disabled', 'true')
    expect(retry).toHaveAttribute('aria-busy', 'true')
    expect(screen.queryByRole('status', { name: '正在加载空间列表…' })).toBeNull()
    expect(document.activeElement).toBe(retry)
    answer(json(200, AFTER))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.getByRole('link', { name: '研发部' })).toBeInTheDocument()
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: '团队空间' }))
  })
})
