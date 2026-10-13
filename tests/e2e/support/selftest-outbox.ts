// 自检使用真实登录身份后，其随机文档收尾不能删除同一账户原有的草稿。
import type { Page } from '@playwright/test'
import type { SelftestStep } from './selftest-plan.ts'
import { randomUUID } from 'node:crypto'
import { expect } from './fixtures.ts'
import { draftFor, openOutboxProbe, probe, probeDatabase, writerOf } from './outbox-probe.ts'
import { loginThroughApi } from './session.ts'

export async function preserveUnrelatedDraft(page: Page, step: SelftestStep): Promise<() => Promise<void>> {
  if (step.scenario !== 'outbox-stall' && step.scenario !== 'outbox-pipeline')
    return async () => {}
  await loginThroughApi(page, step.account)
  const response = await page.request.get('/api/auth/session')
  expect(response.ok()).toBe(true)
  const session = await response.json() as { readonly user: { readonly id: string } }
  const key = { userId: session.user.id, documentId: randomUUID() }
  const writer = writerOf(1)
  await openOutboxProbe(page)
  await probe(page, 'chooseKey', 1)
  expect((await probe(page, 'register', key, writer, { now: Date.now(), force: false })).kind).toBe('registered')
  expect((await probe(page, 'write', draftFor(key, writer, 1))).kind).toBe('written')
  const original = await Promise.all(['drafts', 'writers'].map(async store => probeDatabase(page, 'getRaw', store, key)))
  return async () => {
    await openOutboxProbe(page)
    expect(await Promise.all(['drafts', 'writers'].map(async store => probeDatabase(page, 'getRaw', store, key)))).toEqual(original)
    expect((await probe(page, 'remove', key, 1)).kind).toBe('removed')
  }
}
