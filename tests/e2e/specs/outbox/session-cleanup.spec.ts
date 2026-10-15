import type { BrowserContext, Page } from '@playwright/test'
import type { ProbeCapture } from '../../support/outbox-probe.ts'
import type { SessionPermit, SessionTicket } from '../../support/session-fence-probe.ts'
import { randomUUID } from 'node:crypto'
import { createUser } from '../../support/database.ts'
import { test as base, expect } from '../../support/fixtures.ts'
import { draftFor, openOutboxProbe, outcomeOf, probe, probeDatabase, probePipeline, removeMirrorOf, writerOf } from '../../support/outbox-probe.ts'
import { firstPage, launchPersistentProfile } from '../../support/persistent-profile.ts'
import { fence } from '../../support/session-fence-probe.ts'
import { loginThroughApi } from '../../support/session.ts'

const RAW_KEY = '61'.repeat(32)

const test = base.extend<{ profile: { readonly page: Page, readonly context: BrowserContext } }>({
  profile: async ({ playwright, browserName, cspViolations, pageErrors }, provide, testInfo) => {
    const context = await launchPersistentProfile(playwright[browserName], testInfo, 'profile', { cspViolations, pageErrors })
    try {
      await provide({ context, page: await firstPage(context) })
    }
    finally {
      await context.close()
    }
  },
})

async function worker(page: Page) {
  const created = await probePipeline(page, 'create', { host: 'worker' })
  expect(created.ready.kind).toBe('ready')
  await probePipeline(page, 'setKey', created.id, 'probe')
  return created.id
}

async function setup(page: Page) {
  const user = await createUser('ob-clean-session')
  await loginThroughApi(page, user)
  await openOutboxProbe(page)
  await probe(page, 'chooseKey', 1, RAW_KEY)
  const key = { userId: user.id, documentId: randomUUID() }
  const writer = writerOf(3)
  const id = await worker(page)
  expect((await probePipeline(page, 'register', id, key, writer, false)).kind).toBe('registered')
  const capture: ProbeCapture = { key, writer, draftSeq: 1, baseRevision: 1, writtenBy: randomUUID(), format: { clientBuild: '0.1.0', univerVersion: '0.12.4', profile: 'sheet-v1', formatVersion: 1 }, formulasPending: false, inFlight: null, content: 'original content', dedupe: false }
  expect(await probePipeline(page, 'write', id, capture)).toMatchObject({ kind: 'written', mirror: { kind: 'mirrored' } })
  return { user, key, writer, id, capture }
}

async function lateDisabled(page: Page, late: 'request' | 'query', original: SessionPermit, ticket: SessionTicket) {
  return late === 'request'
    ? fence(page, 'beginCleanup', original, 'account_disabled')
    : fence(page, 'reject', ticket, { kind: 'disabled', userId: original.userId })
}

test.describe('持久清理资格与真实镜像', { tag: '@test-build' }, () => {
  for (const late of ['request', 'query'] as const) {
    test(`普通查询失效先暂停后，原 ${late} 的停用事实仍清除真实草稿与镜像`, async ({ profile: { page } }) => {
      const h = await setup(page)
      try {
        const ticket = outcomeOf(await fence(page, 'begin', 'query'), 'ticket').ticket
        const original = { userId: h.user.id, generation: ticket.generation }
        const stopped = await fence(page, 'reject', ticket, { kind: 'preserve' })
        expect(stopped).toEqual({ kind: 'stopped', previous: original })
        const state = outcomeOf(await fence(page, 'read'), 'state').state
        expect(state).toMatchObject({ phase: 'suspended' })
        expect(state?.generation).not.toBe(original.generation)
        // 暂停已经撤销写入；这里不能靠迟到事实恢复旧 Worker。
        expect((await probePipeline(page, 'write', h.id, { ...h.capture, draftSeq: 2 })).kind).toBe('session-invalid')
        await probePipeline(page, 'release', h.id, h.key)
        const result = await lateDisabled(page, late, original, ticket)
        expect(result.kind).toBe('clearing')
        const permit = outcomeOf(result, 'clearing').permit
        expect(await probePipeline(page, 'cleanupUser', permit)).toEqual({ kind: 'cleared', pending: [] })
        expect(await probeDatabase(page, 'getRaw', 'drafts', h.key)).toBeNull()
        expect(await probeDatabase(page, 'getRaw', 'writers', h.key)).toBeNull()
        expect(await probePipeline(page, 'mirrorSlots', h.key)).toEqual([{ kind: 'missing' }, { kind: 'missing' }])
      }
      finally {
        await probePipeline(page, 'release', h.id, h.key)
        await expect.poll(async () => removeMirrorOf(page, h.user.id)).toBe('removed')
      }
    })
  }

  test('镜像忙保留 clearing；同人重登后旧 pending、旧批量删除和旧墓碑均不能碰新原件', async ({ profile: { page, context } }) => {
    const h = await setup(page)
    const next = await context.newPage()
    try {
      const other = { userId: randomUUID(), documentId: randomUUID() }
      await probeDatabase(page, 'seedDraft', draftFor(other, h.writer, 1))
      const otherOriginal = await probeDatabase(page, 'getRaw', 'drafts', other)
      const permit = outcomeOf(await probePipeline(page, 'beginCleanup', 'logout'), 'clearing').permit
      expect(await probePipeline(page, 'cleanupUser', permit)).toEqual({ kind: 'pending', pending: [h.key] })
      expect(outcomeOf(await fence(page, 'read'), 'state').state).toMatchObject({ phase: 'clearing', generation: permit.generation })
      expect(await probePipeline(page, 'register', h.id, { ...h.key, documentId: randomUUID() }, h.writer, true)).toMatchObject({ kind: 'session-invalid' })
      expect(await probePipeline(page, 'write', h.id, { ...h.capture, draftSeq: 2 })).toMatchObject({ kind: 'session-invalid', gzip: null })
      await probePipeline(page, 'release', h.id, h.key)
      await loginThroughApi(next, h.user)
      await openOutboxProbe(next)
      await probe(next, 'chooseKey', 1, RAW_KEY)
      const id = await worker(next)
      const newer = writerOf(4)
      expect((await probePipeline(next, 'register', id, h.key, newer, true)).kind).toBe('registered')
      expect((await probePipeline(next, 'write', id, { ...h.capture, writer: newer, draftSeq: 2, adoptSeq: 1, content: 'new session content' })).kind).toBe('written')
      await probePipeline(next, 'release', id, h.key)
      const before = await Promise.all(['drafts', 'writers'].map(async store => probeDatabase(next, 'getRaw', store, h.key)))
      const slots = await probePipeline(next, 'mirrorSlots', h.key)
      expect(await probePipeline(page, 'cleanupUser', permit)).toEqual({ kind: 'invalidated' })
      expect(await Promise.all(['drafts', 'writers'].map(async store => probeDatabase(next, 'getRaw', store, h.key)))).toEqual(before)
      expect(await probePipeline(next, 'mirrorSlots', h.key)).toEqual(slots)
      expect(await probe(page, 'retireUser', permit, Date.now())).toEqual({ kind: 'session-invalid' })
      expect(await probe(page, 'removeUser', permit)).toEqual({ kind: 'session-invalid' })
      expect(await Promise.all(['drafts', 'writers'].map(async store => probeDatabase(next, 'getRaw', store, h.key)))).toEqual(before)
      expect(await probePipeline(next, 'mirrorSlots', h.key)).toEqual(slots)
      expect(await probeDatabase(next, 'getRaw', 'drafts', other)).toEqual(otherOriginal)
      expect(await probePipeline(next, 'read', id, h.key)).toMatchObject({ kind: 'draft', gzip: { text: 'new session content' } })
    }
    finally {
      await removeMirrorOf(page, h.user.id)
      await removeMirrorOf(next, h.user.id)
      await next.close()
      await expect.poll(async () => removeMirrorOf(page, h.user.id)).toBe('removed')
    }
  })

  test('清理先得锁：镜像删除期间登记和新激活等待；完成后旧宿主拒绝，新会话可以重新保存', async ({ profile: { page, context } }) => {
    const h = await setup(page)
    const next = await context.newPage()
    const permit = outcomeOf(await probePipeline(page, 'beginCleanup', 'account_disabled'), 'clearing').permit
    await probePipeline(page, 'release', h.id, h.key)
    await probePipeline(page, 'pauseCleanup')
    const cleaning = probePipeline(page, 'cleanupUser', permit)
    try {
      await expect.poll(async () => probePipeline(page, 'cleanupPaused')).toBe(true)
      expect(await probeDatabase(page, 'getRaw', 'writers', h.key)).toMatchObject({ writerId: 'retired' })
      const registering = probePipeline(page, 'register', h.id, { ...h.key, documentId: randomUUID() }, h.writer, true)
      await loginThroughApi(next, h.user)
      const activating = openOutboxProbe(next)
      await expect.poll(async () => page.evaluate(async () => (await navigator.locks.query()).pending?.length ?? 0)).toBeGreaterThanOrEqual(2)
      expect(await probeDatabase(page, 'getRaw', 'sessions', 'current')).toMatchObject({ state: { phase: 'clearing', generation: permit.generation } })
      await probePipeline(page, 'resumeCleanup')
      expect(await cleaning).toEqual({ kind: 'cleared', pending: [] })
      expect(await registering).toMatchObject({ kind: 'session-invalid' })
      await activating
      expect(await probeDatabase(page, 'getRaw', 'drafts', h.key)).toBeNull()
      await probe(next, 'chooseKey', 1, RAW_KEY)
      const id = await worker(next)
      const newer = writerOf(4)
      expect((await probePipeline(next, 'register', id, h.key, newer, true)).kind).toBe('registered')
      expect((await probePipeline(next, 'write', id, { ...h.capture, writer: newer, draftSeq: 1, content: 'after cleanup' })).kind).toBe('written')
      expect(await probePipeline(page, 'cleanupUser', permit)).toEqual({ kind: 'invalidated' })
      expect(await probePipeline(next, 'read', id, h.key)).toMatchObject({ kind: 'draft', gzip: { text: 'after cleanup' } })
    }
    finally {
      await probePipeline(page, 'resumeCleanup')
      await cleaning
      await removeMirrorOf(page, h.user.id)
      await removeMirrorOf(next, h.user.id)
      await next.close()
      await expect.poll(async () => removeMirrorOf(page, h.user.id)).toBe('removed')
    }
  })

  test('清完与保留期回收之后仍保留退役代次，迟到 force 不能登记从未存在的文档', async ({ profile: { page } }) => {
    const h = await setup(page)
    try {
      await probePipeline(page, 'release', h.id, h.key)
      const permit = outcomeOf(await probePipeline(page, 'beginCleanup', 'logout'), 'clearing').permit
      expect(await probePipeline(page, 'cleanupUser', permit)).toEqual({ kind: 'cleared', pending: [] })
      const state = outcomeOf(await fence(page, 'read'), 'state').state
      expect(state).toMatchObject({ phase: 'cleared', cause: 'logout' })
      expect((await probePipeline(page, 'cleanupExpired', Date.now() + 15 * 24 * 60 * 60 * 1000)).kind).toBe('purged')
      expect(outcomeOf(await fence(page, 'read'), 'state').state).toEqual(state)
      expect(await probePipeline(page, 'register', h.id, { ...h.key, documentId: randomUUID() }, h.writer, true)).toMatchObject({ kind: 'session-invalid' })
      expect(await probePipeline(page, 'read', h.id, h.key)).toEqual({ kind: 'session-invalid' })
      expect(await probeDatabase(page, 'getRaw', 'drafts', h.key)).toBeNull()
      expect(await probePipeline(page, 'cleanupUser', permit)).toEqual({ kind: 'invalidated' })
    }
    finally {
      await expect.poll(async () => removeMirrorOf(page, h.user.id)).toBe('removed')
    }
  })
})
