// 管理界面：吊销本机密钥（M3-P6 设计 §3.8，US-M3-17）。账户页每一行都有（所有状态的账户）；确认框说清楚本机密钥的用途与吊销的后果，
// 不说"没同步的修改都会作废"（A14）、正面说正在编辑的页面照常保存（审查 B7），自己、别人、停用的各一版（审查 B1），逐字核对；
// 成功之后这一行"状态"列里本机密钥的版本按响应换成新的一版（审查 B2），随后与别的操作一样刷新列表——先取消在路上的列表请求，
// 它们回来时不会把这一行换回吊销之前的版本（复验 C1）；说明等确认框关掉之后写进页面顶部的状态区；结果未知时刷新列表、
// 用专门的说法（再吊销一次没有坏处）；焦点回到这一行的按钮；吊销不动会话，自己的账户也不重新确认。接口用假的 fetch，
// 账户与本机密钥的版本存在有状态的假服务端里（keyServer）：刷新回来的是服务端现在的样子。
import type { AdminUser } from '@nerve-office/contracts'
import type { Handler } from '../shared/testing/fake-api.test-support.ts'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OUTCOME_REFRESH_TIME_LIMIT_MS } from '../shared/api/write-outcome.ts'
import { watchAnnouncement } from '../shared/testing/announcement.test-support.ts'
import { apiError, installFakeApi, inTurn, json, networkFailure } from '../shared/testing/fake-api.test-support.ts'
import { plainName } from '../shared/testing/people.test-support.ts'
import { AMY, listPage, ROOT, rowOf, session, settle, SPACES } from './admin.test-support.ts'
import { renderApp } from './render-app.test-support.tsx'

const AMY_NAME = plainName('艾米', 'amy')
const ROOT_NAME = plainName('管理员', 'root')
const BEN: AdminUser = { ...AMY, id: '0199a2c4-0000-7000-8000-00000000000b', username: 'ben', displayName: '本', status: 'disabled' }
const BEN_NAME = plainName('本', 'ben')
const REVOKE_AMY = `POST /api/admin/users/${AMY.id}/local-key/revoke`
const REVOKE_ROOT = `POST /api/admin/users/${ROOT.id}/local-key/revoke`
const ENABLE_BEN = `POST /api/admin/users/${BEN.id}/enable`
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

/**
 * 有状态的假服务端（复验 C1）：账户按 id 存着，列表按收到请求那一刻的样子回答；吊销把这个人当前的本机密钥换成下一版
 * （从没取过的原样），交回吊销之后的账户。吊销之后的刷新回来的就是吊销之后的样子
 */
function keyServer(initial: readonly AdminUser[]) {
  const users = new Map(initial.map(user => [user.id, user]))
  function change(id: string, update: (user: AdminUser) => AdminUser): AdminUser {
    const user = users.get(id)
    if (user === undefined)
      throw new Error(`假服务端里没有这个账户：${id}`)
    const next = update(user)
    users.set(id, next)
    return next
  }
  return {
    /** 现在的账户列表（一页；nextCursor 不为空时还有下一页） */
    list: (nextCursor: string | null = null): Response => json(200, listPage([...users.values()], nextCursor)),
    /** 吊销：版本加一，交回吊销之后的账户 */
    revoke: (id: string): Response => json(200, change(id, user => (user.localKey === null ? user : withKey(user, user.localKey.version + 1)))),
    /** 别的写操作（例如启用）：改这个账户，交回改了之后的 */
    update: (id: string, update: (user: AdminUser) => AdminUser): Response => json(200, change(id, update)),
  }
}

/**
 * 在路上的请求（复验 C1）：收到请求那一刻按服务端当时的样子算好回答（它在随后的写操作生效之前就读了库），由用例决定什么时候交回。
 * 交回之后等页面读完它的正文、再等随后的渲染走完（settle）：页面按它该做的都已经做完，之后的断言不是"现在还没变"的瞬时断言
 */
function inFlight(answer: () => Response) {
  let deliver: (() => void) | undefined
  let markRead: () => void = () => {}
  const read = new Promise<void>((resolve) => {
    markRead = resolve
  })
  const handler: Handler = async () => {
    const response = answer()
    const parse = response.json.bind(response)
    response.json = async () => {
      const body: unknown = await parse()
      markRead()
      return body
    }
    return new Promise<Response>((resolve) => {
      deliver = () => resolve(response)
    })
  }
  return {
    handler,
    /** 已经发出、还在路上 */
    sent: (): boolean => deliver !== undefined,
    /** 交回发出那一刻的回答，等页面读完它的正文、随后的渲染走完 */
    deliver: async (): Promise<void> => {
      if (deliver === undefined)
        throw new Error('这个请求还没发出')
      deliver()
      await read
      await settle()
    },
  }
}

/** 拨过结果未知、成功之后等刷新的时限（10 秒）：跟着真实的时间走的假时钟（vi.useFakeTimers 的 shouldAdvanceTime） */
async function passRefreshTimeLimit(): Promise<void> {
  await act(async () => vi.advanceTimersByTimeAsync(OUTCOME_REFRESH_TIME_LIMIT_MS))
}

/**
 * 说明写进去之后，页面把焦点所在的元素滚回可视区域（状态区在表格上方，写进说明时下面的内容整体下移）。jsdom 没有布局，也没有
 * scrollIntoView：换成记录调用的假实现，核对滚的是哪一个、怎样滚；真实浏览器里的位置由 E2E 核对（specs/admin/local-keys.spec.ts 靠下的一行）
 */
const scrollIntoView = vi.fn<(options?: ScrollIntoViewOptions) => void>()

beforeEach(() => {
  scrollIntoView.mockClear()
  Element.prototype.scrollIntoView = scrollIntoView
})

afterEach(() => {
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
})

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
  it('吊销别人的：确认框说清楚本机密钥的用途与后果，按钮醒目；确认之后请求一次，这一行的本机密钥换成第 2 版，弹窗关掉之后状态区说明换成了第几版；焦点回到这一行的"吊销本机密钥"；列表随即刷新一次（复验 C1）、会话不重新确认', async () => {
    const server = keyServer([ROOT, withKey(AMY, 1)])
    const api = admin([], { [USERS]: () => server.list(), [REVOKE_AMY]: () => server.revoke(AMY.id) })
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
    // 说明写进去之后，焦点所在的按钮留在可视区域里（最小距离）：状态区在表格上方，写进说明时下面的内容整体下移
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest' })
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(button)
    expect(count(api, REVOKE_AMY)).toBe(1)
    // 这一行是吊销之后的样子：明眼人在这一行看得见结果（审查 B2）。成功之后与别的操作一样刷新一次列表（复验 C1：先取消在路上的列表请求，
    // 见下面"在路上的列表请求"一组）；吊销不动会话：不重新确认
    expect(keyLine(row)).toHaveTextContent('本机密钥第 2 版')
    expect(count(api, USERS)).toBe(listed + 1)
    expect(count(api, SESSION)).toBe(1)
  })

  it('吊销自己的：专门的标题与说明（你正在编辑的页面照常保存、你的登录不会退出、为自己生成重置链接）；成功之后同样写进状态区，不重新确认会话', async () => {
    const server = keyServer([withKey(ROOT, 3), AMY])
    const api = admin([], { [USERS]: () => server.list(), [REVOKE_ROOT]: () => server.revoke(ROOT.id) })
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
    const server = keyServer([withKey(AMY, 1)])
    admin([], { [USERS]: () => server.list(), [REVOKE_AMY]: () => server.revoke(AMY.id) })
    renderApp('/admin/users')
    const row = await rowOf('amy')
    ;(document.activeElement as HTMLElement | null)?.blur()
    fireEvent.click(within(row).getByRole('button', { name: `吊销本机密钥 ${AMY_NAME}` }))
    confirmIn(await screen.findByRole('dialog'))
    await waitFor(() => expect(statusRegion()).toHaveTextContent(`已吊销 ${AMY_NAME} 的本机密钥，换成了第 2 版。`))
    await waitFor(() => expect(document.activeElement).toBe(row))
    // 滚回可视区域的是焦点所在的这一行
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(row)
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

  it('结果未知（断网）：刷新账户列表，这一行随之是现在的状态（这里那一次其实已经生效：第 2 版）；专门的说法——没能确认是否已经吊销、列表已刷新、再吊销一次没有坏处，不用通用的"还没有生效的话可以再试一次"；弹窗留着，再点一次成功', async () => {
    const server = keyServer([withKey(AMY, 1)])
    const api = admin([], {
      [USERS]: () => server.list(),
      // 第一次：请求到了服务端、生效了（第 2 版），回答丢了；之后的列表里是第 2 版
      [REVOKE_AMY]: inTurn(() => {
        server.revoke(AMY.id)
        return networkFailure()
      }, () => server.revoke(AMY.id)),
    })
    renderApp('/admin/users')
    const row = await rowOf('amy')
    expect(keyLine(row)).toHaveTextContent('本机密钥第 1 版')
    const { button, dialog } = await openRevoke(row, AMY_NAME)
    const listed = count(api, USERS)
    confirmIn(dialog)
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('没能确认是否已经吊销（网络连接失败，请检查网络后重试）。列表已刷新：这一行显示的是现在的状态。再吊销一次没有坏处：有本机密钥的话会再换一把新的，之前的都已作废。')
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

  it('结果未知、随后刷新账户列表也失败（仍然断网）：说明列表没能刷新、显示的可能还是之前的，不说"这一行显示的是现在的状态"', async () => {
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
    expect(await within(dialog).findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent('没能确认是否已经吊销（网络连接失败，请检查网络后重试）。列表没能刷新，显示的可能还是之前的，请稍后再看。再吊销一次没有坏处：有本机密钥的话会再换一把新的，之前的都已作废。')
    expect(lists).toBeGreaterThan(1)
    expect(statusRegion()).toBeEmptyDOMElement()
  })

  it('从没取过本机密钥的人，吊销的结果未知、列表刷新好了：说"这一行显示的是现在的状态"（这一行不显示版本），不说"本机密钥现在的版本"，也不说再吊销一次"会再换一把新的密钥"——他没有密钥可换（复验 C8）', async () => {
    const api = admin([AMY], { [REVOKE_AMY]: inTurn(() => networkFailure(), () => json(200, AMY)) })
    renderApp('/admin/users')
    const row = await rowOf('amy')
    const { dialog } = await openRevoke(row, AMY_NAME)
    const listed = count(api, USERS)
    confirmIn(dialog)
    const alert = await within(dialog).findByRole('alert')
    expect(alert.textContent).toBe('没能确认是否已经吊销（网络连接失败，请检查网络后重试）。列表已刷新：这一行显示的是现在的状态。再吊销一次没有坏处：有本机密钥的话会再换一把新的，之前的都已作废。')
    expect(count(api, USERS)).toBe(listed + 1)
    expect(keyLine(row)).toBeNull()
    // 照说明再吊销一次：没有要吊销的
    confirmIn(dialog)
    await waitFor(() => expect(statusRegion()).toHaveTextContent(`${AMY_NAME} 还没有本机密钥，没有要吊销的。`))
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
    // 状态区没写说明，页面也不滚
    expect(scrollIntoView).not.toHaveBeenCalled()
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

// 复验 C1：吊销成功原来只按响应换上这一行、不刷新列表。在吊销之前读库、之后才回来的列表请求，回来时 TanStack Query 用它整个替换缓存
// （"加载更多"按发出那一刻的各页拼上新的一页），这一行又变回吊销之前的版本，与状态区"换成了第 N 版"的说明矛盾。现在与别的操作一样，
// 换上这一行之后接着刷新（refreshQueries 先取消在路上的请求，再重新请求）。下面三种在路上的情形都在原来的做法上失败；
// 刷新本身用共用的时限与说明（refreshAfterSuccess、表格上方的"列表还在刷新"）
describe('吊销成功之后接着刷新列表：在路上的列表请求回来时不把这一行换回吊销之前的版本（复验 C1）', () => {
  it('吊销成功，随后刷新账户列表一直不回来：到了时限确认框照常关掉，这一行按响应已经是第 2 版、状态区照常说明、焦点回到按钮；表格上方说列表还在刷新，刷新回来之后不再说（共用的时限与说明，CX4）', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const server = keyServer([withKey(AMY, 1)])
      // 第 2 次列表请求是吊销之后的刷新：一直不回来
      const refreshing = inFlight(() => server.list())
      let lists = 0
      admin([], {
        [USERS]: async (init) => {
          lists += 1
          return lists === 2 ? refreshing.handler(init) : server.list()
        },
        [REVOKE_AMY]: () => server.revoke(AMY.id),
      })
      renderApp('/admin/users')
      const row = await rowOf('amy')
      const { button, dialog } = await openRevoke(row, AMY_NAME)
      confirmIn(dialog)
      await waitFor(() => expect(refreshing.sent()).toBe(true))
      // 时限之前仍在等刷新；留出 2 秒的余量，测试本身的耗时不会让时限提前到
      await act(async () => vi.advanceTimersByTimeAsync(OUTCOME_REFRESH_TIME_LIMIT_MS - 2_000))
      expect(within(dialog).getByRole('button', { name: '正在处理…' })).toHaveAttribute('aria-disabled', 'true')
      await act(async () => vi.advanceTimersByTimeAsync(2_000))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      await waitFor(() => expect(statusRegion()).toHaveTextContent(`已吊销 ${AMY_NAME} 的本机密钥，换成了第 2 版。`))
      expect(keyLine(row)).toHaveTextContent('本机密钥第 2 版')
      await waitFor(() => expect(document.activeElement).toBe(button))
      const line = screen.getByText('列表还在刷新，显示的可能还是之前的，刷新好了会自动更新。')
      await refreshing.deliver()
      await waitFor(() => expect(line).toBeEmptyDOMElement())
      expect(keyLine(row)).toHaveTextContent('本机密钥第 2 版')
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('"加载更多"的下一页还在路上时吊销：这一行换成第 2 版；那一页（吊销之前发出）随后回来，这一行仍是第 2 版——它随刷新作废，列表是重新取的，"加载更多"照常可以再点', async () => {
    const server = keyServer([withKey(AMY, 1)])
    const nextPage = inFlight(() => json(200, listPage([BEN])))
    admin([], {
      [USERS]: () => server.list('c1'),
      [`${USERS}?cursor=c1`]: nextPage.handler,
      [REVOKE_AMY]: () => server.revoke(AMY.id),
    })
    renderApp('/admin/users')
    const row = await rowOf('amy')
    expect(keyLine(row)).toHaveTextContent('本机密钥第 1 版')
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }))
    await waitFor(() => expect(nextPage.sent()).toBe(true))
    confirmIn((await openRevoke(row, AMY_NAME)).dialog)
    await waitFor(() => expect(statusRegion()).toHaveTextContent(`已吊销 ${AMY_NAME} 的本机密钥，换成了第 2 版。`))
    expect(keyLine(await rowOf('amy'))).toHaveTextContent('本机密钥第 2 版')
    await nextPage.deliver()
    expect(keyLine(await rowOf('amy'))).toHaveTextContent('本机密钥第 2 版')
    expect(screen.getByRole('button', { name: '加载更多' })).toHaveAttribute('aria-disabled', 'false')
  })

  it('上一个操作（启用别人）成功之后的刷新到了时限还在后台（表格上方说列表还在刷新）时吊销：这一行换成第 2 版；那次刷新（吊销之前读的）随后回来，这一行仍是第 2 版', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const server = keyServer([withKey(AMY, 1), BEN])
      // 第 2 次列表请求是启用之后的刷新：一直在路上，回答的是收到那一刻的样子（艾米还是第 1 版）
      const lateRefresh = inFlight(() => server.list())
      let lists = 0
      admin([], {
        [USERS]: async (init) => {
          lists += 1
          return lists === 2 ? lateRefresh.handler(init) : server.list()
        },
        [ENABLE_BEN]: () => server.update(BEN.id, user => ({ ...user, status: 'active' })),
        [REVOKE_AMY]: () => server.revoke(AMY.id),
      })
      renderApp('/admin/users')
      fireEvent.click(within(await rowOf('ben')).getByRole('button', { name: `启用 ${BEN_NAME}` }))
      const enable = await screen.findByRole('dialog')
      fireEvent.click(within(enable).getByRole('button', { name: '启用' }))
      await waitFor(() => expect(lateRefresh.sent()).toBe(true))
      await passRefreshTimeLimit()
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      // 前提：启用之后的刷新到了时限还在后台
      expect(screen.getByText('列表还在刷新，显示的可能还是之前的，刷新好了会自动更新。')).toBeInTheDocument()

      confirmIn((await openRevoke(await rowOf('amy'), AMY_NAME)).dialog)
      await waitFor(() => expect(statusRegion()).toHaveTextContent(`已吊销 ${AMY_NAME} 的本机密钥，换成了第 2 版。`))
      expect(keyLine(await rowOf('amy'))).toHaveTextContent('本机密钥第 2 版')
      await lateRefresh.deliver()
      expect(keyLine(await rowOf('amy'))).toHaveTextContent('本机密钥第 2 版')
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('结果未知之后的刷新到了时限还没回来（说列表没能刷新），照说明再吊销一次、成功（第 3 版）：那次刷新（第二次吊销之前读的，第 2 版）随后回来，这一行仍是第 3 版，与状态区的说明一致', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const server = keyServer([withKey(AMY, 1)])
      // 第 2 次列表请求是结果未知之后的刷新：一直在路上，回答的是收到那一刻的样子（第一次其实已经生效：第 2 版）
      const lateRefresh = inFlight(() => server.list())
      let lists = 0
      admin([], {
        [USERS]: async (init) => {
          lists += 1
          return lists === 2 ? lateRefresh.handler(init) : server.list()
        },
        // 第一次：请求到了服务端、生效了（第 2 版），回答丢了
        [REVOKE_AMY]: inTurn(() => {
          server.revoke(AMY.id)
          return networkFailure()
        }, () => server.revoke(AMY.id)),
      })
      renderApp('/admin/users')
      const { dialog } = await openRevoke(await rowOf('amy'), AMY_NAME)
      confirmIn(dialog)
      await waitFor(() => expect(lateRefresh.sent()).toBe(true))
      await passRefreshTimeLimit()
      expect(await within(dialog).findByRole('alert')).toHaveTextContent('没能确认是否已经吊销（网络连接失败，请检查网络后重试）。列表没能刷新，显示的可能还是之前的，请稍后再看。再吊销一次没有坏处：有本机密钥的话会再换一把新的，之前的都已作废。')
      // 照说明再吊销一次
      confirmIn(dialog)
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      await waitFor(() => expect(statusRegion()).toHaveTextContent(`已吊销 ${AMY_NAME} 的本机密钥，换成了第 3 版。`))
      expect(keyLine(await rowOf('amy'))).toHaveTextContent('本机密钥第 3 版')
      await lateRefresh.deliver()
      expect(keyLine(await rowOf('amy'))).toHaveTextContent('本机密钥第 3 版')
    }
    finally {
      vi.useRealTimers()
    }
  })
})
