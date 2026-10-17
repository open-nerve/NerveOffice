// 新暂停页面的三引擎校准：只拦心跳与交出，真等租约到期；不把这个结果当作原生进程暂停。
import type { Page, Route } from '@playwright/test'
import type { RequestStage } from '../../support/selftest-request.ts'
import { createHash, randomUUID } from 'node:crypto'
import process from 'node:process'
import { PAUSED_HOLDER_EDITS } from '../../../../apps/web/src/editor/testing/selftest-report.ts'
import { e2eOrigin } from '../../support/environment.ts'
import { expect, test } from '../../support/fixtures.ts'
import { currentLocalKey, diskSnapshot, readLocalDisk } from '../../support/local-draft.ts'
import { createNaturalObservation } from '../../support/natural-observation.ts'
import { pauseRequestEvidence, pauseServerProblems } from '../../support/pause-evidence.ts'
import { createLocalPauseSession } from '../../support/pause-session.ts'
import { selftestPageUrl, selftestScene, serverProblemsOf } from '../../support/selftest-plan.ts'
import { runPausedHolder } from '../../support/selftest-request.ts'
import { holdFirstSaveReply } from '../../support/selftest-run.ts'
import { cellOf, EDITOR_TEST_TIMEOUT, savedContent } from '../../support/sheet.ts'

const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
const values = (snapshot: Parameters<typeof cellOf>[0]): readonly unknown[] => PAUSED_HOLDER_EDITS.map(cell => cellOf(snapshot, cell.cell, cell.sheetId)?.v ?? null)
const content = PAUSED_HOLDER_EDITS.map(cell => cell.value)
const cloud = [...content.slice(0, 2), null]

async function visibility(page: Page, value: DocumentVisibilityState): Promise<void> {
  await page.evaluate((value) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
    document.dispatchEvent(new Event('visibilitychange'))
  }, value)
}

async function holdHolderBack(route: Route): Promise<void> {
  const request = route.request()
  const path = new URL(request.url()).pathname
  if ((request.method() === 'PUT' && path.endsWith('/edit-lease')) || (request.method() === 'POST' && path.endsWith('/edit-lease/handover')))
    await route.abort('internetdisconnected')
  else
    await route.fallback()
}

test.use({ autosave: process.env.E2E_AUTOSAVE === 'running' ? 'running' : 'held' })

test('US-M4-04 自然桌面过渡校准：多次可见性变化不能抢先写第三格，宿主确认后才形成未上传的真实草稿', { tag: '@test-build' }, async ({ page }, testInfo) => {
  test.setTimeout(EDITOR_TEST_TIMEOUT)
  const scene = await selftestScene('st-space', [{ id: 'paused-local-holder', scenario: 'paused-local-holder', role: 'author', sample: 'template' }])
  const step = scene.steps[0]!
  const runId = randomUUID()
  const endpoint = `${e2eOrigin()}/__nerve-pause/${runId}`
  const session = createNaturalObservation({ runId, documentId: step.documentId, userId: scene.author.id, contentHash: digest(JSON.stringify(content)), cloudHash: digest(JSON.stringify(cloud)), deadline: Date.now() + EDITOR_TEST_TIMEOUT, waitForWindow: true })
  let queries = 0
  await page.route(endpoint, async (route) => {
    const message = route.request().postDataJSON() as { kind: string }
    if (message.kind === 'window-state')
      queries += 1
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session.receive(message, Date.now())) })
  })
  const release = await holdFirstSaveReply(page, step.documentId)
  try {
    await page.goto(selftestPageUrl(e2eOrigin(), step, endpoint))
    await expect.poll(() => session.snapshot().phase, { timeout: 60_000 }).toBe('preparing')
    await expect.poll(async () => (await savedContent(page, step.documentId)).revision, { timeout: 60_000 }).toBe(2)
    await visibility(page, 'hidden')
    release()
    await expect.poll(() => queries, { timeout: 20_000 }).toBeGreaterThan(0)
    for (let index = 0; index < 3; index += 1) {
      await visibility(page, 'visible')
      await visibility(page, 'hidden')
    }
    expect(session.snapshot().local).toBeUndefined()
    const before = await savedContent(page, step.documentId)
    expect(before.revision).toBe(3)
    expect(values(before.snapshot)).toEqual(cloud)
    expect(session.confirmWindowReady(Date.now())).toBe(true)
    await expect.poll(() => session.snapshot().phase, { timeout: 30_000 }).toBe('ready')
    const ready = session.snapshot().local!
    const disk = (await readLocalDisk(page, { userId: scene.author.id, documentId: step.documentId })).draft!
    const text = diskSnapshot(disk, await currentLocalKey(page))
    expect(values(JSON.parse(text) as Parameters<typeof cellOf>[0])).toEqual(content)
    expect(digest(text)).toBe(ready.snapshotHash)
    expect(disk).toMatchObject({ draftSeq: 3, baseRevision: 3, inFlight: null, formulasPending: false })
    expect((await savedContent(page, step.documentId)).revision).toBe(3)
  }
  finally {
    release()
    await testInfo.attach('natural-window-calibration', { body: JSON.stringify(session.snapshot(), null, 2), contentType: 'application/json' })
  }
})

test('US-M4-04 持久草稿暂停校准：第三格经 Worker 写成并独立解密，租约真实到期后失权、另存完整副本并清理本机原件', { tag: '@test-build' }, async ({ page }, testInfo) => {
  test.setTimeout(EDITOR_TEST_TIMEOUT + 180_000)
  const scene = await selftestScene('st-local-pause', [{ id: 'paused-local-holder', scenario: 'paused-local-holder', role: 'author', sample: 'template' }])
  const step = scene.steps[0]!
  const deadline = Date.now() + 300_000
  const runId = randomUUID()
  const endpoint = `${e2eOrigin()}/__nerve-pause/${runId}`
  const session = createLocalPauseSession({ mode: 'heartbeat-calibration', runId, documentId: step.documentId, userId: scene.author.id, contentHash: digest(JSON.stringify(content)), cloudHash: digest(JSON.stringify(cloud)), deadline })
  const reports: unknown[] = []
  await page.route(endpoint, async (route) => {
    expect(route.request().method()).toBe('POST')
    const message = route.request().postDataJSON() as unknown
    reports.push(message)
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session.receive(message, Date.now())) })
  })
  const release = await holdFirstSaveReply(page, step.documentId)
  const pattern = `**/api/documents/${step.documentId}/edit-lease**`
  let independent: unknown
  const stage: RequestStage = {
    open: async () => {
      await page.goto(selftestPageUrl(e2eOrigin(), step, endpoint))
    },
    hide: async () => {
      await page.route(pattern, holdHolderBack)
      await visibility(page, 'hidden')
      release()
    },
    pause: async () => {
      await expect.poll(() => session.snapshot().phase, { timeout: 60_000 }).not.toBe('preparing')
      expect(session.snapshot().phase).toBe('ready')
      const ready = session.snapshot().local!
      const disk = (await readLocalDisk(page, { userId: scene.author.id, documentId: step.documentId })).draft!
      const text = diskSnapshot(disk, await currentLocalKey(page))
      const book = JSON.parse(text) as Parameters<typeof cellOf>[0]
      expect(values(book)).toEqual(content)
      expect(disk).toMatchObject({ draftSeq: ready.draftSeq, writeEpoch: ready.writeEpoch, writerId: ready.writerId, writtenBy: ready.clientInstanceId, baseRevision: 3, inFlight: null, formulasPending: false })
      expect(digest(text)).toBe(ready.snapshotHash)
      const stored = await savedContent(page, step.documentId)
      expect(values(stored.snapshot)).toEqual(cloud)
      expect(stored.revision).toBe(3)
      independent = { snapshotHash: digest(text), cloudHash: digest(JSON.stringify(values(stored.snapshot))), draftSeq: disk.draftSeq, revision: stored.revision, values: values(book) }
      expect(session.authorizePause({ revision: stored.revision, contentHash: digest(JSON.stringify(values(stored.snapshot))) }, Date.now())).toBe(true)
      expect(session.paused({ kind: 'heartbeat-calibration' }, Date.now())).toBe(true)
    },
    show: async () => {
      expect(session.resumed({ kind: 'heartbeat-calibration' }, Date.now())).toBe(true)
      await visibility(page, 'visible')
      await page.unroute(pattern, holdHolderBack)
    },
    report: async (until) => {
      await expect.poll(() => session.snapshot().phase, { timeout: Math.max(1, until - Date.now()) }).not.toBe('resumed')
      return session.snapshot().report
    },
    voided: () => session.snapshot().problems.at(0),
  }
  try {
    const run = await runPausedHolder({ origin: e2eOrigin(), documentId: step.documentId, holder: scene.author, requester: scene.peer, stage, deadline, expectSuspended: false })
    await testInfo.attach('request-evidence', { body: JSON.stringify(pauseRequestEvidence(run), null, 2), contentType: 'application/json' })
    expect(run.report?.path).toBe('lost-after-pause')
    const stored = await serverProblemsOf(step, run.report?.path)
    const problems = [...pauseServerProblems(run, { native: false, holderId: scene.author.id, pausedAt: run.marks.pausedAt ?? 0, resumedAt: session.snapshot().resumedAt ?? 0 }), ...stored.problems]
    expect(problems).toEqual([])
    const copyId = run.report?.facts?.copyDocumentId
    expect(typeof copyId).toBe('string')
    expect(values((await savedContent(page, String(copyId))).snapshot)).toEqual(content)
    expect((await readLocalDisk(page, { userId: scene.author.id, documentId: step.documentId })).draft).toBeNull()
    expect(session.finish(problems, Date.now())).toBe(true)
    expect(session.snapshot().phase).toBe('passed')
  }
  finally {
    release()
    await testInfo.attach('local-pause-calibration', { body: JSON.stringify({ independent, reports, session: session.snapshot() }, null, 2), contentType: 'application/json' })
  }
})
