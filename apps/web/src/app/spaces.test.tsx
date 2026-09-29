// 空间（M2-P2 设计 §3.10）：左侧导航、空间页（按权限显示的操作、归档、看不到、行内改名、新建到这个空间）、
// 成员页（按需加载：查看、添加、调整角色、移出，降低或移出自己先确认；只能查看；看不到）。接口用假的 fetch。
import type { SessionResponse, SpaceMember, SpaceMemberListResponse, SpaceView } from '@nerve-office/contracts'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { apiError, installFakeApi, json } from '../shared/testing/fake-api.test-support.ts'
import { documentsKey, personalSpaceOf, spaceRoutes } from '../shared/testing/spaces.test-support.ts'
import { currentPath, renderApp } from './render-app.test-support.tsx'

const SESSION: SessionResponse = {
  user: { id: '0199a2c4-0000-7000-8000-00000000000a', username: 'amy', displayName: '艾米', systemRole: 'member' },
  personalSpace: { id: '0199a2c4-0000-7000-8000-0000000000a1', name: '艾米' },
  csrfToken: 'csrf-1',
}

const TEAM_ID = '0199a2c4-0000-7000-8000-0000000000c1'

function team(changes: Partial<SpaceView> = {}): SpaceView {
  return {
    id: TEAM_ID,
    type: 'team',
    name: '市场部',
    status: 'active',
    visibleToAll: false,
    role: 'editor',
    permissions: { canCreateDocuments: true, canViewMembers: true, canManageMembers: false, canRename: false },
    ...changes,
  }
}

const MANAGER = team({ role: 'admin', permissions: { canCreateDocuments: true, canViewMembers: true, canManageMembers: true, canRename: true } })

function teamDocumentsKey(cursor?: string): string {
  const query = new URLSearchParams({ spaceId: TEAM_ID })
  if (cursor !== undefined)
    query.set('cursor', cursor)
  return `GET /api/documents?${query.toString()}`
}

/** 登录之后、导航里有这些团队空间；团队空间的页头与文档列表 */
function loggedIn(view: SpaceView = team(), extra: Parameters<typeof installFakeApi>[0] = {}) {
  return installFakeApi({
    'GET /api/auth/session': () => json(200, SESSION),
    ...spaceRoutes(SESSION, [view]),
    [documentsKey(SESSION)]: () => json(200, { items: [], nextCursor: null }),
    [`GET /api/spaces/${TEAM_ID}`]: () => json(200, view),
    [teamDocumentsKey()]: () => json(200, { items: [], nextCursor: null }),
    ...extra,
  })
}

describe('US-M2-05 左侧导航', () => {
  it('我的空间与团队空间（已归档的带标记）；点团队空间进入它的空间页', async () => {
    loggedIn(team(), { 'GET /api/spaces': () => json(200, { items: [personalSpaceOf(SESSION), team(), team({ id: '0199a2c4-0000-7000-8000-0000000000c2', name: '旧项目', status: 'archived', role: 'viewer' })] }) })
    const app = renderApp('/')
    const nav = await screen.findByRole('navigation', { name: '空间' })
    expect(within(nav).getByRole('link', { name: '我的空间' })).toHaveAttribute('href', '/')
    expect(await within(nav).findByRole('link', { name: '旧项目（已归档）' })).toBeInTheDocument()
    fireEvent.click(within(nav).getByRole('link', { name: '市场部' }))
    expect(await screen.findByRole('heading', { name: '市场部' })).toBeInTheDocument()
    expect(currentPath(app)).toBe(`/spaces/${TEAM_ID}`)
  })

  it('还没有团队空间：说明；加载失败：说明，可以重试', async () => {
    const api = loggedIn(team(), { 'GET /api/spaces': () => apiError(500, 'INTERNAL_ERROR') })
    renderApp('/')
    const nav = await screen.findByRole('navigation', { name: '空间' })
    expect(await within(nav).findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent('空间列表加载失败')
    api.on('GET /api/spaces', () => json(200, { items: [personalSpaceOf(SESSION)] }))
    fireEvent.click(within(nav).getByRole('button', { name: '重试' }))
    expect(await within(nav).findByText('还没有加入团队空间')).toBeInTheDocument()
  })
})

describe('US-M2-05 空间页', () => {
  it('团队空间的编辑者：名称、类型与我的角色；有成员与新建表格，没有改名；文档按这个空间取', async () => {
    const api = loggedIn(team(), { [teamDocumentsKey()]: () => json(200, { items: [{ id: '0199a2c4-0000-7000-8000-0000000000d1', title: '周报', type: 'sheet', createdAt: '2026-09-29T01:00:00.000Z', updatedAt: '2026-09-29T02:00:00.000Z' }], nextCursor: null }) })
    renderApp(`/spaces/${TEAM_ID}`)
    expect(await screen.findByRole('heading', { name: '市场部' })).toBeInTheDocument()
    expect(screen.getByText('我的角色：编辑者')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '成员' })).toHaveAttribute('href', `/spaces/${TEAM_ID}/members`)
    expect(screen.queryByRole('button', { name: '改名' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新建表格' })).toBeInTheDocument()
    expect(await screen.findByText('周报')).toBeInTheDocument()
    expect(api.requests.some(request => request.key === teamDocumentsKey())).toBe(true)
  })

  it('查看者与归档的空间：没有新建表格；归档的另有说明', async () => {
    loggedIn(team({ status: 'archived', role: 'viewer', permissions: { canCreateDocuments: false, canViewMembers: true, canManageMembers: false, canRename: false } }))
    renderApp(`/spaces/${TEAM_ID}`)
    expect(await screen.findByText('这个空间已归档，只能查看。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '新建表格' })).not.toBeInTheDocument()
  })

  it('看不到与不存在的空间：同一句说明', async () => {
    loggedIn(team(), { [`GET /api/spaces/${TEAM_ID}`]: () => apiError(404, 'NOT_FOUND') })
    renderApp(`/spaces/${TEAM_ID}`)
    expect(await screen.findByText('空间不存在，或者你没有访问权限')).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: '文档列表' })).not.toBeInTheDocument()
  })

  it('新建表格：建在这个空间里', async () => {
    const created = { id: '0199a2c4-0000-7000-8000-0000000000d9', title: '未命名表格', type: 'sheet', createdAt: '2026-09-29T01:00:00.000Z', updatedAt: '2026-09-29T01:00:00.000Z', spaceId: TEAM_ID, space: { id: TEAM_ID, type: 'team', name: '市场部' }, revision: 1, profile: 'sheet@1', formatVersion: 1, permissions: { canEdit: true } }
    const api = loggedIn(team(), { 'POST /api/documents': () => json(201, created) })
    const app = renderApp(`/spaces/${TEAM_ID}`)
    fireEvent.click(await screen.findByRole('button', { name: '新建表格' }))
    await waitFor(() => expect(app.page.visits).toEqual([`assign /documents/${created.id}`]))
    expect(api.requests.find(request => request.key === 'POST /api/documents')?.body).toMatchObject({ type: 'sheet', spaceId: TEAM_ID })
  })

  it('空间管理员改名：行内的表单；保存之后页头与导航是新名称；名称已被使用时说明原因', async () => {
    let name = '市场部'
    const api = loggedIn(MANAGER, {
      'GET /api/spaces': () => json(200, { items: [personalSpaceOf(SESSION), { ...MANAGER, name }] }),
      [`GET /api/spaces/${TEAM_ID}`]: () => json(200, { ...MANAGER, name }),
      [`PUT /api/spaces/${TEAM_ID}/name`]: () => apiError(409, 'SPACE_NAME_TAKEN'),
    })
    renderApp(`/spaces/${TEAM_ID}`)
    fireEvent.click(await screen.findByRole('button', { name: '改名' }))
    const input = screen.getByLabelText('空间名称')
    expect(input).toHaveValue('市场部')
    expect(document.activeElement).toBe(input)
    fireEvent.change(input, { target: { value: '产品部' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('已有同名的团队空间')

    api.on(`PUT /api/spaces/${TEAM_ID}/name`, () => {
      name = '市场与品牌部'
      return json(200, { id: TEAM_ID, name, status: 'active', visibleToAll: false })
    })
    fireEvent.change(screen.getByLabelText('空间名称'), { target: { value: '市场与品牌部' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByRole('heading', { name: '市场与品牌部' })).toBeInTheDocument()
    expect(within(screen.getByRole('navigation', { name: '空间' })).getByRole('link', { name: '市场与品牌部' })).toBeInTheDocument()
    expect(api.requests.filter(request => request.key === `PUT /api/spaces/${TEAM_ID}/name`).map(request => request.body)).toEqual([{ name: '产品部' }, { name: '市场与品牌部' }])
    // 表单收起之后焦点回到改名的按钮
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: '改名' })))
  })
})

const BEN = { id: '0199a2c4-0000-7000-8000-00000000000b', username: 'ben', displayName: '本' }
const CAT = { id: '0199a2c4-0000-7000-8000-00000000000c', username: 'cat', displayName: '凯特' }

function member(user: SpaceMember['user'], role: SpaceMember['role'], status: SpaceMember['status'] = 'active'): SpaceMember {
  return { user, role, status, createdAt: '2026-09-29T01:00:00.000Z' }
}

function membersList(canManage: boolean, items: SpaceMember[]): SpaceMemberListResponse {
  return { space: { id: TEAM_ID, name: '市场部', status: 'active', visibleToAll: false }, canManage, items }
}

const MEMBERS_KEY = `GET /api/spaces/${TEAM_ID}/members`

describe('US-M2-06 成员页', () => {
  it('只能查看：成员与角色、停用的带标记；没有添加、调整与移出', async () => {
    loggedIn(team(), { [MEMBERS_KEY]: () => json(200, membersList(false, [member(SESSION.user, 'admin'), member(BEN, 'viewer', 'disabled')])) })
    renderApp(`/spaces/${TEAM_ID}/members`)
    expect(await screen.findByRole('heading', { name: '市场部 的成员' })).toBeInTheDocument()
    expect(screen.getByText('只有空间管理员能添加、调整与移出成员。')).toBeInTheDocument()
    const table = screen.getByRole('table', { name: '成员列表' })
    expect(within(table).getByText('已停用')).toBeInTheDocument()
    expect(within(table).queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^移出/ })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: '返回空间' })).toHaveAttribute('href', `/spaces/${TEAM_ID}`)
  })

  it('添加：按名字找同事（已经是成员的不列出）、选角色；成功之后列表刷新', async () => {
    let items = [member(SESSION.user, 'admin')]
    const api = loggedIn(MANAGER, {
      [MEMBERS_KEY]: () => json(200, membersList(true, items)),
      [`GET /api/users?${new URLSearchParams({ query: '本' }).toString()}`]: () => json(200, { items: [BEN, SESSION.user] }),
      [`POST /api/spaces/${TEAM_ID}/members`]: () => {
        items = [...items, member(BEN, 'editor')]
        return json(201, member(BEN, 'editor'))
      },
    })
    renderApp(`/spaces/${TEAM_ID}/members`)
    fireEvent.change(await screen.findByLabelText('添加成员'), { target: { value: '本' } })
    const candidates = await screen.findByRole('list', { name: '找到的同事' })
    // 自己已经是成员，不作为候选
    expect(within(candidates).getAllByRole('button').map(button => button.textContent)).toEqual(['本（ben）'])
    fireEvent.click(within(candidates).getByRole('button', { name: '本（ben）' }))
    fireEvent.change(screen.getByLabelText('角色'), { target: { value: 'editor' } })
    fireEvent.click(screen.getByRole('button', { name: '添加成员' }))
    expect(await screen.findByRole('combobox', { name: '本（ben） 的角色' })).toHaveValue('editor')
    expect(api.requests.find(request => request.key === `POST /api/spaces/${TEAM_ID}/members`)?.body).toEqual({ userId: BEN.id, role: 'editor' })
  })

  it('调整别人的角色：直接修改；失败时说明原因', async () => {
    const api = loggedIn(MANAGER, {
      [MEMBERS_KEY]: () => json(200, membersList(true, [member(SESSION.user, 'admin'), member(BEN, 'viewer')])),
      [`PUT /api/spaces/${TEAM_ID}/members/${BEN.id}`]: () => apiError(409, 'LAST_SPACE_ADMIN'),
    })
    renderApp(`/spaces/${TEAM_ID}/members`)
    fireEvent.change(await screen.findByRole('combobox', { name: '本（ben） 的角色' }), { target: { value: 'editor' } })
    expect(await screen.findByRole('alert')).toHaveTextContent('团队空间至少要保留一个空间管理员')
    expect(api.requests.find(request => request.key === `PUT /api/spaces/${TEAM_ID}/members/${BEN.id}`)?.body).toEqual({ role: 'editor' })
  })

  it('空间管理员降低自己：先确认；确认之后改，失败的原因显示在确认的弹窗里', async () => {
    const api = loggedIn(MANAGER, {
      [MEMBERS_KEY]: () => json(200, membersList(true, [member(SESSION.user, 'admin'), member(BEN, 'admin')])),
      [`PUT /api/spaces/${TEAM_ID}/members/${SESSION.user.id}`]: () => apiError(409, 'LAST_SPACE_ADMIN'),
    })
    renderApp(`/spaces/${TEAM_ID}/members`)
    fireEvent.change(await screen.findByRole('combobox', { name: '艾米（amy） 的角色' }), { target: { value: 'viewer' } })
    const dialog = await screen.findByRole('dialog', { name: '把你自己的角色改为查看者？' })
    expect(api.requests.some(request => request.key.startsWith('PUT '))).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: '修改' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('团队空间至少要保留一个空间管理员')
  })

  it('移出：先确认；确认之后移出，列表刷新', async () => {
    let items = [member(SESSION.user, 'admin'), member(CAT, 'editor')]
    const api = loggedIn(MANAGER, {
      [MEMBERS_KEY]: () => json(200, membersList(true, items)),
      [`DELETE /api/spaces/${TEAM_ID}/members/${CAT.id}`]: () => {
        items = [member(SESSION.user, 'admin')]
        return new Response(null, { status: 204 })
      },
    })
    renderApp(`/spaces/${TEAM_ID}/members`)
    fireEvent.click(await screen.findByRole('button', { name: '移出 凯特（cat）' }))
    const dialog = await screen.findByRole('dialog', { name: '把 凯特（cat） 移出这个空间？' })
    fireEvent.click(within(dialog).getByRole('button', { name: '移出' }))
    await waitFor(() => expect(screen.queryByText('凯特（cat）')).not.toBeInTheDocument())
    expect(api.requests.some(request => request.key === `DELETE /api/spaces/${TEAM_ID}/members/${CAT.id}`)).toBe(true)
  })

  it('看不到与不存在的空间：同一句说明', async () => {
    loggedIn(team(), { [MEMBERS_KEY]: () => apiError(404, 'NOT_FOUND') })
    renderApp(`/spaces/${TEAM_ID}/members`)
    expect(await screen.findByText('空间不存在，或者你没有访问权限')).toBeInTheDocument()
  })
})
