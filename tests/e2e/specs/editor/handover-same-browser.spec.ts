// 同一个浏览器里的标签页（M3-P5 设计 §3.1、§3.7；US-M3-08 本人接管的底座）：正在编辑的标签页从服务端批准之后直到离开编辑持有这份文档的
// 本机锁（Web Locks，先服务端、后本机锁）。锁的争用一律以服务端的事实裁决（M3-P6 设计 §3.13，Codex 评审 CX2）：申请成功的回包、本机锁都
// 说明不了这一刻的事实——服务端批准之后、回包到达之前可能已经再换代。拿锁时被本浏览器的别的标签页占着，先向服务端核对（续租一次）本页这一代
// 仍是当前的才抢，不是当前的就不抢、不释放、回到阅读；锁被抢的一方同样先核对，确实被取代才失去编辑权（说是本人在本浏览器的另一个标签页接手了，
// 没保存的修改照旧给副本与放弃），核对不了（断网）时不判自己失效、也不抢，等之后的心跳给出结论。
// 两个标签页用同一个浏览器上下文（共用 Cookie、Web Locks 与 Playwright 的时钟）；回包迟到用 route.fetch()（先执行真实的服务端事务）、扣住再送达；
// 前一个"断网、休眠"用拦下它的心跳与保存模拟（support/sheet.ts 的 disconnectTab）；编辑权到期改写租约行。
// "在此编辑"的三条路、同一浏览器的先保存再交出、旧页不响应之后接手（前一个连着网：核对得知被接管，随即失去编辑权）、刷新时在途保存的等待、
// 跨设备在 handover-takeover.spec.ts（设计 §3.7）。
// 容器 E2E 也跑：修改在断开之后才做，两种构建里都存不上；另存为副本不经保存的那条路（断开只拦保存与心跳）
import type { APIResponse, Page, Response } from '@playwright/test'
import { createUser, editLeaseEpoch, editLeaseTakeover, expireEditLease } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi } from '../../support/session.ts'
import { cellOf, createSheetThroughApi, disconnectTab, editingNotice, EDITOR_TEST_TIMEOUT, enterEditButton, enterEditing, lostNotice, openAndEnterEditing, openReader, saveAndWait, saveButton, savedContent, takeOverHereButton, typeInCell, waitForEditorAccess } from '../../support/sheet.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

/** 自己在本浏览器的另一个标签页里编辑时的说明 */
const IN_THIS_BROWSER = '你在本浏览器的另一个标签页里正在编辑这份文档。点"在此编辑"，那个标签页会先保存，再把编辑权交给这里'
/** 自己在别处（另一台设备或浏览器，或者刚关闭、刷新过的页面）编辑时的说明：锁不在本浏览器 */
const ELSEWHERE = '你在另一台设备或浏览器上正在编辑这份文档（也可能是刚关闭、刷新过的页面）。点"在此编辑"在这里接着编辑，那边会失去编辑权，没保存的修改可以在那边另存为副本'

/** 这份文档的编辑权的请求（…/edit-lease：申请 POST、续租 PUT、释放 DELETE、读编辑状态 GET） */
function isLeaseRequest(url: string, documentId: string): boolean {
  return new URL(url).pathname === `/api/documents/${documentId}/edit-lease`
}

/** 从现在起这个页面发出的、改动编辑权的请求（申请、续租、释放：…/edit-lease 上除了读编辑状态之外的） */
function recordLeaseWrites(page: Page, documentId: string): string[] {
  const methods: string[] = []
  page.on('request', (request) => {
    if (request.method() !== 'GET' && isLeaseRequest(request.url(), documentId))
      methods.push(request.method())
  })
  return methods
}

/** 这个页面下一次续租（PUT …/edit-lease）的回答 */
async function nextRenewal(page: Page, documentId: string): Promise<Response> {
  return page.waitForResponse(response => response.request().method() === 'PUT' && isLeaseRequest(response.url(), documentId))
}

test.describe('US-M3-08 同一个浏览器里的标签页：编辑权随本机锁，锁的争用由服务端裁决', () => {
  test('US-M3-08 回包乱序（Codex 评审 CX2）：A 的申请服务端已经提交（第 1 代）、回包迟到，B 点"在此编辑"取得第 2 代、拿锁、编辑；A 的回包到了——锁被 B 占着，A 向服务端核对得知第 1 代已被接管：不抢锁、不释放，回到阅读，说本浏览器的另一个标签页在编辑、照常给"在此编辑"；B 照常编辑、保存', async ({ page, context }) => {
    await loginThroughApi(page, await createUser('stale-acquire'))
    const documentId = await createSheetThroughApi(page)
    // Playwright 的时钟是上下文级的：两个标签页一起走，最后拨它核对 A 不再续租
    await page.clock.install()
    await openReader(page, documentId)
    // A 的申请：先执行真实的服务端事务（route.fetch），回包扣住、等 B 接手之后再送达；别的请求照常
    let deliver: () => void = () => {}
    const delivered = new Promise<void>((resolve) => {
      deliver = resolve
    })
    let committed: (response: APIResponse) => void = () => {}
    const acquisition = new Promise<APIResponse>((resolve) => {
      committed = resolve
    })
    let intercepted = false
    await page.route(`**/api/documents/${documentId}/edit-lease`, async (route) => {
      if (route.request().method() !== 'POST' || intercepted) {
        await route.continue()
        return
      }
      intercepted = true
      const response = await route.fetch()
      committed(response)
      await delivered
      await route.fulfill({ response })
    })
    try {
      await enterEditButton(page).click()
      expect((await acquisition).status()).toBe(201)
      expect(await editLeaseEpoch(documentId)).toBe(1)

      // B：A 还没拿到回包、没拿锁，B 读到的是自己在别处编辑；"在此编辑"以本人接管取得第 2 代、拿锁（锁空着）、编辑
      const other = await context.newPage()
      await openReader(other, documentId)
      await expect(editingNotice(other)).toHaveText(ELSEWHERE)
      await takeOverHereButton(other).click()
      await waitForEditorAccess(other, 'edit')
      await expect(saveButton(other)).toBeVisible()
      expect(await editLeaseEpoch(documentId)).toBe(2)
      expect(await editLeaseTakeover(documentId)).toBe('self')
      await typeInCell(other, 'A1', 'newer holder')

      // A 的回包到了：锁被 B 占着，A 核对（续租第 1 代）——服务端说第 1 代已被本人接管
      const leaseWrites = recordLeaseWrites(page, documentId)
      const verdict = nextRenewal(page, documentId)
      deliver()
      const answer = await verdict
      expect(answer.status()).toBe(409)
      expect(await answer.json()).toMatchObject({ error: { code: 'EDIT_LEASE_LOST', details: { reason: 'taken_over', forced: false } } })

      // A 回到阅读（从没进入编辑，没有失去编辑权的说明）：本浏览器的另一个标签页在编辑，照常给"在此编辑"
      await expect(editingNotice(page)).toHaveText(IN_THIS_BROWSER)
      await expect(takeOverHereButton(page)).toBeVisible()
      await waitForEditorAccess(page, 'read')
      await expect(saveButton(page)).toHaveCount(0)
      await expect(lostNotice(page)).toHaveCount(0)

      // B 不受影响：照常编辑、保存，服务器上是 B 的修改，仍是第 2 代
      await expect(lostNotice(other)).toHaveCount(0)
      await saveAndWait(other)
      expect(cellOf((await savedContent(other, documentId)).snapshot, 'A1')?.v).toBe('newer holder')
      expect(await editLeaseEpoch(documentId)).toBe(2)

      // A 只发了那一次核对：不释放（那一代已经不是它的）、不续上；之后的几个心跳周期里也不再续租
      await page.clock.fastForward(30_000)
      expect(leaseWrites).toEqual(['PUT'])
      await expect(saveButton(other)).toBeVisible()
      expect(await editLeaseEpoch(documentId)).toBe(2)
    }
    finally {
      deliver()
    }
  })

  test('US-M3-08 锁被抢时前一个断网（核对不了）：不判自己失效、不抢回锁，照常留在编辑（但不持有锁）；连上之后由心跳给出结论——那一代被换掉、续上时被本浏览器的另一个标签页占着，失去编辑权，本页没保存的修改另存为副本', async ({ page, context }) => {
    await loginThroughApi(page, await createUser('same-browser-lock'))
    const documentId = await createSheetThroughApi(page)
    // Playwright 的时钟是上下文级的：两个标签页一起走，之后拨它让前一个的心跳到点
    await page.clock.install()
    await openAndEnterEditing(page, documentId)
    // 前一个"断网、休眠"之后改了一处：存不上，它也从服务端得知不了任何事
    const asleep = await disconnectTab(page)
    await typeInCell(page, 'A1', 'only in the first tab')
    await expireEditLease(documentId)

    // 后一个：打开、点"编辑"，取得新的一代；锁被前一个占着，核对过这一代是当前的才抢
    const confirmation = page.waitForEvent('requestfailed', { predicate: request => request.method() === 'PUT' && isLeaseRequest(request.url(), documentId), timeout: 60_000 })
    const other = await context.newPage()
    await openReader(other, documentId)
    await enterEditing(other)
    await expect(saveButton(other)).toBeVisible()

    // 前一个得知锁被抢、向服务端核对，续租被拦下（核对不了）：不判自己失效——照常留在编辑，没有失去编辑权的说明；也不抢回锁——后一个照常
    // 编辑、保存
    await confirmation
    await expect(saveButton(page)).toBeVisible()
    await expect(lostNotice(page)).toHaveCount(0)
    await typeInCell(other, 'B1', 'second tab')
    await saveAndWait(other)
    await expect(lostNotice(other)).toHaveCount(0)

    // 前一个连上了：下一次心跳得知那一代已被换掉，续上时被本浏览器的另一个标签页占着——失去编辑权（心跳已有的处理），以只读显示本页的内容
    await asleep.reconnect()
    await page.clock.fastForward(10_000)
    const lost = lostNotice(page)
    await expect(lost).toContainText('编辑权已失效：你在另一个标签页或设备上正在编辑这份文档。本页的修改没有保存：可以另存为副本，或者放弃这些修改。')
    await expect(lost.getByRole('button', { name: '放弃本页的修改', exact: true })).toBeVisible()
    await waitForEditorAccess(page, 'read')
    await expect(saveButton(page)).toHaveCount(0)

    // 之后不再续租、不再申请
    const leaseWrites = recordLeaseWrites(page, documentId)
    await page.clock.fastForward(30_000)
    expect(leaseWrites).toEqual([])
    expect(await editLeaseEpoch(documentId)).toBe(2)

    // 前一个的修改另存为副本：副本是它的内容
    await lost.getByRole('button', { name: '另存为副本', exact: true }).click()
    const copied = page.locator('#editor-chrome').getByRole('status').filter({ hasText: '已另存为副本' })
    const link = copied.getByRole('link', { name: '打开副本（新标签页）', exact: true })
    await expect(link).toBeVisible()
    const copyId = (await link.getAttribute('href') ?? '').split('/').at(-1) ?? ''
    expect(cellOf((await savedContent(page, copyId)).snapshot, 'A1')?.v).toBe('only in the first tab')

    // 后一个一直在编辑；服务器上没有前一个的修改
    await expect(saveButton(other)).toBeVisible()
    const saved = (await savedContent(other, documentId)).snapshot
    expect([cellOf(saved, 'A1'), cellOf(saved, 'B1')?.v]).toEqual([undefined, 'second tab'])
  })
})
