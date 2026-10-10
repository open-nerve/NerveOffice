// S3：生产宿主与资格准备在真实 Worker/IDB 上的接缝。两种 WorkingDraft 来源的故事随后在同文件补齐。
import type { Page } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { openOutboxProbe, probe, probeDatabase, removeMirrorOf } from '../../support/outbox-probe.ts'
import { probeSession } from '../../support/outbox-session-probe.ts'
import { loginThroughApi } from '../../support/session.ts'

let ownerId: string | undefined

test.afterEach(async ({ page }) => {
  if (ownerId !== undefined)
    await removeMirrorOf(page, ownerId)
  ownerId = undefined
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
