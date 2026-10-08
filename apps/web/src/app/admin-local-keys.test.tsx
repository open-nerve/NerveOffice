// 管理界面：吊销本机密钥（M3-P6 设计 §3.8，US-M3-17）。账户页每一行都有（所有状态的账户）；确认框说清楚本机密钥的用途与吊销的后果，
// 不说"没同步的修改都会作废"（A14）、正面说正在编辑的页面照常保存（审查 B7），自己、别人、停用的各一版（审查 B1），逐字核对；
// 成功之后这一行"状态"列里本机密钥的版本按响应换成新的一版（审查 B2），说明等确认框关掉之后写进页面顶部的状态区；结果未知时刷新列表、
// 用专门的说法（再吊销一次没有坏处）；焦点回到这一行的按钮；吊销不动会话，自己的账户也不重新确认。接口用假的 fetch。
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

/** 这一行的"状态"列（登录名、显示名、角色、状态、创建时间、操作）：弹窗开着时它在 aria-hidden 之下，也找得到 */
function statusCell(row: HTMLElement): HTMLElement {
  const cell = within(row).getAllByRole('cell', { hidden: true })[3]
  if (cell === undefined)
    throw new Error('这一行没有"状态"列')
  return cell
}

/** "状态"列里本机密钥的那一行小字（审查 B2）：从没取过本机密钥的没有 */
function keyLine(row: HTMLElement): HTMLElement | null {
  return within(statusCell(row)).queryByText(/^本机密钥第 \d+ 版$/)
}

/** 账户页顶部的状态区（共用的 StatusRegion）：弹窗开着时它在 aria-hidden 之下，也找得到 */
function statusRegion(): HTMLElement {
  const region = screen.getAllByRole('status', { hidden: true }).find(element => element.getAttribute('data-slot') === 'status-region')
  if (region === undefined)
    throw new Error('账户页没有状态区')
  return region
}

describe('管理界面：吊销本机密钥（M3-P6 设计 §3.8，US-M3-17）', () => {
  it('吊销别人的：确认框说清楚本机密钥的用途与后果，按钮醒目；确认之后请求一次，这一行的本机密钥按响应换成第 2 版，弹窗关掉之后状态区说明换成了第几版；焦点回到这一行的"吊销本机密钥"；列表不刷新、会话不重新确认', async () => {
    const api = admin([ROOT, withKey(AMY, 1)], { [REVOKE_AMY]: () => json(200, withKey(AMY, 2)) })
    renderApp('/admin/users')
    const row = await rowOf('amy')
    expect(keyLine(row)).toHaveTextContent('本机密钥第 1 版')
    const { button, dialog } = await openRevoke(row, AMY_NAME)
    expect(dialog).toHaveAccessibleName(`吊销 ${AMY_NAME} 的本机密钥？`)
    // 不说"没同步的修改都会作废"（页面里还没保存的修改不受吊销影响，那样说不实，A14），正面说正在编辑的页面照常保存（审查 B7）
    expect(dialog).toHaveAccessibleDescription('本机密钥用来加密保存在浏览器里、还没同步的草稿，吊销之后用旧密钥加密的草稿都无法再解开；已经保存到云端的文档不受影响；他正在编辑的页面也不受影响，修改照常保存；他的登录也不会退出。设备可能落在别人手里时，请同时为他生成重置链接（会退出他在所有地方的登录）。')
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
    // 这一行按响应（吊销之后的账户）换上：明眼人在这一行看得见结果（审查 B2）；别的行不变，不刷新列表；吊销不动会话：不重新确认
    expect(keyLine(row)).toHaveTextContent('本机密钥第 2 版')
    expect(count(api, USERS)).toBe(listed)
    expect(count(api, SESSION)).toBe(1)
  })

  it('吊销自己的：专门的标题与说明（你正在编辑的页面照常保存、你的登录不会退出、为自己生成重置链接）；成功之后同样写进状态区，不重新确认会话', async () => {
    const api = admin([withKey(ROOT, 3), AMY], { [REVOKE_ROOT]: () => json(200, withKey(ROOT, 4)) })
    renderApp('/admin/users')
    const row = await rowOf('root')
    expect(keyLine(row)).toHaveTextContent('本机密钥第 3 版')
    const { button, dialog } = await openRevoke(row, ROOT_NAME)
    expect(dialog).toHaveAccessibleName('吊销你自己的本机密钥？')
    expect(dialog).toHaveAccessibleDescription('本机密钥用来加密保存在浏览器里、还没同步的草稿，吊销之后用旧密钥加密的草稿都无法再解开；已经保存到云端的文档不受影响；你正在编辑的页面也不受影响，修改照常保存；你的登录也不会退出。设备可能落在别人手里时，请同时为自己生成重置链接（会退出你在所有地方的登录）。')
    expect(within(dialog).getByRole('button', { name: '吊销本机密钥' })).toHaveAttribute('data-variant', 'destructive')
    confirmIn(dialog)
    await waitFor(() => expect(statusRegion()).toHaveTextContent(`已吊销 ${ROOT_NAME} 的本机密钥，换成了第 4 版。`))
    expect(keyLine(row)).toHaveTextContent('本机密钥第 4 版')
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

  it('停用的账户也能吊销：说明另一版——登录都已退出、重新启用之后旧密码照旧可用，启用之后再生成重置链接（这时这一行没有"生成重置链接"）；启用的确认框里同样提醒。这个人从没取过本机密钥：服务端原样返回，状态区说明没有要吊销的', async () => {
    const disabled: AdminUser = { ...AMY, status: 'disabled' }
    const api = admin([disabled], { [REVOKE_AMY]: () => json(200, disabled) })
    renderApp('/admin/users')
    const row = await rowOf('amy')
    expect(within(row).queryByRole('button', { name: `生成重置链接 ${AMY_NAME}` })).toBeNull()
    // 从没取过本机密钥：这一行不显示本机密钥
    expect(keyLine(row)).toBeNull()
    const { dialog } = await openRevoke(row, AMY_NAME)
    expect(dialog).toHaveAccessibleName(`吊销 ${AMY_NAME} 的本机密钥？`)
    expect(dialog).toHaveAccessibleDescription('本机密钥用来加密保存在浏览器里、还没同步的草稿，吊销之后用旧密钥加密的草稿都无法再解开；已经保存到云端的文档不受影响。这个账户已停用，他在所有地方的登录都已退出；重新启用之后旧密码照旧可用——设备可能落在别人手里时，启用之后请立即为他生成重置链接。')
    confirmIn(dialog)
    await waitFor(() => expect(statusRegion()).toHaveTextContent(`${AMY_NAME} 还没有本机密钥，没有要吊销的。`))
    expect(count(api, REVOKE_AMY)).toBe(1)
    expect(keyLine(row)).toBeNull()

    // 启用的确认框：设备丢失而停用的，启用之后旧密码照旧可用，要立即生成重置链接
    fireEvent.click(within(row).getByRole('button', { name: `启用 ${AMY_NAME}` }))
    const enable = await screen.findByRole('dialog')
    expect(enable).toHaveAccessibleName(`启用 ${AMY_NAME}？`)
    expect(enable).toHaveAccessibleDescription('启用后这个人可以照常登录。停用期间转移走的文档不会回到他的个人空间。停用是因为设备丢失的，启用之后请立即为他生成重置链接：旧密码照旧可用。')
  })

  it('结果未知（断网）：刷新账户列表，这一行随之是本机密钥现在的版本（这里那一次其实已经生效：第 2 版）；专门的说法——没能确认是否已经吊销、列表已刷新、再吊销一次没有坏处，不用通用的"还没有生效的话可以再试一次"；弹窗留着，再点一次成功', async () => {
    let attempted = false
    const api = admin([], {
      // 那一次其实已经生效：之后的列表里是第 2 版
      [USERS]: () => json(200, listPage([withKey(AMY, attempted ? 2 : 1)])),
      [REVOKE_AMY]: inTurn(() => {
        attempted = true
        return networkFailure()
      }, () => json(200, withKey(AMY, 3))),
    })
    renderApp('/admin/users')
    const row = await rowOf('amy')
    expect(keyLine(row)).toHaveTextContent('本机密钥第 1 版')
    const { button, dialog } = await openRevoke(row, AMY_NAME)
    const listed = count(api, USERS)
    confirmIn(dialog)
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('没能确认是否已经吊销（网络连接失败，请检查网络后重试）。列表已刷新：这一行显示的是本机密钥现在的版本。再吊销一次没有坏处：会再换一把新的密钥，之前的都已作废。')
    expect(count(api, USERS)).toBe(listed + 1)
    expect(keyLine(row)).toHaveTextContent('本机密钥第 2 版')
    expect(statusRegion()).toBeEmptyDOMElement()
    confirmIn(dialog)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(statusRegion()).toHaveTextContent(`已吊销 ${AMY_NAME} 的本机密钥，换成了第 3 版。`))
    expect(keyLine(row)).toHaveTextContent('本机密钥第 3 版')
    await waitFor(() => expect(document.activeElement).toBe(button))
    expect(count(api, REVOKE_AMY)).toBe(2)
  })

  it('结果未知、随后刷新账户列表也失败（仍然断网）：说明列表没能刷新、显示的可能还是之前的，不说"这一行显示的是本机密钥现在的版本"', async () => {
    let lists = 0
    admin([], {
      [USERS]: () => {
        lists += 1
        return lists === 1 ? json(200, listPage([withKey(AMY, 1)])) : networkFailure()
      },
      [REVOKE_AMY]: () => networkFailure(),
    })
    renderApp('/admin/users')
    const { dialog } = await openRevoke(await rowOf('amy'), AMY_NAME)
    confirmIn(dialog)
    expect(await within(dialog).findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent('没能确认是否已经吊销（网络连接失败，请检查网络后重试）。列表没能刷新，显示的可能还是之前的，请稍后再看。再吊销一次没有坏处：会再换一把新的密钥，之前的都已作废。')
    expect(lists).toBeGreaterThan(1)
    expect(statusRegion()).toBeEmptyDOMElement()
  })

  it('账户列表的"状态"列：取过本机密钥的人显示当前是第几版（停用的也一样），从没取过的不显示；与登录锁定的说明一样是这一格里的一行小字', async () => {
    const cat: AdminUser = { ...withKey(AMY, 5), id: '0199a2c4-0000-7000-8000-000000000003', username: 'cat', displayName: '凯特', status: 'disabled' }
    admin([withKey(ROOT, 2), AMY, cat], {})
    renderApp('/admin/users')
    expect(keyLine(await rowOf('root'))).toHaveTextContent('本机密钥第 2 版')
    expect(keyLine(await rowOf('cat'))).toHaveTextContent('本机密钥第 5 版')
    expect(keyLine(await rowOf('amy'))).toBeNull()
    expect(within(statusCell(await rowOf('cat'))).getByText('已停用')).toBeInTheDocument()
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
