// P4-S2：用真实 IndexedDB 核对加法升级与会话资格。探针调用生产实现，不使用内存库代替事务交错。
import type { Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { contentOf, draftFor, openOutboxProbe, outcomeOf, probe, probeDatabase, writerOf } from '../../support/outbox-probe.ts'
import { fence } from '../../support/session-fence-probe.ts'
import { loginThroughApi } from '../../support/session.ts'

async function failNextSessionWrite(page: Page, failure: 'quota' | 'abort') {
  await page.evaluate((failure) => {
    const original: typeof IDBObjectStore.prototype.put = Reflect.get(IDBObjectStore.prototype, 'put')
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name !== 'sessions')
        return Reflect.apply(original, this, args)
      IDBObjectStore.prototype.put = original
      if (failure === 'quota')
        throw new DOMException('会话状态写入配额失败', 'QuotaExceededError')
      const request = Reflect.apply(original, this, args)
      request.addEventListener('success', () => this.transaction.abort(), { once: true })
      return request
    }
  }, failure)
}

test.describe('本机草稿的会话资格', { tag: '@test-build' }, () => {
  test('v1 加法升级只增加会话仓库，原密文、写入者高水位与提示逐字段保留', async ({ page }) => {
    const user = await createUser('ob-session-v1')
    await loginThroughApi(page, user)
    await openOutboxProbe(page, { authorize: false })
    await probe(page, 'chooseKey', 1)
    const key = { userId: user.id, documentId: randomUUID() }
    const writer = writerOf(7)
    await probeDatabase(page, 'seedVersionOne', draftFor(key, writer, 11))
    expect((await probeDatabase(page, 'describe'))?.version).toBe(1)
    const names = ['drafts', 'writers', 'notices']
    const before = await Promise.all(names.map(async name => probeDatabase(page, 'getRaw', name, key)))
    const query = outcomeOf(await fence(page, 'begin', 'query'), 'ticket').ticket
    const permit = outcomeOf(await fence(page, 'accept', query, { userId: user.id, sourceHash: '1'.repeat(64) }), 'active').permit
    expect(await probe(page, 'bindSession', permit)).toEqual({ kind: 'bound' })
    expect(outcomeOf(await probe(page, 'read', key), 'draft').opened).toEqual({ kind: 'opened', content: contentOf(writer, 11) })
    expect(await probeDatabase(page, 'describe')).toEqual({
      version: 2,
      stores: [
        { name: 'drafts', keyPath: ['userId', 'documentId'], indexes: [] },
        { name: 'notices', keyPath: ['userId', 'documentId'], indexes: [] },
        { name: 'sessions', keyPath: 'slot', indexes: [] },
        { name: 'writers', keyPath: ['userId', 'documentId'], indexes: [] },
      ],
    })
    expect(await Promise.all(names.map(async name => probeDatabase(page, 'getRaw', name, key)))).toEqual(before)
  })

  test('并发初查共享一次激活；持久状态的读写使用独立 strict 事务', async ({ page }) => {
    const user = await createUser('ob-session-share')
    await loginThroughApi(page, user)
    await openOutboxProbe(page, { authorize: false })
    await probe(page, 'recordTransactions')
    expect(await fence(page, 'read')).toEqual({ kind: 'state', state: undefined })
    const checks = await Promise.all([fence(page, 'begin', 'query'), fence(page, 'begin', 'query')])
    const tickets = checks.map(check => outcomeOf(check, 'ticket').ticket)
    expect(tickets[1]).toEqual(tickets[0])
    const ticket = tickets[0]!
    const source = { userId: user.id, sourceHash: '1'.repeat(64) }
    const permit = outcomeOf(await fence(page, 'accept', ticket, source), 'active').permit
    expect(permit.generation).not.toBe(ticket.generation)
    expect(await fence(page, 'accept', tickets[1]!, source)).toEqual({ kind: 'active', permit })
    expect(await fence(page, 'read')).toEqual({ kind: 'state', state: {
      phase: 'active',
      generation: permit.generation,
      activatedFrom: ticket.generation,
      source,
    } })
    const transactions = await probe(page, 'transactions')
    expect(transactions.length).toBeGreaterThan(0)
    for (const tx of transactions) {
      expect(tx.stores).toEqual(['sessions'])
      expect(tx.durability).toBe(tx.mode === 'readwrite' ? 'strict' : undefined)
    }
  })

  test('登录变更使旧查询和旧许可失效；变更中的查询不能抢先激活', async ({ page }) => {
    const user = await createUser('ob-session-change')
    await loginThroughApi(page, user)
    await openOutboxProbe(page, { authorize: false })
    const oldQuery = outcomeOf(await fence(page, 'begin', 'query'), 'ticket').ticket
    const oldSource = { userId: user.id, sourceHash: '1'.repeat(64) }
    const oldPermit = outcomeOf(await fence(page, 'accept', oldQuery, oldSource), 'active').permit
    const mutation = outcomeOf(await fence(page, 'begin', 'mutation'), 'ticket').ticket
    expect(await fence(page, 'accept', oldQuery, oldSource)).toEqual({ kind: 'session-invalid' })
    const during = outcomeOf(await fence(page, 'begin', 'query'), 'ticket').ticket
    expect(await fence(page, 'accept', during, oldSource)).toEqual({ kind: 'session-invalid' })
    const source = { userId: randomUUID(), sourceHash: '2'.repeat(64) }
    const permit = outcomeOf(await fence(page, 'accept', mutation, source), 'active').permit
    expect(await fence(page, 'suspend', oldPermit)).toEqual({ kind: 'session-invalid' })
    expect(await fence(page, 'fail', oldQuery)).toEqual({ kind: 'session-invalid' })
    expect(outcomeOf(await fence(page, 'read'), 'state').state).toEqual({
      phase: 'active',
      generation: permit.generation,
      activatedFrom: mutation.generation,
      source,
    })
  })

  test('删库后生成新的初查代次，旧票据不会因重新建库复活', async ({ page }) => {
    const user = await createUser('ob-session-delete')
    await loginThroughApi(page, user)
    await openOutboxProbe(page, { authorize: false })
    const oldTicket = outcomeOf(await fence(page, 'begin', 'query'), 'ticket').ticket
    const source = { userId: user.id, sourceHash: '3'.repeat(64) }
    const oldPermit = outcomeOf(await fence(page, 'accept', oldTicket, source), 'active').permit
    expect(await probeDatabase(page, 'remove', 2000)).toBe('deleted')
    const ticket = outcomeOf(await fence(page, 'begin', 'query'), 'ticket').ticket
    expect([oldTicket.generation, oldPermit.generation]).not.toContain(ticket.generation)
    expect(await fence(page, 'accept', oldTicket, source)).toEqual({ kind: 'session-invalid' })
    const permit = outcomeOf(await fence(page, 'accept', ticket, source), 'active').permit
    expect(permit).not.toEqual(oldPermit)
  })

  test('清理状态跨连接保留；同人新登录后旧清理的完成回包不能覆盖新状态', async ({ page }) => {
    const user = await createUser('ob-session-clean')
    await loginThroughApi(page, user)
    await openOutboxProbe(page, { authorize: false })
    const source = { userId: user.id, sourceHash: '4'.repeat(64) }
    const ticket = outcomeOf(await fence(page, 'begin', 'query'), 'ticket').ticket
    const permit = outcomeOf(await fence(page, 'accept', ticket, source), 'active').permit
    const cleanup = outcomeOf(await fence(page, 'beginCleanup', permit, 'logout'), 'clearing').permit
    await fence(page, 'close')
    expect(outcomeOf(await fence(page, 'read'), 'state').state).toEqual({
      phase: 'clearing',
      generation: cleanup.generation,
      source,
      cause: 'logout',
    })
    const retiredQuery = outcomeOf(await fence(page, 'begin', 'query'), 'ticket').ticket
    expect(await fence(page, 'accept', retiredQuery, source)).toEqual({ kind: 'session-invalid' })
    const login = outcomeOf(await fence(page, 'begin', 'mutation'), 'ticket').ticket
    const nextSource = { userId: user.id, sourceHash: '5'.repeat(64) }
    const next = outcomeOf(await fence(page, 'accept', login, nextSource), 'active').permit
    expect(await fence(page, 'finishCleanup', cleanup)).toEqual({ kind: 'session-invalid' })
    expect(outcomeOf(await fence(page, 'read'), 'state').state).toEqual({
      phase: 'active',
      generation: next.generation,
      activatedFrom: login.generation,
      source: nextSource,
    })
  })

  test('未决登录到期后必须重新查会话，已到期的旧登录回包不能激活', async ({ page }) => {
    const user = await createUser('ob-session-orphan')
    await loginThroughApi(page, user)
    await openOutboxProbe(page, { authorize: false })
    const orphan = outcomeOf(await fence(page, 'begin', 'mutation'), 'ticket').ticket
    await fence(page, 'advance', 60_000)
    const query = outcomeOf(await fence(page, 'begin', 'query'), 'ticket').ticket
    expect(query.generation).not.toBe(orphan.generation)
    const source = { userId: user.id, sourceHash: '6'.repeat(64) }
    expect(await fence(page, 'accept', orphan, source)).toEqual({ kind: 'session-invalid' })
    expect((await fence(page, 'accept', query, source)).kind).toBe('active')
  })

  test('畸形或未知会话状态不会被当成空库重新激活，也不会被覆盖', async ({ page }) => {
    const user = await createUser('ob-session-invalid')
    await loginThroughApi(page, user)
    await openOutboxProbe(page, { authorize: false })
    outcomeOf(await fence(page, 'begin', 'query'), 'ticket')
    const raw = { slot: 'current', state: { phase: 'future', generation: randomUUID() } }
    await probeDatabase(page, 'putRaw', 'sessions', raw)
    expect((await fence(page, 'begin', 'query')).kind).toBe('failed')
    expect((await fence(page, 'read')).kind).toBe('failed')
    expect(await probeDatabase(page, 'getRaw', 'sessions', 'current')).toEqual(raw)
  })

  test('存储缺失、被禁止或版本更新时如实返回不可用，不返回会话资格', async ({ page }) => {
    const user = await createUser('ob-session-unavailable')
    await loginThroughApi(page, user)
    await openOutboxProbe(page, { authorize: false })
    await fence(page, 'reset', { factory: 'missing' })
    expect(await fence(page, 'begin', 'query')).toEqual({ kind: 'unavailable', reason: 'unsupported' })
    await fence(page, 'reset', { factory: 'throws' })
    expect(await fence(page, 'begin', 'mutation')).toEqual({ kind: 'unavailable', reason: 'denied' })
    await fence(page, 'reset')
    outcomeOf(await fence(page, 'begin', 'query'), 'ticket')
    expect(await probeDatabase(page, 'upgrade', 3, 2000)).toBe('upgraded')
    expect(await fence(page, 'begin', 'query')).toEqual({ kind: 'unavailable', reason: 'newer-version' })
  })

  test('旧连接挡住会话仓库升级时不取得资格，连接放开后才能开始初查', async ({ page }) => {
    const user = await createUser('ob-session-blocked')
    await loginThroughApi(page, user)
    await openOutboxProbe(page, { authorize: false })
    const held = await probeDatabase(page, 'hold', 1)
    await fence(page, 'reset', { blockedTimeoutMs: 100 })
    try {
      expect(await fence(page, 'begin', 'query')).toEqual({ kind: 'unavailable', reason: 'blocked' })
    }
    finally {
      await probeDatabase(page, 'release', held)
    }
    expect(outcomeOf(await fence(page, 'begin', 'query'), 'ticket').ticket.generation).toMatch(/^[\da-f-]{36}$/)
  })

  test('失败登录与暂停都要求新查询；已完成清理的来源永久保留退役事实', async ({ page }) => {
    const user = await createUser('ob-session-lifecycle')
    await loginThroughApi(page, user)
    await openOutboxProbe(page, { authorize: false })
    const source = { userId: user.id, sourceHash: 'c'.repeat(64) }
    const mutation = outcomeOf(await fence(page, 'begin', 'mutation'), 'ticket').ticket
    expect(await fence(page, 'fail', mutation)).toEqual({ kind: 'released' })
    expect(await fence(page, 'accept', mutation, source)).toEqual({ kind: 'session-invalid' })
    const query = outcomeOf(await fence(page, 'begin', 'query'), 'ticket').ticket
    const permit = outcomeOf(await fence(page, 'accept', query, source), 'active').permit
    expect(await fence(page, 'suspend', permit)).toEqual({ kind: 'suspended' })
    expect(await fence(page, 'accept', query, source)).toEqual({ kind: 'session-invalid' })
    const fresh = outcomeOf(await fence(page, 'begin', 'query'), 'ticket').ticket
    const next = outcomeOf(await fence(page, 'accept', fresh, source), 'active').permit
    const cleanup = outcomeOf(await fence(page, 'beginCleanup', next, 'account_disabled'), 'clearing').permit
    expect(await fence(page, 'finishCleanup', cleanup)).toEqual({ kind: 'cleared' })
    await fence(page, 'close')
    const state = outcomeOf(await fence(page, 'read'), 'state').state
    expect(state).toMatchObject({ phase: 'cleared', source, cause: 'account_disabled' })
    expect(state?.generation).not.toBe(cleanup.generation)
    const retired = outcomeOf(await fence(page, 'begin', 'query'), 'ticket').ticket
    expect(await fence(page, 'accept', retired, source)).toEqual({ kind: 'session-invalid' })
  })

  for (const failure of ['quota', 'abort'] as const) {
    test(`清理状态写入 ${failure} 时不交回许可或清空成功，事务完整回滚`, async ({ page }) => {
      const user = await createUser(`ob-session-${failure}`)
      await loginThroughApi(page, user)
      await openOutboxProbe(page, { authorize: false })
      const source = { userId: user.id, sourceHash: 'd'.repeat(64) }
      const query = outcomeOf(await fence(page, 'begin', 'query'), 'ticket').ticket
      const permit = outcomeOf(await fence(page, 'accept', query, source), 'active').permit
      const before = await fence(page, 'read')
      await failNextSessionWrite(page, failure)
      expect((await fence(page, 'beginCleanup', permit, 'logout')).kind).toBe(failure === 'quota' ? 'quota' : 'failed')
      expect(await fence(page, 'read')).toEqual(before)
      const cleanup = outcomeOf(await fence(page, 'beginCleanup', permit, 'logout'), 'clearing').permit
      const clearing = await fence(page, 'read')
      await failNextSessionWrite(page, failure)
      expect((await fence(page, 'finishCleanup', cleanup)).kind).toBe(failure === 'quota' ? 'quota' : 'failed')
      expect(await fence(page, 'read')).toEqual(clearing)
      expect(await fence(page, 'finishCleanup', cleanup)).toEqual({ kind: 'cleared' })
    })
  }
})
