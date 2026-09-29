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
    space: { id: SPACE_ID, type: 'personal', name: '艾米' },
    folderId: null,
    revision: 1,
    profile: 'sheet@1',
    formatVersion: 1,
    permissions: { canEdit: true, canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: true, canCopy: true, canDelete: true },
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
    expect(await screen.findByText(/新建文件夹失败/)).toBeInTheDocument()
    const first = lastBody(api, 'POST /api/folders') as { requestId: string, parentId: string, name: string, spaceId: string }
    expect(first).toMatchObject({ spaceId: SPACE_ID, parentId: PLAN_ID, name: '二季度' })

    // 重试沿用同一个 requestId：服务端只建一个
    api.on('POST /api/folders', () => json(201, folder(QUARTER_ID, '二季度', { parentId: PLAN_ID, depth: 2 })))
    fireEvent.click(within(form).getByRole('button', { name: '新建文件夹' }))
    await waitFor(() => expect(screen.queryByRole('form', { name: '新建文件夹' })).not.toBeInTheDocument())
    expect((lastBody(api, 'POST /api/folders') as { requestId: string }).requestId).toBe(first.requestId)
  })
})

describe('US-M2-07 行内的整理操作', () => {
  it('文档的操作面板按服务端给的权限显示：查看者只有复制，没有改名、移动、删除', async () => {
    loggedIn({
      [`GET /api/documents/${WEEKLY_ID}`]: () => json(200, detail({
        permissions: { canEdit: false, canRename: false, canMoveWithinSpace: false, canMoveAcrossSpaces: false, canCopy: true, canDelete: false },
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
    const copy = detail({ id: QUARTER_ID, title: '周报 的副本' })
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

  it('编辑者删文件夹被服务端按子树拒绝（403）：说清楚是因为里面有别人创建的文档', async () => {
    loggedIn({
      [foldersKey(SPACE_ID)]: folderPage([folder(PLAN_ID, '方案')]),
      [`DELETE /api/folders/${PLAN_ID}`]: () => apiError(403, 'PERMISSION_DENIED'),
    })
    renderApp('/')
    await openActions('方案')
    fireEvent.click(await screen.findByRole('button', { name: '删除' }))
    expect(await screen.findByText('这个文件夹里有别人创建的文档，只有空间管理员能删除它')).toBeInTheDocument()
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
