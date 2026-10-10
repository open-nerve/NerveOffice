// M4-P1 复验 C1、C2、C5 的回归：出错重试不丢草稿、回滚不破坏新格式、清理不被在途写入复活。
// 假存储 + 内存里的 OPFS + 真的镜像、比对与管道（与 draft-writer-mirror.test.ts 同一个搭法）
import type { LocalKeyHandle } from './draft-codec.ts'
import type { DraftKey, DraftMeta, StoredDraft } from './draft-record.ts'
import type { FakeDraftStore } from './draft-store.test-support.ts'
import type { DraftStore } from './draft-store.ts'
import type { CaptureToWrite, DraftWriter } from './draft-writer.ts'
import type { FakeMirrorDirectory } from './mirror-directory.test-support.ts'
import type { MirrorDirectory } from './mirror-directory.ts'
import type { WriterIdentity } from './writer-fence.ts'
import { describe, expect, it } from 'vitest'
import { gzipBytes, sealDraft } from './draft-codec.ts'
import { createDraftMirror } from './draft-mirror.ts'
import { CLIENT_INSTANCE_ID, DOCUMENT_ID, NOW, OTHER_WRITER_ID, sampleMeta, USER_ID, WRITER_ID } from './draft-record.test-support.ts'
import { createDraftRecovery, pageReconciliation } from './draft-recovery.ts'
import { fakeDraftStore } from './draft-store.test-support.ts'
import { createDraftWriter } from './draft-writer.ts'
import { createLocalCleanup } from './local-cleanup.ts'
import { fakeMirrorDirectory } from './mirror-directory.test-support.ts'
import { encodeSlot, parseSlot, SLOT_HEADER_BYTES } from './mirror-slot.ts'
import { deferred } from './outbox-lock.test-support.ts'
import { readRecoveryNotice } from './recovery-notice.ts'
import { decideRestore } from './writer-fence.ts'

const KEY: DraftKey = { userId: USER_ID, documentId: DOCUMENT_ID }
/** 上一次会话的写入者（第 3 代） */
const W1: WriterIdentity = { writeEpoch: 3, writerId: WRITER_ID }
/** 这一次打开的页面（第 4 代，新的一次登记） */
const W2: WriterIdentity = { writeEpoch: 4, writerId: OTHER_WRITER_ID }
const RETRY = { initialMs: 500, maxMs: 4_000 }

function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text)
}

async function localKey(version: number): Promise<LocalKeyHandle> {
  return { version, key: await crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)), 'AES-GCM', false, ['encrypt', 'decrypt']) }
}

function capture(writer: WriterIdentity, draftSeq: number, content: string, overrides: Partial<CaptureToWrite> = {}): CaptureToWrite {
  return { key: KEY, writer, draftSeq, baseRevision: 12, writtenBy: CLIENT_INSTANCE_ID, format: sampleMeta().format, formulasPending: false, inFlight: null, bytes: utf8(content), dedupe: false, ...overrides }
}

async function sealed(key: LocalKeyHandle, writer: WriterIdentity, draftSeq: number, content: string, overrides: Partial<DraftMeta> = {}): Promise<StoredDraft> {
  const { keyVersion: _keyVersion, ...meta } = sampleMeta({ ...writer, draftSeq, inFlight: null, rawBytes: utf8(content).byteLength, updatedAt: NOW, ...overrides })
  return sealDraft(key, meta, await gzipBytes(utf8(content)))
}

async function slotBytes(record: StoredDraft, generation: number): Promise<Uint8Array<ArrayBuffer>> {
  const { header, content } = await encodeSlot(record, generation)
  const file = new Uint8Array(SLOT_HEADER_BYTES + content.byteLength)
  file.set(header)
  file.set(content, SLOT_HEADER_BYTES)
  return file
}

/** 两个槽位读出来的样子：写入者的代次与序号 */
async function slots(files: FakeMirrorDirectory): Promise<string[]> {
  const result: string[] = []
  for (const slot of [0, 1] as const) {
    const bytes = files.file(KEY, slot)
    const read = bytes === undefined ? undefined : await parseSlot(bytes, KEY)
    result.push(read === undefined ? 'missing' : read.kind === 'valid' ? `e${read.record.writeEpoch}:seq${read.record.draftSeq}` : read.kind === 'empty' ? 'empty' : `invalid:${read.reason}`)
  }
  return result
}

interface World {
  readonly store: FakeDraftStore
  readonly files: FakeMirrorDirectory
  readonly key: LocalKeyHandle
  readonly open: (overrides?: { readonly directory?: MirrorDirectory, readonly store?: DraftStore }) => Promise<DraftWriter>
  readonly advance: (ms: number) => void
}

async function world(): Promise<World> {
  const store = fakeDraftStore()
  const files = fakeMirrorDirectory()
  const key = await localKey(2)
  let wall = NOW
  let monotonic = 0
  return {
    store,
    files,
    key,
    advance: (ms) => {
      wall += ms
      monotonic += ms
    },
    open: async (overrides = {}) => {
      const target = overrides.store ?? store.store
      const mirror = createDraftMirror({ directory: overrides.directory ?? files.directory, clock: { now: () => monotonic }, retry: RETRY })
      const writer = createDraftWriter({ store: target, now: () => wall, mirror, recovery: createDraftRecovery({ store: target, mirror, now: () => wall }) })
      await writer.setKey(key)
      return writer
    },
  }
}

/**
 * 上一次会话：W1 写了第 10、11 份（库与镜像都有），之后库悄悄退回到第 10 份（UR-034 一类：库丢了最后提交的那一次）；
 * 镜像里还有第 11 份（代号 2，最新写的）
 */
async function rolledBack(w: World): Promise<void> {
  const ten = await sealed(w.key, W1, 10, 'ten')
  const eleven = await sealed(w.key, W1, 11, 'eleven (only in the mirror)', { updatedAt: NOW + 1 })
  w.store.putRaw('drafts', KEY, ten)
  w.store.putRaw('writers', KEY, { ...KEY, ...W1, lastDraftSeq: 10, registeredAt: NOW - 1_000 })
  w.files.putFile(KEY, 0, await slotBytes(ten, 1))
  w.files.putFile(KEY, 1, await slotBytes(eleven, 2))
}

describe('恢复完成之后才登记新的写入者（复验 C1）', () => {
  it('临时读者持有句柄时，新页等待恢复完成才登记，继承完整的序号', async () => {
    const w = await world()
    await rolledBack(w)
    const reached = deferred<void>()
    const release = deferred<void>()
    const reader = await w.open({ directory: {
      ...w.files.directory,
      openSlots: async (key, create) => {
        const opened = await w.files.directory.openSlots(key, create)
        reached.resolve()
        await release.promise
        return opened
      },
    } })
    const reading = reader.read(KEY)
    await reached.promise
    const page = await w.open()
    const registering = page.register(KEY, W2, false)
    // 给没有互斥的实现一次完整事件循环：它会在读者放开前以 busy 登记高水位 10。
    await new Promise(resolve => setTimeout(resolve, 0))
    release.resolve()
    await reading
    expect(await registering).toMatchObject({ kind: 'registered', lastDraftSeq: 11, existing: { kind: 'draft', meta: { draftSeq: 11 } } })
  })

  it('比对把镜像里的第 11 份写回，新的登记继承高水位 11', async () => {
    const w = await world()
    await rolledBack(w)
    const page = await w.open()
    expect(await page.register(KEY, W2, false)).toMatchObject({ kind: 'registered', lastDraftSeq: 11, existing: { kind: 'draft', meta: { draftSeq: 11, writeEpoch: 3 } } })
  })

  it.each(['restoreDraft', 'readDraft', 'mirror'] as const)('%s 一时出错：不登记、不改镜像；重试恢复第 11 份', async (operation) => {
    const w = await world()
    await rolledBack(w)
    const page = await w.open()
    if (operation === 'mirror')
      w.files.failNextOpen({ kind: 'failed', error: new TypeError('一时出错') })
    else
      w.store.failNext(operation, { kind: 'failed', error: new TypeError('一时出错') })
    expect(await page.register(KEY, W2, false)).toMatchObject({ kind: 'failed' })
    expect(w.store.rawWriter(KEY)).toMatchObject({ ...W1, lastDraftSeq: 10 })
    expect(await slots(w.files)).toEqual(['e3:seq10', 'e3:seq11'])
    expect(await page.register(KEY, W2, false)).toMatchObject({ kind: 'registered', lastDraftSeq: 11, existing: { kind: 'draft', meta: { draftSeq: 11 } } })
  })

  it('库里留着候选写入者的旧草稿：写回更完整的一份，不动现有写入者与高水位', () => {
    const meta = (seq: number) => sampleMeta({ ...W1, draftSeq: seq, inFlight: null, updatedAt: NOW })
    expect(decideRestore({ ...KEY, ...W2, lastDraftSeq: 10, registeredAt: NOW }, { kind: 'draft', draft: meta(10) }, meta(11), NOW))
      .toEqual({ kind: 'restore', writer: 'keep' })
  })

  it('回滚后的候选与库里自己的草稿冲突：保留双方，留下 lost，重复比对不刷新提示时刻', async () => {
    const w = await world()
    const current = await sealed(w.key, W2, 10, 'current')
    w.store.putRaw('drafts', KEY, current)
    w.store.putRaw('writers', KEY, { ...KEY, ...W2, lastDraftSeq: 10, registeredAt: NOW })
    w.files.putFile(KEY, 0, await slotBytes(await sealed(w.key, W1, 12, 'unseen'), 1))
    w.files.putFile(KEY, 1, new Uint8Array(0))
    const page = await w.open()
    expect(await page.read(KEY)).toMatchObject({ kind: 'draft', meta: { draftSeq: 10 } })
    expect(await slots(w.files)).toEqual(['e3:seq12', 'empty'])
    expect(readRecoveryNotice(w.store.rawNotice(KEY))).toMatchObject({ kind: 'lost', at: NOW })
    w.advance(1_000)
    await page.read(KEY)
    expect(readRecoveryNotice(w.store.rawNotice(KEY))).toMatchObject({ kind: 'lost', at: NOW })
    expect(w.store.rawDraft(KEY)).toEqual(structuredClone(current))
  })

  it('平台页面只读比对不留下 lost，也不截断未读过的冲突镜像', async () => {
    const w = await world()
    w.store.putRaw('drafts', KEY, await sealed(w.key, W2, 10, 'current'))
    w.store.putRaw('writers', KEY, { ...KEY, ...W2, lastDraftSeq: 10, registeredAt: NOW })
    w.files.putFile(KEY, 0, await slotBytes(await sealed(w.key, W1, 12, 'unseen'), 1))
    w.files.putFile(KEY, 1, new Uint8Array(0))
    const recovery = pageReconciliation({ store: w.store.store, directory: w.files.directory, now: () => NOW })
    await recovery.reconcile(KEY)
    expect(w.store.rawNotice(KEY)).toBeUndefined()
    expect(await slots(w.files)).toEqual(['e3:seq12', 'empty'])
  })
})

describe('部署回滚不破坏更新格式的镜像（复验 C2）', () => {
  it.each(['torn', 'valid'] as const)('更新格式与 %s 槽位并存：不恢复旧份、不报丢失、不截断、不覆盖', async (other) => {
    const w = await world()
    const newer = await slotBytes(await sealed(w.key, W1, 20, 'written by newer page'), 9)
    new DataView(newer.buffer).setUint16(8, 2, true)
    const old = await slotBytes(await sealed(w.key, W1, 3, 'old'), 4)
    const second = other === 'torn' ? old.slice(0, old.byteLength - 5) : old
    w.files.putFile(KEY, 0, newer)
    w.files.putFile(KEY, 1, second)
    const page = await w.open()
    expect(await page.read(KEY)).toEqual({ kind: 'absent' })
    expect(w.store.rawNotice(KEY)).toBeUndefined()
    expect(await page.register(KEY, W2, false)).toMatchObject({ kind: 'registered', lastDraftSeq: 0, mirror: { kind: 'not-mirrored', reason: 'newer-format' } })
    expect(await page.write(capture(W2, 1, 'current page'))).toMatchObject({ kind: 'written', mirror: { kind: 'not-mirrored', reason: 'newer-format' } })
    expect(w.files.file(KEY, 0)).toEqual(newer)
    expect(w.files.file(KEY, 1)).toEqual(second)
    await page.remove(KEY)
    expect(w.files.file(KEY, 0)).toEqual(newer)
    expect(w.files.file(KEY, 1)).toEqual(second)
  })
})

describe('清理过程中不允许旧页面重建镜像（复验 C5）', () => {
  it('IndexedDB 已提交但尚未写镜像：清理等待整个写入结束，重试后不会有旧草稿复活', async () => {
    const w = await world()
    const committed = deferred<void>()
    const resume = deferred<void>()
    const page = await w.open({ store: {
      ...w.store.store,
      writeDraft: async (...args) => {
        const result = await w.store.store.writeDraft(...args)
        committed.resolve()
        await resume.promise
        return result
      },
    } })
    await page.register(KEY, W1, false)
    await page.release(KEY)
    const writing = page.write(capture(W1, 1, 'one'))
    await committed.promise
    const cleanup = createLocalCleanup({ store: w.store.store, directory: w.files.directory, now: () => NOW })
    const cleaning = cleanup.removeUser(USER_ID)
    await new Promise(resolve => setTimeout(resolve, 0))
    resume.resolve()
    await writing
    const first = await cleaning
    // 已结束写入的 Worker 仍保留句柄时清理交回 pending，墓碑不能提前删。
    expect(first).toEqual({ kind: 'cleared', pending: [KEY] })
    await page.release(KEY)
    expect(await cleanup.removeUser(USER_ID)).toEqual({ kind: 'cleared', pending: [] })
    expect(await slots(w.files)).toEqual(['missing', 'missing'])
    const reader = await w.open()
    expect(await reader.read(KEY)).toEqual({ kind: 'absent' })
  })

  it('删镜像之后、清库之前的写入被墓碑拦住，重新打开没有草稿复活', async () => {
    const w = await world()
    const page = await w.open()
    expect(await page.register(KEY, W1, false)).toMatchObject({ kind: 'registered' })
    expect(await page.write(capture(W1, 1, 'one'))).toMatchObject({ kind: 'written', mirror: { kind: 'mirrored' } })
    await page.release(KEY)
    const cleanup = createLocalCleanup({ store: w.store.store, directory: w.files.directory, now: () => NOW })
    const held = w.store.holdNext('removeUserData')
    const cleaning = cleanup.removeUser(USER_ID)
    await held.reached
    const writing = page.write(capture(W1, 2, 'two'))
    try {
      expect(await slots(w.files)).toEqual(['missing', 'missing'])
    }
    finally {
      held.release()
      await cleaning
    }
    expect(await writing).toMatchObject({ kind: 'fenced', reason: 'not-writer' })
    expect(await cleaning).toEqual({ kind: 'cleared', pending: [] })
    expect([w.store.rawDraft(KEY), w.store.rawWriter(KEY)]).toEqual([undefined, undefined])
    expect(await slots(w.files)).toEqual(['missing', 'missing'])
    const later = await w.open()
    expect(await later.read(KEY)).toEqual({ kind: 'absent' })
    expect(w.store.rawNotice(KEY)).toBeUndefined()
  })
})
