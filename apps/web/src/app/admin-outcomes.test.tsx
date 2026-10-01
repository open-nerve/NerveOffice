// 管理界面里不带 requestId 的写操作在结果未知之后（M2-P6 复核 S1）：创建团队空间、加入空间、重新生成邀请、生成重置链接。
// 照修改密码与签发邀请的做法：结果未知时刷新相关列表并说明可能已经生效，之后的 409 给出对应的引导；
// 给自己生成重置链接的结果未知之后再试得到"登录已过期"，登录页说明密码可能已经失效。接口用假的 fetch。
import type { AdminSpace, Invitation } from '@nerve-office/contracts'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { apiError, installFakeApi, json, networkFailure } from '../shared/testing/fake-api.test-support.ts'
import { plainName } from '../shared/testing/people.test-support.ts'
import { AMY, INVITATION, listPage, ROOT, rowOf, session, settle, SPACES } from './admin.test-support.ts'
import { renderApp } from './render-app.test-support.tsx'

const BEN = { id: '0199a2c4-0000-7000-8000-00000000000b', username: 'ben', displayName: '本' }
const TEAM_ID = '0199a2c4-0000-7000-8000-0000000000c1'

function count(api: ReturnType<typeof installFakeApi>, key: string): number {
  return api.requests.filter(request => request.key === key).length
}

describe('管理界面：结果未知之后（M2-P6 复核 S1）', () => {
  it('创建团队空间的结果未知：列表刷新，说明下面有它就是建好了；用同一个名称再创建得到"已有同名"，说明多半就是刚才那一次（P7）', async () => {
    const created: AdminSpace = { id: TEAM_ID, name: '市场部', status: 'active', visibleToAll: false, memberCount: 1, createdAt: '2026-09-29T01:00:00.000Z', myRole: null }
    let spaces: AdminSpace[] = []
    let posts = 0
    const api = installFakeApi({
      ...SPACES,
      'GET /api/auth/session': () => json(200, session('admin')),
      'GET /api/admin/spaces': () => json(200, listPage(spaces)),
      [`GET /api/users?${new URLSearchParams({ query: '本' }).toString()}`]: () => json(200, { items: [BEN] }),
      'POST /api/admin/spaces': () => {
        posts += 1
        if (posts === 1) {
          spaces = [created]
          return networkFailure()
        }
        return apiError(409, 'SPACE_NAME_TAKEN')
      },
    })
    renderApp('/admin/spaces')
    const form = await screen.findByRole('form', { name: '创建团队空间' })
    fireEvent.change(within(form).getByLabelText('首个空间管理员'), { target: { value: '本' } })
    fireEvent.click(await within(form).findByRole('button', { name: '@ben 本' }))
    fireEvent.change(within(form).getByLabelText('名称'), { target: { value: '市场部' } })
    fireEvent.click(within(form).getByRole('button', { name: '创建团队空间' }))
    expect(await within(form).findByText('没能确认团队空间是否已经创建（网络连接失败，请检查网络后重试）。列表已刷新：下面的列表里有它，就是已经建好了。')).toBeInTheDocument()
    // 列表刷新出来了：刚才那一次其实已经建好
    expect(await rowOf('市场部')).toBeInTheDocument()

    const listed = count(api, 'GET /api/admin/spaces')
    fireEvent.click(within(form).getByRole('button', { name: '创建团队空间' }))
    expect(await within(form).findByText('已有同名的团队空间，可能就是刚才没能确认的那一次创建。列表已刷新：请在下面的列表里找找它。')).toBeInTheDocument()
    await waitFor(() => expect(count(api, 'GET /api/admin/spaces')).toBeGreaterThan(listed))
  })

  it('换了名称之后的"已有同名"是真的同名：照常说明，不说成刚才那一次', async () => {
    let posts = 0
    installFakeApi({
      ...SPACES,
      'GET /api/auth/session': () => json(200, session('admin')),
      'GET /api/admin/spaces': () => json(200, listPage([])),
      [`GET /api/users?${new URLSearchParams({ query: '本' }).toString()}`]: () => json(200, { items: [BEN] }),
      'POST /api/admin/spaces': () => {
        posts += 1
        return posts === 1 ? networkFailure() : apiError(409, 'SPACE_NAME_TAKEN')
      },
    })
    renderApp('/admin/spaces')
    const form = await screen.findByRole('form', { name: '创建团队空间' })
    fireEvent.change(within(form).getByLabelText('首个空间管理员'), { target: { value: '本' } })
    fireEvent.click(await within(form).findByRole('button', { name: '@ben 本' }))
    fireEvent.change(within(form).getByLabelText('名称'), { target: { value: '市场部' } })
    fireEvent.click(within(form).getByRole('button', { name: '创建团队空间' }))
    await within(form).findByText(/^没能确认团队空间是否已经创建/)
    fireEvent.change(within(form).getByLabelText('名称'), { target: { value: '产品部' } })
    fireEvent.click(within(form).getByRole('button', { name: '创建团队空间' }))
    expect(await within(form).findByText(/^已有同名的团队空间（大小写/)).toBeInTheDocument()
  })

  it('重新生成邀请的结果未知：列表刷新，说明原来的链接可能已经作废、要找到最新的那一条再重新生成；再点得到"已被占用"，同样引导（P8）', async () => {
    let posts = 0
    let items: Invitation[] = [INVITATION]
    const reissued: Invitation = { ...INVITATION, id: '0199a2c4-0000-7000-8000-000000000011', createdAt: '2026-09-28T06:00:00.000Z' }
    const api = installFakeApi({
      ...SPACES,
      'GET /api/auth/session': () => json(200, session('admin')),
      'GET /api/admin/invitations': () => json(200, listPage(items)),
      [`POST /api/admin/invitations/${INVITATION.id}/reissue`]: () => {
        posts += 1
        if (posts === 1) {
          items = [reissued, { ...INVITATION, status: 'revoked', superseded: true, revokedAt: '2026-09-28T06:00:00.000Z' }]
          return apiError(500, 'INTERNAL_ERROR')
        }
        return apiError(409, 'USERNAME_TAKEN')
      },
    })
    renderApp('/admin/invitations')
    fireEvent.click(within(await rowOf('bea')).getByRole('button', { name: '重新生成 bea' }))
    const dialog = await screen.findByRole('dialog')
    const listed = count(api, 'GET /api/admin/invitations')
    fireEvent.click(within(dialog).getByRole('button', { name: '重新生成' }))
    expect(await within(dialog).findByText('没能确认邀请链接是否已经重新生成（服务器出了点问题，请稍后重试）。如果已经生成，原来的链接已经作废，新的链接不能再次显示：列表已刷新，请找到这个登录名最新的那一条，再点"重新生成"。')).toBeInTheDocument()
    await waitFor(() => expect(count(api, 'GET /api/admin/invitations')).toBeGreaterThan(listed))

    const again = count(api, 'GET /api/admin/invitations')
    fireEvent.click(within(dialog).getByRole('button', { name: '重新生成' }))
    expect(await within(dialog).findByText('这个登录名已有待接受的邀请，可能就是刚才没能确认的那一次重新生成。链接不能再次显示：列表已刷新，请找到最新的那一条，再点"重新生成"。')).toBeInTheDocument()
    await waitFor(() => expect(count(api, 'GET /api/admin/invitations')).toBeGreaterThan(again))
  })

  it('为别人生成重置链接的结果未知：弹窗里说明这个人的密码可能已经失效、可以再生成一次', async () => {
    installFakeApi({
      ...SPACES,
      'GET /api/auth/session': () => json(200, session('admin')),
      'GET /api/admin/users': () => json(200, listPage([AMY, ROOT])),
      [`POST /api/admin/users/${AMY.id}/password-reset`]: () => networkFailure(),
    })
    renderApp('/admin/users')
    fireEvent.click(within(await rowOf('amy')).getByRole('button', { name: `生成重置链接 ${plainName('艾米', 'amy')}` }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '生成重置链接' }))
    expect(await within(dialog).findByText('没能确认重置链接是否已经生成（网络连接失败，请检查网络后重试）。如果已经生成，这个人的当前密码已经失效，链接却没能显示：可以再生成一次，之前那一条随即作废。')).toBeInTheDocument()
  })

  it('为自己生成重置链接的结果未知：说明你的密码可能已经失效；再试得到"登录已过期"（上一次其实生效了），登录页说明密码可能已经失效', async () => {
    let posts = 0
    let revoked = false
    const api = installFakeApi({
      ...SPACES,
      'GET /api/auth/session': () => (revoked ? apiError(401, 'UNAUTHENTICATED') : json(200, session('admin'))),
      'GET /api/admin/users': () => json(200, listPage([ROOT])),
      [`POST /api/admin/users/${ROOT.id}/password-reset`]: () => {
        posts += 1
        if (posts === 1) {
          // 服务端已经让密码失效、撤销了会话，回包却丢了
          revoked = true
          return networkFailure()
        }
        return apiError(401, 'SESSION_EXPIRED')
      },
    })
    const app = renderApp('/admin/users')
    fireEvent.click(within(await rowOf('root')).getByRole('button', { name: `生成重置链接 ${plainName('管理员', 'root')}` }))
    const dialog = await screen.findByRole('dialog', { name: '为你自己生成重置链接？' })
    fireEvent.click(within(dialog).getByRole('button', { name: '生成重置链接' }))
    expect(await within(dialog).findByText('没能确认重置链接是否已经生成（网络连接失败，请检查网络后重试）。如果已经生成，你的密码已经失效、登录也已退出，那条链接找不回来：再试时会回到登录页，请联系另一位系统管理员为你生成新的重置链接。')).toBeInTheDocument()
    await settle()
    expect(app.page.visits).toEqual([])

    fireEvent.click(within(dialog).getByRole('button', { name: '生成重置链接' }))
    // 运行时先向服务端确认会话（已经没有了），带着"密码可能已经失效"的原因整页回到登录页
    await waitFor(() => expect(app.page.visits).toEqual(['/login?from=%2Fadmin%2Fusers&reason=password_reset']))
    expect(count(api, `POST /api/admin/users/${ROOT.id}/password-reset`)).toBe(2)
  })

  it('登录页认得"为自己生成重置链接之后登录失效"的原因：说明密码可能已经失效、找另一位系统管理员', async () => {
    installFakeApi({ 'GET /api/auth/session': () => apiError(401, 'UNAUTHENTICATED') })
    renderApp('/login?reason=password_reset')
    expect(await screen.findByText('刚才为自己生成重置链接时没能确认结果，随后登录失效了：你的密码可能已经失效，那条链接也已经找不回来。请联系另一位系统管理员为你生成新的重置链接。')).toBeInTheDocument()
    await waitFor(() => expect(document.title).toBe('登录 - NerveOffice'))
  })
})

describe('管理界面：按状态幂等的操作结果未知时刷新并说明（M2-P6 复核第二批 G-2）', () => {
  const UNKNOWN = '没能确认是否已经完成（服务器出了点问题，请稍后重试）。可能已经生效：页面已按服务端现在的状态刷新，看得出是否已经生效；还没有的话，可以再试一次。'

  it('停用账户的结果未知（其实已经停用）：账户列表刷新、这一行显示已停用；弹窗说明可能已经生效，可以再试', async () => {
    let amy = AMY
    const api = installFakeApi({
      ...SPACES,
      'GET /api/auth/session': () => json(200, session('admin')),
      'GET /api/admin/users': () => json(200, listPage([ROOT, amy])),
      [`POST /api/admin/users/${AMY.id}/disable`]: () => {
        amy = { ...AMY, status: 'disabled' }
        return apiError(500, 'INTERNAL_ERROR')
      },
    })
    renderApp('/admin/users')
    fireEvent.click(within(await rowOf('amy')).getByRole('button', { name: `停用 ${plainName('艾米', 'amy')}` }))
    const dialog = await screen.findByRole('dialog')
    const listed = count(api, 'GET /api/admin/users')
    fireEvent.click(within(dialog).getByRole('button', { name: '停用' }))
    expect(await within(dialog).findByText(UNKNOWN)).toBeInTheDocument()
    expect(count(api, 'GET /api/admin/users')).toBeGreaterThan(listed)
    // 表格不停在旧的状态
    expect(within(await rowOf('amy')).getByText('已停用')).toBeInTheDocument()
  })

  it('归档团队空间的结果未知：同样刷新列表、说明可能已经生效', async () => {
    const space: AdminSpace = { id: TEAM_ID, name: '市场部', status: 'active', visibleToAll: false, memberCount: 1, createdAt: '2026-09-29T01:00:00.000Z', myRole: null }
    let archived = false
    const spacesApi = installFakeApi({
      ...SPACES,
      'GET /api/auth/session': () => json(200, session('admin')),
      'GET /api/admin/spaces': () => json(200, listPage([{ ...space, status: archived ? 'archived' : 'active' }])),
      [`POST /api/admin/spaces/${TEAM_ID}/archive`]: () => {
        archived = true
        return networkFailure()
      },
    })
    renderApp('/admin/spaces')
    fireEvent.click(within(await rowOf('市场部')).getByRole('button', { name: '归档 市场部' }))
    const archive = await screen.findByRole('dialog')
    const listed = count(spacesApi, 'GET /api/admin/spaces')
    fireEvent.click(within(archive).getByRole('button', { name: '归档' }))
    expect(await within(archive).findByText(/^没能确认是否已经完成（网络连接失败，请检查网络后重试）。可能已经生效/)).toBeInTheDocument()
    expect(count(spacesApi, 'GET /api/admin/spaces')).toBeGreaterThan(listed)
    expect(within(await rowOf('市场部')).getByText('已归档')).toBeInTheDocument()
  })

  it('作废邀请的结果未知：同样刷新列表、说明可能已经生效', async () => {
    let revoked = false
    const invitationsApi = installFakeApi({
      ...SPACES,
      'GET /api/auth/session': () => json(200, session('admin')),
      'GET /api/admin/invitations': () => json(200, listPage([{ ...INVITATION, status: revoked ? 'revoked' : 'pending' }] satisfies Invitation[])),
      [`POST /api/admin/invitations/${INVITATION.id}/revoke`]: () => {
        revoked = true
        return apiError(500, 'INTERNAL_ERROR')
      },
    })
    renderApp('/admin/invitations')
    fireEvent.click(within(await rowOf('bea')).getByRole('button', { name: '作废 bea' }))
    const revoke = await screen.findByRole('dialog')
    const before = count(invitationsApi, 'GET /api/admin/invitations')
    fireEvent.click(within(revoke).getByRole('button', { name: '作废' }))
    expect(await within(revoke).findByText(UNKNOWN)).toBeInTheDocument()
    expect(count(invitationsApi, 'GET /api/admin/invitations')).toBeGreaterThan(before)
    expect(within(await rowOf('bea')).getByText('已作废')).toBeInTheDocument()
  })
})

describe('管理界面：标题（M2-P6 复核 S4、G5）', () => {
  it('各页的浏览器标签页标题；成员打开管理界面：无权限的说明之上也有标题（h1）', async () => {
    installFakeApi({
      ...SPACES,
      'GET /api/auth/session': () => json(200, session('member')),
    })
    renderApp('/admin/users')
    expect(await screen.findByText('只有系统管理员能打开管理界面。')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: '管理' })).toBeInTheDocument()
    await waitFor(() => expect(document.title).toBe('管理 - NerveOffice'))
  })

  it('系统管理员打开账户页：标题是"账户 - 管理"', async () => {
    installFakeApi({
      ...SPACES,
      'GET /api/auth/session': () => json(200, session('admin')),
      'GET /api/admin/users': () => json(200, listPage([AMY])),
    })
    renderApp('/admin/users')
    await rowOf('amy')
    await waitFor(() => expect(document.title).toBe('账户 - 管理 - NerveOffice'))
  })
})
