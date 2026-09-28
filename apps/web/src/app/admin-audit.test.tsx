// 管理界面：审计查询（M2-P1 设计 §3.7、§3.8，US-M2-13，审查 B8、B9、B14）：筛选、时间换算、找操作者、按对象筛选与清除、分页。
import type { AuditEventItem } from '@nerve-office/contracts'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { apiError, installFakeApi, json } from '../shared/testing/fake-api.test-support.ts'
import { AMY, deferred, EVENT, listPage, ROOT, session, settle } from './admin.test-support.ts'
import { renderApp } from './render-app.test-support.tsx'

const LIST = 'GET /api/admin/audit-events'

function event(index: number, changes: Partial<AuditEventItem> = {}): AuditEventItem {
  return { ...EVENT, id: `0199a2c4-0000-7000-8000-0000000002${String(index).padStart(2, '0')}`, ...changes }
}

function audit(handlers: Parameters<typeof installFakeApi>[0] = {}) {
  return installFakeApi({ 'GET /api/auth/session': () => json(200, session('admin')), ...handlers })
}

function requested(api: ReturnType<typeof installFakeApi>, key: string): boolean {
  return api.requests.some(request => request.key === key)
}

/** 表格的第 index 行（0 是表头） */
function rowAt(table: HTMLElement, index: number): HTMLElement {
  const row = within(table).getAllByRole('row')[index]
  if (row === undefined)
    throw new Error(`表格没有第 ${index} 行`)
  return row
}

describe('管理界面：审计', () => {
  it('显示操作者、动作、对象与来源（客户端地址与请求标识）；按动作筛选', async () => {
    const api = audit({
      [LIST]: () => json(200, listPage([EVENT, event(2, { actor: { type: 'system', id: null, username: null, displayName: null }, target: null, source: 'cli', requestId: null, clientIp: null, details: { purpose: 'password_reset' } })])),
      [`${LIST}?action=users.disabled`]: () => json(200, listPage([EVENT])),
    })
    renderApp('/admin/audit')
    const table = await screen.findByRole('table', { name: '审计事件' })
    const first = rowAt(table, 1)
    expect(first).toHaveTextContent('管理员（root）')
    expect(within(first).getByText('停用账户')).toBeInTheDocument()
    expect(within(first).getByText('网页 · 192.0.2.1')).toBeInTheDocument()
    // 请求标识：等宽小字，放在来源一格里（审查 B8）
    expect(within(first).getByText('req-1')).toHaveAttribute('title', '请求标识：req-1')
    const second = rowAt(table, 2)
    expect(second).toHaveTextContent('系统')
    expect(within(second).getByText('命令行')).toBeInTheDocument()
    expect(within(second).getByText('{"purpose":"password_reset"}')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('动作'), { target: { value: 'users.disabled' } })
    await waitFor(() => expect(requested(api, `${LIST}?action=users.disabled`)).toBe(true))
  })

  it('点对象只看这个对象：焦点移到"清除对象的筛选"；清除之后焦点回到动作的筛选，请求不再带对象（审查 B9、B14）', async () => {
    const api = audit({
      [LIST]: () => json(200, listPage([EVENT])),
      [`${LIST}?targetId=${AMY.id}&targetType=user`]: () => json(200, listPage([EVENT])),
    })
    renderApp('/admin/audit')
    const target = await screen.findByRole('button', { name: '账户：艾米（amy）' })
    target.focus()
    fireEvent.click(target)
    expect(await screen.findByText('对象：账户：艾米（amy）')).toBeInTheDocument()
    await waitFor(() => expect(requested(api, `${LIST}?targetId=${AMY.id}&targetType=user`)).toBe(true))
    const clear = screen.getByRole('button', { name: '清除对象的筛选' })
    expect(clear).toHaveTextContent('清除')
    await waitFor(() => expect(document.activeElement).toBe(clear))

    const before = api.requests.length
    fireEvent.click(clear)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('动作')))
    expect(screen.queryByText('对象：账户：艾米（amy）')).toBeNull()
    // 回到没有条件的查询：缓存里有，不必再请求；请求的一定没有对象
    await settle()
    expect(api.requests.slice(before).every(request => !request.key.includes('targetId'))).toBe(true)
  })

  it('前端不认识的对象类型：只按 id 筛选', async () => {
    const future = event(3, { target: { type: 'folder', id: '0199a2c4-0000-7000-8000-0000000003aa', label: null } })
    const api = audit({
      [LIST]: () => json(200, listPage([future])),
      [`${LIST}?targetId=0199a2c4-0000-7000-8000-0000000003aa`]: () => json(200, listPage([future])),
    })
    renderApp('/admin/audit')
    fireEvent.click(await screen.findByRole('button', { name: 'folder：0199a2c4-0000-7000-8000-0000000003aa' }))
    await waitFor(() => expect(requested(api, `${LIST}?targetId=0199a2c4-0000-7000-8000-0000000003aa`)).toBe(true))
  })

  it('时间按本地时间输入，换算成 UTC；结束时间含所选的这一分钟（审查 B8）', async () => {
    vi.stubEnv('TZ', 'Etc/GMT-8')
    onTestFinished(() => {
      vi.unstubAllEnvs()
    })
    const from = `${LIST}?from=2026-09-28T02%3A30%3A00.000Z`
    const fromTo = `${from}&to=2026-09-28T02%3A31%3A00.000Z`
    const api = audit({
      [LIST]: () => json(200, listPage([EVENT])),
      [from]: () => json(200, listPage([EVENT])),
      [fromTo]: () => json(200, listPage([])),
    })
    renderApp('/admin/audit')
    await screen.findByRole('table', { name: '审计事件' })
    fireEvent.change(screen.getByLabelText('开始时间'), { target: { value: '2026-09-28T10:30' } })
    await waitFor(() => expect(requested(api, from)).toBe(true))
    fireEvent.change(screen.getByLabelText('结束时间'), { target: { value: '2026-09-28T10:30' } })
    expect(await screen.findByText('没有符合条件的事件')).toBeInTheDocument()
    expect(requested(api, fromTo)).toBe(true)
    expect(screen.getByLabelText('开始时间')).toHaveAttribute('aria-invalid', 'false')
  })

  it('换算出来接口不接受的时间（UTC 的 0 年）：不发出去，输入框标成无效（审查 B8）', async () => {
    vi.stubEnv('TZ', 'Etc/GMT-8')
    onTestFinished(() => {
      vi.unstubAllEnvs()
    })
    const api = audit({ [LIST]: () => json(200, listPage([EVENT])) })
    renderApp('/admin/audit')
    await screen.findByRole('table', { name: '审计事件' })
    fireEvent.change(screen.getByLabelText('开始时间'), { target: { value: '0001-01-01T05:00' } })
    expect(screen.getByLabelText('开始时间')).toHaveAttribute('aria-invalid', 'true')
    await settle()
    expect(api.requests.filter(request => request.key.startsWith(LIST)).map(request => request.key)).toEqual([LIST])
  })

  it('找操作者：查找中有提示；选中之后焦点移到"清除操作者的筛选"，请求带上操作者；清除之后焦点回到输入框（审查 B8、B9）', async () => {
    const candidates = deferred()
    const api = audit({
      [LIST]: () => json(200, listPage([EVENT])),
      'GET /api/admin/users?query=%E7%AE%A1': candidates.handler,
      [`${LIST}?actorId=${ROOT.id}`]: () => json(200, listPage([EVENT])),
    })
    renderApp('/admin/audit')
    await screen.findByRole('table', { name: '审计事件' })
    fireEvent.change(screen.getByLabelText('按名字找操作者'), { target: { value: '管' } })
    // 输入停下 300 毫秒之后才查找
    expect(await screen.findByText('正在查找…', {}, { timeout: 2000 })).toHaveAttribute('role', 'status')
    candidates.resolve(json(200, listPage([ROOT])))
    const candidate = await within(await screen.findByRole('list', { name: '操作者' })).findByRole('button', { name: '管理员（root）' })
    candidate.focus()
    fireEvent.click(candidate)
    expect(await screen.findByText('操作者：管理员（root）')).toBeInTheDocument()
    expect(screen.queryByLabelText('按名字找操作者')).toBeNull()
    await waitFor(() => expect(requested(api, `${LIST}?actorId=${ROOT.id}`)).toBe(true))
    const clear = screen.getByRole('button', { name: '清除操作者的筛选' })
    await waitFor(() => expect(document.activeElement).toBe(clear))

    fireEvent.click(clear)
    const input = await screen.findByLabelText('按名字找操作者')
    await waitFor(() => expect(document.activeElement).toBe(input))
    expect(input).toHaveValue('')
  })

  it('找操作者：没有找到时说明；查找失败时说明原因，可以重试（审查 B8）', async () => {
    let failing = true
    const api = audit({
      [LIST]: () => json(200, listPage([EVENT])),
      'GET /api/admin/users?query=zzz': () => json(200, listPage([])),
      'GET /api/admin/users?query=amy': () => (failing ? apiError(400, 'REQUEST_INVALID') : json(200, listPage([AMY]))),
    })
    renderApp('/admin/audit')
    await screen.findByRole('table', { name: '审计事件' })
    fireEvent.change(screen.getByLabelText('按名字找操作者'), { target: { value: 'zzz' } })
    expect(await screen.findByText('没有找到这个人')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('按名字找操作者'), { target: { value: 'amy' } })
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('查找失败：请求的内容不合法，请检查后重试')
    failing = false
    fireEvent.click(within(alert).getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('button', { name: '艾米（amy）' })).toBeInTheDocument()
    expect(api.requests.filter(request => request.key === 'GET /api/admin/users?query=amy')).toHaveLength(2)
  })

  it('加载更多：按游标取下一页，焦点移到第一条新行；下一页失败时保留已有的行并提示', async () => {
    const api = audit({
      [LIST]: () => json(200, listPage([event(1)], 'c1')),
      [`${LIST}?cursor=c1`]: () => json(200, listPage([event(2, { action: 'users.enabled' })], 'c2')),
      [`${LIST}?cursor=c2`]: () => apiError(500, 'INTERNAL_ERROR'),
    })
    renderApp('/admin/audit')
    const table = await screen.findByRole('table', { name: '审计事件' })
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }))
    expect(await within(table).findByText('启用账户')).toBeInTheDocument()
    await waitFor(() => expect(document.activeElement).toBe(rowAt(table, 2)))

    const more = screen.getByRole('button', { name: '加载更多' })
    more.focus()
    fireEvent.click(more)
    // 5xx 自动重试一次，之后才显示失败
    expect(await screen.findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent('服务器出了点问题，请稍后重试')
    expect(within(table).getAllByRole('row')).toHaveLength(3)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '加载更多' }))
    expect(api.requests.filter(request => request.key === `${LIST}?cursor=c2`)).toHaveLength(2)
  })
})
