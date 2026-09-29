// 管理界面：团队空间与停用者文档的转移（M2-P2 设计 §3.10，US-M2-04、05）。接口用假的 fetch。
import type { AdminSpace, AdminUser } from '@nerve-office/contracts'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { apiError, installFakeApi, json } from '../shared/testing/fake-api.test-support.ts'
import { AMY, listPage, ROOT_ID, rowOf, session, SPACES } from './admin.test-support.ts'
import { renderApp } from './render-app.test-support.tsx'

const SPACE: AdminSpace = { id: '0199a2c4-0000-7000-8000-0000000000c1', name: '市场部', status: 'active', visibleToAll: false, memberCount: 3, createdAt: '2026-09-29T01:00:00.000Z', myRole: null }
const BEN = { id: '0199a2c4-0000-7000-8000-00000000000b', username: 'ben', displayName: '本' }

function search(query: Record<string, string>): string {
  return `?${new URLSearchParams(query).toString()}`
}

function admin(handlers: Parameters<typeof installFakeApi>[0] = {}) {
  return installFakeApi({ ...SPACES, 'GET /api/auth/session': () => json(200, session('admin')), ...handlers })
}

function lastBody(api: ReturnType<typeof installFakeApi>, key: string): unknown {
  return api.requests.filter(request => request.key === key).at(-1)?.body
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

  it('创建：名称、按名字选首个空间管理员、全员可见；没有选空间管理员时不能创建；成功之后清空表单', async () => {
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
    fireEvent.change(within(form).getByLabelText('名称'), { target: { value: ' 市场部 ' } })
    expect(within(form).getByRole('button', { name: '创建团队空间' })).toHaveAttribute('aria-disabled', 'true')
    fireEvent.change(within(form).getByLabelText('首个空间管理员'), { target: { value: '本' } })
    fireEvent.click(await within(form).findByRole('button', { name: '本（ben）' }))
    fireEvent.click(within(form).getByLabelText('全员可见：所有有效账户都能以查看者的身份看到它'))
    fireEvent.click(within(form).getByRole('button', { name: '创建团队空间' }))
    expect(await rowOf('市场部')).toBeInTheDocument()
    expect(lastBody(api, 'POST /api/admin/spaces')).toEqual({ name: '市场部', adminUserId: BEN.id, visibleToAll: true })
    await waitFor(() => expect(within(form).getByLabelText('名称')).toHaveValue(''))
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
    fireEvent.click(await within(form).findByRole('button', { name: '本（ben）' }))
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
})

const LEAVER: AdminUser = { ...AMY, status: 'disabled' }

function titles(count: number) {
  return Array.from({ length: count }, (_, index) => ({ id: `0199a2c4-0000-7000-8000-0000000000d${index}`, title: `文档 ${index}`, type: 'sheet', updatedAt: '2026-09-29T01:00:00.000Z' }))
}

describe('US-M2-04 转移停用者的文档', () => {
  it('账户页：停用的账户才有"转移文档"', async () => {
    admin({ 'GET /api/admin/users': () => json(200, listPage([LEAVER, { ...AMY, id: '0199a2c4-0000-7000-8000-000000000099', username: 'bea', displayName: '贝亚' }])) })
    renderApp('/admin/users')
    expect(within(await rowOf('amy')).getByRole('link', { name: '转移文档 艾米（amy）' })).toHaveAttribute('href', `/admin/users/${AMY.id}/documents`)
    expect(within(await rowOf('bea')).queryByRole('link', { name: /^转移文档/ })).not.toBeInTheDocument()
  })

  it('只看得到标题；选文档与团队空间，确认之后整批转移，说明结果，列表刷新', async () => {
    let items = titles(3)
    const api = admin({
      [`GET /api/admin/users/${AMY.id}`]: () => json(200, LEAVER),
      [`GET /api/admin/users/${AMY.id}/documents`]: () => json(200, listPage(items)),
      [`GET /api/admin/spaces${search({ query: '市场', status: 'active' })}`]: () => json(200, listPage([SPACE])),
      [`POST /api/admin/users/${AMY.id}/documents/transfer`]: () => {
        items = items.slice(2)
        return json(200, { transferred: 2 })
      },
    })
    renderApp(`/admin/users/${AMY.id}/documents`)
    expect(await screen.findByRole('heading', { name: '转移 艾米（amy） 的文档' })).toBeInTheDocument()
    fireEvent.click(await screen.findByLabelText('选择 文档 0'))
    fireEvent.click(screen.getByLabelText('选择 文档 1'))
    expect(screen.getByText('已选择 2 份，一次最多 100 份')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '转移' })).toHaveAttribute('aria-disabled', 'true')
    fireEvent.change(screen.getByLabelText('按名称搜索团队空间'), { target: { value: '市场' } })
    fireEvent.click(await screen.findByRole('button', { name: '市场部' }))
    fireEvent.click(screen.getByRole('button', { name: '转移' }))
    const dialog = await screen.findByRole('dialog', { name: '把 2 份文档转移到 市场部？' })
    fireEvent.click(within(dialog).getByRole('button', { name: '转移' }))
    expect(await screen.findByText('已把 2 份文档转移到 市场部')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('文档 0')).not.toBeInTheDocument())
    expect(lastBody(api, `POST /api/admin/users/${AMY.id}/documents/transfer`)).toEqual({ documentIds: [titles(3)[0]?.id, titles(3)[1]?.id], target: { type: 'team', spaceId: SPACE.id } })
  })

  it('转移到某人的个人空间：按名字选同事（不列出这个停用的人自己）', async () => {
    const api = admin({
      [`GET /api/admin/users/${AMY.id}`]: () => json(200, LEAVER),
      [`GET /api/admin/users/${AMY.id}/documents`]: () => json(200, listPage(titles(1))),
      [`GET /api/users${search({ query: '本' })}`]: () => json(200, { items: [BEN] }),
      [`POST /api/admin/users/${AMY.id}/documents/transfer`]: () => apiError(409, 'TRANSFER_CONFLICT'),
    })
    renderApp(`/admin/users/${AMY.id}/documents`)
    fireEvent.click(await screen.findByLabelText('全选已加载的文档'))
    fireEvent.click(screen.getByRole('radio', { name: '某人的个人空间' }))
    fireEvent.change(screen.getByLabelText('按名字找同事'), { target: { value: '本' } })
    fireEvent.click(await screen.findByRole('button', { name: '本（ben）' }))
    fireEvent.click(screen.getByRole('button', { name: '转移' }))
    const dialog = await screen.findByRole('dialog', { name: '把 1 份文档转移到 本（ben） 的个人空间？' })
    fireEvent.click(within(dialog).getByRole('button', { name: '转移' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('有文档已经不在这个人的个人空间里')
    expect(lastBody(api, `POST /api/admin/users/${AMY.id}/documents/transfer`)).toEqual({ documentIds: [titles(1)[0]?.id], target: { type: 'personal', userId: BEN.id } })
  })

  it('账户仍然有效：说明只有停用的账户才能转移，不列文档', async () => {
    const api = admin({ [`GET /api/admin/users/${AMY.id}`]: () => json(200, AMY) })
    renderApp(`/admin/users/${AMY.id}/documents`)
    expect(await screen.findByText('账户仍然有效：只有停用的账户才能转移文档')).toBeInTheDocument()
    expect(api.requests.some(request => request.key.endsWith('/documents'))).toBe(false)
  })
})
