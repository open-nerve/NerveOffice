// 编辑权中断之后自动续上（US-M3-11 的在线部分；M3 总设计 §2.1 的细化，2026-10-04 决定从 P2 提前到 P1）：
// 编辑权因为到期（断网、休眠一类）、换了登录而中断，期间没人保存过、本人仍能编辑时，页面自动重新取得编辑权（新的一代），接着保存，
// 页头不出现失效的说明。续不上（别处在编辑、别处保存过）的情形见 conflict.spec.ts（US-M1-07）；
// 换了登录、原来的登录还在（经接口重新登录）的情形见 session.spec.ts（US-M1-05 的第三条）。
// 期间的那一版是本页自己一次没收到回包的保存时（US-M3-13）：续上时认出是自己的，以它为基准接着保存，不当成别处保存过（审查 B1）。
// 没收到回包之后失去了编辑权、还读得到时（US-M3-13，M3-P2 设计 §3.4）：给副本之前先原样重发那一次（重放先于登录与租约，只要求能访问），
// 拿到原来的结果就按已保存处理，不说"没有保存"、不给副本。
// M3-P4 起修改自动保存：生产构建里停 2 秒就上传、结果未知的失败 2 秒之后原样重发（测试构建的夹具暂停了定时的上传，生产镜像里没有这个控制）。
// 要"那次结果未知的保存一直悬着、直到编辑权到期"的用例，在回包丢了之后断开这一页的保存与心跳（support/sheet.ts 的 disconnectTab）；
// 只能在测试构建里成立的那一条（心跳先得知、页头回到"有未保存的修改"）标 @test-build。
import type { Page } from '@playwright/test'
import { createDocumentIn, createTeamSpace, createUser, editLeaseEpoch, expireEditLease, revisionOf, withDatabase } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { actAs, loginThroughApi, loginThroughUi } from '../../support/session.ts'
import { cellOf, createSheetThroughApi, disconnectTab, EDITOR_TEST_TIMEOUT, expectFoundOnce, isSaveRequest, lostNotice, openAndEnterEditing, saveAndWait, saveButton, savedContent, saveStatus, typeInCell, waitForEditorAccess, wouldPromptOnLeave } from '../../support/sheet.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

test.describe('US-M3-11 编辑权中断、期间没人保存过：自动续上，接着保存', () => {
  test('编辑权到期、没人接手（改写租约行的时间）：保存时（或者心跳先一步）续上新的一代，保存成功，不出现失效的说明', async ({ page }) => {
    await loginThroughApi(page, await createUser('recover-expired'))
    const documentId = await createSheetThroughApi(page)
    await openAndEnterEditing(page, documentId)
    const before = await editLeaseEpoch(documentId)
    await typeInCell(page, 'A1', 'after expiry')

    await expireEditLease(documentId)
    await saveAndWait(page)
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('after expiry')
    expect(await editLeaseEpoch(documentId)).toBeGreaterThan(before ?? 0)
    await expect(page.getByRole('alert')).toHaveCount(0)

    // 续上之后照常编辑、保存
    await typeInCell(page, 'A2', 'still editing')
    await saveAndWait(page)
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A2')?.v).toBe('still editing')
  })

  test('本人在别的标签页退出又重新登录（换了登录）：本页确认是本人之后续上新的一代，接着保存成功', async ({ page, context }) => {
    const owner = await createUser('recover-relogin')
    await loginThroughApi(page, owner)
    const documentId = await createSheetThroughApi(page)
    await openAndEnterEditing(page, documentId)
    const before = await editLeaseEpoch(documentId)
    await typeInCell(page, 'A1', 'after relogin')

    const other = await context.newPage()
    await other.goto('/')
    await other.getByRole('button', { name: '退出', exact: true }).click()
    await expect(other.getByRole('form', { name: '登录' })).toBeVisible()
    await expect(page.getByRole('alert').filter({ hasText: '本页的修改还在' })).toBeVisible()
    await loginThroughUi(other, owner)
    await expect(other.getByRole('heading', { name: '我的空间' })).toBeVisible()

    // 本页收到登录的消息，确认是本人；编辑权绑定的是原来的登录，随即续上（新的一代），页头没有任何说明。
    // 之后保存成功（生产构建里自动保存在会话回来时就上传了，页头可能已经是"已保存到云端"；按保存照样上传）
    await expect.poll(async () => editLeaseEpoch(documentId)).toBeGreaterThan(before ?? 0)
    await expect(page.getByRole('alert')).toHaveCount(0)
    await saveAndWait(page)
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('after relogin')
  })
})

/**
 * 本页的第一次保存：请求照常到达服务端并提交（修订号 2），浏览器却收不到回包，页头说保存失败。之后接着改了 A2。
 * 返回打开时编辑权的代次。结果未知的失败会自动重试（M3-P4 设计 §3.8）：测试构建暂停了定时的上传，这里不会重试；生产构建里 2 秒之后
 * 原样重发、认出它已提交——要它一直悬着的用例随后断开这一页（disconnectTab）
 */
async function saveWithLostReply(page: Page, documentId: string): Promise<number> {
  await openAndEnterEditing(page, documentId)
  const epoch = await editLeaseEpoch(documentId) ?? 0
  await page.route('**/api/documents/*/content?*', async (route) => {
    if (route.request().method() !== 'PUT') {
      await route.continue()
      return
    }
    await route.fetch()
    await route.abort('connectionreset')
  }, { times: 1 })
  await typeInCell(page, 'A1', 'first')
  await saveButton(page).click()
  await expect(saveStatus(page)).toHaveText('保存失败，稍后自动重试')
  expect((await savedContent(page, documentId)).revision).toBe(2)
  await typeInCell(page, 'A2', 'second')
  return epoch
}

test.describe('US-M3-13 没收到保存的确认，这期间编辑权到期：续上时认出期间的那一版是本页自己的，不误判为别处保存过', () => {
  // 只在测试构建里（@test-build）：要那次结果未知的保存一直悬着、由心跳先得知编辑权到期，而且之后页头回到"有未保存的修改"——
  // 生产构建里自动保存 2 秒之后就原样重发、认出它已提交，走不到"续上时认出"这一步；断开保存让它悬着的话，自动保存的重试一直失败，
  // 页头说的是"保存失败，稍后自动重试"。生产构建里的这条路由下一条（保存先得知，断开这一页）覆盖
  test('US-M3-13 心跳先得知编辑权到期：续上新的一代，以本页那次保存的修订为基准，"保存失败"随之消失；接着保存，服务器上的内容正确（审查 B1）', { tag: '@test-build' }, async ({ page }) => {
    await loginThroughApi(page, await createUser('recover-own-heartbeat'))
    const documentId = await createSheetThroughApi(page)
    const before = await saveWithLostReply(page, documentId)

    // 断网超过 90 秒的效果：编辑权到期，下一次心跳得知、续上
    await expireEditLease(documentId)
    await expect.poll(async () => editLeaseEpoch(documentId), { timeout: 15_000 }).toBeGreaterThan(before)
    // 那次保存其实已经提交：不再说保存失败，之后改的 A2 还没保存；没有失效的说明
    await expect(saveStatus(page)).toHaveText('有未保存的修改')
    await expect(page.getByRole('alert')).toHaveCount(0)

    await saveAndWait(page)
    const saved = await savedContent(page, documentId)
    expect(saved.revision).toBe(3)
    expect([cellOf(saved.snapshot, 'A1')?.v, cellOf(saved.snapshot, 'A2')?.v]).toEqual(['first', 'second'])
    await typeInCell(page, 'A3', 'third')
    await saveAndWait(page)
    const again = await savedContent(page, documentId)
    expect(again.revision).toBe(4)
    expect(cellOf(again.snapshot, 'A3')?.v).toBe('third')
  })

  test('US-M3-13 保存先得知编辑权到期：续上时认出是本页自己的，用新的一代重发、换上新的基准，保存成功，服务器上的内容正确（审查 B1）', async ({ page }) => {
    await loginThroughApi(page, await createUser('recover-own-save'))
    const documentId = await createSheetThroughApi(page)
    const before = await saveWithLostReply(page, documentId)

    // 断网、休眠（拦下心跳与保存）：心跳不会先一步得知，生产构建里自动保存的重试也到不了服务端，那次保存一直悬着；
    // 编辑权到期之后恢复、按保存（生产构建里可能是自动保存的重试先发出，走的是同一条路）
    const asleep = await disconnectTab(page)
    await expireEditLease(documentId)
    await asleep.reconnect()
    await saveAndWait(page)
    expect(await editLeaseEpoch(documentId)).toBeGreaterThan(before)
    await expect(page.getByRole('alert')).toHaveCount(0)
    const saved = await savedContent(page, documentId)
    expect(saved.revision).toBe(3)
    expect([cellOf(saved.snapshot, 'A1')?.v, cellOf(saved.snapshot, 'A2')?.v]).toEqual(['first', 'second'])
  })
})

test.describe('US-M3-13 没收到保存的确认，随后失去编辑权（还读得到）：给副本之前先原样重发那一次', () => {
  test('US-M3-13 保存的回包丢了、随后被降为查看者：页面原样重发那一次（同一个请求），拿到原来的结果——按已保存处理，不说"没有保存"、不给副本；服务器上只有一个新修订', async ({ page, anotherDevice }) => {
    const lead = await createUser('replay-lead', '组长')
    const me = await createUser('replay-me', '同事')
    const space = await createTeamSpace('回包丢了', lead, [[lead, 'admin'], [me, 'editor']])
    const documentId = await createDocumentIn(space.id, lead, '共同的表')
    await loginThroughApi(page, me)
    await openAndEnterEditing(page, documentId)
    const saves: string[] = []
    page.on('request', (request) => {
      if (isSaveRequest(request))
        saves.push(new URL(request.url()).searchParams.get('requestId') ?? '')
    })

    // 保存：请求照常到达服务端并提交（修订 2），浏览器却收不到回包，页头说保存失败
    await page.route('**/api/documents/*/content?*', async (route) => {
      if (route.request().method() !== 'PUT') {
        await route.continue()
        return
      }
      await route.fetch()
      await route.abort('connectionreset')
    }, { times: 1 })
    await typeInCell(page, 'A1', 'first')
    await saveButton(page).click()
    await expect(saveStatus(page)).toHaveText('保存失败，稍后自动重试')
    expect(await revisionOf(documentId)).toBe(2)

    // 生产构建里自动保存 2 秒之后原样重发那一次（重放在登录与租约之前判断，降级之后照样拿到原来的结果），之后失去编辑权时就没有要核对的了；
    // 测试构建暂停了定时的上传，由失去编辑权时的核对重发。两条路发出的都是同一个请求，只有一次重发
    // 空间管理员把我降为查看者（收回写入权）：下一次心跳得知不能编辑了（403），编辑权失效，本页换成只读。还读得到：给副本之前，
    // 先原样重发那一次结果未知的保存——拿到原来的结果，本页的修改其实已经保存，只给"重新加载"。
    // 心跳每 10 秒一次，之后还要以只读重建、重发那一次：慢的机器（CI 比本机慢几倍）上留足余量
    await loginThroughApi(anotherDevice, lead)
    await actAs(anotherDevice, 'PUT', `/api/spaces/${space.id}/members/${me.id}`, { role: 'viewer' })
    const lost = lostNotice(page)
    await expect(lost).toContainText('编辑权已失效：你已没有编辑这份文档的权限（只能查看这份文档，不能编辑）。本页的修改都已保存，重新加载可以看到最新的版本。', { timeout: 45_000 })
    await expect(lost.getByRole('button', { name: '另存为副本', exact: true })).toHaveCount(0)
    await expect(lost.getByRole('button', { name: '放弃本页的修改', exact: true })).toHaveCount(0)
    await waitForEditorAccess(page, 'read')
    expect(await wouldPromptOnLeave(page)).toBe(false)

    // 重发的是同一个请求（requestId 不变），服务端按重放回答原来的结果：没有重复写入，只有一个新修订
    expect(saves).toHaveLength(2)
    expect(saves[1]).toBe(saves[0])
    expect(await revisionOf(documentId)).toBe(2)
    const revisions = await withDatabase(async client => (await client.query<{ revision: number }>('SELECT revision FROM document_revisions WHERE document_id = $1 ORDER BY revision', [documentId])).rows.map(row => row.revision))
    expect(revisions).toEqual([1, 2])

    // 重新加载：按服务器上的版本回到阅读，只能查看；那一次保存的内容在
    await lost.getByRole('button', { name: '重新加载', exact: true }).click()
    await expect(lostNotice(page)).toHaveCount(0)
    await expect(saveStatus(page)).toHaveText('只能查看')
    await expectFoundOnce(page, 'first')
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('first')
  })
})
