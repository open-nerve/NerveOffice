// 文件夹导航与行内的整理操作（M2-P4 设计 §3.7，US-M2-07、08、09）：面包屑与直达地址、新建文件夹、
// 按服务端给的权限显示行内操作、改名、移动、复制、删除。接口用假的 fetch。
import type { DocumentDetail, DocumentSummary, Folder, SessionResponse, SpaceView } from '@nerve-office/contracts'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { apiError, installFakeApi, json } from '../shared/testing/fake-api.test-support.ts'
import { documentsKey, foldersKey, noFolders, personalSpaceOf, spaceRoutes } from '../shared/testing/spaces.test-support.ts'
import { currentPath, renderApp } from './render-app.test-support.tsx'

const SESSION: SessionResponse = {
  user: { id: '0199a2c4-0000-7000-8000-00000000000a', username: 'amy', displayName: '艾米', systemRole: 'member' },
  personalSpace: { id: '0199a2c4-0000-7000-8000-0000000000a1', name: '艾米' },
  csrfToken: 'csrf-1',
}

const SPACE_ID = SESSION.personalSpace.id
const TEAM_ID = '0199a2c4-0000-7000-8000-0000000000c1'
const PLAN_ID = '0199a2c4-0000-7000-8000-0000000000f1'
const QUARTER_ID = '0199a2c4-0000-7000-8000-0000000000f2'
const WEEKLY_ID = '0199a2c4-0000-7000-8000-0000000000d1'

const ALL_FOLDER_PERMISSIONS = { canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: true, canDelete: true }

function folder(id: string, name: string, changes: Partial<Folder> = {}): Folder {
  return {
    id,
    spaceId: SPACE_ID,
    parentId: null,
    name,
    depth: 1,
    createdAt: '2026-09-29T01:00:00.000Z',
    updatedAt: '2026-09-29T01:00:00.000Z',
    permissions: ALL_FOLDER_PERMISSIONS,
    ...changes,
  }
}

function folderPage(items: readonly Folder[]) {
  return () => json(200, { items, truncated: false })
}

const WEEKLY: DocumentSummary = { id: WEEKLY_ID, title: '周报', type: 'sheet', createdAt: '2026-09-29T01:00:00.000Z', updatedAt: '2026-09-29T02:00:00.000Z' }

function detail(changes: Partial<DocumentDetail> = {}): DocumentDetail {
  return {
    ...WEEKLY,
    spaceId: SPACE_ID,
    space: { id: SPACE_ID, type: 'personal' },
    folderId: null,
    accessVia: 'space',
    revision: 1,
    profile: 'sheet@1',
    formatVersion: 1,
    permissions: { canEdit: true, canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: true, canCopy: true, canDelete: true, canShare: true },
    ...changes,
  }
}

const TEAM: SpaceView = {
  id: TEAM_ID,
  type: 'team',
  name: '市场部',
  status: 'active',
  visibleToAll: false,
  role: 'admin',
  permissions: { canCreateDocuments: true, canCreateFolders: true, canViewMembers: true, canManageMembers: true, canRename: true, canPurgeTrash: true },
}

/** 个人空间里：根目录下有文件夹与文档 */
function loggedIn(handlers: Parameters<typeof installFakeApi>[0] = {}) {
  return installFakeApi({
    'GET /api/auth/session': () => json(200, SESSION),
    ...spaceRoutes(SESSION),
    [documentsKey(SESSION)]: () => json(200, { items: [WEEKLY], nextCursor: null }),
    ...handlers,
  })
}

function documentsIn(folderId: string, items: readonly DocumentSummary[]) {
  const query = new URLSearchParams({ spaceId: SPACE_ID, folderId })
  return { [`GET /api/documents?${query.toString()}`]: () => json(200, { items, nextCursor: null }) }
}

function lastBody(api: ReturnType<typeof installFakeApi>, key: string): unknown {
  return api.requests.filter(request => request.key === key).at(-1)?.body
}

/** 展开一行的操作面板，等到面板里的按钮出现 */
async function openActions(name: string): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: `操作 ${name}` }))
}

/** 展开一行的操作面板，并返回那一行的"操作"按钮（收起面板之后焦点要回到它身上） */
async function openActionsFrom(name: string): Promise<HTMLElement> {
  const trigger = await screen.findByRole('button', { name: `操作 ${name}` })
  fireEvent.click(trigger)
  return trigger
}

/** 每一次"复制"请求带的 requestId，按发出的顺序 */
function copyRequestIds(api: ReturnType<typeof installFakeApi>): string[] {
  return api.requests
    .filter(request => request.key === `POST /api/documents/${WEEKLY_ID}/copy`)
    .map(request => (request.body as { requestId: string }).requestId)
}

/** 点一次"复制到这里"，等到这次请求失败（表单还在，按钮不再显示"正在复制…"） */
async function copyHere(api: ReturnType<typeof installFakeApi>, form: HTMLElement): Promise<void> {
  const sent = copyRequestIds(api).length
  fireEvent.click(within(form).getByRole('button', { name: /复制到这里|正在复制…/ }))
  await waitFor(() => {
    expect(copyRequestIds(api)).toHaveLength(sent + 1)
    expect(within(form).getByRole('button', { name: '复制到这里' })).toBeInTheDocument()
  })
}

/** 点一次"复制到这里"，等到这次成功（面板随之收起，表单从页面上消失） */
async function copySucceeds(api: ReturnType<typeof installFakeApi>, form: HTMLElement): Promise<void> {
  const sent = copyRequestIds(api).length
  fireEvent.click(within(form).getByRole('button', { name: '复制到这里' }))
  await waitFor(() => {
    expect(copyRequestIds(api)).toHaveLength(sent + 1)
    expect(form).not.toBeInTheDocument()
  })
}

/** 展开"周报"那一行的操作面板，进入复制的表单 */
async function openCopyForm(): Promise<HTMLElement> {
  await openActions('周报')
  fireEvent.click(await screen.findByRole('button', { name: '复制' }))
  return screen.getByRole('form', { name: '复制' })
}

/** 根目录下有"方案"一个文件夹，复制一律 5xx（结果未知）：用来观察 requestId 按什么记账 */
function copyAlwaysUnknown(): ReturnType<typeof installFakeApi> {
  return loggedIn({
    [foldersKey(SPACE_ID)]: folderPage([folder(PLAN_ID, '方案')]),
    [foldersKey(SPACE_ID, PLAN_ID)]: noFolders(),
    [`GET /api/documents/${WEEKLY_ID}`]: () => json(200, detail()),
    [`POST /api/documents/${WEEKLY_ID}/copy`]: () => apiError(500, 'INTERNAL_ERROR'),
  })
}

describe('US-M2-07 文件夹导航', () => {
  it('文件夹排在文档前面；点进去地址与内容都跟着变，面包屑能回到空间的根目录', async () => {
    loggedIn({
      [foldersKey(SPACE_ID)]: folderPage([folder(PLAN_ID, '方案')]),
      [foldersKey(SPACE_ID, PLAN_ID)]: noFolders(),
      ...documentsIn(PLAN_ID, [{ ...WEEKLY, id: QUARTER_ID, title: '季度计划' }]),
    })
    const app = renderApp('/')
    // 一份列表里文件夹在前：先是文件夹列表，再是文档列表
    expect(await screen.findByRole('link', { name: '方案' })).toBeInTheDocument()
    expect(within(screen.getByRole('list', { name: '文件夹列表' })).getAllByRole('listitem')).toHaveLength(1)
    expect(within(screen.getByRole('list', { name: '文档列表' })).getAllByRole('listitem')).toHaveLength(1)

    fireEvent.click(screen.getByRole('link', { name: '方案' }))
    expect(await screen.findByText('季度计划')).toBeInTheDocument()
    expect(currentPath(app)).toBe(`/spaces/${SPACE_ID}/folders/${PLAN_ID}`)
    const breadcrumb = screen.getByRole('navigation', { name: '位置' })
    expect(within(breadcrumb).getByText('方案')).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByText('周报')).not.toBeInTheDocument()

    fireEvent.click(within(breadcrumb).getByRole('link', { name: '我的空间' }))
    expect(await screen.findByText('周报')).toBeInTheDocument()
    expect(currentPath(app)).toBe(`/spaces/${SPACE_ID}`)
  })

  it('直接打开深层地址：每一级的名称从它上一层的列表里读出来，上一级是链接', async () => {
    loggedIn({
      [foldersKey(SPACE_ID)]: folderPage([folder(PLAN_ID, '方案')]),
      [foldersKey(SPACE_ID, PLAN_ID)]: folderPage([folder(QUARTER_ID, '二季度', { parentId: PLAN_ID, depth: 2 })]),
      [foldersKey(SPACE_ID, QUARTER_ID)]: noFolders(),
      ...documentsIn(QUARTER_ID, []),
    })
    renderApp(`/spaces/${SPACE_ID}/folders/${PLAN_ID}/${QUARTER_ID}`)
    const breadcrumb = await screen.findByRole('navigation', { name: '位置' })
    await waitFor(() => expect(within(breadcrumb).getByRole('link', { name: '方案' })).toHaveAttribute('href', `/spaces/${SPACE_ID}/folders/${PLAN_ID}`))
    expect(within(breadcrumb).getByText('二季度')).toHaveAttribute('aria-current', 'page')
  })

  it('地址里的文件夹不存在（被删或被移走）：明确说明，并给出回到空间根目录的入口', async () => {
    loggedIn({
      [foldersKey(SPACE_ID)]: folderPage([]),
      [foldersKey(SPACE_ID, PLAN_ID)]: () => apiError(404, 'NOT_FOUND'),
      ...documentsIn(PLAN_ID, []),
    })
    renderApp(`/spaces/${SPACE_ID}/folders/${PLAN_ID}`)
    expect(await screen.findByText('这个文件夹不存在，或者你没有访问权限')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '回到空间的根目录' })).toHaveAttribute('href', `/spaces/${SPACE_ID}`)
  })

  it('新建文件夹是行内表单（首屏不用弹窗）：建在当前位置，同一次新建只用一个 requestId', async () => {
    const api = loggedIn({
      [foldersKey(SPACE_ID)]: folderPage([folder(PLAN_ID, '方案')]),
      [foldersKey(SPACE_ID, PLAN_ID)]: noFolders(),
      ...documentsIn(PLAN_ID, []),
      'POST /api/folders': () => apiError(500, 'INTERNAL_ERROR'),
    })
    renderApp(`/spaces/${SPACE_ID}/folders/${PLAN_ID}`)
    fireEvent.click(await screen.findByRole('button', { name: '新建文件夹' }))
    const form = screen.getByRole('form', { name: '新建文件夹' })
    fireEvent.change(within(form).getByLabelText('文件夹名称'), { target: { value: '二季度' } })
    fireEvent.click(within(form).getByRole('button', { name: '新建文件夹' }))
    // 结果未知（M2-P6 复核 M1）：说清楚可能已经建好、原样再提交不会重复新建
    expect(await screen.findByText(/没能确认文件夹是否已经建好/)).toBeInTheDocument()
    const first = lastBody(api, 'POST /api/folders') as { requestId: string, parentId: string, name: string, spaceId: string }
    expect(first).toMatchObject({ spaceId: SPACE_ID, parentId: PLAN_ID, name: '二季度' })

    // 重试沿用同一个 requestId：服务端只建一个
    api.on('POST /api/folders', () => json(201, { ...folder(QUARTER_ID, '二季度', { parentId: PLAN_ID, depth: 2 }), replayed: false }))
    fireEvent.click(within(form).getByRole('button', { name: '新建文件夹' }))
    await waitFor(() => expect(screen.queryByRole('form', { name: '新建文件夹' })).not.toBeInTheDocument())
    expect((lastBody(api, 'POST /api/folders') as { requestId: string }).requestId).toBe(first.requestId)
  })

  it('在文件夹里新建表格：一次请求就带上 folderId，不再"建到根目录再移进来"；空间根目录下不带 folderId', async () => {
    const created = { ...detail({ id: QUARTER_ID, title: '未命名表格', folderId: PLAN_ID }), replayed: false }
    const api = loggedIn({
      [foldersKey(SPACE_ID)]: folderPage([folder(PLAN_ID, '方案')]),
      [foldersKey(SPACE_ID, PLAN_ID)]: noFolders(),
      ...documentsIn(PLAN_ID, []),
      'POST /api/documents': () => json(201, created),
    })
    const app = renderApp(`/spaces/${SPACE_ID}/folders/${PLAN_ID}`)
    fireEvent.click(await screen.findByRole('button', { name: '新建表格' }))
    await waitFor(() => expect(app.page.visits).toEqual([`assign /documents/${QUARTER_ID}`]))
    expect(lastBody(api, 'POST /api/documents')).toEqual({ type: 'sheet', spaceId: SPACE_ID, folderId: PLAN_ID, requestId: expect.stringMatching(/^[\da-f-]{36}$/) as unknown })
    // 只有新建这一次请求：没有跟着一次移动
    expect(api.requests.filter(request => request.key.endsWith('/move'))).toEqual([])
  })
})

describe('US-M2-07 行内的整理操作', () => {
  it('文档的操作面板按服务端给的权限显示：查看者只有复制，没有改名、移动、删除', async () => {
    loggedIn({
      [`GET /api/documents/${WEEKLY_ID}`]: () => json(200, detail({
        permissions: { canEdit: false, canRename: false, canMoveWithinSpace: false, canMoveAcrossSpaces: false, canCopy: true, canDelete: false, canShare: false },
      })),
    })
    renderApp('/')
    await openActions('周报')
    expect(await screen.findByRole('button', { name: '复制' })).toBeInTheDocument()
    for (const action of ['改名', '移动', '删除'])
      expect(screen.queryByRole('button', { name: action })).not.toBeInTheDocument()
  })

  it('改名是行内表单：提交 PATCH，成功之后面板收起', async () => {
    const api = loggedIn({
      [`GET /api/documents/${WEEKLY_ID}`]: () => json(200, detail()),
      [`PATCH /api/documents/${WEEKLY_ID}`]: () => json(200, detail({ title: '周报（终稿）' })),
    })
    renderApp('/')
    await openActions('周报')
    fireEvent.click(await screen.findByRole('button', { name: '改名' }))
    fireEvent.change(screen.getByLabelText('周报 的新名称'), { target: { value: '周报（终稿）' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(lastBody(api, `PATCH /api/documents/${WEEKLY_ID}`)).toEqual({ title: '周报（终稿）' }))
    await waitFor(() => expect(screen.queryByLabelText('周报 的新名称')).not.toBeInTheDocument())
  })

  it('移动：先选目标空间、再点进目标文件夹，提交的是 move 接口；做完在列表上方说明它去了哪里', async () => {
    const teamFolders = new URLSearchParams({ spaceId: TEAM_ID })
    const api = loggedIn({
      'GET /api/spaces': () => json(200, { items: [personalSpaceOf(SESSION), TEAM] }),
      [`GET /api/documents/${WEEKLY_ID}`]: () => json(200, detail()),
      [`GET /api/folders?${teamFolders.toString()}`]: folderPage([folder(PLAN_ID, '方案', { spaceId: TEAM_ID })]),
      [foldersKey(TEAM_ID, PLAN_ID)]: noFolders(),
      [`POST /api/documents/${WEEKLY_ID}/move`]: () => json(200, detail({ spaceId: TEAM_ID, folderId: PLAN_ID })),
    })
    renderApp('/')
    await openActions('周报')
    fireEvent.click(await screen.findByRole('button', { name: '移动' }))
    const form = screen.getByRole('form', { name: '移动' })
    // 只有一个候选空间时不出现选择框；这里有两个
    fireEvent.change(within(form).getByLabelText('目标空间'), { target: { value: TEAM_ID } })
    fireEvent.click(await within(form).findByRole('button', { name: '进入 方案' }))
    fireEvent.click(within(form).getByRole('button', { name: '移动到这里' }))
    await waitFor(() => expect(lastBody(api, `POST /api/documents/${WEEKLY_ID}/move`)).toEqual({ spaceId: TEAM_ID, folderId: PLAN_ID }))
    expect(await screen.findByText('已把「周报」移动到市场部 / 方案')).toBeInTheDocument()
  })

  it('移动到它现在待的地方：按钮不可用，并说明原因', async () => {
    loggedIn({ [`GET /api/documents/${WEEKLY_ID}`]: () => json(200, detail()) })
    renderApp('/')
    await openActions('周报')
    fireEvent.click(await screen.findByRole('button', { name: '移动' }))
    const form = screen.getByRole('form', { name: '移动' })
    expect(within(form).getByRole('button', { name: '移动到这里' })).toHaveAttribute('aria-disabled', 'true')
    expect(within(form).getByText('它已经在这里了')).toBeInTheDocument()
  })

  it('复制：复制到选定的位置，说明里给出副本的标题与打开副本的链接', async () => {
    const copy = { ...detail({ id: QUARTER_ID, title: '周报 的副本' }), replayed: false }
    const api = loggedIn({
      [`GET /api/documents/${WEEKLY_ID}`]: () => json(200, detail()),
      [`POST /api/documents/${WEEKLY_ID}/copy`]: () => json(201, copy),
    })
    renderApp('/')
    await openActions('周报')
    fireEvent.click(await screen.findByRole('button', { name: '复制' }))
    fireEvent.click(within(screen.getByRole('form', { name: '复制' })).getByRole('button', { name: '复制到这里' }))
    expect(await screen.findByText('已复制出「周报 的副本」')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '打开副本' })).toHaveAttribute('href', `/documents/${QUARTER_ID}`)
    expect(lastBody(api, `POST /api/documents/${WEEKLY_ID}/copy`)).toMatchObject({ spaceId: SPACE_ID })
  })

  it('删除：进回收站，说明里给出打开回收站的入口', async () => {
    const api = loggedIn({
      [`GET /api/documents/${WEEKLY_ID}`]: () => json(200, detail()),
      [`DELETE /api/documents/${WEEKLY_ID}`]: () => new Response(null, { status: 204 }),
    })
    renderApp('/')
    await openActions('周报')
    fireEvent.click(await screen.findByRole('button', { name: '删除' }))
    expect(await screen.findByText('已把「周报」移到回收站')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '打开回收站' })).toHaveAttribute('href', `/spaces/${SPACE_ID}/trash`)
    expect(api.requests.some(request => request.key === `DELETE /api/documents/${WEEKLY_ID}`)).toBe(true)
  })

  it('复制的 requestId 按"这一次复制"持有：结果未知（5xx）之后重试沿用同一个，确定被拒绝（4xx）之后重试换一个（审查 B1）', async () => {
    const api = loggedIn({
      [`GET /api/documents/${WEEKLY_ID}`]: () => json(200, detail()),
      [`POST /api/documents/${WEEKLY_ID}/copy`]: () => apiError(500, 'INTERNAL_ERROR'),
    })
    renderApp('/')
    await openActions('周报')
    fireEvent.click(await screen.findByRole('button', { name: '复制' }))
    const form = screen.getByRole('form', { name: '复制' })

    // 5xx：结果未知，服务端可能已经复制出来了。再点一次沿用同一个 requestId，不会建出第二份副本
    await copyHere(api, form)
    await copyHere(api, form)
    const [first, second] = copyRequestIds(api)
    expect(second).toBe(first)

    // 4xx：服务端在写入之前就拒绝了，这个 requestId 已经没用了（服务端把它记成了另一次请求）。再点换一个新的
    api.on(`POST /api/documents/${WEEKLY_ID}/copy`, () => apiError(409, 'REQUEST_ID_CONFLICT'))
    await copyHere(api, form)
    await copyHere(api, form)
    const [, , third, fourth] = copyRequestIds(api)
    expect(third).toBe(first)
    expect(fourth).not.toBe(third)
  })

  it('换了目标位置就换一个新的 requestId：重试不会落回旧目标（审查 B1）', async () => {
    const teamFolders = new URLSearchParams({ spaceId: TEAM_ID })
    const api = loggedIn({
      'GET /api/spaces': () => json(200, { items: [personalSpaceOf(SESSION), TEAM] }),
      [`GET /api/documents/${WEEKLY_ID}`]: () => json(200, detail()),
      [`GET /api/folders?${teamFolders.toString()}`]: noFolders(),
      [`POST /api/documents/${WEEKLY_ID}/copy`]: () => apiError(500, 'INTERNAL_ERROR'),
    })
    renderApp('/')
    await openActions('周报')
    fireEvent.click(await screen.findByRole('button', { name: '复制' }))
    const form = screen.getByRole('form', { name: '复制' })
    await copyHere(api, form)

    fireEvent.change(within(form).getByLabelText('目标空间'), { target: { value: TEAM_ID } })
    await copyHere(api, form)
    const [toPersonal, toTeam] = copyRequestIds(api)
    expect(toTeam).not.toBe(toPersonal)
  })

  it('同一个空间里只换了文件夹：requestId 同样换新的（目标位置是"空间加文件夹"，复验 S3）', async () => {
    const api = copyAlwaysUnknown()
    renderApp('/')
    const form = await openCopyForm()
    await copyHere(api, form)

    // 空间没变，只是点进了"方案"：目标位置变了，沿用旧的 requestId 会让重试落回空间的根目录
    fireEvent.click(await within(form).findByRole('button', { name: '进入 方案' }))
    await copyHere(api, form)
    const [toRoot, toPlan] = copyRequestIds(api)
    expect(toPlan).not.toBe(toRoot)
  })

  it('一个位置的结果未知，切去别处再切回来：沿用它原来那一个 requestId，不会在那里多出一份副本（复验 S1）', async () => {
    const api = copyAlwaysUnknown()
    renderApp('/')
    const form = await openCopyForm()
    // 根目录：结果未知（5xx），服务端可能已经复制出来了
    await copyHere(api, form)
    // 切到"方案"再点：那是另一个位置，另一个 requestId
    fireEvent.click(await within(form).findByRole('button', { name: '进入 方案' }))
    await copyHere(api, form)
    // 切回根目录再点：要沿用根目录那一次的 requestId，不能又换一个（换了就可能在根目录下多出一份副本）
    fireEvent.click(within(form).getByRole('button', { name: '上一级' }))
    await copyHere(api, form)

    const [toRoot, toPlan, backToRoot] = copyRequestIds(api)
    expect(toPlan).not.toBe(toRoot)
    expect(backToRoot).toBe(toRoot)
  })

  it('同一个位置连着复制两次：第二次换一个新的 requestId，第二份副本才真的建得出来（复验 S1）', async () => {
    const api = loggedIn({
      [`GET /api/documents/${WEEKLY_ID}`]: () => json(200, detail()),
      [`POST /api/documents/${WEEKLY_ID}/copy`]: () => json(201, { ...detail({ id: QUARTER_ID, title: '周报 的副本' }), replayed: false }),
    })
    renderApp('/')
    for (const round of [1, 2]) {
      await copySucceeds(api, await openCopyForm())
      expect(copyRequestIds(api)).toHaveLength(round)
    }

    // 沿用旧的会被服务端按幂等重放，原样返回第一份副本：界面照样说"已复制"，第二份根本没建出来
    const [first, second] = copyRequestIds(api)
    expect(second).not.toBe(first)
  })

  it('编辑者删文件夹被服务端按子树拒绝：说清楚是因为里面有别人创建的文档；空间刚被归档的 403 用服务端说的原因（审查 B2，M2-P6 复核 S5）', async () => {
    const api = loggedIn({
      [foldersKey(SPACE_ID)]: folderPage([folder(PLAN_ID, '方案')]),
      [`DELETE /api/folders/${PLAN_ID}`]: () => apiError(403, 'FOLDER_HAS_OTHERS_DOCUMENTS'),
    })
    renderApp('/')
    await openActions('方案')
    fireEvent.click(await screen.findByRole('button', { name: '删除' }))
    expect(await screen.findByText('这个文件夹里有别人创建的文档，只有空间管理员能删除')).toBeInTheDocument()

    // 同一个 403 状态的另一种原因（空间刚被归档，自己刚被降为查看者也走它）：不能说成"里面有别人创建的文档"，
    // 也不盖成笼统的"没有权限"：服务端写好了具体原因（ADR-008 的例外）。面板收起，原因写在列表上方
    api.on(`DELETE /api/folders/${PLAN_ID}`, () => apiError(403, 'PERMISSION_DENIED', '空间已归档，只能查看'))
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    expect(await screen.findByText('「方案」的操作没有完成：空间已归档，只能查看')).toBeInTheDocument()
    expect(screen.queryByText('这个文件夹里有别人创建的文档，只有空间管理员能删除')).not.toBeInTheDocument()
    expect(screen.queryByText('你没有执行这个操作的权限')).not.toBeInTheDocument()
  })

  it('移动文件夹时目标位置里不列出它自己（进去了也只能被服务端的 409 拦下，审查建议 6）', async () => {
    loggedIn({
      [foldersKey(SPACE_ID)]: folderPage([folder(PLAN_ID, '方案'), folder(QUARTER_ID, '归档')]),
    })
    renderApp('/')
    await openActions('方案')
    fireEvent.click(await screen.findByRole('button', { name: '移动' }))
    const form = screen.getByRole('form', { name: '移动' })
    expect(await within(form).findByRole('button', { name: '进入 归档' })).toBeInTheDocument()
    expect(within(form).queryByRole('button', { name: '进入 方案' })).not.toBeInTheDocument()
  })

  it('操作被 403 拒绝：连这个空间里的文件夹与文档一起重新请求，过期的权限不会一直留在界面上（审查建议 2）', async () => {
    let permissions = ALL_FOLDER_PERMISSIONS
    loggedIn({
      [foldersKey(SPACE_ID)]: () => json(200, { items: [folder(PLAN_ID, '方案', { permissions })], truncated: false }),
      [`DELETE /api/folders/${PLAN_ID}`]: () => {
        // 空间刚被归档（或者自己刚被降为查看者）：这个人现在一个操作都做不了了
        permissions = { canRename: false, canMoveWithinSpace: false, canMoveAcrossSpaces: false, canDelete: false }
        return apiError(403, 'PERMISSION_DENIED')
      },
    })
    renderApp('/')
    await openActions('方案')
    fireEvent.click(await screen.findByRole('button', { name: '删除' }))
    // 文件夹列表跟着重新请求：那一行还在（只是不能动了），"操作"随新的权限消失
    await waitFor(() => expect(screen.queryByRole('button', { name: '操作 方案' })).not.toBeInTheDocument())
    expect(screen.getByRole('link', { name: '方案' })).toBeInTheDocument()
  })

  it('面板收起、说明条关掉之后焦点回到那一行的"操作"，不落到 body（审查建议 1）', async () => {
    loggedIn({
      [`GET /api/documents/${WEEKLY_ID}`]: () => json(200, detail()),
      [`PATCH /api/documents/${WEEKLY_ID}`]: () => json(200, detail({ title: '周报（终稿）' })),
    })
    renderApp('/')

    // 展开之后点"取消"
    const trigger = await openActionsFrom('周报')
    fireEvent.click(await screen.findByRole('button', { name: '取消' }))
    expect(document.activeElement).toBe(trigger)

    // 改名成功：面板收起，没有说明条
    fireEvent.click(trigger)
    fireEvent.click(await screen.findByRole('button', { name: '改名' }))
    fireEvent.change(screen.getByLabelText('周报 的新名称'), { target: { value: '周报（终稿）' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('说明条先接住焦点；关掉它时那一行还在，焦点还给它的"操作"（审查建议 1）', async () => {
    loggedIn({
      [`GET /api/documents/${WEEKLY_ID}`]: () => json(200, detail()),
      [`POST /api/documents/${WEEKLY_ID}/copy`]: () => json(201, { ...detail({ id: QUARTER_ID, title: '周报 的副本' }), replayed: false }),
    })
    renderApp('/')
    const trigger = await openActionsFrom('周报')
    fireEvent.click(await screen.findByRole('button', { name: '复制' }))
    fireEvent.click(within(screen.getByRole('form', { name: '复制' })).getByRole('button', { name: '复制到这里' }))

    // 复制出来的那一份在别处（说明里给出"打开副本"）：焦点先交给说明条
    const notice = await screen.findByText('已复制出「周报 的副本」')
    const alert = notice.closest('[tabindex="-1"]')
    await waitFor(() => expect(document.activeElement).toBe(alert))
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(document.activeElement).toBe(trigger)
  })

  it('查看者：没有新建文件夹，文件夹那一行也没有"操作"', async () => {
    const viewer: SpaceView = { ...TEAM, role: 'viewer', permissions: { ...TEAM.permissions, canCreateDocuments: false, canCreateFolders: false, canPurgeTrash: false } }
    const teamDocs = new URLSearchParams({ spaceId: TEAM_ID })
    loggedIn({
      'GET /api/spaces': () => json(200, { items: [personalSpaceOf(SESSION), viewer] }),
      [`GET /api/spaces/${TEAM_ID}`]: () => json(200, viewer),
      [`GET /api/documents?${teamDocs.toString()}`]: () => json(200, { items: [WEEKLY], nextCursor: null }),
      [foldersKey(TEAM_ID)]: folderPage([folder(PLAN_ID, '方案', {
        spaceId: TEAM_ID,
        permissions: { canRename: false, canMoveWithinSpace: false, canMoveAcrossSpaces: false, canDelete: false },
      })]),
    })
    renderApp(`/spaces/${TEAM_ID}`)
    expect(await screen.findByRole('link', { name: '方案' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '新建文件夹' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '操作 方案' })).not.toBeInTheDocument()
    // 回收站的列表看得到（能不能动由每一条的权限决定）
    expect(screen.getByRole('link', { name: '回收站' })).toHaveAttribute('href', `/spaces/${TEAM_ID}/trash`)
  })
})
