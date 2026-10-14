// 失效回包的原票据在真实 strict 事务内比较；网络绑定由 client/session-activation 的单元与真实用户链路覆盖。
import type { Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { draftFor, openOutboxProbe, outcomeOf, probe, probeDatabase, writerOf } from '../../support/outbox-probe.ts'
import { fence } from '../../support/session-fence-probe.ts'
import { loginThroughApi } from '../../support/session.ts'

async function prepare(page: Page) {
  const user = await createUser('ob-reject')
  await loginThroughApi(page, user)
  await openOutboxProbe(page)
  await probe(page, 'chooseKey', 1)
  const ticket = outcomeOf(await fence(page, 'begin', 'query'), 'ticket').ticket
  const key = { userId: user.id, documentId: randomUUID() }
  await probeDatabase(page, 'seedDraft', draftFor(key, writerOf(3), 1))
  return { user, ticket, key, original: await probeDatabase(page, 'getRaw', 'drafts', key) }
}

test.describe('失败查询的持久来源绑定', { tag: '@test-build' }, () => {
  for (const nextUser of ['same', 'other'] as const) {
    test(`新登录 ${nextUser} 已激活，旧停用/过期回包不修改新状态和草稿`, async ({ page }) => {
      const { user, ticket, key, original } = await prepare(page)
      const mutation = outcomeOf(await fence(page, 'begin', 'mutation'), 'ticket').ticket
      const permit = outcomeOf(await fence(page, 'accept', mutation, { userId: nextUser === 'same' ? user.id : randomUUID(), sourceHash: 'b'.repeat(64) }), 'active').permit
      const state = await fence(page, 'read')
      await probe(page, 'recordTransactions')
      expect(await fence(page, 'reject', ticket, { kind: 'disabled', userId: user.id })).toEqual({ kind: 'invalidated' })
      expect(await fence(page, 'reject', ticket, { kind: 'preserve' })).toEqual({ kind: 'invalidated' })
      expect(await fence(page, 'reject', mutation, { kind: 'disabled', userId: user.id }), '失败不能复用 activatedFrom').toEqual({ kind: 'invalidated' })
      expect(await probe(page, 'transactions')).toEqual(Array.from({ length: 3 }, () => ({ stores: ['sessions'], mode: 'readwrite', durability: 'strict' })))
      expect(await fence(page, 'read')).toEqual(state)
      expect(permit.generation).not.toBe(ticket.generation)
      expect(await probeDatabase(page, 'getRaw', 'drafts', key)).toEqual(original)
    })
  }

  test('匹配的停用先提交 clearing；关闭连接再读仍有资格，旧写入立即被挡', async ({ page }) => {
    const { user, ticket, key, original } = await prepare(page)
    await probe(page, 'recordTransactions')
    const result = outcomeOf(await fence(page, 'reject', ticket, { kind: 'disabled', userId: user.id }), 'clearing')
    expect(result.previous).toEqual({ userId: user.id, generation: ticket.generation })
    expect(result.permit.generation).not.toBe(ticket.generation)
    expect(await probe(page, 'transactions')).toEqual([{ stores: ['sessions'], mode: 'readwrite', durability: 'strict' }])
    await fence(page, 'close')
    expect(outcomeOf(await fence(page, 'read'), 'state').state).toMatchObject({ phase: 'clearing', generation: result.permit.generation, cause: 'account_disabled' })
    expect(await probe(page, 'write', draftFor(key, writerOf(3), 2))).toEqual({ kind: 'session-invalid' })
    expect(await probeDatabase(page, 'getRaw', 'drafts', key), '先阻止旧写入，再由清理协调器删除').toEqual(original)
  })

  test('认证失败只暂停，其他账户停用不能替原账户取得删除资格', async ({ page }) => {
    const { ticket, key, original } = await prepare(page)
    expect(await fence(page, 'reject', ticket, { kind: 'disabled', userId: randomUUID() })).toEqual({ kind: 'invalidated' })
    expect(await fence(page, 'reject', ticket, { kind: 'preserve' })).toEqual({ kind: 'stopped', previous: { userId: key.userId, generation: ticket.generation } })
    expect(outcomeOf(await fence(page, 'read'), 'state').state).toMatchObject({ phase: 'suspended' })
    expect(await probeDatabase(page, 'getRaw', 'drafts', key)).toEqual(original)
  })

  test('失败查询不能穿过正在进行的登录；未知持久格式失败关闭而不覆盖原行', async ({ page }) => {
    const { user, key, original } = await prepare(page)
    await fence(page, 'begin', 'mutation')
    const ticket = outcomeOf(await fence(page, 'begin', 'query'), 'ticket').ticket
    expect(await fence(page, 'reject', ticket, { kind: 'disabled', userId: user.id })).toEqual({ kind: 'invalidated' })
    const raw = { slot: 'current', state: { phase: 'future', generation: randomUUID() } }
    await probeDatabase(page, 'putRaw', 'sessions', raw)
    expect(await fence(page, 'reject', ticket, { kind: 'disabled', userId: user.id })).toMatchObject({ kind: 'failed' })
    expect(await probeDatabase(page, 'getRaw', 'sessions', 'current')).toEqual(raw)
    expect(await probeDatabase(page, 'getRaw', 'drafts', key)).toEqual(original)
  })

  test('清理资格事务中止，不交出许可、不改变原状态和原件', async ({ page }) => {
    const { user, ticket, key, original } = await prepare(page)
    const state = await fence(page, 'read')
    await page.evaluate(() => {
      const original: typeof IDBObjectStore.prototype.put = Reflect.get(IDBObjectStore.prototype, 'put')
      IDBObjectStore.prototype.put = function (...args) {
        const request = Reflect.apply(original, this, args)
        if (this.name === 'sessions') {
          IDBObjectStore.prototype.put = original
          request.addEventListener('success', () => this.transaction.abort(), { once: true })
        }
        return request
      }
    })
    expect(await fence(page, 'reject', ticket, { kind: 'disabled', userId: user.id })).toMatchObject({ kind: 'failed' })
    expect(await fence(page, 'read')).toEqual(state)
    expect(await probeDatabase(page, 'getRaw', 'drafts', key)).toEqual(original)
  })
})
