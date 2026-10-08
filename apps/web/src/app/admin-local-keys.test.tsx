// 管理界面：吊销本机密钥（M3-P6 设计 §3.8，US-M3-17）。账户页每一行都有（所有状态的账户）；确认框说清楚本机密钥的用途与吊销的后果，
// 不说"没同步的修改都会作废"（A14）；成功的说明等确认框关掉之后写进页面顶部的状态区；结果未知用专门的说法（再吊销一次没有坏处）；
// 焦点回到这一行的按钮；吊销不动会话，自己的账户也不重新确认。接口用假的 fetch。
import type { AdminUser } from '@nerve-office/contracts'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { watchAnnouncement } from '../shared/testing/announcement.test-support.ts'
import { apiError, installFakeApi, inTurn, json, networkFailure } from '../shared/testing/fake-api.test-support.ts'
import { plainName } from '../shared/testing/people.test-support.ts'
import { AMY, listPage, ROOT, rowOf, session, SPACES } from './admin.test-support.ts'
import { renderApp } from './render-app.test-support.tsx'

const AMY_NAME = plainName('艾米', 'amy')
const ROOT_NAME = plainName('管理员', 'root')
const REVOKE_AMY = `POST /api/admin/users/${AMY.id}/local-key/revoke`
const REVOKE_ROOT = `POST /api/admin/users/${ROOT.id}/local-key/revoke`
const USERS = 'GET /api/admin/users'
const SESSION = 'GET /api/auth/session'

function withKey(user: AdminUser, version: number): AdminUser {
  return { ...user, localKey: { version, createdAt: '2026-10-08T02:00:00.000Z' } }
}

function count(api: ReturnType<typeof installFakeApi>, key: string): number {
  return api.requests.filter(request => request.key === key).length
}

function admin(users: readonly AdminUser[], handlers: Parameters<typeof installFakeApi>[0]) {
  return installFakeApi({ ...SPACES, [SESSION]: () => json(200, session('admin')), [USERS]: () => json(200, listPage(users)), ...handlers })
}

/** 点行里的"吊销本机密钥"（先让它得到焦点，与键盘操作一样），返回这个按钮与弹出的确认框 */
async function openRevoke(row: HTMLElement, name: string): Promise<{ readonly button: HTMLElement, readonly dialog: HTMLElement }> {
  const button = within(row).getByRole('button', { name: `吊销本机密钥 ${name}` })
  button.focus()
  fireEvent.click(button)
  return { button, dialog: await screen.findByRole('dialog') }
}

function confirmIn(dialog: HTMLElement): void {
  fireEvent.click(within(dialog).getByRole('button', { name: '吊销本机密钥' }))
}

/** 账户页顶部的状态区（共用的 StatusRegion）：弹窗开着时它在 aria-hidden 之下，也找得到 */
function statusRegion(): HTMLElement {
  const region = screen.getAllByRole('status', { hidden: true }).find(element => element.getAttribute('data-slot') === 'status-region')
  if (region === undefined)
    throw new Error('账户页没有状态区')
  return region
}

describe('管理界面：吊销本机密钥（M3-P6 设计 §3.8，US-M3-17）', () => {
  it('吊销别人的：确认框说清楚本机密钥的用途与后果，按钮醒目；确认之后请求一次，弹窗关掉之后状态区说明换成了第几版；焦点回到这一行的"吊销本机密钥"；列表不刷新、会话不重新确认', async () => {
    const api = admin([ROOT, withKey(AMY, 1)], { [REVOKE_AMY]: () => json(200, withKey(AMY, 2)) })
    renderApp('/admin/users')
    const { button, dialog } = await openRevoke(await rowOf('amy'), AMY_NAME)
    expect(dialog).toHaveAccessibleName(`吊销 ${AMY_NAME} 的本机密钥？`)
    expect(dialog).toHaveAccessibleDescription('本机密钥用来加密保存在浏览器里、还没同步的草稿，吊销之后用旧密钥加密的草稿都无法再解开；已经保存到云端的文档不受影响，这个人的登录也不会退出。设备可能落在别人手里时，请同时为他生成重置链接（会退出他在所有地方的登录）。')
    // 不说"没同步的修改都会作废"：页面里还没保存的修改不受吊销影响，那样说不实（A14）
    expect(dialog).not.toHaveTextContent(/修改/)
    expect(within(dialog).getByRole('button', { name: '吊销本机密钥' })).toHaveAttribute('data-variant', 'destructive')
    const listed = count(api, USERS)
    const announced = watchAnnouncement(`已吊销 ${AMY_NAME} 的本机密钥`)
    confirmIn(dialog)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(statusRegion()).toHaveTextContent(`已吊销 ${AMY_NAME} 的本机密钥，换成了第 2 版。`))
    // 等确认的弹窗关掉之后才写进去（M2-P5 复验 S1）：写进去的那一刻页面不在 aria-hidden 之下，焦点已经交还
    expect(announced()).toEqual({ ariaHidden: false, focusReturned: true })
    await waitFor(() => expect(document.activeElement).toBe(button))
    expect(count(api, REVOKE_AMY)).toBe(1)
    // 吊销不改这一行显示的任何一项：不刷新列表；吊销不动会话：不重新确认
    expect(count(api, USERS)).toBe(listed)
    expect(count(api, SESSION)).toBe(1)
  })

  it('吊销自己的：专门的标题与说明（你的登录不会退出、为自己生成重置链接）；成功之后同样写进状态区，不重新确认会话', async () => {
    const api = admin([withKey(ROOT, 3), AMY], { [REVOKE_ROOT]: () => json(200, withKey(ROOT, 4)) })
    renderApp('/admin/users')
    const { button, dialog } = await openRevoke(await rowOf('root'), ROOT_NAME)
    expect(dialog).toHaveAccessibleName('吊销你自己的本机密钥？')
    expect(dialog).toHaveAccessibleDescription('本机密钥用来加密保存在浏览器里、还没同步的草稿，吊销之后用旧密钥加密的草稿都无法再解开；已经保存到云端的文档不受影响，你的登录也不会退出。设备可能落在别人手里时，请同时为自己生成重置链接（会退出你在所有地方的登录）。')
    expect(within(dialog).getByRole('button', { name: '吊销本机密钥' })).toHaveAttribute('data-variant', 'destructive')
    confirmIn(dialog)
    await waitFor(() => expect(statusRegion()).toHaveTextContent(`已吊销 ${ROOT_NAME} 的本机密钥，换成了第 4 版。`))
    await waitFor(() => expect(document.activeElement).toBe(button))
    expect(count(api, REVOKE_ROOT)).toBe(1)
    expect(count(api, SESSION)).toBe(1)
  })

  it('点按钮不给焦点的浏览器（WebKit）：打开之前的焦点记不下来，关掉之后焦点回到这一行，不落到 body（审查 B9）', async () => {
    admin([withKey(AMY, 1)], { [REVOKE_AMY]: () => json(200, withKey(AMY, 2)) })
    renderApp('/admin/users')
    const row = await rowOf('amy')
    ;(document.activeElement as HTMLElement | null)?.blur()
    fireEvent.click(within(row).getByRole('button', { name: `吊销本机密钥 ${AMY_NAME}` }))
    confirmIn(await screen.findByRole('dialog'))
    await waitFor(() => expect(statusRegion()).toHaveTextContent(`已吊销 ${AMY_NAME} 的本机密钥，换成了第 2 版。`))
    await waitFor(() => expect(document.activeElement).toBe(row))
  })

  it('停用的账户也能吊销；这个人从没取过本机密钥：服务端原样返回，状态区说明没有要吊销的', async () => {
    const disabled: AdminUser = { ...AMY, status: 'disabled' }
    const api = admin([disabled], { [REVOKE_AMY]: () => json(200, disabled) })
    renderApp('/admin/users')
    const { dialog } = await openRevoke(await rowOf('amy'), AMY_NAME)
    confirmIn(dialog)
    await waitFor(() => expect(statusRegion()).toHaveTextContent(`${AMY_NAME} 还没有本机密钥，没有要吊销的。`))
    expect(count(api, REVOKE_AMY)).toBe(1)
  })

  it('结果未知（断网）：专门的说法——没能确认是否已经吊销、再吊销一次没有坏处，不用通用的"页面已刷新"；不刷新列表；弹窗留着，再点一次成功', async () => {
    const api = admin([withKey(AMY, 1)], { [REVOKE_AMY]: inTurn(networkFailure, () => json(200, withKey(AMY, 3))) })
    renderApp('/admin/users')
    const { button, dialog } = await openRevoke(await rowOf('amy'), AMY_NAME)
    const listed = count(api, USERS)
    confirmIn(dialog)
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('没能确认是否已经吊销（网络连接失败，请检查网络后重试）。再吊销一次没有坏处：会再换一把新的密钥，之前的都已作废。')
    expect(count(api, USERS)).toBe(listed)
    expect(statusRegion()).toBeEmptyDOMElement()
    confirmIn(dialog)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(statusRegion()).toHaveTextContent(`已吊销 ${AMY_NAME} 的本机密钥，换成了第 3 版。`))
    await waitFor(() => expect(document.activeElement).toBe(button))
    expect(count(api, REVOKE_AMY)).toBe(2)
  })

  it('确定的失败（例如这个账户不在了）：按错误码说明，不说成结果未知；弹窗留着，状态区不写', async () => {
    admin([AMY], { [REVOKE_AMY]: () => apiError(404, 'NOT_FOUND') })
    renderApp('/admin/users')
    const { dialog } = await openRevoke(await rowOf('amy'), AMY_NAME)
    confirmIn(dialog)
    const alert = await within(dialog).findByRole('alert')
    expect(alert).toHaveTextContent('内容不存在，或者你没有访问权限')
    expect(alert).not.toHaveTextContent('没能确认')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(statusRegion()).toBeEmptyDOMElement()
  })

  it('打开下一个确认的弹窗（别的操作也一样）时清掉状态区里上一次的说明：同样的说法再出现时照样是一次变化，读屏照样播报', async () => {
    const nothing = `${AMY_NAME} 还没有本机密钥，没有要吊销的。`
    admin([AMY], { [REVOKE_AMY]: () => json(200, AMY) })
    renderApp('/admin/users')
    const row = await rowOf('amy')
    confirmIn((await openRevoke(row, AMY_NAME)).dialog)
    await waitFor(() => expect(statusRegion()).toHaveTextContent(nothing))

    // 再吊销一次：打开确认框时清掉，确认之后同样的说法重新写进去
    const { dialog } = await openRevoke(row, AMY_NAME)
    expect(statusRegion()).toBeEmptyDOMElement()
    const announced = watchAnnouncement(nothing)
    confirmIn(dialog)
    await waitFor(() => expect(statusRegion()).toHaveTextContent(nothing))
    expect(announced()).toEqual({ ariaHidden: false, focusReturned: true })

    // 别的操作的确认框也清掉（说明只对刚做完的那一次）
    fireEvent.click(within(row).getByRole('button', { name: `停用 ${AMY_NAME}` }))
    const disable = await screen.findByRole('dialog')
    expect(statusRegion()).toBeEmptyDOMElement()
    fireEvent.click(within(disable).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(statusRegion()).toBeEmptyDOMElement()
  })
})
