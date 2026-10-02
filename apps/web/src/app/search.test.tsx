// 顶栏的搜索框与搜索结果页（M2-P4 设计 §3.7，US-M2-12）：按标题搜索我能访问的文档，结果给出它在哪里与更新时间。
// 结果页按需加载，页头里只有跳过去的搜索框。接口用假的 fetch。
import type { SearchResult, SessionResponse } from '@nerve-office/contracts'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { apiError, installFakeApi, json } from '../shared/testing/fake-api.test-support.ts'
import { personIn, shownName } from '../shared/testing/people.test-support.ts'
import { spaceRoutes } from '../shared/testing/spaces.test-support.ts'
import { currentPath, renderApp } from './render-app.test-support.tsx'

const SESSION: SessionResponse = {
  user: { id: '0199a2c4-0000-7000-8000-00000000000a', username: 'amy', displayName: '艾米', systemRole: 'member' },
  personalSpace: { id: '0199a2c4-0000-7000-8000-0000000000a1', name: '艾米' },
  csrfToken: 'csrf-1',
}

const WEEKLY_ID = '0199a2c4-0000-7000-8000-0000000000d1'

function searchKey(query: string, cursor?: string): string {
  const params = new URLSearchParams({ query })
  if (cursor !== undefined)
    params.set('cursor', cursor)
  return `GET /api/search?${params.toString()}`
}

function result(changes: Partial<SearchResult> = {}): SearchResult {
  return {
    id: WEEKLY_ID,
    title: '周报',
    type: 'sheet',
    createdAt: '2026-09-29T01:00:00.000Z',
    updatedAt: '2026-09-29T02:00:00.000Z',
    space: { id: '0199a2c4-0000-7000-8000-0000000000c1', type: 'team', name: '市场部' },
    folderId: '0199a2c4-0000-7000-8000-0000000000f1',
    folderPath: ['方案', '二季度'],
    accessVia: 'space',
    ...changes,
  }
}

function loggedIn(handlers: Parameters<typeof installFakeApi>[0] = {}) {
  return installFakeApi({
    'GET /api/auth/session': () => json(200, SESSION),
    ...spaceRoutes(SESSION),
    [`GET /api/documents?${new URLSearchParams({ spaceId: SESSION.personalSpace.id }).toString()}`]: () => json(200, { items: [], nextCursor: null }),
    ...handlers,
  })
}

describe('US-M2-12 按标题搜索', () => {
  it('页头的搜索框带着关键词跳到结果页：地址里有关键词，刷新与分享都拿得到同一批结果', async () => {
    loggedIn({ [searchKey('周报')]: () => json(200, { items: [result()], nextCursor: null }) })
    const app = renderApp('/')
    const box = await screen.findByRole('search')
    fireEvent.change(within(box).getByLabelText('按标题搜索文档'), { target: { value: '周报' } })
    fireEvent.submit(box)
    expect(await screen.findByRole('heading', { name: '“周报”的搜索结果' })).toBeInTheDocument()
    expect(currentPath(app)).toBe('/search?q=%E5%91%A8%E6%8A%A5')
  })

  it('结果给出空间名、文件夹路径与更新时间；点结果打开文档；排序写明是最近更新在前', async () => {
    loggedIn({ [searchKey('周报')]: () => json(200, { items: [result()], nextCursor: null }) })
    renderApp('/search?q=周报')
    const item = within(await screen.findByRole('list', { name: '搜索结果' })).getByRole('listitem')
    expect(within(item).getByRole('link')).toHaveAttribute('href', `/documents/${WEEKLY_ID}`)
    expect(item).toHaveTextContent('市场部 / 方案 / 二季度')
    expect(item).toHaveTextContent('更新于 2026年9月29日')
    expect(screen.getByText('按标题匹配，最近更新在前。')).toBeInTheDocument()
  })

  it('所在的空间（M2-P5）：自己的个人空间写"我的空间"；别人的个人空间（凭单独授权命中）按所有者的人名呈现（人名组件），不带文件夹路径；不用个人空间存的名称', async () => {
    const ben = { id: '0199a2c4-0000-7000-8000-00000000000b', username: 'ben', displayName: '本' }
    loggedIn({
      [searchKey('周报')]: () => json(200, {
        items: [
          result({ space: { id: SESSION.personalSpace.id, type: 'personal', owner: { id: SESSION.user.id, username: 'amy', displayName: '艾米' } }, folderPath: ['方案'] }),
          result({ id: '0199a2c4-0000-7000-8000-0000000000d2', title: '本的周报', space: { id: '0199a2c4-0000-7000-8000-0000000000b1', type: 'personal', owner: ben }, folderId: null, folderPath: [], accessVia: 'grant' }),
          result({ id: '0199a2c4-0000-7000-8000-0000000000d3', title: '部门的周报', folderId: null, folderPath: [], accessVia: 'grant' }),
        ],
        nextCursor: null,
      }),
    })
    renderApp('/search?q=周报')
    const [mine, others, team] = within(await screen.findByRole('list', { name: '搜索结果' })).getAllByRole('listitem')
    expect(mine).toHaveTextContent('我的空间 / 方案 · 更新于')
    expect(others).toHaveTextContent(`${shownName('本', 'ben')} 的个人空间 · 更新于`)
    personIn(others as HTMLElement, '本', 'ben')
    expect(others).not.toHaveTextContent('我的空间')
    expect(team).toHaveTextContent('市场部 · 更新于')
  })

  it('没有关键词：说明怎么用，不发请求', async () => {
    const api = loggedIn()
    renderApp('/search')
    expect(await screen.findByText('输入关键词后按“搜索”，按标题查找你能访问的文档。')).toBeInTheDocument()
    expect(api.requests.some(request => request.key.startsWith('GET /api/search'))).toBe(false)
  })

  it('一个也没搜到：说明关键词，并指出回收站里的不算', async () => {
    loggedIn({ [searchKey('不存在的表')]: () => json(200, { items: [], nextCursor: null }) })
    renderApp('/search?q=不存在的表')
    expect(await screen.findByText('没有找到标题包含“不存在的表”的文档（回收站里的不算）')).toBeInTheDocument()
  })

  it('搜索失败：说明原因，可以重试；成功之后能按游标加载下一页', async () => {
    const api = loggedIn({ [searchKey('周报')]: () => apiError(500, 'INTERNAL_ERROR') })
    renderApp('/search?q=周报')
    expect(await screen.findByText('搜索失败', {}, { timeout: 3000 })).toBeInTheDocument()
    api.on(searchKey('周报'), () => json(200, { items: [result()], nextCursor: 'c1' }))
    api.on(searchKey('周报', 'c1'), () => json(200, { items: [result({ id: '0199a2c4-0000-7000-8000-0000000000d2', title: '旧周报', folderPath: [] })], nextCursor: null }))
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    fireEvent.click(await screen.findByRole('button', { name: '加载更多' }))
    expect(await screen.findByText('旧周报')).toBeInTheDocument()
  })

  it('最后一页加载完"加载更多"随之消失：焦点移到第一条新结果，不落到 body（M2-P6 复核 S3 的 P13）', async () => {
    loggedIn({
      [searchKey('周报')]: () => json(200, { items: [result()], nextCursor: 'c1' }),
      [searchKey('周报', 'c1')]: () => json(200, { items: [result({ id: '0199a2c4-0000-7000-8000-0000000000d2', title: '旧周报', folderPath: [] })], nextCursor: null }),
    })
    renderApp('/search?q=周报')
    const more = await screen.findByRole('button', { name: '加载更多' })
    more.focus()
    fireEvent.click(more)
    expect(await screen.findByText('旧周报')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '加载更多' })).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('link', { name: /旧周报/ })))
  })

  it('加载中：读屏读得到"正在搜索…"（状态写在骨架屏的容器上，M2-P6 复核 S4）；浏览器标签页的标题是这次搜索（WCAG 2.4.2）', async () => {
    loggedIn({ [searchKey('周报')]: async () => new Promise<Response>(() => {}) })
    renderApp('/search?q=周报')
    expect(await screen.findByRole('status', { name: '正在搜索…' })).toBeInTheDocument()
    await waitFor(() => expect(document.title).toBe('“周报”的搜索结果 - NerveOffice'))
  })

  it('加载中有自己的说明；关键词只有空白时按没有关键词处理（契约在客户端就拦下）', async () => {
    const api = loggedIn()
    renderApp('/search?q=%20%20')
    await waitFor(() => expect(screen.getByText('输入关键词后按“搜索”，按标题查找你能访问的文档。')).toBeInTheDocument())
    expect(api.requests.some(request => request.key.startsWith('GET /api/search'))).toBe(false)
  })
})
