// 吊销本机密钥（US-M3-17；M3-P6 设计 §3.6、§3.8）：系统管理员在账户页对某人"吊销本机密钥"——确认框说清楚本机密钥的用途与吊销的后果
// （不说"没同步的修改都会作废"，A14；正面说正在编辑的页面照常保存，审查 B7），确认之后页面顶部的状态区说明换成了第几版（确认框关掉、焦点交还之后才写，读屏读得到），
// 这一行"状态"列里的本机密钥随之换成新的一版（审查 B2：在列表靠下的一行吊销时状态区不在可视区域里，明眼人看这一行；说明写进状态区、下面的内容下移之后，页面把焦点所在的按钮滚回可视区域；窄屏时它排成一行，复验 C7），
// 焦点回到这一行的按钮；审计页按动作找得到（操作者、对象、明细里被吊销的那一版）。
// 这个人另一台设备上正在编辑的页面经心跳得知（M3 落在协议层：心跳的响应带着他当前的版本，页面上没有可见的反应）：下一次心跳的响应里版本加一，
// 页面照常编辑、保存；他再经接口取，得到新的一版、字节不同。"没有可见的反应"以确定的界核对（审查 B3）：得知第 2 版之后再等下一次心跳回来
// （它是处理完上一次之后才排的），标签页的标题、对话框、body 里画布之外的文字（复验 C3：门户里的提示条挂在 #editor-chrome 之外）与吊销之前相同、
// 读屏状态区一句话也没写过、没有 alert、仍在编辑；键入、保存之后再核对一遍。取用的响应不缓存（容器 E2E 经 Caddy 的 HTTPS 同样核对代理没有改掉 no-store）。
// 不真等：编辑的那一页装 Playwright 的时钟（打开之前装上，之后照常流动），要它的下一次心跳时拨 10 秒。
// 容器 E2E 也跑（不带 @test-build：只用公开的接口与界面）
import type { LocalKey } from '@nerve-office/contracts'
import type { Locator, Page, Request } from '@playwright/test'
import { randomBytes } from 'node:crypto'
import { localKeySchema, renewedEditLeaseSchema } from '@nerve-office/contracts'
import { createDocument, createUser } from '../../support/database.ts'
import { e2eOrigin } from '../../support/environment.ts'
import { expect, test } from '../../support/fixtures.ts'
import { searchList } from '../../support/list-search.ts'
import { plainName, shownName } from '../../support/people.ts'
import { loginThroughApi } from '../../support/session.ts'
import { cellOf, EDITOR_SURFACE, EDITOR_TEST_TIMEOUT, lostNotice, openAndEnterEditing, saveAndWait, savedContent, saveStatus, typeInCell, waitForEditorAccess } from '../../support/sheet.ts'
import { expectWrittenAfterClose, recordStatusWrites, spokenWrites } from '../../support/status-writes.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

/** 编辑时的心跳间隔（契约的 EDIT_LEASE_HEARTBEAT_SECONDS） */
const HEARTBEAT_MS = 10_000

/**
 * 等下一次心跳的回答最多多久：拨过一个心跳间隔之后它随即发出；有一次在途时，在途的回来之后按真实时间（最多一个心跳间隔）才排下一次。
 * 等不到就是这一页不再续租了（不在编辑了），随即失败、说清楚，不拖到用例的时限（审查 B3 的变异：页面按失去编辑权处理时原来要等满 4 分钟）
 */
const HEARTBEAT_WAIT_MS = 60_000

/**
 * 确认框里的说明（与界面的文案逐字相同：说清楚本机密钥加密的是什么、吊销影响什么不影响什么，设备丢了另要做什么）。不说"没同步的修改都会作废"
 * （页面里还没保存的修改不受吊销影响，A14），正面说正在编辑的页面照常保存（审查 B7）
 */
const DESCRIPTION = '本机密钥用来加密保存在浏览器里、还没同步的草稿，吊销之后用旧密钥加密的草稿都无法再解开；已经保存到云端的文档不受影响；他正在编辑的页面也不受影响，修改照常保存；他的登录也不会退出。设备可能落在别人手里时，请同时为他生成重置链接（会退出他在所有地方的登录）。'

/** 本人经接口取当前的本机密钥（M4 起由页面自己取）：第一次取时生成第 1 版；响应不缓存，经代理时同样 */
async function fetchLocalKey(page: Page): Promise<LocalKey> {
  const { csrfToken } = await (await page.request.get('/api/auth/session')).json() as { csrfToken: string }
  const response = await page.request.post('/api/local-key', { headers: { 'origin': e2eOrigin(), 'x-csrf-token': csrfToken } })
  expect(response.status(), await response.text()).toBe(200)
  expect(response.headers()['cache-control']).toBe('no-store')
  return localKeySchema.parse(await response.json())
}

/** 心跳（续租：PUT …/edit-lease） */
function isHeartbeat(request: Request, documentId: string): boolean {
  return request.method() === 'PUT' && new URL(request.url()).pathname === `/api/documents/${documentId}/edit-lease`
}

/**
 * 从现在起这一页发出的下一次心跳：拨过一个心跳间隔，返回它的响应里调用者自己当前的本机密钥的版本。
 * 只认现在之后才发出的心跳：之前发出、现在才回来的那一次读的可能是之前的版本
 */
async function nextHeartbeatVersion(page: Page, documentId: string): Promise<number | null> {
  const sent = new Set<Request>()
  const record = (request: Request): void => {
    if (isHeartbeat(request, documentId))
      sent.add(request)
  }
  page.on('request', record)
  try {
    const answered = page.waitForResponse(response => sent.has(response.request()), { timeout: HEARTBEAT_WAIT_MS }).catch((error: unknown) => {
      throw new Error(`${HEARTBEAT_WAIT_MS / 1000} 秒内这一页没有发出、收到下一次心跳：它不再续租了，可能已经不在编辑（${error instanceof Error ? error.message : String(error)}）`)
    })
    await page.clock.fastForward(HEARTBEAT_MS)
    const response = await answered
    expect(response.status(), await response.text()).toBe(200)
    return renewedEditLeaseSchema.parse(await response.json()).localKeyVersion
  }
  finally {
    page.off('request', record)
  }
}

/** 编辑器页自己的页头与说明（React 的挂载点：页头、页头之外的读屏状态区、页头下面的各种说明） */
const EDITOR_CHROME = '#editor-chrome'

/** 编辑器页看得见的样子（审查 B3、复验 C3）：浏览器标签页的标题、页面上的对话框有几个、body 里画布之外的文字 */
interface EditorPageLook {
  readonly title: string
  readonly dialogs: number
  readonly text: string
}

/**
 * 编辑器页看得见的样子（核对页面对吊销没有可见的反应）。文字取整个 body：页头（标题、保存状态、按钮）、页头之外一直在的读屏状态区、
 * 页头下面的各种说明，以及挂在 body 上的东西——门户里的提示条与对话框、Univer 的弹层都在 #editor-chrome 之外（复验 C3：原来只看
 * #editor-chrome，挂在 body 上的提示条认不出）。按"吊销之前的那一刻"与界之后的两次比较，不比较的几处本来就会变（三个浏览器实测过 body 的内容）：
 * - 画布（#sheet-editor：Univer 的工作区、编辑栏、单元格编辑器与工作表标签，键入、保存时本来就变）；
 * - 页头里读屏的播报区（播完 7 秒之后清空；播过什么另由 recordStatusWrites 记下每一次写进去的话）；
 * - script、style（不是显示的文字）。
 * Univer 挂在 body 上、平时隐藏的弹层（编辑栏的选区容器、工作表标签的右键菜单）在这两刻之间不变，照常比较
 */
async function editorPageLook(page: Page): Promise<EditorPageLook> {
  return page.evaluate(({ surface, announcer }) => {
    const copy = document.body.cloneNode(true) as HTMLElement
    for (const element of copy.querySelectorAll(`${surface}, ${announcer}, script, style`))
      element.remove()
    return { title: document.title, dialogs: document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length, text: copy.textContent }
  }, { surface: EDITOR_SURFACE, announcer: `${EDITOR_CHROME} header [role="status"]` })
}

/**
 * 编辑器页对吊销没有可见的反应（审查 B3、复验 C3）：仍在编辑（可编辑的编辑器就绪）；标签页的标题、对话框的个数、body 里画布之外的文字
 * 都与吊销之前记下的相同；没有 alert、没有失去编辑权的说明。在确定的界之后调用（得知新版本之后的下一次心跳回来、保存之后），
 * 不当作"现在还没出现"的瞬时断言用
 */
async function expectNoVisibleReaction(page: Page, before: EditorPageLook): Promise<void> {
  await waitForEditorAccess(page, 'edit')
  const now = await editorPageLook(page)
  expect(now.title, '浏览器标签页的标题与吊销之前不同（页面对吊销有了可见的反应）').toBe(before.title)
  expect(now.dialogs, '页面上多了对话框（页面对吊销有了可见的反应）').toBe(before.dialogs)
  expect(now.text, '编辑器页上（画布之外）的文字与吊销之前不同（页面对吊销有了可见的反应）').toBe(before.text)
  await expect(lostNotice(page)).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(0)
}

/**
 * 这段文字排成了几行：按它自己的行高量高度（"状态"列里的小字是弹性布局里的一项、成了块，getClientRects 分不出几行；
 * 原来 400 宽时是 3 行、48px 高，复验 C7）
 */
async function lineCountOf(text: Locator): Promise<number> {
  return text.evaluate((element) => {
    const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight)
    return Math.round(element.getBoundingClientRect().height / lineHeight)
  })
}

test.describe('US-M3-17 系统管理员吊销本机密钥', () => {
  test('US-M3-17 系统管理员在账户页吊销某人的本机密钥（键盘操作）：确认框说清楚用途与后果；状态区说明换成了第几版、这一行的本机密钥随之换成新的一版、焦点回到这个按钮；审计页按动作找得到；他另一台设备上正在编辑的页面下一次心跳得知新的版本，照常编辑、保存；再取得到新的一把', async ({ page, anotherDevice }) => {
    const admin = await createUser('lk-admin', '吊销的管理员', { systemRole: 'admin' })
    const owner = await createUser('lk-owner', '丢了设备的人')
    const documentId = await createDocument(owner, '设备上的表')

    // 他先在另一台设备上取一次本机密钥（第一次取，生成第 1 版），打开文档、进入编辑：心跳的响应里是第 1 版
    await loginThroughApi(anotherDevice, owner)
    const first = await fetchLocalKey(anotherDevice)
    expect(first.version).toBe(1)
    await anotherDevice.clock.install()
    await openAndEnterEditing(anotherDevice, documentId)
    expect(await nextHeartbeatVersion(anotherDevice, documentId)).toBe(1)
    // 吊销之前编辑器页上的样子（审查 B3、复验 C3）：已保存到云端，记下标签页的标题、对话框的个数（没有）与 body 里画布之外的文字；
    // 从这里起记下两个读屏状态区（页头里的播报区、页头之外的状态区）写进去的每一句话
    await expect(saveStatus(anotherDevice)).toHaveText('已保存到云端')
    const quiet = await editorPageLook(anotherDevice)
    expect(quiet.dialogs).toBe(0)
    await recordStatusWrites(anotherDevice.locator(`${EDITOR_CHROME} [role="status"]`))

    // 系统管理员在账户页找到他，用键盘打开"吊销本机密钥"的确认框
    await loginThroughApi(page, admin)
    await page.goto('/admin/users')
    // 等搜索的过滤完成再操作这一行（support/list-search.ts）
    await searchList(page, '按名字或登录名搜索', owner.username)
    const row = page.getByRole('table', { name: '账户列表' }).getByRole('row').filter({ hasText: owner.username })
    await expect(row).toHaveCount(1)
    // "状态"列里他当前的本机密钥（审查 B2）：吊销之前是第 1 版
    const keyLine = row.getByText(/^本机密钥第 \d+ 版$/)
    await expect(keyLine).toHaveText('本机密钥第 1 版')
    // 结果的说明：页面顶部的状态区一直在（空的时候只做视觉隐藏），记下它每一次内容变化的那一刻
    await recordStatusWrites(page.locator('[data-slot="status-region"]'))
    const revoke = row.getByRole('button', { name: `吊销本机密钥 ${plainName(owner)}`, exact: true })
    await revoke.focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: `吊销 ${plainName(owner)} 的本机密钥？` })
    await expect(dialog).toHaveAccessibleDescription(DESCRIPTION)
    await dialog.getByRole('button', { name: '吊销本机密钥', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    const done = `已吊销 ${plainName(owner)} 的本机密钥，换成了第 2 版。`
    await expect(page.getByRole('status').filter({ hasText: '已吊销' })).toHaveText(done)
    // 确认框开着时 Radix 把页面标为 aria-hidden：说明等它关掉、焦点交还之后才写，写进去的那一刻读屏读得到
    await expectWrittenAfterClose(page, done)
    await expect(revoke).toBeFocused()
    // 这一行按吊销之后的账户换上：明眼人在这一行看得见结果（审查 B2）
    await expect(keyLine).toHaveText('本机密钥第 2 版')

    // 审计：按动作筛选"吊销本机密钥"，点对象只看这个人——操作者是这位系统管理员，明细是被吊销的那一版
    await page.getByRole('navigation', { name: '管理界面' }).getByRole('link', { name: '审计' }).click()
    await page.getByLabel('动作', { exact: true }).selectOption({ label: '吊销本机密钥' })
    const target = `账户：${shownName(owner)}`
    await page.getByRole('table', { name: '审计事件' }).getByRole('button', { name: target }).click()
    await expect(page.getByText(`对象：${target}`)).toBeVisible()
    const events = page.getByRole('table', { name: '审计事件' }).getByRole('row')
    // 表头一行，加上这一次吊销
    await expect(events).toHaveCount(2)
    await expect(events.nth(1)).toContainText(shownName(admin))
    await expect(events.nth(1)).toContainText('吊销本机密钥')
    await expect(events.nth(1)).toContainText('{"version":1}')

    // 他另一台设备上正在编辑的页面：下一次心跳的响应里是第 2 版
    expect(await nextHeartbeatVersion(anotherDevice, documentId)).toBe(2)
    // 页面上没有可见的反应（审查 B3）：以再下一次心跳回来为界——它是页面处理完得知第 2 版的那一次之后才排的，之后才出现的反应也认得出。
    // 标签页的标题、对话框、body 里画布之外的文字与吊销之前相同（复验 C3），读屏状态区一句话也没写过（说过又撤掉的也算），没有 alert、
    // 没有失去编辑权的说明，仍在编辑
    expect(await nextHeartbeatVersion(anotherDevice, documentId)).toBe(2)
    await expectNoVisibleReaction(anotherDevice, quiet)
    expect(await spokenWrites(anotherDevice), '读屏状态区里说了话（页面对吊销有了反应）').toEqual([])
    // 照常编辑、保存
    await typeInCell(anotherDevice, 'A1', 'after revocation')
    await saveAndWait(anotherDevice)
    expect(cellOf((await savedContent(anotherDevice, documentId)).snapshot, 'A1')?.v).toBe('after revocation')
    // 用例最后（键入、保存之后）再核对一遍
    await expectNoVisibleReaction(anotherDevice, quiet)

    // 再经接口取：新的一版，字节与之前的不同
    const second = await fetchLocalKey(anotherDevice)
    expect(second.version).toBe(2)
    expect(second.key).not.toBe(first.key)
  })

  test('US-M3-17 在账户列表靠下的一行吊销：这一行的本机密钥换成新的一版，就在可视区域里（页面顶部的状态区这时不在可视区域里，明眼人看的是这一行）', async ({ page, anotherDevice }) => {
    const admin = await createUser('lkrow-admin', '看结果的管理员', { systemRole: 'admin' })
    // 同一个前缀的 30 个人排在他前面（账户列表按登录名排序），搜这个前缀时他在最后一行：管理员常常按部门之类的共同部分找人
    const prefix = `lkrow${randomBytes(3).toString('hex')}`
    for (let index = 0; index < 30; index += 1)
      await createUser(`${prefix}-a${String(index).padStart(2, '0')}`)
    const owner = await createUser(`${prefix}-z`, '靠下的人')
    // 他取过本机密钥（第 1 版）
    await loginThroughApi(anotherDevice, owner)
    expect((await fetchLocalKey(anotherDevice)).version).toBe(1)

    await loginThroughApi(page, admin)
    await page.goto('/admin/users')
    await searchList(page, '按名字或登录名搜索', prefix)
    const rows = page.getByRole('table', { name: '账户列表' }).getByRole('row')
    // 表头一行，加上这 31 个人；他在最后
    await expect(rows).toHaveCount(32)
    await expect(rows.last()).toContainText(owner.username)
    const keyLine = rows.last().getByText(/^本机密钥第 \d+ 版$/)
    await expect(keyLine).toHaveText('本机密钥第 1 版')
    const revoke = rows.last().getByRole('button', { name: `吊销本机密钥 ${plainName(owner)}`, exact: true })
    await revoke.focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: `吊销 ${plainName(owner)} 的本机密钥？` })
    await dialog.getByRole('button', { name: '吊销本机密钥', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(revoke).toBeFocused()
    // 结果就在这一行、整个在可视区域里，焦点交还的按钮也在：说明写进页面顶部的状态区时下面的内容整体下移（三个浏览器都不补偿滚动），
    // 页面随即把焦点所在的按钮滚回可视区域。原来只核对"有一点在可视区域里"，下移之后只剩 3 像素的字也算通过（复验 C7 时发现）
    await expect(keyLine).toHaveText('本机密钥第 2 版')
    await expect(keyLine).toBeInViewport({ ratio: 1 })
    await expect(revoke).toBeInViewport({ ratio: 1 })
    // 前提：说明照常写进页面顶部的状态区（读屏靠它），而它这时不在可视区域里——这一行的变化才是明眼人看得见的结果
    const status = page.getByRole('status').filter({ hasText: '已吊销' })
    await expect(status).toHaveText(`已吊销 ${plainName(owner)} 的本机密钥，换成了第 2 版。`)
    await expect(status).not.toBeInViewport()
  })

  test('US-M3-17 窄屏（400 宽）：账户页"状态"列里的"本机密钥第 N 版"排成一行，不把"第 1 版"拆开；表格在自己的容器里横向滚动，页面本身不横向滚动（复验 C7）', async ({ page, anotherDevice }) => {
    const admin = await createUser('lknarrow-admin', '窄屏的管理员', { systemRole: 'admin' })
    const owner = await createUser('lknarrow', '名字比较长的一位同事')
    // 他取过本机密钥（第 1 版）
    await loginThroughApi(anotherDevice, owner)
    expect((await fetchLocalKey(anotherDevice)).version).toBe(1)

    await page.setViewportSize({ width: 400, height: 800 })
    await loginThroughApi(page, admin)
    await page.goto('/admin/users')
    await searchList(page, '按名字或登录名搜索', owner.username)
    const row = page.getByRole('table', { name: '账户列表' }).getByRole('row').filter({ hasText: owner.username })
    await expect(row).toHaveCount(1)
    const keyLine = row.getByText(/^本机密钥第 \d+ 版$/)
    await expect(keyLine).toHaveText('本机密钥第 1 版')
    expect(await lineCountOf(keyLine), '"本机密钥第 1 版"排成的行数').toBe(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), '页面横向溢出').toBe(true)
  })
})
