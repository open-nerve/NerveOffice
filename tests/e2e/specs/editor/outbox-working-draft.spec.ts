// S3：生产宿主、资格准备与两种内容来源在真实 Worker/IDB 上的契约。
import type { Page } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { openOutboxProbe, probe, probeDatabase, removeMirrorOf } from '../../support/outbox-probe.ts'
import { probeSession } from '../../support/outbox-session-probe.ts'
import { loginThroughApi } from '../../support/session.ts'
import { probeWorking } from '../../support/working-draft-probe.ts'

let ownerId: string | undefined

test.afterEach(async ({ page }) => {
  if (ownerId !== undefined)
    await probeWorking(page, 'disposeAll')
  if (ownerId !== undefined)
    await removeMirrorOf(page, ownerId)
  ownerId = undefined
})

test.describe('工作草稿来源的浏览器契约', { tag: '@test-build' }, () => {
  for (const mode of ['worker', 'initial-failure', 'memory'] as const) {
    test(`${mode} 同步序号 → 固定上传 → 新捕获带未知请求 → 旧确认 → 释放后上传新内容`, async ({ page }) => {
      const draft = await prepare(page)
      const { id } = await probeWorking(page, 'create', { draft, mode })
      const first = await probeWorking(page, 'capture', id, '原上传 😀', 90)
      expect(first).toMatchObject({ serial: 1, draftSeq: 1, editorSeq: 90 })
      expect(await probeWorking(page, 'ready', id, first.serial)).toMatchObject({ kind: 'ready', local: { kind: mode === 'memory' ? 'memory' : 'persisted' } })
      const upload = await probeWorking(page, 'prepare', id, first.serial)
      expect(upload).toMatchObject({ kind: 'prepared', contentSeq: 1, baseRevision: 7, text: '原上传 😀' })
      const inFlight = { requestId: randomUUID(), clientInstanceId: randomUUID(), localSeq: 1, sentAt: Date.now() }
      expect(await probeWorking(page, 'markInFlight', id, inFlight)).toMatchObject({ kind: mode === 'memory' ? 'memory' : 'resealed' })
      const second = await probeWorking(page, 'capture', id, '原上传 😀', 0)
      expect(await probeWorking(page, 'ready', id, second.serial)).toMatchObject({ contentSeq: 2 })
      expect(await probe(page, 'read', draft)).toMatchObject(mode === 'memory' ? { kind: 'absent' } : { meta: { draftSeq: 2, inFlight } })
      const latest = await probeWorking(page, 'capture', id, '继续编辑的内容', 1)
      await probeWorking(page, 'ready', id, latest.serial)
      expect(await probeWorking(page, 'prepare', id, first.serial)).toEqual(upload)
      expect(await probeWorking(page, 'confirm', id, 8)).toMatchObject({ kind: mode === 'memory' ? 'memory' : 'rebased' })
      expect(await probeWorking(page, 'readLatest', id)).toMatchObject({ ref: latest, snapshot: '继续编辑的内容' })
      await probeWorking(page, 'release', id)
      expect(await probeWorking(page, 'prepare', id, latest.serial)).toMatchObject({ contentSeq: 3, baseRevision: 8, text: '继续编辑的内容' })
      expect(await probeWorking(page, 'confirm', id, 9)).toMatchObject({ kind: mode === 'memory' ? 'memory' : 'deleted' })
      await probeWorking(page, 'release', id)
      expect(await probeWorking(page, 'readLatest', id)).toMatchObject({ snapshot: '继续编辑的内容' })
      expect(await probeWorking(page, 'counts', id)).toEqual({ keys: mode === 'memory' ? 0 : 1, hosts: mode === 'memory' ? 0 : 1, confirmations: 0 })
    })
  }

  test('Worker 去重使用旧内容序号，确认删除后相同内容必须重新落盘', async ({ page }) => {
    const draft = await prepare(page)
    const { id } = await probeWorking(page, 'create', { draft, mode: 'worker' })
    const first = await probeWorking(page, 'capture', id, '相同内容', 2)
    await probeWorking(page, 'ready', id, first.serial)
    const same = await probeWorking(page, 'capture', id, '相同内容', 3)
    expect(await probeWorking(page, 'ready', id, same.serial)).toMatchObject({ contentSeq: 1 })
    expect(await probeWorking(page, 'prepare', id, same.serial)).toMatchObject({ contentSeq: 1, ref: { draftSeq: 2 }, text: '相同内容' })
    expect(await probeWorking(page, 'confirm', id, 8)).toEqual({ kind: 'deleted' })
    await probeWorking(page, 'release', id)
    expect(await probeWorking(page, 'readLatest', id)).toMatchObject({ snapshot: '相同内容' })
    const next = await probeWorking(page, 'capture', id, '相同内容', 4)
    expect(await probeWorking(page, 'ready', id, next.serial)).toMatchObject({ contentSeq: 3, local: { kind: 'persisted' } })
    expect(await probe(page, 'read', draft)).toMatchObject({ meta: { draftSeq: 3, baseRevision: 8 } })
  })

  test('无钥保留内存，换钥重写当前内容；暂停后恢复不覆盖已有草稿', async ({ page }) => {
    const draft = await prepare(page)
    const { id } = await probeWorking(page, 'create', { draft, mode: 'worker' })
    const first = await probeWorking(page, 'capture', id, '旧钥内容', 1)
    await probeWorking(page, 'ready', id, first.serial)
    expect(await probeWorking(page, 'setKey', id, 'none')).toMatchObject({ kind: 'key-set' })
    const missing = await probeWorking(page, 'capture', id, '无钥的新编辑', 2)
    expect(await probeWorking(page, 'ready', id, missing.serial)).toMatchObject({ local: { kind: 'memory', reason: 'no-key' } })
    await probe(page, 'chooseKey', 2)
    expect(await probeWorking(page, 'setKey', id, 'probe')).toMatchObject({ kind: 'key-set' })
    expect(await probe(page, 'read', draft)).toMatchObject({ opened: { content: '无钥的新编辑' }, meta: { keyVersion: 2, draftSeq: 3 } })
    await probeWorking(page, 'suspend', id)
    const paused = await probeWorking(page, 'capture', id, '暂停的新编辑', 3)
    expect(await probeWorking(page, 'ready', id, paused.serial)).toMatchObject({ local: { kind: 'memory', reason: 'paused' } })
    expect(await probeWorking(page, 'resume', id)).toMatchObject({ kind: 'memory', reason: 'existing-draft' })
    expect(await probeWorking(page, 'readLatest', id)).toMatchObject({ ref: paused, snapshot: '暂停的新编辑' })
    expect(await probe(page, 'read', draft)).toMatchObject({ opened: { content: '无钥的新编辑' }, meta: { draftSeq: 3 } })
  })

  test('进程内退路遇 IDB 写满，原文仍可上传且不声称落盘，下一次新捕获恢复', async ({ page }) => {
    const draft = await prepare(page)
    const { id } = await probeWorking(page, 'create', { draft, mode: 'initial-failure' })
    await probe(page, 'failTransactions', 1, 'QuotaExceededError')
    const failed = await probeWorking(page, 'capture', id, '写满时的内容', 1)
    expect(await probeWorking(page, 'ready', id, failed.serial)).toMatchObject({ local: { kind: 'memory', reason: 'quota' } })
    expect(await probeWorking(page, 'prepare', id, failed.serial)).toMatchObject({ text: '写满时的内容', digest: undefined })
    await probeWorking(page, 'release', id)
    const next = await probeWorking(page, 'capture', id, '下一次编辑', 2)
    expect(await probeWorking(page, 'ready', id, next.serial)).toMatchObject({ local: { kind: 'persisted' } })
  })

  test('Worker 运行中终止，当前内容经有界只读恢复读回，不重新登记或恢复写入', async ({ page }) => {
    const draft = await prepare(page)
    const { id } = await probeWorking(page, 'create', { draft, mode: 'worker' })
    const ref = await probeWorking(page, 'capture', id, '终止后仍能读回', 1)
    await probeWorking(page, 'ready', id, ref.serial)
    await page.clock.install()
    await probeWorking(page, 'terminate', id)
    await probeWorking(page, 'startRead', id)
    await page.clock.fastForward(15_000)
    expect(await probeWorking(page, 'readResult', id)).toMatchObject({ ref, snapshot: '终止后仍能读回' })
    expect(await probeWorking(page, 'counts', id)).toMatchObject({ hosts: 2, confirmations: 0 })
    expect(await probe(page, 'read', draft)).toMatchObject({ opened: { content: '终止后仍能读回' }, meta: { draftSeq: 1 } })
  })
})

async function prepare(page: Page) {
  const user = await createUser('working-draft')
  ownerId = user.id
  await loginThroughApi(page, user)
  await openOutboxProbe(page)
  await probe(page, 'chooseKey', 1)
  return { userId: user.id, documentId: randomUUID() }
}

test.describe('工作草稿的宿主与资格准备', { tag: '@test-build' }, () => {
  for (const mode of ['worker', 'initial-failure'] as const) {
    test(`${mode} 登记 → 写入 → 读回 → 上传标记 → 新内容 → 旧确认保留新内容 → 新确认删除，高水位保留`, async ({ page }) => {
      const draft = await prepare(page)
      const { id, result } = await probeSession(page, 'create', { draft, epoch: 3, mode })
      expect(result).toMatchObject({ kind: 'ready', lastDraftSeq: 0, hostKind: mode === 'worker' ? 'worker' : 'in-process' })
      const first = '第一份工作草稿 😀'
      expect(await probeSession(page, 'write', id, 1, first)).toEqual({ kind: 'written', text: first, digest: createHash('sha256').update(first).digest('hex') })
      expect(await probeSession(page, 'read', id)).toMatchObject({ kind: 'draft', text: first, meta: { draftSeq: 1, keyVersion: 1, writeEpoch: 3 } })
      const inFlight = { requestId: randomUUID(), clientInstanceId: randomUUID(), localSeq: 1, sentAt: Date.now() }
      expect(await probeSession(page, 'markInFlight', id, inFlight)).toEqual({ kind: 'resealed' })
      expect(await probeSession(page, 'write', id, 2, '第二份', inFlight)).toMatchObject({ kind: 'written' })
      expect(await probeSession(page, 'confirm', id, 1, 2)).toEqual({ kind: 'rebased' })
      expect(await probeSession(page, 'read', id)).toMatchObject({ kind: 'draft', text: '第二份', meta: { draftSeq: 2, baseRevision: 2, inFlight: null } })
      expect(await probeSession(page, 'confirm', id, 2, 3)).toEqual({ kind: 'deleted' })
      await probeSession(page, 'suspend', id)
      expect(await probeSession(page, 'resume', id)).toMatchObject({ kind: 'ready', lastDraftSeq: 2 })
      expect(await probeSession(page, 'counts', id)).toEqual({ keys: 2, hosts: 2, persists: 1, confirmations: 2 })
    })
  }

  for (const mode of ['disabled', 'no-locks', 'no-key'] as const) {
    test(`${mode} 不建立宿主，已有记录原样保留`, async ({ page }) => {
      const draft = await prepare(page)
      const existing = { ...draft, recordVersion: 99, marker: '不可覆盖' }
      expect(await probeDatabase(page, 'openWith', 1, 3_000)).toBe('connected')
      await probeDatabase(page, 'putRaw', 'drafts', existing)
      const { id, result } = await probeSession(page, 'create', { draft, epoch: 3, mode })
      expect(result).toMatchObject({ kind: 'memory', reason: mode === 'no-locks' ? 'unsupported' : mode })
      expect(await probeSession(page, 'write', id, 1, '不能落盘')).toMatchObject({ kind: 'failed' })
      expect(await probeSession(page, 'counts', id)).toEqual({ keys: mode === 'no-key' ? 1 : 0, hosts: 0, persists: mode === 'no-key' ? 1 : 0, confirmations: 0 })
      expect(await probeDatabase(page, 'getRaw', 'drafts', draft)).toEqual(existing)
      expect(await probeDatabase(page, 'getRaw', 'writers', draft)).toBeNull()
    })
  }

  test('旧钥停用后不能写入，新钥重封内容；暂停阻止新写入与确认，恢复保留已有草稿', async ({ page }) => {
    const draft = await prepare(page)
    const { id } = await probeSession(page, 'create', { draft, epoch: 3 })
    expect(await probeSession(page, 'write', id, 1, '保留我')).toMatchObject({ kind: 'written' })
    expect(await probeSession(page, 'setKey', id, 'none')).toEqual({ kind: 'key-set', notResealed: [] })
    expect(await probeSession(page, 'write', id, 2, '旧钥不得写')).toMatchObject({ kind: 'failed' })
    await probe(page, 'chooseKey', 2)
    expect(await probeSession(page, 'setKey', id, 'probe')).toEqual({ kind: 'key-set', notResealed: [] })
    expect(await probeSession(page, 'read', id)).toMatchObject({ kind: 'draft', text: '保留我', meta: { draftSeq: 1, keyVersion: 2 } })
    await probeSession(page, 'suspend', id)
    expect(await probeSession(page, 'write', id, 3, '暂停不得写')).toMatchObject({ kind: 'failed' })
    expect(await probeSession(page, 'confirm', id, 1, 2)).toMatchObject({ kind: 'failed' })
    expect(await probeSession(page, 'read', id)).toMatchObject({ kind: 'draft', text: '保留我' })
    expect(await probeSession(page, 'resume', id)).toMatchObject({ kind: 'memory', reason: 'existing-draft', existingKind: 'draft', lastDraftSeq: 1 })
    expect(await probe(page, 'read', draft)).toMatchObject({ kind: 'draft', opened: { kind: 'opened', content: '保留我' }, meta: { keyVersion: 2, draftSeq: 1 } })
  })

  test('运行中 Worker 被终止，15 秒后结束读取；不自动建退路，重试先核对并保留旧草稿', async ({ page }) => {
    const draft = await prepare(page)
    const { id } = await probeSession(page, 'create', { draft, epoch: 3 })
    expect(await probeSession(page, 'write', id, 1, '终止前写成')).toMatchObject({ kind: 'written' })
    await page.clock.install()
    await probeSession(page, 'terminate', id)
    await probeSession(page, 'startRead', id)
    await page.clock.fastForward(15_000)
    expect(await probeSession(page, 'readResult', id)).toEqual({ kind: 'failed' })
    expect(await probeSession(page, 'state', id)).toMatchObject({ kind: 'memory', reason: 'worker-failed' })
    expect(await probeSession(page, 'counts', id)).toEqual({ keys: 1, hosts: 1, persists: 1, confirmations: 0 })
    expect(await probeSession(page, 'resume', id)).toMatchObject({ kind: 'memory', reason: 'existing-draft', existingKind: 'draft' })
    expect(await probeSession(page, 'counts', id)).toEqual({ keys: 2, hosts: 2, persists: 1, confirmations: 2 })
    expect(await probe(page, 'read', draft)).toMatchObject({ kind: 'draft', opened: { kind: 'opened', content: '终止前写成' } })
  })
})
