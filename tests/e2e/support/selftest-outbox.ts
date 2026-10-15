// 自检使用真实登录身份后，其随机文档收尾不能删除同一账户原有的草稿。
import type { Page } from '@playwright/test'
import type { SelftestStep } from './selftest-plan.ts'
import { revisionOf } from './database.ts'
import { expect } from './fixtures.ts'
import { readLocalDisk } from './local-draft.ts'
import { recoverySnapshot, seedRecovery } from './local-recovery.ts'
import { openOutboxProbe, probe } from './outbox-probe.ts'
import { loginThroughApi } from './session.ts'
import { createSheetThroughApi, savedContent } from './sheet.ts'

export async function preserveUnrelatedDraft(page: Page, step: SelftestStep): Promise<() => Promise<void>> {
  if (step.scenario !== 'outbox-stall' && step.scenario !== 'outbox-pipeline')
    return async () => {}
  await loginThroughApi(page, step.account)
  const response = await page.request.get('/api/auth/session')
  expect(response.ok()).toBe(true)
  const session = await response.json() as { readonly user: { readonly id: string } }
  // P4 启动维护会正常清理不存在的文档和无法用真实密钥解开的记录。
  // 防误删对照必须是本人有权恢复的真实文档，不能靠随机 ID/随机密钥暂时躲过维护。
  const documentId = await createSheetThroughApi(page, '自检不得影响的现有草稿')
  const key = { userId: session.user.id, documentId }
  const cloud = await savedContent(page, documentId)
  const seeded = await seedRecovery(page, key, recoverySnapshot(cloud.text, '自检期间必须逐字节保留'))
  const original = await readLocalDisk(page, key)
  return async () => {
    await openOutboxProbe(page)
    expect(await readLocalDisk(page, key)).toEqual(original)
    expect(await revisionOf(documentId)).toBe(1)
    expect((await probe(page, 'remove', key, seeded.input.meta.draftSeq)).kind).toBe('removed')
  }
}
