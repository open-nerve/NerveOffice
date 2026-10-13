// M4-P3 S5：新页面先阅读，明确恢复采用新身份。旧版记号仅作为迁移/副本隔离反例夹具。
import type { BrowserContext, Dialog, Locator, Page, Request, Route } from '@playwright/test'
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
import { cellOf, createSheetThroughApi, EDITOR_TEST_TIMEOUT, openAndEnterEditing, savedContent, saveStatus, takeOverHereButton, typeInCell, waitForEditorAccess } from '../../support/sheet.ts'

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

function recordAcquires(page: Page | BrowserContext, documentId: string) {
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
  expect(await markerOf(page, h.key)).toBeNull()
  expect(await revisionOf(h.documentId)).toBe(1)
  const marker: Marker = { v: 1, ...h.key, clientInstanceId: disk.writtenBy, writeEpoch: disk.writeEpoch, writerId: disk.writerId }
  return { ...h, disk, marker }
}

/** 旧版本遗留记号夹具：历史地址设为目标，随后真实导航；不伪造 navigation.type 或跳过恢复入口。 */
async function readySeededReload(page: Page, key: DraftKey, disk: DiskDraft, changes: Partial<Marker> = {}): Promise<void> {
  const marker: Marker = { v: 1, ...key, clientInstanceId: disk.writtenBy, writeEpoch: disk.writeEpoch, writerId: disk.writerId, ...changes }
  await page.evaluate(({ storageKey, marker, documentId }) => {
    sessionStorage.setItem(storageKey, JSON.stringify(marker))
    history.replaceState(null, '', `/documents/${documentId}`)
  }, { storageKey: markerKey(key), marker, documentId: key.documentId })
}

/** 只选界面实际提供的明确入口；持久恢复仍经过原有租约与文档锁。 */
async function confirmRecovery(page: Page): Promise<'restore' | 'takeover-self'> {
  const restore = page.locator('[data-slot="recovery-notice"]').getByRole('button', { name: '恢复并编辑', exact: true })
  const takeover = takeOverHereButton(page)
  const enabled = async (button: Locator): Promise<boolean> => await button.isVisible() && await button.isEnabled()
  await expect.poll(async () => await enabled(restore) || await enabled(takeover)).toBe(true)
  if (await enabled(restore)) {
    await restore.click()
    return 'restore'
  }
  await expect(page.locator('[data-slot="recovery-notice"]').getByRole('button', { name: '另存为副本', exact: true })).toBeEnabled()
  await takeover.click()
  return 'takeover-self'
}

async function blockedNavigation(page: Page, documentId: string, navigation: 'reload' | 'navigate'): Promise<void> {
  if (navigation === 'reload')
    await page.reload({ waitUntil: 'commit' })
  else
    await page.goto(`/documents/${documentId}`, { waitUntil: 'commit' })
}

test.describe('US-M4-04 新页面明确恢复与副本隔离', { tag: '@test-build' }, () => {
  test.use({ autosave: 'running' })

  for (const disabled of [false, true]) {
    test(`真实刷新先阅读，确认后以新身份恢复正文并同步（本机能力关闭：${disabled}）`, async ({ page }) => {
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
      await waitForEditorAccess(page, 'read', 'steady')
      expect(acquires).toHaveLength(0)
      expect(writes.saves).toHaveLength(0)
      expect((await readLocalDisk(page, h.key)).draft).toEqual(h.disk)
      const entry = await confirmRecovery(page)
      await waitForEditorAccess(page, 'edit')
      await expect(saveStatus(page)).toHaveText('已保存到云端')
      expect(acquires).toHaveLength(1)
      expect(acquires[0]?.clientInstanceId).not.toBe(h.disk.writtenBy)
      expect(acquires[0]?.takeover).toBe(entry === 'restore' ? undefined : 'self')
      expect(writes.saves).toHaveLength(1)
      expect(saveParam(writes.saves[0], 'clientInstanceId')).toBe(acquires[0]?.clientInstanceId)
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
    await readySeededReload(page, h.key, h.disk)
    const acquires = recordAcquires(page, h.documentId)
    await reload(page)
    await waitForEditorAccess(page, 'read', 'steady')
    expect(acquires).toHaveLength(0)
    expect(await markerOf(page, h.key)).toBeNull()
    expect(await shownCell(page, 'A1')).toBe('刷新前真正落盘的修改')
  })

  for (const failedNavigation of [false, true]) {
    test(`真实 opener 副本继承旧版记号后先普通导航（正文失败：${failedNavigation}），原页关闭后刷新也不冒充`, async ({ page, context }) => {
      const h = await actualDraft(page, `reload-clone-${failedNavigation}`)
      await readySeededReload(page, h.key, h.disk)
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

  for (const navigation of ['reload', 'navigate'] as const) {
    test(`副本首段产品脚本尚未运行，原页关闭后 ${navigation} 仍先阅读，明确恢复才申请`, async ({ page, context }, testInfo) => {
      const h = await actualDraft(page, `clone-before-${navigation}`)
      await readySeededReload(page, h.key, h.disk)
      const acquires = recordAcquires(context, h.documentId)
      const saves: Request[] = []
      context.on('request', (request) => {
        if (request.method() === 'PUT' && new URL(request.url()).pathname === `/api/documents/${h.documentId}/content`)
          saves.push(request)
      })
      let generation = 0
      let allowed = false
      const held: { readonly route: Route, readonly generation: number }[] = []
      await context.route('**/*', async (route) => {
        const request = route.request()
        // 首个导航请求到达时 frame 尚未创建；先数 Document 导航，仅脚本请求读取所属页面。
        if (request.isNavigationRequest()) {
          if (new URL(request.url()).pathname === `/documents/${h.documentId}`)
            generation += 1
          await route.continue()
          return
        }
        if (request.resourceType() === 'script' && request.frame().page() !== page && !allowed) {
          held.push({ route, generation })
          return
        }
        await route.continue()
      })
      try {
        const popup = page.waitForEvent('popup')
        await page.evaluate(() => {
          window.open(location.href, '_blank')
        })
        const copy = await popup
        await expect.poll(() => held.some(item => item.generation === 1)).toBe(true)
        expect(await copy.evaluate(() => window.__nerveEditorProbe === undefined)).toBe(true)
        expect(await markerOf(copy, h.key)).toEqual(h.marker)
        await page.close()
        await blockedNavigation(copy, h.documentId, navigation)
        await expect.poll(() => held.some(item => item.generation === 2)).toBe(true)
        expect(generation).toBe(2)
        expect(await copy.evaluate(() => window.__nerveEditorProbe === undefined)).toBe(true)
        expect(await markerOf(copy, h.key)).toEqual(h.marker)
        const facts = await copy.evaluate(() => ({ type: (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).type, opener: window.opener !== null }))
        expect(facts.type).toBe(navigation)
        await testInfo.attach('copy-before-first-product-script', { body: JSON.stringify({ navigation: facts, originalClosed: page.isClosed(), inheritedLegacyMarker: h.marker, heldScripts: held.map(item => ({ generation: item.generation })) }), contentType: 'application/json' })
        // 仅第二个 Document 的脚本放行，旧请求从未获得脚本正文。
        allowed = true
        for (const item of held.filter(item => item.generation === 2))
          await item.route.continue()
        await waitForEditorAccess(copy, 'read', 'steady')
        expect(acquires).toHaveLength(0)
        expect(saves).toHaveLength(0)
        expect(await revisionOf(h.documentId)).toBe(1)
        expect((await readLocalDisk(copy, h.key)).draft).toEqual(h.disk)
        expect(await markerOf(copy, h.key)).toBeNull()
        const entry = await confirmRecovery(copy)
        await waitForEditorAccess(copy, 'edit')
        await expect(saveStatus(copy)).toHaveText('已保存到云端')
        expect(acquires).toHaveLength(1)
        expect(acquires[0]?.clientInstanceId).not.toBe(h.disk.writtenBy)
        expect(acquires[0]?.takeover).toBe(entry === 'restore' ? undefined : 'self')
        expect(saves).toHaveLength(1)
        const cloud = await savedContent(copy, h.documentId)
        expect(cloud.revision).toBe(2)
        expect(cellOf(cloud.snapshot, 'A1')?.v).toBe('刷新前真正落盘的修改')
      }
      finally {
        await Promise.allSettled(held.filter(item => item.generation === 1).map(async item => item.route.abort('aborted')))
      }
    })
  }

  test('另一活页仍在编辑，继承同一旧记号刷新也不自动申请或抢文档锁', async ({ page, context }) => {
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

  test('阅读发现旧钥时刷新密钥，明确确认后恢复新钥原件', async ({ page, anotherDevice }) => {
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
    await waitForEditorAccess(page, 'read', 'steady')
    expect(acquires).toHaveLength(0)
    await confirmRecovery(page)
    await waitForEditorAccess(page, 'edit')
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(keys).toBeGreaterThanOrEqual(2)
    expect(acquires).toHaveLength(1)
    expect(acquires[0]?.clientInstanceId).not.toBe(seeded.disk.writtenBy)
    expect(acquires[0]?.takeover).toBeUndefined()
    expect(cellOf((await savedContent(page, h.documentId)).snapshot, 'A1')?.v).toBe('新钥的重载原件')
  })

  test('明确申请期间原件被另一写入者替换，恢复核对阻止进入且保留新原件', async ({ page, context }) => {
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
    expect(acquires).toHaveLength(0)
    await confirmRecovery(page)
    await waitForEditorAccess(page, 'read', 'steady')
    expect(acquires).toHaveLength(1)
    expect(acquires[0]?.takeover).toBeUndefined()
    expect(writes.saves).toHaveLength(0)
    expect(await revisionOf(h.documentId)).toBe(1)
    expect(replacement).toBeDefined()
    expect((await readLocalDisk(page, h.key)).draft).toEqual(replacement)
  })

  test('US-M4-05 旧请求已成功但回执丢失，阅读时核对回执与最新云端，不申请编辑或新增修订', async ({ page }) => {
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
    expect(acquires).toHaveLength(0)
    await expect.poll(async () => shownCell(page, 'A1')).toBe('后来的云端内容')
    expect(writes.saves).toHaveLength(1)
    expect(saveParam(writes.saves[0], 'requestId')).toBe(inFlight.requestId)
    expect(await revisionOf(h.documentId)).toBe(3)
    await expect.poll(async () => (await readLocalDisk(page, h.key)).draft).toBeNull()
  })

  test('US-M4-14 回收标志的否定校准：注入 wasDiscarded 也不能自动沿用旧身份（不替代崩溃证据）', async ({ page }) => {
    const h = await documentFor(page, 'reload-discarded-fact')
    const seeded = await seedRecovery(page, h.key, recoverySnapshot(h.cloud.text, '回收前的原件'))
    await readySeededReload(page, h.key, seeded.disk)
    await page.addInitScript(() => {
      Object.defineProperty(document, 'wasDiscarded', { configurable: true, value: true })
    })
    const acquires = recordAcquires(page, h.documentId)
    await page.goto(`/documents/${h.documentId}`)
    await waitForEditorAccess(page, 'read', 'steady')
    expect(acquires).toHaveLength(0)
    expect((await readLocalDisk(page, h.key)).draft).toEqual(seeded.disk)
    await confirmRecovery(page)
    await waitForEditorAccess(page, 'edit')
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(acquires).toHaveLength(1)
    expect(acquires[0]?.clientInstanceId).not.toBe(seeded.disk.writtenBy)
    expect(acquires[0]?.takeover).toBeUndefined()
    expect(cellOf((await savedContent(page, h.documentId)).snapshot, 'A1')?.v).toBe('回收前的原件')
  })

  test('明确申请成功回包尚在途时换人，迟到结果不启用编辑、不清原用户原件', async ({ page, context }) => {
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
      await waitForEditorAccess(page, 'read', 'steady')
      await confirmRecovery(page)
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
