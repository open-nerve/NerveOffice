// 写操作的结果未知（以及之后的拒绝说明上一次多半已经生效）之后的刷新，各流程都走共用的做法（M2-P6 复核第四批，shared/api/write-outcome.ts）：
// 创建团队空间、签发与重新生成邀请、管理界面的加入空间、成员页的添加成员、新建表格与文件夹、整理面板的改名、复制、移动与删除、
// 回收站的恢复、转移之后的冲突。每个流程都看两件事：刷新失败时说明"列表没能刷新"，不说"已刷新"；刷新一直不回来时最多等 10 秒，
// 到了时限先给出说明，按钮与弹窗不一直停在"正在…"。接口用假的 fetch；计时器是假的（跟着真实的时间走，另外可以一下子拨过时限）。
import type { AdminSpace, DocumentDetail, DocumentSummary, Folder, SessionResponse, SpaceMember, SpaceView, TrashEntry } from '@nerve-office/contracts'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OUTCOME_REFRESH_TIME_LIMIT_MS } from '../shared/api/write-outcome.ts'
import { apiError, installFakeApi, inTurn, json, networkFailure } from '../shared/testing/fake-api.test-support.ts'
import { documentsKey, foldersKey, noFolders, personalSpaceOf, spaceRoutes } from '../shared/testing/spaces.test-support.ts'
import { AMY, INVITATION, listPage, rowOf, session, SPACES } from './admin.test-support.ts'
import { renderApp } from './render-app.test-support.tsx'

/** 刷新失败或者到了时限还没回来时，说明里的那一句（不说"已刷新"） */
const NOT_REFRESHED = '列表没能刷新，显示的可能还是之前的，请稍后再看'
const NETWORK = '网络连接失败，请检查网络后重试'
const SERVER = '服务器出了点问题，请稍后重试'

type ListState = 'ok' | 'fail' | 'hang'

/** 列表接口：照常返回、失败（断网；查询会重试一次）或者一直不回来（服务端挂起），由用例在写操作之前切换 */
function listEndpoint(ok: () => Response) {
  let state: ListState = 'ok'
  let calls = 0
  return {
    handler: async (): Promise<Response> => {
      calls += 1
      if (state === 'fail')
        return networkFailure()
      return state === 'hang' ? new Promise<Response>(() => {}) : ok()
    },
    set: (next: ListState): void => {
      state = next
    },
    calls: (): number => calls,
  }
}

type ListEndpoint = ReturnType<typeof listEndpoint>

/** 拨过一段时间：到期的计时器（查询的重试、刷新的时限）随之触发，React 的更新随之完成 */
async function advance(ms: number): Promise<void> {
  await act(async () => vi.advanceTimersByTimeAsync(ms))
}

/** 写操作之后的刷新失败：等它发出（第一次失败），再拨过查询重试的 1 秒，等重试也发出（同样失败） */
async function refreshFails(list: ListEndpoint, before: number): Promise<void> {
  await waitFor(() => expect(list.calls()).toBeGreaterThan(before))
  await advance(1_000)
  // 慢的机器上重试的计时器可能在拨动之后才排上：计时器跟着真实的时间走，多等一会儿也会触发
  await waitFor(() => expect(list.calls()).toBeGreaterThan(before + 1), { timeout: 3_000 })
}

/** 写操作之后的刷新一直不回来：等它发出，再拨到时限之前 2 秒（留出余量，测试本身的耗时不会让时限提前到），这时仍在等 */
async function refreshHangs(list: ListEndpoint, before: number): Promise<void> {
  await waitFor(() => expect(list.calls()).toBeGreaterThan(before))
  await advance(OUTCOME_REFRESH_TIME_LIMIT_MS - 2_000)
}

/** 拨过时限：先给出说明，刷新在后台继续 */
async function passTimeLimit(): Promise<void> {
  await advance(2_000)
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
})

function admin(handlers: Parameters<typeof installFakeApi>[0]) {
  return installFakeApi({ ...SPACES, 'GET /api/auth/session': () => json(200, session('admin')), ...handlers })
}

const BEN = { id: '0199a2c4-0000-7000-8000-00000000000b', username: 'ben', displayName: '本' }
const TEAM_ID = '0199a2c4-0000-7000-8000-0000000000c1'
const BEN_SEARCH = `GET /api/users?${new URLSearchParams({ query: '本' }).toString()}`

describe('管理界面：结果未知之后的刷新（第四批）', () => {
  it('创建团队空间：刷新失败时说明列表没能刷新；再创建得到"已有同名"、刷新一直不回来，到了时限先说明，按钮不一直停在"正在创建…"', async () => {
    const list = listEndpoint(() => json(200, listPage([])))
    admin({
      'GET /api/admin/spaces': list.handler,
      [BEN_SEARCH]: () => json(200, { items: [BEN] }),
      'POST /api/admin/spaces': inTurn(networkFailure, () => apiError(409, 'SPACE_NAME_TAKEN')),
    })
    renderApp('/admin/spaces')
    const form = await screen.findByRole('form', { name: '创建团队空间' })
    await screen.findByText('没有符合条件的团队空间')
    fireEvent.change(within(form).getByLabelText('首个空间管理员'), { target: { value: '本' } })
    fireEvent.click(await within(form).findByRole('button', { name: '@ben 本' }))
    fireEvent.change(within(form).getByLabelText('名称'), { target: { value: '市场部' } })

    list.set('fail')
    const first = list.calls()
    fireEvent.click(within(form).getByRole('button', { name: '创建团队空间' }))
    await refreshFails(list, first)
    expect(await within(form).findByText(`没能确认团队空间是否已经创建（${NETWORK}）。${NOT_REFRESHED}：下面的列表里有它，就是已经建好了。`)).toBeInTheDocument()

    list.set('hang')
    const before = list.calls()
    fireEvent.click(within(form).getByRole('button', { name: '创建团队空间' }))
    await refreshHangs(list, before)
    expect(within(form).getByRole('button', { name: '正在创建…' })).toBeInTheDocument()
    await passTimeLimit()
    expect(await within(form).findByText(`已有同名的团队空间，可能就是刚才没能确认的那一次创建。${NOT_REFRESHED}：在下面的列表里找找它。`)).toBeInTheDocument()
    expect(within(form).getByRole('button', { name: '创建团队空间' })).toHaveAttribute('aria-disabled', 'false')
  })

  it('签发邀请：刷新失败时说明列表没能刷新；同一个登录名再签发得到"已被占用"、刷新一直不回来，到了时限先说明，按钮不一直停在"正在生成…"', async () => {
    const list = listEndpoint(() => json(200, listPage([])))
    admin({
      'GET /api/admin/invitations': list.handler,
      'POST /api/admin/invitations': inTurn(networkFailure, () => apiError(409, 'USERNAME_TAKEN')),
    })
    renderApp('/admin/invitations')
    await screen.findByText('还没有邀请')
    fireEvent.change(screen.getByLabelText('登录名'), { target: { value: 'amy' } })
    fireEvent.change(screen.getByLabelText('显示名'), { target: { value: '艾米' } })

    list.set('fail')
    const first = list.calls()
    fireEvent.click(screen.getByRole('button', { name: '生成邀请链接' }))
    await refreshFails(list, first)
    expect(await screen.findByText(`没能确认邀请是否已经生成（${NETWORK}）。如果已经生成，链接不能再次显示。${NOT_REFRESHED}：在下面的列表里找到这个登录名，点"重新生成"得到新的链接（原来的随即作废）；列表里没有时，可以再生成一次。`)).toBeInTheDocument()

    list.set('hang')
    const before = list.calls()
    fireEvent.click(screen.getByRole('button', { name: '生成邀请链接' }))
    await refreshHangs(list, before)
    expect(screen.getByRole('button', { name: '正在生成…' })).toBeInTheDocument()
    await passTimeLimit()
    expect(await screen.findByText(`这个登录名已有待接受的邀请，可能就是刚才没能确认的那一次。链接不能再次显示。${NOT_REFRESHED}：在下面的列表里找到它，点"重新生成"。`)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '生成邀请链接' })).toHaveAttribute('aria-disabled', 'false')
  })

  it('重新生成邀请：刷新失败时说明列表没能刷新；再点得到"已被占用"、刷新一直不回来，到了时限先说明，弹窗不一直停在"正在处理…"', async () => {
    const list = listEndpoint(() => json(200, listPage([INVITATION])))
    admin({
      'GET /api/admin/invitations': list.handler,
      [`POST /api/admin/invitations/${INVITATION.id}/reissue`]: inTurn(() => apiError(500, 'INTERNAL_ERROR'), () => apiError(409, 'USERNAME_TAKEN')),
    })
    renderApp('/admin/invitations')
    fireEvent.click(within(await rowOf('bea')).getByRole('button', { name: '重新生成 bea' }))
    const dialog = await screen.findByRole('dialog')

    list.set('fail')
    const before = list.calls()
    fireEvent.click(within(dialog).getByRole('button', { name: '重新生成' }))
    await refreshFails(list, before)
    expect(await within(dialog).findByText(`没能确认邀请链接是否已经重新生成（${SERVER}）。如果已经生成，原来的链接已经作废，新的链接不能再次显示。${NOT_REFRESHED}：找到这个登录名最新的那一条，再点"重新生成"。`)).toBeInTheDocument()

    list.set('hang')
    const again = list.calls()
    fireEvent.click(within(dialog).getByRole('button', { name: '重新生成' }))
    await refreshHangs(list, again)
    expect(within(dialog).getByRole('button', { name: '正在处理…' })).toBeInTheDocument()
    await passTimeLimit()
    expect(await within(dialog).findByText(`这个登录名已有待接受的邀请，可能就是刚才没能确认的那一次重新生成。链接不能再次显示。${NOT_REFRESHED}：找到最新的那一条，再点"重新生成"。`)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('加入空间：刷新失败时说明列表没能刷新；再加入得到"已经是成员"、刷新一直不回来，到了时限先说明，弹窗不一直停在"正在处理…"', async () => {
    const space: AdminSpace = { id: TEAM_ID, name: '市场部', status: 'active', visibleToAll: false, memberCount: 3, createdAt: '2026-09-29T01:00:00.000Z', myRole: null }
    const list = listEndpoint(() => json(200, listPage([space])))
    admin({
      'GET /api/admin/spaces': list.handler,
      [`POST /api/spaces/${TEAM_ID}/members`]: inTurn(() => apiError(500, 'INTERNAL_ERROR'), () => apiError(409, 'ALREADY_MEMBER')),
    })
    renderApp('/admin/spaces')
    fireEvent.click(within(await rowOf('市场部')).getByRole('button', { name: '加入空间 市场部' }))
    const dialog = await screen.findByRole('dialog', { name: '加入 市场部' })

    list.set('fail')
    const before = list.calls()
    fireEvent.click(within(dialog).getByRole('button', { name: '加入空间' }))
    await refreshFails(list, before)
    expect(await within(dialog).findByText(`没能确认是否已经加入（${SERVER}）。${NOT_REFRESHED}：这个空间的"我的角色"不再是"没有加入"，就是已经加入了。`)).toBeInTheDocument()

    list.set('hang')
    const again = list.calls()
    fireEvent.click(within(dialog).getByRole('button', { name: '加入空间' }))
    await refreshHangs(list, again)
    expect(within(dialog).getByRole('button', { name: '正在处理…' })).toBeInTheDocument()
    await passTimeLimit()
    expect(await within(dialog).findByText(`你已经是这个空间的成员了，可能就是刚才没能确认的那一次加入。${NOT_REFRESHED}。`)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('转移之后的冲突：刷新标题列表一直不回来时同样最多等 10 秒，弹窗留着说明原因，不一直停在"正在处理…"', async () => {
    const leaver = { ...AMY, status: 'disabled' as const }
    const list = listEndpoint(() => json(200, listPage([{ id: '0199a2c4-0000-7000-8000-000000000101', title: '交接清单', type: 'sheet', updatedAt: '2026-09-29T01:00:00.000Z' }])))
    admin({
      [`GET /api/admin/users/${AMY.id}`]: () => json(200, leaver),
      [`GET /api/admin/users/${AMY.id}/documents`]: list.handler,
      [`GET /api/admin/spaces?${new URLSearchParams({ query: '市场', status: 'active' }).toString()}`]: () => json(200, listPage([{ id: TEAM_ID, name: '市场部', status: 'active', visibleToAll: false, memberCount: 3, createdAt: '2026-09-29T01:00:00.000Z', myRole: null }])),
      [`POST /api/admin/users/${AMY.id}/documents/transfer`]: () => apiError(409, 'TRANSFER_CONFLICT'),
    })
    renderApp(`/admin/users/${AMY.id}/documents`)
    fireEvent.click(await screen.findByLabelText('全选已加载的文档'))
    fireEvent.change(screen.getByLabelText('目标团队空间'), { target: { value: '市场' } })
    fireEvent.click(await screen.findByRole('button', { name: '市场部' }))
    fireEvent.click(screen.getByRole('button', { name: '转移' }))
    const dialog = await screen.findByRole('dialog', { name: '把 1 份文档转移到 市场部？' })
    list.set('hang')
    const before = list.calls()
    fireEvent.click(within(dialog).getByRole('button', { name: '转移' }))
    await refreshHangs(list, before)
    expect(within(dialog).getByRole('button', { name: '正在处理…' })).toBeInTheDocument()
    await passTimeLimit()
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('有文档已经不在这个人的个人空间里（可能被别人转走了），请刷新后重试')
    expect(within(dialog).getByRole('button', { name: '转移' })).toHaveAttribute('aria-disabled', 'false')
  })
})

const MEMBER_SESSION: SessionResponse = {
  user: { id: '0199a2c4-0000-7000-8000-00000000000a', username: 'amy', displayName: '艾米', systemRole: 'member' },
  personalSpace: { id: '0199a2c4-0000-7000-8000-0000000000a1', name: '艾米' },
  csrfToken: 'csrf-1',
  features: { localDraftsEnabled: true },
}

describe('成员页：添加成员之后的刷新（第四批）', () => {
  const manager: SpaceView = {
    id: TEAM_ID,
    type: 'team',
    name: '市场部',
    status: 'active',
    visibleToAll: false,
    role: 'admin',
    permissions: { canCreateDocuments: true, canCreateFolders: true, canViewMembers: true, canManageMembers: true, canRename: true, canPurgeTrash: true },
  }
  const self: SpaceMember = { user: MEMBER_SESSION.user, role: 'admin', status: 'active', createdAt: '2026-09-29T01:00:00.000Z' }

  it('刷新失败时说明成员列表没能刷新；再添加得到"已经是成员"、刷新一直不回来，到了时限先说明，按钮不一直停在"正在添加…"', async () => {
    const list = listEndpoint(() => json(200, { space: { id: TEAM_ID, name: '市场部', status: 'active', visibleToAll: false }, canManage: true, items: [self] }))
    installFakeApi({
      'GET /api/auth/session': () => json(200, MEMBER_SESSION),
      ...spaceRoutes(MEMBER_SESSION, [manager]),
      [`GET /api/spaces/${TEAM_ID}/members`]: list.handler,
      [BEN_SEARCH]: () => json(200, { items: [BEN] }),
      [`POST /api/spaces/${TEAM_ID}/members`]: inTurn(() => apiError(500, 'INTERNAL_ERROR'), () => apiError(409, 'ALREADY_MEMBER')),
    })
    renderApp(`/spaces/${TEAM_ID}/members`)
    fireEvent.change(await screen.findByLabelText('要添加的同事'), { target: { value: '本' } })
    fireEvent.click(await screen.findByRole('button', { name: '@ben 本' }))

    list.set('fail')
    const before = list.calls()
    fireEvent.click(screen.getByRole('button', { name: '添加成员' }))
    await refreshFails(list, before)
    expect(await screen.findByText(`没能确认是否已经添加（${SERVER}）。成员${NOT_REFRESHED}：这个人在列表里，就是已经加好了。`)).toBeInTheDocument()

    list.set('hang')
    const again = list.calls()
    fireEvent.click(screen.getByRole('button', { name: '添加成员' }))
    await refreshHangs(list, again)
    expect(screen.getByRole('button', { name: '正在添加…' })).toBeInTheDocument()
    await passTimeLimit()
    expect(await screen.findByText(`这个人已经是空间的成员了（可能就是刚才没能确认的那一次添加），成员${NOT_REFRESHED}。`)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '添加成员' })).toBeInTheDocument()
  })
})

const SPACE_ID = MEMBER_SESSION.personalSpace.id
const PLAN_ID = '0199a2c4-0000-7000-8000-0000000000f1'
const WEEKLY_ID = '0199a2c4-0000-7000-8000-0000000000d1'
const WEEKLY: DocumentSummary = { id: WEEKLY_ID, title: '周报', type: 'sheet', createdAt: '2026-09-29T01:00:00.000Z', updatedAt: '2026-09-29T02:00:00.000Z' }

function detail(): DocumentDetail {
  return {
    ...WEEKLY,
    spaceId: SPACE_ID,
    space: { id: SPACE_ID, type: 'personal' },
    folderId: null,
    accessVia: 'space',
    revision: 1,
    profile: 'sheet@1',
    formatVersion: 1,
    sdkVersion: '1.0.1',
    formulasPending: false,
    permissions: { canEdit: true, canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: true, canCopy: true, canDelete: true, canShare: true, canTakeOver: true },
  }
}

function plan(): Folder {
  return {
    id: PLAN_ID,
    spaceId: SPACE_ID,
    parentId: null,
    name: '方案',
    depth: 1,
    createdAt: '2026-09-29T01:00:00.000Z',
    updatedAt: '2026-09-29T01:00:00.000Z',
    permissions: { canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: true, canDelete: true },
  }
}

/** 我的空间：根目录下的文档列表由用例给出（可以切到失败或挂起），另有这份文档的元数据 */
function home(documents: ListEndpoint, handlers: Parameters<typeof installFakeApi>[0] = {}) {
  return installFakeApi({
    'GET /api/auth/session': () => json(200, MEMBER_SESSION),
    ...spaceRoutes(MEMBER_SESSION),
    [documentsKey(MEMBER_SESSION)]: documents.handler,
    [`GET /api/documents/${WEEKLY_ID}`]: () => json(200, detail()),
    ...handlers,
  })
}

async function openActions(name: string): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: `操作 ${name}` }))
}

describe('空间页：新建与整理之后的刷新（第四批）', () => {
  it('新建表格：刷新失败时说明列表没能刷新；再点得到 REQUEST_ID_CONFLICT（上一次已经建好）、刷新一直不回来，到了时限先说明，按钮不一直停在"正在新建…"', async () => {
    const documents = listEndpoint(() => json(200, { items: [], nextCursor: null }))
    home(documents, { 'POST /api/documents': inTurn(networkFailure, () => apiError(409, 'REQUEST_ID_CONFLICT')) })
    renderApp('/')
    await screen.findByText('这里还没有文档')

    documents.set('fail')
    const before = documents.calls()
    fireEvent.click(screen.getByRole('button', { name: '新建表格' }))
    await refreshFails(documents, before)
    expect(await screen.findByText(`没能确认表格是否已经建好（${NETWORK}）。${NOT_REFRESHED}；再点"新建表格"不会重复新建。`)).toBeInTheDocument()

    documents.set('hang')
    const again = documents.calls()
    fireEvent.click(screen.getByRole('button', { name: '新建表格' }))
    await refreshHangs(documents, again)
    expect(screen.getByRole('button', { name: '正在新建…' })).toBeInTheDocument()
    await passTimeLimit()
    expect(await screen.findByText(`上一次新建可能已经建好（当时没能确认结果），${NOT_REFRESHED}：先在列表里找找它；还要另建一份时再点"新建表格"。`)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新建表格' })).toHaveAttribute('aria-disabled', 'false')
  })

  it('新建文件夹：刷新失败时说明列表没能刷新；改了名再提交得到 REQUEST_ID_CONFLICT、刷新一直不回来，到了时限先说明，表单不一直停在"正在新建…"', async () => {
    const documents = listEndpoint(() => json(200, { items: [], nextCursor: null }))
    const folders = listEndpoint(() => json(200, { items: [], truncated: false }))
    home(documents, {
      [foldersKey(SPACE_ID)]: folders.handler,
      'POST /api/folders': inTurn(networkFailure, () => apiError(409, 'REQUEST_ID_CONFLICT')),
    })
    renderApp('/')
    fireEvent.click(await screen.findByRole('button', { name: '新建文件夹' }))
    const form = screen.getByRole('form', { name: '新建文件夹' })
    fireEvent.change(within(form).getByLabelText('文件夹名称'), { target: { value: '方案' } })

    folders.set('fail')
    const before = folders.calls()
    fireEvent.click(within(form).getByRole('button', { name: '新建文件夹' }))
    await refreshFails(folders, before)
    expect(await within(form).findByText(`没能确认文件夹是否已经建好（${NETWORK}）。${NOT_REFRESHED}；原样再提交一次不会重复新建。`)).toBeInTheDocument()

    fireEvent.change(within(form).getByLabelText('文件夹名称'), { target: { value: '方案二' } })
    folders.set('hang')
    const again = folders.calls()
    fireEvent.click(within(form).getByRole('button', { name: '新建文件夹' }))
    await refreshHangs(folders, again)
    expect(within(form).getByRole('button', { name: '正在新建…' })).toBeInTheDocument()
    await passTimeLimit()
    expect(await within(form).findByText(`上一次新建可能已经建好（当时没能确认结果），${NOT_REFRESHED}：先看看列表里是否已经有它；还要另建时再提交一次。`)).toBeInTheDocument()
    expect(within(form).getByRole('button', { name: '新建文件夹' })).toHaveAttribute('aria-disabled', 'false')
  })

  it('改名的结果未知、刷新失败：面板里说明列表没能刷新，可以再保存一次', async () => {
    const documents = listEndpoint(() => json(200, { items: [WEEKLY], nextCursor: null }))
    home(documents, { [`PATCH /api/documents/${WEEKLY_ID}`]: () => networkFailure() })
    renderApp('/')
    await openActions('周报')
    fireEvent.click(await screen.findByRole('button', { name: '改名' }))
    fireEvent.change(screen.getByLabelText('周报 的新名称'), { target: { value: '周报（终稿）' } })
    documents.set('fail')
    const before = documents.calls()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await refreshFails(documents, before)
    expect(await screen.findByText(`没能确认是否已经改好（${NETWORK}）。${NOT_REFRESHED}；可以再保存一次。`)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存' })).toHaveAttribute('aria-disabled', 'false')
  })

  it('删除的结果未知、刷新一直不回来：到了时限先在列表上方说明（列表没能刷新），不一直停在"正在删除…"', async () => {
    const documents = listEndpoint(() => json(200, { items: [WEEKLY], nextCursor: null }))
    home(documents, { [`DELETE /api/documents/${WEEKLY_ID}`]: () => apiError(500, 'INTERNAL_ERROR') })
    renderApp('/')
    await openActions('周报')
    const remove = await screen.findByRole('button', { name: '删除' })
    documents.set('hang')
    const before = documents.calls()
    fireEvent.click(remove)
    await refreshHangs(documents, before)
    expect(screen.getByRole('button', { name: '正在删除…' })).toBeInTheDocument()
    await passTimeLimit()
    expect(await screen.findByText(`没能确认「周报」是否已经删除（${SERVER}）。${NOT_REFRESHED}：它已经不在这里，就是已经移到回收站了；还在的话可以再删除一次。`)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '正在删除…' })).toBeNull()
  })

  it('删除文件夹的结果未知、刷新失败：列表上方说明列表没能刷新（文件夹那一行的面板同样走共用的做法）', async () => {
    const documents = listEndpoint(() => json(200, { items: [], nextCursor: null }))
    const folders = listEndpoint(() => json(200, { items: [plan()], truncated: false }))
    home(documents, {
      [foldersKey(SPACE_ID)]: folders.handler,
      [`DELETE /api/folders/${PLAN_ID}`]: () => apiError(502, 'INTERNAL_ERROR'),
    })
    renderApp('/')
    await openActions('方案')
    const remove = await screen.findByRole('button', { name: '删除' })
    folders.set('fail')
    const before = folders.calls()
    fireEvent.click(remove)
    await refreshFails(folders, before)
    expect(await screen.findByText(`没能确认「方案」是否已经删除（${SERVER}）。${NOT_REFRESHED}：它已经不在这里，就是已经移到回收站了；还在的话可以再删除一次。`)).toBeInTheDocument()
  })

  it('移动的结果未知、刷新失败：列表上方说明列表没能刷新', async () => {
    const documents = listEndpoint(() => json(200, { items: [WEEKLY], nextCursor: null }))
    home(documents, {
      [foldersKey(SPACE_ID)]: () => json(200, { items: [plan()], truncated: false }),
      [foldersKey(SPACE_ID, PLAN_ID)]: noFolders(),
      [`POST /api/documents/${WEEKLY_ID}/move`]: () => networkFailure(),
    })
    renderApp('/')
    await openActions('周报')
    fireEvent.click(await screen.findByRole('button', { name: '移动' }))
    const form = screen.getByRole('form', { name: '移动' })
    fireEvent.click(await within(form).findByRole('button', { name: '进入 方案' }))
    documents.set('fail')
    const before = documents.calls()
    fireEvent.click(within(form).getByRole('button', { name: '移动到这里' }))
    await refreshFails(documents, before)
    expect(await screen.findByText(`没能确认「周报」是否已经移动（${NETWORK}）。${NOT_REFRESHED}：它已经不在这里，就是移走了；还在的话可以再移动一次。`)).toBeInTheDocument()
  })

  it('复制：结果未知之后再复制得到 REQUEST_ID_CONFLICT（上一次已经完成）、刷新一直不回来：到了时限先在面板里说明列表没能刷新，不一直停在"正在复制…"', async () => {
    const documents = listEndpoint(() => json(200, { items: [WEEKLY], nextCursor: null }))
    home(documents, { [`POST /api/documents/${WEEKLY_ID}/copy`]: inTurn(() => apiError(500, 'INTERNAL_ERROR'), () => apiError(409, 'REQUEST_ID_CONFLICT')) })
    renderApp('/')
    await openActions('周报')
    fireEvent.click(await screen.findByRole('button', { name: '复制' }))
    const form = screen.getByRole('form', { name: '复制' })
    fireEvent.click(within(form).getByRole('button', { name: '复制到这里' }))
    expect(await within(form).findByText(`没能确认是否已经复制（${SERVER}）。再点一次不会重复复制。`)).toBeInTheDocument()

    documents.set('hang')
    const before = documents.calls()
    fireEvent.click(within(form).getByRole('button', { name: '复制到这里' }))
    await refreshHangs(documents, before)
    expect(within(form).getByRole('button', { name: '正在复制…' })).toBeInTheDocument()
    await passTimeLimit()
    expect(await within(form).findByText(`上一次复制可能已经完成（当时没能确认结果），${NOT_REFRESHED}：先到目标位置看看；还要再复制一份时再点一次。`)).toBeInTheDocument()
    expect(within(form).getByRole('button', { name: '复制到这里' })).toHaveAttribute('aria-disabled', 'false')
  })
})

describe('回收站：恢复之后的刷新（第四批）', () => {
  const entryId = '0199a2c4-0000-7000-8000-0000000000e1'
  const entry: TrashEntry = {
    id: entryId,
    spaceId: SPACE_ID,
    kind: 'folder',
    title: '方案',
    deletedBy: { id: MEMBER_SESSION.user.id, username: 'amy', displayName: '艾米' },
    deletedAt: '2026-09-29T02:00:00.000Z',
    expiresAt: '2026-10-29T02:00:00.000Z',
    origin: { parentId: null, parentName: null, available: true },
    documentCount: 3,
    permissions: { canRestore: true, canPurge: true },
  }

  it('结果未知、刷新失败：说明列表没能刷新；再恢复、刷新一直不回来：到了时限先说明，"恢复"不一直停在"正在恢复…"', async () => {
    const trash = listEndpoint(() => json(200, { items: [entry], nextCursor: null }))
    installFakeApi({
      'GET /api/auth/session': () => json(200, MEMBER_SESSION),
      ...spaceRoutes(MEMBER_SESSION),
      [`GET /api/spaces/${SPACE_ID}`]: () => json(200, personalSpaceOf(MEMBER_SESSION)),
      [`GET /api/trash?${new URLSearchParams({ spaceId: SPACE_ID }).toString()}`]: trash.handler,
      [`POST /api/trash/${entryId}/restore`]: () => networkFailure(),
    })
    renderApp(`/spaces/${SPACE_ID}/trash`)
    const restore = await screen.findByRole('button', { name: '恢复 方案' })
    const text = `没能确认「方案」是否已经恢复（${NETWORK}）。${NOT_REFRESHED}：它已经不在回收站里，就是恢复好了。`

    trash.set('fail')
    const before = trash.calls()
    fireEvent.click(restore)
    await refreshFails(trash, before)
    expect(await screen.findByText(text)).toBeInTheDocument()

    trash.set('hang')
    const again = trash.calls()
    fireEvent.click(screen.getByRole('button', { name: '恢复 方案' }))
    await refreshHangs(trash, again)
    expect(screen.getByRole('button', { name: '恢复 方案' })).toHaveTextContent('正在恢复…')
    await passTimeLimit()
    await waitFor(() => expect(screen.getByRole('button', { name: '恢复 方案' })).toHaveTextContent(/^恢复$/))
    expect(screen.getByText(text)).toBeInTheDocument()
  })
})
