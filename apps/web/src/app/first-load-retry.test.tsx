// 第一次就没取到 → 按"重试"（规范 §2.4，shared/lib/use-first-load-retry.ts）：各页面逐处核对同一件事——
// 重试期间说明与同一个"重试"留着（不可用、标为忙碌、说"正在重试…"，不换成加载中），焦点还在按钮上；又失败了说明换成新的原因，焦点还在按钮上；
// 取到之后说明连同按钮一起消失，焦点交给一直在的元素（标题、列表、页头开头、输入框、面板里的"取消"、选目标位置时的"目标位置"这一行），不落到 body。
// 得到页面另有说明的错误（404、403、链接不能用）时焦点同样有去处；得到未登录、转到登录页时由登录页接住（DEF-047）。
// 分页表格与左侧导航见各自的测试，对话框与按关键词选一项见各自的组件测试。
// 接口用假的 fetch；计时器是假的（跟着真实的时间走，另外可以拨过查询自动重试的 1 秒）。
import type { AdminUser, DocumentDetail, DocumentSummary, Folder, SearchResult, SessionResponse, SpaceMemberListResponse, SpaceView } from '@nerve-office/contracts'
import type { FakeApi, Handler } from '../shared/testing/fake-api.test-support.ts'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiError, installFakeApi, json } from '../shared/testing/fake-api.test-support.ts'
import { documentsKey, foldersKey, noFolders, spaceRoutes } from '../shared/testing/spaces.test-support.ts'
import { AMY, listPage, session, SPACES } from './admin.test-support.ts'
import { currentPath, renderApp } from './render-app.test-support.tsx'

const SESSION: SessionResponse = {
  user: { id: '0199a2c4-0000-7000-8000-00000000000a', username: 'amy', displayName: '艾米', systemRole: 'member' },
  personalSpace: { id: '0199a2c4-0000-7000-8000-0000000000a1', name: '艾米' },
  csrfToken: 'csrf-1',
}

const TEAM_ID = '0199a2c4-0000-7000-8000-0000000000c1'
const WEEKLY_ID = '0199a2c4-0000-7000-8000-0000000000d1'
const SPACE_KEY = `GET /api/spaces/${TEAM_ID}`

/** 第一次的原因（5xx：查询自动重试一次，隔 1 秒，第二次同样失败） */
const SERVER = '服务器出了点问题，请稍后重试'
/** 重试又失败了的原因（429：不自动重试） */
const BUSY = '尝试次数过多，请稍后再试'

function server(): Response {
  return apiError(500, 'INTERNAL_ERROR')
}

function busy(): Response {
  return apiError(429, 'TOO_MANY_ATTEMPTS')
}

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

const PLAN_ID = '0199a2c4-0000-7000-8000-0000000000f1'

/** 空间根目录下的一个文件夹（选目标位置时点得进去） */
function rootFolder(spaceId: string, name: string): Folder {
  return {
    id: PLAN_ID,
    spaceId,
    parentId: null,
    name,
    depth: 1,
    createdAt: '2026-09-29T01:00:00.000Z',
    updatedAt: '2026-09-29T01:00:00.000Z',
    permissions: { canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: true, canDelete: true },
  }
}

function detail(): DocumentDetail {
  return {
    ...WEEKLY,
    spaceId: SESSION.personalSpace.id,
    space: { id: SESSION.personalSpace.id, type: 'personal' },
    folderId: null,
    accessVia: 'space',
    revision: 1,
    profile: 'sheet@1',
    formatVersion: 1,
    sdkVersion: '1.0.1',
    formulasPending: false,
    permissions: { canEdit: true, canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: true, canCopy: true, canDelete: true, canShare: false },
  }
}

function teamKey(path: string): string {
  return `GET ${path}?${new URLSearchParams({ spaceId: TEAM_ID }).toString()}`
}

/** 登录之后：导航里有这个团队空间；它的页头、根目录、文档与回收站都是空的；个人空间（首页）的文档里有"周报" */
function loggedIn(handlers: Record<string, Handler> = {}): FakeApi {
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

/**
 * 由用例控制的接口：按 answer 回应；hold() 之后来的请求先挂起，release() 时按那时的 answer 回应
 * （用来看"重试"进行中的样子）
 */
function controlled(initial: Handler) {
  let current = initial
  let holding = false
  const held: (() => void)[] = []
  const handler: Handler = async (init) => {
    if (!holding)
      return current(init)
    return new Promise<Response>((resolve, reject) => {
      held.push(() => {
        Promise.resolve().then(async () => current(init)).then(resolve, reject)
      })
    })
  }
  return {
    handler,
    answer: (next: Handler): void => {
      current = next
    },
    hold: (): void => {
      holding = true
    },
    release: (): void => {
      holding = false
      for (const respond of held.splice(0))
        respond()
    },
  }
}

type Controlled = ReturnType<typeof controlled>

function requestCount(api: FakeApi, key: string): number {
  return api.requests.filter(request => request.key === key).length
}

/** 拨过一段时间：到期的计时器（查询的自动重试）随之触发，React 的更新随之完成 */
async function advance(ms: number): Promise<void> {
  await act(async () => vi.advanceTimersByTimeAsync(ms))
}

/**
 * 等到 key 的请求发出了 count 次：先按真实的时间等第一次（按需加载的页面要先下载它的代码），
 * 再一点一点拨计时器（5xx 自动重试一次，隔 1 秒）
 */
async function untilRequested(api: FakeApi, key: string, count: number): Promise<void> {
  await waitFor(() => expect(requestCount(api, key)).toBeGreaterThan(0), { timeout: 10_000 })
  for (let step = 0; step < 60 && requestCount(api, key) < count; step += 1)
    await advance(100)
  expect(requestCount(api, key)).toBe(count)
}

/** 含这段文字的说明（role="alert" 的那一块） */
function alertWith(text: string): HTMLElement {
  const alert = screen.getByText(text).closest<HTMLElement>('[role="alert"]')
  if (alert === null)
    throw new Error(`"${text}"不在 role="alert" 的说明里`)
  return alert
}

/** 包着这段文字与"重试"的最近的一块（说明与按钮分开排的页面：整页的会话确认、一次性链接） */
function blockWith(text: string): HTMLElement {
  let block = screen.getByText(text).parentElement
  while (block !== null && within(block).queryByRole('button', { name: /重试/ }) === null)
    block = block.parentElement
  if (block === null)
    throw new Error(`"${text}"附近没有"重试"`)
  return block
}

interface RetryFlow {
  readonly api: FakeApi
  readonly key: string
  readonly endpoint: Controlled
  /** 加载失败的说明：包着原因与"重试"的那一块 */
  readonly problem: () => HTMLElement
  /** 这一处加载中（骨架屏）的读屏名称：重试期间不该换成它 */
  readonly loading: string
  /** 取到了的回应 */
  readonly ok: Handler
  /** 取到之后焦点应当在的元素 */
  readonly target: () => HTMLElement
  /** 第一次加载要发几次请求才算失败（默认 2：5xx 自动重试一次） */
  readonly attempts?: number
  /** 重试期间另外要核对的（例如查找的进展不说"正在查找…"） */
  readonly whileRetrying?: () => void
}

/**
 * 第一次就没取到 → 用键盘按"重试"的整个过程：
 * 1. 说明里有第一次的原因与"重试"；焦点放在"重试"上按下；
 * 2. 重新请求期间：说明与同一个按钮留着，按钮不可用、标为忙碌、说"正在重试…"，上一次的原因不再给，没有换成加载中；焦点还在按钮上；
 *    这时再按，交回在途的那一次，不重复请求；
 * 3. 又失败了：说明换成新的原因，按钮可用，焦点还在同一个按钮上；
 * 4. 再按、取到了：说明连同按钮一起消失，焦点交给 target（不落到 body）
 */
async function retryFlow({ api, key, endpoint, problem, loading, ok, target, attempts = 2, whileRetrying }: RetryFlow): Promise<void> {
  await untilRequested(api, key, attempts)
  const shown = await waitFor(problem)
  expect(shown).toHaveTextContent(SERVER)
  const retry = within(shown).getByRole('button', { name: '重试' })

  endpoint.hold()
  endpoint.answer(busy)
  retry.focus()
  fireEvent.click(retry)
  await waitFor(() => expect(retry).toHaveTextContent('正在重试…'))
  expect(retry).toHaveAttribute('aria-disabled', 'true')
  expect(retry).toHaveAttribute('aria-busy', 'true')
  expect(shown).toBeInTheDocument()
  expect(shown).not.toHaveTextContent(SERVER)
  expect(screen.queryByRole('status', { name: loading })).toBeNull()
  whileRetrying?.()
  expect(document.activeElement).toBe(retry)
  const sent = requestCount(api, key)
  fireEvent.click(retry)
  await advance(50)
  expect(requestCount(api, key)).toBe(sent)

  endpoint.release()
  await waitFor(() => expect(shown).toHaveTextContent(BUSY))
  expect(retry).toHaveTextContent(/^重试$/)
  expect(retry).toHaveAttribute('aria-disabled', 'false')
  expect(retry).toHaveAttribute('aria-busy', 'false')
  expect(document.activeElement).toBe(retry)

  endpoint.answer(ok)
  fireEvent.click(retry)
  await waitFor(() => expect(retry).not.toBeInTheDocument())
  await waitFor(() => expect(document.activeElement).toBe(target()))
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('搜索结果页', () => {
  const SEARCH_KEY = `GET /api/search?${new URLSearchParams({ query: '周报' }).toString()}`
  const RESULT: SearchResult = {
    id: WEEKLY_ID,
    title: '周报',
    type: 'sheet',
    createdAt: '2026-09-29T01:00:00.000Z',
    updatedAt: '2026-09-29T02:00:00.000Z',
    space: { id: TEAM_ID, type: 'team', name: '市场部' },
    folderId: null,
    folderPath: [],
    accessVia: 'space',
  }

  it('搜索失败、按"重试"：重试期间说明与按钮留着；又失败时换成新的原因；搜到之后焦点交给结果的列表', async () => {
    const search = controlled(server)
    const api = loggedIn({ [SEARCH_KEY]: search.handler })
    renderApp('/search?q=周报')
    await retryFlow({
      api,
      key: SEARCH_KEY,
      endpoint: search,
      problem: () => alertWith('搜索失败'),
      loading: '正在搜索…',
      ok: () => json(200, { items: [RESULT], nextCursor: null }),
      target: () => screen.getByRole('list', { name: '搜索结果' }),
    })
  })

  it('重试之后一个也没搜到：焦点交给没搜到的说明', async () => {
    const search = controlled(server)
    const api = loggedIn({ [SEARCH_KEY]: search.handler })
    renderApp('/search?q=周报')
    await untilRequested(api, SEARCH_KEY, 2)
    const retry = within(await waitFor(() => alertWith('搜索失败'))).getByRole('button', { name: '重试' })
    search.answer(() => json(200, { items: [], nextCursor: null }))
    retry.focus()
    fireEvent.click(retry)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText('没有找到标题包含“周报”的文档（回收站里的不算）')))
  })

  it('留着之前的结果、刷新却失败了（"没能刷新"）：重试成功之后焦点同样交给结果的列表，不落到 body', async () => {
    const search = controlled(() => json(200, { items: [RESULT], nextCursor: null }))
    const api = loggedIn({ [SEARCH_KEY]: search.handler })
    const app = renderApp('/search?q=周报')
    expect(await screen.findByRole('list', { name: '搜索结果' })).toBeInTheDocument()
    search.answer(server)
    void app.router.navigate('/')
    expect(await screen.findByRole('heading', { level: 1, name: '我的空间' })).toBeInTheDocument()
    void app.router.navigate('/search?q=周报')
    await untilRequested(api, SEARCH_KEY, 3)
    const alert = await waitFor(() => alertWith('搜索结果没能刷新，显示的还是之前的内容'))
    search.answer(() => json(200, { items: [RESULT], nextCursor: null }))
    const retry = within(alert).getByRole('button', { name: '重试' })
    retry.focus()
    fireEvent.click(retry)
    await waitFor(() => expect(retry).not.toBeInTheDocument())
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('list', { name: '搜索结果' })))
  })
})

describe('需要登录的外层路由（会话确认失败的整页说明）', () => {
  it('确认失败、按"重试"：重试期间说明与按钮留着；又失败时换成新的原因；确认之后焦点交给页头开头的产品名称', async () => {
    const check = controlled(server)
    const api = installFakeApi({
      ...spaceRoutes(SESSION),
      [documentsKey(SESSION)]: () => json(200, { items: [], nextCursor: null }),
      'GET /api/auth/session': check.handler,
    })
    renderApp('/')
    await retryFlow({
      api,
      key: 'GET /api/auth/session',
      endpoint: check,
      problem: () => blockWith('没能确认登录状态'),
      loading: '正在确认登录状态…',
      ok: () => json(200, SESSION),
      target: () => screen.getByRole('link', { name: 'NerveOffice' }),
    })
    expect(await screen.findByRole('heading', { level: 1, name: '我的空间' })).toBeInTheDocument()
  })

  it('重试之后得到"未登录"：转到登录页（不再是加载失败的说明），焦点交给用户名，不落到 body（DEF-047）', async () => {
    const check = controlled(server)
    const api = installFakeApi({ 'GET /api/auth/session': check.handler })
    const app = renderApp('/')
    await untilRequested(api, 'GET /api/auth/session', 2)
    const retry = within(await waitFor(() => blockWith('没能确认登录状态'))).getByRole('button', { name: '重试' })
    check.answer(() => apiError(401, 'UNAUTHENTICATED'))
    retry.focus()
    fireEvent.click(retry)
    expect(await screen.findByRole('form', { name: '登录' })).toBeInTheDocument()
    expect(currentPath(app)).toBe('/login')
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('用户名')))
  })

  it('重试之后得到"登录已过期"：转到登录页，焦点交给"登录已过期"的说明（读屏先读到它，DEF-047）', async () => {
    const check = controlled(server)
    const api = installFakeApi({ 'GET /api/auth/session': check.handler })
    const app = renderApp('/')
    await untilRequested(api, 'GET /api/auth/session', 2)
    const retry = within(await waitFor(() => blockWith('没能确认登录状态'))).getByRole('button', { name: '重试' })
    check.answer(() => apiError(401, 'SESSION_EXPIRED'))
    retry.focus()
    fireEvent.click(retry)
    const notice = (await screen.findByText('登录已过期，请重新登录')).closest('[role="status"]')
    expect(notice).not.toBeNull()
    expect(currentPath(app)).toBe('/login?reason=expired')
    await waitFor(() => expect(document.activeElement).toBe(notice))
  })
})

describe('一次性链接（邀请与重置密码）的查看', () => {
  const TOKEN = `${'t'.repeat(40)}-_x`
  const INSPECT_KEY = 'POST /api/auth/invitations/inspect'

  it('查看失败、按"重试"：重试期间说明与按钮留着；又失败时换成新的原因；取到之后焦点交给页面标题', async () => {
    const inspect = controlled(server)
    const api = installFakeApi({ [INSPECT_KEY]: inspect.handler })
    renderApp(`/invite#${TOKEN}`)
    await retryFlow({
      api,
      key: INSPECT_KEY,
      endpoint: inspect,
      problem: () => blockWith('没能核对邀请链接'),
      loading: '正在核对邀请链接…',
      ok: () => json(200, { username: 'zhang.san', displayName: '张三', expiresAt: '2026-10-05T00:00:00.000Z' }),
      target: () => screen.getByRole('heading', { level: 1, name: '接受邀请' }),
    })
    expect(screen.getByText('zhang.san')).toBeInTheDocument()
  })

  it('重试之后得到"链接不能用"：说明原因，焦点同样交给页面标题', async () => {
    const inspect = controlled(server)
    const api = installFakeApi({ [INSPECT_KEY]: inspect.handler })
    renderApp(`/invite#${TOKEN}`)
    await untilRequested(api, INSPECT_KEY, 2)
    const retry = within(await waitFor(() => blockWith('没能核对邀请链接'))).getByRole('button', { name: '重试' })
    inspect.answer(() => json(410, { error: { code: 'LINK_INVALID', message: '说明', requestId: 'req-1', details: { reason: 'expired' } } }))
    retry.focus()
    fireEvent.click(retry)
    expect(await screen.findByText('邀请链接已过期，请管理员重新发送')).toBeInTheDocument()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: '接受邀请' })))
  })
})

describe('空间页', () => {
  const SPACE_PATH = `/spaces/${TEAM_ID}`

  it('页头（空间本身）第一次就没取到、按"重试"：重试期间页面的说明与按钮留着（浏览器标签页的标题照旧）；取到之后焦点交给页面的标题', async () => {
    const space = controlled(server)
    const api = loggedIn({ [SPACE_KEY]: space.handler })
    renderApp(SPACE_PATH)
    await untilRequested(api, SPACE_KEY, 2)
    expect(await screen.findByRole('heading', { level: 1, name: '空间加载失败' })).toBeInTheDocument()
    await retryFlow({
      api,
      key: SPACE_KEY,
      endpoint: space,
      problem: () => within(screen.getByRole('heading', { level: 1, name: '空间加载失败' }).parentElement as HTMLElement).getByRole('alert'),
      loading: '正在加载空间…',
      ok: () => json(200, team()),
      target: () => screen.getByRole('heading', { level: 1, name: '市场部' }),
    })
  })

  it('页头重试期间浏览器标签页的标题照旧是"空间加载失败"', async () => {
    const space = controlled(server)
    const api = loggedIn({ [SPACE_KEY]: space.handler })
    renderApp(SPACE_PATH)
    await untilRequested(api, SPACE_KEY, 2)
    const retry = await screen.findByRole('button', { name: '重试' })
    await waitFor(() => expect(document.title).toBe('空间加载失败 - NerveOffice'))
    space.hold()
    retry.focus()
    fireEvent.click(retry)
    await waitFor(() => expect(retry).toHaveTextContent('正在重试…'))
    await advance(50)
    expect(document.title).toBe('空间加载失败 - NerveOffice')
    space.answer(() => json(200, team()))
    space.release()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: '市场部' })))
  })

  it('页头重试之后得到 404：换成"空间不存在"，焦点交给那条说明', async () => {
    const space = controlled(server)
    const api = loggedIn({ [SPACE_KEY]: space.handler })
    renderApp(SPACE_PATH)
    await untilRequested(api, SPACE_KEY, 2)
    const retry = await screen.findByRole('button', { name: '重试' })
    space.answer(() => apiError(404, 'NOT_FOUND'))
    retry.focus()
    fireEvent.click(retry)
    const notFound = (await screen.findByText('空间不存在，或者你没有访问权限')).closest('[role="alert"]')
    await waitFor(() => expect(document.activeElement).toBe(notFound))
  })

  it('子文件夹第一次就没取到、按"重试"：重试期间说明与按钮留着；取到之后焦点交给页面的标题', async () => {
    const folders = controlled(server)
    const api = loggedIn({ [foldersKey(TEAM_ID)]: folders.handler })
    renderApp(SPACE_PATH)
    await retryFlow({
      api,
      key: foldersKey(TEAM_ID),
      endpoint: folders,
      problem: () => alertWith('文件夹列表加载失败'),
      loading: '正在加载文件夹…',
      ok: () => json(200, { items: [], truncated: false }),
      target: () => screen.getByRole('heading', { level: 1, name: '市场部' }),
    })
  })

  it('文档列表第一次就没取到、按"重试"：重试期间说明与按钮留着；取到之后焦点交给页面的标题', async () => {
    const documents = controlled(server)
    const api = loggedIn({ [teamKey('/api/documents')]: documents.handler })
    renderApp(SPACE_PATH)
    await retryFlow({
      api,
      key: teamKey('/api/documents'),
      endpoint: documents,
      problem: () => alertWith('文档列表加载失败'),
      loading: '正在加载文档列表…',
      ok: () => json(200, { items: [WEEKLY], nextCursor: null }),
      target: () => screen.getByRole('heading', { level: 1, name: '市场部' }),
    })
    expect(screen.getByRole('link', { name: /周报/ })).toBeInTheDocument()
  })
})

describe('空间页的行内操作', () => {
  const DETAIL_KEY = `GET /api/documents/${WEEKLY_ID}`

  it('展开时可以做的操作第一次就没取到、按"重试"：重试期间说明与按钮留着；取到之后焦点交给面板里的"取消"（不跳到页面的标题）', async () => {
    const actions = controlled(server)
    const api = loggedIn({ [DETAIL_KEY]: actions.handler })
    renderApp('/')
    fireEvent.click(await screen.findByRole('button', { name: '操作 周报' }))
    await retryFlow({
      api,
      key: DETAIL_KEY,
      endpoint: actions,
      problem: () => alertWith(`没能确认可以做哪些操作：${SERVER}`).parentElement as HTMLElement,
      loading: '正在确认可以做哪些操作…',
      ok: () => json(200, detail()),
      target: () => screen.getByRole('button', { name: '取消' }),
    })
    expect(screen.getByRole('button', { name: '改名' })).toBeInTheDocument()
  })

  it('重试期间说的是"没能确认可以做哪些操作"（不再给上一次的原因）', async () => {
    const actions = controlled(server)
    const api = loggedIn({ [DETAIL_KEY]: actions.handler })
    renderApp('/')
    fireEvent.click(await screen.findByRole('button', { name: '操作 周报' }))
    await untilRequested(api, DETAIL_KEY, 2)
    const retry = await screen.findByRole('button', { name: '重试' })
    actions.hold()
    retry.focus()
    fireEvent.click(retry)
    await waitFor(() => expect(retry).toHaveTextContent('正在重试…'))
    expect(screen.getByRole('alert')).toHaveTextContent(/^没能确认可以做哪些操作$/)
    actions.answer(() => json(200, detail()))
    actions.release()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: '取消' })))
  })

  it('复制的目标空间没能加载、按"重试"：重试期间说明与按钮留着；取到之后焦点交给"目标位置"这一行（随即选上的默认目标）', async () => {
    const spaces = controlled(server)
    const api = loggedIn({ 'GET /api/spaces': spaces.handler, [DETAIL_KEY]: () => json(200, { ...detail(), permissions: { ...detail().permissions, canMoveAcrossSpaces: false } }) })
    renderApp('/')
    // 导航的空间列表没能加载（自动重试一次）
    await untilRequested(api, 'GET /api/spaces', 2)
    fireEvent.click(await screen.findByRole('button', { name: '操作 周报' }))
    fireEvent.click(await screen.findByRole('button', { name: '复制' }))
    const form = await screen.findByRole('form', { name: '复制' })
    await retryFlow({
      api,
      key: 'GET /api/spaces',
      endpoint: spaces,
      problem: () => within(form).getByRole('alert'),
      loading: '正在加载可以复制到的空间…',
      ok: () => json(200, { items: [team()] }),
      target: () => within(form).getByText('目标位置：'),
    })
    expect(within(form).getByText('目标位置：')).toHaveTextContent('目标位置：市场部')
  })

  it('复制到另一个空间、它的子文件夹第一次就没取到，按"重试"：重试期间说明与按钮留着；取到之后焦点交给"目标位置"这一行（DEF-046）', async () => {
    const folders = controlled(server)
    const api = loggedIn({ [foldersKey(TEAM_ID)]: folders.handler, [DETAIL_KEY]: () => json(200, detail()) })
    renderApp('/')
    fireEvent.click(await screen.findByRole('button', { name: '操作 周报' }))
    fireEvent.click(await screen.findByRole('button', { name: '复制' }))
    const form = await screen.findByRole('form', { name: '复制' })
    // 换到市场部：它的子文件夹还没取过（首页取的是我的空间的）
    fireEvent.change(within(form).getByLabelText('目标空间'), { target: { value: TEAM_ID } })
    await retryFlow({
      api,
      key: foldersKey(TEAM_ID),
      endpoint: folders,
      problem: () => alertWith(`目标位置加载失败：${SERVER}`),
      loading: '正在加载目标位置…',
      ok: () => json(200, { items: [rootFolder(TEAM_ID, '方案')], truncated: false }),
      target: () => within(form).getByText('目标位置：'),
      // 重试期间不再给上一次的原因（请求缓存已经清掉了它）
      whileRetrying: () => expect(within(form).getByText('目标位置加载失败')).toBeInTheDocument(),
    })
    expect(within(form).getByText('目标位置：')).toHaveTextContent('目标位置：市场部')
    expect(within(form).getByRole('button', { name: '进入 方案' })).toBeInTheDocument()
  })

  it('移动时点进的文件夹第一次就没取到，按"重试"：重试期间说明与按钮留着；取到之后焦点交给"目标位置"这一行（DEF-046）', async () => {
    const folders = controlled(server)
    const personal = SESSION.personalSpace.id
    const api = loggedIn({
      [foldersKey(personal)]: () => json(200, { items: [rootFolder(personal, '方案')], truncated: false }),
      [foldersKey(personal, PLAN_ID)]: folders.handler,
      [DETAIL_KEY]: () => json(200, detail()),
    })
    renderApp('/')
    fireEvent.click(await screen.findByRole('button', { name: '操作 周报' }))
    fireEvent.click(await screen.findByRole('button', { name: '移动' }))
    const form = await screen.findByRole('form', { name: '移动' })
    fireEvent.click(await within(form).findByRole('button', { name: '进入 方案' }))
    await retryFlow({
      api,
      key: foldersKey(personal, PLAN_ID),
      endpoint: folders,
      problem: () => alertWith(`目标位置加载失败：${SERVER}`),
      loading: '正在加载目标位置…',
      ok: () => json(200, { items: [], truncated: false }),
      target: () => within(form).getByText('目标位置：'),
    })
    expect(within(form).getByText('目标位置：')).toHaveTextContent('目标位置：我的空间 / 方案')
    expect(within(form).getByText('这里没有子文件夹')).toBeInTheDocument()
  })
})

describe('回收站页', () => {
  const TRASH_PATH = `/spaces/${TEAM_ID}/trash`

  it('页头（空间本身）第一次就没取到、按"重试"：重试期间页面的说明与按钮留着；取到之后焦点交给页面的标题', async () => {
    const space = controlled(server)
    const api = loggedIn({ [SPACE_KEY]: space.handler })
    renderApp(TRASH_PATH)
    await untilRequested(api, SPACE_KEY, 2)
    await retryFlow({
      api,
      key: SPACE_KEY,
      endpoint: space,
      problem: () => within(screen.getByRole('heading', { level: 1, name: '回收站加载失败' }).parentElement as HTMLElement).getByRole('alert'),
      loading: '正在加载回收站…',
      ok: () => json(200, team()),
      target: () => screen.getByRole('heading', { level: 1, name: '市场部 的回收站' }),
    })
  })

  it('列表第一次就没取到、按"重试"：重试期间说明与按钮留着；取到之后焦点交给页面的标题', async () => {
    const trash = controlled(server)
    const api = loggedIn({ [teamKey('/api/trash')]: trash.handler })
    renderApp(TRASH_PATH)
    await retryFlow({
      api,
      key: teamKey('/api/trash'),
      endpoint: trash,
      problem: () => alertWith('回收站加载失败'),
      loading: '正在加载回收站…',
      ok: () => json(200, { items: [], nextCursor: null }),
      target: () => screen.getByRole('heading', { level: 1, name: '市场部 的回收站' }),
    })
    expect(screen.getByText('回收站里没有内容')).toBeInTheDocument()
  })
})

describe('成员页', () => {
  const MEMBERS_PATH = `/spaces/${TEAM_ID}/members`
  const MEMBERS_KEY = `GET /api/spaces/${TEAM_ID}/members`
  const MEMBERS: SpaceMemberListResponse = {
    space: { id: TEAM_ID, name: '市场部', status: 'active', visibleToAll: false },
    canManage: false,
    items: [{ user: SESSION.user, role: 'viewer', status: 'active', createdAt: '2026-09-29T01:00:00.000Z' }],
  }

  it('第一次就没取到、按"重试"：重试期间页面的说明与按钮留着；取到之后焦点交给页面的标题', async () => {
    const members = controlled(server)
    const api = loggedIn({ [MEMBERS_KEY]: members.handler })
    renderApp(MEMBERS_PATH)
    await untilRequested(api, MEMBERS_KEY, 2)
    await retryFlow({
      api,
      key: MEMBERS_KEY,
      endpoint: members,
      problem: () => within(screen.getByRole('heading', { level: 1, name: '成员列表加载失败' }).parentElement as HTMLElement).getByRole('alert'),
      loading: '正在加载成员…',
      ok: () => json(200, MEMBERS),
      target: () => screen.getByRole('heading', { level: 1, name: '市场部 的成员' }),
    })
  })

  it('重试之后得到 403（不能查看成员）：说明服务端给的原因，焦点交给那一页的标题', async () => {
    const members = controlled(server)
    const api = loggedIn({ [MEMBERS_KEY]: members.handler })
    renderApp(MEMBERS_PATH)
    await untilRequested(api, MEMBERS_KEY, 2)
    const retry = await screen.findByRole('button', { name: '重试' })
    members.answer(() => apiError(403, 'PERMISSION_DENIED', '个人空间没有成员'))
    retry.focus()
    fireEvent.click(retry)
    expect(await screen.findByText('个人空间没有成员')).toBeInTheDocument()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: '成员' })))
  })
})

describe('"与我共享"', () => {
  it('第一次就没取到、按"重试"：重试期间说明与按钮留着；取到之后焦点交给页面的标题', async () => {
    const list = controlled(server)
    const api = loggedIn({ 'GET /api/shared': list.handler })
    renderApp('/shared')
    await retryFlow({
      api,
      key: 'GET /api/shared',
      endpoint: list,
      problem: () => alertWith('分享给你的文档没能加载'),
      loading: '正在加载分享给你的文档…',
      ok: () => json(200, { items: [], nextCursor: null }),
      target: () => screen.getByRole('heading', { level: 1, name: '与我共享' }),
    })
  })
})

describe('管理界面', () => {
  const LEAVER: AdminUser = { ...AMY, status: 'disabled' }
  const ACCOUNT_KEY = `GET /api/admin/users/${AMY.id}`
  const TRANSFER_PATH = `/admin/users/${AMY.id}/documents`

  function admin(handlers: Record<string, Handler>): FakeApi {
    return installFakeApi({
      ...SPACES,
      'GET /api/auth/session': () => json(200, session('admin')),
      [`GET /api/admin/users/${AMY.id}/documents`]: () => json(200, listPage([])),
      ...handlers,
    })
  }

  it('转移页的账户第一次就没取到、按"重试"：重试期间说明与按钮留着；取到之后焦点交给标题', async () => {
    const account = controlled(server)
    const api = admin({ [ACCOUNT_KEY]: account.handler })
    renderApp(TRANSFER_PATH)
    await retryFlow({
      api,
      key: ACCOUNT_KEY,
      endpoint: account,
      problem: () => alertWith('账户加载失败'),
      loading: '正在加载账户…',
      ok: () => json(200, LEAVER),
      target: () => screen.getByRole('heading', { name: '转移 @amy 艾米 的文档' }),
    })
  })

  it('转移页的账户重试之后得到 404：说明不存在，焦点交给那条说明', async () => {
    const account = controlled(server)
    const api = admin({ [ACCOUNT_KEY]: account.handler })
    renderApp(TRANSFER_PATH)
    await untilRequested(api, ACCOUNT_KEY, 2)
    const retry = within(await waitFor(() => alertWith('账户加载失败'))).getByRole('button', { name: '重试' })
    account.answer(() => apiError(404, 'NOT_FOUND'))
    retry.focus()
    fireEvent.click(retry)
    const missing = (await screen.findByText('内容不存在，或者你没有访问权限')).closest('[role="alert"]')
    await waitFor(() => expect(document.activeElement).toBe(missing))
    expect(screen.getByRole('link', { name: '返回账户' })).toBeInTheDocument()
  })

  it('审计页按人筛选的候选查找失败、按"重试"：重试期间说明与按钮留着（不换成"正在查找…"）；找到之后焦点交给找操作者的输入框', async () => {
    const candidates = controlled(server)
    const CANDIDATES_KEY = `GET /api/admin/users?${new URLSearchParams({ query: 'amy' }).toString()}`
    const api = admin({ 'GET /api/admin/audit-events': () => json(200, listPage([])), [CANDIDATES_KEY]: candidates.handler })
    renderApp('/admin/audit')
    const input = await screen.findByLabelText('按名字找操作者')
    fireEvent.change(input, { target: { value: 'amy' } })
    await retryFlow({
      api,
      key: CANDIDATES_KEY,
      endpoint: candidates,
      problem: () => alertWith(`查找失败：${SERVER}`),
      loading: '正在查找…',
      ok: () => json(200, listPage([AMY])),
      target: () => screen.getByLabelText('按名字找操作者'),
      // 查找的进展（状态区）不说"正在查找…"：说明本身就在说正在重试
      whileRetrying: () => expect(screen.queryByText('正在查找…')).toBeNull(),
    })
    expect(screen.getByRole('button', { name: '@amy 艾米' })).toBeInTheDocument()
  })
})
