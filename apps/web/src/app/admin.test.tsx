// 管理界面（M2-P1 设计 §3.8，US-M2-01、03、04）：只给系统管理员；账户的操作先确认；一次性链接只显示一次。审计页见 admin-audit.test.tsx。
import type { Invitation } from '@nerve-office/contracts'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { formatDateTime } from '../shared/lib/format.ts'
import { apiError, installFakeApi, inTurn, json, networkFailure } from '../shared/testing/fake-api.test-support.ts'
import { documentsKey } from '../shared/testing/spaces.test-support.ts'
import { AMY, deferred, INVITATION, listPage, ROOT, rowOf, session, settle, SPACES } from './admin.test-support.ts'
import { currentPath, renderApp } from './render-app.test-support.tsx'

function requestCount(api: ReturnType<typeof installFakeApi>, key: string): number {
  return api.requests.filter(request => request.key === key).length
}

/** 点行里的操作（先让它得到焦点，与键盘操作一样），返回弹出的确认弹窗 */
async function openConfirm(row: HTMLElement, name: string): Promise<HTMLElement> {
  const button = within(row).getByRole('button', { name })
  button.focus()
  fireEvent.click(button)
  return screen.findByRole('dialog')
}

describe('管理界面：访问', () => {
  it('成员：页头没有"管理"入口；直接打开看到无权限的说明，不请求管理接口', async () => {
    const api = installFakeApi({
      ...SPACES,
      'GET /api/auth/session': () => json(200, session('member')),
    })
    renderApp('/admin/users')
    expect(await screen.findByText('只有系统管理员能打开管理界面。')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '管理' })).toBeNull()
    expect(api.requests.some(request => request.key.includes('/api/admin/'))).toBe(false)
  })

  it('系统管理员：页头有"管理"入口，/admin 打开账户页', async () => {
    installFakeApi({
      ...SPACES,
      'GET /api/auth/session': () => json(200, session('admin')),
      'GET /api/admin/users': () => json(200, listPage([ROOT, AMY])),
    })
    const app = renderApp('/admin')
    await waitFor(() => expect(currentPath(app)).toBe('/admin/users'))
    expect(await screen.findByRole('table', { name: '账户列表' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '管理' })).toHaveAttribute('href', '/admin')
  })

  it('已被别的管理员取消了系统管理员：管理接口得到 PERMISSION_DENIED 时重新确认会话，切到无权限，页头不再有入口（审查 B4）', async () => {
    let role: 'admin' | 'member' = 'admin'
    const api = installFakeApi({
      ...SPACES,
      'GET /api/auth/session': () => json(200, session(role, 'csrf-2')),
      'GET /api/admin/users': () => {
        role = 'member'
        return apiError(403, 'PERMISSION_DENIED')
      },
    })
    const app = renderApp('/admin/users')
    expect(await screen.findByText('只有系统管理员能打开管理界面。')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '管理' })).toBeNull()
    expect(requestCount(api, 'GET /api/auth/session')).toBe(2)
    // 还是同一个人：页面不重新加载
    expect(app.page.visits).toEqual([])
  })

  it('其他请求得到 PERMISSION_DENIED（不是管理接口）：不重新确认会话', async () => {
    const api = installFakeApi({
      ...SPACES,
      'GET /api/auth/session': () => json(200, session('admin')),
      [documentsKey(session('admin'))]: () => apiError(403, 'PERMISSION_DENIED'),
    })
    renderApp('/')
    expect(await screen.findByText('文档列表加载失败')).toBeInTheDocument()
    await settle()
    expect(requestCount(api, 'GET /api/auth/session')).toBe(1)
  })
})

describe('管理界面：账户', () => {
  it('停用先确认后果；确认之后请求、刷新列表；焦点回到这一行的按钮', async () => {
    let disabled = false
    const api = installFakeApi({
      ...SPACES,
      'GET /api/auth/session': () => json(200, session('admin')),
      'GET /api/admin/users': () => json(200, listPage([ROOT, { ...AMY, status: disabled ? 'disabled' : 'active' }])),
      [`POST /api/admin/users/${AMY.id}/disable`]: () => {
        disabled = true
        return json(200, { ...AMY, status: 'disabled' })
      },
    })
    renderApp('/admin/users')
    const dialog = await openConfirm(await rowOf('amy'), '停用 艾米（amy）')
    expect(dialog).toHaveAccessibleName('停用 艾米（amy）？')
    expect(within(dialog).getByText(/停用后，这个人立即不能访问/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: '停用' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.requests.some(request => request.key === `POST /api/admin/users/${AMY.id}/disable`)).toBe(true)
    // 状态的筛选里也有"已停用"这个选项：只在这一行里找
    const row = await rowOf('amy')
    await waitFor(() => expect(within(row).getByText('已停用')).toBeInTheDocument())
    // 同一个位置的按钮换成了"启用"：焦点回到它，不落到 body（审查 B9）
    await waitFor(() => expect(document.activeElement).toBe(within(row).getByRole('button', { name: '启用 艾米（amy）' })))
  })

  it('取消弹窗：焦点回到打开它的按钮，不发请求', async () => {
    const api = installFakeApi({
      ...SPACES,
      'GET /api/auth/session': () => json(200, session('admin')),
      'GET /api/admin/users': () => json(200, listPage([AMY])),
    })
    renderApp('/admin/users')
    const row = await rowOf('amy')
    const dialog = await openConfirm(row, '设为系统管理员 艾米（amy）')
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(within(row).getByRole('button', { name: '设为系统管理员 艾米（amy）' })))
    expect(api.requests.some(request => request.key.includes('/system-role'))).toBe(false)
  })

  it('操作之后这一行不在列表里了（按状态过滤）：焦点回到搜索框，不落到 body（审查 B9）', async () => {
    let disabled = false
    installFakeApi({
      ...SPACES,
      'GET /api/auth/session': () => json(200, session('admin')),
      'GET /api/admin/users': () => json(200, listPage([ROOT, AMY])),
      'GET /api/admin/users?status=active': () => json(200, listPage(disabled ? [ROOT] : [ROOT, AMY])),
      [`POST /api/admin/users/${AMY.id}/disable`]: () => {
        disabled = true
        return json(200, { ...AMY, status: 'disabled' })
      },
    })
    renderApp('/admin/users')
    await rowOf('amy')
    fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'active' } })
    await waitFor(() => expect(screen.getByRole('table', { name: '账户列表' })).toBeInTheDocument())
    const dialog = await openConfirm(await rowOf('amy'), '停用 艾米（amy）')
    fireEvent.click(within(dialog).getByRole('button', { name: '停用' }))
    await waitFor(() => expect(screen.queryByText('amy')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('按名字或登录名搜索')))
  })

  it('每行的操作按钮带上对象作为可读名称（审查 B14）', async () => {
    installFakeApi({
      ...SPACES,
      'GET /api/auth/session': () => json(200, session('admin')),
      'GET /api/admin/users': () => json(200, listPage([ROOT, AMY, { ...AMY, id: '0199a2c4-0000-7000-8000-000000000003', username: 'cat', displayName: '凯特', status: 'disabled' }])),
    })
    renderApp('/admin/users')
    const amy = await rowOf('amy')
    expect(within(amy).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['停用 艾米（amy）', '设为系统管理员 艾米（amy）', '生成重置链接 艾米（amy）'])
    expect(within(amy).getByRole('button', { name: '停用 艾米（amy）' })).toHaveTextContent('停用')
    expect(within(await rowOf('root')).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['停用 管理员（root）', '取消系统管理员 管理员（root）', '生成重置链接 管理员（root）'])
    expect(within(await rowOf('cat')).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['启用 凯特（cat）'])
  })

  it('取消最后一个系统管理员：弹窗里说明原因，弹窗留着', async () => {
    installFakeApi({
      ...SPACES,
      'GET /api/auth/session': () => json(200, session('admin')),
      'GET /api/admin/users': () => json(200, listPage([ROOT])),
      [`PUT /api/admin/users/${ROOT.id}/system-role`]: () => apiError(409, 'LAST_ADMIN'),
    })
    renderApp('/admin/users')
    const dialog = await openConfirm(await rowOf('root'), '取消系统管理员 管理员（root）')
    fireEvent.click(within(dialog).getByRole('button', { name: '取消系统管理员' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('至少要保留一个有效的系统管理员')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('进行中：按钮标为不可用，不能重复提交，也不能关闭', async () => {
    const pending = deferred()
    const api = installFakeApi({
      ...SPACES,
      'GET /api/auth/session': () => json(200, session('admin')),
      'GET /api/admin/users': () => json(200, listPage([AMY])),
      [`POST /api/admin/users/${AMY.id}/disable`]: pending.handler,
    })
    renderApp('/admin/users')
    const dialog = await openConfirm(await rowOf('amy'), '停用 艾米（amy）')
    fireEvent.click(within(dialog).getByRole('button', { name: '停用' }))
    const busy = await within(dialog).findByRole('button', { name: '正在处理…' })
    expect(busy).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(busy)
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await settle()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(requestCount(api, `POST /api/admin/users/${AMY.id}/disable`)).toBe(1)
    pending.resolve(json(200, { ...AMY, status: 'disabled' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('生成重置链接：确认时说清楚后果；确认之后只剩链接的弹窗（只显示这一次），可以复制；关闭之后焦点回到这一行（审查 A7、B7、B9）', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const api = installFakeApi({
      ...SPACES,
      'GET /api/auth/session': () => json(200, session('admin')),
      'GET /api/admin/users': () => json(200, listPage([AMY])),
      [`POST /api/admin/users/${AMY.id}/password-reset`]: () => json(201, { url: 'https://docs.example.com/reset-password#token', expiresAt: '2026-09-29T03:00:00.000Z' }),
    })
    renderApp('/admin/users')
    const row = await rowOf('amy')
    const dialog = await openConfirm(row, '生成重置链接 艾米（amy）')
    expect(dialog).toHaveAccessibleName('为 艾米（amy） 生成重置链接？')
    expect(dialog).toHaveAccessibleDescription('生成后，这个人的当前密码立即失效，所有地方的登录都会退出。链接 24 小时内有效，只显示这一次，请交给本人。')
    fireEvent.click(within(dialog).getByRole('button', { name: '生成重置链接' }))
    const linkDialog = await screen.findByRole('dialog', { name: '重置链接：艾米（amy）' })
    // 被 aria-hidden 的弹窗也算上：同时打开两个时，按角色查找默认只看得见最上面的一个（复验 N3）
    expect(screen.getAllByRole('dialog', { hidden: true })).toHaveLength(1)
    expect(within(linkDialog).getByLabelText('链接')).toHaveValue('https://docs.example.com/reset-password#token')
    expect(within(linkDialog).getByText(/链接只显示这一次/)).toBeInTheDocument()
    fireEvent.click(within(linkDialog).getByRole('button', { name: '复制链接' }))
    expect(await within(linkDialog).findByText('已复制')).toBeInTheDocument()
    expect(writeText).toHaveBeenCalledWith('https://docs.example.com/reset-password#token')

    fireEvent.click(within(linkDialog).getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(row))
    // 给别人生成的：本人的会话不受影响，不重新确认
    expect(requestCount(api, 'GET /api/auth/session')).toBe(1)
  })

  // 登录锁定（M2-P6 复核 A1）：账户行说明锁到什么时候、是全部来源还是部分来源；系统管理员先确认、再解除，解除之后这一行不再有锁定与这个按钮
  const LOCKED_UNTIL = '2026-09-30T08:15:00.000Z'
  const LOCKED = { until: LOCKED_UNTIL, allSources: true }

  it('登录被锁定的账户：状态一栏说明锁到什么时候，操作里多一个"解除锁定"；没有锁定的账户没有', async () => {
    installFakeApi({
      ...SPACES,
      'GET /api/auth/session': () => json(200, session('admin')),
      'GET /api/admin/users': () => json(200, listPage([ROOT, { ...AMY, loginLock: LOCKED }])),
    })
    renderApp('/admin/users')
    const amy = await rowOf('amy')
    expect(within(amy).getByText(`登录已锁定，到 ${formatDateTime(LOCKED_UNTIL)} 解除`)).toBeInTheDocument()
    expect(within(amy).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['停用 艾米（amy）', '设为系统管理员 艾米（amy）', '生成重置链接 艾米（amy）', '解除锁定 艾米（amy）'])
    const root = await rowOf('root')
    expect(within(root).queryByText(/登录已锁定/)).toBeNull()
    expect(within(root).queryByRole('button', { name: /^解除锁定/ })).toBeNull()
  })

  it('只锁了某些来源（本人从别处照常登录）：说明写"部分来源"，同样可以解除', async () => {
    installFakeApi({
      ...SPACES,
      'GET /api/auth/session': () => json(200, session('admin')),
      'GET /api/admin/users': () => json(200, listPage([ROOT, { ...AMY, loginLock: { until: LOCKED_UNTIL, allSources: false } }])),
    })
    renderApp('/admin/users')
    const amy = await rowOf('amy')
    expect(within(amy).getByText(`部分来源的登录已锁定，到 ${formatDateTime(LOCKED_UNTIL)} 解除`)).toBeInTheDocument()
    expect(within(amy).queryByText(/^登录已锁定/)).toBeNull()
    expect(within(amy).getByRole('button', { name: '解除锁定 艾米（amy）' })).toBeInTheDocument()
  })

  it('解除锁定：先确认后果；确认之后请求、刷新列表；锁定的说明与按钮随之消失，焦点回到这一行', async () => {
    let unlocked = false
    const api = installFakeApi({
      ...SPACES,
      'GET /api/auth/session': () => json(200, session('admin')),
      'GET /api/admin/users': () => json(200, listPage([ROOT, { ...AMY, loginLock: unlocked ? null : LOCKED }])),
      [`POST /api/admin/users/${AMY.id}/unlock-login`]: () => {
        unlocked = true
        return json(200, AMY)
      },
    })
    renderApp('/admin/users')
    const dialog = await openConfirm(await rowOf('amy'), '解除锁定 艾米（amy）')
    expect(dialog).toHaveAccessibleName('解除 艾米（amy） 的登录锁定？')
    // 说明准确（复验 N5）：清掉的是这个人在各个来源上的失败次数；他所在的网络整体被锁时仍要等到期，不说"可以立即登录"
    expect(dialog).toHaveAccessibleDescription(/^解除后，清掉这个人在所有来源上的登录失败次数。他所在的网络如果整体被锁（同一来源失败次数太多），仍要等锁定到期。/)
    expect(dialog).not.toHaveAccessibleDescription(/立即/)
    fireEvent.click(within(dialog).getByRole('button', { name: '解除锁定' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(requestCount(api, `POST /api/admin/users/${AMY.id}/unlock-login`)).toBe(1)
    const row = await rowOf('amy')
    await waitFor(() => expect(within(row).queryByText(/登录已锁定/)).toBeNull())
    expect(within(row).queryByRole('button', { name: /^解除锁定/ })).toBeNull()
    // 打开弹窗的按钮已经不在了：焦点回到这一行，不落到 body（审查 B9）
    await waitFor(() => expect(document.activeElement).toBe(row))
    // 解除的是别人的锁定：本人的会话不受影响，不重新确认
    expect(requestCount(api, 'GET /api/auth/session')).toBe(1)
  })

  it('解除锁定失败：弹窗里说明原因，弹窗留着，可以再试', async () => {
    const api = installFakeApi({
      ...SPACES,
      'GET /api/auth/session': () => json(200, session('admin')),
      'GET /api/admin/users': () => json(200, listPage([{ ...AMY, loginLock: LOCKED }])),
      [`POST /api/admin/users/${AMY.id}/unlock-login`]: inTurn(networkFailure, () => json(200, AMY)),
    })
    renderApp('/admin/users')
    const dialog = await openConfirm(await rowOf('amy'), '解除锁定 艾米（amy）')
    fireEvent.click(within(dialog).getByRole('button', { name: '解除锁定' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/网络/)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: '解除锁定' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(requestCount(api, `POST /api/admin/users/${AMY.id}/unlock-login`)).toBe(2)
  })

  it('搜索与状态过滤：带着条件请求', async () => {
    const api = installFakeApi({
      ...SPACES,
      'GET /api/auth/session': () => json(200, session('admin')),
      'GET /api/admin/users': () => json(200, listPage([ROOT, AMY])),
      'GET /api/admin/users?status=disabled': () => json(200, listPage([])),
      'GET /api/admin/users?query=zzz&status=disabled': () => json(200, listPage([])),
    })
    renderApp('/admin/users')
    await screen.findByText('amy')
    fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'disabled' } })
    expect(await screen.findByText('没有符合条件的账户')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('按名字或登录名搜索'), { target: { value: 'zzz' } })
    await waitFor(() => expect(api.requests.some(request => request.key === 'GET /api/admin/users?query=zzz&status=disabled')).toBe(true))
  })
})

describe('管理界面：对自己的账户操作（审查 B4、A12）', () => {
  it('取消自己的系统管理员：专门的确认文案；成功后重新确认会话，切到无权限，页头不再有"管理"', async () => {
    let role: 'admin' | 'member' = 'admin'
    const api = installFakeApi({
      ...SPACES,
      'GET /api/auth/session': () => json(200, session(role)),
      'GET /api/admin/users': () => (role === 'admin' ? json(200, listPage([ROOT, { ...AMY, systemRole: 'admin' }])) : apiError(403, 'PERMISSION_DENIED')),
      [`PUT /api/admin/users/${ROOT.id}/system-role`]: () => {
        role = 'member'
        return json(200, { ...ROOT, systemRole: 'member' })
      },
    })
    const app = renderApp('/admin/users')
    const dialog = await openConfirm(await rowOf('root'), '取消系统管理员 管理员（root）')
    expect(dialog).toHaveAccessibleName('取消你自己的系统管理员？')
    expect(dialog).toHaveAccessibleDescription(/你立即不能再打开管理界面/)
    fireEvent.click(within(dialog).getByRole('button', { name: '取消系统管理员' }))
    expect(await screen.findByText('只有系统管理员能打开管理界面。')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '管理' })).toBeNull()
    // 管理页连同确认的弹窗一起卸载：焦点交给无权限的说明，不落到 body（复验 N5）
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('alert')))
    const keys = api.requests.map(request => request.key)
    const changed = keys.indexOf(`PUT /api/admin/users/${ROOT.id}/system-role`)
    expect(api.requests[changed]?.body).toEqual({ systemRole: 'member' })
    // 成功之后先确认会话，而不是等刷新列表得到 PERMISSION_DENIED 才发现
    expect(keys[changed + 1]).toBe('GET /api/auth/session')
    expect(app.page.visits).toEqual([])
  })

  it('停用自己：确认文案说明本人会退出（不写"随时可以重新启用"）；成功后重新确认会话，已经退出，整页重新加载', async () => {
    let disabled = false
    installFakeApi({
      ...SPACES,
      'GET /api/auth/session': () => (disabled ? apiError(401, 'UNAUTHENTICATED') : json(200, session('admin'))),
      'GET /api/admin/users': () => (disabled ? apiError(401, 'UNAUTHENTICATED') : json(200, listPage([ROOT, { ...AMY, systemRole: 'admin' }]))),
      [`POST /api/admin/users/${ROOT.id}/disable`]: () => {
        disabled = true
        return json(200, { ...ROOT, status: 'disabled' })
      },
    })
    const app = renderApp('/admin/users')
    const dialog = await openConfirm(await rowOf('root'), '停用 管理员（root）')
    expect(dialog).toHaveAccessibleName('停用你自己的账户？')
    expect(dialog).toHaveAccessibleDescription(/停用后你立即退出，不能再登录/)
    expect(dialog).not.toHaveTextContent('随时可以重新启用')
    fireEvent.click(within(dialog).getByRole('button', { name: '停用' }))
    await waitFor(() => expect(app.page.visits).toEqual(['reload']))
    await settle()
    expect(app.page.visits).toEqual(['reload'])
  })

  it('给自己生成重置链接：专门的确认文案；链接先交到本人手里，关闭弹窗之后才重新确认会话（已经退出，整页重新加载）', async () => {
    let reset = false
    const api = installFakeApi({
      ...SPACES,
      'GET /api/auth/session': () => (reset ? apiError(401, 'UNAUTHENTICATED') : json(200, session('admin'))),
      'GET /api/admin/users': () => json(200, listPage([ROOT])),
      [`POST /api/admin/users/${ROOT.id}/password-reset`]: () => {
        reset = true
        return json(201, { url: 'https://docs.example.com/reset-password#own', expiresAt: '2026-09-29T03:00:00.000Z' })
      },
    })
    const app = renderApp('/admin/users')
    const dialog = await openConfirm(await rowOf('root'), '生成重置链接 管理员（root）')
    expect(dialog).toHaveAccessibleName('为你自己生成重置链接？')
    expect(dialog).toHaveAccessibleDescription('生成后，你自己的登录会立即退出，当前密码随即失效，之后用这个链接设置新密码。链接 24 小时内有效，只显示这一次，请先复制保存。')
    fireEvent.click(within(dialog).getByRole('button', { name: '生成重置链接' }))
    const linkDialog = await screen.findByRole('dialog', { name: '重置链接：管理员（root）' })
    expect(within(linkDialog).getByLabelText('链接')).toHaveValue('https://docs.example.com/reset-password#own')
    expect(within(linkDialog).getByText('你的登录已经退出：关闭之后回到登录页，打开这个链接设置新密码。')).toBeInTheDocument()
    await settle()
    expect(requestCount(api, 'GET /api/auth/session')).toBe(1)
    expect(app.page.visits).toEqual([])

    fireEvent.click(within(linkDialog).getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(app.page.visits).toEqual(['reload']))
  })
})

describe('管理界面：邀请', () => {
  it('签发：登录名不合规时在前端说明；合规时请求，弹出只显示一次的链接；关闭之后焦点回到登录名（审查 B9）', async () => {
    const api = installFakeApi({
      ...SPACES,
      'GET /api/auth/session': () => json(200, session('admin')),
      'GET /api/admin/invitations': () => json(200, listPage([])),
      'POST /api/admin/invitations': () => json(201, { invitation: { ...INVITATION, username: 'zhang.san', displayName: '张三' }, url: 'https://docs.example.com/invite#token' }),
    })
    renderApp('/admin/invitations')
    await screen.findByText('还没有邀请')
    fireEvent.change(screen.getByLabelText('登录名'), { target: { value: '张三' } })
    fireEvent.change(screen.getByLabelText('显示名'), { target: { value: '张三' } })
    fireEvent.click(screen.getByRole('button', { name: '生成邀请链接' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('用户名为 3–32 个字符')
    expect(api.requests.some(request => request.key === 'POST /api/admin/invitations')).toBe(false)

    fireEvent.change(screen.getByLabelText('登录名'), { target: { value: 'Zhang.San' } })
    const submit = screen.getByRole('button', { name: '生成邀请链接' })
    submit.focus()
    fireEvent.click(submit)
    const dialog = await screen.findByRole('dialog', { name: '邀请链接：张三（zhang.san）' })
    expect(within(dialog).getByLabelText('链接')).toHaveValue('https://docs.example.com/invite#token')
    expect(api.requests.find(request => request.key === 'POST /api/admin/invitations')?.body).toEqual({ username: 'zhang.san', displayName: '张三' })
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('登录名')))
    expect(screen.getByLabelText('登录名')).toHaveValue('')
  })

  it('说明里的有效期是 7 天（M2-P6 复核 S-2：来自 contracts 的常量，常量换了界面跟着变，见 admin-invitation-lifetime.test.tsx）', async () => {
    installFakeApi({
      ...SPACES,
      'GET /api/auth/session': () => json(200, session('admin')),
      'GET /api/admin/invitations': () => json(200, listPage([])),
    })
    renderApp('/admin/invitations')
    expect(await screen.findByText(/生成一次性链接（7 天内有效）/)).toBeInTheDocument()
  })

  it('签发的结果未知（断网、服务端出错）：说明邀请可能已经生成、去列表里重新生成；刷新列表；输入留着（M2-P6 复核 G-2）', async () => {
    let listCalls = 0
    const api = installFakeApi({
      ...SPACES,
      'GET /api/auth/session': () => json(200, session('admin')),
      'GET /api/admin/invitations': () => {
        listCalls += 1
        return json(200, listPage(listCalls === 1 ? [] : [{ ...INVITATION, username: 'amy', displayName: '艾米' }]))
      },
      'POST /api/admin/invitations': inTurn(networkFailure, () => apiError(500, 'INTERNAL_ERROR')),
    })
    renderApp('/admin/invitations')
    await screen.findByText('还没有邀请')
    fireEvent.change(screen.getByLabelText('登录名'), { target: { value: 'amy' } })
    fireEvent.change(screen.getByLabelText('显示名'), { target: { value: '艾米' } })
    fireEvent.click(screen.getByRole('button', { name: '生成邀请链接' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('没能确认邀请是否已经生成（网络连接失败')
    expect(alert).toHaveTextContent('请在下面的列表里找到这个登录名，点"重新生成"')
    // 列表刷新了：可能已经建好的那一条出现在列表里
    await waitFor(() => expect(requestCount(api, 'GET /api/admin/invitations')).toBe(2))
    expect(await rowOf('amy')).toBeInTheDocument()
    expect(screen.getByLabelText('登录名')).toHaveValue('amy')
    expect(screen.getByLabelText('显示名')).toHaveValue('艾米')

    fireEvent.click(screen.getByRole('button', { name: '生成邀请链接' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('没能确认邀请是否已经生成（服务器出了点问题'))
  })

  it('结果未知之后，同一个登录名再签发得到"已被占用"：说明多半就是刚才那一次，引导去重新生成；换一个登录名的"已被占用"照常说明（M2-P6 复核 G-2）', async () => {
    installFakeApi({
      ...SPACES,
      'GET /api/auth/session': () => json(200, session('admin')),
      'GET /api/admin/invitations': () => json(200, listPage([])),
      'POST /api/admin/invitations': inTurn(networkFailure, () => apiError(409, 'USERNAME_TAKEN'), () => apiError(409, 'USERNAME_TAKEN')),
    })
    renderApp('/admin/invitations')
    await screen.findByText('还没有邀请')
    // 登录名按规范写法比较：大写与首尾空白都算同一个
    fireEvent.change(screen.getByLabelText('登录名'), { target: { value: 'amy' } })
    fireEvent.change(screen.getByLabelText('显示名'), { target: { value: '艾米' } })
    fireEvent.click(screen.getByRole('button', { name: '生成邀请链接' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('没能确认邀请是否已经生成')

    fireEvent.change(screen.getByLabelText('登录名'), { target: { value: ' AMY ' } })
    fireEvent.click(screen.getByRole('button', { name: '生成邀请链接' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('这个登录名已有待接受的邀请，可能就是刚才没能确认的那一次'))

    fireEvent.change(screen.getByLabelText('登录名'), { target: { value: 'bob' } })
    fireEvent.click(screen.getByRole('button', { name: '生成邀请链接' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/^这个登录名已被账户占用，或者已有待接受的邀请$/))
  })

  it('结果未知的那一次输入带着大写与首尾空白，再按规范写法签发得到"已被占用"：同样认作同一个登录名，给出专门的引导（复验 N10）', async () => {
    const api = installFakeApi({
      ...SPACES,
      'GET /api/auth/session': () => json(200, session('admin')),
      'GET /api/admin/invitations': () => json(200, listPage([])),
      'POST /api/admin/invitations': inTurn(() => apiError(500, 'INTERNAL_ERROR'), () => apiError(409, 'USERNAME_TAKEN')),
    })
    renderApp('/admin/invitations')
    await screen.findByText('还没有邀请')
    fireEvent.change(screen.getByLabelText('登录名'), { target: { value: ' Amy.Lee ' } })
    fireEvent.change(screen.getByLabelText('显示名'), { target: { value: '艾米' } })
    fireEvent.click(screen.getByRole('button', { name: '生成邀请链接' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('没能确认邀请是否已经生成')

    fireEvent.change(screen.getByLabelText('登录名'), { target: { value: 'amy.lee' } })
    fireEvent.click(screen.getByRole('button', { name: '生成邀请链接' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('这个登录名已有待接受的邀请，可能就是刚才没能确认的那一次'))
    // 两次请求里都是规范写法
    expect(api.requests.filter(request => request.key === 'POST /api/admin/invitations').map(request => request.body)).toEqual([
      { username: 'amy.lee', displayName: '艾米' },
      { username: 'amy.lee', displayName: '艾米' },
    ])
  })

  it('结果未知之后又签发成功：之后同一个登录名的"已被占用"照常说明', async () => {
    installFakeApi({
      ...SPACES,
      'GET /api/auth/session': () => json(200, session('admin')),
      'GET /api/admin/invitations': () => json(200, listPage([])),
      'POST /api/admin/invitations': inTurn(
        networkFailure,
        () => json(201, { invitation: { ...INVITATION, username: 'amy', displayName: '艾米' }, url: 'https://docs.example.com/invite#token' }),
        () => apiError(409, 'USERNAME_TAKEN'),
      ),
    })
    renderApp('/admin/invitations')
    await screen.findByText('还没有邀请')
    fireEvent.change(screen.getByLabelText('登录名'), { target: { value: 'amy' } })
    fireEvent.change(screen.getByLabelText('显示名'), { target: { value: '艾米' } })
    fireEvent.click(screen.getByRole('button', { name: '生成邀请链接' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('没能确认邀请是否已经生成')
    fireEvent.click(screen.getByRole('button', { name: '生成邀请链接' }))
    const dialog = await screen.findByRole('dialog', { name: '邀请链接：艾米（amy）' })
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    fireEvent.change(screen.getByLabelText('登录名'), { target: { value: 'amy' } })
    fireEvent.change(screen.getByLabelText('显示名'), { target: { value: '艾米' } })
    fireEvent.click(screen.getByRole('button', { name: '生成邀请链接' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/^这个登录名已被账户占用，或者已有待接受的邀请$/))
  })

  it('登录名已被占用或已有待接受的邀请：按错误码说明，用"登录名"的说法（审查 B6）', async () => {
    installFakeApi({
      ...SPACES,
      'GET /api/auth/session': () => json(200, session('admin')),
      'GET /api/admin/invitations': () => json(200, listPage([])),
      'POST /api/admin/invitations': () => apiError(409, 'USERNAME_TAKEN', '用户名已被占用'),
    })
    renderApp('/admin/invitations')
    await screen.findByText('还没有邀请')
    fireEvent.change(screen.getByLabelText('登录名'), { target: { value: 'amy' } })
    fireEvent.change(screen.getByLabelText('显示名'), { target: { value: '艾米' } })
    fireEvent.click(screen.getByRole('button', { name: '生成邀请链接' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('这个登录名已被账户占用，或者已有待接受的邀请')
  })

  it('列表显示状态与签发人；待接受的可以作废（先确认）；作废之后焦点回到这一行', async () => {
    let revoked = false
    const api = installFakeApi({
      ...SPACES,
      'GET /api/auth/session': () => json(200, session('admin')),
      'GET /api/admin/invitations': () => json(200, listPage([{ ...INVITATION, status: revoked ? 'revoked' : 'pending' }])),
      [`POST /api/admin/invitations/${INVITATION.id}/revoke`]: () => {
        revoked = true
        return json(200, { ...INVITATION, status: 'revoked', revokedAt: '2026-09-28T04:00:00.000Z' })
      },
    })
    renderApp('/admin/invitations')
    const row = await rowOf('bea')
    expect(within(row).getByText('待接受')).toBeInTheDocument()
    expect(within(row).getByText('管理员')).toBeInTheDocument()
    const dialog = await openConfirm(row, '作废 bea')
    fireEvent.click(within(dialog).getByRole('button', { name: '作废' }))
    expect(await screen.findByText('已作废')).toBeInTheDocument()
    expect(api.requests.some(request => request.key === `POST /api/admin/invitations/${INVITATION.id}/revoke`)).toBe(true)
    // "作废"随之消失了：焦点回到这一行，不落到 body（审查 B9）
    await waitFor(() => expect(document.activeElement).toBe(row))
  })

  it('只对没有接受、后来也没有再签发过的邀请给出"重新生成"（审查 B6）', async () => {
    const invitation = (index: number, changes: Partial<Invitation>): Invitation => ({ ...INVITATION, id: `0199a2c4-0000-7000-8000-00000000010${index}`, username: `user${index}`, ...changes })
    installFakeApi({
      ...SPACES,
      'GET /api/auth/session': () => json(200, session('admin')),
      'GET /api/admin/invitations': () => json(200, listPage([
        invitation(1, { status: 'pending' }),
        invitation(2, { status: 'expired' }),
        invitation(3, { status: 'revoked', superseded: true }),
        invitation(4, { status: 'revoked' }),
        invitation(5, { status: 'accepted', acceptedAt: '2026-09-28T05:00:00.000Z' }),
        invitation(6, { status: 'expired', superseded: true }),
      ])),
    })
    renderApp('/admin/invitations')
    const actions = async (username: string) => within(await rowOf(username)).queryAllByRole('button').map(button => button.getAttribute('aria-label'))
    expect(await actions('user1')).toEqual(['作废 user1', '重新生成 user1'])
    expect(await actions('user2')).toEqual(['作废 user2', '重新生成 user2'])
    expect(await actions('user3')).toEqual([])
    expect(await actions('user4')).toEqual(['重新生成 user4'])
    expect(await actions('user5')).toEqual([])
    expect(await actions('user6')).toEqual(['作废 user6'])
  })

  it('重新生成：确认弹窗一直显示进行中，列表刷新之后换成链接的弹窗，任何时刻只有一个弹窗；关闭之后焦点到新的那一行（审查 B7、B9）', async () => {
    const reissued: Invitation = { ...INVITATION, id: '0199a2c4-0000-7000-8000-000000000011', createdAt: '2026-09-28T06:00:00.000Z' }
    const reissue = deferred()
    const refreshed = deferred()
    let listCalls = 0
    const api = installFakeApi({
      ...SPACES,
      'GET /api/auth/session': () => json(200, session('admin')),
      'GET /api/admin/invitations': async (init) => {
        listCalls += 1
        return listCalls === 1 ? json(200, listPage([INVITATION])) : refreshed.handler(init)
      },
      [`POST /api/admin/invitations/${INVITATION.id}/reissue`]: reissue.handler,
    })
    renderApp('/admin/invitations')
    const dialog = await openConfirm(await rowOf('bea'), '重新生成 bea')
    expect(dialog).toHaveAccessibleName('为 bea 重新生成邀请链接？')
    fireEvent.click(within(dialog).getByRole('button', { name: '重新生成' }))
    expect(await within(dialog).findByRole('button', { name: '正在处理…' })).toHaveAttribute('aria-disabled', 'true')
    reissue.resolve(json(201, { invitation: reissued, url: 'https://docs.example.com/invite#new' }))
    await waitFor(() => expect(requestCount(api, 'GET /api/admin/invitations')).toBe(2))
    // 列表还在刷新：仍然只有确认的弹窗（被 aria-hidden 的也算上，复验 N3）
    expect(screen.getAllByRole('dialog', { hidden: true })).toEqual([dialog])
    refreshed.resolve(json(200, listPage([reissued, { ...INVITATION, status: 'revoked', superseded: true, revokedAt: '2026-09-28T06:00:00.000Z' }])))
    const linkDialog = await screen.findByRole('dialog', { name: '邀请链接：贝亚（bea）' })
    expect(screen.getAllByRole('dialog', { hidden: true })).toEqual([linkDialog])
    expect(within(linkDialog).getByLabelText('链接')).toHaveValue('https://docs.example.com/invite#new')

    fireEvent.click(within(linkDialog).getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const rows = within(screen.getByRole('table', { name: '邀请列表' })).getAllByRole('row')
    // 表头之后的第一行是新的邀请
    await waitFor(() => expect(document.activeElement).toBe(rows[1]))
    expect(within(rows[1] ?? document.body).getByText('待接受')).toBeInTheDocument()
  })
})
