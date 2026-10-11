// M4-P3-S2：生产 IndexedDB 的原子观察/采用/条件删除与真实 Worker 往返。
// 三页事务排队固定交错，不依赖计时；中止已执行 delete 的事务证明墓碑与原件没有部分提交。
import type { Page } from '@playwright/test'
import type { DraftKey, ProbeAdoption, ProbeRegisterOutcome, WriterIdentity } from '../../support/outbox-probe.ts'
import { randomBytes, randomUUID } from 'node:crypto'
import { createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { contentOf, draftFor, NOW, openOutboxProbe, outcomeOf, probe, probeDatabase, probePipeline, removeMirrorOf, writerOf } from '../../support/outbox-probe.ts'
import { loginThroughApi } from '../../support/session.ts'

async function setup(page: Page) {
  const user = await createUser('observed-recovery')
  await loginThroughApi(page, user)
  const second = await page.context().newPage()
  const raw = randomBytes(32).toString('hex')
  for (const tab of [page, second]) {
    await openOutboxProbe(tab)
    await probe(tab, 'chooseKey', 1, raw)
  }
  const key = { userId: user.id, documentId: randomUUID() }
  const writer = writerOf(3)
  expect((await register(page, key, writer)).kind).toBe('registered')
  expect(await probe(page, 'write', draftFor(key, writer, 41))).toEqual({ kind: 'written' })
  return { key, writer, second }
}

async function register(page: Page, key: DraftKey, writer: WriterIdentity) {
  return probe(page, 'register', key, writer, { now: NOW, force: false })
}

async function observe(page: Page, key: DraftKey) {
  return outcomeOf(await probe(page, 'observe', key), 'observed')
}

async function schedule(order: 'adopt-first' | 'register-first', startAdopt: () => Promise<number>, startRegister: () => Promise<{ readonly outcome: Promise<ProbeRegisterOutcome> }>) {
  if (order === 'adopt-first') {
    const operation = await startAdopt()
    return { operation, registering: await startRegister() }
  }
  const registering = await startRegister()
  return { operation: await startAdopt(), registering }
}

async function replaceDamaged(page: Page, key: DraftKey, replacement: 'draft' | 'newer-format' | 'malformed', original: Record<string, unknown> | null) {
  if (replacement === 'draft') {
    if (original === null)
      throw new Error('缺少原草稿')
    await probeDatabase(page, 'putRaw', 'drafts', original)
    await probeDatabase(page, 'patchDraft', key, { iv: (original.iv as { hex: string }).hex, ciphertext: (original.ciphertext as { hex: string }).hex })
  }
  else {
    await probeDatabase(page, 'putRaw', 'drafts', { ...key, ...(replacement === 'newer-format' ? { recordVersion: 99 } : { damaged: 'second' }) })
  }
  expect((await probe(page, 'read', key)).kind).toBe(replacement)
}

test.describe('观察之后的恢复动作', { tag: '@test-build' }, () => {
  for (const order of ['adopt-first', 'register-first'] as const) {
    test(`三页确定交错：${order}，比较与采用在同一个 strict 事务`, async ({ page }) => {
      const { key, writer, second } = await setup(page)
      const adopter = writerOf(4)
      expect(outcomeOf(await register(page, key, adopter), 'registered').lastDraftSeq).toBe(41)
      const observed = await observe(page, key)
      expect((await probe(second, 'read', key)).kind).toBe('draft')
      for (const tab of [page, second])
        await probe(tab, 'recordTransactions')
      const holder = await page.context().newPage()
      await openOutboxProbe(holder)
      const held = await probeDatabase(holder, 'holdTransaction')
      const next = writerOf(5)
      const startAdopt = async () => {
        const operation = await probe(page, 'startAdopt', observed.observation, draftFor(key, adopter, 42))
        await expect.poll(async () => (await probe(page, 'transactions')).length).toBe(1)
        return operation
      }
      const startRegister = async () => {
        const outcome = register(second, key, next)
        await expect.poll(async () => (await probe(second, 'transactions')).length).toBe(1)
        return { outcome }
      }
      const { operation, registering } = await schedule(order, startAdopt, startRegister)
      await probeDatabase(holder, 'releaseTransaction', held)
      expect(await probe(page, 'settled', operation)).toEqual(order === 'adopt-first' ? { kind: 'written' } : { kind: 'fenced', reason: 'changed' })
      const registered = outcomeOf(await registering.outcome, 'registered')
      expect(registered.lastDraftSeq).toBe(order === 'adopt-first' ? 42 : 41)
      const stored = outcomeOf(await probe(page, 'read', key), 'draft')
      expect(stored.opened).toEqual({ kind: 'opened', content: contentOf(order === 'adopt-first' ? adopter : writer, order === 'adopt-first' ? 42 : 41) })
      expect((await probe(page, 'transactions'))[0]).toEqual({ stores: ['drafts', 'writers'], mode: 'readwrite', durability: 'strict' })
    })
  }

  test('同序号重封换密文也使原观察失效，不能采用或删除', async ({ page }) => {
    const { key, writer, second } = await setup(page)
    const before = await observe(page, key)
    const flight = { requestId: randomUUID(), clientInstanceId: 'original-page', localSeq: 41, sentAt: NOW }
    expect(await probe(second, 'replace', draftFor(key, writer, 41, { inFlight: flight }))).toEqual({ kind: 'written' })
    const resealed = outcomeOf(await probe(second, 'read', key), 'draft')
    expect(resealed.ivHex).not.toBe(outcomeOf(before.record, 'draft').ivHex)
    expect(await probe(page, 'adopt', before.observation, draftFor(key, writer, 42))).toEqual({ kind: 'fenced', reason: 'changed' })
    expect(await probe(page, 'removeObserved', before.observation, NOW)).toEqual({ kind: 'changed' })
    expect(await probe(page, 'read', key)).toEqual(resealed)
  })

  for (const replacement of ['draft', 'newer-format', 'malformed'] as const) {
    test(`损坏记录被换成 ${replacement} 后，旧清理操作保留替换后的原件`, async ({ page }) => {
      const { key, second } = await setup(page)
      const original = await probeDatabase(page, 'getRaw', 'drafts', key)
      await probeDatabase(page, 'putRaw', 'drafts', { ...key, damaged: 'first' })
      const before = await observe(page, key)
      expect(before.record).toEqual({ kind: 'malformed' })
      await replaceDamaged(second, key, replacement, original)
      const expected = await probeDatabase(second, 'getRaw', 'drafts', key)
      expect(await probe(page, 'removeObserved', before.observation, NOW)).toEqual({ kind: 'changed' })
      expect(await probeDatabase(page, 'getRaw', 'drafts', key)).toEqual(expected)
    })
  }

  test('原件与墓碑同事务提交；新提示不被旧观察清掉，高水位保留', async ({ page }) => {
    const { key, writer } = await setup(page)
    await probeDatabase(page, 'putRaw', 'notices', { ...key, kind: 'restored', at: NOW })
    await probe(page, 'recordTransactions')
    const before = await observe(page, key)
    expect((await probe(page, 'transactions'))[0]).toEqual({ stores: ['drafts', 'writers', 'notices'], mode: 'readonly', durability: undefined })
    const notice = { ...key, kind: 'lost', at: NOW + 1 }
    await probeDatabase(page, 'putRaw', 'notices', notice)
    expect(await probe(page, 'removeObserved', before.observation, NOW + 2)).toEqual({ kind: 'removed' })
    expect(await probeDatabase(page, 'getRaw', 'drafts', key)).toBeNull()
    expect(await probeDatabase(page, 'getRaw', 'writers', key)).toMatchObject({ lastDraftSeq: 41, writerId: 'retired', writeEpoch: writer.writeEpoch, registeredAt: NOW + 2 })
    expect(await probeDatabase(page, 'getRaw', 'notices', key)).toEqual(notice)
    expect(await probe(page, 'write', draftFor(key, writer, 42))).toEqual({ kind: 'fenced', reason: 'not-writer' })
    expect(await probe(page, 'transactions')).toContainEqual({ stores: ['drafts', 'writers', 'notices'], mode: 'readwrite', durability: 'strict' })
    expect(outcomeOf(await register(page, key, writerOf(4)), 'registered').lastDraftSeq).toBe(41)
  })

  test('delete 已成功但事务中止时，原件/写入者/提示全数回滚，原凭证可以重试', async ({ page }) => {
    const { key } = await setup(page)
    const notice = { ...key, kind: 'restored', at: NOW }
    await probeDatabase(page, 'putRaw', 'notices', notice)
    const before = await observe(page, key)
    const original = await probeDatabase(page, 'getRaw', 'drafts', key)
    const writer = await probeDatabase(page, 'getRaw', 'writers', key)
    await probe(page, 'abortNextDraftDelete')
    expect(await probe(page, 'removeObserved', before.observation, NOW + 1)).toMatchObject({ kind: 'failed' })
    expect(await probeDatabase(page, 'getRaw', 'drafts', key)).toEqual(original)
    expect(await probeDatabase(page, 'getRaw', 'writers', key)).toEqual(writer)
    expect(await probeDatabase(page, 'getRaw', 'notices', key)).toEqual(notice)
    expect(await probe(page, 'removeObserved', before.observation, NOW + 2)).toEqual({ kind: 'removed' })
    expect(await probeDatabase(page, 'getRaw', 'notices', key)).toBeNull()
  })

  test('不变的损坏记录可以条件删除；跨宿主、换键和关闭后的凭证均失效', async ({ page }) => {
    const { key, second } = await setup(page)
    await probeDatabase(page, 'putRaw', 'drafts', { ...key, damaged: 'same' })
    const before = await observe(page, key)
    expect(await probe(second, 'removeObserved', before.observation, NOW)).toEqual({ kind: 'changed' })
    expect(await probe(page, 'removeObserved', { ...before.observation, key: { ...key, documentId: randomUUID() } }, NOW)).toEqual({ kind: 'changed' })
    await probe(page, 'close')
    expect(await probe(page, 'removeObserved', before.observation, NOW)).toEqual({ kind: 'changed' })
    const current = await observe(page, key)
    expect(await probe(page, 'removeObserved', current.observation, NOW)).toEqual({ kind: 'removed' })
  })
})

for (const host of ['worker', 'in-process'] as const) {
  test(`恢复管道 ${host}：真实交钥/字节往返、新序号新请求与条件清理`, { tag: '@test-build' }, async ({ page }) => {
    const { key } = await setup(page)
    try {
      const current = await probePipeline(page, 'create', { host })
      // create 的握手嵌在 ready 字段，管道编号不因恢复切换。
      expect(current.ready).toEqual({ kind: 'ready' })
      const id = current.id
      expect(await probePipeline(page, 'setKey', id, 'probe')).toEqual({ kind: 'key-set', notResealed: [] })
      const writer = writerOf(4)
      expect(outcomeOf(await probePipeline(page, 'register', id, key, writer, false), 'registered').lastDraftSeq).toBe(41)
      const before = outcomeOf(await probePipeline(page, 'observe', id, key), 'observed')
      const original = outcomeOf(before.record, 'draft')
      expect(original.gzip.text).toBeDefined()
      expect(Object.keys(before.observation).sort()).toEqual(['id', 'key'])
      const capture: ProbeAdoption = { key, writer, draftSeq: 42, baseRevision: 8, writtenBy: 'recovery-page', format: original.meta.format, formulasPending: true, content: '收齐后恢复的新正文' }
      const adopted = outcomeOf(await probePipeline(page, 'adopt', id, before.observation, capture), 'written')
      expect(adopted.gzip.text).toBe(capture.content)
      const read = outcomeOf(await probePipeline(page, 'read', id, key), 'draft')
      expect(read.gzip).toEqual(adopted.gzip)
      expect(read.meta).toMatchObject({ ...writer, draftSeq: 42, inFlight: null, baseRevision: 8, formulasPending: true })
      const now = outcomeOf(await probePipeline(page, 'observe', id, key), 'observed')
      expect(await probePipeline(page, 'removeObserved', id, now.observation)).toMatchObject({ kind: 'removed' })
      expect(await probePipeline(page, 'reconcileDocument', id, key)).toEqual({ kind: 'reconciled' })
      expect(await probePipeline(page, 'read', id, key)).toEqual({ kind: 'absent' })
      expect(await probeDatabase(page, 'getRaw', 'writers', key)).toMatchObject({ lastDraftSeq: 42, writerId: 'retired', writeEpoch: writer.writeEpoch })
    }
    finally {
      await removeMirrorOf(page, key.userId)
    }
  })
}
