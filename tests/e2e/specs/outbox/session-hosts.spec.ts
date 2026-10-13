// 真实登录入口与真实 Worker/IDB 的交错：请求发出前退役，迟到查询不借新代次。
import type { Page } from '@playwright/test'
import type { ProbeCapture } from '../../support/outbox-probe.ts'
import { randomUUID } from 'node:crypto'
import { createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { openOutboxProbe, outcomeOf, probe, probeDatabase, probePipeline, removeMirrorOf, writerOf } from '../../support/outbox-probe.ts'
import { fence } from '../../support/session-fence-probe.ts'
import { actAs, loginThroughApi, loginThroughUi } from '../../support/session.ts'

const RAW_KEY = '12'.repeat(32)
const EXPECTED_READ = { 'same-user': { kind: 'draft', gzip: { text: 'same captured text' } }, 'other-user': { kind: 'session-invalid' } }

async function nextLogin(change: string, user: Awaited<ReturnType<typeof createUser>>) {
  return change === 'same-user' ? user : createUser('ob-host-next')
}

function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function activePermit(page: Page) {
  const state = outcomeOf(await fence(page, 'read'), 'state').state
  if (state?.phase !== 'active' || typeof state.generation !== 'string' || typeof state.source !== 'object' || state.source === null || !('userId' in state.source) || typeof state.source.userId !== 'string')
    throw new Error('应有真实登录激活的会话')
  return { userId: state.source.userId, generation: state.generation }
}

test.describe('真实请求与宿主会话资格', { tag: '@test-build' }, () => {
  for (const host of ['in-process', 'worker'] as const) {
    for (const change of ['same-user', 'other-user'] as const) {
      test(`${host} / ${change}：登录尚未发到服务器时旧缓存、原件观察和 force 登记已失效`, async ({ page }) => {
        const user = await createUser('ob-host-old')
        const nextUser = await nextLogin(change, user)
        await loginThroughApi(page, user)
        await openOutboxProbe(page)
        await probe(page, 'chooseKey', 1, RAW_KEY)
        const oldPermit = await activePermit(page)
        const created = await probePipeline(page, 'create', { host })
        expect(created.ready.kind).toBe('ready')
        await probePipeline(page, 'setKey', created.id, 'probe')
        const key = { userId: user.id, documentId: randomUUID() }
        const writer = writerOf(4)
        expect((await probePipeline(page, 'register', created.id, key, writer, false)).kind).toBe('registered')
        const capture: ProbeCapture = { key, writer, draftSeq: 1, baseRevision: 1, writtenBy: randomUUID(), format: { clientBuild: '0.1.0', univerVersion: '0.12.4', profile: 'sheet-v1', formatVersion: 1 }, formulasPending: false, inFlight: null, content: 'same captured text', dedupe: true }
        expect((await probePipeline(page, 'write', created.id, capture)).kind).toBe('written')
        const observed = outcomeOf(await probePipeline(page, 'observe', created.id, key), 'observed')
        const before = await Promise.all(['drafts', 'writers'].map(async name => probeDatabase(page, 'getRaw', name, key)))
        // API 退出只准备登录界面；资格退役必须由下面真正的 UI 登录开始，而不是夹具手改 sessions。
        const login = await page.context().newPage()
        await actAs(login, 'POST', '/api/auth/logout')
        await login.goto('/login')
        const reached = barrier()
        const release = barrier()
        await login.route('**/api/auth/login', async (route) => {
          reached.resolve()
          await release.promise
          await route.continue()
        })
        try {
          await loginThroughUi(login, nextUser)
          await reached.promise
          const pending = outcomeOf(await fence(page, 'read'), 'state').state
          expect(pending?.phase).toBe('unconfirmed')
          expect(pending?.generation).not.toBe(oldPermit.generation)
          expect(await probePipeline(page, 'write', created.id, { ...capture, draftSeq: 2 })).toEqual({ kind: 'session-invalid', gzip: null })
          expect(await probePipeline(page, 'read', created.id, key)).toEqual({ kind: 'session-invalid' })
          expect(await probePipeline(page, 'observe', created.id, key)).toEqual({ kind: 'session-invalid' })
          expect(await probePipeline(page, 'removeObserved', created.id, observed.observation)).toEqual({ kind: 'session-invalid' })
          expect(await probePipeline(page, 'register', created.id, key, writerOf(100), true)).toEqual({ kind: 'session-invalid' })
          expect(await probePipeline(page, 'reconcile', created.id, user.id)).toEqual({ kind: 'session-invalid' })
          expect(await probePipeline(page, 'notices', created.id, user.id)).toEqual({ kind: 'session-invalid' })
          expect(await Promise.all(['drafts', 'writers'].map(async name => probeDatabase(page, 'getRaw', name, key)))).toEqual(before)
          release.resolve()
          await expect(login.getByRole('heading', { name: '我的空间' })).toBeVisible()
          const nextPermit = await activePermit(page)
          expect(nextPermit.userId).toBe(nextUser.id)
          expect(nextPermit.generation).not.toBe(oldPermit.generation)
          expect(await probePipeline(page, 'bindSession', created.id, nextPermit)).toEqual({ kind: 'session-invalid' })
          await probePipeline(page, 'release', created.id, key)
          await openOutboxProbe(login)
          await probe(login, 'chooseKey', 1, RAW_KEY)
          const fresh = await probePipeline(login, 'create', { host })
          await probePipeline(login, 'setKey', fresh.id, 'probe')
          const read = await probePipeline(login, 'read', fresh.id, key)
          expect(read).toMatchObject(EXPECTED_READ[change])
          await probePipeline(login, 'disposeAll')
        }
        finally {
          release.resolve()
          await removeMirrorOf(page, user.id)
          await login.close()
        }
      })
    }
  }

  test('旧 GET 响应在新登录之后回来，不重新取票、不激活也不覆盖新状态', async ({ page }) => {
    const user = await createUser('ob-late-session')
    await loginThroughApi(page, user)
    await openOutboxProbe(page)
    const late = await page.context().newPage()
    await openOutboxProbe(late, { authorize: false })
    const captured = barrier()
    const release = barrier()
    await late.route('**/api/auth/session', async (route) => {
      const response = await route.fetch()
      captured.resolve()
      await release.promise
      await route.fulfill({ response })
    })
    const result = probe(late, 'authorizeSession').then(value => ({ value }), (error: unknown) => ({ error: String(error) }))
    const login = await page.context().newPage()
    try {
      await captured.promise
      await actAs(login, 'POST', '/api/auth/logout')
      await login.goto('/login')
      await loginThroughUi(login, user)
      await expect(login.getByRole('heading', { name: '我的空间' })).toBeVisible()
      const current = await probeDatabase(page, 'getRaw', 'sessions', 'current')
      release.resolve()
      expect(await result).toMatchObject({ error: expect.stringContaining('没有取得本机会话许可') })
      expect(await probeDatabase(page, 'getRaw', 'sessions', 'current')).toEqual(current)
      expect(await probe(late, 'register', { userId: user.id, documentId: randomUUID() }, writerOf(50), { now: Date.now(), force: true })).toEqual({ kind: 'session-invalid' })
    }
    finally {
      release.resolve()
      await result
      await login.close()
      await late.close()
    }
  })
})
