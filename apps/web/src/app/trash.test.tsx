// 回收站页（M2-P4 设计 §3.7，规则细则见 specs/P4-S3-回收站的规则.md，US-M2-09）：按空间列出删除单元、恢复、永久删除。
// 按需加载的页面，所以这里可以用弹窗（永久删除要确认）。接口用假的 fetch。
import type { SessionResponse, TrashEntry } from '@nerve-office/contracts'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { formatDateTime } from '../shared/lib/format.ts'
import { apiError, installFakeApi, json, networkFailure } from '../shared/testing/fake-api.test-support.ts'
import { personIn } from '../shared/testing/people.test-support.ts'
import { personalSpaceOf, spaceRoutes } from '../shared/testing/spaces.test-support.ts'
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
    // 删除者用 PersonName（显示名与登录名分开呈现），时间另起一行（M2-P6 复核 M2）
    expect(personIn(row, '艾米', 'amy')).toBeInTheDocument()
    expect(within(row).getByText(formatDateTime('2026-09-29T02:00:00.000Z'))).toBeInTheDocument()
    expect(within(row).getByText('空间的根目录')).toBeInTheDocument()
  })

  it('删除者的显示名是从右到左的文字：在 <bdi> 里，不打乱同一格里的时间（M2-P6 复核 M2）', async () => {
    loggedIn({ [TRASH_KEY]: () => json(200, { items: [entry({ deletedBy: { id: SESSION.user.id, username: 'shalom', displayName: 'שלום' } })], nextCursor: null }) })
    renderApp(TRASH_PATH)
    const row = await rowOf('方案')
    const name = personIn(row, 'שלום', 'shalom')
    expect(name.querySelector('bdi')).toHaveTextContent('שלום')
    // 时间不与名字拼在同一段文字里：它在自己的元素里
    expect(within(row).getByText(formatDateTime('2026-09-29T02:00:00.000Z')).tagName).toBe('TIME')
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
    // 这样的页面同样有标题（M2-P6 复核 G5）
    expect(screen.getByRole('heading', { level: 1, name: '空间不存在' })).toBeInTheDocument()
  })
})

describe('US-M2-09 回收站：没能完成时（M2-P6 复核 S1–S5）', () => {
  it('恢复得到 404，而整个空间已经看不到了：页面换成"空间不存在"，不留着旧的行，也不说"列表已刷新"（P4）', async () => {
    let gone = false
    loggedIn({
      [`GET /api/spaces/${SPACE_ID}`]: () => (gone ? apiError(404, 'NOT_FOUND') : json(200, personalSpaceOf(SESSION))),
      [TRASH_KEY]: () => (gone ? apiError(404, 'NOT_FOUND') : json(200, { items: [entry()], nextCursor: null })),
      [`POST /api/trash/${ENTRY_ID}/restore`]: () => {
        gone = true
        return apiError(404, 'NOT_FOUND')
      },
    })
    renderApp(TRASH_PATH)
    fireEvent.click(await screen.findByRole('button', { name: '恢复 方案' }))
    expect(await screen.findByText('空间不存在，或者你没有访问权限')).toBeInTheDocument()
    expect(screen.queryByRole('table', { name: '回收站列表' })).toBeNull()
    expect(screen.queryByRole('button', { name: '恢复 方案' })).toBeNull()
    expect(screen.queryByText(/列表已刷新/)).toBeNull()
  })

  it('恢复得到 403（空间刚被归档）：回收站与页头按新的权限重新请求，"恢复"随之消失；服务端说的原因写在说明里，说明接住焦点（P5）', async () => {
    let archived = false
    const api = loggedIn({
      [TRASH_KEY]: () => json(200, { items: [entry({ permissions: archived ? { canRestore: false, canPurge: false } : { canRestore: true, canPurge: true } })], nextCursor: null }),
      [`POST /api/trash/${ENTRY_ID}/restore`]: () => {
        archived = true
        return apiError(403, 'PERMISSION_DENIED', '空间已归档，只能查看')
      },
    })
    renderApp(TRASH_PATH)
    const restore = await screen.findByRole('button', { name: '恢复 方案' })
    restore.focus()
    const listed = api.requests.filter(request => request.key === TRASH_KEY).length
    fireEvent.click(restore)
    const text = '没能恢复「方案」：空间已归档，只能查看'
    expect(await screen.findByText(text)).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('button', { name: '恢复 方案' })).toBeNull())
    expect(api.requests.filter(request => request.key === TRASH_KEY).length).toBeGreaterThan(listed)
    expect(api.requests.filter(request => request.key === `GET /api/spaces/${SPACE_ID}`).length).toBeGreaterThan(1)
    expect(screen.queryByText('你没有执行这个操作的权限')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText(text).closest('[tabindex="-1"]')))
  })

  it('恢复的结果未知：列表刷新，说明它可能已经恢复了（S1）', async () => {
    let items = [entry()]
    loggedIn({
      [TRASH_KEY]: () => json(200, { items, nextCursor: null }),
      [`POST /api/trash/${ENTRY_ID}/restore`]: () => {
        items = []
        return networkFailure()
      },
    })
    renderApp(TRASH_PATH)
    fireEvent.click(await screen.findByRole('button', { name: '恢复 方案' }))
    expect(await screen.findByText('没能确认「方案」是否已经恢复（网络连接失败，请检查网络后重试）。列表已刷新：它已经不在回收站里，就是恢复好了。')).toBeInTheDocument()
    expect(await screen.findByText('回收站里没有内容')).toBeInTheDocument()
  })

  it('最后一页加载完"加载更多"随之消失：焦点移到第一条新行，不落到 body（P13）', async () => {
    loggedIn({
      [TRASH_KEY]: () => json(200, { items: [entry()], nextCursor: 'c1' }),
      [`GET /api/trash?${new URLSearchParams({ spaceId: SPACE_ID, cursor: 'c1' }).toString()}`]: () => json(200, { items: [entry({ id: '0199a2c4-0000-7000-8000-0000000000e2', title: '旧周报', kind: 'document', documentCount: 1 })], nextCursor: null }),
    })
    renderApp(TRASH_PATH)
    const more = await screen.findByRole('button', { name: '加载更多' })
    more.focus()
    fireEvent.click(more)
    expect(await screen.findByText('旧周报')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '加载更多' })).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText('旧周报').closest('tr')))
  })

  it('浏览器标签页的标题是这个回收站（WCAG 2.4.2，S4）', async () => {
    loggedIn({ [TRASH_KEY]: () => json(200, { items: [entry()], nextCursor: null }) })
    renderApp(TRASH_PATH)
    await screen.findByRole('heading', { name: '我的空间 的回收站' })
    await waitFor(() => expect(document.title).toBe('我的空间 的回收站 - NerveOffice'))
  })
})
