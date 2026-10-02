// "与我共享"页（M2-P5 设计 §3.5，US-M2-10）：别人单独分享给我的文档，每条显示文档与所属的空间——团队空间写名称，个人空间按所有者的
// 人名呈现（人名组件，不用个人空间存的名称），不显示所在位置；分页与焦点照既有的约定（"加载更多"之后焦点到第一条新内容），
// 加载中读屏读得到，每页一个 h1，浏览器标签页的标题。路由级按需加载。接口用假的 fetch。
import type { SessionResponse, SharedDocument } from '@nerve-office/contracts'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { apiError, installFakeApi, json } from '../shared/testing/fake-api.test-support.ts'
import { personIn, shownName } from '../shared/testing/people.test-support.ts'
import { spaceRoutes } from '../shared/testing/spaces.test-support.ts'
import { renderApp } from './render-app.test-support.tsx'

const SESSION: SessionResponse = {
  user: { id: '0199a2c4-0000-7000-8000-00000000000a', username: 'amy', displayName: '艾米', systemRole: 'member' },
  personalSpace: { id: '0199a2c4-0000-7000-8000-0000000000a1', name: '艾米' },
  csrfToken: 'csrf-1',
}

const BEN = { id: '0199a2c4-0000-7000-8000-00000000000b', username: 'ben', displayName: '本' }

function shared(id: string, title: string, changes: Partial<SharedDocument> = {}): SharedDocument {
  return {
    id,
    title,
    type: 'sheet',
    createdAt: '2026-09-29T01:00:00.000Z',
    updatedAt: '2026-09-29T02:00:00.000Z',
    space: { id: '0199a2c4-0000-7000-8000-0000000000c1', type: 'team', name: '市场部' },
    contentRole: 'viewer',
    ...changes,
  }
}

const IN_TEAM = shared('0199a2c4-0000-7000-8000-0000000000d1', '团队的周报', { contentRole: 'editor' })
const IN_PERSONAL = shared('0199a2c4-0000-7000-8000-0000000000d2', '本的预算', { space: { id: '0199a2c4-0000-7000-8000-0000000000b1', type: 'personal', owner: BEN } })

function sharedKey(cursor?: string): string {
  return cursor === undefined ? 'GET /api/shared' : `GET /api/shared?${new URLSearchParams({ cursor }).toString()}`
}

function loggedIn(handlers: Parameters<typeof installFakeApi>[0] = {}) {
  return installFakeApi({
    'GET /api/auth/session': () => json(200, SESSION),
    ...spaceRoutes(SESSION),
    ...handlers,
  })
}

describe('US-M2-10 "与我共享"页', () => {
  it('每条：打开编辑器页的链接、所属的空间（团队空间的名称；个人空间按所有者的人名）、能不能编辑与更新时间；不显示所在位置', async () => {
    loggedIn({ [sharedKey()]: () => json(200, { items: [IN_TEAM, IN_PERSONAL], nextCursor: null }) })
    renderApp('/shared')
    expect(await screen.findByRole('heading', { level: 1, name: '与我共享' })).toBeInTheDocument()
    await waitFor(() => expect(document.title).toBe('与我共享 - NerveOffice'))
    const [team, personal] = within(await screen.findByRole('list', { name: '分享给我的文档' })).getAllByRole('listitem')
    expect(within(team as HTMLElement).getByRole('link')).toHaveAttribute('href', `/documents/${IN_TEAM.id}`)
    expect(team).toHaveTextContent('团队的周报市场部 · 可以编辑 · 更新于 2026年9月29日')
    expect(personal).toHaveTextContent(`本的预算${shownName('本', 'ben')} 的个人空间 · 只能查看 · 更新于`)
    personIn(personal as HTMLElement, '本', 'ben')
    expect(screen.queryByText(/\//)).toBeNull()
  })

  it('自己的个人空间写"我的空间"（契约里个人空间只给所有者，不给存的名称）', async () => {
    loggedIn({ [sharedKey()]: () => json(200, { items: [shared('0199a2c4-0000-7000-8000-0000000000d3', '我的表', { space: { id: SESSION.personalSpace.id, type: 'personal', owner: { id: SESSION.user.id, username: 'amy', displayName: '艾米' } } })], nextCursor: null }) })
    renderApp('/shared')
    const item = within(await screen.findByRole('list', { name: '分享给我的文档' })).getByRole('listitem')
    expect(item).toHaveTextContent('我的表我的空间 · 只能查看')
  })

  it('一份也没有：说明；加载中读屏读得到（状态写在骨架屏的容器上）', async () => {
    let answer: (response: Response) => void = () => {}
    loggedIn({ [sharedKey()]: async () => new Promise<Response>((resolve) => {
      answer = resolve
    }) })
    renderApp('/shared')
    expect(await screen.findByRole('status', { name: '正在加载分享给你的文档…' })).toBeInTheDocument()
    answer(json(200, { items: [], nextCursor: null }))
    expect(await screen.findByText('还没有人单独分享文档给你。')).toBeInTheDocument()
  })

  it('加载失败：说明原因，可以重试', async () => {
    const api = loggedIn({ [sharedKey()]: () => apiError(500, 'INTERNAL_ERROR') })
    renderApp('/shared')
    expect(await screen.findByText('分享给你的文档没能加载', {}, { timeout: 3000 })).toBeInTheDocument()
    api.on(sharedKey(), () => json(200, { items: [IN_TEAM], nextCursor: null }))
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('团队的周报')).toBeInTheDocument()
  })

  it('"加载更多"：按游标取下一页；最后一页之后按钮消失，焦点移到第一条新内容，不落到 body', async () => {
    loggedIn({
      [sharedKey()]: () => json(200, { items: [IN_TEAM], nextCursor: 'c1' }),
      [sharedKey('c1')]: () => json(200, { items: [IN_PERSONAL], nextCursor: null }),
    })
    renderApp('/shared')
    const more = await screen.findByRole('button', { name: '加载更多' })
    more.focus()
    fireEvent.click(more)
    expect(await screen.findByText('本的预算')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '加载更多' })).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('link', { name: /本的预算/ })))
  })
})
