import type { MirrorRead } from './draft-mirror.ts'
import type { DraftKey, StoredDraft } from './draft-record.ts'
import type { RecoveryMirror } from './draft-recovery.ts'
import type { StoreReadOutcome } from './draft-store.ts'
import { describe, expect, it } from 'vitest'
import { DOCUMENT_ID, NOW, OTHER_WRITER_ID, sampleStoredDraft, sampleWriter, USER_ID, WRITER_ID } from './draft-record.test-support.ts'
import { createDraftRecovery, mirroredRecords, pageMirror, pageReconciliation, reconcileAction, reconcileAll, versionsToOpen } from './draft-recovery.ts'
import { fakeDraftStore } from './draft-store.test-support.ts'
import { fakeMirrorDirectory } from './mirror-directory.test-support.ts'
import { encodeSlot, SLOT_HEADER_BYTES } from './mirror-slot.ts'
import { readRecoveryNotice } from './recovery-notice.ts'
import { LOCAL_DRAFT_RETENTION_MS, RETIRED_WRITER_ID } from './writer-fence.ts'

const KEY: DraftKey = { userId: USER_ID, documentId: DOCUMENT_ID }
const OTHER: DraftKey = { userId: USER_ID, documentId: '0199b0c4-7d3e-7a3b-9c4e-00000000d0c2' }

/** 本页（第 3 代、W）写下的第 seq 份 */
function record(draftSeq: number, overrides: Partial<StoredDraft> = {}): StoredDraft {
  return sampleStoredDraft({ ...KEY, draftSeq, inFlight: null, updatedAt: NOW, ...overrides })
}

function valid(draft: StoredDraft, generation: number): Extract<MirrorRead, { readonly kind: 'slots' }>['slots'][number] {
  return { kind: 'valid', header: { formatVersion: 1, writeEpoch: draft.writeEpoch, writerId: draft.writerId, draftSeq: draft.draftSeq, generation, contentLength: 1, contentSha256: 'ab' }, record: draft }
}

function slots(a: Extract<MirrorRead, { readonly kind: 'slots' }>['slots'][number], b: Extract<MirrorRead, { readonly kind: 'slots' }>['slots'][number]): MirrorRead {
  return { kind: 'slots', slots: [a, b] }
}

const EMPTY = { kind: 'empty' } as const
const TORN = { kind: 'invalid', reason: 'torn' } as const
const NEWER_FORMAT = { kind: 'invalid', reason: 'newer-format' } as const

async function fileOf(draft: StoredDraft, generation: number): Promise<Uint8Array> {
  const { header, content } = await encodeSlot(draft, generation)
  const file = new Uint8Array(SLOT_HEADER_BYTES + content.byteLength)
  file.set(header)
  file.set(content, SLOT_HEADER_BYTES)
  return file
}

/** 记下调用的镜像（截断、补写），读出的是给定的样子 */
function scriptedMirror(read: MirrorRead, held = true): RecoveryMirror & { readonly cleared: DraftKey[], readonly backfilled: StoredDraft[] } {
  const cleared: DraftKey[] = []
  const backfilled: StoredDraft[] = []
  return {
    cleared,
    backfilled,
    read: async () => read,
    clear: async (key) => {
      cleared.push(key)
      return { kind: 'mirrored' }
    },
    backfill: async (draft) => {
      if (!held)
        return undefined
      backfilled.push(draft)
      return { kind: 'mirrored' }
    },
  }
}

describe('比对要做什么（只看库里的草稿与镜像里最新写的那一份；写不写回由存储按写入者判定）', () => {
  const latest = record(8)
  const stored = (draft: StoredDraft): StoreReadOutcome => ({ kind: 'draft', draft })
  const cases: readonly { readonly name: string, readonly stored: StoreReadOutcome, readonly latest: StoredDraft | undefined, readonly torn: boolean, readonly expected: ReturnType<typeof reconcileAction> }[] = [
    { name: '库用不了：不比对', stored: { kind: 'unavailable', reason: 'blocked' }, latest, torn: false, expected: 'none' },
    { name: '库里写满：不比对', stored: { kind: 'quota' }, latest, torn: false, expected: 'none' },
    { name: '库里出错：不比对', stored: { kind: 'failed', error: new TypeError('x') }, latest, torn: false, expected: 'none' },
    { name: '库里是更新的页面写的：不动它', stored: { kind: 'newer-format', recordVersion: 2 }, latest, torn: false, expected: 'none' },
    { name: '库里那一条形状不对：不动它', stored: { kind: 'malformed' }, latest, torn: false, expected: 'none' },
    { name: '库里没有草稿、镜像里有：交给存储判定写回', stored: { kind: 'absent' }, latest, torn: false, expected: 'restore' },
    { name: '库里没有、镜像里一份合格的也没有、有写一半的：核对丢失', stored: { kind: 'absent' }, latest: undefined, torn: true, expected: 'lost' },
    { name: '库里没有、镜像里都是空的：什么也不做', stored: { kind: 'absent' }, latest: undefined, torn: false, expected: 'none' },
    { name: '库里有、镜像里一份合格的也没有：补写', stored: stored(record(7)), latest: undefined, torn: true, expected: 'backfill' },
    { name: '同一个版本：什么也不做', stored: stored(record(8)), latest, torn: false, expected: 'none' },
    { name: '同一个写入者、镜像的更新（库悄悄退回）：交给存储判定写回', stored: stored(record(7)), latest, torn: false, expected: 'restore' },
    { name: '同一个写入者、同一个序号、镜像的更新时间晚（库丢了重封）：交给存储判定写回', stored: stored(record(8, { updatedAt: NOW - 1 })), latest, torn: false, expected: 'restore' },
    { name: '同一个写入者、库里的更新：补写', stored: stored(record(9)), latest, torn: false, expected: 'backfill' },
    { name: '别的写入者写的（代次更大也好、更小也好）：交给存储按库里当前的写入者判定（多半是 foreign）', stored: stored(record(11, { writeEpoch: 2, writerId: OTHER_WRITER_ID })), latest, torn: false, expected: 'restore' },
  ]
  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(reconcileAction(testCase.stored, testCase.latest, testCase.torn)).toBe(testCase.expected)
    })
  }
})

describe('读草稿、登记时交回哪一个版本（审查 A3）', () => {
  const seven = record(7)
  const eight = record(8)
  it('写回了：写回的那一份，同一版本在镜像里的另一份跟在后面；不交回更旧的版本', () => {
    const copy = { ...eight, iv: new Uint8Array(12) }
    const read = slots(valid(eight, 4), valid(copy, 3))
    expect(versionsToOpen({ kind: 'absent' }, { mirror: read, restored: eight })).toEqual([eight, copy])
  })

  it('没写回：库里的草稿在前，镜像里同一版本的拷贝在后；镜像里更旧、别的写入者的不算', () => {
    const copy = { ...eight, iv: new Uint8Array(12) }
    const foreign = record(8, { writeEpoch: 5, writerId: OTHER_WRITER_ID })
    expect(versionsToOpen({ kind: 'draft', draft: eight }, { mirror: slots(valid(copy, 6), valid(seven, 5)), restored: undefined })).toEqual([eight, copy])
    expect(versionsToOpen({ kind: 'draft', draft: eight }, { mirror: slots(valid(foreign, 6), EMPTY), restored: undefined })).toEqual([eight])
  })

  it('库用不了：镜像里最新写的那一份（按代号，不按代次）；库里没有、更新的页面写的、形状不对：没有', () => {
    const foreign = record(10, { writeEpoch: 5, writerId: OTHER_WRITER_ID })
    expect(versionsToOpen({ kind: 'unavailable', reason: 'blocked' }, { mirror: slots(valid(foreign, 1), valid(seven, 2)), restored: undefined })).toEqual([seven])
    expect(versionsToOpen({ kind: 'absent' }, { mirror: slots(valid(eight, 1), EMPTY), restored: undefined })).toEqual([])
    expect(versionsToOpen({ kind: 'newer-format', recordVersion: 2 }, { mirror: undefined, restored: undefined })).toEqual([])
    expect(versionsToOpen({ kind: 'malformed' }, { mirror: undefined, restored: undefined })).toEqual([])
    expect(mirroredRecords({ kind: 'busy' })).toEqual([])
  })
})

describe('比对一份文档（createDraftRecovery）', () => {
  it('镜像里什么也没有（空的槽位、文件不在、被占着、用不了）：不读库', async () => {
    for (const read of [slots(EMPTY, EMPTY), slots(NEWER_FORMAT, EMPTY), { kind: 'absent' } as const, { kind: 'busy' } as const, { kind: 'unsupported' } as const]) {
      const store = fakeDraftStore()
      const recovery = createDraftRecovery({ store: store.store, mirror: scriptedMirror(read), now: () => NOW })
      expect(await recovery.reconcile(KEY), JSON.stringify(read)).toEqual({ mirror: read, restored: undefined })
      expect(store.calls, '槽位是更新的页面写的不算写一半（审查 A8）').toEqual([])
    }
  })

  it('删库之后写回，交回写回的那一份；库里的胜出时补写（本页拿着句柄时）；库里是墓碑时截断镜像', async () => {
    const store = fakeDraftStore()
    const read = slots(valid(record(8), 2), valid(record(7), 1))
    const restore = createDraftRecovery({ store: store.store, mirror: scriptedMirror(read), now: () => NOW })
    expect(await restore.reconcile(KEY)).toEqual({ mirror: read, restored: record(8) })
    expect(readRecoveryNotice(store.rawNotice(KEY))).toEqual({ ...KEY, kind: 'restored', at: NOW })

    const newer = fakeDraftStore()
    newer.putRaw('drafts', KEY, record(9))
    newer.putRaw('writers', KEY, sampleWriter({ ...KEY, lastDraftSeq: 9 }))
    const held = scriptedMirror(read)
    expect(await createDraftRecovery({ store: newer.store, mirror: held, now: () => NOW }).reconcile(KEY)).toEqual({ mirror: read, restored: undefined })
    expect(held.backfilled.map(draft => draft.draftSeq)).toEqual([9])

    const retired = fakeDraftStore()
    retired.putRaw('writers', KEY, sampleWriter({ ...KEY, writerId: RETIRED_WRITER_ID }))
    const mirror = scriptedMirror(read)
    expect(await createDraftRecovery({ store: retired.store, mirror, now: () => NOW }).reconcile(KEY)).toEqual({ mirror: undefined, restored: undefined })
    expect(mirror.cleared).toEqual([KEY])
    expect(retired.rawDraft(KEY), '墓碑挡住写回').toBeUndefined()
  })

  it('以 force 登记、代次倒退之后：库里当前的写入者写的胜出，旧一代的镜像不写回、不截断，本页拿着句柄时补写（审查 A2）', async () => {
    const store = fakeDraftStore()
    const current = record(11, { writeEpoch: 2, writerId: OTHER_WRITER_ID })
    store.putRaw('drafts', KEY, current)
    store.putRaw('writers', KEY, sampleWriter({ ...KEY, writeEpoch: 2, writerId: OTHER_WRITER_ID, lastDraftSeq: 11 }))
    const read = slots(valid(record(10, { writeEpoch: 5 }), 4), EMPTY)
    const mirror = scriptedMirror(read)
    expect(await createDraftRecovery({ store: store.store, mirror, now: () => NOW }).reconcile(KEY)).toEqual({ mirror: read, restored: undefined })
    expect(store.rawDraft(KEY)).toMatchObject({ draftSeq: 11, writeEpoch: 2 })
    expect([mirror.cleared, mirror.backfilled.map(draft => [draft.writeEpoch, draft.draftSeq])]).toEqual([[], [[2, 11]]])
    expect(store.rawNotice(KEY)).toBeUndefined()
  })

  it('库里的草稿是别人的（接手过），镜像里是库里当前的写入者之后写的而库悄悄退回了：交给存储判定，写回', async () => {
    const store = fakeDraftStore()
    store.putRaw('drafts', KEY, record(6, { writeEpoch: 2, writerId: OTHER_WRITER_ID }))
    store.putRaw('writers', KEY, sampleWriter({ ...KEY, lastDraftSeq: 7 }))
    const read = slots(valid(record(8), 2), EMPTY)
    expect(await createDraftRecovery({ store: store.store, mirror: scriptedMirror(read), now: () => NOW }).reconcile(KEY)).toEqual({ mirror: read, restored: record(8) })
    expect(store.rawDraft(KEY)).toMatchObject({ draftSeq: 8, writerId: WRITER_ID })
  })

  it('库悄悄丢了更新的那次登记与它的写入（UR-034 的变体，审查 A2 的订正）：写回，写入者换成镜像里那一份的', async () => {
    const store = fakeDraftStore()
    store.putRaw('drafts', KEY, record(10, { writeEpoch: 5, writerId: OTHER_WRITER_ID }))
    store.putRaw('writers', KEY, sampleWriter({ ...KEY, writeEpoch: 5, writerId: OTHER_WRITER_ID, lastDraftSeq: 10 }))
    const read = slots(valid(record(11, { writeEpoch: 6 }), 2), valid(record(10, { writeEpoch: 5, writerId: OTHER_WRITER_ID }), 1))
    expect(await createDraftRecovery({ store: store.store, mirror: scriptedMirror(read), now: () => NOW }).reconcile(KEY)).toEqual({ mirror: read, restored: record(11, { writeEpoch: 6 }) })
    expect(store.rawWriter(KEY)).toMatchObject({ writeEpoch: 6, writerId: WRITER_ID, lastDraftSeq: 11 })
  })

  it('库里是更新的一代、还没写过草稿：写回成别人留下的草稿，写入者与高水位不动', async () => {
    const store = fakeDraftStore()
    store.putRaw('writers', KEY, sampleWriter({ ...KEY, writeEpoch: 4, writerId: OTHER_WRITER_ID, lastDraftSeq: 0 }))
    const read = slots(valid(record(8), 2), EMPTY)
    expect((await createDraftRecovery({ store: store.store, mirror: scriptedMirror(read), now: () => NOW }).reconcile(KEY)).restored).toEqual(record(8))
    expect(store.rawWriter(KEY)).toMatchObject({ writeEpoch: 4, writerId: OTHER_WRITER_ID, lastDraftSeq: 0 })
  })

  it('库里的写入者看过镜像里那一份、库里有草稿：本页是写入者时补写（镜像跟上库）；不是时截断（镜像过时）', async () => {
    const store = fakeDraftStore()
    store.putRaw('drafts', KEY, record(11, { writeEpoch: 2, writerId: OTHER_WRITER_ID }))
    store.putRaw('writers', KEY, sampleWriter({ ...KEY, writeEpoch: 2, writerId: OTHER_WRITER_ID, lastDraftSeq: 11 }))
    const read = slots(valid(record(10, { writeEpoch: 5 }), 4), EMPTY)
    const notHeld = scriptedMirror(read, false)
    expect(await createDraftRecovery({ store: store.store, mirror: notHeld, now: () => NOW }).reconcile(KEY)).toEqual({ mirror: undefined, restored: undefined })
    expect([notHeld.cleared, notHeld.backfilled]).toEqual([[KEY], []])
  })

  it('镜像过时（确认删掉、放弃过、超过保留期）：截断，里面的不再算数', async () => {
    const seen = fakeDraftStore()
    seen.putRaw('writers', KEY, sampleWriter({ ...KEY, lastDraftSeq: 8 }))
    const read = slots(valid(record(8), 2), EMPTY)
    const mirror = scriptedMirror(read)
    expect(await createDraftRecovery({ store: seen.store, mirror, now: () => NOW }).reconcile(KEY)).toEqual({ mirror: undefined, restored: undefined })
    expect(mirror.cleared).toEqual([KEY])

    const old = slots(valid(record(8, { updatedAt: NOW - LOCAL_DRAFT_RETENTION_MS - 1 }), 2), EMPTY)
    const expired = scriptedMirror(old)
    expect(await createDraftRecovery({ store: fakeDraftStore().store, mirror: expired, now: () => NOW }).reconcile(KEY)).toEqual({ mirror: undefined, restored: undefined })
    expect(expired.cleared).toEqual([KEY])
  })

  it('写回、核对丢失时库出了问题：如实交回（读草稿交回它，不拿镜像里的顶替）', async () => {
    const store = fakeDraftStore()
    store.failNext('restoreDraft', { kind: 'quota' })
    const read = slots(valid(record(8), 2), EMPTY)
    expect(await createDraftRecovery({ store: store.store, mirror: scriptedMirror(read), now: () => NOW }).reconcile(KEY)).toEqual({ mirror: read, restored: undefined, problem: { kind: 'quota' } })

    const lost = fakeDraftStore()
    lost.failNext('recordLost', { kind: 'unavailable', reason: 'blocked' })
    const torn = slots(TORN, TORN)
    const mirror = scriptedMirror(torn)
    expect(await createDraftRecovery({ store: lost.store, mirror, now: () => NOW }).reconcile(KEY)).toEqual({ mirror: torn, restored: undefined, problem: { kind: 'unavailable', reason: 'blocked' } })
    expect(mirror.cleared, '没核对成：槽位留着，下一次再核对').toEqual([])
  })

  it('补写出了意外（抛出）：这一次落后着，比对照常交回', async () => {
    const store = fakeDraftStore()
    store.putRaw('drafts', KEY, record(9))
    const read = slots(valid(record(8), 2), EMPTY)
    const throwing: RecoveryMirror = { read: async () => read, clear: async () => ({ kind: 'mirrored' }), backfill: async () => Promise.reject(new TypeError('坏了')) }
    expect(await createDraftRecovery({ store: store.store, mirror: throwing, now: () => NOW }).reconcile(KEY)).toEqual({ mirror: read, restored: undefined })
  })

  it('不留 lost 的比对（平台页面）：两个槽位都坏了、库里什么都没有时不核对、不截断', async () => {
    const store = fakeDraftStore()
    const mirror = scriptedMirror(slots(TORN, TORN))
    expect((await createDraftRecovery({ store: store.store, mirror, now: () => NOW, noteLost: false }).reconcile(KEY)).mirror?.kind).toBe('slots')
    expect([store.calls.includes('recordLost'), mirror.cleared, store.rawNotice(KEY)]).toEqual([false, [], undefined])
  })
})

describe('平台页面里的比对（P4 的本机草稿页列出与清理之前，审查 A18）与一份一份地比对（审查 A13）', () => {
  it('经 getFile 读槽位、核对是这份文档的；删库之后写回库；不截断、不补写、不留 lost', async () => {
    const files = fakeMirrorDirectory()
    files.putFile(KEY, 0, await fileOf(record(8), 3))
    files.putFile(KEY, 1, new Uint8Array(0))
    files.putFile(OTHER, 0, new Uint8Array(400).fill(7))
    const mirror = pageMirror(files.directory)
    expect((await mirror.read(KEY)).kind).toBe('slots')
    expect(await mirror.read({ userId: USER_ID, documentId: 'nothing' })).toEqual({ kind: 'absent' })
    expect(await mirror.clear(KEY)).toEqual({ kind: 'not-mirrored', reason: 'unsupported' })
    expect(await mirror.backfill(record(8))).toBeUndefined()

    const store = fakeDraftStore()
    const source = pageReconciliation({ store: store.store, directory: files.directory, now: () => NOW })
    expect(await reconcileAll(source, USER_ID)).toEqual({ kind: 'reconciled', documents: 2, failed: [] })
    expect(store.rawDraft(KEY)).toMatchObject({ draftSeq: 8 })
    expect([store.rawNotice(OTHER), files.file(OTHER, 0)?.byteLength]).toEqual([undefined, 400])
  })

  it('一份出错不拖累别的：交回出错的那几份；列不出时如实交回；没有 OPFS 时没有可比对的', async () => {
    const files = fakeMirrorDirectory()
    files.putFile(KEY, 0, await fileOf(record(8), 3))
    files.putFile(OTHER, 0, await fileOf(record(4, { ...OTHER }), 1))
    const store = fakeDraftStore()
    store.failNext('restoreDraft', { kind: 'quota' })
    expect(await reconcileAll(pageReconciliation({ store: store.store, directory: files.directory, now: () => NOW }), USER_ID)).toEqual({ kind: 'reconciled', documents: 2, failed: [KEY] })
    expect(store.rawDraft(OTHER)).toMatchObject({ draftSeq: 4 })

    const failing = pageReconciliation({ store: fakeDraftStore().store, directory: { ...files.directory, listDocuments: async () => ({ kind: 'failed', error: new TypeError('坏了') }) }, now: () => NOW })
    expect(await reconcileAll(failing, USER_ID)).toEqual({ kind: 'failed', error: { name: 'TypeError', message: '坏了' } })
    const unsupported = pageReconciliation({ store: fakeDraftStore().store, directory: { ...files.directory, listDocuments: async () => ({ kind: 'unsupported' }) }, now: () => NOW })
    expect(await reconcileAll(unsupported, USER_ID)).toEqual({ kind: 'reconciled', documents: 0, failed: [] })
    const throwing = pageReconciliation({ store: fakeDraftStore().store, directory: { ...files.directory, readSlots: async () => Promise.reject(new TypeError('炸了')) }, now: () => NOW })
    expect(await reconcileAll(throwing, USER_ID)).toEqual({ kind: 'reconciled', documents: 2, failed: [KEY, OTHER] })
  })

  it('页面里读槽位时目录的问题折成读出的样子', async () => {
    const files = fakeMirrorDirectory()
    const of = async (outcome: Awaited<ReturnType<typeof files.directory.readSlots>>) => pageMirror({ ...files.directory, readSlots: async () => outcome }).read(KEY)
    expect(await of({ kind: 'busy' })).toEqual({ kind: 'busy' })
    expect(await of({ kind: 'unsupported' })).toEqual({ kind: 'unsupported' })
    expect(await of({ kind: 'quota' })).toEqual({ kind: 'failed', error: { name: 'QuotaExceededError', message: '读镜像时写满' } })
    expect(await of({ kind: 'failed', error: new TypeError('坏了') })).toEqual({ kind: 'failed', error: { name: 'TypeError', message: '坏了' } })
    expect(await of({ kind: 'bytes', files: [undefined, undefined] })).toEqual({ kind: 'slots', slots: [{ kind: 'empty' }, { kind: 'empty' }] })
  })

  it('别的人的、别的文档的槽位文件被挪进这个目录：不认（审查 A4）', async () => {
    const files = fakeMirrorDirectory()
    files.putFile(KEY, 0, await fileOf(record(4, { ...OTHER }), 1))
    files.putFile(KEY, 1, new Uint8Array(0))
    expect(await pageMirror(files.directory).read(KEY)).toEqual({ kind: 'slots', slots: [{ kind: 'invalid', reason: 'mismatch' }, { kind: 'empty' }] })
    expect(WRITER_ID).toBeDefined()
  })
})
