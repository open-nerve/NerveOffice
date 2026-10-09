import type { LocalKeyHandle } from './draft-codec.ts'
import type { DraftKey, DraftMeta, InFlightSave, StoredDraft } from './draft-record.ts'
import type { FakeDraftStore } from './draft-store.test-support.ts'
import type { DraftStore } from './draft-store.ts'
import type { CaptureToWrite, DraftWriter } from './draft-writer.ts'
import type { WriterIdentity } from './writer-fence.ts'
import { describe, expect, it } from 'vitest'
import { gunzipBytes, gzipBytes, openDraft, sealDraft, sha256Hex } from './draft-codec.ts'
import { CLIENT_INSTANCE_ID, DOCUMENT_ID, NOW, OTHER_WRITER_ID, sampleMeta, USER_ID, WRITER_ID } from './draft-record.test-support.ts'
import { DRAFT_RECORD_VERSION, draftMetaOf, readStoredDraft } from './draft-record.ts'
import { fakeDraftStore } from './draft-store.test-support.ts'
import { createDraftWriter } from './draft-writer.ts'

const KEY: DraftKey = { userId: USER_ID, documentId: DOCUMENT_ID }
const OTHER_DOCUMENT: DraftKey = { userId: USER_ID, documentId: '0199b0c4-7d3e-7a3b-9c4e-00000000d0c2' }
/** 本页：第 3 代、这次登记的 W */
const ME: WriterIdentity = { writeEpoch: 3, writerId: WRITER_ID }
const FORMAT = sampleMeta().format

function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text)
}

function textOf(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

async function localKey(version: number, raw = crypto.getRandomValues(new Uint8Array(32))): Promise<LocalKeyHandle> {
  return { version, key: await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']) }
}

function inFlight(localSeq: number, overrides: Partial<InFlightSave> = {}): InFlightSave {
  return { requestId: `0199b0c4-7d3e-7a3b-9c4e-0000000e000${localSeq}`, clientInstanceId: CLIENT_INSTANCE_ID, localSeq, sentAt: NOW, ...overrides }
}

function capture(draftSeq: number, content: string, overrides: Partial<CaptureToWrite> = {}): CaptureToWrite {
  return {
    key: KEY,
    writer: ME,
    draftSeq,
    baseRevision: 12,
    writtenBy: CLIENT_INSTANCE_ID,
    format: FORMAT,
    formulasPending: false,
    inFlight: null,
    bytes: utf8(content),
    dedupe: true,
    ...overrides,
  }
}

interface Setup {
  readonly fake: FakeDraftStore
  readonly writer: DraftWriter
  readonly key: LocalKeyHandle
  /** 墙上时间往前走 */
  readonly advance: (ms: number) => void
}

/** 假存储 + 管道（墙上时间从 NOW 起、可拨）+ 第 2 版的密钥；默认已经以本页登记为 KEY 的写入者 */
async function setup(options: { readonly withKey?: boolean, readonly register?: boolean, readonly store?: (fake: FakeDraftStore) => DraftStore } = {}): Promise<Setup> {
  const fake = fakeDraftStore()
  let wallClock = NOW
  const writer = createDraftWriter({ store: options.store?.(fake) ?? fake.store, now: () => wallClock })
  const key = await localKey(2)
  if (options.withKey !== false)
    await writer.setKey(key)
  if (options.register !== false)
    expect(await writer.register(KEY, ME, false)).toMatchObject({ kind: 'registered' })
  return { fake, writer, key, advance: (ms) => {
    wallClock += ms
  } }
}

/** 库里的那一份：形状核对、解开、解压之后的元数据与文字 */
async function stored(fake: FakeDraftStore, key: LocalKeyHandle, draftKey: DraftKey = KEY): Promise<{ readonly meta: DraftMeta, readonly text: string, readonly record: StoredDraft }> {
  const read = readStoredDraft(fake.rawDraft(draftKey))
  if (read.kind !== 'draft')
    throw new Error(`库里没有认得出的草稿：${read.kind}`)
  const opened = await openDraft(key, read.draft)
  if (opened.kind !== 'opened')
    throw new Error(`解不开：${opened.reason}`)
  return { meta: draftMetaOf(read.draft), text: textOf(await gunzipBytes(opened.gzip)), record: read.draft }
}

/** 别的写入者（第 2 代、OTHER_WRITER_ID）留下的第 6 份：用 key 加密，直接放进库里，写入者记录也是它 */
async function putForeignDraft(fake: FakeDraftStore, key: LocalKeyHandle, content: string, overrides: Partial<DraftMeta> = {}): Promise<StoredDraft> {
  const { keyVersion: _keyVersion, ...meta } = sampleMeta({ writeEpoch: 2, writerId: OTHER_WRITER_ID, draftSeq: 6, inFlight: null, rawBytes: utf8(content).byteLength, ...overrides })
  const draft = await sealDraft(key, meta, await gzipBytes(utf8(content)))
  fake.putRaw('drafts', KEY, draft)
  fake.putRaw('writers', KEY, { ...KEY, writeEpoch: 2, writerId: OTHER_WRITER_ID, lastDraftSeq: 6, registeredAt: NOW - 1_000 })
  return draft
}

function count(fake: FakeDraftStore, operation: FakeDraftStore['calls'][number]): number {
  return fake.calls.filter(call => call === operation).length
}

describe('写入（M4-P1 设计 §3.4.3）：去重 → gzip → 加密 → 交给存储，写成功交回 gzip', () => {
  it('库里是加密的记录：元数据取自这次捕获，密钥版本取自密钥，更新时间是这一刻；解开、解压等于原来的字节；交回的 gzip 解压之后同样等于输入', async () => {
    const { fake, writer, key, advance } = await setup()
    advance(3_000)
    const content = '{"甲":"汉字与 emoji 😀","n":[1,2,3]}'
    const result = await writer.write(capture(1, content, { formulasPending: true }))
    expect(result).toMatchObject({ kind: 'written', digest: await sha256Hex(utf8(content)) })
    if (result.kind !== 'written')
      throw new Error('应当写成')
    expect(textOf(await gunzipBytes(result.gzip))).toBe(content)
    const { meta, text } = await stored(fake, key)
    expect(text).toBe(content)
    expect(meta).toEqual({
      ...KEY,
      recordVersion: DRAFT_RECORD_VERSION,
      draftSeq: 1,
      baseRevision: 12,
      writeEpoch: ME.writeEpoch,
      writerId: ME.writerId,
      writtenBy: CLIENT_INSTANCE_ID,
      format: FORMAT,
      formulasPending: true,
      keyVersion: 2,
      inFlight: null,
      rawBytes: utf8(content).byteLength,
      updatedAt: NOW + 3_000,
    })
    expect(fake.rawWriter(KEY), '高水位随之抬到这个序号').toMatchObject({ lastDraftSeq: 1 })
  })

  it('在途的保存照样写进记录（上传进行中继续输入，恢复时认"自己追自己"）', async () => {
    const { fake, writer, key } = await setup()
    expect(await writer.write(capture(2, 'two', { inFlight: inFlight(1) }))).toMatchObject({ kind: 'written' })
    expect((await stored(fake, key)).meta.inFlight).toEqual(inFlight(1))
  })

  it('在途的保存比这一份新：不写（failed），压缩之前就拦下，库不动', async () => {
    const { fake, writer } = await setup()
    const result = await writer.write(capture(2, 'two', { inFlight: inFlight(3) }))
    expect(result).toMatchObject({ kind: 'failed', gzip: null, error: { name: 'InvalidCapture' } })
    expect(count(fake, 'writeDraft')).toBe(0)
  })

  it('交回的 gzip 是调用方自己的一份：改动它，之后的重封照样是原来的内容', async () => {
    const { fake, writer, key } = await setup()
    const result = await writer.write(capture(1, 'original'))
    if (result.kind !== 'written')
      throw new Error('应当写成')
    result.gzip.fill(0)
    expect(await writer.markInFlight(KEY, ME, inFlight(1))).toEqual({ kind: 'resealed' })
    expect((await stored(fake, key)).text).toBe('original')
  })

  it('去重：内容与"公式待更新"都与上次写入的相同才交回 unchanged（不写）；标记不同、内容不同、不允许去重都照常写', async () => {
    const { fake, writer } = await setup()
    const digest = await sha256Hex(utf8('same'))
    expect(await writer.write(capture(1, 'same'))).toMatchObject({ kind: 'written', digest })
    expect(await writer.write(capture(2, 'same'))).toEqual({ kind: 'unchanged', digest })
    expect(count(fake, 'writeDraft')).toBe(1)
    expect(await writer.write(capture(3, 'same', { formulasPending: true })), '标记不同').toMatchObject({ kind: 'written' })
    expect(await writer.write(capture(4, 'same', { formulasPending: true, dedupe: false })), '显式保存不去重').toMatchObject({ kind: 'written' })
    expect(await writer.write(capture(5, 'other', { formulasPending: true }))).toMatchObject({ kind: 'written' })
    expect(await writer.write(capture(6, 'same', { formulasPending: true })), '与上一次写入的不同').toMatchObject({ kind: 'written' })
    expect(count(fake, 'writeDraft')).toBe(5)
  })

  it('没写成的捕获之后不去重：那一份照样会上传，服务端可能已经不是上次写下的内容——再与上次写下的相同也照常写', async () => {
    const { fake, writer } = await setup()
    expect(await writer.write(capture(1, 'C'))).toMatchObject({ kind: 'written' })
    fake.failNext('writeDraft', { kind: 'quota' })
    expect(await writer.write(capture(2, 'D'))).toMatchObject({ kind: 'quota' })
    expect(await writer.write(capture(3, 'C'))).toMatchObject({ kind: 'written' })
  })

  it('去重的起点：登记之后清空；seedDigest 设定、清空；放弃之后清空', async () => {
    const { writer } = await setup()
    expect(await writer.write(capture(1, 'C'))).toMatchObject({ kind: 'written' })
    expect(await writer.register(KEY, ME, false)).toMatchObject({ kind: 'registered', lastDraftSeq: 1 })
    expect(await writer.write(capture(2, 'C')), '登记之后').toMatchObject({ kind: 'written' })
    await writer.seedDigest(KEY, { digest: await sha256Hex(utf8('S')), formulasPending: true })
    expect(await writer.write(capture(3, 'S')), '标记与起点不同').toMatchObject({ kind: 'written' })
    await writer.seedDigest(KEY, { digest: await sha256Hex(utf8('S')), formulasPending: false })
    expect(await writer.write(capture(4, 'S'))).toMatchObject({ kind: 'unchanged' })
    await writer.seedDigest(KEY, undefined)
    expect(await writer.write(capture(5, 'S')), '清空之后').toMatchObject({ kind: 'written' })
    expect(await writer.remove(KEY)).toEqual({ kind: 'removed' })
    expect(await writer.write(capture(6, 'S')), '放弃之后').toMatchObject({ kind: 'written' })
  })

  it('去重按文档：另一份文档的相同内容照常写', async () => {
    const { writer } = await setup()
    expect(await writer.register(OTHER_DOCUMENT, ME, false)).toMatchObject({ kind: 'registered' })
    expect(await writer.write(capture(1, 'same'))).toMatchObject({ kind: 'written' })
    expect(await writer.write(capture(1, 'same', { key: OTHER_DOCUMENT }))).toMatchObject({ kind: 'written' })
  })

  it('没有密钥：交回 no-key 与 gzip（上传照旧），不写', async () => {
    const { fake, writer } = await setup({ withKey: false })
    const result = await writer.write(capture(1, 'content'))
    expect(result.kind).toBe('no-key')
    if (result.kind !== 'no-key')
      throw new Error('应当没有密钥')
    expect(textOf(await gunzipBytes(result.gzip))).toBe('content')
    expect(count(fake, 'writeDraft')).toBe(0)
  })

  it('存储的问题如实交回，带上 gzip：写满、库用不了、出错（错误折成名字与消息）', async () => {
    const { fake, writer } = await setup()
    fake.failNext('writeDraft', { kind: 'quota' })
    const quota = await writer.write(capture(1, 'a'))
    expect(quota.kind).toBe('quota')
    expect(quota.kind === 'quota' && textOf(await gunzipBytes(quota.gzip))).toBe('a')
    fake.failNext('writeDraft', { kind: 'unavailable', reason: 'denied' })
    const unavailable = await writer.write(capture(2, 'b'))
    expect(unavailable).toMatchObject({ kind: 'unavailable', reason: 'denied' })
    expect(unavailable.kind === 'unavailable' && textOf(await gunzipBytes(unavailable.gzip))).toBe('b')
    fake.failNext('writeDraft', { kind: 'failed', error: new DOMException('磁盘出错', 'UnknownError') })
    const failed = await writer.write(capture(3, 'c'))
    expect(failed).toMatchObject({ kind: 'failed', error: { name: 'UnknownError', message: '磁盘出错' } })
    expect(failed.kind === 'failed' && failed.gzip !== null && textOf(await gunzipBytes(failed.gzip))).toBe('c')
    fake.failNext('writeDraft', { kind: 'failed', error: 'not an error object' })
    expect(await writer.write(capture(4, 'd'))).toMatchObject({ kind: 'failed', error: { name: 'Error', message: 'not an error object' } })
  })

  it('栅栏拒绝如实交回（带上 gzip）：不是写入者、序号不大于高水位；库里那一份不变', async () => {
    const { fake, writer, key } = await setup()
    const fenced = await writer.write(capture(1, 'a', { writer: { writeEpoch: 3, writerId: OTHER_WRITER_ID } }))
    expect(fenced).toMatchObject({ kind: 'fenced', reason: 'not-writer' })
    expect(fenced.kind === 'fenced' && textOf(await gunzipBytes(fenced.gzip))).toBe('a')
    expect(fake.rawDraft(KEY)).toBeUndefined()
    expect(await writer.write(capture(5, 'a'))).toMatchObject({ kind: 'written' })
    expect(await writer.write(capture(4, 'b'))).toMatchObject({ kind: 'fenced', reason: 'stale-seq' })
    expect((await stored(fake, key)).meta.draftSeq).toBe(5)
  })

  it('别的写入者留下、还没接手的草稿不覆盖（foreign-draft）；带上接手的序号就照常写', async () => {
    const { fake, writer, key } = await setup({ register: false })
    await putForeignDraft(fake, key, 'left behind')
    expect(await writer.register(KEY, ME, false)).toMatchObject({ kind: 'registered', lastDraftSeq: 6 })
    expect(await writer.write(capture(7, 'mine'))).toMatchObject({ kind: 'fenced', reason: 'foreign-draft' })
    expect((await stored(fake, key)).text).toBe('left behind')
    expect(await writer.write(capture(8, 'mine', { adoptSeq: 6 }))).toMatchObject({ kind: 'written' })
    expect((await stored(fake, key)).text).toBe('mine')
  })

  it('存储没按约定交回而是抛出：照样以 failed 交回，不抛', async () => {
    const { writer } = await setup({ store: fake => ({ ...fake.store, writeDraft: async () => Promise.reject(new TypeError('坏了')) }) })
    const failed = await writer.write(capture(1, 'a'))
    expect(failed).toMatchObject({ kind: 'failed', error: { name: 'TypeError', message: '坏了' } })
    expect(failed.kind === 'failed' && failed.gzip !== null && textOf(await gunzipBytes(failed.gzip)), '压缩之后出的错照样带上 gzip').toBe('a')
  })
})

describe('同一份文档的操作排成一队，按调用的先后；不同文档互不等待', () => {
  it('前一次写入还在存储里时，同一份文档的下一次写入不交给存储；另一份文档照常写完', async () => {
    const { fake, writer, key } = await setup()
    expect(await writer.register(OTHER_DOCUMENT, ME, false)).toMatchObject({ kind: 'registered' })
    const held = fake.holdNext('writeDraft')
    const first = writer.write(capture(1, 'first'))
    const second = writer.write(capture(2, 'second'))
    await held.reached
    expect(await writer.write(capture(1, 'other document', { key: OTHER_DOCUMENT }))).toMatchObject({ kind: 'written' })
    expect(count(fake, 'writeDraft'), '第二次还排着').toBe(2)
    held.release()
    expect(await first).toMatchObject({ kind: 'written' })
    expect(await second).toMatchObject({ kind: 'written' })
    expect((await stored(fake, key)).text).toBe('second')
    expect((await stored(fake, key, OTHER_DOCUMENT)).text).toBe('other document')
  })

  it('读回排在之前的写入之后：读到的是刚写下的', async () => {
    const { writer } = await setup()
    const written = writer.write(capture(1, 'just written'))
    const read = await writer.read(KEY)
    expect(read.kind).toBe('draft')
    expect(read.kind === 'draft' && textOf(await gunzipBytes(read.gzip))).toBe('just written')
    expect(await written).toMatchObject({ kind: 'written' })
  })

  it('排在前面的出错不影响后面的：出错的那一次以 failed 交回，队列接着走', async () => {
    let calls = 0
    const { writer } = await setup({ store: fake => ({ ...fake.store, writeDraft: async (draft, options) => {
      calls += 1
      return calls === 1 ? Promise.reject(new Error('第一次坏了')) : fake.store.writeDraft(draft, options)
    } }) })
    const first = writer.write(capture(1, 'a'))
    const second = writer.write(capture(2, 'b'))
    expect(await first).toMatchObject({ kind: 'failed' })
    expect(await second).toMatchObject({ kind: 'written' })
  })
})

describe('标记在途（§3.4.4）：先落盘再发请求；按新的 AAD 与新的 IV 重封，比较并交换', () => {
  it('重封本页最新的一份：内容不变，带上在途的请求与这一刻，IV 换新的', async () => {
    const { fake, writer, key, advance } = await setup()
    await writer.write(capture(1, 'content'))
    const before = await stored(fake, key)
    advance(5_000)
    expect(await writer.markInFlight(KEY, ME, inFlight(1))).toEqual({ kind: 'resealed' })
    const after = await stored(fake, key)
    expect(after.text).toBe('content')
    expect(after.meta).toEqual({ ...before.meta, inFlight: inFlight(1), updatedAt: NOW + 5_000 })
    expect(Array.from(after.record.iv)).not.toEqual(Array.from(before.record.iv))
    expect(count(fake, 'replaceDraft')).toBe(1)
  })

  it('在途的是更早的一份、库里已是更新的（上传期间又写了新的）：标在更新的那一份上', async () => {
    const { fake, writer, key } = await setup()
    await writer.write(capture(1, 'one'))
    await writer.write(capture(2, 'two'))
    expect(await writer.markInFlight(KEY, ME, inFlight(1))).toEqual({ kind: 'resealed' })
    const { meta, text } = await stored(fake, key)
    expect([meta.draftSeq, meta.inFlight?.localSeq, text]).toEqual([2, 1, 'two'])
  })

  it('库里没有、或者只有比在途的更旧的内容：不标记（absent）——否则恢复时会把旧内容接到服务端更新的那一版上', async () => {
    const { fake, writer, key } = await setup()
    expect(await writer.markInFlight(KEY, ME, inFlight(1))).toEqual({ kind: 'absent' })
    await writer.write(capture(1, 'one'))
    expect(await writer.markInFlight(KEY, ME, inFlight(2))).toEqual({ kind: 'absent' })
    expect((await stored(fake, key)).meta.inFlight).toBeNull()
    expect(count(fake, 'replaceDraft')).toBe(0)
  })

  it('手里没有最新的一份时先解开库里的（管道重建之后）', async () => {
    const { fake, writer, key } = await setup()
    await writer.write(capture(1, 'from before'))
    const rebuilt = createDraftWriter({ store: fake.store, now: () => NOW + 9_000 })
    await rebuilt.setKey(key)
    expect(await rebuilt.markInFlight(KEY, ME, inFlight(1))).toEqual({ kind: 'resealed' })
    const { meta, text } = await stored(fake, key)
    expect([text, meta.updatedAt, meta.inFlight?.localSeq]).toEqual(['from before', NOW + 9_000, 1])
  })

  it('库里已不是本页写下的那一份：fenced（changed）；写入者换了：fenced（not-writer）；记录都不动', async () => {
    const { fake, writer, key } = await setup()
    await writer.write(capture(1, 'mine'))
    const foreign = await putForeignDraft(fake, key, 'theirs')
    fake.putRaw('writers', KEY, { ...KEY, ...ME, lastDraftSeq: 6, registeredAt: NOW })
    expect(await writer.markInFlight(KEY, ME, inFlight(1))).toEqual({ kind: 'fenced', reason: 'changed' })
    const untouched = await stored(fake, key)
    // 字节按值比较（库里的是结构化克隆出来的，属于另一个 realm）
    expect([untouched.meta, Array.from(untouched.record.ciphertext)]).toEqual([draftMetaOf(foreign), Array.from(foreign.ciphertext)])
    await writer.write(capture(7, 'mine again', { adoptSeq: 6 }))
    fake.putRaw('writers', KEY, { ...KEY, writeEpoch: 4, writerId: OTHER_WRITER_ID, lastDraftSeq: 7, registeredAt: NOW })
    expect(await writer.markInFlight(KEY, ME, inFlight(7))).toEqual({ kind: 'fenced', reason: 'not-writer' })
    expect((await stored(fake, key)).meta.inFlight).toBeNull()
  })

  it('库里那一份是本页写下的、却用当前的密钥解不开：failed，不动它', async () => {
    const { fake, writer, key } = await setup()
    await writer.write(capture(1, 'content'))
    const rebuilt = createDraftWriter({ store: fake.store, now: () => NOW })
    await rebuilt.setKey(await localKey(3))
    expect(await rebuilt.markInFlight(KEY, ME, inFlight(1))).toMatchObject({ kind: 'failed', error: { name: 'DraftUnreadable' } })
    expect((await stored(fake, key)).meta.inFlight).toBeNull()
  })

  it('没有密钥：no-key，记录不动；存储的问题如实交回', async () => {
    const { fake, writer, key } = await setup()
    await writer.write(capture(1, 'content'))
    fake.failNext('replaceDraft', { kind: 'quota' })
    expect(await writer.markInFlight(KEY, ME, inFlight(1))).toEqual({ kind: 'quota' })
    await writer.setKey(undefined)
    expect(await writer.markInFlight(KEY, ME, inFlight(1))).toEqual({ kind: 'no-key' })
    expect((await stored(fake, key)).meta.inFlight).toBeNull()
  })
})

describe('确认（§3.4.5）：只删到已确认的序号；更新的改基准、清掉在途', () => {
  it('草稿就是确认的那一份：删掉；高水位留着（序号不回头）', async () => {
    const { fake, writer } = await setup()
    await writer.write(capture(1, 'one'))
    await writer.markInFlight(KEY, ME, inFlight(1))
    expect(await writer.confirm(KEY, ME, 1, 13)).toEqual({ kind: 'deleted' })
    expect(fake.rawDraft(KEY)).toBeUndefined()
    expect(fake.rawWriter(KEY)).toMatchObject({ lastDraftSeq: 1 })
  })

  it('确认期间又写了新的（保存中继续输入，A08）：不删，基准换成新的修订号、清掉在途，内容是新的那一份', async () => {
    const { fake, writer, key, advance } = await setup()
    await writer.write(capture(1, 'one'))
    await writer.markInFlight(KEY, ME, inFlight(1))
    await writer.write(capture(2, 'two', { inFlight: inFlight(1) }))
    advance(2_000)
    expect(await writer.confirm(KEY, ME, 1, 13)).toEqual({ kind: 'rebased' })
    const { meta, text } = await stored(fake, key)
    expect(text).toBe('two')
    expect(meta).toMatchObject({ draftSeq: 2, baseRevision: 13, inFlight: null, updatedAt: NOW + 2_000 })
  })

  it('改过基准的那一份之后照常确认、删掉', async () => {
    const { fake, writer } = await setup()
    await writer.write(capture(1, 'one'))
    await writer.write(capture(2, 'two'))
    expect(await writer.confirm(KEY, ME, 1, 13)).toEqual({ kind: 'rebased' })
    expect(await writer.confirm(KEY, ME, 2, 14)).toEqual({ kind: 'deleted' })
    expect(fake.rawDraft(KEY)).toBeUndefined()
  })

  it('已经没有草稿：absent；写入者换了：fenced（not-writer），新一代的记录不删', async () => {
    const { fake, writer, key } = await setup()
    expect(await writer.confirm(KEY, ME, 1, 13)).toEqual({ kind: 'absent' })
    await writer.write(capture(1, 'one'))
    fake.putRaw('writers', KEY, { ...KEY, writeEpoch: 4, writerId: OTHER_WRITER_ID, lastDraftSeq: 1, registeredAt: NOW })
    expect(await writer.confirm(KEY, ME, 1, 13)).toEqual({ kind: 'fenced', reason: 'not-writer' })
    expect((await stored(fake, key)).text).toBe('one')
  })

  it('库里是别的写入者留下的：fenced（foreign-draft），不删（本页的上传不包含它的内容）', async () => {
    const { fake, writer, key } = await setup()
    await putForeignDraft(fake, key, 'theirs')
    fake.putRaw('writers', KEY, { ...KEY, ...ME, lastDraftSeq: 6, registeredAt: NOW })
    expect(await writer.confirm(KEY, ME, 9, 13)).toEqual({ kind: 'fenced', reason: 'foreign-draft' })
    expect((await stored(fake, key)).text).toBe('theirs')
  })

  it('库里的比管道记着的新（存储交回 needs-rebase）：按库里现在的那一份重新准备再来', async () => {
    const { fake, writer, key } = await setup()
    await writer.write(capture(1, 'one'))
    // 同一个写入者的另一份更新的（例如重建之前的管道写下的）：管道手里记着的还是第 1 份
    const { keyVersion: _keyVersion, ...meta } = sampleMeta({ ...ME, draftSeq: 2, inFlight: inFlight(1), rawBytes: 3 })
    fake.putRaw('drafts', KEY, await sealDraft(key, meta, await gzipBytes(utf8('two'))))
    fake.putRaw('writers', KEY, { ...KEY, ...ME, lastDraftSeq: 2, registeredAt: NOW })
    expect(await writer.confirm(KEY, ME, 1, 13)).toEqual({ kind: 'rebased' })
    expect(count(fake, 'confirmDraft')).toBe(2)
    const after = await stored(fake, key)
    expect([after.text, after.meta.draftSeq, after.meta.baseRevision, after.meta.inFlight]).toEqual(['two', 2, 13, null])
  })

  it('一直对不上：试过几次之后 failed，不挂住', async () => {
    const { fake, writer } = await setup({ store: fake => ({ ...fake.store, confirmDraft: async () => ({ kind: 'needs-rebase' }) }) })
    await writer.write(capture(1, 'one'))
    expect(await writer.confirm(KEY, ME, 1, 13)).toMatchObject({ kind: 'failed', error: { name: 'ConfirmRace' } })
    expect(fake.rawDraft(KEY)).toBeDefined()
  })

  it('要改基准、手里却没有密钥：no-key，记录不动；只是删就不需要密钥', async () => {
    const { fake, writer, key } = await setup()
    await writer.write(capture(1, 'one'))
    await writer.write(capture(2, 'two'))
    await writer.setKey(undefined)
    expect(await writer.confirm(KEY, ME, 1, 13)).toEqual({ kind: 'no-key' })
    expect((await stored(fake, key)).meta.baseRevision).toBe(12)
    expect(await writer.confirm(KEY, ME, 2, 14)).toEqual({ kind: 'deleted' })
  })

  it('存储的问题如实交回', async () => {
    const { fake, writer } = await setup()
    await writer.write(capture(1, 'one'))
    fake.failNext('confirmDraft', { kind: 'unavailable', reason: 'blocked' })
    expect(await writer.confirm(KEY, ME, 1, 13)).toEqual({ kind: 'unavailable', reason: 'blocked' })
  })

  it('删掉之后，相同的内容去重（服务端已经有了）；确认时已没有草稿（absent）之后不再去重', async () => {
    const { writer } = await setup()
    await writer.write(capture(1, 'C'))
    expect(await writer.confirm(KEY, ME, 1, 13)).toEqual({ kind: 'deleted' })
    expect(await writer.write(capture(2, 'C', { baseRevision: 13 }))).toMatchObject({ kind: 'unchanged' })
    expect(await writer.confirm(KEY, ME, 2, 13)).toEqual({ kind: 'absent' })
    expect(await writer.write(capture(3, 'C', { baseRevision: 13 }))).toMatchObject({ kind: 'written' })
  })
})

describe('读回（§3.4.6）：解开，或者归类', () => {
  it('draft：元数据与解开的 gzip', async () => {
    const { writer } = await setup()
    await writer.write(capture(1, 'content', { inFlight: inFlight(1) }))
    const read = await writer.read(KEY)
    expect(read).toMatchObject({ kind: 'draft', meta: { draftSeq: 1, keyVersion: 2, inFlight: inFlight(1) } })
    expect(read.kind === 'draft' && textOf(await gunzipBytes(read.gzip))).toBe('content')
  })

  it('解不开：记录的密钥版本比当前的小 → revoked；版本不小（被改过的明文、不是这把密钥）→ corrupted；都带元数据', async () => {
    const { fake, writer } = await setup()
    await writer.write(capture(1, 'content'))
    const newer = createDraftWriter({ store: fake.store, now: () => NOW })
    await newer.setKey(await localKey(3))
    expect(await newer.read(KEY)).toMatchObject({ kind: 'unreadable', reason: 'revoked', meta: { draftSeq: 1, keyVersion: 2 } })
    const raw = fake.rawDraft(KEY) as StoredDraft
    fake.putRaw('drafts', KEY, { ...raw, baseRevision: raw.baseRevision + 1 })
    expect(await writer.read(KEY)).toMatchObject({ kind: 'unreadable', reason: 'corrupted', meta: { baseRevision: 13 } })
  })

  it('没有密钥：no-key，带元数据（恢复的提示要用它的时刻）', async () => {
    const { fake, writer, key } = await setup()
    await writer.write(capture(1, 'content'))
    const keyless = createDraftWriter({ store: fake.store, now: () => NOW })
    expect(await keyless.read(KEY)).toEqual({ kind: 'no-key', meta: (await stored(fake, key)).meta })
  })

  it('没有、更新的页面写的、形状不对、存储的问题', async () => {
    const { fake, writer } = await setup()
    expect(await writer.read(KEY)).toEqual({ kind: 'absent' })
    fake.putRaw('drafts', KEY, { recordVersion: DRAFT_RECORD_VERSION + 1 })
    expect(await writer.read(KEY)).toEqual({ kind: 'newer-format', recordVersion: DRAFT_RECORD_VERSION + 1 })
    fake.putRaw('drafts', KEY, { recordVersion: DRAFT_RECORD_VERSION })
    expect(await writer.read(KEY)).toEqual({ kind: 'malformed' })
    fake.failNext('readDraft', { kind: 'unavailable', reason: 'newer-version' })
    expect(await writer.read(KEY)).toEqual({ kind: 'unavailable', reason: 'newer-version' })
  })
})

describe('登记写入者（§3.4.2）', () => {
  it('registered：交回高水位与现有的草稿（已解开，恢复用）；force 照样交给存储', async () => {
    const { fake, writer, key } = await setup({ register: false })
    await putForeignDraft(fake, key, 'left behind')
    const registered = await writer.register(KEY, ME, false)
    expect(registered).toMatchObject({ kind: 'registered', lastDraftSeq: 6, existing: { kind: 'draft', meta: { writerId: OTHER_WRITER_ID, draftSeq: 6 } } })
    expect(registered.kind === 'registered' && registered.existing?.kind === 'draft' && textOf(await gunzipBytes(registered.existing.gzip))).toBe('left behind')
    fake.putRaw('writers', KEY, { ...KEY, writeEpoch: 9, writerId: OTHER_WRITER_ID, lastDraftSeq: 6, registeredAt: NOW })
    expect(await writer.register(KEY, ME, false)).toEqual({ kind: 'superseded', currentEpoch: 9, sameEpoch: false })
    expect(await writer.register(KEY, ME, true)).toMatchObject({ kind: 'registered', lastDraftSeq: 6 })
  })

  it('没有草稿：existing 为 undefined', async () => {
    const { writer } = await setup({ register: false })
    expect(await writer.register(KEY, ME, false)).toEqual({ kind: 'registered', lastDraftSeq: 0, existing: undefined })
  })

  it('现有的草稿解不开、没有密钥、更新的页面写的、形状不对：都归类交回', async () => {
    const { fake, writer, key } = await setup({ register: false })
    await putForeignDraft(fake, await localKey(1), 'old key')
    expect(await writer.register(KEY, ME, false)).toMatchObject({ existing: { kind: 'unreadable', reason: 'revoked', meta: { keyVersion: 1 } } })
    await putForeignDraft(fake, key, 'content')
    const keyless = createDraftWriter({ store: fake.store, now: () => NOW })
    expect(await keyless.register(KEY, ME, false)).toMatchObject({ existing: { kind: 'no-key', meta: { draftSeq: 6 } } })
    fake.putRaw('drafts', KEY, { recordVersion: 5 })
    expect(await writer.register(KEY, ME, false)).toMatchObject({ existing: { kind: 'newer-format', recordVersion: 5 } })
    fake.putRaw('drafts', KEY, 'garbage')
    expect(await writer.register(KEY, ME, false)).toMatchObject({ existing: { kind: 'malformed' } })
  })

  it('存储的问题如实交回（登记也可能写满）', async () => {
    const { fake, writer } = await setup({ register: false })
    fake.failNext('registerWriter', { kind: 'quota' })
    expect(await writer.register(KEY, ME, false)).toEqual({ kind: 'quota' })
  })
})

describe('放弃（§3.4.7）', () => {
  it('交给存储（带 expectedSeq 时只删那一份），结果原样交回', async () => {
    const { fake, writer } = await setup()
    await writer.write(capture(1, 'one'))
    await writer.write(capture(2, 'two'))
    expect(await writer.remove(KEY, 1)).toEqual({ kind: 'changed' })
    expect(await writer.remove(KEY, 2)).toEqual({ kind: 'removed' })
    expect(await writer.remove(KEY)).toEqual({ kind: 'absent' })
    fake.failNext('removeDraft', { kind: 'failed', error: new DOMException('x', 'AbortError') })
    expect(await writer.remove(KEY)).toEqual({ kind: 'failed', error: { name: 'AbortError', message: 'x' } })
  })

  it('放弃之后，标记在途找不到手里那一份（不去重封已经删掉的）', async () => {
    const { writer } = await setup()
    await writer.write(capture(1, 'one'))
    await writer.remove(KEY)
    expect(await writer.markInFlight(KEY, ME, inFlight(1))).toEqual({ kind: 'absent' })
  })
})

describe('换密钥（§3.4.4）：之后的写入用新密钥；本页写下的草稿用新密钥重封', () => {
  it('重封本页写下的每一份：内容不变，带上新版本；旧密钥随之解不开', async () => {
    const { fake, writer, key } = await setup()
    expect(await writer.register(OTHER_DOCUMENT, ME, false)).toMatchObject({ kind: 'registered' })
    await writer.write(capture(1, 'one'))
    await writer.write(capture(1, 'other', { key: OTHER_DOCUMENT }))
    const next = await localKey(3)
    expect(await writer.setKey(next)).toEqual({ kind: 'key-set', notResealed: [] })
    for (const [draftKey, content] of [[KEY, 'one'], [OTHER_DOCUMENT, 'other']] as const) {
      const { meta, text, record } = await stored(fake, next, draftKey)
      expect([meta.keyVersion, text]).toEqual([3, content])
      expect(await openDraft(key, record)).toEqual({ kind: 'unreadable', reason: 'corrupted' })
    }
    expect(await writer.write(capture(2, 'two'))).toMatchObject({ kind: 'written' })
    expect((await stored(fake, next)).meta).toMatchObject({ keyVersion: 3, draftSeq: 2 })
  })

  it('版本没变（同一把密钥再给一次）：不重封', async () => {
    const { fake, writer } = await setup()
    await writer.write(capture(1, 'one'))
    expect(await writer.setKey(await localKey(2))).toEqual({ kind: 'key-set', notResealed: [] })
    expect(count(fake, 'replaceDraft')).toBe(0)
  })

  it('没能重封的交回（写满）：记录还是旧版本；那份文档下一次不去重，以新密钥重写', async () => {
    const { fake, writer, key } = await setup()
    await writer.write(capture(1, 'C'))
    fake.failNext('replaceDraft', { kind: 'quota' })
    const next = await localKey(3)
    expect(await writer.setKey(next)).toEqual({ kind: 'key-set', notResealed: [KEY] })
    expect((await stored(fake, key)).meta.keyVersion).toBe(2)
    expect(await writer.write(capture(2, 'C'))).toMatchObject({ kind: 'written' })
    expect((await stored(fake, next)).meta.keyVersion).toBe(3)
  })

  it('重封时库里已经不是那一份（别的写入者）：不算没重封（不是本页的了）', async () => {
    const { fake, writer, key } = await setup()
    await writer.write(capture(1, 'mine'))
    fake.putRaw('writers', KEY, { ...KEY, writeEpoch: 4, writerId: OTHER_WRITER_ID, lastDraftSeq: 1, registeredAt: NOW })
    expect(await writer.setKey(await localKey(3))).toEqual({ kind: 'key-set', notResealed: [] })
    expect((await stored(fake, key)).meta.keyVersion).toBe(2)
  })

  it('写入途中换密钥：那一次按开始时的密钥写下，随后用新密钥重封', async () => {
    const { fake, writer } = await setup()
    const held = fake.holdNext('writeDraft')
    const written = writer.write(capture(1, 'in the middle'))
    await held.reached
    const next = await localKey(3)
    const changed = writer.setKey(next)
    held.release()
    expect(await written).toMatchObject({ kind: 'written' })
    expect(await changed).toEqual({ kind: 'key-set', notResealed: [] })
    const { meta, text } = await stored(fake, next)
    expect([meta.keyVersion, text]).toEqual([3, 'in the middle'])
  })

  it('丢掉密钥：之后的写入 no-key；再给新密钥时照样重封手里的那一份', async () => {
    const { fake, writer } = await setup()
    await writer.write(capture(1, 'one'))
    expect(await writer.setKey(undefined)).toEqual({ kind: 'key-set', notResealed: [] })
    expect(await writer.write(capture(2, 'two'))).toMatchObject({ kind: 'no-key' })
    const next = await localKey(3)
    expect(await writer.setKey(next)).toEqual({ kind: 'key-set', notResealed: [] })
    expect((await stored(fake, next)).meta).toMatchObject({ keyVersion: 3, draftSeq: 1 })
  })
})

describe('关闭', () => {
  it('dispose 之后一律 failed（排着的也不做），关掉存储的连接', async () => {
    const { fake, writer } = await setup()
    const held = fake.holdNext('writeDraft')
    const first = writer.write(capture(1, 'one'))
    const queued = writer.write(capture(2, 'two'))
    await held.reached
    writer.dispose()
    held.release()
    expect(await first, '已经交给存储的照常结束').toMatchObject({ kind: 'written' })
    expect(await queued).toMatchObject({ kind: 'failed', error: { name: 'InvalidStateError' } })
    expect(await writer.read(KEY)).toMatchObject({ kind: 'failed' })
    expect(await writer.register(KEY, ME, false)).toMatchObject({ kind: 'failed' })
    expect(await writer.setKey(await localKey(3))).toMatchObject({ kind: 'failed' })
    await expect(writer.seedDigest(KEY, undefined)).resolves.toBeUndefined()
    expect(count(fake, 'writeDraft')).toBe(1)
    expect(fake.closed()).toBe(1)
  })
})

describe('跨边界不抛异常：存储抛出时每个操作都以 failed 交回', () => {
  it('登记、标记在途、确认、读回、放弃', async () => {
    const reject = async () => Promise.reject(new Error('坏了'))
    const { fake, writer } = await setup({ register: false, store: fake => ({ ...fake.store, registerWriter: reject, replaceDraft: reject, confirmDraft: reject, readDraft: reject, removeDraft: reject }) })
    const failed = { kind: 'failed', error: { name: 'Error', message: '坏了' } }
    expect(await writer.register(KEY, ME, false)).toEqual(failed)
    fake.putRaw('writers', KEY, { ...KEY, ...ME, lastDraftSeq: 0, registeredAt: NOW })
    expect(await writer.write(capture(1, 'one'))).toMatchObject({ kind: 'written' })
    expect(await writer.markInFlight(KEY, ME, inFlight(1))).toEqual(failed)
    expect(await writer.confirm(KEY, ME, 1, 13)).toEqual(failed)
    expect(await writer.read(KEY)).toEqual(failed)
    expect(await writer.remove(KEY)).toEqual(failed)
  })
})
