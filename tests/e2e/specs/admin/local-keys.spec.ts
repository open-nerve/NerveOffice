// 吊销本机密钥（US-M3-17；M3-P6 设计 §3.6、§3.8）：系统管理员在账户页对某人"吊销本机密钥"——确认框说清楚本机密钥的用途与吊销的后果
// （不说"没同步的修改都会作废"，A14），确认之后页面顶部的状态区说明换成了第几版（确认框关掉、焦点交还之后才写，读屏读得到），
// 焦点回到这一行的按钮；审计页按动作找得到（操作者、对象、明细里被吊销的那一版）。
// 这个人另一台设备上正在编辑的页面经心跳得知（M3 落在协议层：心跳的响应带着他当前的版本，页面上没有可见的反应）：下一次心跳的响应里版本加一，
// 页面照常编辑、保存；他再经接口取，得到新的一版、字节不同。取用的响应不缓存（容器 E2E 经 Caddy 的 HTTPS 同样核对代理没有改掉 no-store）。
// 不真等：编辑的那一页装 Playwright 的时钟（打开之前装上，之后照常流动），要它的下一次心跳时拨 10 秒。
// 容器 E2E 也跑（不带 @test-build：只用公开的接口与界面）
import type { LocalKey } from '@nerve-office/contracts'
import type { Page, Request } from '@playwright/test'
import { localKeySchema, renewedEditLeaseSchema } from '@nerve-office/contracts'
import { createDocument, createUser } from '../../support/database.ts'
import { e2eOrigin } from '../../support/environment.ts'
import { expect, test } from '../../support/fixtures.ts'
import { searchList } from '../../support/list-search.ts'
import { plainName, shownName } from '../../support/people.ts'
import { loginThroughApi } from '../../support/session.ts'
import { cellOf, EDITOR_TEST_TIMEOUT, lostNotice, openAndEnterEditing, saveAndWait, savedContent, typeInCell, waitForEditorAccess } from '../../support/sheet.ts'
import { expectWrittenAfterClose, recordStatusWrites } from '../../support/status-writes.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

/** 编辑时的心跳间隔（契约的 EDIT_LEASE_HEARTBEAT_SECONDS） */
const HEARTBEAT_MS = 10_000

/** 确认框里的说明（与界面的文案逐字相同：说清楚本机密钥加密的是什么、吊销影响什么不影响什么，设备丢了另要做什么） */
const DESCRIPTION = '本机密钥用来加密保存在浏览器里、还没同步的草稿，吊销之后用旧密钥加密的草稿都无法再解开；已经保存到云端的文档不受影响，这个人的登录也不会退出。设备可能落在别人手里时，请同时为他生成重置链接（会退出他在所有地方的登录）。'

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
    const answered = page.waitForResponse(response => sent.has(response.request()))
    await page.clock.fastForward(HEARTBEAT_MS)
    const response = await answered
    expect(response.status(), await response.text()).toBe(200)
    return renewedEditLeaseSchema.parse(await response.json()).localKeyVersion
  }
  finally {
    page.off('request', record)
  }
}

test.describe('US-M3-17 系统管理员吊销本机密钥', () => {
  test('US-M3-17 系统管理员在账户页吊销某人的本机密钥（键盘操作）：确认框说清楚用途与后果；状态区说明换成了第几版、焦点回到这个按钮；审计页按动作找得到；他另一台设备上正在编辑的页面下一次心跳得知新的版本，照常编辑、保存；再取得到新的一把', async ({ page, anotherDevice }) => {
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

    // 系统管理员在账户页找到他，用键盘打开"吊销本机密钥"的确认框
    await loginThroughApi(page, admin)
    await page.goto('/admin/users')
    // 等搜索的过滤完成再操作这一行（support/list-search.ts）
    await searchList(page, '按名字或登录名搜索', owner.username)
    const row = page.getByRole('table', { name: '账户列表' }).getByRole('row').filter({ hasText: owner.username })
    await expect(row).toHaveCount(1)
    // 结果的说明：页面顶部的状态区一直在（空的时候只做视觉隐藏），记下它每一次内容变化的那一刻
    await recordStatusWrites(page.locator('[data-slot="status-region"]'))
    const revoke = row.getByRole('button', { name: `吊销本机密钥 ${plainName(owner)}`, exact: true })
    await revoke.focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: `吊销 ${plainName(owner)} 的本机密钥？` })
    await expect(dialog).toHaveAccessibleDescription(DESCRIPTION)
    // 不说"没同步的修改都会作废"：页面里还没保存的修改不受吊销影响（A14）
    await expect(dialog).not.toContainText('修改')
    await dialog.getByRole('button', { name: '吊销本机密钥', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    const done = `已吊销 ${plainName(owner)} 的本机密钥，换成了第 2 版。`
    await expect(page.getByRole('status').filter({ hasText: '已吊销' })).toHaveText(done)
    // 确认框开着时 Radix 把页面标为 aria-hidden：说明等它关掉、焦点交还之后才写，写进去的那一刻读屏读得到
    await expectWrittenAfterClose(page, done)
    await expect(revoke).toBeFocused()

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

    // 他另一台设备上正在编辑的页面：下一次心跳的响应里是第 2 版；页面上没有可见的反应，照常编辑、保存
    expect(await nextHeartbeatVersion(anotherDevice, documentId)).toBe(2)
    await expect(lostNotice(anotherDevice)).toHaveCount(0)
    await expect(anotherDevice.getByRole('alert')).toHaveCount(0)
    await waitForEditorAccess(anotherDevice, 'edit')
    await typeInCell(anotherDevice, 'A1', 'after revocation')
    await saveAndWait(anotherDevice)
    expect(cellOf((await savedContent(anotherDevice, documentId)).snapshot, 'A1')?.v).toBe('after revocation')

    // 再经接口取：新的一版，字节与之前的不同
    const second = await fetchLocalKey(anotherDevice)
    expect(second.version).toBe(2)
    expect(second.key).not.toBe(first.key)
  })
})
