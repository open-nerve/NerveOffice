// M4-P3 S3：原件由合法加密夹具落盘；用户动作、SDK、保存与清理使用产品入口。
import type { Page, Request } from '@playwright/test'
import type { Workbook } from '../../support/sheet.ts'
import { randomUUID } from 'node:crypto'
import { acquiredEditLeaseSchema } from '@nerve-office/contracts'
import { recordWrites, saveParam } from '../../support/autosave.ts'
import { CURRENT_CLIENT } from '../../support/client-format.ts'
import { archiveSpace, createDocumentIn, createTeamSpace, createUser, revisionOf, writeVersion } from '../../support/database.ts'
import { shownCell } from '../../support/editor-probe.ts'
import { e2eOrigin } from '../../support/environment.ts'
import { expect, test } from '../../support/fixtures.ts'
import { expectFormulaCombination, withFormulaCombination } from '../../support/formula-combination.ts'
import { currentLocalKey, readLocalDisk } from '../../support/local-draft.ts'
import { recoverySnapshot, seedRecovery } from '../../support/local-recovery.ts'
import { DAY_MS, probe, probeDatabase } from '../../support/outbox-probe.ts'
import { actAs, loginThroughApi, loginThroughUi } from '../../support/session.ts'
import { cellOf, createSheetThroughApi, EDITOR_TEST_TIMEOUT, enterEditButton, exitEditing, openAndEnterEditing, openReader, savedContent, saveStatus, waitForEditorAccess } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

async function documentFor(page: Page, prefix: string) {
  const owner = await createUser(prefix)
  await loginThroughApi(page, owner)
  const documentId = await createSheetThroughApi(page)
  const cloud = await savedContent(page, documentId)
  return { owner, documentId, key: { userId: owner.id, documentId }, cloud }
}

function notice(page: Page) {
  return page.locator('[data-slot="recovery-notice"]')
}

/** 两个既定案例共用恢复协议，公式案例额外携带故意错误的跨表缓存。 */
function fastForwardSnapshot(text: string, formula: boolean): string {
  const original = recoverySnapshot(text, formula ? 2 : '崩溃前的本机内容', formula)
  return formula ? withFormulaCombination(original, true) : original
}

function expectFastForwardContent(book: Workbook, formula: boolean): void {
  expect(cellOf(book, 'A1')?.v).toBe(formula ? 2 : '崩溃前的本机内容')
  expect(cellOf(book, 'B1')?.v).toBe(formula ? 4 : undefined)
  expect(cellOf(book, 'B1')?.f).toBe(formula ? '=A1*2' : undefined)
  if (formula)
    expectFormulaCombination(book, 2)
}

async function copyAndCheck(page: Page, documentId: string, value: string) {
  await expect(notice(page).getByRole('button', { name: '另存为副本', exact: true })).toBeEnabled()
  await notice(page).getByRole('button', { name: '另存为副本', exact: true }).click()
  const link = notice(page).getByRole('link', { name: '打开副本（新标签页）' })
  await expect(link).toBeVisible()
  const copiedId = (await link.getAttribute('href'))!.split('/').at(-1)!
  expect(copiedId).not.toBe(documentId)
  expect(cellOf((await savedContent(page, copiedId)).snapshot, 'A1')?.v).toBe(value)
  await expect(notice(page).getByRole('button', { name: '另存为副本', exact: true })).toHaveCount(0)
  return copiedId
}

async function classifiedConflict(page: Page, prefix: string) {
  const h = await documentFor(page, prefix)
  const clientInstanceId = randomUUID()
  const inFlight = { requestId: randomUUID(), clientInstanceId, localSeq: 37, sentAt: Date.now() }
  await seedRecovery(page, h.key, recoverySnapshot(h.cloud.text, '待处理的冲突修改'), { writtenBy: clientInstanceId, inFlight })
  await advanceCloud(h, '别处的云端修改')
  await openReader(page, h.documentId)
  // 没有旧回执且修订差一版：阅读状态缺来源，申请后才能证明这不是自己的旧上传。
  const restore = notice(page).getByRole('button', { name: '恢复并编辑' })
  await expect(restore).toBeEnabled()
  await restore.click()
  await expect(notice(page).getByText(/云端已有不同的修改/)).toBeVisible()
  await waitForEditorAccess(page, 'read', 'steady')
  await expect.poll(async () => (await (await page.request.get(`/api/documents/${h.documentId}/edit-lease`)).json() as { editor: unknown }).editor).toBeNull()
  return h
}

async function advanceCloud(h: Awaited<ReturnType<typeof documentFor>>, value: string): Promise<void> {
  await writeVersion(h.documentId, h.owner, (book) => {
    Object.assign(book, JSON.parse(recoverySnapshot(JSON.stringify(book), value)) as Record<string, unknown>)
  })
}

/** 真实成功的 HTTP 与本机原样请求：只让夹具不应用回执，构造丢确认的断点。 */
async function receiptFor(page: Page, prefix: string) {
  const h = await documentFor(page, prefix)
  const { csrfToken } = await (await page.request.get('/api/auth/session')).json() as { csrfToken: string }
  const clientInstanceId = randomUUID()
  const acquired = await page.request.post(`/api/documents/${h.documentId}/edit-lease`, { headers: { 'origin': e2eOrigin(), 'x-csrf-token': csrfToken }, data: { ...CURRENT_CLIENT, clientInstanceId } })
  expect(acquired.status()).toBe(201)
  const lease = acquiredEditLeaseSchema.parse(await acquired.json())
  const inFlight = { requestId: randomUUID(), clientInstanceId, localSeq: 37, sentAt: Date.now() }
  const seeded = await seedRecovery(page, h.key, recoverySnapshot(h.cloud.text, '已保存但丢回包'), { inFlight, writtenBy: clientInstanceId, writeEpoch: lease.writeEpoch })
  const query = new URLSearchParams({ ...CURRENT_CLIENT, formatVersion: String(CURRENT_CLIENT.formatVersion), baseRevision: '1', requestId: inFlight.requestId, clientInstanceId, localSeq: '37', writeEpoch: String(lease.writeEpoch), formulasPending: 'false' })
  const sent = await page.request.put(`/api/documents/${h.documentId}/content?${query}`, { headers: { 'origin': e2eOrigin(), 'x-csrf-token': csrfToken, 'x-edit-lease': lease.token, 'content-type': 'application/gzip' }, data: seeded.gzip })
  expect(sent.status(), await sent.text()).toBe(200)
  expect((await page.request.delete(`/api/documents/${h.documentId}/edit-lease`, { headers: { 'origin': e2eOrigin(), 'x-csrf-token': csrfToken, 'x-edit-lease': lease.token } })).ok()).toBe(true)
  return { ...h, seeded, inFlight }
}

test.describe('US-M4-03 手动恢复与冲突处理', { tag: '@test-build' }, () => {
  test.use({ autosave: 'running' })

  for (const formula of [false, true]) {
    test(`快进恢复${formula ? '完整重算公式' : '原文'}，零次额外输入也自动上传并清理`, async ({ page }) => {
      const h = await documentFor(page, `recovery-${formula ? 'formula' : 'text'}`)
      const snapshot = fastForwardSnapshot(h.cloud.text, formula)
      await seedRecovery(page, h.key, snapshot, { formulasPending: formula })
      const writes = recordWrites(page, h.documentId)
      await openReader(page, h.documentId)
      await expect(notice(page).getByText(/发现 .* 未同步的修改/)).toBeVisible()
      expect(await revisionOf(h.documentId)).toBe(1)
      await notice(page).getByRole('button', { name: '恢复并编辑' }).click()
      await waitForEditorAccess(page, 'edit')
      await expect(saveStatus(page)).toHaveText('已保存到云端')
      const cloud = await savedContent(page, h.documentId)
      expect(cloud.revision).toBe(2)
      expectFastForwardContent(cloud.snapshot, formula)
      expect(saveParam(writes.saves[0], 'formulasPending')).toBe('false')
      expect(Number(saveParam(writes.saves[0], 'localSeq'))).toBeGreaterThan(37)
      await expect.poll(async () => (await readLocalDisk(page, h.key)).draft).toBeNull()
      await exitEditing(page)
      await expect(notice(page).getByText('恢复的修改已保存到云端')).toBeVisible()
    })
  }

  test('真实冲突只另存副本，原文云端修订与内容不变', async ({ page }) => {
    const h = await documentFor(page, 'recovery-conflict')
    await seedRecovery(page, h.key, recoverySnapshot(h.cloud.text, '我的未同步修改'))
    await advanceCloud(h, '别处的云端修改')
    await openReader(page, h.documentId)
    await expect(notice(page).getByText(/云端已有不同的修改/)).toBeVisible()
    await expect(notice(page).getByRole('button', { name: '恢复并编辑' })).toHaveCount(0)
    await copyAndCheck(page, h.documentId, '我的未同步修改')
    expect(await revisionOf(h.documentId)).toBe(2)
    expect(cellOf((await savedContent(page, h.documentId)).snapshot, 'A1')?.v).toBe('别处的云端修改')
    await expect.poll(async () => (await readLocalDisk(page, h.key)).draft).toBeNull()
  })

  test('普通编辑入口也先恢复旧草稿，不能用云端初值覆盖它', async ({ page }) => {
    const h = await documentFor(page, 'r-ordinary-entry')
    await seedRecovery(page, h.key, recoverySnapshot(h.cloud.text, '从普通编辑恢复'))
    await openReader(page, h.documentId)
    await expect(notice(page).getByText(/发现 .* 未同步的修改/)).toBeVisible()
    await enterEditButton(page).click()
    await waitForEditorAccess(page, 'edit')
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(cellOf((await savedContent(page, h.documentId)).snapshot, 'A1')?.v).toBe('从普通编辑恢复')
    expect(await revisionOf(h.documentId)).toBe(2)
    await expect.poll(async () => (await readLocalDisk(page, h.key)).draft).toBeNull()
  })

  for (const refusal of [false, true]) {
    test(`副本${refusal ? '明确拒绝' : '结果未知'}后放弃原件，可以继续普通编辑`, async ({ page }) => {
      const h = await documentFor(page, `r-copy-${refusal ? 'refused' : 'unknown'}`)
      const seeded = await seedRecovery(page, h.key, recoverySnapshot(h.cloud.text, '不再需要的本机修改'))
      await advanceCloud(h, '应保留的云端内容')
      const requests: Request[] = []
      await page.route(`**/api/documents/${h.documentId}/conflict-copies?**`, async (route) => {
        requests.push(route.request())
        if (refusal)
          await route.fulfill({ status: 422, json: { error: { code: 'SNAPSHOT_INVALID', message: '副本内容不合格', requestId: 'copy-refused' } } })
        else
          await route.abort('failed')
      })
      await openReader(page, h.documentId)
      await notice(page).getByRole('button', { name: '另存为副本', exact: true }).click()
      await expect(notice(page).getByText(refusal ? /本机修改的内容未通过保存检查/ : /未能确认副本是否保存成功/)).toBeVisible()
      expect((await readLocalDisk(page, h.key)).draft).toEqual(seeded.disk)
      await notice(page).getByRole('button', { name: '放弃本机修改' }).click()
      await page.getByRole('dialog').getByRole('button', { name: '确认放弃' }).click()
      await expect.poll(async () => (await readLocalDisk(page, h.key)).draft).toBeNull()
      await expect(notice(page).getByRole('button', { name: '重试另存为副本' })).toHaveCount(0)
      await enterEditButton(page).click()
      await waitForEditorAccess(page, 'edit', 'steady')
      expect(await shownCell(page, 'A1')).toBe('应保留的云端内容')
      expect(await revisionOf(h.documentId)).toBe(2)
      expect(requests).toHaveLength(1)
    })
  }

  test('申请编辑后证实冲突，退回阅读仍能另存原件副本', async ({ page }) => {
    const h = await classifiedConflict(page, 'r-classified-copy')
    await copyAndCheck(page, h.documentId, '待处理的冲突修改')
    expect(await revisionOf(h.documentId)).toBe(2)
    expect(cellOf((await savedContent(page, h.documentId)).snapshot, 'A1')?.v).toBe('别处的云端修改')
    await expect.poll(async () => (await readLocalDisk(page, h.key)).draft).toBeNull()
  })

  test('申请编辑后证实冲突，退回阅读的放弃确认能清理原件', async ({ page }) => {
    const h = await classifiedConflict(page, 'r-classified-discard')
    const discard = notice(page).getByRole('button', { name: '放弃本机修改' })
    await expect(discard).toBeEnabled()
    await discard.click()
    await page.getByRole('dialog').getByRole('button', { name: '确认放弃' }).click()
    await expect.poll(async () => (await readLocalDisk(page, h.key)).draft).toBeNull()
    await expect(notice(page).getByText('这份本机草稿已清除')).toBeVisible()
    expect(await revisionOf(h.documentId)).toBe(2)
  })

  test('只读仍能另存副本；原文不获得写入', async ({ page }) => {
    const owner = await createUser('recovery-viewer')
    await loginThroughApi(page, owner)
    const space = await createTeamSpace('recovery-viewer', owner, [[owner, 'editor']])
    const documentId = await createDocumentIn(space.id, owner, '归档前本机内容')
    const key = { userId: owner.id, documentId }
    await seedRecovery(page, key, recoverySnapshot((await savedContent(page, documentId)).text, '只读后保留'))
    await archiveSpace(space.id)
    await openReader(page, documentId)
    await expect(notice(page).getByText(/目前只能查看/)).toBeVisible()
    await expect(notice(page).getByRole('button', { name: '恢复并编辑' })).toHaveCount(0)
    await copyAndCheck(page, documentId, '只读后保留')
    expect(await revisionOf(documentId)).toBe(1)
    await expect.poll(async () => (await readLocalDisk(page, key)).draft).toBeNull()
  })

  test('另一设备占用时不恢复覆盖，可以取回本机副本', async ({ page, anotherDevice }) => {
    const h = await documentFor(page, 'recovery-held')
    await seedRecovery(page, h.key, recoverySnapshot(h.cloud.text, '被占用的本机内容'))
    await loginThroughApi(anotherDevice, h.owner)
    await openAndEnterEditing(anotherDevice, h.documentId)
    await openReader(page, h.documentId)
    await expect(notice(page).getByText(/有人正在编辑/)).toBeVisible()
    await expect(notice(page).getByRole('button', { name: '恢复并编辑' })).toHaveCount(0)
    await copyAndCheck(page, h.documentId, '被占用的本机内容')
    expect(await revisionOf(h.documentId)).toBe(1)
    await expect.poll(async () => (await readLocalDisk(page, h.key)).draft).toBeNull()
  })

  test('放弃先确认；取消保持密文，确认后只删原件', async ({ page }) => {
    const h = await documentFor(page, 'recovery-discard')
    const seeded = await seedRecovery(page, h.key, recoverySnapshot(h.cloud.text, '只在本机'))
    await openReader(page, h.documentId)
    await notice(page).getByRole('button', { name: '放弃本机修改' }).click()
    await page.getByRole('dialog').getByRole('button', { name: '取消' }).click()
    expect((await readLocalDisk(page, h.key)).draft).toEqual(seeded.disk)
    await notice(page).getByRole('button', { name: '放弃本机修改' }).click()
    await page.getByRole('dialog').getByRole('button', { name: '确认放弃' }).click()
    await expect.poll(async () => (await readLocalDisk(page, h.key)).draft).toBeNull()
    await expect(notice(page).getByText('这份本机草稿已清除')).toBeVisible()
    expect(await revisionOf(h.documentId)).toBe(1)
  })

  for (const state of ['expired', 'corrupted', 'newer-format'] as const) {
    test(`${state} 按实际记录分类，清理或保留均不改云端`, async ({ page }) => {
      const h = await documentFor(page, `recovery-${state}`)
      const seeded = await seedRecovery(page, h.key, recoverySnapshot(h.cloud.text, '原本机草稿'), state === 'expired' ? { updatedAt: Date.now() - 15 * DAY_MS } : {})
      await probeDatabase(page, 'patchDraft', h.key, state === 'corrupted' ? { updatedAt: seeded.input.meta.updatedAt + 1 } : state === 'newer-format' ? { recordVersion: 2 } : {})
      const before = (await readLocalDisk(page, h.key)).draft
      await openReader(page, h.documentId)
      await expect(notice(page).getByText(state === 'expired' ? /(?:超过保留期的本机草稿已清除|本机草稿超过 14 天保留期，已清理)/ : state === 'corrupted' ? '损坏的本机草稿已清除' : /本机修改由更新版本写入/)).toBeVisible()
      expect((await readLocalDisk(page, h.key)).draft).toEqual(state === 'newer-format' ? before : null)
      expect(await revisionOf(h.documentId)).toBe(1)
    })
  }

  test('早期 404 也清理当前身份的原记录', async ({ page }) => {
    const h = await documentFor(page, 'recovery-404')
    await seedRecovery(page, h.key, recoverySnapshot(h.cloud.text, '删除前'))
    await actAs(page, 'DELETE', `/api/documents/${h.documentId}`)
    await page.goto(`/documents/${h.documentId}`)
    await expect(notice(page).getByText('已无法访问这份文档，对应的本机草稿已清除')).toBeVisible()
    expect((await readLocalDisk(page, h.key)).draft).toBeNull()
    expect((await page.request.get(`/api/documents/${h.documentId}`)).status()).toBe(404)
  })

  test('旧钥先刷新再判定，不把新版本原件当作损坏', async ({ page, anotherDevice }) => {
    const h = await documentFor(page, 'recovery-stale-key')
    const stale = await currentLocalKey(page)
    const admin = await createUser('recovery-stale-admin', '吊销管理员', { systemRole: 'admin' })
    await loginThroughApi(anotherDevice, admin)
    await actAs(anotherDevice, 'POST', `/api/admin/users/${h.owner.id}/local-key/revoke`)
    const seeded = await seedRecovery(page, h.key, recoverySnapshot(h.cloud.text, '新钥下的原件'))
    let requests = 0
    await page.route('**/api/local-key', async (route) => {
      requests += 1
      if (requests === 1)
        await route.fulfill({ json: stale })
      else
        await route.continue()
    })
    await openReader(page, h.documentId)
    await expect(notice(page).getByRole('button', { name: '恢复并编辑' })).toBeEnabled()
    expect(requests).toBe(2)
    expect((await readLocalDisk(page, h.key)).draft).toEqual(seeded.disk)
    expect(await revisionOf(h.documentId)).toBe(1)
  })

  test('密钥真实吊销后仅清理已失效的原草稿', async ({ page, anotherDevice }) => {
    const h = await documentFor(page, 'recovery-revoked-key')
    await seedRecovery(page, h.key, recoverySnapshot(h.cloud.text, '旧钥原件'))
    const admin = await createUser('recovery-revoked-admin', '吊销管理员', { systemRole: 'admin' })
    await loginThroughApi(anotherDevice, admin)
    await actAs(anotherDevice, 'POST', `/api/admin/users/${h.owner.id}/local-key/revoke`)
    await openReader(page, h.documentId)
    await expect(notice(page).getByText('密钥失效的本机草稿已清除')).toBeVisible()
    expect((await readLocalDisk(page, h.key)).draft).toBeNull()
    expect(await revisionOf(h.documentId)).toBe(1)
  })

  test('发现后断网保留原件，重新联网仍能恢复', async ({ page, context }) => {
    const h = await documentFor(page, 'recovery-offline')
    const seeded = await seedRecovery(page, h.key, recoverySnapshot(h.cloud.text, '离线保持'))
    await openReader(page, h.documentId)
    const restore = notice(page).getByRole('button', { name: '恢复并编辑' })
    await expect(restore).toBeEnabled()
    await context.setOffline(true)
    await expect(restore).toBeDisabled()
    expect((await readLocalDisk(page, h.key)).draft).toEqual(seeded.disk)
    expect(await revisionOf(h.documentId)).toBe(1)
    await context.setOffline(false)
    await expect(restore).toBeEnabled()
    expect((await readLocalDisk(page, h.key)).draft).toEqual(seeded.disk)
    await restore.click()
    await waitForEditorAccess(page, 'edit')
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(cellOf((await savedContent(page, h.documentId)).snapshot, 'A1')?.v).toBe('离线保持')
    await expect.poll(async () => (await readLocalDisk(page, h.key)).draft).toBeNull()
  })

  test('旧请求核对断网时保留原件，重试确认只发送相同请求', async ({ page }) => {
    const h = await receiptFor(page, 'recovery-unknown-replay')
    const url = `**/api/documents/${h.documentId}/content?**`
    await page.route(url, async route => route.abort('failed'))
    const writes = recordWrites(page, h.documentId)
    await openReader(page, h.documentId)
    await expect(notice(page).getByText(/中断前的保存结果尚未确认/)).toBeVisible()
    expect((await readLocalDisk(page, h.key)).draft).toEqual(h.seeded.disk)
    expect(await revisionOf(h.documentId)).toBe(2)
    await page.unroute(url)
    await notice(page).getByRole('button', { name: '重新检查本机修改' }).click()
    await expect(notice(page).getByText(/中断前的保存已由云端确认/)).toBeVisible()
    expect(writes.saves).toHaveLength(2)
    expect(writes.saves[1]?.url()).toBe(writes.saves[0]?.url())
    expect(writes.saves[1]?.postDataBuffer()).toEqual(h.seeded.gzip)
    expect((await readLocalDisk(page, h.key)).draft).toBeNull()
    expect(await revisionOf(h.documentId)).toBe(2)
  })

  test('换人登录后旧请求成功回包迟到，不清理原用户草稿或启用编辑', async ({ page, context }) => {
    // 先留下真实登录表单；原用户随后经接口准备原件，不产生界面登录广播。
    const other = await context.newPage()
    await other.goto('/login')
    await expect(other.getByRole('form', { name: '登录' })).toBeVisible()
    const h = await receiptFor(page, 'r-late-receipt')
    const someoneElse = await createUser('r-next-account')
    let release!: () => void
    let received = false
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const url = `**/api/documents/${h.documentId}/content?**`
    await page.route(url, async (route) => {
      const response = await route.fetch()
      expect(response.status()).toBe(200)
      received = true
      await held
      await route.fulfill({ response })
    })
    const writes = recordWrites(page, h.documentId)
    try {
      await openReader(page, h.documentId)
      await expect.poll(() => received).toBe(true)
      // 本例验证换人后旧回包；明确退出会主动删除原件，直接真实登录并由产品广播触发复核。
      await loginThroughUi(other, someoneElse)
      await expect(other.getByRole('heading', { name: '我的空间' })).toBeVisible()
      await expect(page.getByRole('alert').filter({ hasText: '别的标签页登录了另一个账户。原来的账户重新登录之后，这一页可以接着使用' })).toBeVisible()
      const delivered = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().includes(`/api/documents/${h.documentId}/content?`))
      release()
      await (await delivered).finished()
      expect((await readLocalDisk(page, h.key)).draft).toEqual(h.seeded.disk)
      expect(await revisionOf(h.documentId)).toBe(2)
      expect(writes.saves).toHaveLength(1)
      await expect(enterEditButton(page)).toBeDisabled()
    }
    finally {
      release()
    }
  })

  test('副本成功回包丢失，重试同一请求得到同一副本后清理', async ({ page }) => {
    const h = await documentFor(page, 'recovery-copy-receipt')
    const seeded = await seedRecovery(page, h.key, recoverySnapshot(h.cloud.text, '只创建一次的副本'))
    await advanceCloud(h, '云端不同内容')
    const sent: Request[] = []
    const ids: string[] = []
    await page.route(`**/api/documents/${h.documentId}/conflict-copies?**`, async (route) => {
      sent.push(route.request())
      const response = await route.fetch()
      const created = await response.json() as { id: string }
      ids.push(created.id)
      if (sent.length === 1)
        await route.abort('failed')
      else
        await route.fulfill({ response })
    })
    await openReader(page, h.documentId)
    await notice(page).getByRole('button', { name: '另存为副本', exact: true }).click()
    const retry = notice(page).getByRole('button', { name: '重试另存为副本' })
    await expect(retry).toBeEnabled()
    expect((await readLocalDisk(page, h.key)).draft).toEqual(seeded.disk)
    await retry.click()
    await expect(notice(page).getByRole('link', { name: '打开副本（新标签页）' })).toBeVisible()
    expect(sent).toHaveLength(2)
    expect(sent[1]?.url()).toBe(sent[0]?.url())
    expect(sent[1]?.postDataBuffer()).toEqual(sent[0]?.postDataBuffer())
    expect(ids).toHaveLength(2)
    expect(ids[1]).toBe(ids[0])
    expect(cellOf((await savedContent(page, ids[0]!)).snapshot, 'A1')?.v).toBe('只创建一次的副本')
    expect(await revisionOf(h.documentId)).toBe(2)
    await expect.poll(async () => (await readLocalDisk(page, h.key)).draft).toBeNull()
  })

  test('部署关闭仍能恢复旧草稿，内存保存确认后条件清理', async ({ page }) => {
    const h = await documentFor(page, 'recovery-disabled')
    await seedRecovery(page, h.key, recoverySnapshot(h.cloud.text, '关闭开关前已落盘'))
    await page.route('**/api/auth/session', async (route) => {
      const response = await route.fetch()
      const body = await response.json() as { features?: object }
      await route.fulfill({ response, json: { ...body, features: { ...body.features, localDraftsEnabled: false } } })
    })
    await openReader(page, h.documentId)
    await notice(page).getByRole('button', { name: '恢复并编辑' }).click()
    await waitForEditorAccess(page, 'edit')
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(cellOf((await savedContent(page, h.documentId)).snapshot, 'A1')?.v).toBe('关闭开关前已落盘')
    await expect.poll(async () => (await readLocalDisk(page, h.key)).draft).toBeNull()
  })

  test('确认丢失且云端后来又更新：精确重放旧请求后显示最新云端', async ({ page }) => {
    const h = await receiptFor(page, 'recovery-receipt')
    await advanceCloud(h, '后来云端版本')
    const writes = recordWrites(page, h.documentId)
    await openReader(page, h.documentId)
    await expect(notice(page).getByText(/中断前的保存已由云端确认/)).toBeVisible()
    await expect.poll(async () => shownCell(page, 'A1')).toBe('后来云端版本')
    expect(writes.saves).toHaveLength(1)
    expect(saveParam(writes.saves[0], 'requestId')).toBe(h.inFlight.requestId)
    expect(writes.saves[0]?.postDataBuffer()).toEqual(h.seeded.gzip)
    expect(writes.saves[0]?.headers()['x-edit-lease']).toBeUndefined()
    expect(await revisionOf(h.documentId)).toBe(3)
    await expect.poll(async () => (await readLocalDisk(page, h.key)).draft).toBeNull()
  })

  test('原文已向前保存但本机有更新捕获，经真实来源快进保存', async ({ page }) => {
    const h = await receiptFor(page, 'recovery-own-revision')
    expect(await probe(page, 'write', { meta: { ...h.seeded.input.meta, draftSeq: 38, updatedAt: Date.now() }, content: recoverySnapshot(h.cloud.text, '捕获的新内容') })).toMatchObject({ kind: 'written' })
    const writes = recordWrites(page, h.documentId)
    await openReader(page, h.documentId)
    await notice(page).getByRole('button', { name: '恢复并编辑' }).click()
    await waitForEditorAccess(page, 'edit')
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(cellOf((await savedContent(page, h.documentId)).snapshot, 'A1')?.v).toBe('捕获的新内容')
    expect(Number(saveParam(writes.saves.at(-1), 'localSeq'))).toBeGreaterThan(38)
    expect(await revisionOf(h.documentId)).toBe(3)
    await expect.poll(async () => (await readLocalDisk(page, h.key)).draft).toBeNull()
  })
})
