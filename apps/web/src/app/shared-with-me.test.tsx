// "与我共享"页（M2-P5 设计 §3.5，US-M2-10）：别人单独分享给我的文档，每条显示文档与所属的空间——团队空间写名称，个人空间按所有者的
// 人名呈现（人名组件，不用个人空间存的名称），不显示所在位置；分页与焦点照既有的约定（"加载更多"之后焦点到第一条新内容），
// 加载中读屏读得到，每页一个 h1，浏览器标签页的标题。路由级按需加载。接口用假的 fetch。
// 每条的"操作"（Codex 对抗评审 CX3，US-M2-08）：与空间的文档列表同一个行内操作，按服务端给的权限只列出能做的——只凭授权时编辑者能改名，
// 能读就能复制，没有移动、删除与分享；复制的目标是自己能新建的空间，不显示源空间的目录结构。
import type { DocumentDetail, SessionResponse, SharedDocument, SpaceView } from '@nerve-office/contracts'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { apiError, installFakeApi, inTurn, json } from '../shared/testing/fake-api.test-support.ts'
import { personIn, shownName } from '../shared/testing/people.test-support.ts'
import { foldersKey, noFolders, personalSpaceOf, spaceRoutes } from '../shared/testing/spaces.test-support.ts'
import { renderApp } from './render-app.test-support.tsx'

const SESSION: SessionResponse = {
  user: { id: '0199a2c4-0000-7000-8000-00000000000a', username: 'amy', displayName: '艾米', systemRole: 'member' },
  personalSpace: { id: '0199a2c4-0000-7000-8000-0000000000a1', name: '艾米' },
  csrfToken: 'csrf-1',
  features: { localDraftsEnabled: true },
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
    // 页面的说明不假定"我在那个空间里没有角色"：这一页本来就包括我在那个空间里也有角色的（M2-P5 审查 B 的 S4）
    expect(screen.getByText('别人单独分享给你的文档。分享只给这些文档本身，不给它们所在空间里的其他内容；你在那个空间里另有角色的，照样按那个角色访问。')).toBeInTheDocument()
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

/** 只凭单独授权看到的一份（不在那个空间里）：服务端给的详情——不带所在的文件夹，结构性的操作一律不能做（M2-P5 设计 §3.4(1)） */
function grantDetail(document: SharedDocument, role: 'viewer' | 'editor', changes: Partial<DocumentDetail> = {}): DocumentDetail {
  const editor = role === 'editor'
  return {
    id: document.id,
    title: document.title,
    type: document.type,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    spaceId: document.space.id,
    space: { id: document.space.id, type: 'team', name: '市场部' },
    folderId: null,
    accessVia: 'grant',
    revision: 3,
    profile: 'sheet@1',
    formatVersion: 1,
    sdkVersion: '1.0.1',
    formulasPending: false,
    permissions: { canEdit: editor, canRename: editor, canMoveWithinSpace: false, canMoveAcrossSpaces: false, canCopy: true, canDelete: false, canShare: false, canTakeOver: false },
    ...changes,
  }
}

const READ_ONLY = shared('0199a2c4-0000-7000-8000-0000000000d4', '只读的报表', { contentRole: 'viewer' })
const EDITABLE = shared('0199a2c4-0000-7000-8000-0000000000d5', '能改的周报', { contentRole: 'editor' })

/** 我在一个团队空间里能新建（不是这几份所在的"市场部"）：复制的候选是它与我的个人空间 */
const MY_TEAM: SpaceView = {
  id: '0199a2c4-0000-7000-8000-0000000000c9',
  type: 'team',
  name: '我的小组',
  status: 'active',
  visibleToAll: false,
  role: 'editor',
  permissions: { canCreateDocuments: true, canCreateFolders: true, canViewMembers: true, canManageMembers: false, canRename: false, canPurgeTrash: false },
}

function detailKey(document: SharedDocument): string {
  return `GET /api/documents/${document.id}`
}

/** 展开一条的"操作"，等到面板里的操作出现（权限已经取到） */
async function openActions(title: string): Promise<HTMLElement> {
  const trigger = await screen.findByRole('button', { name: `操作 ${title}` })
  trigger.focus()
  fireEvent.click(trigger)
  await screen.findByRole('button', { name: '复制' })
  return trigger
}

function count(api: ReturnType<typeof installFakeApi>, key: string): number {
  return api.requests.filter(request => request.key === key).length
}

/** 取过哪些目录（GET /api/folders 的请求），按发出的顺序 */
function folderRequests(api: ReturnType<typeof installFakeApi>): string[] {
  return api.requests.filter(request => request.key.startsWith('GET /api/folders')).map(request => request.key)
}

/** open() 之后才回应的接口：每次请求都在那之后各得到一份新的响应（同一个响应体只能读一次） */
function gated(respond: () => Response) {
  let open: () => void = () => {}
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return {
    handler: async () => {
      await opened
      return respond()
    },
    open: () => open(),
  }
}

/** 这一条（列表里的 li）上的按钮的文字，按出现的顺序 */
function buttonsOf(title: string): (string | null)[] {
  const item = screen.getByRole('link', { name: new RegExp(title) }).closest('li') as HTMLElement
  return within(item).getAllByRole('button').map(button => button.textContent)
}

describe('US-M2-08 "与我共享"的行内操作（Codex 对抗评审 CX3）', () => {
  it('入口按服务端给的权限显示：只凭授权的查看者只有复制；编辑者有改名与复制；都没有移动、删除与分享', async () => {
    loggedIn({
      [sharedKey()]: () => json(200, { items: [READ_ONLY, EDITABLE], nextCursor: null }),
      [detailKey(READ_ONLY)]: () => json(200, grantDetail(READ_ONLY, 'viewer')),
      [detailKey(EDITABLE)]: () => json(200, grantDetail(EDITABLE, 'editor')),
    })
    renderApp('/shared')
    const trigger = await openActions('只读的报表')
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(buttonsOf('只读的报表')).toEqual(['操作', '复制', '取消'])

    // 收起，焦点回到这一条的"操作"；再展开另一条
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    await openActions('能改的周报')
    expect(buttonsOf('能改的周报')).toEqual(['操作', '改名', '复制', '取消'])
    expect(screen.queryByRole('button', { name: /^(?:移动|删除|分享)$/ })).toBeNull()
  })

  it('复制：目标是自己能新建的空间（我的空间与我的小组），源空间不在其中、不显示它的目录结构；复制到我的空间，说明给出打开副本的链接；"与我共享"不因复制刷新', async () => {
    const copyId = '0199a2c4-0000-7000-8000-0000000000e1'
    const api = loggedIn({
      ...spaceRoutes(SESSION, [MY_TEAM]),
      [sharedKey()]: () => json(200, { items: [READ_ONLY], nextCursor: null }),
      [detailKey(READ_ONLY)]: () => json(200, grantDetail(READ_ONLY, 'viewer')),
      [foldersKey(SESSION.personalSpace.id)]: noFolders(),
      [`POST /api/documents/${READ_ONLY.id}/copy`]: () => json(201, {
        ...grantDetail(READ_ONLY, 'viewer'),
        id: copyId,
        title: '只读的报表 的副本',
        spaceId: SESSION.personalSpace.id,
        space: { id: SESSION.personalSpace.id, type: 'personal' },
        accessVia: 'space',
        revision: 1,
        permissions: { canEdit: true, canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: true, canCopy: true, canDelete: true, canShare: true, canTakeOver: true },
        replayed: false,
      }),
    })
    renderApp('/shared')
    await openActions('只读的报表')
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    const form = screen.getByRole('form', { name: '复制' })
    // 候选只有能新建的空间：源空间（市场部）不在其中，它的目录也就不会被取
    expect(within(form).getAllByRole('option').map(option => option.textContent)).toEqual(['我的空间', '我的小组'])
    expect(within(form).getByLabelText('目标空间')).toHaveValue(SESSION.personalSpace.id)
    expect(await within(form).findByText('这里没有子文件夹')).toBeInTheDocument()
    expect(api.requests.some(request => request.key === foldersKey(READ_ONLY.space.id))).toBe(false)
    expect(screen.queryByText('市场部', { selector: 'option' })).toBeNull()

    fireEvent.click(within(form).getByRole('button', { name: '复制到这里' }))
    const notice = await screen.findByText('已复制出「只读的报表 的副本」')
    expect(notice.closest('[role="status"]')).not.toBeNull()
    expect(screen.getByRole('link', { name: '打开副本' })).toHaveAttribute('href', `/documents/${copyId}`)
    expect(api.requests.find(request => request.key === `POST /api/documents/${READ_ONLY.id}/copy`)?.body).toEqual({ spaceId: SESSION.personalSpace.id, requestId: expect.stringMatching(/^[\da-f-]{36}$/) as unknown })
    // 复制不改动源文档："与我共享"不重新请求（刷新的是副本所在空间的列表）
    expect(count(api, sharedKey())).toBe(1)
  })

  it('复制：导航的空间列表还没取到时，说明正在加载可以复制到的空间，不取任何目录、不能提交；列表晚到之后选上我能新建的空间（我的空间），只取它的目录，从不取源空间的（M2 Codex 评审复验的一般 1）', async () => {
    const spaces = gated(() => json(200, { items: [personalSpaceOf(SESSION), MY_TEAM] }))
    const api = loggedIn({
      'GET /api/spaces': spaces.handler,
      [sharedKey()]: () => json(200, { items: [READ_ONLY], nextCursor: null }),
      [detailKey(READ_ONLY)]: () => json(200, grantDetail(READ_ONLY, 'viewer')),
      [foldersKey(SESSION.personalSpace.id)]: noFolders(),
    })
    renderApp('/shared')
    await openActions('只读的报表')
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    const form = screen.getByRole('form', { name: '复制' })
    expect(within(form).getByRole('status', { name: '正在加载可以复制到的空间…' })).toBeInTheDocument()
    const submit = within(form).getByRole('button', { name: '复制到这里' })
    expect(submit).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(submit)
    expect(folderRequests(api)).toEqual([])
    expect(api.requests.some(request => request.key.startsWith('POST '))).toBe(false)

    spaces.open()
    expect(await within(form).findByText('这里没有子文件夹')).toBeInTheDocument()
    expect(within(form).getByLabelText('目标空间')).toHaveValue(SESSION.personalSpace.id)
    expect(within(form).getByRole('button', { name: '复制到这里' })).toHaveAttribute('aria-disabled', 'false')
    expect(folderRequests(api)).toEqual([foldersKey(SESSION.personalSpace.id)])
  })

  it('复制：导航的空间列表取不到（连同一次自动重试）时，说明原因、给出重试，不取任何目录、不能提交；重试取到之后选上我能新建的空间', async () => {
    const api = loggedIn({
      'GET /api/spaces': inTurn(
        () => apiError(500, 'INTERNAL_ERROR'),
        () => apiError(500, 'INTERNAL_ERROR'),
        () => json(200, { items: [personalSpaceOf(SESSION), MY_TEAM] }),
      ),
      [sharedKey()]: () => json(200, { items: [READ_ONLY], nextCursor: null }),
      [detailKey(READ_ONLY)]: () => json(200, grantDetail(READ_ONLY, 'viewer')),
      [foldersKey(SESSION.personalSpace.id)]: noFolders(),
    })
    renderApp('/shared')
    await openActions('只读的报表')
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    const form = screen.getByRole('form', { name: '复制' })
    const problem = await within(form).findByText('可以复制到的空间没能加载：服务器出了点问题，请稍后重试', {}, { timeout: 4000 })
    const alert = problem.closest('[role="alert"]') as HTMLElement
    expect(alert).not.toBeNull()
    expect(within(form).getByRole('button', { name: '复制到这里' })).toHaveAttribute('aria-disabled', 'true')
    expect(folderRequests(api)).toEqual([])

    fireEvent.click(within(alert).getByRole('button', { name: '重试' }))
    expect(await within(form).findByText('这里没有子文件夹')).toBeInTheDocument()
    expect(within(form).getByLabelText('目标空间')).toHaveValue(SESSION.personalSpace.id)
    expect(folderRequests(api)).toEqual([foldersKey(SESSION.personalSpace.id)])
    expect(count(api, 'GET /api/spaces')).toBe(3)
  })

  it('复制：我在哪个空间里都不能新建（候选一个也没有，源空间也不在其中）：说清楚没有可以复制到的空间，不取任何目录、不能提交', async () => {
    const personal = personalSpaceOf(SESSION)
    const api = loggedIn({
      'GET /api/spaces': () => json(200, { items: [{ ...personal, permissions: { ...personal.permissions, canCreateDocuments: false } }] }),
      [sharedKey()]: () => json(200, { items: [READ_ONLY], nextCursor: null }),
      [detailKey(READ_ONLY)]: () => json(200, grantDetail(READ_ONLY, 'viewer')),
    })
    renderApp('/shared')
    await openActions('只读的报表')
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    const form = screen.getByRole('form', { name: '复制' })
    expect(await within(form).findByText('没有可以复制到的空间：你在任何空间里都不能新建文档。')).toBeInTheDocument()
    expect(within(form).queryByLabelText('目标空间')).toBeNull()
    expect(within(form).getByRole('button', { name: '复制到这里' })).toHaveAttribute('aria-disabled', 'true')
    expect(folderRequests(api)).toEqual([])
  })

  it('只凭授权的编辑者改名：成功之后"与我共享"随即刷新、是新的标题，焦点回到这一条的"操作"', async () => {
    const api = loggedIn({
      [sharedKey()]: inTurn(() => json(200, { items: [EDITABLE], nextCursor: null }), () => json(200, { items: [{ ...EDITABLE, title: '改好的周报' }], nextCursor: null })),
      [detailKey(EDITABLE)]: () => json(200, grantDetail(EDITABLE, 'editor')),
      [`PATCH /api/documents/${EDITABLE.id}`]: () => json(200, grantDetail(EDITABLE, 'editor', { title: '改好的周报' })),
    })
    renderApp('/shared')
    await openActions('能改的周报')
    fireEvent.click(screen.getByRole('button', { name: '改名' }))
    const input = screen.getByLabelText('能改的周报 的新名称')
    fireEvent.change(input, { target: { value: '改好的周报' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    const renamed = await screen.findByRole('button', { name: '操作 改好的周报' })
    expect(api.requests.find(request => request.key === `PATCH /api/documents/${EDITABLE.id}`)?.body).toEqual({ title: '改好的周报' })
    expect(count(api, sharedKey())).toBe(2)
    await waitFor(() => expect(document.activeElement).toBe(renamed))
  })

  it('展开时这一份已经看不到了（404：分享被取消或者已删除）："与我共享"随即刷新，说明里说出这一页的可能原因；看不到它所在的空间，不给"打开回收站"', async () => {
    const api = loggedIn({
      [sharedKey()]: inTurn(() => json(200, { items: [READ_ONLY], nextCursor: null }), () => json(200, { items: [], nextCursor: null })),
      [detailKey(READ_ONLY)]: () => apiError(404, 'NOT_FOUND'),
    })
    renderApp('/shared')
    fireEvent.click(await screen.findByRole('button', { name: '操作 只读的报表' }))
    const notice = await screen.findByText('「只读的报表」已经不在这里了（可能已经删除，或者分享已被取消），列表已刷新。')
    expect(screen.queryByRole('link', { name: '打开回收站' })).toBeNull()
    expect(await screen.findByText('还没有人单独分享文档给你。')).toBeInTheDocument()
    expect(count(api, sharedKey())).toBe(2)
    // 说明条接住焦点（那一行随刷新消失了）
    await waitFor(() => expect(document.activeElement).toBe(notice.closest('[role="alert"]')))
  })

  it('改名成功（200），随后刷新"与我共享"回 500：列表上方说明没能刷新（原因）、给出重试；重试成功之后说明消失，列表是新的（Codex 对抗评审 CX5）', async () => {
    const api = loggedIn({
      [sharedKey()]: inTurn(
        () => json(200, { items: [EDITABLE], nextCursor: null }),
        () => apiError(500, 'INTERNAL_ERROR'),
        () => apiError(500, 'INTERNAL_ERROR'),
        () => json(200, { items: [{ ...EDITABLE, title: '改好的周报' }], nextCursor: null }),
      ),
      [detailKey(EDITABLE)]: () => json(200, grantDetail(EDITABLE, 'editor')),
      [`PATCH /api/documents/${EDITABLE.id}`]: () => json(200, grantDetail(EDITABLE, 'editor', { title: '改好的周报' })),
    })
    renderApp('/shared')
    await openActions('能改的周报')
    fireEvent.click(screen.getByRole('button', { name: '改名' }))
    fireEvent.change(screen.getByLabelText('能改的周报 的新名称'), { target: { value: '改好的周报' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    // 刷新失败（连同一次自动重试）：之前的列表照常显示，上方明说没能刷新
    const problem = await screen.findByText('分享给你的文档没能刷新，显示的还是之前的内容', {}, { timeout: 4000 })
    const alert = problem.closest('[role="alert"]') as HTMLElement
    expect(alert).toHaveTextContent('服务器出了点问题，请稍后重试')
    expect(screen.getByRole('link', { name: /能改的周报/ })).toBeInTheDocument()
    expect(alert.compareDocumentPosition(screen.getByRole('list', { name: '分享给我的文档' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(within(alert).getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('link', { name: /改好的周报/ })).toBeInTheDocument()
    expect(screen.queryByText('分享给你的文档没能刷新，显示的还是之前的内容')).toBeNull()
    expect(count(api, sharedKey())).toBe(4)
  })
})
