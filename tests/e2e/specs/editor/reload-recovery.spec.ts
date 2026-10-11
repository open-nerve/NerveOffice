// M4-P3 S4：真实页面落盘/刷新与浏览器实例锁；夹具只为少见的原件分支准备合法密文。
import type { Dialog, Page } from '@playwright/test'
import type { DiskDraft } from '../../support/local-draft.ts'
import type { DraftKey } from '../../support/outbox-probe.ts'
import type { Workbook } from '../../support/sheet.ts'
import { randomUUID } from 'node:crypto'
import { acquiredEditLeaseSchema } from '@nerve-office/contracts'
import { holdAutosave, recordWrites, saveParam } from '../../support/autosave.ts'
import { CURRENT_CLIENT } from '../../support/client-format.ts'
import { createUser, revisionOf, writeVersion } from '../../support/database.ts'
import { shownCell } from '../../support/editor-probe.ts'
import { e2eOrigin } from '../../support/environment.ts'
import { expect, test } from '../../support/fixtures.ts'
import { currentLocalKey, diskSnapshot, readLocalDisk } from '../../support/local-draft.ts'
import { recoverySnapshot, seedRecovery } from '../../support/local-recovery.ts'
import { openOutboxProbe, probe } from '../../support/outbox-probe.ts'
import { actAs, loginThroughApi } from '../../support/session.ts'
import { cellOf, createSheetThroughApi, EDITOR_TEST_TIMEOUT, openAndEnterEditing, savedContent, saveStatus, typeInCell, waitForEditorAccess } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

interface Marker extends DraftKey {
  readonly v: number
  readonly clientInstanceId: string
  readonly writeEpoch: number
  readonly writerId: string
}

function markerKey(key: DraftKey): string {
  return `nerve-office:reload:${key.userId}:${key.documentId}`
}

async function markerOf(page: Page, key: DraftKey): Promise<Marker | null> {
  return page.evaluate(key => JSON.parse(sessionStorage.getItem(key) ?? 'null') as Marker | null, markerKey(key))
}

function recordAcquires(page: Page, documentId: string) {
  const requests: { readonly clientInstanceId: string, readonly takeover?: string }[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/documents/${documentId}/edit-lease`)
      requests.push(request.postDataJSON() as { readonly clientInstanceId: string, readonly takeover?: string })
  })
  return requests
}

async function reload(page: Page): Promise<void> {
  const accept = async (dialog: Dialog): Promise<void> => dialog.accept()
  page.on('dialog', accept)
  try {
    await page.reload()
  }
  finally {
    page.off('dialog', accept)
  }
}

async function documentFor(page: Page, prefix: string) {
  const owner = await createUser(prefix)
  await loginThroughApi(page, owner)
  const documentId = await createSheetThroughApi(page)
  return { owner, documentId, key: { userId: owner.id, documentId }, cloud: await savedContent(page, documentId) }
}

async function actualDraft(page: Page, prefix: string) {
  const h = await documentFor(page, prefix)
  await openAndEnterEditing(page, h.documentId)
  // 只暂停这一代的定时上传；捕获、生产 Worker 和 IndexedDB 照常。刷新后由 running 夹具恢复生产节奏。
  await holdAutosave(page)
  const secret = await currentLocalKey(page)
  await typeInCell(page, 'A1', '刷新前真正落盘的修改')
  await expect.poll(async () => {
    const draft = (await readLocalDisk(page, h.key)).draft
    return draft === null ? undefined : cellOf(JSON.parse(diskSnapshot(draft, secret)) as Workbook, 'A1')?.v
  }).toBe('刷新前真正落盘的修改')
  const disk = (await readLocalDisk(page, h.key)).draft!
  await expect.poll(async () => markerOf(page, h.key)).toEqual({ v: 1, ...h.key, clientInstanceId: disk.writtenBy, writeEpoch: disk.writeEpoch, writerId: disk.writerId })
  expect(await revisionOf(h.documentId)).toBe(1)
  return { ...h, disk, marker: (await markerOf(page, h.key))! }
}

/** 罕见原件的断点夹具：历史地址设为目标，随后真正 reload；不伪造 navigation.type 或跳过页面恢复入口。 */
async function readySeededReload(page: Page, key: DraftKey, disk: DiskDraft, changes: Partial<Marker> = {}): Promise<void> {
  const marker: Marker = { v: 1, ...key, clientInstanceId: disk.writtenBy, writeEpoch: disk.writeEpoch, writerId: disk.writerId, ...changes }
  await page.evaluate(({ storageKey, marker, documentId }) => {
    sessionStorage.setItem(storageKey, JSON.stringify(marker))
    history.replaceState(null, '', `/documents/${documentId}`)
  }, { storageKey: markerKey(key), marker, documentId: key.documentId })
}

test.describe('US-M4-04 原标签页自动重载', { tag: '@test-build' }, () => {
  test.use({ autosave: 'running' })

  for (const disabled of [false, true]) {
    test(`真实刷新以原实例普通申请，零次额外输入恢复正文并同步（本机能力关闭：${disabled}）`, async ({ page }) => {
      const h = await actualDraft(page, `reload-real-${disabled}`)
      await page.route('**/api/auth/session', async (route) => {
        if (disabled) {
          const response = await route.fetch()
          const body = await response.json() as { features?: object }
          await route.fulfill({ response, json: { ...body, features: { ...body.features, localDraftsEnabled: false } } })
        }
        else {
          await route.continue()
        }
      })
      const acquires = recordAcquires(page, h.documentId)
      const writes = recordWrites(page, h.documentId)
      await reload(page)
      await waitForEditorAccess(page, 'edit')
      await expect(saveStatus(page)).toHaveText('已保存到云端')
      expect(acquires).toHaveLength(1)
      expect(acquires[0]?.clientInstanceId).toBe(h.marker.clientInstanceId)
      expect(acquires[0]?.takeover).toBeUndefined()
      expect(writes.saves).toHaveLength(1)
      expect(saveParam(writes.saves[0], 'clientInstanceId')).toBe(h.marker.clientInstanceId)
      const cloud = await savedContent(page, h.documentId)
      expect(cloud.revision).toBe(2)
      expect(cellOf(cloud.snapshot, 'A1')?.v).toBe('刷新前真正落盘的修改')
      await expect.poll(async () => (await readLocalDisk(page, h.key)).draft).toBeNull()
    })
  }

  test('云端已确认且本机无原件，刷新保持阅读，不因残留记号普通申请', async ({ page }) => {
    const h = await actualDraft(page, 'reload-no-draft')
    await page.locator('#editor-chrome').getByRole('button', { name: '保存', exact: true }).click()
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    await expect.poll(async () => (await readLocalDisk(page, h.key)).draft).toBeNull()
    const acquires = recordAcquires(page, h.documentId)
    await reload(page)
    await waitForEditorAccess(page, 'read', 'steady')
    expect(acquires).toHaveLength(0)
    expect(await markerOf(page, h.key)).toBeNull()
    expect(await shownCell(page, 'A1')).toBe('刷新前真正落盘的修改')
  })

  for (const failedNavigation of [false, true]) {
    test(`真实复制标签页先普通导航（正文失败：${failedNavigation}），原页关闭后刷新也不冒充`, async ({ page, context }) => {
      const h = await actualDraft(page, `reload-clone-${failedNavigation}`)
      let gotContent = false
      await context.route(`**/api/documents/${h.documentId}/content`, async (route) => {
        if (failedNavigation && route.request().method() === 'GET')
          await route.abort('failed')
        else
          await route.continue()
        gotContent = true
      }, { times: 1 })
      // window.open 确实继承 opener 的 sessionStorage；入口脚本之前被动记录，不人工写回记号。
      await context.addInitScript((key) => {
        Object.assign(window, { __inheritedReload: sessionStorage.getItem(key) })
      }, markerKey(h.key))
      const opened = page.waitForEvent('popup')
      await page.evaluate(() => {
        window.open(location.href, '_blank')
      })
      const copy = await opened
      const acquires = recordAcquires(copy, h.documentId)
      await expect.poll(async () => copy.evaluate(() => (window as typeof window & { __inheritedReload?: string }).__inheritedReload ?? null)).toBe(JSON.stringify(h.marker))
      await expect.poll(async () => markerOf(copy, h.key)).toBeNull()
      await expect.poll(() => gotContent).toBe(true)
      await page.close()
      await reload(copy)
      await waitForEditorAccess(copy, 'read', 'steady')
      expect(acquires).toHaveLength(0)
      expect(await revisionOf(h.documentId)).toBe(1)
      const restore = copy.locator('[data-slot="recovery-notice"]').getByRole('button', { name: '恢复并编辑' })
      await expect(restore).toBeEnabled()
      await restore.click()
      await waitForEditorAccess(copy, 'edit')
      await expect(saveStatus(copy)).toHaveText('已保存到云端')
      expect(acquires.at(-1)?.clientInstanceId).not.toBe(h.marker.clientInstanceId)
      expect(cellOf((await savedContent(copy, h.documentId)).snapshot, 'A1')?.v).toBe('刷新前真正落盘的修改')
    })
  }

  test('另一活页仍持实例锁，带同一候选刷新也不自动申请或偷锁', async ({ page, context }) => {
    const h = await actualDraft(page, 'reload-live-instance')
    const other = await context.newPage()
    await other.goto(`/documents/${h.documentId}`)
    await waitForEditorAccess(other, 'read')
    await readySeededReload(other, h.key, h.disk)
    const acquires = recordAcquires(other, h.documentId)
    await reload(other)
    await waitForEditorAccess(other, 'read', 'steady')
    expect(acquires).toHaveLength(0)
    expect(await markerOf(other, h.key)).toBeNull()
    await waitForEditorAccess(page, 'edit')
    expect((await readLocalDisk(other, h.key)).draft).toEqual(h.disk)
  })

  for (const field of ['userId', 'documentId', 'writerId', 'clientInstanceId'] as const) {
    test(`候选 ${field} 不匹配，保持阅读并保留原件供显式处理`, async ({ page }) => {
      const h = await documentFor(page, `reload-${field.toLowerCase()}`)
      const seeded = await seedRecovery(page, h.key, recoverySnapshot(h.cloud.text, '只能明确恢复的原件'))
      await readySeededReload(page, h.key, seeded.disk, { [field]: randomUUID() })
      const acquires = recordAcquires(page, h.documentId)
      await reload(page)
      await waitForEditorAccess(page, 'read', 'steady')
      expect(acquires).toHaveLength(0)
      expect(await markerOf(page, h.key)).toBeNull()
      expect((await readLocalDisk(page, h.key)).draft).toEqual(seeded.disk)
      await expect(page.locator('[data-slot="recovery-notice"]').getByRole('button', { name: '恢复并编辑' })).toBeEnabled()
    })
  }

  test('预检旧钥只刷新后再确认，新钥原件自动恢复', async ({ page, anotherDevice }) => {
    const h = await documentFor(page, 'reload-stale-key')
    const stale = await currentLocalKey(page)
    await loginThroughApi(anotherDevice, await createUser('reload-key-admin', '密钥管理员', { systemRole: 'admin' }))
    await actAs(anotherDevice, 'POST', `/api/admin/users/${h.owner.id}/local-key/revoke`)
    const seeded = await seedRecovery(page, h.key, recoverySnapshot(h.cloud.text, '新钥的重载原件'))
    await readySeededReload(page, h.key, seeded.disk)
    let keys = 0
    await page.route('**/api/local-key', async (route) => {
      keys += 1
      if (keys === 1)
        await route.fulfill({ json: stale })
      else
        await route.continue()
    })
    const acquires = recordAcquires(page, h.documentId)
    await reload(page)
    await waitForEditorAccess(page, 'edit')
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(keys).toBeGreaterThanOrEqual(2)
    expect(acquires).toHaveLength(1)
    expect(acquires[0]?.clientInstanceId).toBe(seeded.disk.writtenBy)
    expect(acquires[0]?.takeover).toBeUndefined()
    expect(cellOf((await savedContent(page, h.documentId)).snapshot, 'A1')?.v).toBe('新钥的重载原件')
  })

  test('预检之后原件被另一写入者替换，第二次核对阻止自动进入且保留新原件', async ({ page, context }) => {
    const h = await documentFor(page, 'reload-replaced')
    const seeded = await seedRecovery(page, h.key, recoverySnapshot(h.cloud.text, '原候选正文'))
    await readySeededReload(page, h.key, seeded.disk)
    const other = await context.newPage()
    let replacement: DiskDraft | undefined
    await page.route(`**/api/documents/${h.documentId}/edit-lease`, async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue()
        return
      }
      const response = await route.fetch()
      const acquired = acquiredEditLeaseSchema.parse(await response.json())
      await openOutboxProbe(other)
      expect(await probe(other, 'remove', h.key, seeded.disk.draftSeq)).toMatchObject({ kind: 'removed' })
      replacement = (await seedRecovery(other, h.key, recoverySnapshot(h.cloud.text, '另一写入者的新原件'), { writeEpoch: acquired.writeEpoch + 1, draftSeq: seeded.disk.draftSeq + 1 })).disk
      await route.fulfill({ response })
    })
    const acquires = recordAcquires(page, h.documentId)
    const writes = recordWrites(page, h.documentId)
    await reload(page)
    await waitForEditorAccess(page, 'read', 'steady')
    expect(acquires).toHaveLength(1)
    expect(acquires[0]?.takeover).toBeUndefined()
    expect(writes.saves).toHaveLength(0)
    expect(await revisionOf(h.documentId)).toBe(1)
    expect(replacement).toBeDefined()
    expect((await readLocalDisk(page, h.key)).draft).toEqual(replacement)
  })

  test('US-M4-05 旧请求已成功但回执丢失，自动核对后显示最新云端并回阅读，不再次空白进入', async ({ page }) => {
    const h = await documentFor(page, 'reload-confirmed')
    const { csrfToken } = await (await page.request.get('/api/auth/session')).json() as { csrfToken: string }
    const headers = { 'origin': e2eOrigin(), 'x-csrf-token': csrfToken }
    const clientInstanceId = randomUUID()
    const response = await page.request.post(`/api/documents/${h.documentId}/edit-lease`, { headers, data: { ...CURRENT_CLIENT, clientInstanceId } })
    const lease = acquiredEditLeaseSchema.parse(await response.json())
    const inFlight = { requestId: randomUUID(), clientInstanceId, localSeq: 37, sentAt: Date.now() }
    const seeded = await seedRecovery(page, h.key, recoverySnapshot(h.cloud.text, '已保存的旧请求'), { writtenBy: clientInstanceId, inFlight, writeEpoch: lease.writeEpoch })
    const query = new URLSearchParams({ ...CURRENT_CLIENT, formatVersion: String(CURRENT_CLIENT.formatVersion), baseRevision: '1', requestId: inFlight.requestId, clientInstanceId, localSeq: '37', writeEpoch: String(lease.writeEpoch), formulasPending: 'false' })
    expect((await page.request.put(`/api/documents/${h.documentId}/content?${query}`, { headers: { ...headers, 'x-edit-lease': lease.token, 'content-type': 'application/gzip' }, data: seeded.gzip })).status()).toBe(200)
    expect((await page.request.delete(`/api/documents/${h.documentId}/edit-lease`, { headers: { ...headers, 'x-edit-lease': lease.token } })).ok()).toBe(true)
    await writeVersion(h.documentId, h.owner, (book) => {
      Object.assign(book, JSON.parse(recoverySnapshot(JSON.stringify(book), '后来的云端内容')) as Record<string, unknown>)
    })
    await readySeededReload(page, h.key, seeded.disk)
    const acquires = recordAcquires(page, h.documentId)
    const writes = recordWrites(page, h.documentId)
    await reload(page)
    await waitForEditorAccess(page, 'read', 'steady')
    expect(acquires).toHaveLength(1)
    expect(acquires[0]?.takeover).toBeUndefined()
    expect(await shownCell(page, 'A1')).toBe('后来的云端内容')
    expect(writes.saves).toHaveLength(1)
    expect(saveParam(writes.saves[0], 'requestId')).toBe(inFlight.requestId)
    expect(await revisionOf(h.documentId)).toBe(3)
    await expect.poll(async () => (await readLocalDisk(page, h.key)).draft).toBeNull()
  })

  test('US-M4-14 回收事实以测试注入校准：普通导航带 wasDiscarded 才保留合格原身份（不替代崩溃证据）', async ({ page }) => {
    const h = await documentFor(page, 'reload-discarded-fact')
    const seeded = await seedRecovery(page, h.key, recoverySnapshot(h.cloud.text, '回收前的原件'))
    await readySeededReload(page, h.key, seeded.disk)
    await page.addInitScript(() => {
      Object.defineProperty(document, 'wasDiscarded', { configurable: true, value: true })
    })
    const acquires = recordAcquires(page, h.documentId)
    await page.goto(`/documents/${h.documentId}`)
    await waitForEditorAccess(page, 'edit')
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(acquires).toHaveLength(1)
    expect(acquires[0]?.clientInstanceId).toBe(seeded.disk.writtenBy)
    expect(acquires[0]?.takeover).toBeUndefined()
    expect(cellOf((await savedContent(page, h.documentId)).snapshot, 'A1')?.v).toBe('回收前的原件')
  })

  test('自动申请成功回包尚在途时换人，迟到结果不启用编辑、不清原用户原件', async ({ page, context }) => {
    const h = await documentFor(page, 'reload-late-acquire')
    const seeded = await seedRecovery(page, h.key, recoverySnapshot(h.cloud.text, '原用户尚未同步'))
    await readySeededReload(page, h.key, seeded.disk)
    const someoneElse = await createUser('reload-next-user')
    const other = await context.newPage()
    await other.goto('/')
    await other.getByRole('button', { name: '退出', exact: true }).focus()
    let release!: () => void
    let received = false
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route(`**/api/documents/${h.documentId}/edit-lease`, async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue()
        return
      }
      const response = await route.fetch()
      expect(response.status()).toBe(201)
      received = true
      await held
      await route.fulfill({ response })
    })
    const writes = recordWrites(page, h.documentId)
    try {
      await reload(page)
      await expect.poll(() => received).toBe(true)
      // 平台页预先就绪；沿真实时钟提交表单，并确认扣住的同一申请收到 201、没有先超时。
      await other.keyboard.press('Enter')
      await expect(other.getByRole('form', { name: '登录' })).toBeVisible()
      await other.getByLabel('用户名').fill(someoneElse.username)
      await other.getByLabel('密码').fill(someoneElse.password)
      await other.getByLabel('密码').press('Enter')
      await expect(other.getByRole('heading', { name: '我的空间' })).toBeVisible()
      await expect(page.getByRole('alert').filter({ hasText: '别的标签页登录了另一个账户' })).toBeVisible()
      const delivered = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/api/documents/${h.documentId}/edit-lease`))
      release()
      const response = await delivered
      expect(response.status()).toBe(201)
      expect(await response.finished()).toBeNull()
      await waitForEditorAccess(page, 'read', 'steady')
      expect(writes.saves).toHaveLength(0)
      expect((await readLocalDisk(page, h.key)).draft).toEqual(seeded.disk)
      expect(await markerOf(page, h.key)).toBeNull()
      expect(await revisionOf(h.documentId)).toBe(1)
    }
    finally {
      release()
    }
  })
})
