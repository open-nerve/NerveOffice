// 回收站页（M2-P4 设计 §3.7，规则细则见 specs/P4-S3-回收站的规则.md，US-M2-09）：按空间列出删除单元、恢复、永久删除。
// 按需加载的页面，所以这里可以用弹窗（永久删除要确认）。接口用假的 fetch。
import type { SessionResponse, TrashEntry } from '@nerve-office/contracts'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { apiError, installFakeApi, json } from '../shared/testing/fake-api.test-support.ts'
import { spaceRoutes } from '../shared/testing/spaces.test-support.ts'
import { renderApp } from './render-app.test-support.tsx'

const SESSION: SessionResponse = {
  user: { id: '0199a2c4-0000-7000-8000-00000000000a', username: 'amy', displayName: '艾米', systemRole: 'member' },
  personalSpace: { id: '0199a2c4-0000-7000-8000-0000000000a1', name: '艾米' },
  csrfToken: 'csrf-1',
}

const SPACE_ID = SESSION.personalSpace.id
const ENTRY_ID = '0199a2c4-0000-7000-8000-0000000000e1'
const TRASH_KEY = `GET /api/trash?${new URLSearchParams({ spaceId: SPACE_ID }).toString()}`
const TRASH_PATH = `/spaces/${SPACE_ID}/trash`

function entry(changes: Partial<TrashEntry> = {}): TrashEntry {
  return {
    id: ENTRY_ID,
    spaceId: SPACE_ID,
    kind: 'folder',
    title: '方案',
    deletedBy: { id: SESSION.user.id, username: 'amy', displayName: '艾米' },
    deletedAt: '2026-09-29T02:00:00.000Z',
    expiresAt: '2026-10-29T02:00:00.000Z',
    origin: { parentId: null, parentName: null, available: true },
    documentCount: 3,
    permissions: { canRestore: true, canPurge: true },
    ...changes,
  }
}

function loggedIn(handlers: Parameters<typeof installFakeApi>[0] = {}) {
  return installFakeApi({
    'GET /api/auth/session': () => json(200, SESSION),
    ...spaceRoutes(SESSION),
    ...handlers,
  })
}

async function rowOf(title: string): Promise<HTMLElement> {
  const table = await screen.findByRole('table', { name: '回收站列表' })
  return within(table).getAllByRole('row').filter(row => row.textContent?.includes(title) === true)[0] as HTMLElement
}

describe('US-M2-09 回收站', () => {
  it('每一条给出种类、名称、谁在什么时候删的、原位置、到期时间与里面的文档份数', async () => {
    loggedIn({ [TRASH_KEY]: () => json(200, { items: [entry()], nextCursor: null }) })
    renderApp(TRASH_PATH)
    expect(await screen.findByRole('heading', { name: '我的空间 的回收站' })).toBeInTheDocument()
    expect(screen.getByText('删除的内容在回收站里保留 30 天，到期后自动永久删除。')).toBeInTheDocument()
    const row = await rowOf('方案')
    expect(within(row).getByText('文件夹')).toBeInTheDocument()
    expect(within(row).getByText('3 份文档')).toBeInTheDocument()
    expect(within(row).getByText(/艾米（amy）/)).toBeInTheDocument()
    expect(within(row).getByText('空间的根目录')).toBeInTheDocument()
  })

  it('整页只有一个"回收站"的标题（读屏按标题导航不会读到两遍）；说明与恢复的规则一致（审查建议 8、4）', async () => {
    loggedIn({ [TRASH_KEY]: () => json(200, { items: [entry()], nextCursor: null }) })
    renderApp(TRASH_PATH)
    // 等列表出来：过去列表里另有一个同名的 sr-only 标题，两个标题的文本一模一样
    expect(await screen.findByText('方案')).toBeInTheDocument()
    expect(screen.getAllByRole('heading', { name: '我的空间 的回收站' })).toHaveLength(1)
    // 恢复还要求"编辑者及以上"：被降为查看者的删除者看不到"恢复"，说明不能只说"删除的人能恢复"
    expect(screen.getByText('能恢复的是空间管理员，以及删除它的人（要仍有编辑者及以上的角色）；永久删除只有空间管理员能做。')).toBeInTheDocument()
  })

  it('原位置已经不在：列表里说明；恢复之后明确告诉用户它回到了空间的根目录', async () => {
    let items = [entry({ origin: { parentId: '0199a2c4-0000-7000-8000-0000000000f9', parentName: null, available: false } })]
    loggedIn({
      [TRASH_KEY]: () => json(200, { items, nextCursor: null }),
      [`POST /api/trash/${ENTRY_ID}/restore`]: () => {
        items = []
        return json(200, { id: ENTRY_ID, kind: 'folder', title: '方案', spaceId: SPACE_ID, folderId: null, movedToRoot: true })
      },
    })
    renderApp(TRASH_PATH)
    expect(await screen.findByText('原位置已不存在')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '恢复 方案' }))
    expect(await screen.findByText('「方案」原来的位置已经不在了，已恢复到空间的根目录')).toBeInTheDocument()
    expect(screen.getByText('回收站里没有内容')).toBeInTheDocument()
  })

  it('恢复到原位置：说明只写恢复，不提根目录', async () => {
    let items = [entry({ origin: { parentId: '0199a2c4-0000-7000-8000-0000000000f8', parentName: '归档', available: true } })]
    loggedIn({
      [TRASH_KEY]: () => json(200, { items, nextCursor: null }),
      [`POST /api/trash/${ENTRY_ID}/restore`]: () => {
        items = []
        return json(200, { id: ENTRY_ID, kind: 'folder', title: '方案', spaceId: SPACE_ID, folderId: '0199a2c4-0000-7000-8000-0000000000f8', movedToRoot: false })
      },
    })
    renderApp(TRASH_PATH)
    expect(await screen.findByText('文件夹「归档」')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '恢复 方案' }))
    expect(await screen.findByText('已恢复「方案」')).toBeInTheDocument()
  })

  it('永久删除要先确认：弹窗说清楚后果，确认之后这一条就没了', async () => {
    let items = [entry()]
    const api = loggedIn({
      [TRASH_KEY]: () => json(200, { items, nextCursor: null }),
      [`DELETE /api/trash/${ENTRY_ID}`]: () => {
        items = []
        return new Response(null, { status: 204 })
      },
    })
    renderApp(TRASH_PATH)
    fireEvent.click(await screen.findByRole('button', { name: '永久删除 方案' }))
    const dialog = await screen.findByRole('dialog', { name: '永久删除「方案」？' })
    expect(within(dialog).getByText('永久删除之后内容就找不回来了，里面的文档与它们的历史一并清除。')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: '永久删除' }))
    expect(await screen.findByText('已永久删除「方案」')).toBeInTheDocument()
    expect(api.requests.some(request => request.key === `DELETE /api/trash/${ENTRY_ID}`)).toBe(true)
    // 打开弹窗的那一行已经不在：焦点交给页面的标题，不落到 body
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: '我的空间 的回收站' })))
  })

  it('别人已经动过它（404）：列表刷新，并说明这一条已经不在回收站里了', async () => {
    let items = [entry()]
    loggedIn({
      [TRASH_KEY]: () => json(200, { items, nextCursor: null }),
      [`POST /api/trash/${ENTRY_ID}/restore`]: () => {
        items = []
        return apiError(404, 'NOT_FOUND')
      },
    })
    renderApp(TRASH_PATH)
    fireEvent.click(await screen.findByRole('button', { name: '恢复 方案' }))
    expect(await screen.findByText('这一条已经不在回收站里了（可能已被别人恢复或永久删除），列表已刷新')).toBeInTheDocument()
  })

  it('权限一律读服务端给的：不能动的那一条没有恢复与永久删除', async () => {
    loggedIn({ [TRASH_KEY]: () => json(200, { items: [entry({ permissions: { canRestore: false, canPurge: false } })], nextCursor: null }) })
    renderApp(TRASH_PATH)
    expect(await screen.findByText('方案')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '恢复 方案' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '永久删除 方案' })).not.toBeInTheDocument()
  })

  it('按游标加载下一页；空间看不到了时与别处一样说明', async () => {
    loggedIn({
      [TRASH_KEY]: () => json(200, { items: [entry()], nextCursor: 'c1' }),
      [`GET /api/trash?${new URLSearchParams({ spaceId: SPACE_ID, cursor: 'c1' }).toString()}`]: () => json(200, { items: [entry({ id: '0199a2c4-0000-7000-8000-0000000000e2', title: '旧周报', kind: 'document', documentCount: 1 })], nextCursor: null }),
    })
    renderApp(TRASH_PATH)
    fireEvent.click(await screen.findByRole('button', { name: '加载更多' }))
    expect(await screen.findByText('旧周报')).toBeInTheDocument()
  })

  it('空间看不到了：与空间页同一句说明', async () => {
    loggedIn({ [`GET /api/spaces/${SPACE_ID}`]: () => apiError(404, 'NOT_FOUND') })
    renderApp(TRASH_PATH)
    await waitFor(() => expect(screen.getByText('空间不存在，或者你没有访问权限')).toBeInTheDocument())
  })
})
