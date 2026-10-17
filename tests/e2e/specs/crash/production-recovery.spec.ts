// M4-P6：生产可运行的真正进程崩溃。公开编辑/恢复/退出入口，正常自动保存，不依赖探针或种草稿。
import type { Page, Request, TestInfo } from '@playwright/test'
import type { CrashTool, RelaunchCookies } from '../../support/browser-crash.ts'
import type { Workbook } from '../../support/sheet.ts'
import { createHash } from 'node:crypto'
import { recordWrites } from '../../support/autosave.ts'
import { expect, expectCrashed, test } from '../../support/browser-crash.ts'
import { createUser, revisionOf } from '../../support/database.ts'
import { currentLocalKey, diskGzip, diskSnapshot, readLocalDisk } from '../../support/local-draft.ts'
import { openLogoutPreview } from '../../support/logout.ts'
import { loginThroughApi } from '../../support/session.ts'
import { cellOf, createSheetThroughApi, openAndEnterEditing, openReader, savedContent, saveStatus, takeOverHereButton, typeInCell, waitForEditorAccess } from '../../support/sheet.ts'

const CONTENT = '生产页面中断前真正保存在本机的正文'
let live: Page | undefined

test.use({ autosave: 'running' })

test.afterEach(async () => {
  const page = live
  live = undefined
  if (page === undefined || page.isClosed())
    return
  // 离开编辑器释放句柄，再走产品清理。macOS WebKit 的 OPFS 不完全位于独立资料目录中。
  await page.context().setOffline(false)
  page.on('dialog', async dialog => dialog.accept())
  await openLogoutPreview(page)
  await page.getByRole('button', { name: '清理本机草稿并退出', exact: true }).click()
  await expect(page.getByRole('form', { name: '登录' })).toBeVisible()
})

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function recordAcquires(page: Page, documentId: string): Request[] {
  const requests: Request[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/documents/${documentId}/edit-lease`)
      requests.push(request)
  })
  return requests
}

async function persistedOffline(crashTool: CrashTool, prefix: string, testInfo: TestInfo) {
  const owner = await createUser(prefix)
  const launch = await crashTool.launch()
  const { page, context } = launch
  live = page
  await loginThroughApi(page, owner)
  const documentId = await createSheetThroughApi(page)
  const key = { userId: owner.id, documentId }
  await openAndEnterEditing(page, documentId)
  const secret = await currentLocalKey(page)
  const writes = recordWrites(page, documentId)
  await context.setOffline(true)
  await typeInCell(page, 'A1', CONTENT)
  await expect.poll(async () => {
    const disk = (await readLocalDisk(page, key)).draft
    return disk === null ? undefined : cellOf(JSON.parse(diskSnapshot(disk, secret)) as Workbook, 'A1')?.v
  }).toBe(CONTENT)
  const disk = (await readLocalDisk(page, key)).draft!
  expect(disk.inFlight).toBeNull()
  expect(writes.saves).toHaveLength(0)
  expect(await revisionOf(documentId)).toBe(1)
  await testInfo.attach('production-durable-before-crash', {
    body: JSON.stringify({ documentId, draftSeq: disk.draftSeq, writeEpoch: disk.writeEpoch, writtenBy: disk.writtenBy, gzipSha256: digest(diskGzip(disk, secret)), cloudRevision: 1, saves: 0 }),
    contentType: 'application/json',
  })
  return { owner, launch, documentId, key, secret, disk, writes }
}

type Editor = Awaited<ReturnType<typeof persistedOffline>>

async function crashAndReopen(crashTool: CrashTool, h: Editor, cookies: RelaunchCookies) {
  const report = await crashTool.crash(h.launch)
  live = undefined
  expectCrashed(report)
  const next = await crashTool.relaunch(h.launch, report, { cookies })
  live = next.page
  if (cookies === 'clear') {
    expect((await next.page.request.get('/api/auth/session')).status()).toBe(401)
    await loginThroughApi(next.page, h.owner)
  }
  return next.page
}

for (const cookies of ['restore', 'clear'] as const) {
  test(`US-M4-04 生产 Cookie ${cookies}：离线落盘后进程中断，新页明确接手才恢复并同步`, async ({ crashTool }, testInfo) => {
    const h = await persistedOffline(crashTool, `production-body-${cookies}`, testInfo)
    const page = await crashAndReopen(crashTool, h, cookies)
    const acquires = recordAcquires(page, h.documentId)
    const writes = recordWrites(page, h.documentId)
    await openReader(page, h.documentId)
    await waitForEditorAccess(page, 'read', 'steady')
    expect(acquires).toHaveLength(0)
    const notice = page.locator('[data-slot="recovery-notice"]')
    await expect(notice.getByRole('button', { name: '另存为副本', exact: true })).toBeEnabled()
    // 进程结束没有正常释放旧租约；不伪造到期，仍须本人明确接手。
    await expect(notice.getByRole('button', { name: '恢复并编辑', exact: true })).toHaveCount(0)
    expect(await revisionOf(h.documentId)).toBe(1)
    const retained = (await readLocalDisk(page, h.key)).draft!
    expect(diskSnapshot(retained, h.secret)).toBe(diskSnapshot(h.disk, h.secret))
    await takeOverHereButton(page).click()
    await waitForEditorAccess(page, 'edit')
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(acquires).toHaveLength(1)
    const request = acquires[0]!.postDataJSON() as { clientInstanceId: string, takeover: string }
    expect(request.takeover).toBe('self')
    expect(request.clientInstanceId).not.toBe(h.disk.writtenBy)
    const cloud = await savedContent(page, h.documentId)
    expect(cloud.revision).toBe(2)
    expect(cellOf(cloud.snapshot, 'A1')?.v).toBe(CONTENT)
    expect(writes.saves).toHaveLength(1)
    await expect.poll(async () => (await readLocalDisk(page, h.key)).draft).toBeNull()
    await testInfo.attach('production-restored-after-crash', { body: JSON.stringify({ cookies, documentId: h.documentId, acquires: acquires.length, saves: writes.saves.length, cloudRevision: cloud.revision, cloudValue: cellOf(cloud.snapshot, 'A1')?.v }), contentType: 'application/json' })
  })

  test(`US-M4-05 生产 Cookie ${cookies}：云端已提交但回包丢失，进程中断后只原样确认一次`, async ({ crashTool }, testInfo) => {
    const h = await persistedOffline(crashTool, `production-ack-${cookies}`, testInfo)
    const oldPage = h.launch.page
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const sent: { query: string, gzipSha256: string, status: number }[] = []
    await oldPage.route(`**/api/documents/${h.documentId}/content?**`, async (route) => {
      if (route.request().method() !== 'PUT') {
        await route.continue()
        return
      }
      const response = await route.fetch()
      sent.push({ query: new URL(route.request().url()).search, gzipSha256: digest(route.request().postDataBuffer()!), status: response.status() })
      await held
      if (!oldPage.isClosed())
        await route.fulfill({ response })
    })
    try {
      await h.launch.context.setOffline(false)
      await expect.poll(() => sent.map(request => request.status)).toEqual([200])
      const original = sent[0]!
      expect(await revisionOf(h.documentId)).toBe(2)
      const pending = (await readLocalDisk(oldPage, h.key)).draft!
      expect(pending.inFlight).not.toBeNull()
      expect(digest(diskGzip(pending, h.secret))).toBe(original.gzipSha256)
      expect(new URLSearchParams(original.query).get('requestId')).toBe(pending.inFlight?.requestId)
      expect(h.writes.saves).toHaveLength(1)
      await testInfo.attach('production-ack-before-crash', { body: JSON.stringify({ ...original, draftSeq: pending.draftSeq, inFlight: pending.inFlight, cloudRevision: 2 }), contentType: 'application/json' })
      const page = await crashAndReopen(crashTool, h, cookies)
      release()
      const acquires = recordAcquires(page, h.documentId)
      const writes = recordWrites(page, h.documentId)
      await openReader(page, h.documentId)
      await expect.poll(async () => (await readLocalDisk(page, h.key)).draft).toBeNull()
      await waitForEditorAccess(page, 'read', 'steady')
      expect(acquires).toHaveLength(0)
      expect(writes.saves).toHaveLength(1)
      const replay = writes.saves[0]!
      expect(new URL(replay.url()).search).toBe(original.query)
      expect(digest(replay.postDataBuffer()!)).toBe(original.gzipSha256)
      expect(await replay.headerValue('x-edit-lease')).toBeNull()
      expect((await replay.response())?.status()).toBe(200)
      const cloud = await savedContent(page, h.documentId)
      expect(cloud.revision).toBe(2)
      expect(cellOf(cloud.snapshot, 'A1')?.v).toBe(CONTENT)
      await testInfo.attach('production-ack-after-crash', { body: JSON.stringify({ cookies, documentId: h.documentId, acquires: acquires.length, saves: writes.saves.length, query: new URL(replay.url()).search, gzipSha256: digest(replay.postDataBuffer()!), cloudRevision: cloud.revision }), contentType: 'application/json' })
    }
    finally {
      release()
    }
  })
}
