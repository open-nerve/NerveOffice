import type { DraftKey } from './draft-record.ts'
import type { FakeDraftStore } from './draft-store.test-support.ts'
import type { LocalCleanup } from './local-cleanup.ts'
import type { FakeMirrorDirectory } from './mirror-directory.test-support.ts'
import type { MirrorDirectory } from './mirror-directory.ts'
import { describe, expect, it } from 'vitest'
import { DOCUMENT_ID, NOW, OTHER_USER_ID, sampleMeta, sampleStoredDraft, sampleWriter, USER_ID } from './draft-record.test-support.ts'
import { readWriterRecord } from './draft-record.ts'
import { fakeDraftStore } from './draft-store.test-support.ts'
import { createLocalCleanup } from './local-cleanup.ts'
import { fakeMirrorDirectory } from './mirror-directory.test-support.ts'
import { decideRestore, decideWrite, isRetired, LOCAL_DRAFT_RETENTION_MS, RETIRED_WRITER_ID } from './writer-fence.ts'

const A: DraftKey = { userId: USER_ID, documentId: DOCUMENT_ID }
const B: DraftKey = { userId: USER_ID, documentId: '0199b0c4-7d3e-7a3b-9c4e-00000000d0c2' }
const C: DraftKey = { userId: USER_ID, documentId: '0199b0c4-7d3e-7a3b-9c4e-00000000d0c3' }
const D: DraftKey = { userId: USER_ID, documentId: '0199b0c4-7d3e-7a3b-9c4e-00000000d0c4' }
const E: DraftKey = { userId: USER_ID, documentId: '0199b0c4-7d3e-7a3b-9c4e-00000000d0c5' }
const THEIRS: DraftKey = { userId: OTHER_USER_ID, documentId: DOCUMENT_ID }

interface Setup {
  readonly store: FakeDraftStore
  readonly files: FakeMirrorDirectory
  readonly cleanup: LocalCleanup
  /** 墙上时间往前走（文件的改动时刻、墓碑的时刻跟着它） */
  readonly advance: (ms: number) => void
}

/** 假存储 + 内存里的 OPFS；override 换掉镜像目录的几样（OPFS 用不了、列不出） */
function setup(override: (directory: MirrorDirectory) => MirrorDirectory = directory => directory): Setup {
  let wall = NOW
  const store = fakeDraftStore()
  const files = fakeMirrorDirectory({ clock: () => wall })
  return {
    store,
    files,
    cleanup: createLocalCleanup({ store: store.store, directory: override(files.directory), now: () => wall }),
    advance: (ms) => {
      wall += ms
    },
  }
}

/** 库里放一份草稿（第 7 份）、它的写入者（高水位 7）与提示 */
function putRecords(store: FakeDraftStore, key: DraftKey): void {
  store.putRaw('drafts', key, sampleStoredDraft({ ...key }))
  store.putRaw('writers', key, sampleWriter({ ...key }))
  store.putRaw('notices', key, { ...key, kind: 'restored', at: NOW })
}

/** 镜像里放这份文档的两个槽位文件（内容随意：清理只看大小与改动时刻） */
function putMirror(files: FakeMirrorDirectory, key: DraftKey, sizes: readonly [number, number] = [300, 0]): void {
  files.putFile(key, 0, new Uint8Array(sizes[0]).fill(1))
  files.putFile(key, 1, new Uint8Array(sizes[1]).fill(1))
}

/** 库里这份文档的草稿、写入者、提示在不在 */
function inStore(store: FakeDraftStore, key: DraftKey): readonly boolean[] {
  return [store.rawDraft(key) !== undefined, store.rawWriter(key) !== undefined, store.rawNotice(key) !== undefined]
}

/** 这份文档的镜像目录在不在 */
async function hasMirror(files: FakeMirrorDirectory, key: DraftKey): Promise<boolean> {
  return (await files.directory.slotFiles(key)).kind !== 'absent'
}

async function users(files: FakeMirrorDirectory): Promise<unknown> {
  return files.directory.listUsers()
}

/** 库里的写入者是不是墓碑 */
function retired(store: FakeDraftStore, key: DraftKey): boolean {
  const writer = readWriterRecord(store.rawWriter(key))
  return writer !== undefined && isRetired(writer)
}

describe('按用户清理（退出登录、账户停用）：库与镜像一起清', () => {
  it('这个人的草稿、写入者、提示与镜像目录都删掉（只在镜像里的、只在库里的也一样），别人的不动；他的用户目录一并删', async () => {
    const { store, files, cleanup } = setup()
    putRecords(store, A)
    putMirror(files, A)
    putMirror(files, B)
    putRecords(store, C)
    putRecords(store, THEIRS)
    putMirror(files, THEIRS)
    expect(await cleanup.removeUser(USER_ID)).toEqual({ kind: 'cleared', pending: [] })
    for (const key of [A, B, C]) {
      expect(inStore(store, key), JSON.stringify(key)).toEqual([false, false, false])
      expect(await hasMirror(files, key), JSON.stringify(key)).toBe(false)
    }
    expect(inStore(store, THEIRS)).toEqual([true, true, true])
    expect(await hasMirror(files, THEIRS)).toBe(true)
    expect(await users(files)).toEqual({ kind: 'listed', userIds: [OTHER_USER_ID] })
  })

  it('镜像目录有句柄开着（那一页的发件箱 Worker 正写着，审查 A1）：跳过它、交回 pending——草稿与提示留着，写入者换成墓碑（那一页之后写不进去、镜像里的写不回来）；放开之后再调就连墓碑一起清完', async () => {
    const { store, files, cleanup, advance } = setup()
    putRecords(store, A)
    putMirror(files, A)
    putRecords(store, B)
    putMirror(files, B)
    const release = files.holdElsewhere(A)
    advance(1_000)
    expect(await cleanup.removeUser(USER_ID)).toEqual({ kind: 'cleared', pending: [A] })
    expect(inStore(store, A)).toEqual([true, true, true])
    expect(readWriterRecord(store.rawWriter(A))).toEqual({ ...A, writeEpoch: 3, writerId: RETIRED_WRITER_ID, lastDraftSeq: 7, registeredAt: NOW + 1_000 })
    expect(await hasMirror(files, A)).toBe(true)
    expect(inStore(store, B)).toEqual([false, false, false])
    expect(await hasMirror(files, B)).toBe(false)
    // 那一页再写：写入者是墓碑，not-writer；比对时镜像里的也不写回
    const tombstone = readWriterRecord(store.rawWriter(A))
    expect(decideWrite(tombstone, undefined, { ...sampleWriter({ ...A }), draftSeq: 8 })).toBe('not-writer')
    expect(decideRestore(tombstone, undefined, sampleMeta({ ...A, draftSeq: 8 }), NOW)).toEqual({ kind: 'skip', reason: 'retired' })

    release()
    expect(await cleanup.removeUser(USER_ID)).toEqual({ kind: 'cleared', pending: [] })
    expect(inStore(store, A)).toEqual([false, false, false])
    expect(await users(files)).toEqual({ kind: 'listed', userIds: [] })
  })

  it('句柄开着的那一份库里没有写入者：同样立一块墓碑，高水位取草稿的序号', async () => {
    const { store, files, cleanup } = setup()
    store.putRaw('drafts', A, sampleStoredDraft({ ...A, draftSeq: 5, inFlight: null }))
    putMirror(files, A)
    files.holdElsewhere(A)
    expect(await cleanup.removeUser(USER_ID)).toEqual({ kind: 'cleared', pending: [A] })
    expect(readWriterRecord(store.rawWriter(A))).toMatchObject({ writerId: RETIRED_WRITER_ID, lastDraftSeq: 5, writeEpoch: 1 })
  })

  it('没有 OPFS：只清库；列不出镜像的目录：什么也不动，如实交回', async () => {
    const unsupported = setup(directory => ({ ...directory, listDocuments: async () => ({ kind: 'unsupported' }), removeUser: async () => ({ kind: 'unsupported' }) }))
    putRecords(unsupported.store, A)
    expect(await unsupported.cleanup.removeUser(USER_ID)).toEqual({ kind: 'cleared', pending: [] })
    expect(inStore(unsupported.store, A)).toEqual([false, false, false])

    const failing = setup(directory => ({ ...directory, listDocuments: async () => ({ kind: 'failed', error: new TypeError('坏了') }) }))
    putRecords(failing.store, A)
    putMirror(failing.files, A)
    expect(await failing.cleanup.removeUser(USER_ID)).toMatchObject({ kind: 'failed', error: { name: 'TypeError' } })
    expect(inStore(failing.store, A)).toEqual([true, true, true])
    expect(await hasMirror(failing.files, A)).toBe(true)
  })

  it('库的问题如实交回（镜像目录已经删了：库那一份还在，再调接着清）', async () => {
    const { store, files, cleanup } = setup()
    putRecords(store, A)
    putMirror(files, A)
    store.failNext('removeUserData', { kind: 'quota' })
    expect(await cleanup.removeUser(USER_ID)).toEqual({ kind: 'quota' })
    expect(inStore(store, A)).toEqual([true, true, true])
    expect(await cleanup.removeUser(USER_ID)).toEqual({ kind: 'cleared', pending: [] })
    expect(inStore(store, A)).toEqual([false, false, false])
  })
})

describe('放弃一份（本机草稿页）：草稿、提示与镜像目录；写入者留着（镜像目录删不掉时换成墓碑）', () => {
  it('删掉草稿与提示、镜像目录；写入者（它的高水位挡住镜像里没删掉的那一份被写回）留着', async () => {
    const { store, files, cleanup } = setup()
    putRecords(store, A)
    putMirror(files, A)
    putMirror(files, B)
    expect(await cleanup.abandon(A, 7)).toEqual({ kind: 'removed', pending: [] })
    expect(inStore(store, A)).toEqual([false, true, false])
    expect(retired(store, A)).toBe(false)
    expect(await hasMirror(files, A)).toBe(false)
    expect(await hasMirror(files, B)).toBe(true)
  })

  it('带的序号不是库里那一份：changed，什么也不动；库里已经没有：照删镜像目录', async () => {
    const { store, files, cleanup } = setup()
    putRecords(store, A)
    putMirror(files, A)
    expect(await cleanup.abandon(A, 6)).toEqual({ kind: 'changed' })
    expect(inStore(store, A)).toEqual([true, true, true])
    expect(await hasMirror(files, A)).toBe(true)
    putMirror(files, B)
    expect(await cleanup.abandon(B)).toEqual({ kind: 'absent', pending: [] })
    expect(await hasMirror(files, B)).toBe(false)
  })

  it('镜像目录有句柄开着（审查 A6）：库里照删，写入者换成墓碑（那一页写不进去、保留期之后镜像里的也写不回来），目录留着、交回 pending；之后目录删掉了，墓碑一并删', async () => {
    const { store, files, cleanup } = setup()
    putRecords(store, A)
    putMirror(files, A)
    const release = files.holdElsewhere(A)
    expect(await cleanup.abandon(A)).toEqual({ kind: 'removed', pending: [A] })
    expect(inStore(store, A)).toEqual([false, true, false])
    expect(retired(store, A)).toBe(true)
    expect(readWriterRecord(store.rawWriter(A))?.lastDraftSeq).toBe(7)
    expect(await hasMirror(files, A)).toBe(true)
    release()
    expect(await cleanup.abandon(A)).toEqual({ kind: 'absent', pending: [] })
    expect(store.rawWriter(A), '镜像目录没了：墓碑一并删').toBeUndefined()
  })

  it('换墓碑、删库里的出了问题：如实交回（镜像不动）；没有 OPFS：只删库里的，没有没清掉的', async () => {
    const { store, files, cleanup } = setup()
    putRecords(store, A)
    putMirror(files, A)
    files.holdElsewhere(A)
    store.failNext('retireWriter', { kind: 'quota' })
    expect(await cleanup.abandon(A)).toEqual({ kind: 'quota' })
    putRecords(store, B)
    putMirror(files, B)
    store.failNext('removeDraft', { kind: 'unavailable', reason: 'blocked' })
    expect(await cleanup.abandon(B)).toEqual({ kind: 'unavailable', reason: 'blocked' })
    expect(await hasMirror(files, B)).toBe(true)

    const unsupported = setup(directory => ({ ...directory, removeDocument: async () => ({ kind: 'unsupported' }) }))
    putRecords(unsupported.store, A)
    expect(await unsupported.cleanup.abandon(A)).toEqual({ kind: 'removed', pending: [] })
    expect(inStore(unsupported.store, A)).toEqual([false, true, false])
  })
})

describe('保留期：库里过期的，镜像里没用的目录（两个槽位都超过 14 天没动过、或者不在），墓碑，不论属于谁', () => {
  it('回收两个槽位都过期的（空的也好、有内容也好）与只剩过期文件的；留下刚截断的空目录（审查 A9）、还在用的、刚写一半的；句柄开着的交回 pending；什么也不剩的用户目录一并删', async () => {
    const { files, cleanup, advance } = setup()
    putMirror(files, A, [0, 0])
    putMirror(files, B, [500, 0])
    putMirror(files, C, [500, 300])
    putMirror(files, E, [0, 0])
    // 别人的：只剩一个过期的空文件（另一个不在）
    files.putFile(THEIRS, 0, new Uint8Array(0))
    advance(LOCAL_DRAFT_RETENTION_MS + 1)
    // D 的两个槽位刚截断过（空的、没过期）：留给下一次编辑；C 的一个槽位刚写过：还在用；E 过期而被拿着
    putMirror(files, D, [0, 0])
    files.putFile(C, 1, new Uint8Array(300).fill(1))
    files.holdElsewhere(E)
    expect(await cleanup.purgeExpired(NOW + LOCAL_DRAFT_RETENTION_MS + 1)).toEqual({ kind: 'purged', drafts: [], pending: [E], mirror: { kind: 'done' } })
    expect(await Promise.all([A, B, C, D, E].map(async key => hasMirror(files, key)))).toEqual([false, false, true, true, true])
    expect(await users(files), '别人的什么也不剩：用户目录一并删').toEqual({ kind: 'listed', userIds: [USER_ID] })
  })

  it('改动时刻恰好 14 天前的不算过期；时刻在将来（时钟往回拨过）的不算', async () => {
    const { files, cleanup } = setup()
    putMirror(files, A, [500, 500])
    files.touch(A, 0, NOW - LOCAL_DRAFT_RETENTION_MS)
    files.touch(A, 1, NOW - LOCAL_DRAFT_RETENTION_MS - 1)
    putMirror(files, B, [500, 500])
    files.touch(B, 0, NOW + 60_000)
    files.touch(B, 1, NOW - LOCAL_DRAFT_RETENTION_MS - 1)
    expect(await cleanup.purgeExpired(NOW)).toEqual({ kind: 'purged', drafts: [], pending: [], mirror: { kind: 'done' } })
    expect([await hasMirror(files, A), await hasMirror(files, B)]).toEqual([true, true])
    files.touch(A, 0, NOW - LOCAL_DRAFT_RETENTION_MS - 1)
    expect(await cleanup.purgeExpired(NOW)).toEqual({ kind: 'purged', drafts: [], pending: [], mirror: { kind: 'done' } })
    expect([await hasMirror(files, A), await hasMirror(files, B)]).toEqual([false, true])
  })

  it('列出来之后目录已经不在了（别处刚删）：当作删了，用户目录照样回收', async () => {
    const { files, cleanup } = setup(directory => ({ ...directory, slotFiles: async () => ({ kind: 'absent' }) }))
    putMirror(files, A, [500, 500])
    expect(await cleanup.purgeExpired(NOW)).toEqual({ kind: 'purged', drafts: [], pending: [], mirror: { kind: 'done' } })
    expect(await users(files)).toEqual({ kind: 'listed', userIds: [] })
  })

  it('墓碑：镜像目录已经不在的删掉，还在的留着；登记超过 14 天、没有草稿的写入者先换成墓碑（审查 A6），同一次里镜像目录不在就删掉；没有 OPFS 时全删', async () => {
    const { store, files, cleanup } = setup()
    // A：放弃时句柄被占着立的墓碑，镜像目录还在、刚写过；B：墓碑，镜像目录早没了
    store.putRaw('writers', A, sampleWriter({ ...A, writerId: RETIRED_WRITER_ID }))
    putMirror(files, A, [500, 0])
    store.putRaw('writers', B, sampleWriter({ ...B, writerId: RETIRED_WRITER_ID }))
    // C、D：登记超过 14 天、没有草稿的写入者；C 的镜像还在用，D 没有镜像
    const old = { registeredAt: NOW - LOCAL_DRAFT_RETENTION_MS - 1 }
    store.putRaw('writers', C, sampleWriter({ ...C, ...old }))
    putMirror(files, C, [500, 0])
    store.putRaw('writers', D, sampleWriter({ ...D, ...old }))
    expect(await cleanup.purgeExpired(NOW)).toEqual({ kind: 'purged', drafts: [], pending: [], mirror: { kind: 'done' } })
    expect([retired(store, A), store.rawWriter(B), retired(store, C), store.rawWriter(D)]).toEqual([true, undefined, true, undefined])

    const unsupported = setup(directory => ({ ...directory, listUsers: async () => ({ kind: 'unsupported' }) }))
    unsupported.store.putRaw('writers', A, sampleWriter({ ...A, writerId: RETIRED_WRITER_ID }))
    expect(await unsupported.cleanup.purgeExpired(NOW)).toMatchObject({ kind: 'purged', mirror: { kind: 'done' } })
    expect(unsupported.store.rawWriter(A)).toBeUndefined()
  })

  it('库那一侧交给存储（过期的草稿交回、过期的提示删掉）；库的问题如实交回；之后镜像那一段出了问题，照样交回库里删了哪几份（审查 A5）', async () => {
    const { store, cleanup } = setup()
    store.putRaw('drafts', A, sampleStoredDraft({ ...A, updatedAt: NOW - LOCAL_DRAFT_RETENTION_MS - 1 }))
    store.putRaw('notices', B, { ...B, kind: 'lost', at: NOW - LOCAL_DRAFT_RETENTION_MS - 1 })
    store.putRaw('notices', C, { ...C, kind: 'lost', at: NOW })
    expect(await cleanup.purgeExpired(NOW)).toEqual({ kind: 'purged', drafts: [{ key: A, record: 'draft' }], pending: [], mirror: { kind: 'done' } })
    expect([store.rawNotice(B), store.rawNotice(C) !== undefined]).toEqual([undefined, true])
    store.failNext('purgeExpired', { kind: 'unavailable', reason: 'denied' })
    expect(await cleanup.purgeExpired(NOW)).toEqual({ kind: 'unavailable', reason: 'denied' })

    const failingUsers = setup(directory => ({ ...directory, listUsers: async () => ({ kind: 'quota' }) }))
    failingUsers.store.putRaw('drafts', A, sampleStoredDraft({ ...A, updatedAt: NOW - LOCAL_DRAFT_RETENTION_MS - 1 }))
    expect(await failingUsers.cleanup.purgeExpired(NOW)).toMatchObject({ kind: 'purged', drafts: [{ key: A, record: 'draft' }], pending: [], mirror: { kind: 'failed', error: { name: 'QuotaExceededError' } } })

    const failingDocuments = setup(directory => ({ ...directory, listDocuments: async () => ({ kind: 'failed', error: new TypeError('坏了') }) }))
    putMirror(failingDocuments.files, A, [0, 0])
    failingDocuments.store.putRaw('writers', B, sampleWriter({ ...B, writerId: RETIRED_WRITER_ID }))
    expect(await failingDocuments.cleanup.purgeExpired(NOW)).toMatchObject({ kind: 'purged', drafts: [], mirror: { kind: 'failed', error: { name: 'TypeError' } } })
    expect(retired(failingDocuments.store, B), '镜像那一段没做完：墓碑不动').toBe(true)

    const failingTombstones = setup()
    failingTombstones.store.failNext('listTombstones', { kind: 'unavailable', reason: 'blocked' })
    expect(await failingTombstones.cleanup.purgeExpired(NOW)).toMatchObject({ kind: 'purged', mirror: { kind: 'failed' } })
    failingTombstones.store.failNext('dropTombstones', { kind: 'failed', error: new TypeError('坏了') })
    expect(await failingTombstones.cleanup.purgeExpired(NOW)).toMatchObject({ kind: 'purged', mirror: { kind: 'failed', error: { name: 'TypeError' } } })
  })
})
