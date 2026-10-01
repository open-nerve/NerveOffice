// 整理操作没能顺利完成时（M2-P6 复核 M1、S1–S5、G1、G2，以及 M3 的单元部分）：带 requestId 的新建在结果未知之后的规则、
// 结果未知与被拒绝之后刷新与说明、焦点不落到 body、输入不合法时的文字说明、浏览器标签页的标题；源与目标不同的整理请求。
// 接口用假的 fetch。
import type { DocumentDetail, DocumentSummary, Folder, SessionResponse, SpaceView } from '@nerve-office/contracts'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { apiError, installFakeApi, json, networkFailure } from '../shared/testing/fake-api.test-support.ts'
import { documentsKey, foldersKey, noFolders, personalSpaceOf, spaceRoutes } from '../shared/testing/spaces.test-support.ts'
import { settle } from './admin.test-support.ts'
import { renderApp } from './render-app.test-support.tsx'

const SESSION: SessionResponse = {
  user: { id: '0199a2c4-0000-7000-8000-00000000000a', username: 'amy', displayName: '艾米', systemRole: 'member' },
  personalSpace: { id: '0199a2c4-0000-7000-8000-0000000000a1', name: '艾米' },
  csrfToken: 'csrf-1',
}

const SPACE_ID = SESSION.personalSpace.id
const TEAM_ID = '0199a2c4-0000-7000-8000-0000000000c1'
const PLAN_ID = '0199a2c4-0000-7000-8000-0000000000f1'
const QUARTER_ID = '0199a2c4-0000-7000-8000-0000000000f2'
const ARCHIVE_ID = '0199a2c4-0000-7000-8000-0000000000f3'
const WEEKLY_ID = '0199a2c4-0000-7000-8000-0000000000d1'
const NEW_ID = '0199a2c4-0000-7000-8000-0000000000d9'

const ALL_FOLDER_PERMISSIONS = { canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: true, canDelete: true }
const NO_FOLDER_PERMISSIONS = { canRename: false, canMoveWithinSpace: false, canMoveAcrossSpaces: false, canDelete: false }

function folder(id: string, name: string, changes: Partial<Folder> = {}): Folder {
  return { id, spaceId: SPACE_ID, parentId: null, name, depth: 1, createdAt: '2026-09-29T01:00:00.000Z', updatedAt: '2026-09-29T01:00:00.000Z', permissions: ALL_FOLDER_PERMISSIONS, ...changes }
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

function loggedIn(handlers: Parameters<typeof installFakeApi>[0] = {}) {
  return installFakeApi({
    'GET /api/auth/session': () => json(200, SESSION),
    ...spaceRoutes(SESSION),
    [documentsKey(SESSION)]: () => json(200, { items: [WEEKLY], nextCursor: null }),
    ...handlers,
  })
}

function documentsIn(spaceId: string, folderId: string, items: readonly DocumentSummary[]) {
  const query = new URLSearchParams({ spaceId, folderId })
  return { [`GET /api/documents?${query.toString()}`]: () => json(200, { items, nextCursor: null }) }
}

function bodies(api: ReturnType<typeof installFakeApi>, key: string): unknown[] {
  return api.requests.filter(request => request.key === key).map(request => request.body)
}

function requestIds(api: ReturnType<typeof installFakeApi>, key: string): string[] {
  return bodies(api, key).map(body => (body as { requestId: string }).requestId)
}

function count(api: ReturnType<typeof installFakeApi>, key: string): number {
  return api.requests.filter(request => request.key === key).length
}

async function openActions(name: string): Promise<HTMLElement> {
  const trigger = await screen.findByRole('button', { name: `操作 ${name}` })
  trigger.focus()
  fireEvent.click(trigger)
  return trigger
}

/** 页面的标题（h1）：关掉说明、按钮随新的权限消失之后焦点交给它 */
function pageTitle(): HTMLElement {
  return screen.getByRole('heading', { level: 1 })
}

/** 有焦点的说明条（tabIndex -1） */
function noticeOf(text: string): HTMLElement {
  return screen.getByText(text).closest('[tabindex="-1"]') as HTMLElement
}

describe('M2-P6 复核 M1：带 requestId 的新建在结果未知之后', () => {
  it('新建文件夹：结果未知之后改了名字再提交得到 REQUEST_ID_CONFLICT——说明上一次可能已经建好、列表刷新、requestId 换新，再提交就建这个新名字（P1）', async () => {
    let calls = 0
    let created: Folder[] = []
    const api = loggedIn({
      [foldersKey(SPACE_ID)]: () => json(200, { items: created, truncated: false }),
      'POST /api/folders': (init) => {
        calls += 1
        const body = JSON.parse(String(init?.body)) as { name: string }
        if (calls === 1) {
          created = [folder(PLAN_ID, body.name)]
          return networkFailure()
        }
        if (calls === 2)
          return apiError(409, 'REQUEST_ID_CONFLICT')
        created = [...created, folder(QUARTER_ID, body.name)]
        return json(201, { ...folder(QUARTER_ID, body.name), replayed: false })
      },
    })
    renderApp('/')
    fireEvent.click(await screen.findByRole('button', { name: '新建文件夹' }))
    const form = screen.getByRole('form', { name: '新建文件夹' })
    const input = within(form).getByLabelText('文件夹名称')
    fireEvent.change(input, { target: { value: '方案' } })
    fireEvent.click(within(form).getByRole('button', { name: '新建文件夹' }))
    expect(await within(form).findByText(/^没能确认文件夹是否已经建好（网络连接失败/)).toBeInTheDocument()
    // 结果未知时列表随即刷新：建好了的话就在列表里
    expect(await screen.findByRole('link', { name: '方案' })).toBeInTheDocument()

    fireEvent.change(input, { target: { value: '方案二' } })
    const listed = count(api, foldersKey(SPACE_ID))
    fireEvent.click(within(form).getByRole('button', { name: '新建文件夹' }))
    expect(await within(form).findByText('上一次新建可能已经建好（当时没能确认结果），列表已刷新：请先看看列表里是否已经有它；还要另建时再提交一次。')).toBeInTheDocument()
    expect(count(api, foldersKey(SPACE_ID))).toBeGreaterThan(listed)

    fireEvent.click(within(form).getByRole('button', { name: '新建文件夹' }))
    await waitFor(() => expect(screen.queryByRole('form', { name: '新建文件夹' })).toBeNull())
    const ids = requestIds(api, 'POST /api/folders')
    expect(ids).toHaveLength(3)
    expect(ids[1]).toBe(ids[0])
    expect(ids[2]).not.toBe(ids[0])
    expect(screen.getByRole('link', { name: '方案二' })).toBeInTheDocument()
  })

  it('新建表格：结果未知之后，重试先撞上"登录状态刚刚更新"（别的标签页换了令牌），requestId 仍然沿用，第三次不会建出第二份（P11）', async () => {
    let posts = 0
    const api = loggedIn({
      'POST /api/documents': () => {
        posts += 1
        if (posts === 1)
          return networkFailure()
        if (posts === 2)
          return apiError(403, 'CSRF_TOKEN_INVALID')
        return json(201, { ...detail({ id: NEW_ID }), replayed: false })
      },
    })
    const app = renderApp('/')
    fireEvent.click(await screen.findByRole('button', { name: '新建表格' }))
    expect(await screen.findByText(/^没能确认表格是否已经建好/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '新建表格' }))
    expect(await screen.findByText('新建表格失败：登录状态刚刚更新，这次操作没有完成，请再试一次')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '新建表格' }))
    await waitFor(() => expect(app.page.visits).toEqual([`assign /documents/${NEW_ID}`]))
    const ids = requestIds(api, 'POST /api/documents')
    expect(ids).toEqual([ids[0], ids[0], ids[0]])
  })

  it('新建表格按位置记账：在文件夹里结果未知、到别处新建是另一个 requestId，回来再点沿用原来的（页头在文件夹之间不重来）', async () => {
    const api = loggedIn({
      [foldersKey(SPACE_ID)]: folderPage([folder(PLAN_ID, '方案')]),
      [foldersKey(SPACE_ID, PLAN_ID)]: noFolders(),
      ...documentsIn(SPACE_ID, PLAN_ID, []),
      'POST /api/documents': () => apiError(500, 'INTERNAL_ERROR'),
    })
    renderApp(`/spaces/${SPACE_ID}/folders/${PLAN_ID}`)
    fireEvent.click(await screen.findByRole('button', { name: '新建表格' }))
    await screen.findByText(/^没能确认表格是否已经建好/)
    fireEvent.click(within(screen.getByRole('navigation', { name: '位置' })).getByRole('link', { name: '我的空间' }))
    await screen.findByText('周报')
    fireEvent.click(screen.getByRole('button', { name: '新建表格' }))
    await waitFor(() => expect(count(api, 'POST /api/documents')).toBe(2))
    await screen.findByText(/^没能确认表格是否已经建好/)
    fireEvent.click(screen.getByRole('link', { name: '方案' }))
    await screen.findByRole('navigation', { name: '位置' })
    fireEvent.click(screen.getByRole('button', { name: '新建表格' }))
    await waitFor(() => expect(count(api, 'POST /api/documents')).toBe(3))
    const [inPlan, atRoot, backInPlan] = requestIds(api, 'POST /api/documents')
    expect(atRoot).not.toBe(inPlan)
    expect(backInPlan).toBe(inPlan)
  })
})

describe('M2-P6 复核第二批 S-1：服务端说这次是重放（replayed）——上一次其实已经完成，这件事随之了结', () => {
  const OTHER_ID = '0199a2c4-0000-7000-8000-0000000000da'

  it('新建表格：结果未知（其实已经建好、又被改了名）之后再点，服务端重放——不打开它，说明"上一次其实已经完成"并给出链接；再点才新建一份（换新的 requestId）', async () => {
    let posts = 0
    const api = loggedIn({
      'POST /api/documents': () => {
        posts += 1
        if (posts === 1)
          return networkFailure()
        if (posts === 2)
          return json(201, { ...detail({ id: NEW_ID, title: '第一季度预算' }), replayed: true })
        return json(201, { ...detail({ id: OTHER_ID, title: '未命名表格' }), replayed: false })
      },
    })
    const app = renderApp('/')
    fireEvent.click(await screen.findByRole('button', { name: '新建表格' }))
    await screen.findByText(/^没能确认表格是否已经建好/)
    const listed = count(api, documentsKey(SESSION))
    fireEvent.click(screen.getByRole('button', { name: '新建表格' }))
    expect(await screen.findByText('上一次新建其实已经完成（当时没能确认结果），这次没有再建一份：就是「第一季度预算」。还要另建一份时，再点"新建表格"。')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '打开它' })).toHaveAttribute('href', `/documents/${NEW_ID}`)
    // 没有打开它（很久以后想另建一份时，打开的会是改过名的那一份）；列表刷新，看得到它现在的样子
    expect(app.page.visits).toEqual([])
    expect(count(api, documentsKey(SESSION))).toBeGreaterThan(listed)
    // 按钮照常可用：再点就是新建一份
    fireEvent.click(screen.getByRole('button', { name: '新建表格' }))
    await waitFor(() => expect(app.page.visits).toEqual([`assign /documents/${OTHER_ID}`]))
    const [first, second, third] = requestIds(api, 'POST /api/documents')
    expect(second).toBe(first)
    expect(third).not.toBe(first)
  })

  it('复制：结果未知之后离开这一页、再回来复制到同一个位置——沿用原来的 requestId（记账是页面一份的，K3）；服务端重放时说"上一次其实已经完成"，再复制才是第二份', async () => {
    let copies = 0
    const api = loggedIn({
      [foldersKey(SPACE_ID)]: folderPage([folder(PLAN_ID, '方案')]),
      [foldersKey(SPACE_ID, PLAN_ID)]: noFolders(),
      ...documentsIn(SPACE_ID, PLAN_ID, []),
      [`GET /api/documents/${WEEKLY_ID}`]: () => json(200, detail()),
      [`POST /api/documents/${WEEKLY_ID}/copy`]: () => {
        copies += 1
        if (copies === 1)
          return apiError(500, 'INTERNAL_ERROR')
        if (copies === 2)
          return json(201, { ...detail({ id: NEW_ID, title: '周报 的副本' }), replayed: true })
        return json(201, { ...detail({ id: OTHER_ID, title: '周报 的副本' }), replayed: false })
      },
    })
    const app = renderApp('/')
    await openActions('周报')
    fireEvent.click(await screen.findByRole('button', { name: '复制' }))
    fireEvent.click(within(screen.getByRole('form', { name: '复制' })).getByRole('button', { name: '复制到这里' }))
    await screen.findByText(/^没能确认是否已经复制/)

    // 离开这一页（进文件夹里，那一行随之卸载），再回来
    await app.router.navigate(`/spaces/${SPACE_ID}/folders/${PLAN_ID}`)
    await screen.findByRole('navigation', { name: '位置' })
    expect(screen.queryByRole('button', { name: '操作 周报' })).toBeNull()
    await app.router.navigate('/')
    await openActions('周报')
    fireEvent.click(await screen.findByRole('button', { name: '复制' }))
    fireEvent.click(within(screen.getByRole('form', { name: '复制' })).getByRole('button', { name: '复制到这里' }))
    const replayed = '上一次复制其实已经完成（当时没能确认结果），这次没有再复制一份：副本就是「周报 的副本」。还要再复制一份时，再复制一次。'
    expect(await screen.findByText(replayed)).toBeInTheDocument()
    expect(screen.queryByText('已复制出「周报 的副本」')).toBeNull()
    expect(screen.getByRole('link', { name: '打开副本' })).toHaveAttribute('href', `/documents/${NEW_ID}`)

    // 这件事了结了：再复制一次是第二份
    await openActions('周报')
    fireEvent.click(await screen.findByRole('button', { name: '复制' }))
    fireEvent.click(within(screen.getByRole('form', { name: '复制' })).getByRole('button', { name: '复制到这里' }))
    expect(await screen.findByText('已复制出「周报 的副本」')).toBeInTheDocument()
    const [first, again, third] = requestIds(api, `POST /api/documents/${WEEKLY_ID}/copy`)
    expect(again).toBe(first)
    expect(third).not.toBe(first)
  })

  it('新建文件夹：结果未知之后原样再提交，服务端重放——表单关掉，列表上方说明"上一次其实已经完成"、接住焦点；再新建是另一个 requestId', async () => {
    let posts = 0
    let created: Folder[] = []
    const api = loggedIn({
      [foldersKey(SPACE_ID)]: () => json(200, { items: created, truncated: false }),
      'POST /api/folders': (init) => {
        posts += 1
        const body = JSON.parse(String(init?.body)) as { name: string }
        if (posts === 1) {
          created = [folder(PLAN_ID, body.name)]
          return networkFailure()
        }
        if (posts === 2)
          return json(201, { ...folder(PLAN_ID, body.name), replayed: true })
        created = [...created, folder(QUARTER_ID, body.name)]
        return json(201, { ...folder(QUARTER_ID, body.name), replayed: false })
      },
    })
    renderApp('/')
    fireEvent.click(await screen.findByRole('button', { name: '新建文件夹' }))
    const form = screen.getByRole('form', { name: '新建文件夹' })
    fireEvent.change(within(form).getByLabelText('文件夹名称'), { target: { value: '方案' } })
    fireEvent.click(within(form).getByRole('button', { name: '新建文件夹' }))
    await within(form).findByText(/^没能确认文件夹是否已经建好/)
    fireEvent.click(within(form).getByRole('button', { name: '新建文件夹' }))
    const text = '上一次新建其实已经完成（当时没能确认结果），这次没有再建一个：文件夹「方案」已经在列表里了。'
    expect(await screen.findByText(text)).toBeInTheDocument()
    expect(screen.queryByRole('form', { name: '新建文件夹' })).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(noticeOf(text)))

    fireEvent.click(screen.getByRole('button', { name: '新建文件夹' }))
    const next = screen.getByRole('form', { name: '新建文件夹' })
    fireEvent.change(within(next).getByLabelText('文件夹名称'), { target: { value: '方案' } })
    fireEvent.click(within(next).getByRole('button', { name: '新建文件夹' }))
    await waitFor(() => expect(screen.queryByRole('form', { name: '新建文件夹' })).toBeNull())
    const [first, second, third] = requestIds(api, 'POST /api/folders')
    expect(second).toBe(first)
    expect(third).not.toBe(first)
  })
})

describe('M2-P6 复核 S1–S3：结果未知与被拒绝之后', () => {
  it('删除文档的结果未知（其实已经删了）：列表刷新、那一行消失，列表上方说明可能已经删除并给出回收站，焦点在说明上，不落到 body（P2）', async () => {
    let deleted = false
    loggedIn({
      [documentsKey(SESSION)]: () => json(200, { items: deleted ? [] : [WEEKLY], nextCursor: null }),
      [`GET /api/documents/${WEEKLY_ID}`]: () => json(200, detail()),
      [`DELETE /api/documents/${WEEKLY_ID}`]: () => {
        deleted = true
        return apiError(500, 'INTERNAL_ERROR')
      },
    })
    renderApp('/')
    await openActions('周报')
    const remove = await screen.findByRole('button', { name: '删除' })
    remove.focus()
    fireEvent.click(remove)
    const text = '没能确认「周报」是否已经删除（服务器出了点问题，请稍后重试）。列表已刷新：它已经不在这里，就是已经移到回收站了；还在的话可以再删除一次。'
    expect(await screen.findByText(text)).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('list', { name: '文档列表' })).toBeNull())
    expect(screen.getByRole('link', { name: '打开回收站' })).toHaveAttribute('href', `/spaces/${SPACE_ID}/trash`)
    await waitFor(() => expect(document.activeElement).toBe(noticeOf(text)))
  })

  it('那一行已经不在了（404）：列表刷新，说明它已经不在这里、给出回收站，不悄悄消失；关掉说明时焦点交给标题（P2、S3）', async () => {
    let gone = false
    loggedIn({
      [documentsKey(SESSION)]: () => json(200, { items: gone ? [] : [WEEKLY], nextCursor: null }),
      [`GET /api/documents/${WEEKLY_ID}`]: () => json(200, detail()),
      [`DELETE /api/documents/${WEEKLY_ID}`]: () => {
        gone = true
        return apiError(404, 'NOT_FOUND')
      },
    })
    renderApp('/')
    await openActions('周报')
    fireEvent.click(await screen.findByRole('button', { name: '删除' }))
    const text = '「周报」已经不在这里了（可能已经删除，或者被别人移走了），列表已刷新。'
    expect(await screen.findByText(text)).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('list', { name: '文档列表' })).toBeNull())
    expect(screen.getByRole('link', { name: '打开回收站' })).toBeInTheDocument()
    await waitFor(() => expect(document.activeElement).toBe(noticeOf(text)))
    // 那一行已经不在了："操作"回不去，焦点交给页面的标题
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(document.activeElement).toBe(pageTitle()))
  })

  it('展开"操作"时它已经不在了（取元数据 404）：列表刷新，说明它已经不在这里，不给一个永远失败的"重试"（P15）', async () => {
    let gone = false
    loggedIn({
      [documentsKey(SESSION)]: () => json(200, { items: gone ? [] : [WEEKLY], nextCursor: null }),
      [`GET /api/documents/${WEEKLY_ID}`]: () => {
        gone = true
        return apiError(404, 'NOT_FOUND')
      },
    })
    renderApp('/')
    await openActions('周报')
    const text = '「周报」已经不在这里了（可能已经删除，或者被别人移走了），列表已刷新。'
    expect(await screen.findByText(text)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
    await waitFor(() => expect(screen.queryByRole('list', { name: '文档列表' })).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(noticeOf(text)))
  })

  it('删除文件夹被 403 拒绝（空间刚被归档）：面板收起，服务端说的原因写在列表上方、接住焦点；"操作"随新的权限消失，关掉说明时焦点交给标题（P10）', async () => {
    let permissions = ALL_FOLDER_PERMISSIONS
    loggedIn({
      [foldersKey(SPACE_ID)]: () => json(200, { items: [folder(PLAN_ID, '方案', { permissions })], truncated: false }),
      [`DELETE /api/folders/${PLAN_ID}`]: () => {
        permissions = NO_FOLDER_PERMISSIONS
        return apiError(403, 'PERMISSION_DENIED', '空间已归档，只能查看')
      },
    })
    renderApp('/')
    await openActions('方案')
    const remove = await screen.findByRole('button', { name: '删除' })
    remove.focus()
    fireEvent.click(remove)
    const text = '「方案」的操作没有完成：空间已归档，只能查看'
    expect(await screen.findByText(text)).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('button', { name: '操作 方案' })).toBeNull())
    // 面板收起了：没有只剩"取消"的空面板
    expect(screen.queryByRole('button', { name: '取消' })).toBeNull()
    expect(screen.queryByText('你没有执行这个操作的权限')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(noticeOf(text)))
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(document.activeElement).toBe(pageTitle()))
  })

  it('改名的结果未知：留在表单里说明可以再保存一次（改名是幂等的），列表随即刷新', async () => {
    const api = loggedIn({
      [`GET /api/documents/${WEEKLY_ID}`]: () => json(200, detail()),
      [`PATCH /api/documents/${WEEKLY_ID}`]: () => networkFailure(),
    })
    renderApp('/')
    await openActions('周报')
    fireEvent.click(await screen.findByRole('button', { name: '改名' }))
    fireEvent.change(screen.getByLabelText('周报 的新名称'), { target: { value: '周报（终稿）' } })
    const listed = count(api, documentsKey(SESSION))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('没能确认是否已经改好（网络连接失败，请检查网络后重试）。列表已刷新，可以再保存一次。')).toBeInTheDocument()
    expect(count(api, documentsKey(SESSION))).toBeGreaterThan(listed)
    expect(screen.getByLabelText('周报 的新名称')).toHaveValue('周报（终稿）')
  })

  it('上一个操作的失败不带进随后打开的改名表单（三种操作共用一个变更，G1 / P3）', async () => {
    loggedIn({
      [foldersKey(SPACE_ID)]: folderPage([folder(PLAN_ID, '方案')]),
      [`DELETE /api/folders/${PLAN_ID}`]: () => apiError(403, 'FOLDER_HAS_OTHERS_DOCUMENTS'),
    })
    renderApp('/')
    await openActions('方案')
    fireEvent.click(await screen.findByRole('button', { name: '删除' }))
    expect(await screen.findByText('这个文件夹里有别人创建的文档，只有空间管理员能删除')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '改名' }))
    const form = screen.getByLabelText('方案 的新名称').closest('form') as HTMLElement
    expect(within(form).queryByRole('alert')).toBeNull()
    expect(screen.queryByText('这个文件夹里有别人创建的文档，只有空间管理员能删除')).toBeNull()
  })

  it('新建文件夹被 403 拒绝：表单关掉（这里已经不能新建了），原因写在列表上方、接住焦点（S2）', async () => {
    let space = personalSpaceOf(SESSION)
    loggedIn({
      [`GET /api/spaces/${SPACE_ID}`]: () => json(200, space),
      'POST /api/folders': () => {
        space = { ...space, permissions: { ...space.permissions, canCreateFolders: false, canCreateDocuments: false } }
        return apiError(403, 'PERMISSION_DENIED', '你已经不能在这里新建了')
      },
    })
    renderApp('/')
    fireEvent.click(await screen.findByRole('button', { name: '新建文件夹' }))
    const form = screen.getByRole('form', { name: '新建文件夹' })
    fireEvent.change(within(form).getByLabelText('文件夹名称'), { target: { value: '方案' } })
    fireEvent.click(within(form).getByRole('button', { name: '新建文件夹' }))
    const text = '没能新建文件夹：你已经不能在这里新建了'
    expect(await screen.findByText(text)).toBeInTheDocument()
    expect(screen.queryByRole('form', { name: '新建文件夹' })).toBeNull()
    await waitFor(() => expect(screen.queryByRole('button', { name: '新建文件夹' })).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(noticeOf(text)))
  })

  it('刷新之后一个操作都做不了的文件夹：已经展开的面板随之收起，焦点交给标题（S2、S3）', async () => {
    let permissions = ALL_FOLDER_PERMISSIONS
    let space = personalSpaceOf(SESSION)
    loggedIn({
      [`GET /api/spaces/${SPACE_ID}`]: () => json(200, space),
      [foldersKey(SPACE_ID)]: () => json(200, { items: [folder(PLAN_ID, '方案', { permissions })], truncated: false }),
      'POST /api/documents': () => {
        permissions = NO_FOLDER_PERMISSIONS
        space = { ...space, permissions: { ...space.permissions, canCreateDocuments: false, canCreateFolders: false } }
        return apiError(403, 'PERMISSION_DENIED', '空间已归档，只能查看')
      },
    })
    renderApp('/')
    await openActions('方案')
    const rename = await screen.findByRole('button', { name: '改名' })
    // 面板开着时，页头的新建表格被拒绝：页面按新的权限重新请求
    fireEvent.click(screen.getByRole('button', { name: '新建表格' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: '操作 方案' })).toBeNull())
    expect(rename).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '改名' })).toBeNull()
    // 被拒绝的原因写在页头的说明里，接住焦点（不落到 body）
    const notice = noticeOf('没能新建表格：空间已归档，只能查看')
    await waitFor(() => expect(document.activeElement).toBe(notice))
  })

  it('文档的改名表单开着，刷新之后不能改名了（只剩复制）：表单收起，回到按新权限列出的操作，不留一个提交了只会被拒绝的表单（第二批 G-6）', async () => {
    let permissions = detail().permissions
    let space = personalSpaceOf(SESSION)
    loggedIn({
      [`GET /api/spaces/${SPACE_ID}`]: () => json(200, space),
      [`GET /api/documents/${WEEKLY_ID}`]: () => json(200, detail({ permissions })),
      'POST /api/documents': () => {
        // 自己刚被降为查看者：只能看、能复制
        permissions = { canEdit: false, canRename: false, canMoveWithinSpace: false, canMoveAcrossSpaces: false, canCopy: true, canDelete: false }
        space = { ...space, permissions: { ...space.permissions, canCreateDocuments: false, canCreateFolders: false } }
        return apiError(403, 'PERMISSION_DENIED', '你已经不能在这里新建了')
      },
    })
    renderApp('/')
    await openActions('周报')
    fireEvent.click(await screen.findByRole('button', { name: '改名' }))
    expect(screen.getByLabelText('周报 的新名称')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '新建表格' }))
    await waitFor(() => expect(screen.queryByLabelText('周报 的新名称')).toBeNull())
    // 面板还在，按新的权限只列出复制
    expect(await screen.findByRole('button', { name: '复制' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '改名' })).toBeNull()
    expect(screen.queryByRole('button', { name: '移动' })).toBeNull()
  })

  it('文件夹的移动表单开着，刷新之后不能移动了（还能删除）：移动表单收起，面板按新的权限只列出删除（第二批 G-6）', async () => {
    let permissions = ALL_FOLDER_PERMISSIONS
    let space = personalSpaceOf(SESSION)
    loggedIn({
      [`GET /api/spaces/${SPACE_ID}`]: () => json(200, space),
      [foldersKey(SPACE_ID)]: () => json(200, { items: [folder(PLAN_ID, '方案', { permissions })], truncated: false }),
      'POST /api/documents': () => {
        permissions = { ...NO_FOLDER_PERMISSIONS, canDelete: true }
        space = { ...space, permissions: { ...space.permissions, canCreateDocuments: false } }
        return apiError(403, 'PERMISSION_DENIED', '你已经不能在这里新建了')
      },
    })
    renderApp('/')
    await openActions('方案')
    fireEvent.click(await screen.findByRole('button', { name: '移动' }))
    expect(screen.getByRole('form', { name: '移动' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '新建表格' }))
    await waitFor(() => expect(screen.queryByRole('form', { name: '移动' })).toBeNull())
    expect(await screen.findByRole('button', { name: '删除' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '移动' })).toBeNull()
  })
})

describe('M2-P6 复核 S3、S4：焦点、读屏与浏览器标签页的标题', () => {
  it('加载中的骨架屏：role="status" 与可读名称写在包住它的容器上，读屏读得到（P9）', async () => {
    loggedIn({ [foldersKey(SPACE_ID)]: async () => new Promise<Response>(() => {}) })
    renderApp('/')
    expect(await screen.findByRole('status', { name: '正在加载文件夹…' })).toBeInTheDocument()
    expect(document.querySelector('[role="status"][aria-hidden="true"]')).toBeNull()
  })

  it('名称不合法：除了标 aria-invalid，还用文字说明原因，输入框与按钮都指向它（WCAG 3.3.1，P12）', async () => {
    loggedIn({ [`GET /api/documents/${WEEKLY_ID}`]: () => json(200, detail()) })
    renderApp('/')
    // 新建文件夹：还没输入时说明规则，输入了不合法的名称时说明原因
    fireEvent.click(await screen.findByRole('button', { name: '新建文件夹' }))
    const form = screen.getByRole('form', { name: '新建文件夹' })
    const input = within(form).getByLabelText('文件夹名称')
    const submit = within(form).getByRole('button', { name: '新建文件夹' })
    expect(submit).toHaveAccessibleDescription(/^名称为 1–/)
    fireEvent.change(input, { target: { value: '方\u200B案' } })
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAccessibleDescription('名称不能包含看不见的字符（例如零宽空格）')
    expect(submit).toHaveAccessibleDescription('名称不能包含看不见的字符（例如零宽空格）')
    fireEvent.change(input, { target: { value: '方案' } })
    expect(input).not.toHaveAccessibleDescription()

    // 行内改名
    await openActions('周报')
    fireEvent.click(await screen.findByRole('button', { name: '改名' }))
    const title = screen.getByLabelText('周报 的新名称')
    fireEvent.change(title, { target: { value: 'a\u0007b' } })
    expect(title).toHaveAttribute('aria-invalid', 'true')
    expect(title).toHaveAccessibleDescription('标题不能包含控制字符')
  })

  it('页头改名：名称不合法时用文字说明原因（P12）', async () => {
    const team = { ...TEAM }
    loggedIn({
      'GET /api/spaces': () => json(200, { items: [personalSpaceOf(SESSION), team] }),
      [`GET /api/spaces/${TEAM_ID}`]: () => json(200, team),
      [foldersKey(TEAM_ID)]: noFolders(),
      [`GET /api/documents?${new URLSearchParams({ spaceId: TEAM_ID }).toString()}`]: () => json(200, { items: [], nextCursor: null }),
    })
    renderApp(`/spaces/${TEAM_ID}`)
    fireEvent.click(await screen.findByRole('button', { name: '改名' }))
    const input = screen.getByLabelText('空间名称')
    fireEvent.change(input, { target: { value: '市场\u200B部' } })
    expect(input).toHaveAccessibleDescription('名称不能包含看不见的字符（例如零宽空格）')
    expect(screen.getByRole('button', { name: '保存' })).toHaveAccessibleDescription('名称不能包含看不见的字符（例如零宽空格）')
  })

  it('浏览器标签页的标题：空间的根目录是空间名，文件夹里是"文件夹名 - 空间名"（WCAG 2.4.2）', async () => {
    loggedIn({
      [foldersKey(SPACE_ID)]: folderPage([folder(PLAN_ID, '方案')]),
      [foldersKey(SPACE_ID, PLAN_ID)]: noFolders(),
      ...documentsIn(SPACE_ID, PLAN_ID, []),
    })
    renderApp('/')
    await screen.findByText('周报')
    await waitFor(() => expect(document.title).toBe('我的空间 - NerveOffice'))
    fireEvent.click(screen.getByRole('link', { name: '方案' }))
    await waitFor(() => expect(document.title).toBe('方案 - 我的空间 - NerveOffice'))
  })

  it('路径中间的文件夹被挪到了同一个空间的别处：说明位置已经变了，给出回到根目录的入口，不一直显示"…"（G2 / P14）', async () => {
    loggedIn({
      // 方案已经不在根目录（被挪进了归档），它下面的二季度照样取得到
      [foldersKey(SPACE_ID)]: folderPage([folder(ARCHIVE_ID, '归档')]),
      [foldersKey(SPACE_ID, PLAN_ID)]: folderPage([folder(QUARTER_ID, '二季度', { parentId: PLAN_ID, depth: 3 })]),
      [foldersKey(SPACE_ID, QUARTER_ID)]: noFolders(),
      ...documentsIn(SPACE_ID, QUARTER_ID, []),
    })
    renderApp(`/spaces/${SPACE_ID}/folders/${PLAN_ID}/${QUARTER_ID}`)
    expect(await screen.findByText('这个位置已经变了：路径上的文件夹被移到了别处。请回到空间的根目录重新找它。')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '回到空间的根目录' })).toHaveAttribute('href', `/spaces/${SPACE_ID}`)
    expect(screen.queryByText('…')).toBeNull()
  })

  it('上一层的列表被截断（超过上限）时看不出它在不在：不说位置变了，照常显示', async () => {
    loggedIn({
      [foldersKey(SPACE_ID)]: () => json(200, { items: [folder(ARCHIVE_ID, '归档')], truncated: true }),
      [foldersKey(SPACE_ID, PLAN_ID)]: noFolders(),
      ...documentsIn(SPACE_ID, PLAN_ID, []),
    })
    renderApp(`/spaces/${SPACE_ID}/folders/${PLAN_ID}`)
    expect(await screen.findByRole('navigation', { name: '位置' })).toBeInTheDocument()
    await settle()
    expect(screen.queryByText(/这个位置已经变了/)).toBeNull()
  })
})

describe('M2-P6 复核 M3：源与目标不同的整理请求（单元部分）', () => {
  it('文件夹改名：提交的是新名称（U1）', async () => {
    const api = loggedIn({
      [foldersKey(SPACE_ID)]: folderPage([folder(PLAN_ID, '方案')]),
      [`PATCH /api/folders/${PLAN_ID}`]: () => json(200, folder(PLAN_ID, '季度方案')),
    })
    renderApp('/')
    await openActions('方案')
    fireEvent.click(await screen.findByRole('button', { name: '改名' }))
    fireEvent.change(screen.getByLabelText('方案 的新名称'), { target: { value: '季度方案' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(bodies(api, `PATCH /api/folders/${PLAN_ID}`)).toEqual([{ name: '季度方案' }]))
  })

  it('把文件夹移进另一个文件夹：请求带着目标文件夹，不会落到根目录（U2）', async () => {
    const api = loggedIn({
      [foldersKey(SPACE_ID)]: folderPage([folder(PLAN_ID, '方案'), folder(ARCHIVE_ID, '归档')]),
      [foldersKey(SPACE_ID, ARCHIVE_ID)]: noFolders(),
      [`POST /api/folders/${PLAN_ID}/move`]: () => json(200, folder(PLAN_ID, '方案', { parentId: ARCHIVE_ID, depth: 2 })),
    })
    renderApp('/')
    await openActions('方案')
    fireEvent.click(await screen.findByRole('button', { name: '移动' }))
    const form = screen.getByRole('form', { name: '移动' })
    fireEvent.click(await within(form).findByRole('button', { name: '进入 归档' }))
    fireEvent.click(within(form).getByRole('button', { name: '移动到这里' }))
    await waitFor(() => expect(bodies(api, `POST /api/folders/${PLAN_ID}/move`)).toEqual([{ spaceId: SPACE_ID, folderId: ARCHIVE_ID }]))
    expect(await screen.findByText('已把「方案」移动到我的空间 / 归档')).toBeInTheDocument()
  })

  it('复制到另一个空间里的文件夹：请求带着目标空间与目标文件夹（U4）', async () => {
    const teamRoot = new URLSearchParams({ spaceId: TEAM_ID })
    const api = loggedIn({
      'GET /api/spaces': () => json(200, { items: [personalSpaceOf(SESSION), TEAM] }),
      [`GET /api/documents/${WEEKLY_ID}`]: () => json(200, detail()),
      [`GET /api/folders?${teamRoot.toString()}`]: folderPage([folder(PLAN_ID, '方案', { spaceId: TEAM_ID })]),
      [foldersKey(TEAM_ID, PLAN_ID)]: noFolders(),
      [`POST /api/documents/${WEEKLY_ID}/copy`]: () => json(201, { ...detail({ id: NEW_ID, title: '周报 的副本', spaceId: TEAM_ID, folderId: PLAN_ID }), replayed: false }),
    })
    renderApp('/')
    await openActions('周报')
    fireEvent.click(await screen.findByRole('button', { name: '复制' }))
    const form = screen.getByRole('form', { name: '复制' })
    fireEvent.change(within(form).getByLabelText('目标空间'), { target: { value: TEAM_ID } })
    fireEvent.click(await within(form).findByRole('button', { name: '进入 方案' }))
    fireEvent.click(within(form).getByRole('button', { name: '复制到这里' }))
    await waitFor(() => expect(bodies(api, `POST /api/documents/${WEEKLY_ID}/copy`)).toEqual([{ spaceId: TEAM_ID, folderId: PLAN_ID, requestId: expect.stringMatching(/^[\da-f-]{36}$/) as unknown }]))
    expect(await screen.findByText('已复制出「周报 的副本」')).toBeInTheDocument()
  })
})
