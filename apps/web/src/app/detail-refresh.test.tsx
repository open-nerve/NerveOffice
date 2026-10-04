// 详情的查询留着上一次的数据、重新请求却失败了（DEF-040）：空间页与回收站页的页头、成员页（成员表与空间信息同一个请求）、
// 转移页的账户、面包屑（上一层的列表）、行内操作展开时取的文档权限。每一处都看：说明"…没能刷新"与原因、之前的内容照常显示、
// 重试成功之后说明消失，焦点交给一直在的元素（不落到 body）；按访问权限被拒绝（403、404）照旧由页面说明，不说成没能刷新；
// 第一次就没取到照旧是"加载失败"。共用的说明本身见 shared/ui/refresh-problem.test.tsx。接口用假的 fetch。
import type { AdminUser, DocumentDetail, DocumentSummary, Folder, SessionResponse, SpaceMember, SpaceMemberListResponse, SpaceView } from '@nerve-office/contracts'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { apiError, installFakeApi, inTurn, json, networkFailure } from '../shared/testing/fake-api.test-support.ts'
import { documentsKey, foldersKey, noFolders, spaceRoutes } from '../shared/testing/spaces.test-support.ts'
import { AMY, deferred, listPage, session, settle, SPACES } from './admin.test-support.ts'
import { renderApp } from './render-app.test-support.tsx'

const SESSION: SessionResponse = {
  user: { id: '0199a2c4-0000-7000-8000-00000000000a', username: 'amy', displayName: '艾米', systemRole: 'member' },
  personalSpace: { id: '0199a2c4-0000-7000-8000-0000000000a1', name: '艾米' },
  csrfToken: 'csrf-1',
}

const PERSONAL_ID = SESSION.personalSpace.id
const TEAM_ID = '0199a2c4-0000-7000-8000-0000000000c1'
const PLAN_ID = '0199a2c4-0000-7000-8000-0000000000f1'
const WEEKLY_ID = '0199a2c4-0000-7000-8000-0000000000d1'

const SPACE_PATH = `/spaces/${TEAM_ID}`
const SPACE_KEY = `GET /api/spaces/${TEAM_ID}`
const MEMBERS_PATH = `/spaces/${TEAM_ID}/members`
const MEMBERS_KEY = `GET /api/spaces/${TEAM_ID}/members`
const DETAIL_KEY = `GET /api/documents/${WEEKLY_ID}`

const SERVER = '服务器出了点问题，请稍后重试'
const NETWORK = '网络连接失败，请检查网络后重试'

const VIEWER_PERMISSIONS: SpaceView['permissions'] = { canCreateDocuments: false, canCreateFolders: false, canViewMembers: true, canManageMembers: false, canRename: false, canPurgeTrash: false }

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

const WEEKLY: DocumentSummary = { id: WEEKLY_ID, title: '周报', type: 'sheet', createdAt: '2026-09-29T01:00:00.000Z', updatedAt: '2026-09-29T02:00:00.000Z' }

function detail(changes: Partial<DocumentDetail> = {}): DocumentDetail {
  return {
    ...WEEKLY,
    spaceId: PERSONAL_ID,
    space: { id: PERSONAL_ID, type: 'personal' },
    folderId: null,
    accessVia: 'space',
    revision: 1,
    profile: 'sheet@1',
    formatVersion: 1,
    permissions: { canEdit: true, canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: true, canCopy: true, canDelete: true, canShare: false },
    ...changes,
  }
}

function folder(id: string, name: string): Folder {
  return {
    id,
    spaceId: PERSONAL_ID,
    parentId: null,
    name,
    depth: 1,
    createdAt: '2026-09-29T01:00:00.000Z',
    updatedAt: '2026-09-29T01:00:00.000Z',
    permissions: { canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: true, canDelete: true },
  }
}

function teamKey(path: string, query: Record<string, string> = {}): string {
  return `GET ${path}?${new URLSearchParams({ spaceId: TEAM_ID, ...query }).toString()}`
}

/** 登录之后：导航里有这个团队空间；它的页头、根目录与回收站；个人空间（首页）的文档里有"周报" */
function loggedIn(handlers: Parameters<typeof installFakeApi>[0] = {}) {
  return installFakeApi({
    'GET /api/auth/session': () => json(200, SESSION),
    ...spaceRoutes(SESSION, [team()]),
    [documentsKey(SESSION)]: () => json(200, { items: [WEEKLY], nextCursor: null }),
    [SPACE_KEY]: () => json(200, team()),
    [teamKey('/api/documents')]: () => json(200, { items: [], nextCursor: null }),
    [foldersKey(TEAM_ID)]: noFolders(),
    [teamKey('/api/trash')]: () => json(200, { items: [], nextCursor: null }),
    ...handlers,
  })
}

function requestCount(api: ReturnType<typeof installFakeApi>, key: string): number {
  return api.requests.filter(request => request.key === key).length
}

/** 说明里的第一句："空间信息没能刷新，显示的还是之前的内容" */
function problemText(name: string): string {
  return `${name}没能刷新，显示的还是之前的内容`
}

/** 等到"…没能刷新"的说明出现（5xx 与断网会自动重试一次，隔 1 秒），返回整条说明（role="alert"） */
async function problemOf(name: string): Promise<HTMLElement> {
  const sentence = await screen.findByText(problemText(name), {}, { timeout: 4000 })
  return sentence.closest('[role="alert"]') as HTMLElement
}

/** 用键盘按说明里的"重试"：焦点在它上面 */
function retry(alert: HTMLElement): void {
  const button = within(alert).getByRole('button', { name: '重试' })
  button.focus()
  fireEvent.click(button)
}

/** a 在文档里排在 b 前面 */
function precedes(a: Node, b: Node): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}

function spaceNav(): HTMLElement {
  return screen.getByRole('navigation', { name: '空间' })
}

/** 先到首页（我的空间），再回到 path：path 上的页面重新挂上，缓存里有的详情显示出来、同时重新请求 */
async function revisit(app: ReturnType<typeof renderApp>, path: string): Promise<void> {
  fireEvent.click(within(spaceNav()).getByRole('link', { name: '我的空间' }))
  expect(await screen.findByRole('heading', { level: 1, name: '我的空间' })).toBeInTheDocument()
  void app.router.navigate(path)
}

describe('DEF-040 空间页的页头', () => {
  it('留着之前的页头、重新请求失败（5xx）：名称下面说明空间信息没能刷新与原因，之前的名称、角色与操作照常显示；重试成功之后说明消失、页头是新的，焦点交给标题', async () => {
    const api = loggedIn()
    const app = renderApp(SPACE_PATH)
    expect(await screen.findByRole('heading', { level: 1, name: '市场部' })).toBeInTheDocument()
    api.on(SPACE_KEY, () => apiError(500, 'INTERNAL_ERROR'))
    await revisit(app, SPACE_PATH)
    const alert = await problemOf('空间信息')
    expect(alert).toHaveTextContent(SERVER)
    const title = screen.getByRole('heading', { level: 1, name: '市场部' })
    expect(screen.getByText('我的角色：编辑者')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新建表格' })).toBeInTheDocument()
    // 在页头的名称下面、内容区（回收站的入口与文档列表）上面
    expect(precedes(title, alert)).toBe(true)
    expect(precedes(alert, screen.getByRole('link', { name: '回收站' }))).toBe(true)

    api.on(SPACE_KEY, () => json(200, team({ name: '市场二部', role: 'viewer', permissions: VIEWER_PERMISSIONS })))
    retry(alert)
    expect(await screen.findByRole('heading', { level: 1, name: '市场二部' })).toBe(title)
    expect(screen.queryByText(problemText('空间信息'))).toBeNull()
    expect(screen.getByText('我的角色：查看者')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '新建表格' })).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(title))
  })

  it('重试又失败了（断网）：说明留着、原因换成新的，之前的页头照常显示', async () => {
    const api = loggedIn()
    const app = renderApp(SPACE_PATH)
    expect(await screen.findByRole('heading', { level: 1, name: '市场部' })).toBeInTheDocument()
    api.on(SPACE_KEY, () => apiError(500, 'INTERNAL_ERROR'))
    await revisit(app, SPACE_PATH)
    const alert = await problemOf('空间信息')
    api.on(SPACE_KEY, networkFailure)
    const before = requestCount(api, SPACE_KEY)
    retry(alert)
    await waitFor(() => expect(within(alert).getByText(NETWORK)).toBeInTheDocument(), { timeout: 4000 })
    expect(requestCount(api, SPACE_KEY)).toBeGreaterThan(before)
    expect(screen.getByRole('heading', { level: 1, name: '市场部' })).toBeInTheDocument()
  })

  it.each([
    ['404（看不到了）：照旧换成"空间不存在"', 404, 'NOT_FOUND'],
    ['403：照旧留着之前的页头（这个接口看不到时一律是 404）', 403, 'PERMISSION_DENIED'],
  ])('重新请求按访问权限被拒绝，%s，不说成没能刷新', async (_case, status, code) => {
    const api = loggedIn()
    const app = renderApp(SPACE_PATH)
    expect(await screen.findByRole('heading', { level: 1, name: '市场部' })).toBeInTheDocument()
    api.on(SPACE_KEY, () => apiError(status, code))
    await revisit(app, SPACE_PATH)
    await waitFor(() => expect(requestCount(api, SPACE_KEY)).toBe(2))
    if (status === 404)
      expect(await screen.findByText('空间不存在，或者你没有访问权限')).toBeInTheDocument()
    await settle()
    if (status === 403)
      expect(screen.getByRole('heading', { level: 1, name: '市场部' })).toBeInTheDocument()
    expect(screen.queryByText(/没能刷新/)).toBeNull()
  })

  it('第一次就没取到（5xx）：照旧"空间加载失败"与重试，不说没能刷新', async () => {
    loggedIn({ [SPACE_KEY]: () => apiError(500, 'INTERNAL_ERROR') })
    renderApp(SPACE_PATH)
    expect(await screen.findByRole('heading', { name: '空间加载失败' }, { timeout: 4000 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
    expect(screen.queryByText(/没能刷新/)).toBeNull()
  })
})

describe('DEF-040 回收站页的页头', () => {
  it('从空间页进来、页头的重新请求失败：标题照旧是之前的空间名，下面说明空间信息没能刷新；重试成功之后标题是新的、说明消失，焦点交给标题', async () => {
    const api = loggedIn()
    renderApp(SPACE_PATH)
    expect(await screen.findByRole('heading', { level: 1, name: '市场部' })).toBeInTheDocument()
    api.on(SPACE_KEY, () => apiError(502, 'INTERNAL_ERROR'))
    fireEvent.click(screen.getByRole('link', { name: '回收站' }))
    const title = await screen.findByRole('heading', { level: 1, name: '市场部 的回收站' })
    const alert = await problemOf('空间信息')
    expect(alert).toHaveTextContent(SERVER)
    expect(screen.getByRole('heading', { level: 1, name: '市场部 的回收站' })).toBe(title)
    expect(precedes(title, alert)).toBe(true)
    expect(precedes(alert, screen.getByText('回收站里没有内容'))).toBe(true)

    api.on(SPACE_KEY, () => json(200, team({ name: '市场二部' })))
    retry(alert)
    expect(await screen.findByRole('heading', { level: 1, name: '市场二部 的回收站' })).toBe(title)
    expect(screen.queryByText(problemText('空间信息'))).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(title))
  })

  it('页头的重新请求得到 404：照旧换成"空间不存在"，不说没能刷新', async () => {
    const api = loggedIn()
    renderApp(SPACE_PATH)
    expect(await screen.findByRole('heading', { level: 1, name: '市场部' })).toBeInTheDocument()
    api.on(SPACE_KEY, () => apiError(404, 'NOT_FOUND'))
    fireEvent.click(screen.getByRole('link', { name: '回收站' }))
    expect(await screen.findByText('空间不存在，或者你没有访问权限')).toBeInTheDocument()
    await settle()
    expect(screen.queryByText(/没能刷新/)).toBeNull()
  })
})

function member(user: SpaceMember['user'], role: SpaceMember['role']): SpaceMember {
  return { user, role, status: 'active', createdAt: '2026-09-29T01:00:00.000Z' }
}

function membersList(name: string, status: SpaceView['status']): SpaceMemberListResponse {
  return { space: { id: TEAM_ID, name, status, visibleToAll: false }, canManage: false, items: [member(SESSION.user, 'viewer')] }
}

describe('DEF-040 成员页（成员表与页头的空间信息是同一个请求）', () => {
  it('留着之前的、重新请求失败：标题下面说明成员列表与空间信息没能刷新与原因，之前的标题、归档的说明与成员表照常显示；重试成功之后都是新的、说明消失，焦点交给标题', async () => {
    const api = loggedIn({ [MEMBERS_KEY]: () => json(200, membersList('市场部', 'archived')) })
    const app = renderApp(MEMBERS_PATH)
    expect(await screen.findByRole('heading', { level: 1, name: '市场部 的成员' })).toBeInTheDocument()
    api.on(MEMBERS_KEY, () => apiError(500, 'INTERNAL_ERROR'))
    await revisit(app, MEMBERS_PATH)
    const alert = await problemOf('成员列表与空间信息')
    expect(alert).toHaveTextContent(SERVER)
    const archived = screen.getByText('这个空间已归档：只有系统管理员能调整成员。')
    const table = screen.getByRole('table', { name: '成员列表' })
    const title = screen.getByRole('heading', { level: 1, name: '市场部 的成员' })
    // 紧跟在标题下面：说的也是标题里的空间
    expect(precedes(title, alert)).toBe(true)
    expect(precedes(alert, archived)).toBe(true)
    expect(precedes(alert, table)).toBe(true)

    api.on(MEMBERS_KEY, () => json(200, membersList('市场二部', 'active')))
    retry(alert)
    expect(await screen.findByRole('heading', { level: 1, name: '市场二部 的成员' })).toBe(title)
    expect(screen.queryByText(problemText('成员列表与空间信息'))).toBeNull()
    expect(screen.queryByText('这个空间已归档：只有系统管理员能调整成员。')).toBeNull()
    expect(screen.getByText('只有空间管理员能添加、调整与移出成员。')).toBeInTheDocument()
    await waitFor(() => expect(document.activeElement).toBe(title))
  })

  it.each([
    ['403（不能查看成员）：换成服务端在这次拒绝里给出的说明', 403, 'PERMISSION_DENIED', '你不能查看这个空间的成员'],
    ['404（看不到了）：换成"空间不存在"', 404, 'NOT_FOUND', '空间不存在，或者你没有访问权限'],
  ])('重新请求按访问权限被拒绝，%s，不说成没能刷新', async (_case, status, code, shown) => {
    const api = loggedIn({ [MEMBERS_KEY]: () => json(200, membersList('市场部', 'active')) })
    const app = renderApp(MEMBERS_PATH)
    expect(await screen.findByRole('heading', { level: 1, name: '市场部 的成员' })).toBeInTheDocument()
    api.on(MEMBERS_KEY, () => apiError(status, code, '你不能查看这个空间的成员'))
    await revisit(app, MEMBERS_PATH)
    expect(await screen.findByText(shown)).toBeInTheDocument()
    expect(screen.queryByRole('table', { name: '成员列表' })).toBeNull()
    await settle()
    expect(screen.queryByText(/没能刷新/)).toBeNull()
  })
})

const LEAVER: AdminUser = { ...AMY, status: 'disabled' }
const ACCOUNT_KEY = `GET /api/admin/users/${AMY.id}`
const TRANSFER_PATH = `/admin/users/${AMY.id}/documents`

/** 系统管理员：停用的艾米的转移页（个人空间里有一份文档）与账户页 */
function admin(handlers: Parameters<typeof installFakeApi>[0] = {}) {
  return installFakeApi({
    ...SPACES,
    'GET /api/auth/session': () => json(200, session('admin')),
    [ACCOUNT_KEY]: () => json(200, LEAVER),
    [`GET /api/admin/users/${AMY.id}/documents`]: () => json(200, listPage([{ id: WEEKLY_ID, title: '周报', type: 'sheet', updatedAt: '2026-09-29T01:00:00.000Z' }])),
    'GET /api/admin/users': () => json(200, listPage([LEAVER])),
    ...handlers,
  })
}

/** 回到账户页，再进这个人的转移页：转移页重新挂上，缓存里的账户显示出来、同时重新请求 */
async function revisitTransfer(app: ReturnType<typeof renderApp>): Promise<void> {
  void app.router.navigate('/admin/users')
  expect(await screen.findByRole('table', { name: '账户列表' })).toBeInTheDocument()
  void app.router.navigate(TRANSFER_PATH)
}

describe('DEF-040 转移页的账户', () => {
  it('留着之前的账户、重新请求失败：标题下面说明账户信息没能刷新，标题与转移的表单照常显示；重试成功之后说明消失，焦点交给标题', async () => {
    const api = admin()
    const app = renderApp(TRANSFER_PATH)
    expect(await screen.findByRole('heading', { name: '转移 @amy 艾米 的文档' })).toBeInTheDocument()
    api.on(ACCOUNT_KEY, () => apiError(500, 'INTERNAL_ERROR'))
    await revisitTransfer(app)
    const alert = await problemOf('账户信息')
    expect(alert).toHaveTextContent(SERVER)
    const title = screen.getByRole('heading', { name: '转移 @amy 艾米 的文档' })
    expect(precedes(title, alert)).toBe(true)
    expect(screen.getByRole('button', { name: '转移' })).toBeInTheDocument()

    api.on(ACCOUNT_KEY, () => json(200, LEAVER))
    retry(alert)
    await waitFor(() => expect(screen.queryByText(problemText('账户信息'))).toBeNull())
    // 这一页没有 useFocusRescue：说明消失时由它自己交给标题，不落到 body
    expect(document.activeElement).toBe(title)
  })

  it('重新请求得到 404（账户不存在了）：照旧说明不存在、可以回到账户，不说没能刷新', async () => {
    const api = admin()
    const app = renderApp(TRANSFER_PATH)
    expect(await screen.findByRole('heading', { name: '转移 @amy 艾米 的文档' })).toBeInTheDocument()
    api.on(ACCOUNT_KEY, () => apiError(404, 'NOT_FOUND'))
    await revisitTransfer(app)
    expect(await screen.findByText('内容不存在，或者你没有访问权限')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '返回账户' })).toBeInTheDocument()
    await settle()
    expect(screen.queryByText(/没能刷新/)).toBeNull()
  })

  it('重新请求得到 403（不再是系统管理员）：不说没能刷新；重新确认会话之后说明没有权限', async () => {
    const recheck = deferred()
    const api = admin({ 'GET /api/auth/session': inTurn(() => json(200, session('admin')), recheck.handler) })
    const app = renderApp(TRANSFER_PATH)
    expect(await screen.findByRole('heading', { name: '转移 @amy 艾米 的文档' })).toBeInTheDocument()
    api.on(ACCOUNT_KEY, () => apiError(403, 'PERMISSION_DENIED'))
    await revisitTransfer(app)
    // 会话的重新确认还没回来：页面还是之前的账户，不说没能刷新
    await waitFor(() => expect(requestCount(api, 'GET /api/auth/session')).toBe(2))
    await settle()
    expect(screen.getByRole('heading', { name: '转移 @amy 艾米 的文档' })).toBeInTheDocument()
    expect(screen.queryByText(/没能刷新/)).toBeNull()
    recheck.resolve(json(200, session('member')))
    expect(await screen.findByText('只有系统管理员能打开管理界面。')).toBeInTheDocument()
  })
})

const FOLDER_PATH = `/spaces/${PERSONAL_ID}/folders/${PLAN_ID}`

/** 个人空间的根目录下有"方案"，它里面是空的；个人空间的回收站 */
function inFolder() {
  return loggedIn({
    [foldersKey(PERSONAL_ID)]: () => json(200, { items: [folder(PLAN_ID, '方案')], truncated: false }),
    [foldersKey(PERSONAL_ID, PLAN_ID)]: noFolders(),
    [`GET /api/documents?${new URLSearchParams({ spaceId: PERSONAL_ID, folderId: PLAN_ID }).toString()}`]: () => json(200, { items: [], nextCursor: null }),
    [`GET /api/trash?${new URLSearchParams({ spaceId: PERSONAL_ID }).toString()}`]: () => json(200, { items: [], nextCursor: null }),
  })
}

/** 到回收站再回来：空间页重新挂上，路径上的每一层都重新请求 */
async function leaveAndReturn(app: ReturnType<typeof renderApp>): Promise<void> {
  fireEvent.click(screen.getByRole('link', { name: '回收站' }))
  expect(await screen.findByRole('heading', { level: 1, name: '我的空间 的回收站' })).toBeInTheDocument()
  void app.router.navigate(FOLDER_PATH)
}

describe('DEF-040 面包屑（名称取自上一层的列表）', () => {
  it('上一层的列表重新请求失败：面包屑照旧是之前的名称，下面说明位置没能刷新；重试成功之后名称是新的、说明消失，焦点交给标题', async () => {
    const api = inFolder()
    const app = renderApp(FOLDER_PATH)
    const breadcrumb = await screen.findByRole('navigation', { name: '位置' })
    expect(await within(breadcrumb).findByText('方案')).toHaveAttribute('aria-current', 'page')
    api.on(foldersKey(PERSONAL_ID), () => apiError(500, 'INTERNAL_ERROR'))
    await leaveAndReturn(app)
    const alert = await problemOf('位置')
    expect(alert).toHaveTextContent(SERVER)
    const trail = screen.getByRole('navigation', { name: '位置' })
    expect(within(trail).getByText('方案')).toHaveAttribute('aria-current', 'page')
    expect(precedes(trail, alert)).toBe(true)
    // 当前这一层照常刷新好了：不另外说文件夹列表没能刷新
    expect(screen.queryByText(problemText('文件夹列表'))).toBeNull()

    api.on(foldersKey(PERSONAL_ID), () => json(200, { items: [folder(PLAN_ID, '方案（定稿）')], truncated: false }))
    retry(alert)
    expect(await within(trail).findByText('方案（定稿）')).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByText(problemText('位置'))).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: '我的空间' })))
  })

  it('当前这一层（不是上一层）刷新失败：照旧是"文件夹列表没能刷新"，面包屑的名称没有过时，不说位置没能刷新', async () => {
    const api = inFolder()
    const app = renderApp(FOLDER_PATH)
    const breadcrumb = await screen.findByRole('navigation', { name: '位置' })
    expect(await within(breadcrumb).findByText('方案')).toBeInTheDocument()
    api.on(foldersKey(PERSONAL_ID, PLAN_ID), () => apiError(500, 'INTERNAL_ERROR'))
    await leaveAndReturn(app)
    expect(await problemOf('文件夹列表')).toHaveTextContent(SERVER)
    expect(screen.queryByText(problemText('位置'))).toBeNull()
  })

  it('上一层重新请求得到 404（路径不成立了）：照旧说明这个文件夹不存在，不说位置没能刷新', async () => {
    const api = inFolder()
    const app = renderApp(FOLDER_PATH)
    const breadcrumb = await screen.findByRole('navigation', { name: '位置' })
    expect(await within(breadcrumb).findByText('方案')).toBeInTheDocument()
    api.on(foldersKey(PERSONAL_ID), () => apiError(404, 'NOT_FOUND'))
    await leaveAndReturn(app)
    expect(await screen.findByText('这个文件夹不存在，或者你没有访问权限')).toBeInTheDocument()
    await settle()
    expect(screen.queryByText(/没能刷新/)).toBeNull()
  })
})

/** 首页（个人空间）的"周报"：展开、收起、再展开（缓存里有之前取到的权限，同时重新取） */
async function reopenActions(): Promise<HTMLElement> {
  const trigger = await screen.findByRole('button', { name: '操作 周报' })
  fireEvent.click(trigger)
  expect(await screen.findByRole('button', { name: '改名' })).toBeInTheDocument()
  fireEvent.click(trigger)
  await waitFor(() => expect(screen.queryByRole('button', { name: '改名' })).toBeNull())
  return trigger
}

describe('DEF-040 行内操作展开时取的文档权限', () => {
  it('再次展开时留着之前的权限、重新取失败：之前的操作照常列出，后面说明可以做的操作没能刷新与原因；重试成功之后按新的权限列出、说明消失，焦点交给"取消"', async () => {
    const api = loggedIn({ [DETAIL_KEY]: () => json(200, detail()) })
    renderApp('/')
    const trigger = await reopenActions()
    api.on(DETAIL_KEY, () => apiError(500, 'INTERNAL_ERROR'))
    fireEvent.click(trigger)
    const alert = await problemOf('可以做的操作')
    expect(alert).toHaveTextContent(SERVER)
    expect(screen.getByRole('button', { name: '改名' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '删除' })).toBeInTheDocument()
    const cancel = screen.getByRole('button', { name: '取消' })
    // 排在操作之后：说明晚到时不把正要点的按钮挤开
    expect(precedes(cancel, alert)).toBe(true)

    // 重新取到的权限：只能复制了（例如刚被降为查看者）
    api.on(DETAIL_KEY, () => json(200, detail({ permissions: { canEdit: false, canRename: false, canMoveWithinSpace: false, canMoveAcrossSpaces: false, canCopy: true, canDelete: false, canShare: false } })))
    retry(alert)
    await waitFor(() => expect(screen.queryByRole('button', { name: '改名' })).toBeNull())
    expect(screen.getByRole('button', { name: '复制' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '删除' })).toBeNull()
    expect(screen.queryByText(problemText('可以做的操作'))).toBeNull()
    // 焦点留在面板里，不跳到页面的标题
    await waitFor(() => expect(document.activeElement).toBe(cancel))
  })

  it.each([
    ['404（已经不在了）', 404, 'NOT_FOUND'],
    ['403', 403, 'PERMISSION_DENIED'],
  ])('再次展开时重新取得到 %s：不说成没能刷新（留着之前列出的操作，下一次操作被拒绝时再说明）', async (_case, status, code) => {
    const api = loggedIn({ [DETAIL_KEY]: () => json(200, detail()) })
    renderApp('/')
    const trigger = await reopenActions()
    api.on(DETAIL_KEY, () => apiError(status, code))
    fireEvent.click(trigger)
    expect(await screen.findByRole('button', { name: '改名' })).toBeInTheDocument()
    await waitFor(() => expect(requestCount(api, DETAIL_KEY)).toBe(2))
    await settle()
    expect(screen.queryByText(/没能刷新/)).toBeNull()
  })

  it('第一次展开就没取到（5xx）：照旧说明没能确认可以做哪些操作、给出重试，不说没能刷新', async () => {
    loggedIn({ [DETAIL_KEY]: () => apiError(500, 'INTERNAL_ERROR') })
    renderApp('/')
    fireEvent.click(await screen.findByRole('button', { name: '操作 周报' }))
    expect(await screen.findByText(`没能确认可以做哪些操作：${SERVER}`, {}, { timeout: 4000 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
    expect(screen.queryByText(/没能刷新/)).toBeNull()
  })
})
