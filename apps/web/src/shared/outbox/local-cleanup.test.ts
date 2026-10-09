import type { DraftKey } from './draft-record.ts'
import type { FakeDraftStore } from './draft-store.test-support.ts'
import type { LocalCleanup } from './local-cleanup.ts'
import type { FakeMirrorDirectory } from './mirror-directory.test-support.ts'
import type { MirrorDirectory } from './mirror-directory.ts'
import { describe, expect, it } from 'vitest'
import { DOCUMENT_ID, NOW, OTHER_USER_ID, sampleStoredDraft, sampleWriter, USER_ID } from './draft-record.test-support.ts'
import { fakeDraftStore } from './draft-store.test-support.ts'
import { createLocalCleanup } from './local-cleanup.ts'
import { fakeMirrorDirectory } from './mirror-directory.test-support.ts'
import { LOCAL_DRAFT_RETENTION_MS } from './writer-fence.ts'

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
  /** 墙上时间往前走（文件的改动时刻跟着它） */
  readonly advance: (ms: number) => void
}

/** 假存储 + 内存里的 OPFS；directory 给出时换掉镜像目录的几样（OPFS 用不了、列不出） */
function setup(override: (directory: MirrorDirectory) => MirrorDirectory = directory => directory): Setup {
  let wall = NOW
  const store = fakeDraftStore()
  const files = fakeMirrorDirectory({ clock: () => wall })
  return {
    store,
    files,
    cleanup: createLocalCleanup({ store: store.store, directory: override(files.directory) }),
    advance: (ms) => {
      wall += ms
    },
  }
}

/** 库里放一份草稿、它的写入者与提示 */
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

function inStore(store: FakeDraftStore, key: DraftKey): readonly boolean[] {
  return [store.rawDraft(key) !== undefined, store.rawWriter(key) !== undefined, store.rawNotice(key) !== undefined]
}

function inMirror(files: FakeMirrorDirectory, key: DraftKey): boolean {
  return files.file(key, 0) !== undefined || files.file(key, 1) !== undefined
}

async function users(files: FakeMirrorDirectory): Promise<unknown> {
  return files.directory.listUsers()
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
      expect(inMirror(files, key), JSON.stringify(key)).toBe(false)
    }
    expect(inStore(store, THEIRS)).toEqual([true, true, true])
    expect(inMirror(files, THEIRS)).toBe(true)
    expect(await users(files)).toEqual({ kind: 'listed', userIds: [OTHER_USER_ID] })
  })

  it('镜像目录有句柄开着（别的标签页拿着）：这一次跳过它，库里它的记录也留着（免得下一次比对把它写回来），交回 pending；放开之后再调就清完', async () => {
    const { store, files, cleanup } = setup()
    putRecords(store, A)
    putMirror(files, A)
    putRecords(store, B)
    putMirror(files, B)
    const release = files.holdElsewhere(A)
    expect(await cleanup.removeUser(USER_ID)).toEqual({ kind: 'cleared', pending: [A] })
    expect(inStore(store, A)).toEqual([true, true, true])
    expect(inMirror(files, A)).toBe(true)
    expect(inStore(store, B)).toEqual([false, false, false])
    expect(inMirror(files, B)).toBe(false)
    release()
    expect(await cleanup.removeUser(USER_ID)).toEqual({ kind: 'cleared', pending: [] })
    expect(inStore(store, A)).toEqual([false, false, false])
    expect(await users(files)).toEqual({ kind: 'listed', userIds: [] })
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
    expect(inMirror(failing.files, A)).toBe(true)
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

describe('放弃一份（本机草稿页）：草稿、提示与镜像目录；写入者留着', () => {
  it('删掉草稿与提示、镜像目录；写入者（它的高水位挡住镜像里没删掉的被写回）留着', async () => {
    const { store, files, cleanup } = setup()
    putRecords(store, A)
    putMirror(files, A)
    putMirror(files, B)
    expect(await cleanup.abandon(A, 7)).toEqual({ kind: 'removed', pending: [] })
    expect(inStore(store, A)).toEqual([false, true, false])
    expect(inMirror(files, A)).toBe(false)
    expect(inMirror(files, B)).toBe(true)
  })

  it('带的序号不是库里那一份：changed，什么也不动；库里已经没有：照删镜像目录', async () => {
    const { store, files, cleanup } = setup()
    putRecords(store, A)
    putMirror(files, A)
    expect(await cleanup.abandon(A, 6)).toEqual({ kind: 'changed' })
    expect(inStore(store, A)).toEqual([true, true, true])
    expect(inMirror(files, A)).toBe(true)
    putMirror(files, B)
    expect(await cleanup.abandon(B)).toEqual({ kind: 'absent', pending: [] })
    expect(inMirror(files, B)).toBe(false)
  })

  it('没有 OPFS：只删库里的，没有没清掉的', async () => {
    const { store, cleanup } = setup(directory => ({ ...directory, removeDocument: async () => ({ kind: 'unsupported' }) }))
    putRecords(store, A)
    expect(await cleanup.abandon(A)).toEqual({ kind: 'removed', pending: [] })
    expect(inStore(store, A)).toEqual([false, true, false])
  })

  it('镜像目录有句柄开着：库里照删，目录留着、交回 pending；库的问题如实交回、镜像不动', async () => {
    const { store, files, cleanup } = setup()
    putRecords(store, A)
    putMirror(files, A)
    files.holdElsewhere(A)
    expect(await cleanup.abandon(A)).toEqual({ kind: 'removed', pending: [A] })
    expect(inStore(store, A)).toEqual([false, true, false])
    expect(inMirror(files, A)).toBe(true)
    putRecords(store, B)
    putMirror(files, B)
    store.failNext('removeDraft', { kind: 'unavailable', reason: 'blocked' })
    expect(await cleanup.abandon(B)).toEqual({ kind: 'unavailable', reason: 'blocked' })
    expect(inMirror(files, B)).toBe(true)
  })
})

describe('保留期：库里过期的，镜像里没用的目录（两个槽位都空、都超过 14 天没动过），不论属于谁', () => {
  it('删两个槽位都空的、都过期的、只剩空目录的；留下有一个槽位还在用的（含删库之后只在镜像里的）、写一半而刚写过的；句柄开着的交回 pending', async () => {
    const { files, cleanup, advance } = setup()
    putMirror(files, B, [500, 0])
    putMirror(files, C, [500, 300])
    putMirror(files, D, [500, 300])
    putMirror(files, E, [0, 0])
    // 别人的：只剩一个空的槽位文件（另一个不在）
    files.putFile(THEIRS, 0, new Uint8Array(0))
    advance(LOCAL_DRAFT_RETENTION_MS + 1)
    // A 的两个槽位刚截断过（空的，没过期）；C 的一个槽位刚写过：还在用；D 的两个都过期；E 被拿着
    putMirror(files, A, [0, 0])
    files.putFile(C, 1, new Uint8Array(300).fill(1))
    files.holdElsewhere(E)
    const outcome = await cleanup.purgeExpired(NOW + LOCAL_DRAFT_RETENTION_MS + 1)
    expect(outcome).toEqual({ kind: 'purged', drafts: [], pending: [E] })
    expect([A, B, C, D, E].map(key => inMirror(files, key))).toEqual([false, false, true, false, true])
    expect(await users(files), '别人的只剩空目录：用户目录一并删').toEqual({ kind: 'listed', userIds: [USER_ID] })
  })

  it('列出来之后目录已经不在了（别处刚删）：当作删了，用户目录照样回收', async () => {
    const { files, cleanup } = setup(directory => ({ ...directory, slotFiles: async () => ({ kind: 'absent' }) }))
    putMirror(files, A, [500, 500])
    expect(await cleanup.purgeExpired(NOW)).toEqual({ kind: 'purged', drafts: [], pending: [] })
    expect(await users(files)).toEqual({ kind: 'listed', userIds: [] })
  })

  it('改动时刻恰好 14 天前的不算过期；时刻在将来（时钟往回拨过）的不算', async () => {
    const { files, cleanup } = setup()
    putMirror(files, A, [500, 500])
    files.touch(A, 0, NOW - LOCAL_DRAFT_RETENTION_MS)
    files.touch(A, 1, NOW - LOCAL_DRAFT_RETENTION_MS - 1)
    putMirror(files, B, [500, 500])
    files.touch(B, 0, NOW + 60_000)
    files.touch(B, 1, NOW - LOCAL_DRAFT_RETENTION_MS - 1)
    expect(await cleanup.purgeExpired(NOW)).toEqual({ kind: 'purged', drafts: [], pending: [] })
    expect([inMirror(files, A), inMirror(files, B)]).toEqual([true, true])
    files.touch(A, 0, NOW - LOCAL_DRAFT_RETENTION_MS - 1)
    expect(await cleanup.purgeExpired(NOW)).toEqual({ kind: 'purged', drafts: [], pending: [] })
    expect([inMirror(files, A), inMirror(files, B)]).toEqual([false, true])
  })

  it('库那一侧交给存储（过期的草稿交回、过期的提示删掉）；库的问题、列不出镜像的目录如实交回', async () => {
    const { store, cleanup } = setup()
    store.putRaw('drafts', A, sampleStoredDraft({ ...A, updatedAt: NOW - LOCAL_DRAFT_RETENTION_MS - 1 }))
    store.putRaw('notices', B, { ...B, kind: 'lost', at: NOW - LOCAL_DRAFT_RETENTION_MS - 1 })
    store.putRaw('notices', C, { ...C, kind: 'lost', at: NOW })
    expect(await cleanup.purgeExpired(NOW)).toEqual({ kind: 'purged', drafts: [{ key: A, record: 'draft' }], pending: [] })
    expect([store.rawNotice(B), store.rawNotice(C) !== undefined]).toEqual([undefined, true])
    store.failNext('purgeExpired', { kind: 'unavailable', reason: 'denied' })
    expect(await cleanup.purgeExpired(NOW)).toEqual({ kind: 'unavailable', reason: 'denied' })

    const failing = setup(directory => ({ ...directory, listUsers: async () => ({ kind: 'quota' }) }))
    expect(await failing.cleanup.purgeExpired(NOW)).toMatchObject({ kind: 'failed', error: { name: 'QuotaExceededError' } })
    const failingDocuments = setup(directory => ({ ...directory, listDocuments: async () => ({ kind: 'failed', error: new TypeError('坏了') }) }))
    putMirror(failingDocuments.files, A, [0, 0])
    expect(await failingDocuments.cleanup.purgeExpired(NOW)).toMatchObject({ kind: 'failed', error: { name: 'TypeError' } })
    const unsupported = setup(directory => ({ ...directory, listUsers: async () => ({ kind: 'unsupported' }) }))
    expect(await unsupported.cleanup.purgeExpired(NOW)).toEqual({ kind: 'purged', drafts: [], pending: [] })
  })
})
