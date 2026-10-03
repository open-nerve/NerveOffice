// 管理界面：团队空间与停用者文档的转移（M2-P2 设计 §3.10，US-M2-04、05）。接口用假的 fetch。
import type { AdminSpace, AdminUser } from '@nerve-office/contracts'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { OUTCOME_REFRESH_TIME_LIMIT_MS } from '../shared/api/write-outcome.ts'
import { watchAnnouncement } from '../shared/testing/announcement.test-support.ts'
import { apiError, installFakeApi, json, networkFailure } from '../shared/testing/fake-api.test-support.ts'
import { plainName } from '../shared/testing/people.test-support.ts'
import { AMY, deferred, listPage, ROOT_ID, rowOf, session, settle, SPACES } from './admin.test-support.ts'
import { renderApp } from './render-app.test-support.tsx'

const SPACE: AdminSpace = { id: '0199a2c4-0000-7000-8000-0000000000c1', name: '市场部', status: 'active', visibleToAll: false, memberCount: 3, createdAt: '2026-09-29T01:00:00.000Z', myRole: null }
const BEN = { id: '0199a2c4-0000-7000-8000-00000000000b', username: 'ben', displayName: '本' }
/** 同事目录里的系统管理员本人（session('admin') 的账户） */
const ROOT_SUMMARY = { id: ROOT_ID, username: 'root', displayName: '管理员' }

function search(query: Record<string, string>): string {
  return `?${new URLSearchParams(query).toString()}`
}

function admin(handlers: Parameters<typeof installFakeApi>[0] = {}) {
  return installFakeApi({ ...SPACES, 'GET /api/auth/session': () => json(200, session('admin')), ...handlers })
}

function lastBody(api: ReturnType<typeof installFakeApi>, key: string): unknown {
  return api.requests.filter(request => request.key === key).at(-1)?.body
}

function requestCount(api: ReturnType<typeof installFakeApi>, key: string): number {
  return api.requests.filter(request => request.key === key).length
}

describe('US-M2-05 管理界面：团队空间', () => {
  it('列表：名称、状态、全员可见、成员数、我的角色；每行的操作带着空间的名称', async () => {
    admin({ 'GET /api/admin/spaces': () => json(200, listPage([SPACE, { ...SPACE, id: '0199a2c4-0000-7000-8000-0000000000c2', name: '旧项目', status: 'archived', visibleToAll: true, myRole: 'viewer' }])) })
    renderApp('/admin/spaces')
    const row = await rowOf('市场部')
    expect(within(row).getByText('没有加入')).toBeInTheDocument()
    expect(within(row).getByRole('link', { name: '成员 市场部' })).toHaveAttribute('href', `/spaces/${SPACE.id}/members`)
    expect(within(row).getByRole('button', { name: '归档 市场部' })).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: '加入空间 市场部' })).toBeInTheDocument()
    const archived = await rowOf('旧项目')
    expect(within(archived).getByRole('button', { name: '恢复 旧项目' })).toBeInTheDocument()
    expect(within(archived).getByRole('button', { name: '取消全员可见 旧项目' })).toBeInTheDocument()
    expect(within(archived).queryByRole('button', { name: '加入空间 旧项目' })).not.toBeInTheDocument()
  })

  it('创建：名称、按名字选首个空间管理员、全员可见；还不能创建时按钮下方说明原因；成功之后整个表单清空（审查 B5、B11）', async () => {
    let spaces: AdminSpace[] = []
    const api = admin({
      'GET /api/admin/spaces': () => json(200, listPage(spaces)),
      [`GET /api/users${search({ query: '本' })}`]: () => json(200, { items: [BEN] }),
      'POST /api/admin/spaces': () => {
        spaces = [SPACE]
        return json(201, SPACE)
      },
    })
    renderApp('/admin/spaces')
    const form = await screen.findByRole('form', { name: '创建团队空间' })
    const submit = within(form).getByRole('button', { name: '创建团队空间' })
    expect(submit).toHaveAttribute('aria-disabled', 'true')
    expect(submit).toHaveAccessibleDescription('请先选择首个空间管理员')
    fireEvent.change(within(form).getByLabelText('首个空间管理员'), { target: { value: '本' } })
    fireEvent.click(await within(form).findByRole('button', { name: '@ben 本' }))
    // 选好了空间管理员，名称还是空的：说明名称的要求
    expect(submit).toHaveAttribute('aria-disabled', 'true')
    expect(submit).toHaveAccessibleDescription(/名称/)
    fireEvent.change(within(form).getByLabelText('名称'), { target: { value: ' 市场部 ' } })
    expect(submit).toHaveAttribute('aria-disabled', 'false')
    expect(submit).not.toHaveAccessibleDescription()
    fireEvent.click(within(form).getByLabelText('全员可见：所有有效账户（包括你自己）都能以查看者的身份看到它的内容'))
    fireEvent.click(submit)
    expect(await rowOf('市场部')).toBeInTheDocument()
    expect(lastBody(api, 'POST /api/admin/spaces')).toEqual({ name: '市场部', adminUserId: BEN.id, visibleToAll: true })
    await waitFor(() => expect(within(form).getByLabelText('名称')).toHaveValue(''))
    // 同事选择也重新开始：关键词与上一次的候选都清掉
    expect(within(form).getByLabelText('首个空间管理员')).toHaveValue('')
    expect(within(form).queryByRole('list', { name: '找到的同事' })).toBeNull()
  })

  it('名称已被使用：说明原因，表单保留', async () => {
    admin({
      'GET /api/admin/spaces': () => json(200, listPage([])),
      [`GET /api/users${search({ query: '本' })}`]: () => json(200, { items: [BEN] }),
      'POST /api/admin/spaces': () => apiError(409, 'SPACE_NAME_TAKEN'),
    })
    renderApp('/admin/spaces')
    const form = await screen.findByRole('form', { name: '创建团队空间' })
    fireEvent.change(within(form).getByLabelText('名称'), { target: { value: '市场部' } })
    fireEvent.change(within(form).getByLabelText('首个空间管理员'), { target: { value: '本' } })
    fireEvent.click(await within(form).findByRole('button', { name: '@ben 本' }))
    fireEvent.click(within(form).getByRole('button', { name: '创建团队空间' }))
    expect(await within(form).findByRole('alert')).toHaveTextContent('已有同名的团队空间')
    expect(within(form).getByLabelText('名称')).toHaveValue('市场部')
  })

  it('归档：先确认后果；确认之后归档，列表刷新', async () => {
    let status: AdminSpace['status'] = 'active'
    const api = admin({
      'GET /api/admin/spaces': () => json(200, listPage([{ ...SPACE, status }])),
      [`POST /api/admin/spaces/${SPACE.id}/archive`]: () => {
        status = 'archived'
        return json(200, { ...SPACE, status })
      },
    })
    renderApp('/admin/spaces')
    fireEvent.click(within(await rowOf('市场部')).getByRole('button', { name: '归档 市场部' }))
    const dialog = await screen.findByRole('dialog', { name: '归档 市场部？' })
    expect(dialog).toHaveTextContent('归档之后所有人只能查看')
    fireEvent.click(within(dialog).getByRole('button', { name: '归档' }))
    expect(await within(await rowOf('市场部')).findByRole('button', { name: '恢复 市场部' })).toBeInTheDocument()
    expect(api.requests.some(request => request.key === `POST /api/admin/spaces/${SPACE.id}/archive`)).toBe(true)
  })

  it('恢复：先确认后果；确认之后恢复，列表刷新（审查 B14）', async () => {
    let status: AdminSpace['status'] = 'archived'
    const api = admin({
      'GET /api/admin/spaces': () => json(200, listPage([{ ...SPACE, status }])),
      [`POST /api/admin/spaces/${SPACE.id}/restore`]: () => {
        status = 'active'
        return json(200, { ...SPACE, status })
      },
    })
    renderApp('/admin/spaces')
    fireEvent.click(within(await rowOf('市场部')).getByRole('button', { name: '恢复 市场部' }))
    const dialog = await screen.findByRole('dialog', { name: '恢复 市场部？' })
    expect(dialog).toHaveTextContent('恢复之后，成员按原来的角色继续使用。')
    fireEvent.click(within(dialog).getByRole('button', { name: '恢复' }))
    expect(await within(await rowOf('市场部')).findByRole('button', { name: '归档 市场部' })).toBeInTheDocument()
    expect(requestCount(api, `POST /api/admin/spaces/${SPACE.id}/restore`)).toBe(1)
  })

  it('全员可见的开关：设为与取消都先确认后果；确认之后列表刷新（审查 B14）', async () => {
    let visibleToAll = false
    const api = admin({
      'GET /api/admin/spaces': () => json(200, listPage([{ ...SPACE, visibleToAll }])),
      [`PUT /api/admin/spaces/${SPACE.id}/visibility`]: (init) => {
        visibleToAll = (JSON.parse(String(init?.body)) as { visibleToAll: boolean }).visibleToAll
        return json(200, { ...SPACE, visibleToAll })
      },
    })
    renderApp('/admin/spaces')
    fireEvent.click(within(await rowOf('市场部')).getByRole('button', { name: '设为全员可见 市场部' }))
    const show = await screen.findByRole('dialog', { name: '把 市场部 设为全员可见？' })
    // 写明后果，包括系统管理员自己：打开之后他不必加入也能看到内容（需求方 2026-10-01 确认的规则）
    expect(show).toHaveTextContent('打开之后所有有效账户都能以查看者的身份看到这个空间里的内容，包括你自己。')
    fireEvent.click(within(show).getByRole('button', { name: '设为全员可见' }))
    const hideButton = await within(await rowOf('市场部')).findByRole('button', { name: '取消全员可见 市场部' })
    expect(within(await rowOf('市场部')).getByText('是')).toBeInTheDocument()

    fireEvent.click(hideButton)
    const hide = await screen.findByRole('dialog', { name: '取消 市场部 的全员可见？' })
    expect(hide).toHaveTextContent('不是成员的人随即看不到这个空间。')
    fireEvent.click(within(hide).getByRole('button', { name: '取消全员可见' }))
    expect(await within(await rowOf('市场部')).findByRole('button', { name: '设为全员可见 市场部' })).toBeInTheDocument()
    expect(api.requests.filter(request => request.key === `PUT /api/admin/spaces/${SPACE.id}/visibility`).map(request => request.body)).toEqual([{ visibleToAll: true }, { visibleToAll: false }])
  })

  it('加入空间：选角色，把自己加入（记审计的说明）；改名：弹窗里改', async () => {
    const api = admin({
      'GET /api/admin/spaces': () => json(200, listPage([SPACE])),
      [`POST /api/spaces/${SPACE.id}/members`]: () => json(201, { user: { id: ROOT_ID, username: 'root', displayName: '管理员' }, status: 'active', role: 'editor', createdAt: SPACE.createdAt }),
      [`PUT /api/spaces/${SPACE.id}/name`]: () => json(200, { id: SPACE.id, name: '市场与品牌部', status: 'active', visibleToAll: false }),
    })
    renderApp('/admin/spaces')
    fireEvent.click(within(await rowOf('市场部')).getByRole('button', { name: '加入空间 市场部' }))
    const join = await screen.findByRole('dialog', { name: '加入 市场部' })
    expect(join).toHaveTextContent('加入会记入审计')
    fireEvent.change(within(join).getByLabelText('以什么角色加入'), { target: { value: 'editor' } })
    fireEvent.click(within(join).getByRole('button', { name: '加入空间' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(lastBody(api, `POST /api/spaces/${SPACE.id}/members`)).toEqual({ userId: ROOT_ID, role: 'editor' })

    fireEvent.click(within(await rowOf('市场部')).getByRole('button', { name: '改名 市场部' }))
    const rename = await screen.findByRole('dialog', { name: '给 市场部 改名' })
    fireEvent.change(within(rename).getByLabelText('名称'), { target: { value: '市场与品牌部' } })
    fireEvent.click(within(rename).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(lastBody(api, `PUT /api/spaces/${SPACE.id}/name`)).toEqual({ name: '市场与品牌部' })
  })

  it('改名：名称不合法时除了标 aria-invalid，还用文字说明原因，输入框与保存按钮都指向它（WCAG 3.3.1，M2-P6 复核 S4 / P12）', async () => {
    admin({ 'GET /api/admin/spaces': () => json(200, listPage([SPACE])) })
    renderApp('/admin/spaces')
    fireEvent.click(within(await rowOf('市场部')).getByRole('button', { name: '改名 市场部' }))
    const dialog = await screen.findByRole('dialog', { name: '给 市场部 改名' })
    const input = within(dialog).getByLabelText('名称')
    expect(input).not.toHaveAccessibleDescription()
    fireEvent.change(input, { target: { value: '市场\u200B部' } })
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAccessibleDescription('名称不能包含看不见的字符（例如零宽空格）')
    expect(within(dialog).getByRole('button', { name: '保存' })).toHaveAccessibleDescription('名称不能包含看不见的字符（例如零宽空格）')
    expect(within(dialog).getByRole('button', { name: '保存' })).toHaveAttribute('aria-disabled', 'true')
  })

  it('改名：进行中关不掉（取消、×、Esc 都不关）；名称已被使用时弹窗留着说明原因；取消之后再打开不带着上一次的说明（审查 B4、B14）', async () => {
    const rename = deferred()
    const api = admin({
      'GET /api/admin/spaces': () => json(200, listPage([SPACE])),
      [`PUT /api/spaces/${SPACE.id}/name`]: rename.handler,
    })
    renderApp('/admin/spaces')
    fireEvent.click(within(await rowOf('市场部')).getByRole('button', { name: '改名 市场部' }))
    const dialog = await screen.findByRole('dialog', { name: '给 市场部 改名' })
    fireEvent.change(within(dialog).getByLabelText('名称'), { target: { value: '产品部' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    const busy = await within(dialog).findByRole('button', { name: '正在处理…' })
    expect(busy).toHaveAttribute('aria-disabled', 'true')
    expect(within(dialog).getByRole('button', { name: '取消' })).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(busy)
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await settle()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(requestCount(api, `PUT /api/spaces/${SPACE.id}/name`)).toBe(1)

    rename.resolve(apiError(409, 'SPACE_NAME_TAKEN'))
    // 说明写成"空格的种类与个数"不算区别：有没有空格仍然算区别（M2-P6 复验第二轮 G2）
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('已有同名的团队空间（大小写、全角与半角、空格的种类与个数、看不见的字符都不算区别，已归档的也算）')
    expect(dialog).toHaveAccessibleDescription('团队空间的名称不能与别的团队空间相同（大小写、全角与半角、空格的种类与个数、看不见的字符都不算区别，已归档的也算）。')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('名称')).toHaveValue('产品部')

    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(within(await rowOf('市场部')).getByRole('button', { name: '改名 市场部' }))
    const again = await screen.findByRole('dialog', { name: '给 市场部 改名' })
    expect(within(again).queryByRole('alert')).toBeNull()
    expect(within(again).getByLabelText('名称')).toHaveValue('市场部')
  })

  it('改名的结果未知（其实已经改好）：列表随即刷新、这一行是新名称；弹窗说明可能已经生效、页面已刷新，可以再保存（第二批 G-2，第三批 S-c）', async () => {
    let name = '市场部'
    const api = admin({
      'GET /api/admin/spaces': () => json(200, listPage([{ ...SPACE, name }])),
      [`PUT /api/spaces/${SPACE.id}/name`]: () => {
        // 服务端已经改好，回包却丢了
        name = '市场与品牌部'
        return apiError(500, 'INTERNAL_ERROR')
      },
    })
    renderApp('/admin/spaces')
    fireEvent.click(within(await rowOf('市场部')).getByRole('button', { name: '改名 市场部' }))
    const dialog = await screen.findByRole('dialog', { name: '给 市场部 改名' })
    fireEvent.change(within(dialog).getByLabelText('名称'), { target: { value: '市场与品牌部' } })
    const listed = requestCount(api, 'GET /api/admin/spaces')
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('没能确认是否已经完成（服务器出了点问题，请稍后重试）。可能已经生效：页面已按服务端现在的状态刷新，看得出是否已经生效；还没有的话，可以再试一次。')
    expect(requestCount(api, 'GET /api/admin/spaces')).toBeGreaterThan(listed)
    expect(await rowOf('市场与品牌部')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: '保存' })).toHaveAttribute('aria-disabled', 'false')
  })

  it('改名的结果未知，随后的刷新一直不回来（服务端挂起）：到了时限先说明页面没能刷新，弹窗不再卡在"正在处理…"，取消关得掉（第三批 S-a、G-a）', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      let lists = 0
      admin({
        'GET /api/admin/spaces': async () => {
          lists += 1
          return lists === 1 ? json(200, listPage([SPACE])) : new Promise<Response>(() => {})
        },
        [`PUT /api/spaces/${SPACE.id}/name`]: () => apiError(504, 'INTERNAL_ERROR'),
      })
      renderApp('/admin/spaces')
      fireEvent.click(within(await rowOf('市场部')).getByRole('button', { name: '改名 市场部' }))
      const dialog = await screen.findByRole('dialog', { name: '给 市场部 改名' })
      fireEvent.change(within(dialog).getByLabelText('名称'), { target: { value: '产品部' } })
      fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
      await waitFor(() => expect(lists).toBe(2))
      // 时限之前仍在等刷新；留出 2 秒的余量，测试本身的耗时不会让时限提前到
      await act(async () => vi.advanceTimersByTimeAsync(OUTCOME_REFRESH_TIME_LIMIT_MS - 2_000))
      expect(within(dialog).getByRole('button', { name: '正在处理…' })).toBeInTheDocument()
      await act(async () => vi.advanceTimersByTimeAsync(2_000))
      expect(await within(dialog).findByRole('alert')).toHaveTextContent('没能确认是否已经完成（服务器出了点问题，请稍后重试）。可能已经生效，只是页面没能刷新，显示的可能还是之前的状态：请稍后再看；确认还没有生效的话，可以再试一次。')
      fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('加入空间：进行中关不掉；失败时弹窗留着说明原因（审查 B4）', async () => {
    const join = deferred()
    const api = admin({
      'GET /api/admin/spaces': () => json(200, listPage([SPACE])),
      [`POST /api/spaces/${SPACE.id}/members`]: join.handler,
    })
    renderApp('/admin/spaces')
    fireEvent.click(within(await rowOf('市场部')).getByRole('button', { name: '加入空间 市场部' }))
    const dialog = await screen.findByRole('dialog', { name: '加入 市场部' })
    fireEvent.click(within(dialog).getByRole('button', { name: '加入空间' }))
    expect(await within(dialog).findByRole('button', { name: '正在处理…' })).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await settle()
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    // 已经是成员（M2-P6 复核 S1）：列表显示的已经过时，随之刷新；弹窗留着。前面没有结果未知的加入，不说"可能就是刚才那一次"（第五批 G5）
    const listed = api.requests.filter(request => request.key === 'GET /api/admin/spaces').length
    join.resolve(apiError(409, 'ALREADY_MEMBER'))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/^你已经是这个空间的成员了。列表已刷新。$/)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await waitFor(() => expect(api.requests.filter(request => request.key === 'GET /api/admin/spaces').length).toBeGreaterThan(listed))
  })

  it('加入空间的结果未知，关掉弹窗再打开、再加入得到"已经是成员"：说可能就是刚才那一次；别的空间得到"已经是成员"只说已经是成员（第五批 G5）', async () => {
    const other: AdminSpace = { ...SPACE, id: '0199a2c4-0000-7000-8000-0000000000c2', name: '产品部' }
    let posts = 0
    admin({
      'GET /api/admin/spaces': () => json(200, listPage([SPACE, other])),
      [`POST /api/spaces/${SPACE.id}/members`]: () => {
        posts += 1
        return posts === 1 ? apiError(502, 'INTERNAL_ERROR') : apiError(409, 'ALREADY_MEMBER')
      },
      [`POST /api/spaces/${other.id}/members`]: () => apiError(409, 'ALREADY_MEMBER'),
    })
    renderApp('/admin/spaces')
    fireEvent.click(within(await rowOf('市场部')).getByRole('button', { name: '加入空间 市场部' }))
    let dialog = await screen.findByRole('dialog', { name: '加入 市场部' })
    fireEvent.click(within(dialog).getByRole('button', { name: '加入空间' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/^没能确认是否已经加入/)
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    // 别的空间：前面没有结果未知的加入
    fireEvent.click(within(await rowOf('产品部')).getByRole('button', { name: '加入空间 产品部' }))
    dialog = await screen.findByRole('dialog', { name: '加入 产品部' })
    fireEvent.click(within(dialog).getByRole('button', { name: '加入空间' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/^你已经是这个空间的成员了。列表已刷新。$/)
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    // 回到结果未知的那个空间：多半就是刚才那一次
    fireEvent.click(within(await rowOf('市场部')).getByRole('button', { name: '加入空间 市场部' }))
    dialog = await screen.findByRole('dialog', { name: '加入 市场部' })
    fireEvent.click(within(dialog).getByRole('button', { name: '加入空间' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('你已经是这个空间的成员了，可能就是刚才没能确认的那一次加入。列表已刷新。')
  })

  it('换了过滤条件、过滤的请求还在路上时创建成功：那个请求取消重来，列表显示刚建好的空间，不停在"没有符合条件的"（第五批 G6）', async () => {
    const created: AdminSpace = { ...SPACE, memberCount: 1 }
    let spaces: AdminSpace[] = []
    let release: () => void = () => {}
    const filtered: boolean[] = []
    admin({
      'GET /api/admin/spaces': () => json(200, listPage(spaces)),
      [`GET /api/admin/spaces${search({ query: '市场' })}`]: async () => {
        // 发出时有没有建好：第一次过滤的请求慢，创建在它回来之前完成，它带回来的是创建之前的结果
        const snapshot = spaces
        filtered.push(snapshot.length > 0)
        if (filtered.length === 1) {
          await new Promise<void>((resolve) => {
            release = resolve
          })
        }
        return json(200, listPage(snapshot))
      },
      [`GET /api/users${search({ query: '本' })}`]: () => json(200, { items: [BEN] }),
      'POST /api/admin/spaces': () => {
        spaces = [created]
        return json(201, created)
      },
    })
    renderApp('/admin/spaces')
    const form = await screen.findByRole('form', { name: '创建团队空间' })
    await screen.findByText('没有符合条件的团队空间')
    fireEvent.change(within(form).getByLabelText('首个空间管理员'), { target: { value: '本' } })
    fireEvent.click(await within(form).findByRole('button', { name: '@ben 本' }))
    fireEvent.change(within(form).getByLabelText('名称'), { target: { value: '市场部' } })
    // 换关键词：去抖之后过滤的请求发出、挂着（还没有数据）
    fireEvent.change(screen.getByLabelText('按名称搜索'), { target: { value: '市场' } })
    await waitFor(() => expect(filtered).toHaveLength(1), { timeout: 3000 })
    fireEvent.click(within(form).getByRole('button', { name: '创建团队空间' }))
    // 创建成功之后的刷新：在路上的那一次取消、重新请求（这一次带回刚建好的）
    await waitFor(() => expect(filtered).toEqual([false, true]))
    release()
    expect(await rowOf('市场部')).toBeInTheDocument()
    await settle()
    expect(screen.queryByText('没有符合条件的团队空间')).toBeNull()
  })
})

const LEAVER: AdminUser = { ...AMY, status: 'disabled' }
const DOCUMENTS_KEY = `GET /api/admin/users/${AMY.id}/documents`
const TRANSFER_KEY = `POST /api/admin/users/${AMY.id}/documents/transfer`

/** 停用者个人空间里的文档（只有标题） */
function titles(count: number) {
  return Array.from({ length: count }, (_, index) => ({ id: `0199a2c4-0000-7000-8000-${index.toString(16).padStart(12, '0')}`, title: `文档 ${index}`, type: 'sheet', updatedAt: '2026-09-29T01:00:00.000Z' }))
}

describe('US-M2-04 转移停用者的文档', () => {
  it('账户页：停用的账户才有"转移文档"', async () => {
    admin({ 'GET /api/admin/users': () => json(200, listPage([LEAVER, { ...AMY, id: '0199a2c4-0000-7000-8000-000000000099', username: 'bea', displayName: '贝亚' }])) })
    renderApp('/admin/users')
    expect(within(await rowOf('amy')).getByRole('link', { name: `转移文档 ${plainName('艾米', 'amy')}` })).toHaveAttribute('href', `/admin/users/${AMY.id}/documents`)
    expect(within(await rowOf('bea')).queryByRole('link', { name: /^转移文档/ })).not.toBeInTheDocument()
  })

  it('只看得到标题；选文档与团队空间，确认之后整批转移，说明结果，列表刷新；焦点回到"转移"（审查 B2、B10）', async () => {
    let items = titles(3)
    const api = admin({
      [`GET /api/admin/users/${AMY.id}`]: () => json(200, LEAVER),
      [DOCUMENTS_KEY]: () => json(200, listPage(items)),
      [`GET /api/admin/spaces${search({ query: '市场', status: 'active' })}`]: () => json(200, listPage([SPACE])),
      [TRANSFER_KEY]: () => {
        items = items.slice(2)
        return json(200, { transferred: 2 })
      },
    })
    renderApp(`/admin/users/${AMY.id}/documents`)
    expect(await screen.findByRole('heading', { name: '转移 @amy 艾米 的文档' })).toBeInTheDocument()
    fireEvent.click(await screen.findByLabelText('选择 文档 0'))
    fireEvent.click(screen.getByLabelText('选择 文档 1'))
    expect(screen.getByText('已选择 2 份，一次最多 100 份')).toBeInTheDocument()
    const submit = screen.getByRole('button', { name: '转移' })
    expect(submit).toHaveAttribute('aria-disabled', 'true')
    expect(submit).toHaveAccessibleDescription('请先选择转移到哪里')

    // 目标团队空间：标签是选的对象，怎么找写在提示里；选中之后标签仍在，"重新选择"带上它（审查 B10）
    const team = screen.getByLabelText('目标团队空间')
    expect(team).toHaveAttribute('placeholder', '按名称搜索团队空间')
    fireEvent.change(team, { target: { value: '市场' } })
    fireEvent.click(within(await screen.findByRole('list', { name: '找到的团队空间' })).getByRole('button', { name: '市场部' }))
    expect(screen.getByText('目标团队空间')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新选择 目标团队空间' })).toBeInTheDocument()
    expect(submit).not.toHaveAccessibleDescription()

    // 结果的说明：容器一开始就在（空的），结果出来时往里填文字，读屏软件才会播报
    const result = screen.getByRole('status')
    expect(result).toBeEmptyDOMElement()
    // WebKit 点按钮时不聚焦按钮：打开之前的焦点记不下来
    ;(document.activeElement as HTMLElement | null)?.blur()
    fireEvent.click(submit)
    const dialog = await screen.findByRole('dialog', { name: '把 2 份文档转移到 市场部？' })
    const announced = watchAnnouncement('已把 2 份文档转移到 市场部')
    fireEvent.click(within(dialog).getByRole('button', { name: '转移' }))
    await waitFor(() => expect(result).toHaveTextContent('已把 2 份文档转移到 市场部'))
    // 等确认的弹窗关掉之后才写进去（M2-P5 复验 S1）：写进去的那一刻页面不在 aria-hidden 之下，焦点已经交还
    expect(announced()).toEqual({ ariaHidden: false, focusReturned: true })
    await waitFor(() => expect(screen.queryByText('文档 0')).not.toBeInTheDocument())
    expect(lastBody(api, TRANSFER_KEY)).toEqual({ documentIds: [titles(3)[0]?.id, titles(3)[1]?.id], target: { type: 'team', spaceId: SPACE.id } })
    await waitFor(() => expect(document.activeElement).toBe(submit))
  })

  it('转移到某人的个人空间：按名字选同事，不列出这个停用的人与操作者本人（审查 A7）；有文档已被别人转走时刷新列表、清掉不在了的选择，关闭弹窗，在转移按钮旁说明，焦点回到"转移"，不会原样重发（审查 B12，复验）', async () => {
    let items = titles(2)
    const api = admin({
      [`GET /api/admin/users/${AMY.id}`]: () => json(200, LEAVER),
      [DOCUMENTS_KEY]: () => json(200, listPage(items)),
      [`GET /api/users${search({ query: '本' })}`]: () => json(200, { items: [BEN, ROOT_SUMMARY, { id: AMY.id, username: 'amy', displayName: '艾米' }] }),
      [TRANSFER_KEY]: () => {
        // 文档 0 已经被别人转走了
        items = items.slice(1)
        return apiError(409, 'TRANSFER_CONFLICT')
      },
    })
    renderApp(`/admin/users/${AMY.id}/documents`)
    fireEvent.click(await screen.findByLabelText('全选已加载的文档'))
    expect(screen.getByText('已选择 2 份，一次最多 100 份')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: '某人的个人空间' }))
    fireEvent.change(screen.getByLabelText('接收文档的同事'), { target: { value: '本' } })
    const candidates = await screen.findByRole('list', { name: '找到的同事' })
    expect(within(candidates).getAllByRole('button').map(button => button.textContent)).toEqual(['@ben 本'])
    fireEvent.click(within(candidates).getByRole('button', { name: '@ben 本' }))
    const submit = screen.getByRole('button', { name: '转移' })
    submit.focus()
    fireEvent.click(submit)
    const dialog = await screen.findByRole('dialog', { name: `把 2 份文档转移到 ${plainName('本', 'ben')} 的个人空间？` })
    const announced = watchAnnouncement('有文档已经不在这个人的个人空间里了')
    fireEvent.click(within(dialog).getByRole('button', { name: '转移' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // 说明在页面上（弹窗之外），不在弹窗里；等弹窗关掉、页面不再被标为 aria-hidden、焦点交还之后才出现（M2-P5 复验 S1）
    expect(await screen.findByRole('alert')).toHaveTextContent('有文档已经不在这个人的个人空间里了（可能被别人转走了）：列表已刷新，请重新选择后再转移')
    expect(announced()).toEqual({ ariaHidden: false, focusReturned: true })
    expect(lastBody(api, TRANSFER_KEY)).toEqual({ documentIds: titles(2).map(document => document.id), target: { type: 'personal', userId: BEN.id } })
    // 列表刷新了，已经不在的文档不再算作选中
    expect(screen.queryByText('文档 0')).toBeNull()
    expect(screen.getByText('已选择 1 份，一次最多 100 份')).toBeInTheDocument()
    await waitFor(() => expect(document.activeElement).toBe(submit))
    expect(requestCount(api, TRANSFER_KEY)).toBe(1)

    // 再次打开确认的弹窗：按新的选择；上一次的说明清掉
    fireEvent.click(submit)
    expect(await screen.findByRole('dialog', { name: `把 1 份文档转移到 ${plainName('本', 'ben')} 的个人空间？` })).toBeInTheDocument()
    expect(screen.queryByText(/列表已刷新，请重新选择后再转移/)).toBeNull()
  })

  it('目标已归档等其他失败：弹窗留着说明原因，页面上不另外说明（复验）', async () => {
    const api = admin({
      [`GET /api/admin/users/${AMY.id}`]: () => json(200, LEAVER),
      [DOCUMENTS_KEY]: () => json(200, listPage(titles(1))),
      [`GET /api/admin/spaces${search({ query: '市场', status: 'active' })}`]: () => json(200, listPage([SPACE])),
      [TRANSFER_KEY]: () => apiError(409, 'SPACE_ARCHIVED'),
    })
    renderApp(`/admin/users/${AMY.id}/documents`)
    fireEvent.click(await screen.findByLabelText('选择 文档 0'))
    fireEvent.change(screen.getByLabelText('目标团队空间'), { target: { value: '市场' } })
    fireEvent.click(await screen.findByRole('button', { name: '市场部' }))
    fireEvent.click(screen.getByRole('button', { name: '转移' }))
    const dialog = await screen.findByRole('dialog', { name: '把 1 份文档转移到 市场部？' })
    fireEvent.click(within(dialog).getByRole('button', { name: '转移' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('目标空间已归档')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.queryByText(/列表已刷新，请重新选择后再转移/)).toBeNull()
    expect(requestCount(api, TRANSFER_KEY)).toBe(1)
  })

  it('转移的结果未知（其实已经转走）：列表刷新、转走的不再算作选中，弹窗说明可能已经转移；再点得到 TRANSFER_CONFLICT，说明多半是上一次已经完成（第二批 G-3）', async () => {
    let items = titles(2)
    let posts = 0
    const api = admin({
      [`GET /api/admin/users/${AMY.id}`]: () => json(200, LEAVER),
      [DOCUMENTS_KEY]: () => json(200, listPage(items)),
      [`GET /api/admin/spaces${search({ query: '市场', status: 'active' })}`]: () => json(200, listPage([SPACE])),
      [TRANSFER_KEY]: () => {
        posts += 1
        if (posts === 1) {
          // 服务端已经转走了，回包却丢了
          items = []
          return apiError(502, 'INTERNAL_ERROR')
        }
        return apiError(409, 'TRANSFER_CONFLICT')
      },
    })
    renderApp(`/admin/users/${AMY.id}/documents`)
    fireEvent.click(await screen.findByLabelText('全选已加载的文档'))
    fireEvent.change(screen.getByLabelText('目标团队空间'), { target: { value: '市场' } })
    fireEvent.click(await screen.findByRole('button', { name: '市场部' }))
    fireEvent.click(screen.getByRole('button', { name: '转移' }))
    const dialog = await screen.findByRole('dialog', { name: '把 2 份文档转移到 市场部？' })
    const listed = requestCount(api, DOCUMENTS_KEY)
    fireEvent.click(within(dialog).getByRole('button', { name: '转移' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('没能确认是否已经转移（服务器出了点问题，请稍后重试）。可能已经转移了：列表已刷新，不在列表里的就是已经转走了，选择也随之去掉；还在的可以再转移一次。')
    expect(requestCount(api, DOCUMENTS_KEY)).toBeGreaterThan(listed)
    expect(screen.queryByText('文档 0')).toBeNull()
    expect(screen.getByText('已选择 0 份，一次最多 100 份')).toBeInTheDocument()

    // 弹窗还开着，再点一次：那两份已经不在了
    fireEvent.click(within(dialog).getByRole('button', { name: '转移' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(await screen.findByRole('alert')).toHaveTextContent('有文档已经不在这个人的个人空间里了：多半是你上一次没能确认的那次转移已经完成。列表已刷新，请看看还剩哪些，需要的话重新选择后再转移')
    expect(requestCount(api, TRANSFER_KEY)).toBe(2)
  })

  it('转移的结果未知，随后刷新标题列表也失败：弹窗说明可能已经转移、列表没能刷新（不说"列表已刷新"），选择不动（第三批 G-a）', async () => {
    let refreshFails = false
    admin({
      [`GET /api/admin/users/${AMY.id}`]: () => json(200, LEAVER),
      [DOCUMENTS_KEY]: () => (refreshFails ? networkFailure() : json(200, listPage(titles(2)))),
      [`GET /api/admin/spaces${search({ query: '市场', status: 'active' })}`]: () => json(200, listPage([SPACE])),
      [TRANSFER_KEY]: () => {
        refreshFails = true
        return apiError(502, 'INTERNAL_ERROR')
      },
    })
    renderApp(`/admin/users/${AMY.id}/documents`)
    fireEvent.click(await screen.findByLabelText('全选已加载的文档'))
    fireEvent.change(screen.getByLabelText('目标团队空间'), { target: { value: '市场' } })
    fireEvent.click(await screen.findByRole('button', { name: '市场部' }))
    fireEvent.click(screen.getByRole('button', { name: '转移' }))
    const dialog = await screen.findByRole('dialog', { name: '把 2 份文档转移到 市场部？' })
    fireEvent.click(within(dialog).getByRole('button', { name: '转移' }))
    expect(await within(dialog).findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent('没能确认是否已经转移（服务器出了点问题，请稍后重试）。可能已经转移了，只是列表没能刷新，显示的可能还是之前的文档：请稍后再看，不在列表里的就是已经转走了；确认还在的再转移。')
    expect(screen.getByText('已选择 2 份，一次最多 100 份')).toBeInTheDocument()
  })

  it('有文档已被别人转走，而刷新标题列表失败：列表还是旧的，弹窗留着说明原因（复验）', async () => {
    let refreshFails = false
    admin({
      [`GET /api/admin/users/${AMY.id}`]: () => json(200, LEAVER),
      [DOCUMENTS_KEY]: () => (refreshFails ? apiError(500, 'INTERNAL_ERROR') : json(200, listPage(titles(2)))),
      [`GET /api/admin/spaces${search({ query: '市场', status: 'active' })}`]: () => json(200, listPage([SPACE])),
      [TRANSFER_KEY]: () => {
        refreshFails = true
        return apiError(409, 'TRANSFER_CONFLICT')
      },
    })
    renderApp(`/admin/users/${AMY.id}/documents`)
    fireEvent.click(await screen.findByLabelText('全选已加载的文档'))
    fireEvent.change(screen.getByLabelText('目标团队空间'), { target: { value: '市场' } })
    fireEvent.click(await screen.findByRole('button', { name: '市场部' }))
    fireEvent.click(screen.getByRole('button', { name: '转移' }))
    const dialog = await screen.findByRole('dialog', { name: '把 2 份文档转移到 市场部？' })
    fireEvent.click(within(dialog).getByRole('button', { name: '转移' }))
    expect(await within(dialog).findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent('有文档已经不在这个人的个人空间里（可能被别人转走了），请刷新后重试')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.queryByText(/列表已刷新，请重新选择后再转移/)).toBeNull()
    expect(screen.getByText('已选择 2 份，一次最多 100 份')).toBeInTheDocument()
  })

  it('一次最多转移 100 份：超过时说明原因，不能提交（审查 B14）', async () => {
    admin({
      [`GET /api/admin/users/${AMY.id}`]: () => json(200, LEAVER),
      [DOCUMENTS_KEY]: () => json(200, listPage(titles(101))),
      [`GET /api/admin/spaces${search({ query: '市场', status: 'active' })}`]: () => json(200, listPage([SPACE])),
    })
    renderApp(`/admin/users/${AMY.id}/documents`)
    fireEvent.click(await screen.findByLabelText('全选已加载的文档'))
    fireEvent.change(screen.getByLabelText('目标团队空间'), { target: { value: '市场' } })
    fireEvent.click(await screen.findByRole('button', { name: '市场部' }))
    expect(screen.getByText('已选择 101 份，一次最多 100 份')).toBeInTheDocument()
    const submit = screen.getByRole('button', { name: '转移' })
    expect(submit).toHaveAttribute('aria-disabled', 'true')
    expect(submit).toHaveAccessibleDescription('一次最多转移 100 份，请分批转移')
    fireEvent.click(submit)
    await settle()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('账户加载失败：说明原因，可以重试（审查 B5、B14）', async () => {
    const api = admin({ [`GET /api/admin/users/${AMY.id}`]: () => apiError(500, 'INTERNAL_ERROR') })
    renderApp(`/admin/users/${AMY.id}/documents`)
    expect(await screen.findByText('账户加载失败', {}, { timeout: 3000 })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '返回账户' })).toBeInTheDocument()
    api.on(`GET /api/admin/users/${AMY.id}`, () => json(200, AMY))
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('账户仍然有效：只有停用的账户才能转移文档')).toBeInTheDocument()
  })

  it('账户不存在：说明，不给重试', async () => {
    admin({ [`GET /api/admin/users/${AMY.id}`]: () => apiError(404, 'NOT_FOUND') })
    renderApp(`/admin/users/${AMY.id}/documents`)
    expect(await screen.findByText('内容不存在，或者你没有访问权限')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('账户仍然有效：说明只有停用的账户才能转移，不列文档', async () => {
    const api = admin({ [`GET /api/admin/users/${AMY.id}`]: () => json(200, AMY) })
    renderApp(`/admin/users/${AMY.id}/documents`)
    expect(await screen.findByText('账户仍然有效：只有停用的账户才能转移文档')).toBeInTheDocument()
    expect(api.requests.some(request => request.key.endsWith('/documents'))).toBe(false)
  })
})
