import type { LocalKeyHandle } from './draft-codec.ts'
import type { DraftMirror } from './draft-mirror.ts'
import type { DraftKey, DraftMeta, InFlightSave, StoredDraft } from './draft-record.ts'
import type { FakeDraftStore } from './draft-store.test-support.ts'
import type { CaptureToWrite, DraftWriter } from './draft-writer.ts'
import type { FakeMirrorDirectory } from './mirror-directory.test-support.ts'
import type { WriterIdentity } from './writer-fence.ts'
import { describe, expect, it } from 'vitest'
import { gunzipBytes, gzipBytes, sealDraft } from './draft-codec.ts'
import { createDraftMirror } from './draft-mirror.ts'
import { CLIENT_INSTANCE_ID, DOCUMENT_ID, NOW, OTHER_WRITER_ID, sampleMeta, USER_ID, WRITER_ID } from './draft-record.test-support.ts'
import { draftMetaOf, readStoredDraft, readWriterRecord } from './draft-record.ts'
import { fakeDraftStore } from './draft-store.test-support.ts'
import { createDraftWriter } from './draft-writer.ts'
import { fakeMirrorDirectory } from './mirror-directory.test-support.ts'
import { encodeSlot, parseSlot, SLOT_HEADER_BYTES } from './mirror-slot.ts'
import { LOCAL_DRAFT_RETENTION_MS } from './writer-fence.ts'

const KEY: DraftKey = { userId: USER_ID, documentId: DOCUMENT_ID }
const OTHER_DOCUMENT: DraftKey = { userId: USER_ID, documentId: '0199b0c4-7d3e-7a3b-9c4e-00000000d0c2' }
const ME: WriterIdentity = { writeEpoch: 3, writerId: WRITER_ID }
const RETRY = { initialMs: 500, maxMs: 4_000 }

function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text)
}

function textOf(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

async function localKey(version: number): Promise<LocalKeyHandle> {
  return { version, key: await crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)), 'AES-GCM', false, ['encrypt', 'decrypt']) }
}

function capture(draftSeq: number, content: string, overrides: Partial<CaptureToWrite> = {}): CaptureToWrite {
  return { key: KEY, writer: ME, draftSeq, baseRevision: 12, writtenBy: CLIENT_INSTANCE_ID, format: sampleMeta().format, formulasPending: false, inFlight: null, bytes: utf8(content), dedupe: true, ...overrides }
}

function inFlight(localSeq: number): InFlightSave {
  return { requestId: `request-${localSeq}`, clientInstanceId: CLIENT_INSTANCE_ID, localSeq, sentAt: NOW }
}

interface Setup {
  readonly store: FakeDraftStore
  readonly files: FakeMirrorDirectory
  readonly mirror: DraftMirror
  readonly writer: DraftWriter
  readonly key: LocalKeyHandle
  /** 墙上时间、单调时钟往前走 */
  readonly advance: (ms: number) => void
  /** 换一个管道（同一个库、同一份镜像）：模拟页面重新打开 */
  readonly reopen: (options?: { readonly store?: FakeDraftStore }) => Promise<DraftWriter>
}

/** 假存储 + 内存里的 OPFS + 真的镜像逻辑 + 管道；第 2 版的密钥；默认已以本页登记 */
async function setup(options: { readonly register?: boolean } = {}): Promise<Setup> {
  const store = fakeDraftStore()
  const files = fakeMirrorDirectory()
  let wall = NOW
  let monotonic = 0
  const key = await localKey(2)
  const make = async (target: FakeDraftStore): Promise<{ readonly writer: DraftWriter, readonly mirror: DraftMirror }> => {
    const mirror = createDraftMirror({ directory: files.directory, clock: { now: () => monotonic }, retry: RETRY })
    const writer = createDraftWriter({ store: target.store, now: () => wall, mirror })
    await writer.setKey(key)
    return { writer, mirror }
  }
  const { writer, mirror } = await make(store)
  if (options.register !== false)
    expect(await writer.register(KEY, ME, false)).toMatchObject({ kind: 'registered', mirror: { kind: 'mirrored' } })
  return {
    store,
    files,
    mirror,
    writer,
    key,
    advance: (ms) => {
      wall += ms
      monotonic += ms
    },
    reopen: async (reopenOptions = {}) => (await make(reopenOptions.store ?? store)).writer,
  }
}

/** 槽位文件读出来的样子 */
async function slots(files: FakeMirrorDirectory, key: DraftKey = KEY): Promise<string[]> {
  const result: string[] = []
  for (const slot of [0, 1] as const) {
    const bytes = files.file(key, slot)
    if (bytes === undefined) {
      result.push('missing')
      continue
    }
    const read = await parseSlot(bytes)
    result.push(read.kind === 'valid' ? `seq${read.record.draftSeq}` : read.kind === 'empty' ? 'empty' : `invalid:${read.reason}`)
  }
  return result
}

/** 最新的那个合格的槽位里的元数据 */
async function newestMirrored(files: FakeMirrorDirectory, key: DraftKey = KEY): Promise<DraftMeta | undefined> {
  let newest: { readonly generation: number, readonly meta: DraftMeta } | undefined
  for (const slot of [0, 1] as const) {
    const bytes = files.file(key, slot)
    const read = bytes === undefined ? undefined : await parseSlot(bytes)
    if (read?.kind === 'valid' && (newest === undefined || read.header.generation > newest.generation))
      newest = { generation: read.header.generation, meta: draftMetaOf(read.record) }
  }
  return newest?.meta
}

/** 放一份槽位文件（上一次会话留下的、被改坏的） */
async function putSlot(files: FakeMirrorDirectory, key: DraftKey, slot: 0 | 1, record: StoredDraft, generation: number): Promise<void> {
  const { header, content } = await encodeSlot(record, generation)
  const file = new Uint8Array(SLOT_HEADER_BYTES + content.byteLength)
  file.set(header)
  file.set(content, SLOT_HEADER_BYTES)
  files.putFile(key, slot, file)
}

/** 用 key 封一份记录（不经管道） */
async function sealed(key: LocalKeyHandle, content: string, overrides: Partial<DraftMeta> = {}): Promise<StoredDraft> {
  const { keyVersion: _keyVersion, ...meta } = sampleMeta({ ...ME, inFlight: null, rawBytes: utf8(content).byteLength, ...overrides })
  return sealDraft(key, meta, await gzipBytes(utf8(content)))
}

describe('写镜像（M4-P1 设计 §3.8）：IndexedDB 写成之后同一份记录写进镜像', () => {
  it('登记时建好两个槽位、拿着句柄；写入之后镜像里是库里的同一份记录，结果带 mirrored', async () => {
    const { store, files, writer } = await setup()
    expect(await slots(files)).toEqual(['empty', 'empty'])
    expect(files.openHandles()).toBe(2)
    const written = await writer.write(capture(1, 'one'))
    expect(written).toMatchObject({ kind: 'written', mirror: { kind: 'mirrored' } })
    const inStore = readStoredDraft(store.rawDraft(KEY))
    const mirrored = await parseSlot(files.file(KEY, 0) ?? new Uint8Array())
    expect(inStore.kind === 'draft' && mirrored.kind === 'valid' && [draftMetaOf(mirrored.record), Array.from(mirrored.record.ciphertext)]).toEqual(inStore.kind === 'draft' && [draftMetaOf(inStore.draft), Array.from(inStore.draft.ciphertext)])
    await writer.write(capture(2, 'two'))
    expect(await slots(files)).toEqual(['seq1', 'seq2'])
  })

  it('镜像没写成（别的标签页占着句柄、写满）：库照样写成，结果里带上原因；之后拿到了就照常', async () => {
    const { store, files, writer, advance } = await setup({ register: false })
    const release = files.holdElsewhere(KEY)
    expect(await writer.register(KEY, ME, false)).toMatchObject({ kind: 'registered', mirror: { kind: 'not-mirrored', reason: 'busy' } })
    expect(await writer.write(capture(1, 'one'))).toMatchObject({ kind: 'written', mirror: { kind: 'not-mirrored', reason: 'busy' } })
    expect(readStoredDraft(store.rawDraft(KEY)).kind).toBe('draft')
    release()
    advance(RETRY.initialMs * 2)
    expect(await writer.write(capture(2, 'two'))).toMatchObject({ kind: 'written', mirror: { kind: 'mirrored' } })
    files.failWrite(0, 5, 'QuotaExceededError')
    expect(await writer.write(capture(3, 'three'))).toMatchObject({ kind: 'written', mirror: { kind: 'not-mirrored', reason: 'quota' } })
    const kept = readStoredDraft(store.rawDraft(KEY))
    expect(kept.kind === 'draft' && kept.draft.draftSeq).toBe(3)
    expect(await slots(files)).toEqual(['seq2', 'invalid:torn'])
  })

  it('镜像出了意外（抛出）：只交回没写成，库那一份照样写成', async () => {
    const store = fakeDraftStore()
    const throwing: DraftMirror = {
      attach: async () => ({ kind: 'mirrored' }),
      write: async () => Promise.reject(new TypeError('坏了')),
      clear: async () => ({ kind: 'mirrored' }),
      read: async () => ({ kind: 'absent' }),
      detach: () => {},
      documents: async () => ({ kind: 'listed', documentIds: [] }),
      close: () => {},
    }
    const writer = createDraftWriter({ store: store.store, now: () => NOW, mirror: throwing })
    await writer.setKey(await localKey(2))
    await writer.register(KEY, ME, false)
    expect(await writer.write(capture(1, 'one'))).toMatchObject({ kind: 'written', mirror: { kind: 'not-mirrored', reason: 'failed', error: { name: 'TypeError', message: '坏了' } } })
  })

  it('标记在途、改基准、换密钥：镜像跟着写新的一份', async () => {
    const { files, writer } = await setup()
    await writer.write(capture(1, 'one'))
    await writer.markInFlight(KEY, ME, inFlight(1))
    expect((await newestMirrored(files))?.inFlight).toEqual(inFlight(1))
    await writer.write(capture(2, 'two', { inFlight: inFlight(1) }))
    expect(await writer.confirm(KEY, ME, 1, 13)).toEqual({ kind: 'rebased' })
    expect(await newestMirrored(files)).toMatchObject({ draftSeq: 2, baseRevision: 13, inFlight: null })
    const next = await localKey(3)
    await writer.setKey(next)
    expect(await newestMirrored(files)).toMatchObject({ draftSeq: 2, keyVersion: 3 })
  })

  it('重写同一份内容时更新时间只增不减（时钟往回拨过）：同一个序号的几份靠它分先后', async () => {
    const { files, writer, advance } = await setup()
    advance(10_000)
    await writer.write(capture(1, 'one'))
    const written = await newestMirrored(files)
    advance(-60_000)
    await writer.markInFlight(KEY, ME, inFlight(1))
    const resealed = await newestMirrored(files)
    expect(resealed?.updatedAt).toBe((written?.updatedAt ?? 0) + 1)
  })

  it('确认删草稿、放弃：两个槽位截断为 0', async () => {
    const { files, writer } = await setup()
    await writer.write(capture(1, 'one'))
    await writer.write(capture(2, 'two'))
    expect(await writer.confirm(KEY, ME, 2, 13)).toEqual({ kind: 'deleted' })
    expect(await slots(files)).toEqual(['empty', 'empty'])
    await writer.write(capture(3, 'three'))
    expect(await writer.remove(KEY)).toEqual({ kind: 'removed' })
    expect(await slots(files)).toEqual(['empty', 'empty'])
  })

  it('失去写入者（被栅栏拒绝 not-writer、页面说不再是写入者）：放开句柄，新的写入者拿得到', async () => {
    const { store, files, writer } = await setup()
    await writer.write(capture(1, 'one'))
    store.putRaw('writers', KEY, { ...KEY, writeEpoch: 4, writerId: OTHER_WRITER_ID, lastDraftSeq: 1, registeredAt: NOW })
    expect(await writer.write(capture(2, 'two'))).toMatchObject({ kind: 'fenced', reason: 'not-writer' })
    expect(files.openHandles()).toBe(0)
    store.putRaw('writers', KEY, { ...KEY, ...ME, lastDraftSeq: 1, registeredAt: NOW })
    expect(await writer.write(capture(3, 'three'))).toMatchObject({ kind: 'written', mirror: { kind: 'mirrored' } })
    expect(files.openHandles()).toBe(2)
    await writer.release(KEY)
    expect(files.openHandles()).toBe(0)
  })

  it('标记在途、确认被栅栏拒绝（not-writer）、登记被更新的一代挡住：同样放开句柄', async () => {
    const newer = { ...KEY, writeEpoch: 4, writerId: OTHER_WRITER_ID, lastDraftSeq: 1, registeredAt: NOW }
    const fencedOn = async (action: (writer: DraftWriter) => Promise<unknown>): Promise<{ readonly result: unknown, readonly handles: number }> => {
      const { store, files, writer } = await setup()
      await writer.write(capture(1, 'one'))
      expect(files.openHandles()).toBe(2)
      store.putRaw('writers', KEY, newer)
      return { result: await action(writer), handles: files.openHandles() }
    }
    expect(await fencedOn(async writer => writer.markInFlight(KEY, ME, inFlight(1)))).toEqual({ result: { kind: 'fenced', reason: 'not-writer' }, handles: 0 })
    expect(await fencedOn(async writer => writer.confirm(KEY, ME, 1, 13))).toEqual({ result: { kind: 'fenced', reason: 'not-writer' }, handles: 0 })
    expect(await fencedOn(async writer => writer.register(KEY, ME, false))).toEqual({ result: { kind: 'superseded', currentEpoch: 4, sameEpoch: false }, handles: 0 })
  })
})

describe('读与恢复（§3.8）：先比对镜像与库，镜像更新时写回；读时取校验通过、解得开、最新的那一份', () => {
  it('删库之后：读回镜像里那一份，写回库（连同写入者：代次、writerId、高水位），留下 restored（只留一次）', async () => {
    const { files, writer, reopen } = await setup()
    await writer.write(capture(1, 'one'))
    await writer.write(capture(2, 'two'))
    writer.dispose()
    const wiped = fakeDraftStore()
    const reopened = await reopen({ store: wiped })
    const read = await reopened.read(KEY)
    expect(read).toMatchObject({ kind: 'draft', meta: { draftSeq: 2, writerId: WRITER_ID } })
    expect(read.kind === 'draft' && textOf(await gunzipBytes(read.gzip))).toBe('two')
    expect(readStoredDraft(wiped.rawDraft(KEY))).toMatchObject({ kind: 'draft', draft: { draftSeq: 2 } })
    expect(readWriterRecord(wiped.rawWriter(KEY))).toMatchObject({ writeEpoch: 3, writerId: WRITER_ID, lastDraftSeq: 2 })
    expect(await reopened.takeRecoveryEvents()).toEqual([{ kind: 'restored', key: KEY }])
    await reopened.read(KEY)
    expect(await reopened.takeRecoveryEvents(), '取走之后没有新的').toEqual([])
    expect(await slots(files)).toEqual(['seq1', 'seq2'])
  })

  it('删库之后登记新的一代：先写回旧的那一份与它的写入者，再登记——现有的草稿是旧写入者的（恢复由 P3 决定），高水位接着它', async () => {
    const { writer, reopen } = await setup()
    await writer.write(capture(5, 'five'))
    writer.dispose()
    const wiped = fakeDraftStore()
    const reopened = await reopen({ store: wiped })
    const registered = await reopened.register(KEY, { writeEpoch: 4, writerId: OTHER_WRITER_ID }, false)
    expect(registered).toMatchObject({ kind: 'registered', lastDraftSeq: 5, existing: { kind: 'draft', meta: { draftSeq: 5, writerId: WRITER_ID } }, mirror: { kind: 'mirrored' } })
    expect(readWriterRecord(wiped.rawWriter(KEY))).toMatchObject({ writeEpoch: 4, writerId: OTHER_WRITER_ID, lastDraftSeq: 5 })
    expect(await reopened.takeRecoveryEvents()).toEqual([{ kind: 'restored', key: KEY }])
  })

  it('库丢了已提交的写入（Chromium 的悄悄丢失）：镜像里的更新，写回、抬高水位', async () => {
    const { store, files, writer, key } = await setup()
    await writer.write(capture(1, 'one'))
    await writer.release(KEY)
    await putSlot(files, KEY, 1, await sealed(key, 'two', { draftSeq: 2 }), 99)
    const read = await writer.read(KEY)
    expect(read.kind === 'draft' && textOf(await gunzipBytes(read.gzip))).toBe('two')
    expect(readWriterRecord(store.rawWriter(KEY))?.lastDraftSeq).toBe(2)
    expect(await writer.takeRecoveryEvents()).toEqual([{ kind: 'restored', key: KEY }])
  })

  it('同一份内容的重封更新（库丢了标记在途的那次提交）：按更新时间认出镜像更新，写回', async () => {
    const { store, files, writer, key } = await setup()
    await writer.write(capture(1, 'one'))
    await writer.release(KEY)
    await putSlot(files, KEY, 1, await sealed(key, 'one', { draftSeq: 1, inFlight: inFlight(1), updatedAt: NOW + 5_000 }), 99)
    expect(await writer.read(KEY)).toMatchObject({ kind: 'draft', meta: { draftSeq: 1, inFlight: inFlight(1) } })
    expect(readStoredDraft(store.rawDraft(KEY))).toMatchObject({ kind: 'draft', draft: { inFlight: inFlight(1) } })
  })

  it('被确认删掉、放弃过的不复活：镜像里留着的那一份（当时没截断成）随之截断，没有事件', async () => {
    const { files, writer, key } = await setup()
    await writer.write(capture(1, 'one'))
    expect(await writer.confirm(KEY, ME, 1, 13)).toEqual({ kind: 'deleted' })
    await writer.release(KEY)
    await putSlot(files, KEY, 0, await sealed(key, 'one', { draftSeq: 1 }), 5)
    expect(await writer.read(KEY)).toEqual({ kind: 'absent' })
    expect(await slots(files)).toEqual(['empty', 'empty'])
    expect(await writer.takeRecoveryEvents()).toEqual([])
  })

  it('超过保留期的不写回（删库之后也一样），镜像随之截断', async () => {
    const { files, reopen, key } = await setup({ register: false })
    await putSlot(files, KEY, 0, await sealed(key, 'old', { draftSeq: 1, updatedAt: NOW - LOCAL_DRAFT_RETENTION_MS - 1 }), 1)
    files.putFile(KEY, 1, new Uint8Array(0))
    const reopened = await reopen({ store: fakeDraftStore() })
    expect(await reopened.read(KEY)).toEqual({ kind: 'absent' })
    expect(await slots(files)).toEqual(['empty', 'empty'])
  })

  it('两个槽位都不合格、库里也没有（连写入者都没了：删库）：留下 lost（只留一次）；库里还有写入者（草稿是被删掉的）时不算', async () => {
    const { files, reopen, key } = await setup({ register: false })
    const record = await sealed(key, 'one', { draftSeq: 1 })
    await putSlot(files, KEY, 0, record, 1)
    files.putFile(KEY, 0, (files.file(KEY, 0) ?? new Uint8Array()).slice(0, 300))
    files.putFile(KEY, 1, new Uint8Array(400).fill(7))
    const wiped = await reopen({ store: fakeDraftStore() })
    expect(await wiped.read(KEY)).toEqual({ kind: 'absent' })
    expect(await wiped.read(KEY)).toEqual({ kind: 'absent' })
    expect(await wiped.takeRecoveryEvents()).toEqual([{ kind: 'lost', key: KEY }])
    const withWriter = fakeDraftStore()
    withWriter.putRaw('writers', KEY, { ...KEY, ...ME, lastDraftSeq: 1, registeredAt: NOW })
    const notLost = await reopen({ store: withWriter })
    expect(await notLost.read(KEY)).toEqual({ kind: 'absent' })
    expect(await notLost.takeRecoveryEvents()).toEqual([])
  })

  it('两个槽位都是空的（确认删掉时截断过）而库被删了：没有可丢的，不留 lost', async () => {
    const { writer, reopen } = await setup()
    await writer.write(capture(1, 'one'))
    expect(await writer.confirm(KEY, ME, 1, 13)).toEqual({ kind: 'deleted' })
    writer.dispose()
    const wiped = await reopen({ store: fakeDraftStore() })
    expect(await wiped.read(KEY)).toEqual({ kind: 'absent' })
    expect(await wiped.takeRecoveryEvents()).toEqual([])
  })

  it('库用不了（读草稿交回 unavailable、failed）：镜像里有合格的就交回它（不写回）；没有时如实交回库的问题', async () => {
    const { store, files, writer } = await setup()
    await writer.write(capture(1, 'one'))
    await writer.release(KEY)
    store.failNext('readDraft', { kind: 'unavailable', reason: 'blocked' })
    const fromMirror = await writer.read(KEY)
    expect(fromMirror.kind === 'draft' && [fromMirror.meta.draftSeq, textOf(await gunzipBytes(fromMirror.gzip))]).toEqual([1, 'one'])
    expect(store.calls.filter(call => call === 'restoreDraft')).toEqual([])
    files.putFile(KEY, 0, new Uint8Array(0))
    store.failNext('readDraft', { kind: 'failed', error: new TypeError('坏了') })
    expect(await writer.read(KEY)).toEqual({ kind: 'failed', error: { name: 'TypeError', message: '坏了' } })
  })

  it('读时取最新、解得开的那一份：库里那一份坏了（解不开）时交回镜像里同一份完好的；镜像里那一份也坏了时交回能解开的旧的', async () => {
    const { store, files, writer } = await setup()
    await writer.write(capture(1, 'one'))
    await writer.write(capture(2, 'two'))
    await writer.release(KEY)
    const raw = store.rawDraft(KEY) as StoredDraft
    const tampered = new Uint8Array(raw.ciphertext)
    tampered[0] = (tampered[0] ?? 0) ^ 0xFF
    store.putRaw('drafts', KEY, { ...raw, ciphertext: tampered })
    const fromMirror = await writer.read(KEY)
    expect(fromMirror.kind === 'draft' && [fromMirror.meta.draftSeq, textOf(await gunzipBytes(fromMirror.gzip))]).toEqual([2, 'two'])
    // 镜像里第 2 份所在的槽位也坏了（写一半）：只剩第 1 份能解开
    files.putFile(KEY, 1, (files.file(KEY, 1) ?? new Uint8Array()).slice(0, 300))
    const older = await writer.read(KEY)
    expect(older.kind === 'draft' && [older.meta.draftSeq, textOf(await gunzipBytes(older.gzip))]).toEqual([1, 'one'])
    expect(await slots(files)).toEqual(['seq1', 'invalid:torn'])
  })

  it('打开平台时的比对：这个用户在镜像里的每份文档，删库之后都写回，各留一个 restored', async () => {
    const { writer, reopen } = await setup()
    await writer.register(OTHER_DOCUMENT, ME, false)
    await writer.write(capture(1, 'one'))
    await writer.write(capture(1, 'other', { key: OTHER_DOCUMENT }))
    writer.dispose()
    const wiped = fakeDraftStore()
    const reopened = await reopen({ store: wiped })
    expect(await reopened.reconcile(USER_ID)).toEqual({ kind: 'reconciled', documents: 2 })
    expect((await reopened.takeRecoveryEvents()).map(event => event.key.documentId).sort()).toEqual([DOCUMENT_ID, OTHER_DOCUMENT.documentId].sort())
    for (const key of [KEY, OTHER_DOCUMENT])
      expect(readStoredDraft(wiped.rawDraft(key)).kind).toBe('draft')
  })

  it('库里已经是镜像里那一份或者更新的（打开、读草稿时的常事）：只读地看库，不开读写的事务；库里更旧时才交给存储写回', async () => {
    const { store, files, writer, key, reopen } = await setup()
    await writer.register(OTHER_DOCUMENT, ME, false)
    await writer.write(capture(1, 'one'))
    await writer.write(capture(1, 'other', { key: OTHER_DOCUMENT }))
    writer.dispose()
    const reopened = await reopen()
    const callsOf = async (action: () => Promise<unknown>): Promise<string[]> => {
      const before = store.calls.length
      await action()
      return store.calls.slice(before)
    }
    expect(await callsOf(async () => reopened.read(KEY)), '读草稿：读库一次').toEqual(['readDraft'])
    expect(await callsOf(async () => reopened.register(KEY, ME, false)), '登记：先只读地比对').toEqual(['readDraft', 'registerWriter'])
    expect(await callsOf(async () => reopened.reconcile(USER_ID)), '打开平台时的比对').toEqual(['readDraft', 'readDraft'])
    // 库里的更旧（库丢了已提交的写入）：交给存储在一个事务里判定、写回
    await reopened.release(KEY)
    await putSlot(files, KEY, 1, await sealed(key, 'two', { draftSeq: 2 }), 99)
    expect(await callsOf(async () => reopened.read(KEY))).toEqual(['readDraft', 'restoreDraft'])
    expect(await reopened.takeRecoveryEvents()).toEqual([{ kind: 'restored', key: KEY }])
  })

  it('没有镜像的宿主：读与比对照旧只看库，结果里是 off', async () => {
    const store = fakeDraftStore()
    const writer = createDraftWriter({ store: store.store, now: () => NOW })
    await writer.setKey(await localKey(2))
    expect(await writer.register(KEY, ME, false)).toEqual({ kind: 'registered', lastDraftSeq: 0, existing: undefined, mirror: { kind: 'off' } })
    expect(await writer.write(capture(1, 'one'))).toMatchObject({ kind: 'written', mirror: { kind: 'off' } })
    expect(await writer.reconcile(USER_ID)).toEqual({ kind: 'reconciled', documents: 0 })
    expect(await writer.takeRecoveryEvents()).toEqual([])
  })
})
