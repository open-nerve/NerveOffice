// M4-P2 S4：真实页面、生产来源、真实 Worker/IDB、真实服务端保存。
// 只读磁盘观察和网络交错，不使用 outbox probe 的工厂替代产品接线。
import type { Page, Request } from '@playwright/test'
import type { Workbook } from '../../support/sheet.ts'
import { autosaveLog, capturesOf, holdSaves, recordWrites, saveParam, uploadedText } from '../../support/autosave.ts'
import { archiveSpace, createDocumentIn, createTeamSpace, createUser, revisionOf } from '../../support/database.ts'
import { setCellValue } from '../../support/editor-probe.ts'
import { expect, test } from '../../support/fixtures.ts'
import { currentLocalKey, diskSnapshot, localSaveOrder, observeLocalSaveOrder, readLocalDisk } from '../../support/local-draft.ts'
import { actAs, loginThroughApi } from '../../support/session.ts'
import { cellOf, createSheetThroughApi, EDITOR_TEST_TIMEOUT, enterEditing, exitEditing, lostNotice, openAndEnterEditing, saveAndWait, saveButton, savedContent, saveStatus, waitForEditorAccess } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

async function openLocalSheet(page: Page, prefix: string) {
  const owner = await createUser(prefix)
  await loginThroughApi(page, owner)
  const documentId = await createSheetThroughApi(page)
  await openAndEnterEditing(page, documentId)
  return { owner, documentId, key: { userId: owner.id, documentId } }
}

function valueAt(text: string, cell = 'A1'): unknown {
  return cellOf(JSON.parse(text) as Workbook, cell)?.v
}

test.describe('US-M4-01 本地优先的真实页面链路', { tag: '@test-build' }, () => {
  test('正文写成但在途标记写满：页面公开同步进度限制，仍上传原正文，确认后解除', async ({ page }) => {
    await observeLocalSaveOrder(page)
    await page.route('**/assets/outbox.worker-*.js', async (route) => {
      const response = await route.fetch()
      const fault = `const put = IDBObjectStore.prototype.put; let failed = false; IDBObjectStore.prototype.put = function (...args) { if (!failed && this.name === 'drafts' && args[0]?.inFlight != null) { failed = true; throw new DOMException('测试在途标记写满', 'QuotaExceededError'); } return Reflect.apply(put, this, args); };`
      await route.fulfill({ response, body: `${fault}\n${await response.text()}` })
    })
    const { documentId, key } = await openLocalSheet(page, 'local-mark-quota')
    const secret = await currentLocalKey(page)
    const held = await holdSaves(page)
    try {
      await setCellValue(page, 'A1', '正文已经落盘')
      await saveButton(page).click()
      await expect.poll(held.held).toBe(1)
      expect(await localSaveOrder(page)).toContain('mark-in-flight:quota')
      const disk = (await readLocalDisk(page, key)).draft!
      expect(disk.inFlight).toBeNull()
      expect(valueAt(diskSnapshot(disk, secret))).toBe('正文已经落盘')
      const local = page.locator('[data-slot="local-save-status"]')
      await expect(local.locator('summary')).toHaveText('已保存在本机（等待同步）')
      await local.locator('summary').click()
      await expect(local.getByText('本机存储空间不足，同步进度未能写入本机。', { exact: true })).toBeVisible()
      held.release()
      await expect(saveStatus(page)).toHaveText('已保存到云端')
      await expect(local).not.toContainText('同步进度未能')
      expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('正文已经落盘')
    }
    finally {
      held.release()
    }
  })

  test('A 确认时 B 的同步进度重封写满：保留 B 的正文并显示限制，新保存真正重写后解除', async ({ page }) => {
    await page.route('**/assets/outbox.worker-*.js', async (route) => {
      const response = await route.fetch()
      const fault = `const put = IDBObjectStore.prototype.put; let failed = false; IDBObjectStore.prototype.put = function (...args) { if (!failed && this.name === 'drafts' && args[0]?.baseRevision > 1 && args[0]?.inFlight === null) { failed = true; throw new DOMException('测试确认重封写满', 'QuotaExceededError'); } return Reflect.apply(put, this, args); };`
      await route.fulfill({ response, body: `${fault}\n${await response.text()}` })
    })
    const { documentId, key } = await openLocalSheet(page, 'local-confirm-quota')
    const secret = await currentLocalKey(page)
    const held = await holdSaves(page)
    try {
      await setCellValue(page, 'A1', '上传 A')
      await saveButton(page).click()
      await expect.poll(held.held).toBe(1)
      const first = (await readLocalDisk(page, key)).draft!
      await setCellValue(page, 'A1', '新输入 B')
      await expect.poll(async () => (await readLocalDisk(page, key)).draft?.draftSeq).toBeGreaterThan(first.draftSeq)
      held.release()
      const local = page.locator('[data-slot="local-save-status"]')
      await local.locator('summary').click()
      await expect(local.getByText('本机存储空间不足，同步进度未能写入本机。', { exact: true })).toBeVisible()
      await expect(local.locator('summary')).toHaveText('已保存在本机（等待同步）')
      const disk = (await readLocalDisk(page, key)).draft!
      expect(disk).toMatchObject({ baseRevision: 1, inFlight: first.inFlight })
      expect(valueAt(diskSnapshot(disk, secret))).toBe('新输入 B')
      await saveAndWait(page)
      await expect(local).not.toContainText('同步进度未能')
      expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('新输入 B')
    }
    finally {
      held.release()
    }
  })

  test('先落盘和标记在途再发 HTTP；上传 A 时捕获 B，A 回包只改 B 的基准，不删新行', async ({ page }) => {
    await observeLocalSaveOrder(page)
    const workers: string[] = []
    page.on('worker', worker => workers.push(worker.url()))
    const { documentId, key } = await openLocalSheet(page, 'local-first-order')
    const secret = await currentLocalKey(page)
    const writes = recordWrites(page, documentId)
    const held = await holdSaves(page)
    try {
      await setCellValue(page, 'A1', '上传 A')
      await saveButton(page).click()
      await expect.poll(held.held).toBe(1)
      const order = await localSaveOrder(page)
      expect(order.indexOf('write:written')).toBeGreaterThanOrEqual(0)
      expect(order.indexOf('mark-in-flight:resealed')).toBeGreaterThan(order.indexOf('write:written'))
      expect(order.indexOf('http:save')).toBeGreaterThan(order.indexOf('mark-in-flight:resealed'))
      const first = (await readLocalDisk(page, key)).draft!
      expect(first).toMatchObject({ baseRevision: 1, inFlight: { requestId: saveParam(writes.saves[0], 'requestId'), localSeq: Number(saveParam(writes.saves[0], 'localSeq')) } })
      expect(diskSnapshot(first, secret)).toBe(uploadedText(writes.saves[0]))
      expect(workers.some(url => /outbox\.worker-/.test(url))).toBe(true)

      await setCellValue(page, 'A1', '继续编辑 B')
      await expect.poll(async () => (await readLocalDisk(page, key)).draft?.draftSeq).toBeGreaterThan(first.draftSeq)
      const newer = (await readLocalDisk(page, key)).draft!
      expect(newer.inFlight).toEqual(first.inFlight)
      expect(valueAt(diskSnapshot(newer, secret))).toBe('继续编辑 B')
      held.release()
      await expect.poll(async () => (await readLocalDisk(page, key)).draft?.baseRevision).toBe(2)
      const rebased = (await readLocalDisk(page, key)).draft!
      expect(rebased).toMatchObject({ draftSeq: newer.draftSeq, inFlight: null })
      expect(valueAt(diskSnapshot(rebased, secret))).toBe('继续编辑 B')
      expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('上传 A')
      await saveAndWait(page)
      await expect.poll(async () => (await readLocalDisk(page, key)).draft).toBeNull()
      expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('继续编辑 B')
    }
    finally {
      held.release()
    }
  })

  test('US-M4-02 断网仍捕获并加密落盘，恢复联网后的显式保存使用该来源且确认删除', async ({ page }) => {
    const { documentId, key } = await openLocalSheet(page, 'local-first-offline')
    const secret = await currentLocalKey(page)
    const writes = recordWrites(page, documentId)
    try {
      await page.context().setOffline(true)
      await setCellValue(page, 'A1', '离线保留的内容')
      await expect.poll(async () => (await readLocalDisk(page, key)).draft).not.toBeNull()
      const stored = (await readLocalDisk(page, key)).draft!
      expect(valueAt(diskSnapshot(stored, secret))).toBe('离线保留的内容')
      expect(stored.inFlight).toBeNull()
      expect(writes.saves).toHaveLength(0)
    }
    finally {
      await page.context().setOffline(false)
    }
    await saveAndWait(page)
    await expect.poll(async () => (await readLocalDisk(page, key)).draft).toBeNull()
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('离线保留的内容')
  })

  test('退出再进入后编辑器计数归零，本机高水位保留，上传 localSeq 沿用持久序号', async ({ page }) => {
    const { documentId, key } = await openLocalSheet(page, 'local-first-seq')
    const writes = recordWrites(page, documentId)
    await setCellValue(page, 'A1', '第一轮')
    await saveAndWait(page)
    await saveAndWait(page)
    await saveAndWait(page)
    await exitEditing(page)
    const high = (await readLocalDisk(page, key)).writer!.lastDraftSeq
    expect(high).toBeGreaterThanOrEqual(3)
    await enterEditing(page)
    const held = await holdSaves(page)
    try {
      await setCellValue(page, 'A1', '第二轮')
      await saveButton(page).click()
      await expect.poll(held.held).toBe(1)
      const stored = (await readLocalDisk(page, key)).draft!
      const capture = capturesOf(await autosaveLog(page)).at(-1)!
      expect(stored.draftSeq).toBeGreaterThan(high)
      expect(stored.draftSeq).toBeGreaterThan(capture.seq)
      expect(Number(saveParam(writes.saves.at(-1), 'localSeq'))).toBe(stored.draftSeq)
      held.release()
      await expect(saveStatus(page)).toHaveText('已保存到云端')
    }
    finally {
      held.release()
    }
  })

  test('A 已提交但回包丢失，捕获 B 后先原字节核对 A，再发送 B；核对在途时保留新行', async ({ page }) => {
    const { documentId, key } = await openLocalSheet(page, 'local-first-unknown')
    const secret = await currentLocalKey(page)
    const sent: Request[] = []
    let firstStatus: number | undefined
    let release = (): void => {}
    const replayGate = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route(`**/api/documents/${documentId}/content?*`, async (route) => {
      if (route.request().method() !== 'PUT') {
        await route.continue()
        return
      }
      sent.push(route.request())
      if (sent.length === 1) {
        const response = await route.fetch()
        firstStatus = response.status()
        await route.abort('failed')
        return
      }
      if (sent.length === 2)
        await replayGate
      await route.continue()
    })
    try {
      await setCellValue(page, 'A1', '未知的 A')
      await saveButton(page).click()
      await expect(saveStatus(page)).toHaveText('保存失败，稍后自动重试')
      expect(firstStatus).toBe(200)
      expect(await revisionOf(documentId)).toBe(2)
      const first = (await readLocalDisk(page, key)).draft!
      await setCellValue(page, 'A1', '后来的 B')
      await expect.poll(async () => (await readLocalDisk(page, key)).draft?.draftSeq).toBeGreaterThan(first.draftSeq)
      await saveButton(page).click()
      await expect.poll(() => sent.length).toBe(2)
      expect(sent[1]!.url()).toBe(sent[0]!.url())
      expect(sent[1]!.postDataBuffer()).toEqual(sent[0]!.postDataBuffer())
      expect(valueAt(diskSnapshot((await readLocalDisk(page, key)).draft!, secret))).toBe('后来的 B')
      release()
      await expect(saveStatus(page)).toHaveText('已保存到云端')
      expect(sent).toHaveLength(3)
      expect(valueAt(uploadedText(sent[2]))).toBe('后来的 B')
      expect(saveParam(sent[2], 'requestId')).not.toBe(saveParam(sent[0], 'requestId'))
      expect(await revisionOf(documentId)).toBe(3)
      await expect.poll(async () => (await readLocalDisk(page, key)).draft).toBeNull()
    }
    finally {
      release()
    }
  })

  test('US-M4-10 有效心跳发现吊销后换钥重写当前内容，无新编辑也使用新密钥与更高序号', async ({ page, anotherDevice }) => {
    await page.clock.install()
    const { owner, documentId, key } = await openLocalSheet(page, 'local-first-rekey')
    const oldKey = await currentLocalKey(page)
    await setCellValue(page, 'A1', '换钥保住的内容')
    await expect.poll(async () => (await readLocalDisk(page, key)).draft).not.toBeNull()
    const first = (await readLocalDisk(page, key)).draft!
    const admin = await createUser('local-first-admin', '吊销管理员', { systemRole: 'admin' })
    await loginThroughApi(anotherDevice, admin)
    await actAs(anotherDevice, 'POST', `/api/admin/users/${owner.id}/local-key/revoke`)
    await page.clock.fastForward(10_000)
    await expect.poll(async () => (await readLocalDisk(page, key)).draft?.keyVersion).toBe(2)
    const rewritten = (await readLocalDisk(page, key)).draft!
    expect(rewritten.draftSeq).toBeGreaterThan(first.draftSeq)
    const nextKey = await currentLocalKey(page)
    expect(valueAt(diskSnapshot(rewritten, nextKey))).toBe('换钥保住的内容')
    expect(() => diskSnapshot(rewritten, oldKey)).toThrow()
    await saveAndWait(page)
    await expect.poll(async () => (await readLocalDisk(page, key)).draft).toBeNull()
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('换钥保住的内容')
  })

  test('US-M4-15 会话的部署开关关闭时不取钥、不启动发件箱 Worker、不写库，仍能云端保存', async ({ page }) => {
    const keys: Request[] = []
    const workers: string[] = []
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/local-key')
        keys.push(request)
    })
    page.on('worker', worker => workers.push(worker.url()))
    await page.route('**/api/auth/session', async (route) => {
      const response = await route.fetch()
      const body = await response.json() as { readonly features?: object }
      await route.fulfill({ response, json: { ...body, features: { ...body.features, localDraftsEnabled: false } } })
    })
    const { documentId, key } = await openLocalSheet(page, 'local-first-disabled')
    await expect(page.locator('[data-slot="local-save-status"] summary')).toHaveText('本部署关闭了本机草稿（浏览器崩溃会丢掉没保存的修改）')
    await setCellValue(page, 'A1', '关闭草稿也能保存')
    await saveAndWait(page)
    expect(keys).toHaveLength(0)
    expect(workers.filter(url => /outbox\.worker-/.test(url))).toHaveLength(0)
    expect(await readLocalDisk(page, key)).toEqual({ draft: null, writer: null })
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('关闭草稿也能保存')
  })

  for (const failure of ['quota', 'unavailable'] as const) {
    test(`US-M4-11 真实 Worker 内存储 ${failure}，页面保持内存退路并上传完整正文`, async ({ page }) => {
      await observeLocalSaveOrder(page)
      let injected = false
      await page.route('**/assets/outbox.worker-*.js', async (route) => {
        const response = await route.fetch()
        // 仅在真实 Worker 的浏览器 API 边界注入失败，生产工厂、协议和保存来源都照常运行。
        const fault = failure === 'quota'
          ? `const put = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function (...args) { if (this.name === 'drafts') throw new DOMException('测试写满', 'QuotaExceededError'); return Reflect.apply(put, this, args); };`
          : `IDBFactory.prototype.open = function () { throw new DOMException('测试禁止存储', 'SecurityError'); };`
        await route.fulfill({ response, body: `${fault}\n${await response.text()}` })
        injected = true
      })
      const { documentId, key } = await openLocalSheet(page, `local-first-${failure}`)
      const held = await holdSaves(page)
      try {
        await setCellValue(page, 'A1', `存储 ${failure} 的内容`)
        await saveButton(page).click()
        await expect.poll(held.held).toBe(1)
        expect(injected).toBe(true)
        await expect(page.locator('[data-slot="local-save-status"] summary')).toHaveText(failure === 'quota' ? '本机存储空间不足' : '本机存储不可用，修改暂留在本页')
        expect(await localSaveOrder(page)).toContain(failure === 'quota' ? 'write:quota' : 'register:unavailable')
        expect((await readLocalDisk(page, key)).draft).toBeNull()
        held.release()
        await expect(saveStatus(page)).toHaveText('已保存到云端')
      }
      finally {
        held.release()
      }
      expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe(`存储 ${failure} 的内容`)
    })
  }

  test('失效后副本继承真实来源；副本回包丢失原样重试，成功不删除原文档的草稿', async ({ page }) => {
    const owner = await createUser('local-first-copy')
    const space = await createTeamSpace('副本来源', owner, [[owner, 'admin']])
    const documentId = await createDocumentIn(space.id, owner, '失效来源')
    const key = { userId: owner.id, documentId }
    await loginThroughApi(page, owner)
    await openAndEnterEditing(page, documentId)
    await setCellValue(page, 'A1', '副本中的本页内容')
    await archiveSpace(space.id)
    await saveButton(page).click()
    await expect(lostNotice(page).getByRole('button', { name: '另存为副本', exact: true })).toBeVisible()
    await waitForEditorAccess(page, 'read')
    const retained = (await readLocalDisk(page, key)).draft!
    expect(retained).not.toBeNull()
    const copies: Request[] = []
    let firstStatus: number | undefined
    await page.route(`**/api/documents/${documentId}/conflict-copies?*`, async (route) => {
      copies.push(route.request())
      if (copies.length === 1) {
        const response = await route.fetch()
        firstStatus = response.status()
        await route.abort('failed')
        return
      }
      await route.continue()
    })
    const button = lostNotice(page).getByRole('button', { name: '另存为副本', exact: true })
    await button.click()
    await expect(lostNotice(page)).toContainText('没能另存为副本')
    expect(firstStatus).toBe(201)
    await button.click()
    const notice = page.locator('#editor-chrome').getByRole('status').filter({ hasText: '已另存为副本' })
    await expect(notice).toBeVisible()
    expect(copies).toHaveLength(2)
    expect(copies[1]!.url()).toBe(copies[0]!.url())
    expect(copies[1]!.postDataBuffer()).toEqual(copies[0]!.postDataBuffer())
    expect(valueAt(uploadedText(copies[0]))).toBe('副本中的本页内容')
    const copyId = (await notice.getByRole('link').getAttribute('href'))!.split('/').at(-1)!
    expect(cellOf((await savedContent(page, copyId)).snapshot, 'A1')?.v).toBe('副本中的本页内容')
    expect(await revisionOf(documentId)).toBe(1)
    expect((await readLocalDisk(page, key)).draft).toEqual(retained)
  })
})
