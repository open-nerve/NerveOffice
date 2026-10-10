// 空间（M2-P2 设计 §3.10）：左侧导航（窄屏时收起）、空间页（按权限显示的操作、归档、看不到、行内改名、新建到这个空间；
// 被移出之后不再显示缓存里的旧内容；页内的操作被拒绝之后页头重新请求）、成员页（按需加载：查看、添加、各行各自调整角色、移出，
// 降低或移出自己先确认；只能查看；看不到；个人空间；加载失败；返回的去处）。接口用假的 fetch。
import type { SessionResponse, SpaceMember, SpaceMemberListResponse, SpaceRole, SpaceView } from '@nerve-office/contracts'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { OUTCOME_REFRESH_TIME_LIMIT_MS } from '../shared/api/write-outcome.ts'
import { watchAnnouncement } from '../shared/testing/announcement.test-support.ts'
import { apiError, installFakeApi, inTurn, json, networkFailure } from '../shared/testing/fake-api.test-support.ts'
import { personIn, plainName } from '../shared/testing/people.test-support.ts'
import { resize } from '../shared/testing/resize.test-support.ts'
import { watchScrollIntoView } from '../shared/testing/scroll.test-support.ts'
import { documentsKey, foldersKey, noFolders, personalSpaceOf, spaceRoutes } from '../shared/testing/spaces.test-support.ts'
import { deferred, settle } from './admin.test-support.ts'
import { currentPath, renderApp } from './render-app.test-support.tsx'

const SESSION: SessionResponse = {
  user: { id: '0199a2c4-0000-7000-8000-00000000000a', username: 'amy', displayName: '艾米', systemRole: 'member' },
  personalSpace: { id: '0199a2c4-0000-7000-8000-0000000000a1', name: '艾米' },
  csrfToken: 'csrf-1',
  features: { localDraftsEnabled: true },
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
    permissions: { canCreateDocuments: true, canCreateFolders: true, canViewMembers: true, canManageMembers: false, canRename: false, canPurgeTrash: false },
    ...changes,
  }
}

const MANAGER = team({ role: 'admin', permissions: { canCreateDocuments: true, canCreateFolders: true, canViewMembers: true, canManageMembers: true, canRename: true, canPurgeTrash: true } })

const WEEKLY = { id: '0199a2c4-0000-7000-8000-0000000000d1', title: '周报', type: 'sheet', createdAt: '2026-09-29T01:00:00.000Z', updatedAt: '2026-09-29T02:00:00.000Z' }

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
    [foldersKey(TEAM_ID)]: noFolders(),
    ...extra,
  })
}

function spaceNav(): HTMLElement {
  return screen.getByRole('navigation', { name: '空间' })
}

describe('US-M2-05 左侧导航', () => {
  it('我的空间与团队空间（已归档的带标记）；点团队空间进入它的空间页', async () => {
    loggedIn(team(), { 'GET /api/spaces': () => json(200, { items: [personalSpaceOf(SESSION), team(), team({ id: '0199a2c4-0000-7000-8000-0000000000c2', name: '旧项目', status: 'archived', role: 'viewer' })] }) })
    const app = renderApp('/')
    const nav = await screen.findByRole('navigation', { name: '空间' })
    expect(within(nav).getByRole('link', { name: '我的空间' })).toHaveAttribute('href', '/')
    expect(await within(nav).findByRole('link', { name: '旧项目（已归档）' })).toBeInTheDocument()
    // 团队空间的列表以"团队空间"这个标题为名（E2E 据此确认导航已经加载完，审查 B6）
    expect(within(nav).getByRole('list', { name: '团队空间' })).toBeInTheDocument()
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

  it('窄屏：导航收起，由"空间"按钮展开（aria-expanded）；点了导航里的链接就收起（审查 B14）', async () => {
    loggedIn()
    renderApp('/')
    const toggle = await screen.findByRole('button', { name: '空间' })
    const nav = spaceNav()
    expect(toggle).toHaveAttribute('aria-controls', nav.id)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(nav).toHaveClass('hidden')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(nav).not.toHaveClass('hidden')
    fireEvent.click(await within(nav).findByRole('link', { name: '市场部' }))
    expect(await screen.findByRole('heading', { name: '市场部' })).toBeInTheDocument()
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(nav).toHaveClass('hidden')
  })

  it('导航与空间页的加载状态名称不同，分得清是哪一处在加载（审查 B10）', async () => {
    const list = deferred()
    const header = deferred()
    loggedIn(team(), { 'GET /api/spaces': list.handler, [`GET /api/spaces/${TEAM_ID}`]: header.handler })
    renderApp(`/spaces/${TEAM_ID}`)
    expect(await screen.findByRole('status', { name: '正在加载空间列表…' })).toBeInTheDocument()
    expect(screen.getByRole('status', { name: '正在加载空间…' })).toBeInTheDocument()
    list.resolve(json(200, { items: [personalSpaceOf(SESSION), team()] }))
    expect(await within(spaceNav()).findByRole('link', { name: '市场部' })).toBeInTheDocument()
    expect(screen.getByRole('status', { name: '正在加载空间…' })).toBeInTheDocument()
    header.resolve(json(200, team()))
    expect(await screen.findByRole('heading', { name: '市场部' })).toBeInTheDocument()
  })
})

describe('US-M2-05 空间页', () => {
  it('团队空间的编辑者：名称、类型与我的角色；有成员与新建表格，没有改名；文档按这个空间取', async () => {
    const api = loggedIn(team(), { [teamDocumentsKey()]: () => json(200, { items: [WEEKLY], nextCursor: null }) })
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
    loggedIn(team({ status: 'archived', role: 'viewer', permissions: { canCreateDocuments: false, canCreateFolders: false, canViewMembers: true, canManageMembers: false, canRename: false, canPurgeTrash: false } }))
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

  it('已打开的页面里被移出了空间：再进来时不显示缓存里的旧页头与文档，说明看不到；导航里它随之消失；下次进来从加载开始（审查 B1）', async () => {
    let joined = true
    const api = loggedIn(team(), {
      'GET /api/spaces': () => json(200, { items: joined ? [personalSpaceOf(SESSION), team()] : [personalSpaceOf(SESSION)] }),
      [`GET /api/spaces/${TEAM_ID}`]: () => (joined ? json(200, team()) : apiError(404, 'NOT_FOUND')),
      [teamDocumentsKey()]: () => (joined ? json(200, { items: [WEEKLY], nextCursor: null }) : apiError(404, 'NOT_FOUND')),
    })
    const app = renderApp(`/spaces/${TEAM_ID}`)
    expect(await screen.findByText('周报')).toBeInTheDocument()
    const nav = spaceNav()
    fireEvent.click(within(nav).getByRole('link', { name: '我的空间' }))
    expect(await screen.findByRole('heading', { name: '我的空间' })).toBeInTheDocument()

    // 被移出了；单页里再点导航里这个空间（缓存里还有它的页头与文档）
    joined = false
    fireEvent.click(within(nav).getByRole('link', { name: '市场部' }))
    expect(await screen.findByText('空间不存在，或者你没有访问权限')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '市场部' })).toBeNull()
    expect(screen.queryByRole('button', { name: '新建表格' })).toBeNull()
    expect(screen.queryByText('周报')).toBeNull()
    await waitFor(() => expect(within(nav).queryByRole('link', { name: '市场部' })).toBeNull())

    // 离开之后这个空间的缓存已经去掉：再进来先是加载中，不先闪出旧的页头与文档
    fireEvent.click(within(nav).getByRole('link', { name: '我的空间' }))
    expect(await screen.findByRole('heading', { name: '我的空间' })).toBeInTheDocument()
    const header = deferred()
    api.on(`GET /api/spaces/${TEAM_ID}`, header.handler)
    void app.router.navigate(`/spaces/${TEAM_ID}`)
    expect(await screen.findByRole('status', { name: '正在加载空间…' })).toBeInTheDocument()
    expect(screen.queryByText('周报')).toBeNull()
    header.resolve(apiError(404, 'NOT_FOUND'))
    expect(await screen.findByText('空间不存在，或者你没有访问权限')).toBeInTheDocument()
  })

  it('新建表格：建在这个空间里', async () => {
    const created = { id: '0199a2c4-0000-7000-8000-0000000000d9', title: '未命名表格', type: 'sheet', createdAt: '2026-09-29T01:00:00.000Z', updatedAt: '2026-09-29T01:00:00.000Z', spaceId: TEAM_ID, space: { id: TEAM_ID, type: 'team', name: '市场部' }, folderId: null, accessVia: 'space', revision: 1, profile: 'sheet@1', formatVersion: 1, sdkVersion: '1.0.1', formulasPending: false, permissions: { canEdit: true, canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: false, canCopy: true, canDelete: true, canShare: false, canTakeOver: false }, replayed: false }
    const api = loggedIn(team(), { 'POST /api/documents': () => json(201, created) })
    const app = renderApp(`/spaces/${TEAM_ID}`)
    fireEvent.click(await screen.findByRole('button', { name: '新建表格' }))
    await waitFor(() => expect(app.page.visits).toEqual([`assign /documents/${created.id}?edit=new`]))
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
    expect(await screen.findByRole('alert')).toHaveTextContent('已有同名的团队空间（大小写、全角与半角、空格的种类与个数、看不见的字符都不算区别，已归档的也算）')

    api.on(`PUT /api/spaces/${TEAM_ID}/name`, () => {
      name = '市场与品牌部'
      return json(200, { id: TEAM_ID, name, status: 'active', visibleToAll: false })
    })
    fireEvent.change(screen.getByLabelText('空间名称'), { target: { value: '市场与品牌部' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByRole('heading', { name: '市场与品牌部' })).toBeInTheDocument()
    expect(within(spaceNav()).getByRole('link', { name: '市场与品牌部' })).toBeInTheDocument()
    expect(api.requests.filter(request => request.key === `PUT /api/spaces/${TEAM_ID}/name`).map(request => request.body)).toEqual([{ name: '产品部' }, { name: '市场与品牌部' }])
    // 表单收起之后焦点回到改名的按钮
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: '改名' })))
  })

  it('改名的结果未知（其实已经改好）：页头与导航随即刷新、是新名称；表单留着说明可能已经生效、页面已刷新，可以再保存（第二批 G-2，第三批 S-c）', async () => {
    let name = '市场部'
    const api = loggedIn(MANAGER, {
      'GET /api/spaces': () => json(200, { items: [personalSpaceOf(SESSION), { ...MANAGER, name }] }),
      [`GET /api/spaces/${TEAM_ID}`]: () => json(200, { ...MANAGER, name }),
      [`PUT /api/spaces/${TEAM_ID}/name`]: () => {
        // 服务端已经改好，回包却丢了
        name = '市场与品牌部'
        return apiError(502, 'INTERNAL_ERROR')
      },
    })
    renderApp(`/spaces/${TEAM_ID}`)
    fireEvent.click(await screen.findByRole('button', { name: '改名' }))
    fireEvent.change(screen.getByLabelText('空间名称'), { target: { value: '市场与品牌部' } })
    const fetched = api.requests.filter(request => request.key === `GET /api/spaces/${TEAM_ID}`).length
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('没能确认是否已经完成（服务器出了点问题，请稍后重试）。可能已经生效：页面已按服务端现在的状态刷新，看得出是否已经生效；还没有的话，可以再试一次。')
    expect(api.requests.filter(request => request.key === `GET /api/spaces/${TEAM_ID}`).length).toBeGreaterThan(fetched)
    expect(screen.getByRole('heading', { name: '市场与品牌部' })).toBeInTheDocument()
    expect(within(spaceNav()).getByRole('link', { name: '市场与品牌部' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存' })).toHaveAttribute('aria-disabled', 'false')
  })
})

/** 空间刚被归档之后的页头：所有人只能查看 */
const ARCHIVED = team({ status: 'archived', role: 'viewer', permissions: { canCreateDocuments: false, canCreateFolders: false, canViewMembers: true, canManageMembers: false, canRename: false, canPurgeTrash: false } })

/**
 * 空间管理员打开空间页。新建表格与改名被拒绝时，空间已经变成 after：归档之后的页头（服务端 403），或者看不到了（undefined，404）；
 * 导航与页头随之按新的状态返回
 */
function deniedInPage(after: SpaceView | undefined) {
  let view: SpaceView | undefined = MANAGER
  function deny(): Response {
    view = after
    return after === undefined ? apiError(404, 'NOT_FOUND') : apiError(403, 'PERMISSION_DENIED', '空间已归档，只能查看')
  }
  const api = loggedIn(MANAGER, {
    'GET /api/spaces': () => json(200, { items: view === undefined ? [personalSpaceOf(SESSION)] : [personalSpaceOf(SESSION), view] }),
    [`GET /api/spaces/${TEAM_ID}`]: () => (view === undefined ? apiError(404, 'NOT_FOUND') : json(200, view)),
    'POST /api/documents': deny,
    [`PUT /api/spaces/${TEAM_ID}/name`]: deny,
  })
  renderApp(`/spaces/${TEAM_ID}`)
  return api
}

/** 点新建表格（按钮先有焦点：真实浏览器里点按钮会聚焦它，WebKit 除外） */
async function createSheet(): Promise<void> {
  const button = await screen.findByRole('button', { name: '新建表格' })
  button.focus()
  fireEvent.click(button)
}

/** 行内改名并保存（保存按钮先有焦点） */
async function renameTo(name: string): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: '改名' }))
  fireEvent.change(screen.getByLabelText('空间名称'), { target: { value: name } })
  const save = screen.getByRole('button', { name: '保存' })
  save.focus()
  fireEvent.click(save)
}

function spaceTitle(): HTMLElement {
  return screen.getByRole('heading', { name: '市场部' })
}

describe('US-M2-05 空间页：页内的操作被拒绝之后，页头按新的权限显示（复验）', () => {
  it('新建表格得到 403（空间刚被归档）：页头与导航重新请求，按新的权限显示；按钮随之消失，服务端说的原因写在页头的说明里、说明接住焦点；关掉说明焦点交给标题（M2-P6 复核 S2、S3、S5）', async () => {
    const api = deniedInPage(ARCHIVED)
    await createSheet()
    expect(await screen.findByText('这个空间已归档，只能查看。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '新建表格' })).toBeNull()
    expect(screen.getByText('我的角色：查看者')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '改名' })).toBeNull()
    expect(await within(spaceNav()).findByRole('link', { name: '市场部（已归档）' })).toBeInTheDocument()
    const notice = screen.getByText('没能新建表格：空间已归档，只能查看').closest('[tabindex="-1"]')
    await waitFor(() => expect(document.activeElement).toBe(notice))
    expect(api.requests.filter(request => request.key === 'POST /api/documents')).toHaveLength(1)
    expect(api.requests.filter(request => request.key === `GET /api/spaces/${TEAM_ID}`)).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(document.activeElement).toBe(spaceTitle()))
  })

  it('改名得到 403（空间刚被归档）：页头重新请求，按新的权限显示；改名的表单随之关掉，服务端说的原因写在页头的说明里、说明接住焦点（M2-P6 复核 S2、S3、S5）', async () => {
    deniedInPage(ARCHIVED)
    await renameTo('产品部')
    expect(await screen.findByText('这个空间已归档，只能查看。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '新建表格' })).toBeNull()
    const notice = screen.getByText('没能改名：空间已归档，只能查看').closest('[tabindex="-1"]')
    await waitFor(() => expect(document.activeElement).toBe(notice))
    expect(screen.queryByLabelText('空间名称')).toBeNull()
    expect(screen.queryByRole('button', { name: '改名' })).toBeNull()
    expect(screen.queryByText('你没有执行这个操作的权限')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(document.activeElement).toBe(spaceTitle()))
  })

  it.each([
    ['新建表格', createSheet],
    ['改名', async () => renameTo('产品部')],
  ])('%s得到 404（被移出了空间）：页头重新请求，显示"空间不存在"，导航里它随之消失；页头连同按钮卸载，焦点交给这条说明', async (_operation, operate) => {
    deniedInPage(undefined)
    await operate()
    const notFound = await screen.findByText('空间不存在，或者你没有访问权限')
    expect(screen.queryByRole('heading', { name: '市场部' })).toBeNull()
    await waitFor(() => expect(within(spaceNav()).queryByRole('link', { name: '市场部' })).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(notFound.closest('[role="alert"]')))
  })

  it('"空间不存在"的说明不抢已经在别处的焦点（例如刚点的导航链接）', async () => {
    loggedIn(team(), { [`GET /api/spaces/${TEAM_ID}`]: () => apiError(404, 'NOT_FOUND') })
    const app = renderApp('/')
    const nav = await screen.findByRole('navigation', { name: '空间' })
    const link = await within(nav).findByRole('link', { name: '市场部' })
    link.focus()
    fireEvent.click(link)
    expect(await screen.findByText('空间不存在，或者你没有访问权限')).toBeInTheDocument()
    expect(currentPath(app)).toBe(`/spaces/${TEAM_ID}`)
    await settle()
    expect(document.activeElement).toBe(link)
  })
})

const BEN = { id: '0199a2c4-0000-7000-8000-00000000000b', username: 'ben', displayName: '本' }
const CAT = { id: '0199a2c4-0000-7000-8000-00000000000c', username: 'cat', displayName: '凯特' }

function member(user: SpaceMember['user'], role: SpaceMember['role'], status: SpaceMember['status'] = 'active'): SpaceMember {
  return { user, role, status, createdAt: '2026-09-29T01:00:00.000Z' }
}

function membersList(canManage: boolean, items: SpaceMember[], status: SpaceView['status'] = 'active'): SpaceMemberListResponse {
  return { space: { id: TEAM_ID, name: '市场部', status, visibleToAll: false }, canManage, items }
}

const MEMBERS_PATH = `/spaces/${TEAM_ID}/members`
const MEMBERS_KEY = `GET /api/spaces/${TEAM_ID}/members`

function memberKey(method: 'PUT' | 'DELETE', user: { readonly id: string }): string {
  return `${method} /api/spaces/${TEAM_ID}/members/${user.id}`
}

/** 成员表里这个人的角色选择框与它所在的行（可读名称里的人名：显示名隔离、登录名另外标出，M2-P6 复核 M2） */
async function roleOf(displayName: string, username: string): Promise<{ select: HTMLElement, row: HTMLElement }> {
  const select = await screen.findByRole('combobox', { name: `${plainName(displayName, username)} 的角色` })
  return { select, row: select.closest('tr')! }
}

/** 选一个角色，再点这一行的"保存"：角色经明确的保存才提交（M2-P6 复核的疑点） */
function saveRole(select: HTMLElement, row: HTMLElement, role: SpaceRole): void {
  fireEvent.change(select, { target: { value: role } })
  fireEvent.click(within(row).getByRole('button', { name: /^保存 .* 的角色$/ }))
}

function membersTitle(): HTMLElement {
  return screen.getByRole('heading', { name: '市场部 的成员' })
}

describe('US-M2-06 成员页', () => {
  it('只能查看：成员与角色、停用的带标记；没有添加、调整与移出', async () => {
    loggedIn(team(), { [MEMBERS_KEY]: () => json(200, membersList(false, [member(SESSION.user, 'admin'), member(BEN, 'viewer', 'disabled')])) })
    renderApp(MEMBERS_PATH)
    expect(await screen.findByRole('heading', { name: '市场部 的成员' })).toBeInTheDocument()
    expect(screen.getByText('只有空间管理员能添加、调整与移出成员。')).toBeInTheDocument()
    const table = screen.getByRole('table', { name: '成员列表' })
    expect(within(table).getByText('已停用')).toBeInTheDocument()
    expect(within(table).queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^移出/ })).not.toBeInTheDocument()
    expect(await screen.findByRole('link', { name: '返回空间' })).toHaveAttribute('href', `/spaces/${TEAM_ID}`)
  })

  it('归档的空间：只能查看的人看到"只有系统管理员能调整"；能管理的（系统管理员）同样看到已归档的说明（审查 B5）', async () => {
    const api = loggedIn(team(), { [MEMBERS_KEY]: () => json(200, membersList(false, [member(SESSION.user, 'viewer')], 'archived')) })
    const app = renderApp(MEMBERS_PATH)
    expect(await screen.findByText('这个空间已归档：只有系统管理员能调整成员。')).toBeInTheDocument()

    fireEvent.click(within(spaceNav()).getByRole('link', { name: '我的空间' }))
    expect(await screen.findByRole('heading', { name: '我的空间' })).toBeInTheDocument()
    api.on(MEMBERS_KEY, () => json(200, membersList(true, [member(BEN, 'admin')], 'archived')))
    void app.router.navigate(MEMBERS_PATH)
    expect(await screen.findByText('这个空间已归档，所有人只能查看。系统管理员仍然可以调整成员，调整之后空间照样只读。')).toBeInTheDocument()
    expect(screen.getByLabelText('要添加的同事')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: `${plainName('本', 'ben')} 的角色` })).toBeInTheDocument()
  })

  it('添加：按名字找同事（已经是成员的不列出）、选角色；没选同事时按钮说明原因；成功之后列表刷新，同事选择整个重新开始（审查 B5、B10、B11）', async () => {
    let items = [member(SESSION.user, 'admin')]
    const api = loggedIn(MANAGER, {
      [MEMBERS_KEY]: () => json(200, membersList(true, items)),
      [`GET /api/users?${new URLSearchParams({ query: '本' }).toString()}`]: () => json(200, { items: [BEN, SESSION.user] }),
      [`POST /api/spaces/${TEAM_ID}/members`]: () => {
        items = [...items, member(BEN, 'editor')]
        return json(201, member(BEN, 'editor'))
      },
    })
    renderApp(MEMBERS_PATH)
    // 同事选择的标签与提交按钮的名称不同
    const input = await screen.findByLabelText('要添加的同事')
    const submit = screen.getByRole('button', { name: '添加成员' })
    expect(submit).toHaveAttribute('aria-disabled', 'true')
    expect(submit).toHaveAccessibleDescription('请先选择要添加的同事')

    fireEvent.change(input, { target: { value: '本' } })
    const candidates = await screen.findByRole('list', { name: '找到的同事' })
    // 自己已经是成员，不作为候选
    expect(within(candidates).getAllByRole('button').map(button => button.textContent)).toEqual(['@ben 本'])
    fireEvent.click(within(candidates).getByRole('button', { name: '@ben 本' }))
    expect(screen.getByRole('button', { name: '重新选择 要添加的同事' })).toBeInTheDocument()
    expect(submit).toHaveAttribute('aria-disabled', 'false')
    expect(submit).not.toHaveAccessibleDescription()
    fireEvent.change(screen.getByLabelText('角色'), { target: { value: 'editor' } })
    fireEvent.click(submit)
    expect(await screen.findByRole('combobox', { name: `${plainName('本', 'ben')} 的角色` })).toHaveValue('editor')
    expect(api.requests.find(request => request.key === `POST /api/spaces/${TEAM_ID}/members`)?.body).toEqual({ userId: BEN.id, role: 'editor' })
    // 关键词与上一次的候选都清掉了
    expect(screen.getByLabelText('要添加的同事')).toHaveValue('')
    expect(screen.queryByRole('list', { name: '找到的同事' })).toBeNull()
    expect(screen.queryByText('没有找到这个人')).toBeNull()
  })

  it('调整别人的角色：保存之后立即显示目标角色，这一行标为忙碌、说明正在保存；进行中再改不提交；刷新之后是新的角色（审查 B3）', async () => {
    let role: SpaceRole = 'viewer'
    const change = deferred()
    const api = loggedIn(MANAGER, {
      [MEMBERS_KEY]: () => json(200, membersList(true, [member(SESSION.user, 'admin'), member(BEN, role)])),
      [memberKey('PUT', BEN)]: change.handler,
    })
    renderApp(MEMBERS_PATH)
    const { select, row } = await roleOf('本', 'ben')
    saveRole(select, row, 'editor')
    expect(select).toHaveValue('editor')
    expect(row).toHaveAttribute('aria-busy', 'true')
    expect(within(row).getByText('正在保存…')).toBeInTheDocument()
    expect(select).toHaveAccessibleDescription('正在保存…')

    // 进行中再改这一行：不提交，选择框仍显示正在保存的角色
    fireEvent.change(select, { target: { value: 'admin' } })
    expect(select).toHaveValue('editor')

    role = 'editor'
    change.resolve(json(200, member(BEN, 'editor')))
    await waitFor(() => expect(row).toHaveAttribute('aria-busy', 'false'))
    expect(select).toHaveValue('editor')
    expect(within(row).queryByText('正在保存…')).toBeNull()
    expect(api.requests.filter(request => request.key === memberKey('PUT', BEN)).map(request => request.body)).toEqual([{ role: 'editor' }])
  })

  it('调整角色：保存之后成员列表刷新完成之前，这一行仍在保存、选择框是目标角色，不先弹回旧的角色（审查 B3，复验）', async () => {
    const refreshed = deferred()
    const api = loggedIn(MANAGER, {
      [MEMBERS_KEY]: () => json(200, membersList(true, [member(SESSION.user, 'admin'), member(BEN, 'viewer')])),
      [memberKey('PUT', BEN)]: () => json(200, member(BEN, 'editor')),
    })
    renderApp(MEMBERS_PATH)
    const { select, row } = await roleOf('本', 'ben')
    // 保存之后的刷新（第二次取成员列表）先挂着
    api.on(MEMBERS_KEY, refreshed.handler)
    saveRole(select, row, 'editor')
    await waitFor(() => expect(api.requests.filter(request => request.key === MEMBERS_KEY)).toHaveLength(2))
    // 保存已经返回：让随后的渲染都走完，再看这一行
    await settle()
    expect(select).toHaveValue('editor')
    expect(row).toHaveAttribute('aria-busy', 'true')
    expect(within(row).getByText('正在保存…')).toBeInTheDocument()

    refreshed.resolve(json(200, membersList(true, [member(SESSION.user, 'admin'), member(BEN, 'editor')])))
    await waitFor(() => expect(row).toHaveAttribute('aria-busy', 'false'))
    expect(select).toHaveValue('editor')
    expect(within(row).queryByText('正在保存…')).toBeNull()
  })

  it('调整角色成功而随后刷新成员列表失败：这一行已经是保存之后的角色，不显示旧的（复验）', async () => {
    const api = loggedIn(MANAGER, {
      [MEMBERS_KEY]: () => json(200, membersList(true, [member(SESSION.user, 'admin'), member(BEN, 'viewer')])),
      [memberKey('PUT', BEN)]: () => json(200, member(BEN, 'editor')),
    })
    renderApp(MEMBERS_PATH)
    const { select, row } = await roleOf('本', 'ben')
    api.on(MEMBERS_KEY, () => apiError(500, 'INTERNAL_ERROR'))
    saveRole(select, row, 'editor')
    // 刷新失败（连同一次重试）之后这一行结束保存
    await waitFor(() => expect(row).toHaveAttribute('aria-busy', 'false'), { timeout: 3000 })
    expect(api.requests.filter(request => request.key === MEMBERS_KEY).length).toBeGreaterThan(1)
    expect(select).toHaveValue('editor')
    expect(within(row).queryByRole('alert')).toBeNull()
  })

  it('调整角色失败：恢复原来的角色，原因就在这一行说明，不在表格上方（审查 B3）', async () => {
    loggedIn(MANAGER, {
      [MEMBERS_KEY]: () => json(200, membersList(true, [member(SESSION.user, 'admin'), member(BEN, 'viewer'), member(CAT, 'editor')])),
      [memberKey('PUT', BEN)]: () => apiError(409, 'LAST_SPACE_ADMIN'),
    })
    renderApp(MEMBERS_PATH)
    const { select, row } = await roleOf('本', 'ben')
    saveRole(select, row, 'editor')
    expect(await within(row).findByRole('alert')).toHaveTextContent('团队空间至少要保留一个空间管理员')
    expect(select).toHaveValue('viewer')
    expect(row).toHaveAttribute('aria-busy', 'false')
    expect(select).toHaveAccessibleDescription('团队空间至少要保留一个空间管理员')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
  })

  it('调整角色的结果未知（其实已经改好）：成员列表随即刷新、选择框是新的角色；这一行说明可能已经生效、页面已刷新（第二批 G-2，第三批 S-c）', async () => {
    let role: SpaceRole = 'viewer'
    loggedIn(MANAGER, {
      [MEMBERS_KEY]: () => json(200, membersList(true, [member(SESSION.user, 'admin'), member(BEN, role)])),
      [memberKey('PUT', BEN)]: () => {
        // 服务端已经改好，回包却丢了
        role = 'editor'
        return apiError(502, 'INTERNAL_ERROR')
      },
    })
    renderApp(MEMBERS_PATH)
    const { select, row } = await roleOf('本', 'ben')
    saveRole(select, row, 'editor')
    expect(await within(row).findByRole('alert')).toHaveTextContent('没能确认是否已经完成（服务器出了点问题，请稍后重试）。可能已经生效：页面已按服务端现在的状态刷新，看得出是否已经生效；还没有的话，可以再试一次。')
    expect(select).toHaveValue('editor')
    expect(row).toHaveAttribute('aria-busy', 'false')
  })

  it('调整角色的结果未知，随后刷新成员列表也失败：这一行说明可能已经生效、页面没能刷新，不说"已按服务端现在的状态刷新"（第三批 G-a）', async () => {
    const api = loggedIn(MANAGER, {
      [MEMBERS_KEY]: () => json(200, membersList(true, [member(SESSION.user, 'admin'), member(BEN, 'viewer')])),
      [memberKey('PUT', BEN)]: () => {
        api.on(MEMBERS_KEY, () => apiError(500, 'INTERNAL_ERROR'))
        return apiError(502, 'INTERNAL_ERROR')
      },
    })
    renderApp(MEMBERS_PATH)
    const { select, row } = await roleOf('本', 'ben')
    saveRole(select, row, 'editor')
    expect(await within(row).findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent('没能确认是否已经完成（服务器出了点问题，请稍后重试）。可能已经生效，只是页面没能刷新，显示的可能还是之前的状态：请稍后再看；确认还没有生效的话，可以再试一次。')
    expect(row).toHaveAttribute('aria-busy', 'false')
  })

  it('不同的行可以同时调整（审查 B3）', async () => {
    const ben = deferred()
    const cat = deferred()
    const api = loggedIn(MANAGER, {
      [MEMBERS_KEY]: () => json(200, membersList(true, [member(SESSION.user, 'admin'), member(BEN, 'viewer'), member(CAT, 'viewer')])),
      [memberKey('PUT', BEN)]: ben.handler,
      [memberKey('PUT', CAT)]: cat.handler,
    })
    renderApp(MEMBERS_PATH)
    const benRow = await roleOf('本', 'ben')
    const catRow = await roleOf('凯特', 'cat')
    saveRole(benRow.select, benRow.row, 'editor')
    saveRole(catRow.select, catRow.row, 'admin')
    expect(benRow.row).toHaveAttribute('aria-busy', 'true')
    expect(catRow.row).toHaveAttribute('aria-busy', 'true')
    await waitFor(() => expect(api.requests.filter(request => request.key.startsWith('PUT ')).map(request => request.key)).toEqual([memberKey('PUT', BEN), memberKey('PUT', CAT)]))
    cat.resolve(apiError(409, 'LAST_SPACE_ADMIN'))
    expect(await within(catRow.row).findByRole('alert')).toBeInTheDocument()
    // 一行失败不影响另一行的进行中
    expect(benRow.row).toHaveAttribute('aria-busy', 'true')
    expect(benRow.select).toHaveValue('editor')
    ben.resolve(json(200, member(BEN, 'editor')))
    await waitFor(() => expect(benRow.row).toHaveAttribute('aria-busy', 'false'))
  })

  it('空间管理员降低自己：先确认；失败的原因显示在确认的弹窗里；成功之后这一页只能查看，焦点交给页面的标题（审查 B2、B14）', async () => {
    let role: SpaceRole = 'admin'
    let fail = true
    const api = loggedIn(MANAGER, {
      [MEMBERS_KEY]: () => json(200, membersList(role === 'admin', [member(SESSION.user, role), member(BEN, 'admin')])),
      [memberKey('PUT', SESSION.user)]: () => {
        if (fail)
          return apiError(409, 'LAST_SPACE_ADMIN')
        role = 'viewer'
        return json(200, member(SESSION.user, 'viewer'))
      },
    })
    renderApp(MEMBERS_PATH)
    const { select, row } = await roleOf('艾米', 'amy')
    select.focus()
    saveRole(select, row, 'viewer')
    const dialog = await screen.findByRole('dialog', { name: '把你自己的角色改为查看者？' })
    expect(api.requests.some(request => request.key.startsWith('PUT '))).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: '修改' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('团队空间至少要保留一个空间管理员')

    fail = false
    fireEvent.click(within(dialog).getByRole('button', { name: '修改' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(await screen.findByText('只有空间管理员能添加、调整与移出成员。')).toBeInTheDocument()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByLabelText('要添加的同事')).toBeNull()
    // 打开弹窗的选择框换成了文字：焦点不落到 body
    await waitFor(() => expect(document.activeElement).toBe(membersTitle()))
  })

  it('空间管理员降低自己、刷新成员列表超过时限：确认框照常关掉，焦点交还给自己那一行的选择框（缓存里还能管理，它还在，在状态区下面）；说明写进状态区、状态区变高之后把它按最小距离滚回可视区域（共用的 keepFocusInView，再复核 D2）', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      let finish: (response: Response) => void = () => {}
      const api = loggedIn(MANAGER, {
        [MEMBERS_KEY]: inTurn(() => json(200, membersList(true, [member(SESSION.user, 'admin'), member(BEN, 'admin')])), async () => new Promise<Response>((resolve) => {
          finish = resolve
        })),
        [memberKey('PUT', SESSION.user)]: () => json(200, member(SESSION.user, 'viewer')),
      })
      renderApp(MEMBERS_PATH)
      const { select, row } = await roleOf('艾米', 'amy')
      select.focus()
      saveRole(select, row, 'viewer')
      const dialog = await screen.findByRole('dialog', { name: '把你自己的角色改为查看者？' })
      const scrolled = watchScrollIntoView()
      fireEvent.click(within(dialog).getByRole('button', { name: '修改' }))
      // 前提：修改已经成功，刷新成员列表的请求已经发出、还没有回来
      await waitFor(() => expect(api.requests.filter(request => request.key === MEMBERS_KEY)).toHaveLength(2))
      await act(async () => vi.advanceTimersByTimeAsync(OUTCOME_REFRESH_TIME_LIMIT_MS))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      const notice = await waitFor(() => {
        const found = screen.getAllByRole('status').find(status => status.textContent.includes('成员列表还在刷新'))
        expect(found).toBeDefined()
        return found!
      })
      await waitFor(() => expect(document.activeElement).toBe(select))
      // 前提：选择框排在状态区后面（文档顺序），状态区撑开时它被往下挤
      expect(notice.compareDocumentPosition(select) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      act(() => resize(notice, 66))
      expect(scrolled).toHaveBeenCalledTimes(1)
      expect(scrolled).toHaveBeenLastCalledWith({ block: 'nearest' })
      expect(scrolled.mock.contexts.at(-1)).toBe(select)
      // 刷新回来，"成员列表还在刷新"一句消失、状态区变矮：不再滚
      await act(async () => finish(json(200, membersList(false, [member(SESSION.user, 'viewer'), member(BEN, 'admin')]))))
      await waitFor(() => expect(notice).not.toHaveTextContent('成员列表还在刷新'))
      act(() => resize(notice, 46))
      expect(scrolled).toHaveBeenCalledTimes(1)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('移出：先确认；确认之后移出，列表刷新；这一行没了，焦点交给页面的标题（审查 B2）', async () => {
    let items = [member(SESSION.user, 'admin'), member(CAT, 'editor')]
    const api = loggedIn(MANAGER, {
      [MEMBERS_KEY]: () => json(200, membersList(true, items)),
      [memberKey('DELETE', CAT)]: () => {
        items = [member(SESSION.user, 'admin')]
        return new Response(null, { status: 204 })
      },
    })
    renderApp(MEMBERS_PATH)
    const remove = await screen.findByRole('button', { name: `移出 ${plainName('凯特', 'cat')}` })
    remove.focus()
    fireEvent.click(remove)
    const dialog = await screen.findByRole('dialog', { name: `把 ${plainName('凯特', 'cat')} 移出这个空间？` })
    fireEvent.click(within(dialog).getByRole('button', { name: '移出' }))
    await waitFor(() => expect(screen.queryByText('@cat')).not.toBeInTheDocument())
    expect(api.requests.some(request => request.key === memberKey('DELETE', CAT))).toBe(true)
    await waitFor(() => expect(document.activeElement).toBe(membersTitle()))
  })

  it('要移出的人已经被别人移出（404）：刷新成员列表，这一行消失；弹窗关闭，在表格上方说明，焦点交给页面的标题，不会原样重发（审查 B12，复验）', async () => {
    let items = [member(SESSION.user, 'admin'), member(CAT, 'editor')]
    const api = loggedIn(MANAGER, {
      [MEMBERS_KEY]: () => json(200, membersList(true, items)),
      [memberKey('DELETE', CAT)]: () => {
        items = [member(SESSION.user, 'admin')]
        return apiError(404, 'NOT_FOUND')
      },
    })
    renderApp(MEMBERS_PATH)
    const remove = await screen.findByRole('button', { name: `移出 ${plainName('凯特', 'cat')}` })
    // 说明的容器一开始就在（空的），之后往里填文字，读屏软件才会播报
    const statuses = screen.getAllByRole('status')
    remove.focus()
    fireEvent.click(remove)
    const dialog = await screen.findByRole('dialog', { name: `把 ${plainName('凯特', 'cat')} 移出这个空间？` })
    const announced = watchAnnouncement('已经不在成员里了')
    const scrolled = watchScrollIntoView()
    fireEvent.click(within(dialog).getByRole('button', { name: '移出' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // 说明等弹窗关掉之后才写进状态区（M2-P5 复验 S1）：写进去的那一刻页面不在 aria-hidden 之下、焦点已经交还。说明里的人名同样用 PersonName（M2-P6 复核 M2）
    const notice = await waitFor(() => {
      const found = statuses.find(status => status.textContent === '@cat 凯特 已经不在成员里了（可能已被别人移出），列表已刷新')
      expect(found).toBeDefined()
      return found!
    })
    expect(announced()).toEqual({ ariaHidden: false, focusReturned: true })
    personIn(notice, '凯特', 'cat')
    expect(screen.queryByRole('button', { name: `移出 ${plainName('凯特', 'cat')}` })).toBeNull()
    expect(screen.getByRole('button', { name: `移出 ${plainName('艾米', 'amy')}` })).toBeInTheDocument()
    await waitFor(() => expect(document.activeElement).toBe(membersTitle()))
    // 状态区在成员表上方（共用的状态区开着 keepFocusInView）：说明写进去、状态区变高（jsdom 没有布局，这里当作它撑开了）时，
    // 只滚排在它后面的焦点元素。这里焦点在页面的标题上（被移出的那一行已经不在），标题在状态区上方、挤不动，不滚——
    // 用户这时已经滚走的话也不把页面拉回标题（再复核 D1）。焦点在状态区下面的情形见"降低自己、刷新超过时限"那一条
    act(() => resize(notice, 46))
    expect(scrolled).not.toHaveBeenCalled()
    expect(api.requests.filter(request => request.key === memberKey('DELETE', CAT))).toHaveLength(1)

    // 下一次打开确认的弹窗时，说明清掉
    fireEvent.click(screen.getByRole('button', { name: `移出 ${plainName('艾米', 'amy')}` }))
    expect(await screen.findByRole('dialog', { name: '把你自己移出这个空间？' })).toBeInTheDocument()
    expect(notice).toBeEmptyDOMElement()
  })

  it('要移出的人 404，而空间本身已经看不到了：成员页显示"空间不存在"，不另外说明；焦点交给这条说明（复验）', async () => {
    let joined = true
    loggedIn(MANAGER, {
      'GET /api/spaces': () => json(200, { items: joined ? [personalSpaceOf(SESSION), MANAGER] : [personalSpaceOf(SESSION)] }),
      [MEMBERS_KEY]: () => (joined ? json(200, membersList(true, [member(SESSION.user, 'admin'), member(CAT, 'editor')])) : apiError(404, 'NOT_FOUND')),
      [memberKey('DELETE', CAT)]: () => {
        joined = false
        return apiError(404, 'NOT_FOUND')
      },
    })
    renderApp(MEMBERS_PATH)
    const remove = await screen.findByRole('button', { name: `移出 ${plainName('凯特', 'cat')}` })
    remove.focus()
    fireEvent.click(remove)
    const dialog = await screen.findByRole('dialog', { name: `把 ${plainName('凯特', 'cat')} 移出这个空间？` })
    fireEvent.click(within(dialog).getByRole('button', { name: '移出' }))
    const notFound = await screen.findByText('空间不存在，或者你没有访问权限')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText(/已经不在成员里了/)).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(notFound.closest('[role="alert"]')))
  })

  it('要移出的人 404，而刷新成员列表失败：列表还是旧的，弹窗留着说明原因（复验）', async () => {
    let refreshFails = false
    loggedIn(MANAGER, {
      [MEMBERS_KEY]: () => (refreshFails ? apiError(500, 'INTERNAL_ERROR') : json(200, membersList(true, [member(SESSION.user, 'admin'), member(CAT, 'editor')]))),
      [memberKey('DELETE', CAT)]: () => {
        refreshFails = true
        return apiError(404, 'NOT_FOUND')
      },
    })
    renderApp(MEMBERS_PATH)
    fireEvent.click(await screen.findByRole('button', { name: `移出 ${plainName('凯特', 'cat')}` }))
    const dialog = await screen.findByRole('dialog', { name: `把 ${plainName('凯特', 'cat')} 移出这个空间？` })
    fireEvent.click(within(dialog).getByRole('button', { name: '移出' }))
    expect(await within(dialog).findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent('内容不存在，或者你没有访问权限')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.queryByText(/已经不在成员里了/)).toBeNull()
    // 弹窗之外的内容被标为 aria-hidden：按角色查找要带上 hidden
    expect(screen.getByRole('button', { name: `移出 ${plainName('凯特', 'cat')}`, hidden: true })).toBeInTheDocument()
  })

  it('移出自己：专门的确认文案；确认之后回到首页，导航里不再有这个空间；再进成员页从加载开始（审查 B14）', async () => {
    let joined = true
    const api = loggedIn(MANAGER, {
      'GET /api/spaces': () => json(200, { items: joined ? [personalSpaceOf(SESSION), MANAGER] : [personalSpaceOf(SESSION)] }),
      [MEMBERS_KEY]: () => json(200, membersList(true, joined ? [member(SESSION.user, 'admin'), member(BEN, 'admin')] : [member(BEN, 'admin')])),
      [memberKey('DELETE', SESSION.user)]: () => {
        joined = false
        return new Response(null, { status: 204 })
      },
    })
    const app = renderApp(MEMBERS_PATH)
    fireEvent.click(await screen.findByRole('button', { name: `移出 ${plainName('艾米', 'amy')}` }))
    const dialog = await screen.findByRole('dialog', { name: '把你自己移出这个空间？' })
    expect(dialog).toHaveAccessibleDescription(/你立即失去这个空间带来的权限/)
    fireEvent.click(within(dialog).getByRole('button', { name: '移出' }))
    await waitFor(() => expect(currentPath(app)).toBe('/'))
    expect(await screen.findByRole('heading', { name: '我的空间' })).toBeInTheDocument()
    await waitFor(() => expect(within(spaceNav()).queryByRole('link', { name: '市场部' })).toBeNull())

    // 缓存里还能管理的成员表已经去掉：回来时先是加载中
    const again = deferred()
    api.on(MEMBERS_KEY, again.handler)
    void app.router.navigate(MEMBERS_PATH)
    expect(await screen.findByRole('status', { name: '正在加载成员…' })).toBeInTheDocument()
    expect(screen.queryByRole('combobox')).toBeNull()
    again.resolve(apiError(404, 'NOT_FOUND'))
    expect(await screen.findByText('空间不存在，或者你没有访问权限')).toBeInTheDocument()
  })

  it('看不到与不存在的空间：同一句说明', async () => {
    loggedIn(team(), { [MEMBERS_KEY]: () => apiError(404, 'NOT_FOUND') })
    renderApp(MEMBERS_PATH)
    expect(await screen.findByText('空间不存在，或者你没有访问权限')).toBeInTheDocument()
  })

  it('已打开的页面里被移出了空间：再进成员页时不显示缓存里还能管理的旧表格，说明看不到；导航里它随之消失（审查 B1）', async () => {
    let joined = true
    loggedIn(MANAGER, {
      'GET /api/spaces': () => json(200, { items: joined ? [personalSpaceOf(SESSION), MANAGER] : [personalSpaceOf(SESSION)] }),
      [MEMBERS_KEY]: () => (joined ? json(200, membersList(true, [member(SESSION.user, 'admin'), member(BEN, 'viewer')])) : apiError(404, 'NOT_FOUND')),
    })
    const app = renderApp(MEMBERS_PATH)
    expect(await screen.findByRole('combobox', { name: `${plainName('本', 'ben')} 的角色` })).toBeInTheDocument()
    fireEvent.click(within(spaceNav()).getByRole('link', { name: '我的空间' }))
    expect(await screen.findByRole('heading', { name: '我的空间' })).toBeInTheDocument()

    joined = false
    void app.router.navigate(MEMBERS_PATH)
    expect(await screen.findByText('空间不存在，或者你没有访问权限')).toBeInTheDocument()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByRole('button', { name: /^移出/ })).toBeNull()
    expect(screen.queryByLabelText('要添加的同事')).toBeNull()
    await waitFor(() => expect(within(spaceNav()).queryByRole('link', { name: '市场部' })).toBeNull())
  })

  it('看得到却不能查看成员（403，例如个人空间）：显示服务端在这次拒绝里给出的说明，不按错误码猜，不给重试（审查 B5，复验）', async () => {
    const personalMembers = `GET /api/spaces/${SESSION.personalSpace.id}/members`
    const api = loggedIn(team(), { [personalMembers]: () => apiError(403, 'PERMISSION_DENIED', '个人空间没有成员') })
    renderApp(`/spaces/${SESSION.personalSpace.id}/members`)
    expect(await screen.findByText('个人空间没有成员')).toBeInTheDocument()
    expect(screen.queryByText('你没有执行这个操作的权限')).toBeNull()
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
    expect(api.requests.filter(request => request.key === personalMembers)).toHaveLength(1)
  })

  it('成员列表加载失败：说明原因，可以重试（审查 B14）', async () => {
    const api = loggedIn(team(), { [MEMBERS_KEY]: () => apiError(500, 'INTERNAL_ERROR') })
    renderApp(MEMBERS_PATH)
    expect(await screen.findByText('成员列表加载失败', {}, { timeout: 3000 })).toBeInTheDocument()
    expect(screen.getByText('服务器出了点问题，请稍后重试')).toBeInTheDocument()
    api.on(MEMBERS_KEY, () => json(200, membersList(false, [member(SESSION.user, 'editor')])))
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('heading', { name: '市场部 的成员' })).toBeInTheDocument()
  })

  it('返回的去处：导航列表还在加载时先不显示；没有加入的系统管理员回到管理界面的团队空间（审查 B5、B14）', async () => {
    const admin: SessionResponse = { ...SESSION, user: { ...SESSION.user, systemRole: 'admin' } }
    const list = deferred()
    installFakeApi({
      'GET /api/auth/session': () => json(200, admin),
      ...spaceRoutes(admin),
      'GET /api/spaces': list.handler,
      [MEMBERS_KEY]: () => json(200, membersList(true, [member(BEN, 'admin')])),
    })
    renderApp(MEMBERS_PATH)
    expect(await screen.findByRole('heading', { name: '市场部 的成员' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /^返回/ })).toBeNull()
    // 导航里没有这个空间：没有加入
    list.resolve(json(200, { items: [personalSpaceOf(admin)] }))
    expect(await screen.findByRole('link', { name: '返回团队空间管理' })).toHaveAttribute('href', '/admin/spaces')
    expect(screen.queryByRole('link', { name: '返回空间' })).toBeNull()
  })
})

describe('US-M2-06 成员页：角色经明确的保存才提交、结果未知、人名（M2-P6 复核）', () => {
  it('在收起的选择框上逐个经过别的角色（Windows、Linux 上的 Chrome 与 Edge 按方向键直接改值）：一个也不保存；选回原来的角色，"保存"随之收起；点了"保存"才提交选定的那一个（疑点）', async () => {
    const api = loggedIn(MANAGER, {
      [MEMBERS_KEY]: () => json(200, membersList(true, [member(SESSION.user, 'admin'), member(BEN, 'viewer')])),
      [memberKey('PUT', BEN)]: () => json(200, member(BEN, 'admin')),
    })
    renderApp(MEMBERS_PATH)
    const { select, row } = await roleOf('本', 'ben')
    // 方向键在收起的选择框上逐个改值：每一步都是一次 change
    for (const role of ['editor', 'admin', 'editor', 'viewer'] as const)
      fireEvent.change(select, { target: { value: role } })
    expect(within(row).queryByRole('button', { name: /^保存/ })).toBeNull()
    for (const role of ['editor', 'admin'] as const)
      fireEvent.change(select, { target: { value: role } })
    await settle()
    expect(api.requests.some(request => request.key.startsWith('PUT '))).toBe(false)
    expect(select).toHaveValue('admin')

    const save = within(row).getByRole('button', { name: `保存 ${plainName('本', 'ben')} 的角色` })
    save.focus()
    fireEvent.click(save)
    await waitFor(() => expect(row).toHaveAttribute('aria-busy', 'false'))
    expect(api.requests.filter(request => request.key === memberKey('PUT', BEN)).map(request => request.body)).toEqual([{ role: 'admin' }])
    // "保存"收起之后焦点在这一行的选择框上，不落到 body
    expect(document.activeElement).toBe(select)
  })

  it('选了还没保存：选择框关联一段"还没保存"的说明，读屏用户听得到它还没生效；选回原来的角色、保存完成之后说明随之去掉（第二批 S-3）', async () => {
    const save = deferred()
    loggedIn(MANAGER, {
      [MEMBERS_KEY]: () => json(200, membersList(true, [member(SESSION.user, 'admin'), member(BEN, 'viewer')])),
      [memberKey('PUT', BEN)]: save.handler,
    })
    renderApp(MEMBERS_PATH)
    const { select, row } = await roleOf('本', 'ben')
    expect(select).not.toHaveAccessibleDescription()
    fireEvent.change(select, { target: { value: 'editor' } })
    expect(select).toHaveAccessibleDescription('还没保存：点"保存"之后才生效')
    // 选回原来的角色：没有要保存的，说明随"保存"一起收起
    fireEvent.change(select, { target: { value: 'viewer' } })
    expect(select).not.toHaveAccessibleDescription()
    fireEvent.change(select, { target: { value: 'editor' } })
    fireEvent.click(within(row).getByRole('button', { name: `保存 ${plainName('本', 'ben')} 的角色` }))
    // 保存进行中：说明换成"正在保存…"
    expect(select).toHaveAccessibleDescription('正在保存…')
    save.resolve(json(200, member(BEN, 'editor')))
    await waitFor(() => expect(row).toHaveAttribute('aria-busy', 'false'))
    expect(select).not.toHaveAccessibleDescription()
  })

  it('添加的结果未知：成员列表刷新，说明可能已经加好；再点得到"已经是成员"，说明多半就是刚才那一次，同事选择重新开始（S1 / P6）', async () => {
    let items = [member(SESSION.user, 'admin')]
    let posts = 0
    const api = loggedIn(MANAGER, {
      [MEMBERS_KEY]: () => json(200, membersList(true, items)),
      [`GET /api/users?${new URLSearchParams({ query: '本' }).toString()}`]: () => json(200, { items: [BEN] }),
      [`POST /api/spaces/${TEAM_ID}/members`]: () => {
        posts += 1
        if (posts === 1) {
          items = [...items, member(BEN, 'viewer')]
          return apiError(500, 'INTERNAL_ERROR')
        }
        return apiError(409, 'ALREADY_MEMBER')
      },
    })
    renderApp(MEMBERS_PATH)
    fireEvent.change(await screen.findByLabelText('要添加的同事'), { target: { value: '本' } })
    fireEvent.click(await screen.findByRole('button', { name: '@ben 本' }))
    const listed = api.requests.filter(request => request.key === MEMBERS_KEY).length
    fireEvent.click(screen.getByRole('button', { name: '添加成员' }))
    expect(await screen.findByText('没能确认是否已经添加（服务器出了点问题，请稍后重试）。成员列表已刷新：这个人在列表里，就是已经加好了。')).toBeInTheDocument()
    await waitFor(() => expect(api.requests.filter(request => request.key === MEMBERS_KEY).length).toBeGreaterThan(listed))
    const table = screen.getByRole('table', { name: '成员列表' })
    await waitFor(() => expect(personIn(table, '本', 'ben')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: '添加成员' }))
    expect(await screen.findByText('这个人已经是空间的成员了（可能就是刚才没能确认的那一次添加），成员列表已刷新。')).toBeInTheDocument()
    // 选择随之清掉：这个人已经是成员，不再是候选
    expect(screen.getByLabelText('要添加的同事')).toHaveValue('')
    expect(screen.getByRole('button', { name: '添加成员' })).toHaveAttribute('aria-disabled', 'true')
  })

  it('添加时得到"已经是成员"，而之前添加这个人没有过结果未知（多半是别人刚加的）：只说已经是成员，成员列表刷新，不说"刚才那一次"（第五批 G5）', async () => {
    const CAT = { id: '0199a2c4-0000-7000-8000-00000000000c', username: 'cat', displayName: '凯特' }
    let items = [member(SESSION.user, 'admin')]
    const api = loggedIn(MANAGER, {
      [MEMBERS_KEY]: () => json(200, membersList(true, items)),
      [`GET /api/users?${new URLSearchParams({ query: '本' }).toString()}`]: () => json(200, { items: [BEN] }),
      [`GET /api/users?${new URLSearchParams({ query: '凯' }).toString()}`]: () => json(200, { items: [CAT] }),
      [`POST /api/spaces/${TEAM_ID}/members`]: (init) => {
        const body = JSON.parse(String(init?.body)) as { userId: string }
        // 添加本的结果未知（其实没有加上）；凯特刚被别人加进来了
        if (body.userId === BEN.id)
          return networkFailure()
        items = [...items, member(CAT, 'viewer')]
        return apiError(409, 'ALREADY_MEMBER')
      },
    })
    renderApp(MEMBERS_PATH)
    fireEvent.change(await screen.findByLabelText('要添加的同事'), { target: { value: '本' } })
    fireEvent.click(await screen.findByRole('button', { name: '@ben 本' }))
    fireEvent.click(screen.getByRole('button', { name: '添加成员' }))
    expect(await screen.findByText(/^没能确认是否已经添加/)).toBeInTheDocument()

    // 换一个人：结果未知的是本，不是她
    fireEvent.click(screen.getByRole('button', { name: '重新选择 要添加的同事' }))
    fireEvent.change(screen.getByLabelText('要添加的同事'), { target: { value: '凯' } })
    fireEvent.click(await screen.findByRole('button', { name: '@cat 凯特' }))
    const listed = api.requests.filter(request => request.key === MEMBERS_KEY).length
    fireEvent.click(screen.getByRole('button', { name: '添加成员' }))
    expect(await screen.findByText('这个人已经是空间的成员了，成员列表已刷新。')).toBeInTheDocument()
    expect(screen.queryByText(/刚才没能确认的那一次添加/)).toBeNull()
    expect(api.requests.filter(request => request.key === MEMBERS_KEY).length).toBeGreaterThan(listed)
    await waitFor(() => expect(personIn(screen.getByRole('table', { name: '成员列表' }), '凯特', 'cat')).toBeInTheDocument())
  })

  it('成员表：显示名写成"李四（lisi）"的人与真正的李四分得清——登录名在单独的元素里；从右到左的显示名在 <bdi> 里（M2）', async () => {
    const real = { id: '0199a2c4-0000-7000-8000-000000000031', username: 'lisi', displayName: '李四' }
    const spoof = { id: '0199a2c4-0000-7000-8000-000000000032', username: 'mallory', displayName: '李四（lisi）' }
    const hebrew = { id: '0199a2c4-0000-7000-8000-000000000033', username: 'shalom', displayName: 'שלום' }
    loggedIn(MANAGER, { [MEMBERS_KEY]: () => json(200, membersList(true, [member(SESSION.user, 'admin'), member(real, 'viewer'), member(spoof, 'viewer'), member(hebrew, 'editor')])) })
    renderApp(MEMBERS_PATH)
    const table = await screen.findByRole('table', { name: '成员列表' })
    const realName = personIn(table, '李四', 'lisi')
    const spoofName = personIn(table, '李四（lisi）', 'mallory')
    expect(realName.closest('tr')).not.toBe(spoofName.closest('tr'))
    // 选择框与按钮的可读名称：显示名用 FSI…PDI 隔离，登录名另外标出
    expect(within(spoofName.closest('tr')!).getByRole('combobox')).toHaveAccessibleName(`${plainName('李四（lisi）', 'mallory')} 的角色`)
    expect(within(spoofName.closest('tr')!).getByRole('button', { name: `移出 ${plainName('李四（lisi）', 'mallory')}` })).toBeInTheDocument()
    expect(personIn(table, 'שלום', 'shalom').querySelector('bdi')).toHaveTextContent('שלום')
    // 本人那一行：名字之后标"（我）"
    expect(personIn(table, '艾米', 'amy').closest('td')).toHaveTextContent('@amy 艾米（我）')
  })

  it('显示名写成"李四 @lisi"冒充别人：选择框、移出按钮的可读名称与确认框的标题都是登录名在前，与真正的李四从开头就分得清（第二批 M-1）', async () => {
    const real = { id: '0199a2c4-0000-7000-8000-000000000034', username: 'lisi', displayName: '李四' }
    const spoof = { id: '0199a2c4-0000-7000-8000-000000000035', username: 'eve', displayName: '李四 @lisi' }
    loggedIn(MANAGER, { [MEMBERS_KEY]: () => json(200, membersList(true, [member(SESSION.user, 'admin'), member(real, 'viewer'), member(spoof, 'viewer')])) })
    renderApp(MEMBERS_PATH)
    const table = await screen.findByRole('table', { name: '成员列表' })
    const rowOfSpoof = personIn(table, '李四 @lisi', 'eve').closest('tr')!
    // 纯文字里的人名：登录名在前、显示名用 FSI…PDI 隔离在后（写出字面量，不拿实现对实现）
    expect(within(rowOfSpoof).getByRole('combobox')).toHaveAccessibleName('@eve \u2068李四 @lisi\u2069 的角色')
    expect(within(personIn(table, '李四', 'lisi').closest('tr')!).getByRole('combobox')).toHaveAccessibleName('@lisi \u2068李四\u2069 的角色')
    // 以真人的可读名称开头的选择框只有真人那一个
    const roles = within(table).getAllByRole('combobox').map(select => select.getAttribute('aria-label') ?? '')
    expect(roles.filter(label => label.startsWith('@lisi '))).toEqual(['@lisi \u2068李四\u2069 的角色'])
    fireEvent.click(within(rowOfSpoof).getByRole('button', { name: '移出 @eve \u2068李四 @lisi\u2069' }))
    expect(await screen.findByRole('dialog', { name: '把 @eve \u2068李四 @lisi\u2069 移出这个空间？' })).toBeInTheDocument()
  })

  it('浏览器标签页的标题是这个空间的成员（WCAG 2.4.2，S4）', async () => {
    loggedIn(team(), { [MEMBERS_KEY]: () => json(200, membersList(false, [member(SESSION.user, 'admin')])) })
    renderApp(MEMBERS_PATH)
    await screen.findByRole('heading', { name: '市场部 的成员' })
    await waitFor(() => expect(document.title).toBe('市场部 的成员 - NerveOffice'))
  })
})

describe('左侧导航与"空间不存在"（M2-P6 复核 G5、G6）', () => {
  it('用 /spaces/{本人的个人空间} 打开（根目录、文件夹、回收站）："我的空间"是当前项', async () => {
    const personal = SESSION.personalSpace.id
    const folderId = '0199a2c4-0000-7000-8000-0000000000f1'
    loggedIn(team(), {
      [foldersKey(personal)]: () => json(200, {
        items: [{ id: folderId, spaceId: personal, parentId: null, name: '方案', depth: 1, createdAt: '2026-09-29T01:00:00.000Z', updatedAt: '2026-09-29T01:00:00.000Z', permissions: { canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: true, canDelete: true } }],
        truncated: false,
      }),
      [foldersKey(personal, folderId)]: noFolders(),
      [`GET /api/documents?${new URLSearchParams({ spaceId: personal, folderId }).toString()}`]: () => json(200, { items: [], nextCursor: null }),
      [`GET /api/trash?${new URLSearchParams({ spaceId: personal }).toString()}`]: () => json(200, { items: [], nextCursor: null }),
    })
    const app = renderApp(`/spaces/${personal}`)
    const mine = await within(await screen.findByRole('navigation', { name: '空间' })).findByRole('link', { name: '我的空间' })
    await waitFor(() => expect(mine).toHaveAttribute('aria-current', 'page'))
    void app.router.navigate(`/spaces/${personal}/folders/${folderId}`)
    await screen.findByRole('navigation', { name: '位置' })
    expect(within(spaceNav()).getByRole('link', { name: '我的空间' })).toHaveAttribute('aria-current', 'page')
    void app.router.navigate(`/spaces/${personal}/trash`)
    await screen.findByRole('heading', { name: '我的空间 的回收站' })
    expect(within(spaceNav()).getByRole('link', { name: '我的空间' })).toHaveAttribute('aria-current', 'page')
    // 别的空间：不是当前项
    void app.router.navigate(`/spaces/${TEAM_ID}`)
    expect(await screen.findByRole('heading', { name: '市场部' })).toBeInTheDocument()
    expect(within(spaceNav()).getByRole('link', { name: '我的空间' })).not.toHaveAttribute('aria-current')
    expect(within(spaceNav()).getByRole('link', { name: '市场部' })).toHaveAttribute('aria-current', 'page')
  })

  it('空间看不到时这一页同样有标题（h1）与浏览器标签页的标题', async () => {
    loggedIn(team(), { [`GET /api/spaces/${TEAM_ID}`]: () => apiError(404, 'NOT_FOUND') })
    renderApp(`/spaces/${TEAM_ID}`)
    expect(await screen.findByRole('heading', { level: 1, name: '空间不存在' })).toBeInTheDocument()
    expect(screen.getByText('空间不存在，或者你没有访问权限')).toBeInTheDocument()
    await waitFor(() => expect(document.title).toBe('空间不存在 - NerveOffice'))
  })
})

// 写入已经确定成功之后的刷新（Codex 对抗评审 CX4、CX5）：刷新一直不回来时确认框到了时限照常关掉（原来一直停在"正在处理…"、关不掉）；
// 留着之前的列表、刷新却失败了时列表明说没能刷新、给出重试（原来照旧显示旧的，看不出已经过时）
describe('US-M2-06 成员页与导航：写入成功之后的刷新（Codex 对抗评审 CX4、CX5）', () => {
  it('移出成功（204），随后刷新成员列表的请求一直不回来：到了时限确认框照常关掉，那一行按确定的写入结果已经不在、焦点交给页面的标题；说明在关掉之后写进状态区，说成员列表还在刷新；刷新回来之后不再说', async () => {
    // 跟着真实的时间走，另外可以一下子拨过时限；在前面留出 2 秒的余量，测试本身的耗时不会让时限提前到
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      let finish: (response: Response) => void = () => {}
      const api = loggedIn(MANAGER, {
        [MEMBERS_KEY]: inTurn(() => json(200, membersList(true, [member(SESSION.user, 'admin'), member(CAT, 'editor')])), async () => new Promise<Response>((resolve) => {
          finish = resolve
        })),
        [memberKey('DELETE', CAT)]: () => new Response(null, { status: 204 }),
      })
      renderApp(MEMBERS_PATH)
      const remove = await screen.findByRole('button', { name: `移出 ${plainName('凯特', 'cat')}` })
      // 说明的容器一开始就在（空的）
      const statuses = screen.getAllByRole('status')
      remove.focus()
      fireEvent.click(remove)
      const dialog = await screen.findByRole('dialog', { name: `把 ${plainName('凯特', 'cat')} 移出这个空间？` })
      const announced = watchAnnouncement('已把 @cat 凯特 移出这个空间')
      fireEvent.click(within(dialog).getByRole('button', { name: '移出' }))
      // 前提：DELETE 已经成功，刷新成员列表的请求已经发出、还没有回来
      await waitFor(() => expect(api.requests.filter(request => request.key === MEMBERS_KEY)).toHaveLength(2))
      await act(async () => vi.advanceTimersByTimeAsync(OUTCOME_REFRESH_TIME_LIMIT_MS - 2_000))
      expect(within(dialog).getByRole('button', { name: '正在处理…' })).toHaveAttribute('aria-disabled', 'true')
      await act(async () => vi.advanceTimersByTimeAsync(2_000))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(screen.queryByRole('button', { name: `移出 ${plainName('凯特', 'cat')}` })).toBeNull()
      await waitFor(() => expect(document.activeElement).toBe(membersTitle()))
      const notice = await waitFor(() => {
        const found = statuses.find(status => status.textContent.startsWith('已把 '))
        expect(found).toBeDefined()
        return found!
      })
      expect(notice).toHaveTextContent('已把 @cat 凯特 移出这个空间；成员列表还在刷新，显示的可能还是之前的，刷新好了会自动更新')
      personIn(notice, '凯特', 'cat')
      expect(announced()).toEqual({ ariaHidden: false, focusReturned: true })
      // 刷新回来了：不再说还在刷新
      await act(async () => finish(json(200, membersList(true, [member(SESSION.user, 'admin')]))))
      await waitFor(() => expect(notice).toHaveTextContent(/^已把 @cat 凯特 移出这个空间$/))
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('移出成功、刷新也在时限之内回来：照旧不另外说明（成员表看得见），状态区是空的', async () => {
    let items = [member(SESSION.user, 'admin'), member(CAT, 'editor')]
    loggedIn(MANAGER, {
      [MEMBERS_KEY]: () => json(200, membersList(true, items)),
      [memberKey('DELETE', CAT)]: () => {
        items = [member(SESSION.user, 'admin')]
        return new Response(null, { status: 204 })
      },
    })
    renderApp(MEMBERS_PATH)
    const remove = await screen.findByRole('button', { name: `移出 ${plainName('凯特', 'cat')}` })
    const statuses = screen.getAllByRole('status')
    fireEvent.click(remove)
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '移出' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await settle()
    expect(statuses.every(status => status.textContent === '')).toBe(true)
  })

  it('调整角色成功，随后刷新成员列表失败：标题下面说明成员列表与空间信息没能刷新（原因，同一个请求，DEF-040）、给出重试，这一行已经是保存之后的角色；重试成功之后说明消失，列表是新的', async () => {
    const api = loggedIn(MANAGER, {
      [MEMBERS_KEY]: () => json(200, membersList(true, [member(SESSION.user, 'admin'), member(BEN, 'viewer')])),
      [memberKey('PUT', BEN)]: () => json(200, member(BEN, 'editor')),
    })
    renderApp(MEMBERS_PATH)
    const { select, row } = await roleOf('本', 'ben')
    api.on(MEMBERS_KEY, () => apiError(500, 'INTERNAL_ERROR'))
    saveRole(select, row, 'editor')
    const problem = await screen.findByText('成员列表与空间信息没能刷新，显示的还是之前的内容', {}, { timeout: 4000 })
    const alert = problem.closest('[role="alert"]') as HTMLElement
    expect(alert).toHaveTextContent('服务器出了点问题，请稍后重试')
    expect(membersTitle().compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(alert.compareDocumentPosition(screen.getByRole('table', { name: '成员列表' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(select).toHaveValue('editor')
    api.on(MEMBERS_KEY, () => json(200, membersList(true, [member(SESSION.user, 'admin'), member(BEN, 'editor'), member(CAT, 'viewer')])))
    fireEvent.click(within(alert).getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('combobox', { name: `${plainName('凯特', 'cat')} 的角色` })).toBeInTheDocument()
    expect(screen.queryByText('成员列表与空间信息没能刷新，显示的还是之前的内容')).toBeNull()
  })

  it('空间改名成功、随后刷新导航失败：导航里明说空间列表没能刷新、给出重试（之前的列表照常显示）；页头已经按响应是新名称', async () => {
    const api = loggedIn(MANAGER, {
      [`PUT /api/spaces/${TEAM_ID}/name`]: () => json(200, { id: TEAM_ID, name: '市场二部', status: 'active', visibleToAll: false }),
    })
    renderApp(`/spaces/${TEAM_ID}`)
    fireEvent.click(await screen.findByRole('button', { name: '改名' }))
    fireEvent.change(screen.getByLabelText('空间名称'), { target: { value: '市场二部' } })
    api.on('GET /api/spaces', () => apiError(500, 'INTERNAL_ERROR'))
    api.on(`GET /api/spaces/${TEAM_ID}`, () => apiError(500, 'INTERNAL_ERROR'))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    const problem = await within(spaceNav()).findByText('空间列表没能刷新，显示的还是之前的内容', {}, { timeout: 4000 })
    const alert = problem.closest('[role="alert"]') as HTMLElement
    // 按确定的写入结果先改好的名称：页头与导航都是新名称（刷新失败也不弹回旧的）
    expect(screen.getByRole('heading', { level: 1, name: '市场二部' })).toBeInTheDocument()
    expect(within(spaceNav()).getByRole('link', { name: '市场二部' })).toBeInTheDocument()
    // 页头自己的重新请求同样失败了：页头下面另说空间信息没能刷新（DEF-040）
    expect(await screen.findByText('空间信息没能刷新，显示的还是之前的内容', {}, { timeout: 4000 })).toBeInTheDocument()
    api.on('GET /api/spaces', () => json(200, { items: [personalSpaceOf(SESSION), { ...MANAGER, name: '市场二部' }, team({ id: '0199a2c4-0000-7000-8000-0000000000c2', name: '新来的空间' })] }))
    fireEvent.click(within(alert).getByRole('button', { name: '重试' }))
    expect(await within(spaceNav()).findByRole('link', { name: '新来的空间' })).toBeInTheDocument()
    expect(within(spaceNav()).queryByText('空间列表没能刷新，显示的还是之前的内容')).toBeNull()
  })
})
