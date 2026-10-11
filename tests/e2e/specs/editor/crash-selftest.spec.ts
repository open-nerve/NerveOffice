// Safari 页面准备/观察模块的三引擎校准；实际触发普通刷新，不将这里的结果宣称为 Safari 进程崩溃。
import type { Request } from '@playwright/test'
import type { CrashServerEvidence } from '../../support/crash-session.ts'
import { createHash, randomUUID } from 'node:crypto'
import { createCrashSession } from '../../support/crash-session.ts'
import { createDocument, createUser, revisionOf } from '../../support/database.ts'
import { e2eOrigin } from '../../support/environment.ts'
import { expect, test } from '../../support/fixtures.ts'
import { currentLocalKey, diskSnapshot, readLocalDisk } from '../../support/local-draft.ts'
import { cellOf, EDITOR_TEST_TIMEOUT, savedContent } from '../../support/sheet.ts'

const CONTENT = 'Safari 页面崩溃前已持久保存的正文'
const digest = (text: string): string => createHash('sha256').update(text).digest('hex')

async function requestEvidence(requests: readonly Request[]) {
  const acquires: CrashServerEvidence['acquires'][number][] = []
  const saves: CrashServerEvidence['saves'][number][] = []
  for (const request of requests) {
    const status = (await request.response())?.status() ?? 0
    if (request.method() === 'POST') {
      const body = request.postDataJSON() as { clientInstanceId: string, takeover?: string }
      acquires.push({ clientInstanceId: body.clientInstanceId, takeover: body.takeover ?? null, status })
    }
    else {
      saves.push({ status })
    }
  }
  return { acquires, saves }
}

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

test('US-M4-04 初页出错但真实写盘成功时不得进入崩溃就绪', { tag: '@test-build' }, async ({ page }, testInfo) => {
  const owner = await createUser('crash-error')
  const documentId = await createDocument(owner, '崩溃自检初页错误反例')
  const runId = randomUUID()
  const endpoint = `${e2eOrigin()}/__nerve-crash/${runId}`
  const session = createCrashSession({ mode: 'reload-calibration', runId, documentId, userId: owner.id, contentHash: digest(CONTENT), deadline: Date.now() + EDITOR_TEST_TIMEOUT })
  const reports: Record<string, unknown>[] = []
  await page.addInitScript(() => {
    const original = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const response = await original(input, init)
      const url = input instanceof window.Request ? input.url : String(input)
      // 已发生真实正文变更、独立解密前注入初页错误；不更改 HTTP/Worker/磁盘结果。
      if (new URL(url, location.href).pathname === '/api/local-key' && (window.__nerveEditorProbe?.changeSeq() ?? 0) > 0)
        // eslint-disable-next-line no-console -- 阳性对照：故意经真实页面的错误收集器报告初页异常。
        console.error('受控的初页异常，必须使崩溃自检失败')
      return response
    }
  })
  await page.route(endpoint, async (route) => {
    const message = route.request().postDataJSON() as Record<string, unknown>
    reports.push(message)
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session.receive(message, Date.now())) })
  })
  const fragment = new URLSearchParams({ user: owner.username, password: owner.password, document: documentId, scenario: 'crash-recovery', next: endpoint })
  await page.goto(`${e2eOrigin()}/selftest.html#${fragment}`)
  await expect.poll(() => ['ready', 'failed'].includes(session.snapshot().phase), { timeout: 90_000 }).toBe(true)
  await testInfo.attach('crash-prepare-error', { body: JSON.stringify({ reports, session: session.snapshot() }), contentType: 'application/json' })
  const attempted = reports.find(message => message.kind === 'ready')
  expect(attempted?.workerWrites).toBeGreaterThan(0)
  expect(attempted?.pageErrors).toBeGreaterThan(0)
  const draft = (await readLocalDisk(page, { userId: owner.id, documentId })).draft!
  const book = JSON.parse(diskSnapshot(draft, await currentLocalKey(page))) as Parameters<typeof cellOf>[0]
  expect(cellOf(book, 'A1')?.v).toBe(CONTENT)
  expect(session.snapshot().phase).toBe('failed')
  expect(session.reloadedForCalibration(Date.now())).toBe(false)
})

for (const autosave of ['held', 'running'] as const) {
  test.describe(`崩溃自检页面校准，初始自动保存 ${autosave}`, () => {
    test.use({ autosave })

    test('US-M4-04 真实持久后原页重载：仅观察自动恢复，不补写身份或点击编辑', { tag: '@test-build' }, async ({ page }, testInfo) => {
      const owner = await createUser('safari-crash')
      const documentId = await createDocument(owner, 'Safari 崩溃自检校准')
      const runId = randomUUID()
      const endpoint = `${e2eOrigin()}/__nerve-crash/${runId}`
      const session = createCrashSession({ mode: 'reload-calibration', runId, documentId, userId: owner.id, contentHash: digest(CONTENT), deadline: Date.now() + EDITOR_TEST_TIMEOUT })
      await page.route(endpoint, async (route) => {
        const result = session.receive(route.request().postDataJSON(), Date.now())
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) })
      })
      const fragment = new URLSearchParams({ user: owner.username, password: owner.password, document: documentId, scenario: 'crash-recovery', next: endpoint })
      await page.goto(`${e2eOrigin()}/selftest.html#${fragment}`)
      await expect.poll(() => ['ready', 'failed'].includes(session.snapshot().phase), { timeout: 90_000 }).toBe(true)
      await testInfo.attach('crash-page-ready', { body: JSON.stringify(session.snapshot()), contentType: 'application/json' })
      expect(session.snapshot()).toMatchObject({ phase: 'ready' })
      const ready = session.snapshot().ready!
      const key = { userId: owner.id, documentId }
      const disk = (await readLocalDisk(page, key)).draft!
      const snapshot = diskSnapshot(disk, await currentLocalKey(page))
      expect(ready.snapshotHash).toBe(digest(snapshot))
      expect(ready.clientInstanceId).toBe(disk.writtenBy)
      expect(await revisionOf(documentId)).toBe(1)
      const requests: Request[] = []
      let reloading = false
      page.on('request', (request) => {
        const path = new URL(request.url()).pathname
        if (reloading && ((request.method() === 'POST' && path === `/api/documents/${documentId}/edit-lease`) || (request.method() === 'PUT' && path === `/api/documents/${documentId}/content`)))
          requests.push(request)
      })
      await page.route(page.url(), async (route) => {
        expect(route.request().isNavigationRequest()).toBe(true)
        expect(session.reloadedForCalibration(Date.now())).toBe(true)
        reloading = true
        await route.continue()
      }, { times: 1 })
      await page.reload()
      await expect.poll(() => ['restored', 'failed'].includes(session.snapshot().phase), { timeout: 90_000 }).toBe(true)
      await testInfo.attach('crash-page-restored', { body: JSON.stringify(session.snapshot()), contentType: 'application/json' })
      expect(session.snapshot()).toMatchObject({ phase: 'restored' })
      const { acquires, saves } = await requestEvidence(requests)
      const cloud = await savedContent(page, documentId)
      const value = cellOf(cloud.snapshot, 'A1')?.v
      expect(session.finish({ revision: cloud.revision, contentHash: digest(typeof value === 'string' ? value : ''), acquires, saves }, Date.now())).toEqual([])
      expect((await readLocalDisk(page, key)).draft).toBeNull()
      await testInfo.attach('crash-page-calibration', { body: JSON.stringify(session.snapshot()), contentType: 'application/json' })
    })
  })
}
