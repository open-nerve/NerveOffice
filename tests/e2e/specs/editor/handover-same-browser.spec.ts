// 同一个浏览器里的标签页（M3-P5 设计 §3.1、§3.7；US-M3-08 本人接管的底座）：正在编辑的标签页从服务端批准之后直到离开编辑持有这份文档的
// 本机锁（Web Locks，先服务端、后本机锁）。另一个标签页取得了服务端批准的新的一代（前一个的那一代已经失效：到期、释放）时抢这把锁，
// 前一个随即得知（AbortError）——不再问服务端、不续上，立即失去编辑权，没保存的修改照旧给副本与放弃。
// 两个标签页用同一个浏览器上下文（共用 Cookie、Web Locks 与 Playwright 的时钟）；前一个"断网、休眠"用拦下它的心跳与保存模拟
// （support/sheet.ts 的 disconnectTab）：它从服务端什么也得知不了，立即失去编辑权只能是本机锁告诉它的。编辑权到期改写租约行。
// "在此编辑"的三条路、同一浏览器的先保存再交出、旧页不响应之后接手、刷新时在途保存的等待、跨设备在 handover-takeover.spec.ts（设计 §3.7）。
// 容器 E2E 也跑：修改在断开之后才做，两种构建里都存不上；另存为副本不经保存的那条路（断开只拦保存与心跳）
import type { Page } from '@playwright/test'
import { createUser, editLeaseEpoch, expireEditLease } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi } from '../../support/session.ts'
import { cellOf, createSheetThroughApi, disconnectTab, EDITOR_TEST_TIMEOUT, enterEditing, lostNotice, openAndEnterEditing, openReader, saveAndWait, saveButton, savedContent, typeInCell, waitForEditorAccess } from '../../support/sheet.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

/** 从现在起这个页面发出的、改动编辑权的请求（申请、续租、释放：…/edit-lease 上除了读编辑状态之外的） */
function recordLeaseWrites(page: Page, documentId: string): string[] {
  const methods: string[] = []
  page.on('request', (request) => {
    if (request.method() !== 'GET' && new URL(request.url()).pathname === `/api/documents/${documentId}/edit-lease`)
      methods.push(request.method())
  })
  return methods
}

test.describe('US-M3-08 同一个浏览器里的标签页：编辑权随本机锁', () => {
  test('US-M3-08 同一个人两个标签页：后一个取得编辑权（前一个的那一代已经失效）的那一刻，前一个立即失去编辑权——不等心跳、不续上；说明是本人在本浏览器的另一个标签页接手了编辑，本页没保存的修改另存为副本', async ({ page, context }) => {
    await loginThroughApi(page, await createUser('same-browser-lock'))
    const documentId = await createSheetThroughApi(page)
    // Playwright 的时钟是上下文级的：两个标签页一起走，之后拨它核对前一个不再续租、不再申请
    await page.clock.install()
    await openAndEnterEditing(page, documentId)
    // 前一个"断网、休眠"之后改了一处：存不上，它也从服务端得知不了任何事
    const asleep = await disconnectTab(page)
    await typeInCell(page, 'A1', 'only in the first tab')
    await expireEditLease(documentId)

    // 后一个：打开、点"编辑"，取得新的一代（抢走本机锁）
    const other = await context.newPage()
    await openReader(other, documentId)
    await enterEditing(other)
    await expect(saveButton(other)).toBeVisible()

    // 前一个立即失去编辑权（它还断着网：是本机锁告诉它的），以只读显示本页的内容，给副本与放弃
    const lost = lostNotice(page)
    await expect(lost).toContainText('编辑权已失效：你在本浏览器的另一个标签页接手了编辑。本页的修改没有保存：可以另存为副本，或者放弃这些修改。')
    await expect(lost.getByRole('button', { name: '放弃本页的修改', exact: true })).toBeVisible()
    await waitForEditorAccess(page, 'read')
    await expect(saveButton(page)).toHaveCount(0)

    // 不续上：之后的几个心跳周期里前一个不再续租、不再申请（请求即使被拦下也看得到它有没有发出）
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

    // 后一个照常编辑、保存；服务器上没有前一个的修改
    await typeInCell(other, 'B1', 'second tab')
    await saveAndWait(other)
    const saved = (await savedContent(other, documentId)).snapshot
    expect([cellOf(saved, 'A1'), cellOf(saved, 'B1')?.v]).toEqual([undefined, 'second tab'])
    await asleep.reconnect()
  })
})
