// 只负责构造中断时已经存在的合法密文；随后关探针，恢复由真实页面/Worker/HTTP 完成。
import type { Page } from '@playwright/test'
import type { DraftKey, ProbeDraftInput } from './outbox-probe.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { CURRENT_CLIENT } from './client-format.ts'
import { expect } from './fixtures.ts'
import { currentLocalKey, diskGzip, diskSnapshot, readLocalDisk } from './local-draft.ts'
import { draftFor, openOutboxProbe, probe, probePipeline } from './outbox-probe.ts'

/** 在真实模板上改第一行，保留 unit、档案与资源；公式故意留旧结果，验证恢复时全量重算。 */
export function recoverySnapshot(text: string, value: string | number, formula = false): string {
  const book = JSON.parse(text) as { sheetOrder: string[], sheets: Record<string, { cellData: Record<string, Record<string, unknown>> }> }
  const sheet = book.sheets[book.sheetOrder[0] ?? '']
  if (sheet === undefined)
    throw new Error('缺少第一张工作表')
  sheet.cellData['0'] = { 0: { v: value, t: typeof value === 'number' ? 2 : 1 }, ...(formula ? { 1: { f: '=A1*2', v: 999, t: 2 } } : {}) }
  return JSON.stringify(book)
}

export async function seedRecovery(page: Page, key: DraftKey, snapshot: string, overrides: Partial<ProbeDraftInput['meta']> = {}) {
  await openOutboxProbe(page)
  const secret = await currentLocalKey(page)
  await probe(page, 'chooseKey', secret.version, Buffer.from(secret.key, 'base64').toString('hex'))
  const writer = { writeEpoch: overrides.writeEpoch ?? 1, writerId: randomUUID() }
  expect(await probe(page, 'register', key, writer, { now: Date.now(), force: false })).toMatchObject({ kind: 'registered' })
  const input = draftFor(key, writer, overrides.draftSeq ?? 37, { writtenBy: randomUUID(), format: CURRENT_CLIENT, updatedAt: Date.now(), ...overrides }, snapshot)
  expect(await probe(page, 'write', input)).toMatchObject({ kind: 'written' })
  const disk = (await readLocalDisk(page, key)).draft
  if (disk === null)
    throw new Error('夹具未写下草稿')
  expect(diskSnapshot(disk, secret)).toBe(snapshot)
  return { input, disk, gzip: diskGzip(disk, secret) }
}

/** 用真实生产 Worker 登记同一写入者，将夹具主库补写进 OPFS，再放开句柄供页面恢复。 */
export async function mirrorRecovery(page: Page, key: DraftKey, seeded: Awaited<ReturnType<typeof seedRecovery>>) {
  const { id, ready } = await probePipeline(page, 'create', { host: 'worker' })
  expect(ready).toEqual({ kind: 'ready' })
  expect(await probePipeline(page, 'setKey', id, 'probe')).toMatchObject({ kind: 'key-set' })
  const { writeEpoch, writerId } = seeded.input.meta
  expect(await probePipeline(page, 'register', id, key, { writeEpoch, writerId }, false)).toMatchObject({ kind: 'registered', mirror: { kind: 'mirrored' } })
  await probePipeline(page, 'dispose', id)
  await expect.poll(async () => probePipeline(page, 'mirrorSlots', key).then(slots => slots.some(slot => slot.kind === 'valid'), () => false)).toBe(true)
}
