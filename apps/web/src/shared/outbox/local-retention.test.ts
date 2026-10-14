import type { StoredDraft } from './draft-record.ts'
import type { MirrorDirectory } from './mirror-directory.ts'
import { describe, expect, it } from 'vitest'
import { DOCUMENT_ID, NOW, OTHER_USER_ID, sampleStoredDraft, USER_ID } from './draft-record.test-support.ts'
import { fakeDraftStore } from './draft-store.test-support.ts'
import { createLocalCleanup } from './local-cleanup.ts'
import { fakeMirrorDirectory } from './mirror-directory.test-support.ts'
import { encodeRecord, encodeSlotHeader } from './mirror-slot.ts'
import { testCleanupSessions } from './session-fence.test-support.ts'
import { LOCAL_DRAFT_RETENTION_MS } from './writer-fence.ts'

const KEY = { userId: USER_ID, documentId: DOCUMENT_ID }
const OLD = NOW - LOCAL_DRAFT_RETENTION_MS - 1

function setup(override: (directory: MirrorDirectory) => MirrorDirectory = directory => directory) {
  const store = fakeDraftStore()
  const files = fakeMirrorDirectory({ clock: () => OLD })
  const cleanup = createLocalCleanup({ store: store.store, directory: override(files.directory), sessions: testCleanupSessions(), now: () => NOW })
  return { store, files, cleanup }
}

async function slot(draft: StoredDraft): Promise<Uint8Array<ArrayBuffer>> {
  const content = encodeRecord(draft)
  const header = await encodeSlotHeader({ ...draft, generation: 1 }, content)
  const bytes = new Uint8Array(header.byteLength + content.byteLength)
  bytes.set(header)
  bytes.set(content, header.byteLength)
  return bytes
}

describe('后台保留期：格式与到期事实必须一致', () => {
  it.each([
    ['新格式', { recordVersion: 2, updatedAt: OLD }],
    ['恰好十四天', { updatedAt: NOW - LOCAL_DRAFT_RETENTION_MS }],
    ['未来时间', { updatedAt: NOW + 1 }],
    ['无法判断时间', { updatedAt: 'unknown' }],
  ])('主库保留%s时，即使镜像里是过期旧记录也不能删备份', async (_, change) => {
    const { store, files, cleanup } = setup()
    const original = { ...sampleStoredDraft(KEY), ...change }
    store.putRaw('drafts', KEY, original)
    const bytes = await slot(sampleStoredDraft({ ...KEY, updatedAt: OLD }))
    files.putFile(KEY, 0, bytes)
    expect(await cleanup.purgeExpired(NOW)).toEqual({ kind: 'purged', drafts: [], pending: [], mirror: { kind: 'done' } })
    expect(store.rawDraft(KEY)).toEqual(structuredClone(original))
    expect(files.file(KEY, 0)).toEqual(bytes)
    expect(store.rawNotice(KEY)).toBeUndefined()
  })

  it.each([Number.POSITIVE_INFINITY, Number.NaN, -1, NOW + 0.5])('无效当前时钟 %s 不启动到期删除', async (at) => {
    const { store, files, cleanup } = setup()
    const original = sampleStoredDraft({ ...KEY, updatedAt: OLD })
    store.putRaw('drafts', KEY, original)
    const bytes = await slot(original)
    files.putFile(KEY, 0, bytes)
    expect(await cleanup.purgeExpired(at)).toMatchObject({ kind: 'purged', drafts: [], pending: [] })
    expect(store.rawDraft(KEY)).toEqual(structuredClone(original))
    expect(files.file(KEY, 0)).toEqual(bytes)
  })

  it('本人和他人的当前格式旧草稿被删后，各自在自己键下留下到期提示', async () => {
    const { store, cleanup } = setup()
    const theirs = { ...KEY, userId: OTHER_USER_ID }
    store.putRaw('drafts', KEY, sampleStoredDraft({ ...KEY, updatedAt: OLD }))
    store.putRaw('drafts', theirs, { ...sampleStoredDraft({ ...theirs, updatedAt: OLD }), iv: 'broken' })
    expect(await cleanup.purgeExpired(NOW)).toMatchObject({ drafts: [{ key: KEY, record: 'draft' }, { key: theirs, record: 'malformed' }] })
    for (const key of [KEY, theirs]) {
      expect(store.rawDraft(key)).toBeUndefined()
      expect(store.rawNotice(key)).toEqual({ ...key, kind: 'expired', at: NOW })
    }
    expect(await store.store.listNotices(USER_ID)).toEqual({ kind: 'notices', notices: [{ ...KEY, kind: 'expired', at: NOW }] })
    expect(await store.store.listNotices(OTHER_USER_ID)).toEqual({ kind: 'notices', notices: [{ ...theirs, kind: 'expired', at: NOW }] })
  })

  it('只有镜像的已知旧草稿：删除后同样留下持久到期提示，报告只列一次', async () => {
    const { store, files, cleanup } = setup()
    files.putFile(KEY, 0, await slot(sampleStoredDraft({ ...KEY, updatedAt: OLD })))
    expect(await cleanup.purgeExpired(NOW)).toEqual({ kind: 'purged', drafts: [{ key: KEY, record: 'draft' }], pending: [], mirror: { kind: 'done' } })
    expect(files.file(KEY, 0)).toBeUndefined()
    expect(store.rawNotice(KEY)).toEqual({ ...KEY, kind: 'expired', at: NOW })
    expect(await cleanup.purgeExpired(NOW + 1)).toMatchObject({ drafts: [] })
    expect(store.rawNotice(KEY)).toEqual({ ...KEY, kind: 'expired', at: NOW })
  })

  it.each([
    ['新槽位格式', async () => {
      const bytes = await slot(sampleStoredDraft({ ...KEY, updatedAt: OLD }))
      new DataView(bytes.buffer).setUint16(8, 2, true)
      return bytes
    }],
    ['新记录格式', async () => slot({ ...sampleStoredDraft({ ...KEY, updatedAt: OLD }), recordVersion: 2 })],
    ['无法判断的非空内容', async () => new Uint8Array([1, 2, 3])],
    ['恰好十四天的记录', async () => slot(sampleStoredDraft({ ...KEY, updatedAt: NOW - LOCAL_DRAFT_RETENTION_MS }))],
    ['未来的记录', async () => slot(sampleStoredDraft({ ...KEY, updatedAt: NOW + 1 }))],
  ])('文件时间过期但%s仍保留全部原件和原提示', async (_, build) => {
    const { store, files, cleanup } = setup()
    const original = await build()
    files.putFile(KEY, 0, original)
    files.putFile(KEY, 1, await slot(sampleStoredDraft({ ...KEY, updatedAt: OLD })))
    store.putRaw('notices', KEY, { ...KEY, kind: 'restored', at: NOW - 1 })
    expect(await cleanup.purgeExpired(NOW)).toMatchObject({ drafts: [], pending: [] })
    expect(files.file(KEY, 0)).toEqual(original)
    expect(store.rawNotice(KEY)).toEqual({ ...KEY, kind: 'restored', at: NOW - 1 })
  })

  it('读槽位失败保留原件和墓碑，报告待重试；能读后补清并留提示', async () => {
    let fail = true
    const { store, files, cleanup } = setup(directory => ({ ...directory, readSlots: async key => fail ? { kind: 'failed', error: new TypeError('读取失败') } : directory.readSlots(key) }))
    const bytes = await slot(sampleStoredDraft({ ...KEY, updatedAt: OLD }))
    files.putFile(KEY, 0, bytes)
    expect(await cleanup.purgeExpired(NOW)).toMatchObject({ drafts: [], pending: [KEY] })
    expect(files.file(KEY, 0)).toEqual(bytes)
    expect(store.rawNotice(KEY)).toBeUndefined()
    fail = false
    expect(await cleanup.purgeExpired(NOW)).toMatchObject({ drafts: [{ key: KEY, record: 'draft' }], pending: [] })
    expect(store.rawNotice(KEY)).toEqual({ ...KEY, kind: 'expired', at: NOW })
  })

  it('镜像正被占用时不称已清理，也不留下成功提示', async () => {
    const { store, files, cleanup } = setup()
    files.putFile(KEY, 0, await slot(sampleStoredDraft({ ...KEY, updatedAt: OLD })))
    files.holdElsewhere(KEY)
    expect(await cleanup.purgeExpired(NOW)).toMatchObject({ drafts: [], pending: [KEY] })
    expect(store.rawNotice(KEY)).toBeUndefined()
  })

  it('空旧目录可以回收，不虚构有草稿到期', async () => {
    const { store, files, cleanup } = setup()
    files.putFile(KEY, 0, new Uint8Array(0))
    expect(await cleanup.purgeExpired(NOW)).toMatchObject({ drafts: [], pending: [] })
    expect(await files.directory.slotFiles(KEY)).toEqual({ kind: 'absent' })
    expect(store.rawNotice(KEY)).toBeUndefined()
  })

  it('主库与镜像都有过期原件时，报告和提示只有一份', async () => {
    const { store, files, cleanup } = setup()
    const original = sampleStoredDraft({ ...KEY, updatedAt: OLD })
    store.putRaw('drafts', KEY, original)
    files.putFile(KEY, 0, await slot(original))
    expect(await cleanup.purgeExpired(NOW)).toMatchObject({ drafts: [{ key: KEY, record: 'draft' }], pending: [] })
    expect(store.calls).not.toContain('recordExpiredMirror')
    expect(store.rawNotice(KEY)).toEqual({ ...KEY, kind: 'expired', at: NOW })
  })

  it('镜像已删除但提示写入失败，如实保留已删事实与失败结果', async () => {
    const { store, files, cleanup } = setup()
    files.putFile(KEY, 0, await slot(sampleStoredDraft({ ...KEY, updatedAt: OLD })))
    store.failNext('recordExpiredMirror', { kind: 'quota' })
    expect(await cleanup.purgeExpired(NOW)).toEqual({ kind: 'purged', drafts: [{ key: KEY, record: 'draft' }], pending: [], mirror: { kind: 'failed', error: { kind: 'quota' } } })
    expect(files.file(KEY, 0)).toBeUndefined()
    expect(store.rawNotice(KEY)).toBeUndefined()
  })

  it('镜像提示写入前重新出现主库草稿时跳过，不覆盖该草稿的提示', async () => {
    const { store } = setup()
    store.putRaw('drafts', KEY, sampleStoredDraft(KEY))
    store.putRaw('notices', KEY, { ...KEY, kind: 'restored', at: NOW - 1 })
    expect(await store.store.recordExpiredMirror(KEY, NOW)).toEqual({ kind: 'skipped' })
    expect(store.rawNotice(KEY)).toEqual({ ...KEY, kind: 'restored', at: NOW - 1 })
  })
})
