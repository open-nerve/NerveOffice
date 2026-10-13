import type { DraftObservation } from './draft-observation.ts'
import { describe, expect, it } from 'vitest'
import { NOW, sampleStoredDraft } from './draft-record.test-support.ts'
import { fakeDraftStore } from './draft-store.test-support.ts'
import { RETIRED_WRITER_ID } from './writer-fence.ts'

const RECORD = sampleStoredDraft()
const KEY = { userId: RECORD.userId, documentId: RECORD.documentId }
const WRITER = { ...KEY, writeEpoch: RECORD.writeEpoch + 1, writerId: 'recovery', lastDraftSeq: RECORD.draftSeq, registeredAt: NOW }
const NEXT = { ...RECORD, ...WRITER, draftSeq: RECORD.draftSeq + 1, inFlight: null, ciphertext: new Uint8Array(32).fill(3) }

async function setup(draft: unknown = RECORD) {
  const fake = fakeDraftStore()
  fake.putRaw('drafts', KEY, draft)
  fake.putRaw('writers', KEY, WRITER)
  const observed = await fake.store.observeDraft(KEY)
  if (observed.kind !== 'observed')
    throw new Error(`观察失败：${observed.kind}`)
  return { fake, observation: observed.observation, observed }
}

describe('观察凭证下的存储动作', () => {
  it('观察只读，接手写新正文并抬高水位，成功后凭证不能重用', async () => {
    const { fake, observation, observed } = await setup()
    expect(observed.record).toEqual({ kind: 'draft', draft: structuredClone(RECORD) })
    expect(observed.writer).toEqual(WRITER)
    expect(fake.rawDraft(KEY)).toEqual(structuredClone(RECORD))
    expect(fake.rawWriter(KEY)).toEqual(WRITER)
    expect(await fake.store.adoptObserved(observation, NEXT)).toEqual({ kind: 'written' })
    expect(fake.rawDraft(KEY)).toMatchObject({ draftSeq: NEXT.draftSeq, writerId: WRITER.writerId, ciphertext: structuredClone(NEXT.ciphertext), inFlight: null })
    expect(fake.rawWriter(KEY)).toMatchObject({ lastDraftSeq: NEXT.draftSeq })
    expect(await fake.store.removeObserved(observation, NOW)).toEqual({ kind: 'changed' })
    expect(await fake.store.adoptObserved(observation, { ...NEXT, draftSeq: NEXT.draftSeq + 1 })).toEqual({ kind: 'fenced', reason: 'changed' })
  })

  it.each(['adopt', 'remove'] as const)('仅登记新写入者但还没写正文，也拦下旧 %s', async (action) => {
    const { fake, observation } = await setup()
    const held = fake.holdNext(action === 'adopt' ? 'adoptObserved' : 'removeObserved')
    const pending = action === 'adopt' ? fake.store.adoptObserved(observation, NEXT) : fake.store.removeObserved(observation, NOW)
    await held.reached
    expect(await fake.store.registerWriter(KEY, { writeEpoch: WRITER.writeEpoch + 1, writerId: 'newer' }, { now: NOW + 1, force: false })).toMatchObject({ kind: 'registered' })
    held.release()
    expect(await pending).toEqual(action === 'adopt' ? { kind: 'fenced', reason: 'changed' } : { kind: 'changed' })
    expect(fake.rawDraft(KEY)).toEqual(structuredClone(RECORD))
    expect(fake.rawWriter(KEY)).toMatchObject({ writerId: 'newer' })
  })

  it.each([
    { ...RECORD, updatedAt: NOW + 9 },
    { ...RECORD, ciphertext: new Uint8Array(32).fill(4) },
    { ...RECORD, iv: new Uint8Array(12).fill(1) },
    { ...RECORD, inFlight: null },
  ])('同序号变化挡住接手和条件清理', async (changed) => {
    const { fake, observation } = await setup()
    fake.putRaw('drafts', KEY, changed)
    expect(await fake.store.adoptObserved(observation, NEXT)).toEqual({ kind: 'fenced', reason: 'changed' })
    expect(await fake.store.removeObserved(observation, NOW)).toEqual({ kind: 'changed' })
    expect(fake.rawDraft(KEY)).toEqual(structuredClone(changed))
    expect(fake.rawWriter(KEY)).toEqual(WRITER)
  })

  it.each([RECORD, { recordVersion: 99 }, { bad: 'second' }])('没有序号的损坏记录被换掉后，不删合法/新格式/另一份损坏记录', async (changed) => {
    const { fake, observation } = await setup({ bad: 'first' })
    fake.putRaw('drafts', KEY, changed)
    expect(await fake.store.removeObserved(observation, NOW)).toEqual({ kind: 'changed' })
    expect(fake.rawDraft(KEY)).toEqual(structuredClone(changed))
  })

  it.each([{ bad: true }, { recordVersion: 99 }, RECORD])('明确处理当前原件时，删除与墓碑一起写入且高水位不丢', async (draft) => {
    const { fake, observation } = await setup(draft)
    expect(await fake.store.removeObserved(observation, NOW + 1)).toEqual({ kind: 'removed' })
    expect(fake.rawDraft(KEY)).toBeUndefined()
    expect(fake.rawWriter(KEY)).toEqual({ ...WRITER, writerId: RETIRED_WRITER_ID, registeredAt: NOW + 1 })
    expect(await fake.store.writeDraft(NEXT)).toEqual({ kind: 'fenced', reason: 'not-writer' })
    expect(await fake.store.restoreDraft(RECORD, { now: NOW + 2 })).toEqual({ kind: 'kept', reason: 'retired' })
  })

  it('删除仅清除原观察提示，同一时刻的新类型提示也保留', async () => {
    const { fake } = await setup()
    const original = { ...KEY, kind: 'restored', at: NOW }
    fake.putRaw('notices', KEY, original)
    const observed = await fake.store.observeDraft(KEY)
    if (observed.kind !== 'observed')
      throw new Error('缺少观察')
    const changed = { ...original, kind: 'lost' }
    fake.putRaw('notices', KEY, changed)
    expect(await fake.store.removeObserved(observed.observation, NOW)).toEqual({ kind: 'removed' })
    expect(fake.rawNotice(KEY)).toEqual(structuredClone(changed))
    fake.putRaw('drafts', KEY, RECORD)
    const again = await fake.store.observeDraft(KEY)
    if (again.kind !== 'observed')
      throw new Error('缺少观察')
    expect(await fake.store.removeObserved(again.observation, NOW)).toEqual({ kind: 'removed' })
    expect(fake.rawNotice(KEY)).toBeUndefined()
  })

  it.each([
    { ...NEXT, draftSeq: WRITER.lastDraftSeq },
    { ...NEXT, writerId: 'foreign' },
    { ...NEXT, documentId: 'foreign' },
  ])('接手不绕过当前写入者、键与严格递增序号', async (next) => {
    const { fake, observation } = await setup()
    expect(await fake.store.adoptObserved(observation, next)).toMatchObject({ kind: 'fenced' })
    expect(fake.rawDraft(KEY)).toEqual(structuredClone(RECORD))
    expect(fake.rawWriter(KEY)).toEqual(WRITER)
  })

  it.each([{ bad: true }, { recordVersion: 99 }])('不可识别记录只能保留或经决定清理，不能接手改写', async (draft) => {
    const { fake, observation } = await setup(draft)
    expect(await fake.store.adoptObserved(observation, NEXT)).toEqual({ kind: 'fenced', reason: 'foreign-draft' })
    expect(fake.rawDraft(KEY)).toEqual(draft)
  })

  it('返回的记录被修改不会改变内部凭证；关闭存储后旧凭证失效', async () => {
    const { fake, observation, observed } = await setup()
    if (observed.record.kind !== 'draft')
      throw new Error('缺少正文')
    observed.record.draft.ciphertext[0] = 99
    expect(await fake.store.adoptObserved(observation, NEXT)).toEqual({ kind: 'written' })
    const later = await fake.store.observeDraft(KEY)
    if (later.kind !== 'observed')
      throw new Error('缺少观察')
    fake.store.close()
    expect(await fake.store.removeObserved(later.observation, NOW)).toEqual({ kind: 'changed' })
  })

  it('空记录也不能让旧凭证删除之后登记的新写入者', async () => {
    const { fake } = await setup()
    fake.putRaw('drafts', KEY, undefined)
    const observed = await fake.store.observeDraft(KEY)
    if (observed.kind !== 'observed')
      throw new Error('缺少观察')
    expect(observed.record).toEqual({ kind: 'absent' })
    expect(await fake.store.removeObserved(observed.observation, NOW)).toEqual({ kind: 'absent' })
    expect(fake.rawWriter(KEY)).toEqual(WRITER)
    const later = await fake.store.observeDraft(KEY)
    if (later.kind !== 'observed')
      throw new Error('缺少观察')
    fake.putRaw('writers', KEY, { ...WRITER, writerId: 'later' })
    expect(await fake.store.removeObserved(later.observation, NOW)).toEqual({ kind: 'changed' })
  })

  it.each(['adoptObserved', 'removeObserved'] as const)('配额失败不消费凭证或改变记录：%s', async (action) => {
    const { fake, observation } = await setup()
    fake.failNext(action, { kind: 'quota' })
    const perform = async (token: DraftObservation) => action === 'adoptObserved' ? fake.store.adoptObserved(token, NEXT) : fake.store.removeObserved(token, NOW)
    expect(await perform(observation)).toEqual({ kind: 'quota' })
    expect(fake.rawDraft(KEY)).toEqual(structuredClone(RECORD))
    expect(fake.rawWriter(KEY)).toEqual(WRITER)
    expect(await perform(observation)).toMatchObject({ kind: action === 'adoptObserved' ? 'written' : 'removed' })
  })
})
