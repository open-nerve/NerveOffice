// 会话已失效的旧存储仍持有真实写入者与原件观察：逐个核对事务入口，拒绝后原件不变。
import type { Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { contentOf, draftFor, NOW, openOutboxProbe, outcomeOf, probe, probeDatabase, writerOf } from '../../support/outbox-probe.ts'
import { fence } from '../../support/session-fence-probe.ts'
import { loginThroughApi } from '../../support/session.ts'

async function prepared(page: Page) {
  const user = await createUser('ob-session-writer')
  await loginThroughApi(page, user)
  await openOutboxProbe(page, { authorize: false })
  await probe(page, 'chooseKey', 1)
  const source = { userId: user.id, sourceHash: 'a'.repeat(64) }
  const ticket = outcomeOf(await fence(page, 'begin', 'query'), 'ticket').ticket
  const permit = outcomeOf(await fence(page, 'accept', ticket, source), 'active').permit
  expect(await probe(page, 'bindSession', permit)).toEqual({ kind: 'bound' })
  const key = { userId: user.id, documentId: randomUUID() }
  const nextKey = { userId: user.id, documentId: randomUUID() }
  const writer = writerOf(7)
  expect((await probe(page, 'register', key, writer, { now: NOW, force: false })).kind).toBe('registered')
  expect(await probe(page, 'write', draftFor(key, writer, 1))).toEqual({ kind: 'written' })
  const observation = outcomeOf(await probe(page, 'observe', key), 'observed').observation
  return { key, nextKey, writer, permit, source, observation }
}

type Prepared = Awaited<ReturnType<typeof prepared>>
const attempts = {
  新文档登记: async (page: Page, p: Prepared) => probe(page, 'register', p.nextKey, p.writer, { now: NOW, force: false }),
  强制登记: async (page: Page, p: Prepared) => probe(page, 'register', p.key, writerOf(8), { now: NOW, force: true }),
  写入: async (page: Page, p: Prepared) => probe(page, 'write', draftFor(p.key, p.writer, 2)),
  重封: async (page: Page, p: Prepared) => probe(page, 'replace', draftFor(p.key, p.writer, 1)),
  确认: async (page: Page, p: Prepared) => probe(page, 'confirm', p.key, p.writer, 1),
  读取: async (page: Page, p: Prepared) => probe(page, 'read', p.key),
  观察: async (page: Page, p: Prepared) => probe(page, 'observe', p.key),
  接手: async (page: Page, p: Prepared) => probe(page, 'adopt', p.observation, draftFor(p.key, p.writer, 2)),
  原件条件删除: async (page: Page, p: Prepared) => probe(page, 'removeObserved', p.observation, NOW),
  删除: async (page: Page, p: Prepared) => probe(page, 'remove', p.key, 1),
  列表: async (page: Page, p: Prepared) => probe(page, 'list', p.key.userId),
  镜像回写: async (page: Page, p: Prepared) => probe(page, 'restore', draftFor(p.nextKey, p.writer, 1), NOW),
  文档退役: async (page: Page, p: Prepared) => probe(page, 'retire', p.key, NOW),
  丢失提示: async (page: Page, p: Prepared) => probe(page, 'recordLost', p.nextKey, NOW),
  读取提示: async (page: Page, p: Prepared) => probe(page, 'listNotices', p.key.userId),
  清除提示: async (page: Page, p: Prepared) => probe(page, 'clearNotice', p.key),
}

async function rawRecords(page: Page, p: Prepared) {
  return Promise.all([p.key, p.nextKey].flatMap(key => ['drafts', 'writers', 'notices'].map(async name => probeDatabase(page, 'getRaw', name, key))))
}

test.describe('草稿事务的会话资格', { tag: '@test-build' }, () => {
  for (const [name, attempt] of Object.entries(attempts)) {
    test(`清理开始后旧存储的${name}被拒绝，原件与新文档均不变`, async ({ page }) => {
      const p = await prepared(page)
      const before = await rawRecords(page, p)
      outcomeOf(await fence(page, 'beginCleanup', p.permit, 'logout'), 'clearing')
      const state = await fence(page, 'read')
      expect(await attempt(page, p)).toEqual({ kind: 'session-invalid' })
      expect(await rawRecords(page, p)).toEqual(before)
      expect(await fence(page, 'read')).toEqual(state)
    })
  }

  test('用户操作在包含会话仓库的同一个事务内核对固定许可', async ({ page }) => {
    const p = await prepared(page)
    await probe(page, 'recordTransactions')
    expect(outcomeOf(await probe(page, 'read', p.key), 'draft').opened).toEqual({ kind: 'opened', content: contentOf(p.writer, 1) })
    expect(await probe(page, 'write', draftFor(p.key, p.writer, 2))).toEqual({ kind: 'written' })
    const transactions = await probe(page, 'transactions')
    expect(transactions.map(tx => [tx.stores.toSorted(), tx.mode, tx.durability])).toEqual([
      [['drafts', 'sessions', 'writers'], 'readonly', undefined],
      [['drafts', 'sessions', 'writers'], 'readwrite', 'strict'],
    ])
  })

  test('未绑定的存储不能读写，已有许可不能用于另一用户', async ({ page }) => {
    const p = await prepared(page)
    const foreign = { userId: randomUUID(), documentId: randomUUID() }
    expect(await probe(page, 'register', foreign, p.writer, { now: NOW, force: true })).toEqual({ kind: 'session-invalid' })
    expect(await probe(page, 'list', foreign.userId)).toEqual({ kind: 'session-invalid' })
    await probe(page, 'resetStore')
    expect(await probe(page, 'read', p.key)).toEqual({ kind: 'session-invalid' })
    expect(await probe(page, 'register', p.nextKey, p.writer, { now: NOW, force: true })).toEqual({ kind: 'session-invalid' })
    expect(await probe(page, 'bindSession', p.permit)).toEqual({ kind: 'bound' })
    expect((await probe(page, 'read', p.key)).kind).toBe('draft')
  })

  test('同人重登后旧存储不能改绑新许可，关连接也不能解除绑定', async ({ page }) => {
    const p = await prepared(page)
    const mutation = outcomeOf(await fence(page, 'begin', 'mutation'), 'ticket').ticket
    const permit = outcomeOf(await fence(page, 'accept', mutation, { ...p.source, sourceHash: 'b'.repeat(64) }), 'active').permit
    expect(await probe(page, 'bindSession', permit)).toEqual({ kind: 'session-invalid' })
    await probe(page, 'close')
    expect(await probe(page, 'bindSession', permit)).toEqual({ kind: 'session-invalid' })
    expect(await probe(page, 'write', draftFor(p.key, p.writer, 2))).toEqual({ kind: 'session-invalid' })
    await probe(page, 'resetStore')
    expect(await probe(page, 'bindSession', permit)).toEqual({ kind: 'bound' })
    expect(await probe(page, 'write', draftFor(p.key, p.writer, 2))).toEqual({ kind: 'written' })
  })

  test('删库后旧存储的迟到登记失败，新会话必须使用新存储实例', async ({ page }) => {
    const p = await prepared(page)
    expect(await probeDatabase(page, 'remove', 2000)).toBe('deleted')
    expect(await probe(page, 'register', p.nextKey, p.writer, { now: NOW, force: true })).toEqual({ kind: 'session-invalid' })
    const query = outcomeOf(await fence(page, 'begin', 'query'), 'ticket').ticket
    const permit = outcomeOf(await fence(page, 'accept', query, p.source), 'active').permit
    expect(await probe(page, 'bindSession', p.permit)).toEqual({ kind: 'session-invalid' })
    expect(await probe(page, 'bindSession', permit)).toEqual({ kind: 'session-invalid' })
    await probe(page, 'resetStore')
    expect(await probe(page, 'bindSession', permit)).toEqual({ kind: 'bound' })
    expect((await probe(page, 'register', p.nextKey, p.writer, { now: NOW, force: false })).kind).toBe('registered')
  })
})
