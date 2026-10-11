// M4-P3 S5：真实编辑器写成的正文经过整棵浏览器进程中断，再由产品入口恢复。
// Cookie restore/clear 是明确的重开前提；不注入原页身份，不用种草稿代替实际写入。
import type { Page, Request, TestInfo } from '@playwright/test'
import type { CrashTool, PersistentLaunch, RelaunchCookies } from '../../support/browser-crash.ts'
import type { Workbook } from '../../support/sheet.ts'
import { createHash } from 'node:crypto'
import { holdAutosave, recordWrites } from '../../support/autosave.ts'
import { expect, expectCrashed, test } from '../../support/browser-crash.ts'
import { createUser, revisionOf } from '../../support/database.ts'
import { currentLocalKey, diskGzip, diskSnapshot, localSaveOrder, observeLocalSaveOrder, readLocalDisk } from '../../support/local-draft.ts'
import { openOutboxProbe, probeDatabase, probePipeline } from '../../support/outbox-probe.ts'
import { loginThroughApi } from '../../support/session.ts'
import { cellOf, createSheetThroughApi, openAndEnterEditing, openReader, savedContent, saveStatus, takeOverHereButton, typeInCell, waitForEditorAccess } from '../../support/sheet.ts'

const CONTENT = '真正崩溃前已写成本机的正文'
let live: { readonly page: Page, readonly userId: string } | undefined

test.afterEach(async () => {
  const last = live
  live = undefined
  if (last === undefined || last.page.isClosed())
    return
  // 离开原编辑页释放 Worker/句柄；WebKit 的 OPFS 可能在持久目录之外，只清本用例用户。
  last.page.on('dialog', async dialog => dialog.accept())
  await openOutboxProbe(last.page)
  await probePipeline(last.page, 'disposeAll')
  await expect.poll(async () => (await probePipeline(last.page, 'removeMirror', last.userId)).kind, { timeout: 10_000 }).toBe('removed')
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

async function persistedEditor(crashTool: CrashTool, prefix: string) {
  const owner = await createUser(prefix)
  const launch = await crashTool.launch()
  const { page } = launch
  live = { page, userId: owner.id }
  await loginThroughApi(page, owner)
  const documentId = await createSheetThroughApi(page)
  const key = { userId: owner.id, documentId }
  await observeLocalSaveOrder(page)
  await openAndEnterEditing(page, documentId)
  await holdAutosave(page)
  const secret = await currentLocalKey(page)
  const writesBefore = (await localSaveOrder(page)).filter(event => event === 'write:written').length
  await typeInCell(page, 'A1', CONTENT)
  await expect.poll(async () => (await localSaveOrder(page)).filter(event => event === 'write:written').length).toBeGreaterThan(writesBefore)
  await expect.poll(async () => {
    const disk = (await readLocalDisk(page, key)).draft
    return disk === null ? undefined : cellOf(JSON.parse(diskSnapshot(disk, secret)) as Workbook, 'A1')?.v
  }).toBe(CONTENT)
  const disk = (await readLocalDisk(page, key)).draft!
  expect(disk.inFlight).toBeNull()
  expect(await revisionOf(documentId)).toBe(1)
  return { owner, launch, documentId, key, secret, disk }
}

type Editor = Awaited<ReturnType<typeof persistedEditor>>

async function reopen(crashTool: CrashTool, h: Editor, cookies: RelaunchCookies): Promise<PersistentLaunch> {
  const report = await crashTool.crash(h.launch)
  live = undefined
  expectCrashed(report)
  const next = await crashTool.relaunch(h.launch, report, { cookies })
  live = { page: next.page, userId: h.owner.id }
  if (cookies === 'clear') {
    expect((await next.page.request.get('/api/auth/session')).status()).toBe(401)
    await loginThroughApi(next.page, h.owner)
  }
  return next
}

async function restoreExplicitly(page: Page, h: Editor, acquires: Request[]): Promise<void> {
  await waitForEditorAccess(page, 'read', 'steady')
  expect(acquires).toHaveLength(0)
  const notice = page.locator('[data-slot="recovery-notice"]')
  await expect(notice.getByRole('button', { name: '另存为副本', exact: true })).toBeEnabled()
  // 旧租约没有正常释放，仍是 held；显式的“在此编辑”由服务端裁决，不伪造到期。
  await expect(notice.getByRole('button', { name: '恢复并编辑', exact: true })).toHaveCount(0)
  expect(await revisionOf(h.documentId)).toBe(1)
  const original = (await readLocalDisk(page, h.key)).draft!
  expect(diskSnapshot(original, h.secret)).toBe(diskSnapshot(h.disk, h.secret))
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
  await expect.poll(async () => (await readLocalDisk(page, h.key)).draft).toBeNull()
}

async function attachBodyEvidence(testInfo: TestInfo, h: Editor, kind: string): Promise<void> {
  await testInfo.attach('editor-crash-evidence', {
    body: JSON.stringify({ kind, userId: h.owner.id, documentId: h.documentId, draftSeq: h.disk.draftSeq, writeEpoch: h.disk.writeEpoch, writtenBy: h.disk.writtenBy, gzipSha256: digest(diskGzip(h.disk, h.secret)) }),
    contentType: 'application/json',
  })
}

test.describe('US-M4-04 真实编辑器写成之后结束浏览器进程', { tag: '@test-build' }, () => {
  test.use({ autosave: 'running' })

  for (const cookies of ['restore', 'clear'] as const) {
    test(`Cookie ${cookies}：普通重开先阅读，显式接手最后持久正文，无新输入也同步`, async ({ crashTool }, testInfo) => {
      const h = await persistedEditor(crashTool, `ce-body-${cookies}`)
      await attachBodyEvidence(testInfo, h, `body-${cookies}`)
      const { page } = await reopen(crashTool, h, cookies)
      const acquires = recordAcquires(page, h.documentId)
      const writes = recordWrites(page, h.documentId)
      await openReader(page, h.documentId)
      await restoreExplicitly(page, h, acquires)
      expect(writes.saves).toHaveLength(1)
    })

    test(`US-M4-05 Cookie ${cookies}：真实保存已提交但未收到回包，崩溃重开只原样确认，不多一个修订`, async ({ crashTool }, testInfo) => {
      const h = await persistedEditor(crashTool, `ce-ack-${cookies}`)
      const oldPage = h.launch.page
      let release: () => void = () => {}
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      let sent: { readonly query: string, readonly gzipSha256: string, readonly status: number } | undefined
      await oldPage.route(`**/api/documents/${h.documentId}/content?**`, async (route) => {
        if (route.request().method() !== 'PUT') {
          await route.continue()
          return
        }
        const response = await route.fetch()
        sent = { query: new URL(route.request().url()).search, gzipSha256: digest(route.request().postDataBuffer()!), status: response.status() }
        await held
        // 真崩溃后的旧连接已经不存在，不给重开的页面伪造回执。
        if (!oldPage.isClosed())
          await route.fulfill({ response })
      })
      try {
        await oldPage.locator('#editor-chrome').getByRole('button', { name: '保存', exact: true }).click()
        await expect.poll(() => sent?.status).toBe(200)
        expect(await revisionOf(h.documentId)).toBe(2)
        const pending = (await readLocalDisk(oldPage, h.key)).draft!
        expect(pending.inFlight).not.toBeNull()
        expect(digest(diskGzip(pending, h.secret))).toBe(sent!.gzipSha256)
        expect(new URLSearchParams(sent!.query).get('requestId')).toBe(pending.inFlight?.requestId)
        await testInfo.attach('lost-receipt-before-crash', { body: JSON.stringify({ ...sent, draftSeq: pending.draftSeq, inFlight: pending.inFlight, cloudRevision: 2 }), contentType: 'application/json' })
        const { page } = await reopen(crashTool, h, cookies)
        release()
        const acquires = recordAcquires(page, h.documentId)
        const writes = recordWrites(page, h.documentId)
        await openReader(page, h.documentId)
        await expect.poll(async () => (await readLocalDisk(page, h.key)).draft).toBeNull()
        await waitForEditorAccess(page, 'read', 'steady')
        expect(acquires).toHaveLength(0)
        expect(writes.saves).toHaveLength(1)
        const replay = writes.saves[0]!
        expect(new URL(replay.url()).search).toBe(sent!.query)
        expect(digest(replay.postDataBuffer()!)).toBe(sent!.gzipSha256)
        expect(await replay.headerValue('x-edit-lease')).toBeNull()
        expect((await replay.response())?.status()).toBe(200)
        const cloud = await savedContent(page, h.documentId)
        expect(cloud.revision).toBe(2)
        expect(cellOf(cloud.snapshot, 'A1')?.v).toBe(CONTENT)
      }
      finally {
        release()
      }
    })
  }

  test('真实正文崩溃后主库丢失（显式删库夹具）：镜像找回提示与正文，显式接手后同步', async ({ crashTool }, testInfo) => {
    const h = await persistedEditor(crashTool, 'ce-mirror')
    await attachBodyEvidence(testInfo, h, 'explicit-primary-database-loss-after-crash')
    const { page } = await reopen(crashTool, h, 'restore')
    await openOutboxProbe(page)
    const slots = await probePipeline(page, 'mirrorSlots', h.key)
    expect(slots.some(slot => slot.kind === 'valid' && slot.meta.draftSeq === h.disk.draftSeq && slot.meta.writerId === h.disk.writerId)).toBe(true)
    expect(await probeDatabase(page, 'remove', 5_000)).toBe('deleted')
    expect(await probeDatabase(page, 'exists')).toBe(false)
    const acquires = recordAcquires(page, h.documentId)
    await openReader(page, h.documentId)
    await expect(page.getByText('本机草稿已从额外备份中找回', { exact: true })).toBeVisible()
    await restoreExplicitly(page, h, acquires)
  })
})
