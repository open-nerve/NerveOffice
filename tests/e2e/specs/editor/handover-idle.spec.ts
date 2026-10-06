// 空闲释放（US-M3-07；M3-P5 设计 §3.9）：编辑时 10 分钟没有键盘、鼠标操作，页面先挡住输入、保存，存上了再释放编辑权，以只读重建、回到阅读，
// 说明放进一直在的读屏状态区；没存上就留在编辑，过一个心跳周期再看；页面一直没能释放时服务端 12 分钟兜底回收，人回来（有操作）时自动续上。
// 不真等 10 分钟：页面的时间用 Playwright 的时钟（打开之前装上，之后照常流动、照常渲染），要到点时 fastForward——到点的计时器至多各执行一次，
// 页面的空闲计时、心跳与自动保存都在注入的时钟上（edit-lease.ts 的 browserLeaseClock）。服务端的时间拨不动（数据库的 now()，心跳上报的空闲
// 也不早于申请的时间），服务端的兜底回收改库（support/database.ts 的 idleEditLease）。
// 容器 E2E 也跑（生产镜像里定时的自动保存照常运行，M3-P4 设计 §3.14）：修改在空闲之前可能已经自动存上，空闲释放的那一次上传就去重、不发；
// 要"没存上"的先拦下这一页的保存（blockSaves），生产构建里自动保存的重试一样被拦下；断言只看结果（阅读、服务器上的内容、编辑权怎样结束），
// 不看是哪一次上传存上的
import type { Page, Request } from '@playwright/test'
import { createUser, editLeaseEndReason, editLeaseEpoch, idleEditLease } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi } from '../../support/session.ts'
import { blockSaves, cellOf, createSheetThroughApi, EDITOR_TEST_TIMEOUT, editorSurface, enterEditButton, headerAnnouncement, lostNotice, openAndEnterEditing, saveAndWait, saveButton, savedContent, saveStatus, typeInCell, waitForEditorAccess } from '../../support/sheet.ts'
import { recordStatusWrites, spokenWrites } from '../../support/status-writes.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

/** 空闲释放之后阅读时的说明：一直在的读屏状态区（不是新插入的提示） */
function statusRegion(page: Page) {
  return page.locator('#editor-chrome [data-slot="status-region"]')
}

/** 申请编辑权（POST …/edit-lease）的请求 */
function isLeaseAcquisition(request: Request, documentId: string): boolean {
  return request.method() === 'POST' && new URL(request.url()).pathname === `/api/documents/${documentId}/edit-lease`
}

/** 心跳续租（PUT …/edit-lease）的请求 */
function isLeaseRenewal(request: Request, documentId: string): boolean {
  return request.method() === 'PUT' && new URL(request.url()).pathname === `/api/documents/${documentId}/edit-lease`
}

/** 这个页面申请编辑权时带的请求体，按先后 */
function recordAcquisitionBodies(page: Page, documentId: string): unknown[] {
  const bodies: unknown[] = []
  page.on('request', (request) => {
    if (isLeaseAcquisition(request, documentId))
      bodies.push(request.postDataJSON())
  })
  return bodies
}

/** 这个页面发出的保存与释放（PUT …/content、DELETE …/edit-lease） */
function recordWrites(page: Page, documentId: string): { readonly saves: number, readonly releases: number } {
  const writes = { saves: 0, releases: 0 }
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (request.method() === 'PUT' && path === `/api/documents/${documentId}/content`)
      writes.saves += 1
    if (request.method() === 'DELETE' && path === `/api/documents/${documentId}/edit-lease`)
      writes.releases += 1
  })
  return writes
}

test.describe('US-M3-07 空闲释放：10 分钟没有操作先保存再释放编辑权', () => {
  test('US-M3-07 10 分钟没有键盘、鼠标操作：先挡住输入保存（页头说正在保存并释放），存上了再释放编辑权、回到阅读，读屏状态区说明；服务器上是这一页的内容，编辑权按释放结束', async ({ page }) => {
    await loginThroughApi(page, await createUser('idle-release'))
    const documentId = await createSheetThroughApi(page)
    await page.clock.install()
    await openAndEnterEditing(page, documentId)
    await recordStatusWrites(headerAnnouncement(page))
    await typeInCell(page, 'A1', 'before idle')

    await page.clock.fastForward('10:00')
    await waitForEditorAccess(page, 'read')
    await expect(statusRegion(page)).toHaveText('10 分钟没有操作，已保存并释放编辑权')
    await expect(enterEditButton(page)).toBeVisible()
    await expect(saveButton(page)).toHaveCount(0)
    // 释放的过程中页头的播报区说过在做什么
    expect((await spokenWrites(page)).map(write => write.text)).toContain('10 分钟没有操作，正在保存并释放编辑权…')
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('before idle')
    expect(await editLeaseEndReason(documentId)).toBe('released')
  })

  test('US-M3-07 空闲满 10 分钟时保存失败：留在编辑、不释放（保存的状态说明失败），过一个心跳周期再试；保存恢复之后存上、释放、回到阅读', async ({ page }) => {
    await loginThroughApi(page, await createUser('idle-save-fails'))
    const documentId = await createSheetThroughApi(page)
    await page.clock.install()
    await openAndEnterEditing(page, documentId)
    const writes = recordWrites(page, documentId)
    // 只拦这一页的保存（心跳照常）：之后的修改存不上
    const saves = await blockSaves(page)
    await typeInCell(page, 'A1', 'saved later')

    await page.clock.fastForward('10:00')
    // 这一轮立即上传、被拦下：留在编辑（可编辑的编辑器还在），保存的状态说明失败；没有释放
    await expect.poll(() => writes.saves).toBeGreaterThan(0)
    await expect(saveStatus(page)).toHaveText(/^保存失败/)
    await expect(editorSurface(page)).toHaveAttribute('data-editor-access', 'edit')
    expect(writes.releases).toBe(0)
    expect(await editLeaseEndReason(documentId)).toBeNull()

    // 保存恢复：下一轮（一个心跳周期之后）存上、释放
    await saves.unblock()
    await page.clock.fastForward(10_000)
    await waitForEditorAccess(page, 'read')
    await expect(statusRegion(page)).toHaveText('10 分钟没有操作，已保存并释放编辑权')
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('saved later')
    expect(await editLeaseEndReason(documentId)).toBe('released')
  })

  test('US-M3-07 页面没能释放（保存一直失败）、服务端 12 分钟兜底回收：人不在时页面不续上；人回来（有操作）时自动续上新的一代（申请带本页的空闲秒数），接着保存，修改不丢', async ({ page }) => {
    await loginThroughApi(page, await createUser('idle-reclaimed'))
    const documentId = await createSheetThroughApi(page)
    await page.clock.install()
    await openAndEnterEditing(page, documentId)
    const epoch = await editLeaseEpoch(documentId) ?? 0
    const acquisitions = recordAcquisitionBodies(page, documentId)
    const saves = await blockSaves(page)
    await typeInCell(page, 'A1', 'kept through reclaim')

    // 10 分钟：空闲释放存不上，留在编辑
    await page.clock.fastForward('10:00')
    await expect(saveStatus(page)).toHaveText(/^保存失败/)
    // 服务端兜底：改库让这一代空闲满 12 分钟；页面这边再过两分多钟，空闲也满了 12 分钟——下一次心跳得知空闲回收，人不在，不续上
    // （先等着那次 409 再改库：改库之后、拨时钟之前恰好有一次心跳也不会漏掉）
    const reclaimed = page.waitForResponse(response => isLeaseRenewal(response.request(), documentId) && response.status() === 409)
    await idleEditLease(documentId)
    await page.clock.fastForward('02:10')
    await reclaimed
    // "没有申请"只能等一段时间再下结论：续上从得知到发出申请不到 100 ms，这里等 1 秒
    const acquired = page.waitForRequest(request => isLeaseAcquisition(request, documentId), { timeout: 1_000 }).then(() => true, () => false)
    expect(await acquired).toBe(false)
    expect(await editLeaseEpoch(documentId)).toBe(epoch)
    await expect(editorSurface(page)).toHaveAttribute('data-editor-access', 'edit')
    await expect(lostNotice(page)).toHaveCount(0)

    // 人回来：保存恢复之后挪动鼠标（可信的、有位移的操作）。人不在时停着的编辑权随即续上；碰上空闲释放正在试的那一轮，下一次心跳续上
    await saves.unblock()
    await page.mouse.move(400, 300)
    await page.mouse.move(420, 320)
    await page.clock.fastForward(10_000)
    await expect.poll(async () => editLeaseEpoch(documentId)).toBeGreaterThan(epoch)
    const body = acquisitions.at(-1) as { readonly idleSeconds?: unknown } | undefined
    expect(typeof body?.idleSeconds).toBe('number')
    await saveAndWait(page)
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('kept through reclaim')
    await expect(lostNotice(page)).toHaveCount(0)
    await expect(editorSurface(page)).toHaveAttribute('data-editor-access', 'edit')
  })
})
