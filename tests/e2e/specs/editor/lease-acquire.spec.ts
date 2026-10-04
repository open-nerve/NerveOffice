// 同一时刻只有一个人、一个标签页能编辑（US-M3-04；P1 设计 §3.4.7、§7 第一条；M3-P2 设计 §3.4）。M3-P2 起打开即阅读，点"编辑"才申请：
// - 两个人：一个在编辑时，其他人（编辑者与查看者）打开都是阅读，看到"谁正在编辑（最后活动 x 分钟前）"——编辑状态能读就能看；
//   能编辑的人点"编辑"得到被占用，留在阅读；两人同时点"编辑"，最多一个成功（并发的申请与锁的交错由集成测试确定地覆盖）；
// - 同一个人的多个标签页：一个在编辑时另一个点"编辑"也进不去；打开时申请，回包丢了也不留下没人用的一代——同一个页面用同一个标识
//   再试一次，服务端当作重试、发新的一代（审查 B7）；刷新、关闭时经 keepalive 释放，之后刷新、重开出来的页面立即能编辑。
// 这几条都不在导航离开之前装拦截：WebKit 装了 page.route 之后，导航离开、刷新时的 keepalive 请求送不到（support/sheet.ts 的 leaveEditor）
import type { Page } from '@playwright/test'
import type { TestUser } from '../../support/database.ts'
import { createDocumentIn, createTeamSpace, createUser, editLeaseEndReason, editLeaseEpoch } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi } from '../../support/session.ts'
import { cellOf, createSheetThroughApi, editingBy, editingNotice, EDITOR_TEST_TIMEOUT, editorSurface, enterEditButton, enterEditing, exitEditing, openAndEnterEditing, openReader, reloadAndEnterEditing, saveAndWait, saveButton, savedContent, saveStatus, typeInCell } from '../../support/sheet.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

/** 这个页面申请编辑权的回答（POST …/edit-lease 的状态码）按先后记下来 */
function recordAcquisitions(page: Page, documentId: string): number[] {
  const statuses: number[] = []
  page.on('response', (response) => {
    if (response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/documents/${documentId}/edit-lease`)
      statuses.push(response.status())
  })
  return statuses
}

/** 点"编辑"的一方：页面与登录的人 */
interface Contender {
  readonly page: Page
  readonly person: TestUser
}

/**
 * 点了"编辑"之后这个页面的结果：editing 是取得了编辑权、以可编辑重建（有保存按钮）；held 是被占用、回到阅读（又有"编辑"，说明谁在编辑）；
 * 别的时候还没有结果
 */
async function enterOutcome(page: Page): Promise<'editing' | 'held' | 'pending'> {
  if (await saveButton(page).isVisible())
    return 'editing'
  return await enterEditButton(page).isVisible() && await editingNotice(page).isVisible() ? 'held' : 'pending'
}

/** 都有了结果之后：进入了编辑的一方与被占用的一方（不是一个进入、一个被占用时抛错，用例失败） */
async function splitOutcomes(contenders: readonly Contender[]): Promise<{ readonly winner: Contender, readonly loser: Contender }> {
  const outcomes = await Promise.all(contenders.map(async contender => ({ contender, outcome: await enterOutcome(contender.page) })))
  const winner = outcomes.find(entry => entry.outcome === 'editing')?.contender
  const loser = outcomes.find(entry => entry.outcome === 'held')?.contender
  if (winner === undefined || loser === undefined)
    throw new Error(`两边的结果不是一个进入编辑、一个被占用：${outcomes.map(entry => entry.outcome).join('、')}`)
  return { winner, loser }
}

test.describe('US-M3-04 同一时刻只有一个人能编辑：其他人打开是阅读，看到谁在编辑', () => {
  test('US-M3-04 甲在编辑：乙（编辑者）与丙（查看者）打开都是阅读，看到"甲正在编辑（最后活动……）"；乙点"编辑"被占用、留在阅读，丙没有"编辑"；甲照常保存', async ({ page, anotherDevice }) => {
    const lead = await createUser('presence-lead', '组长')
    const first = await createUser('presence-first', '甲')
    const second = await createUser('presence-second', '乙')
    const third = await createUser('presence-third', '丙')
    const space = await createTeamSpace('谁在编辑', lead, [[lead, 'admin'], [first, 'editor'], [second, 'editor'], [third, 'viewer']])
    const documentId = await createDocumentIn(space.id, lead, '共同的表')
    await loginThroughApi(page, first)
    await openAndEnterEditing(page, documentId)
    await typeInCell(page, 'A1', 'from first')

    // 乙（编辑者）：打开即阅读，读到编辑状态——甲在编辑，自己现在只能阅读；有"编辑"
    await loginThroughApi(anotherDevice, second)
    await openReader(anotherDevice, documentId)
    await expect(editingNotice(anotherDevice)).toHaveText(editingBy(first, true))
    // 乙点"编辑"：申请被占用（409），留在阅读（只读的编辑器不换），说明还是甲在编辑
    const acquisitions = recordAcquisitions(anotherDevice, documentId)
    await enterEditButton(anotherDevice).click()
    await expect.poll(() => acquisitions).toEqual([409])
    await expect(enterEditButton(anotherDevice)).toBeVisible()
    await expect(editingNotice(anotherDevice)).toHaveText(editingBy(first, true))
    await expect(editorSurface(anotherDevice)).toHaveAttribute('data-editor-access', 'read')
    await expect(saveButton(anotherDevice)).toHaveCount(0)

    // 丙（查看者）：同样看到甲在编辑（编辑状态能读就能看），只能查看，没有"编辑"
    await anotherDevice.goto('about:blank')
    await loginThroughApi(anotherDevice, third)
    await openReader(anotherDevice, documentId)
    await expect(saveStatus(anotherDevice)).toHaveText('只能查看')
    await expect(editingNotice(anotherDevice)).toHaveText(editingBy(first, false))
    await expect(enterEditButton(anotherDevice)).toHaveCount(0)

    // 甲不受影响：照常保存
    await saveAndWait(page)
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('from first')
  })

  test('US-M3-04 两人同时点"编辑"：只有一个成功——一个以可编辑重建、能保存，另一个留在阅读、看到对方正在编辑', async ({ page, anotherDevice }) => {
    const lead = await createUser('race-lead', '组长')
    const first = await createUser('race-first', '甲')
    const second = await createUser('race-second', '乙')
    const space = await createTeamSpace('同时点编辑', lead, [[lead, 'admin'], [first, 'editor'], [second, 'editor']])
    const documentId = await createDocumentIn(space.id, lead, '共同的表')
    await loginThroughApi(page, first)
    await openReader(page, documentId)
    await loginThroughApi(anotherDevice, second)
    await openReader(anotherDevice, documentId)

    const contenders: readonly Contender[] = [{ page, person: first }, { page: anotherDevice, person: second }]
    await Promise.all(contenders.map(async contender => enterEditButton(contender.page).click()))
    // 两边都有了结果：一个进入了编辑，另一个被占用
    await expect.poll(async () => (await Promise.all(contenders.map(async contender => enterOutcome(contender.page)))).sort()).toEqual(['editing', 'held'])
    const { winner, loser } = await splitOutcomes(contenders)
    await expect(editingNotice(loser.page)).toHaveText(editingBy(winner.person, true))
    await expect(editorSurface(loser.page)).toHaveAttribute('data-editor-access', 'read')
    // 服务端只发了一代
    expect(await editLeaseEpoch(documentId)).toBe(1)
    await typeInCell(winner.page, 'A1', 'the winner')
    await saveAndWait(winner.page)
    expect(cellOf((await savedContent(winner.page, documentId)).snapshot, 'A1')?.v).toBe('the winner')
  })
})

test.describe('US-M3-04 同一个人在多个标签页：打开、刷新与关闭时的编辑权', () => {
  test('US-M3-04 一个标签页在编辑时，另一个点"编辑"也进不去：说明在另一个标签页或设备上编辑，留在阅读；那边退出编辑之后，这里点"编辑"就能编辑', async ({ page, context }) => {
    await loginThroughApi(page, await createUser('two-tabs'))
    const documentId = await createSheetThroughApi(page)
    await openAndEnterEditing(page, documentId)
    const other = await context.newPage()
    await openReader(other, documentId)
    const elsewhere = '你在另一个标签页或设备上正在编辑这份文档，这里只能阅读。要是刚刚关闭或刷新过那个页面，那边的编辑权最多 90 秒后自动结束，到时再点"编辑"就能编辑'
    await expect(editingNotice(other)).toHaveText(elsewhere)

    // 点"编辑"：被自己的另一个标签页占着（先隔一小会儿再试几次：刷新时旧页面的释放可能晚到），仍被占用就回到阅读（"编辑"在进入期间不在）
    const acquisitions = recordAcquisitions(other, documentId)
    await enterEditButton(other).click()
    await expect.poll(() => acquisitions.length).toBeGreaterThan(0)
    await expect(enterEditButton(other)).toBeVisible()
    expect(acquisitions.every(status => status === 409)).toBe(true)
    await expect(editingNotice(other)).toHaveText(elsewhere)
    await expect(editorSurface(other)).toHaveAttribute('data-editor-access', 'read')
    await expect(saveButton(other)).toHaveCount(0)
    expect(await editLeaseEpoch(documentId)).toBe(1)
    await expect(saveButton(page)).toBeVisible()

    // 第一个标签页退出编辑（放掉编辑权）：这里点"编辑"取得新的一代，能编辑、保存
    await exitEditing(page)
    await enterEditing(other)
    expect(await editLeaseEpoch(documentId)).toBe(2)
    await typeInCell(other, 'A1', 'second tab')
    await saveAndWait(other)
    expect(cellOf((await savedContent(other, documentId)).snapshot, 'A1')?.v).toBe('second tab')
  })

  test('US-M3-04 申请的回包丢了（服务端其实已经批给了本页）：页面用同一个标识再试一次，照常编辑与保存，不留下占着编辑权、却没有页面在用的一代（审查 B7）', async ({ page }) => {
    await loginThroughApi(page, await createUser('acquire-lost-reply'))
    const documentId = await createSheetThroughApi(page)
    // 这个页面的第一次申请（POST；阅读时读编辑状态的 GET 照常）：请求照常到达服务端并取得，浏览器却收不到回包
    let dropped = false
    await page.route('**/api/documents/*/edit-lease', async (route) => {
      if (dropped || route.request().method() !== 'POST') {
        await route.continue()
        return
      }
      dropped = true
      await route.fetch()
      await route.abort('connectionreset')
    })
    await openAndEnterEditing(page, documentId)
    await expect(saveButton(page)).toBeVisible()
    await expect(editingNotice(page)).toHaveCount(0)
    // 服务端：第一次申请取得了一代；再试是同一个页面的重试，发了新的一代，取代没人用的那一代
    expect(await editLeaseEpoch(documentId)).toBe(2)
    await typeInCell(page, 'A1', 'after retry')
    await saveAndWait(page)
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('after retry')
  })

  test('US-M3-04 关闭标签页：编辑权随即释放（keepalive 送到），之后打开的页面立即能编辑', async ({ page, context }) => {
    await loginThroughApi(page, await createUser('close-releases'))
    const documentId = await createSheetThroughApi(page)
    const editor = await context.newPage()
    await openAndEnterEditing(editor, documentId)
    await expect(saveButton(editor)).toBeVisible()
    expect(await editLeaseEndReason(documentId)).toBeNull()

    await editor.close()
    await expect.poll(async () => editLeaseEndReason(documentId)).toBe('released')
    await openAndEnterEditing(page, documentId)
    await expect(saveButton(page)).toBeVisible()
    await expect(editingNotice(page)).toHaveCount(0)
  })

  test('US-M3-04 刷新：刷新出来的页面点"编辑"立即能编辑，每次是新的一代（旧页面的释放晚到时，新页面隔一小会儿再试，P1 设计 §7 第一条）', async ({ page }) => {
    await loginThroughApi(page, await createUser('reload-keeps-editing'))
    const documentId = await createSheetThroughApi(page)
    await openAndEnterEditing(page, documentId)
    let epoch = await editLeaseEpoch(documentId) ?? 0
    for (let round = 0; round < 3; round += 1) {
      await reloadAndEnterEditing(page)
      await expect(saveButton(page)).toBeVisible()
      await expect(editingNotice(page)).toHaveCount(0)
      const next = await editLeaseEpoch(documentId) ?? 0
      expect(next).toBeGreaterThan(epoch)
      epoch = next
    }
    await typeInCell(page, 'A1', 'after reloads')
    await saveAndWait(page)
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('after reloads')
  })
})
