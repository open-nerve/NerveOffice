import type { AdoptionCapture } from './draft-writer.ts'
import { describe, expect, it, vi } from 'vitest'
import { gunzipBytes, gzipBytes, openDraft, sealDraft } from './draft-codec.ts'
import { createDraftMirror } from './draft-mirror.ts'
import { NOW, sampleMeta } from './draft-record.test-support.ts'
import { readStoredDraft } from './draft-record.ts'
import { createDraftRecovery } from './draft-recovery.ts'
import { fakeDraftStore } from './draft-store.test-support.ts'
import { createDraftWriter } from './draft-writer.ts'
import { fakeMirrorDirectory } from './mirror-directory.test-support.ts'
import { encodeSlot } from './mirror-slot.ts'
import { RETIRED_WRITER_ID } from './writer-fence.ts'

const META = sampleMeta({ rawBytes: new TextEncoder().encode('original in-flight body').byteLength })
const KEY = { userId: META.userId, documentId: META.documentId }
const NEXT_WRITER = { writeEpoch: META.writeEpoch + 1, writerId: 'recovery-writer' }
const decode = async (gzip: Uint8Array<ArrayBuffer>) => new TextDecoder().decode(await gunzipBytes(gzip))

function capture(): AdoptionCapture {
  return { key: KEY, writer: NEXT_WRITER, draftSeq: META.draftSeq + 1, baseRevision: META.baseRevision + 1, writtenBy: 'new-instance', format: META.format, formulasPending: true, bytes: new TextEncoder().encode('recovered with new formulas') }
}

async function setup(options: { readonly register?: boolean, readonly mirror?: boolean } = {}) {
  const fake = fakeDraftStore()
  const files = fakeMirrorDirectory()
  const handle = { version: META.keyVersion, key: await crypto.subtle.importKey('raw', new Uint8Array(32), 'AES-GCM', false, ['encrypt', 'decrypt']) }
  const gzip = await gzipBytes(new TextEncoder().encode('original in-flight body'))
  const record = await sealDraft(handle, META, gzip)
  fake.putRaw('drafts', KEY, record)
  fake.putRaw('writers', KEY, { ...KEY, writeEpoch: META.writeEpoch, writerId: META.writerId, lastDraftSeq: META.draftSeq, registeredAt: NOW })
  const mirror = createDraftMirror({ directory: files.directory, clock: { now: () => NOW } })
  const writer = createDraftWriter({ store: fake.store, directory: files.directory, now: () => NOW + 1, ...(options.mirror === false ? {} : { mirror, recovery: createDraftRecovery({ store: fake.store, mirror, now: () => NOW }) }) })
  await writer.setKey(handle)
  if (options.register !== false)
    expect(await writer.register(KEY, NEXT_WRITER, false)).toMatchObject({ kind: 'registered' })
  return { fake, files, handle, record, gzip, mirror, writer }
}

describe('恢复观察与原子接手的写入管道', () => {
  it('只读观察不登记，保持原序号、在途元数据与原字节', async () => {
    const h = await setup({ register: false, mirror: false })
    const observed = await h.writer.observe(KEY)
    expect(observed).toMatchObject({ kind: 'observed', record: { kind: 'draft', meta: META }, writer: { writerId: META.writerId } })
    if (observed.kind !== 'observed' || observed.record.kind !== 'draft')
      throw new Error('缺少可读观察')
    expect(Array.from(observed.record.gzip)).toEqual(Array.from(h.gzip))
    expect(h.fake.calls).not.toContain('registerWriter')
    expect(h.fake.rawDraft(KEY)).toEqual(structuredClone(h.record))
  })

  it('显式接手用新序号、新基准与重算内容，旧请求不继承，之后普通写入可继续', async () => {
    const h = await setup()
    const observed = await h.writer.observe(KEY)
    if (observed.kind !== 'observed')
      throw new Error('缺少观察')
    const written = await h.writer.adopt(observed.observation, capture())
    expect(written).toMatchObject({ kind: 'written', mirror: { kind: 'mirrored' } })
    if (written.kind !== 'written')
      throw new Error('缺少接手结果')
    expect(await decode(written.gzip)).toBe('recovered with new formulas')
    const stored = readStoredDraft(h.fake.rawDraft(KEY))
    if (stored.kind !== 'draft')
      throw new Error('缺少接手记录')
    expect(stored.draft).toMatchObject({ ...NEXT_WRITER, draftSeq: META.draftSeq + 1, baseRevision: META.baseRevision + 1, writtenBy: 'new-instance', inFlight: null, formulasPending: true })
    expect(await openDraft(h.handle, stored.draft)).toMatchObject({ kind: 'opened' })
    expect(await h.writer.write({ ...capture(), draftSeq: META.draftSeq + 2, inFlight: null, dedupe: false })).toMatchObject({ kind: 'written' })
    expect(await h.writer.removeObserved(observed.observation)).toEqual({ kind: 'changed' })
  })

  it.each(['new-writer', 'reseal', 'other-host', 'other-key'] as const)('旧或不相符的观察不能接手/清理：%s', async (change) => {
    const h = await setup()
    const observed = await h.writer.observe(KEY)
    if (observed.kind !== 'observed')
      throw new Error('缺少观察')
    const token = change === 'other-key' ? { ...observed.observation, key: { ...KEY, documentId: 'another' } } : observed.observation
    if (change === 'new-writer')
      await h.fake.store.registerWriter(KEY, { writeEpoch: NEXT_WRITER.writeEpoch + 1, writerId: 'next' }, { now: NOW, force: false })
    if (change === 'reseal')
      h.fake.putRaw('drafts', KEY, { ...h.record, updatedAt: NOW + 5 })
    const target = change === 'other-host' ? (await setup()).writer : h.writer
    const before = h.fake.rawDraft(KEY)
    expect(await target.adopt(token, capture())).toMatchObject({ kind: 'fenced', reason: 'changed' })
    expect(await target.removeObserved(token)).toEqual({ kind: 'changed' })
    expect(h.fake.rawDraft(KEY)).toEqual(before)
  })

  it.each([{ inFlight: META.inFlight }, { adoptSeq: META.draftSeq }, { dedupe: true }])('接手入口拒绝旧保存/弱接手/去重字段', async (extra) => {
    const h = await setup()
    const observed = await h.writer.observe(KEY)
    if (observed.kind !== 'observed')
      throw new Error('缺少观察')
    expect(await h.writer.adopt(observed.observation, { ...capture(), ...extra })).toMatchObject({ kind: 'failed', error: { name: 'InvalidRecoveryCapture' } })
    expect(h.fake.rawDraft(KEY)).toEqual(structuredClone(h.record))
  })

  it.each(['no-key', 'quota'] as const)('接手失败仍交回当前捕获 gzip，原件与凭证保留：%s', async (failure) => {
    const h = await setup()
    const observed = await h.writer.observe(KEY)
    if (observed.kind !== 'observed')
      throw new Error('缺少观察')
    if (failure === 'no-key')
      await h.writer.setKey(undefined)
    else
      h.fake.failNext('adoptObserved', { kind: 'quota' })
    const result = await h.writer.adopt(observed.observation, capture())
    expect(result.kind).toBe(failure)
    if (!('gzip' in result) || result.gzip === null)
      throw new Error('丢了内存内容')
    expect(await decode(result.gzip)).toBe('recovered with new formulas')
    expect(h.fake.rawDraft(KEY)).toEqual(structuredClone(h.record))
  })

  it('比对或存储读取失败时不给可操作观察', async () => {
    const h = await setup()
    h.fake.failNext('observeDraft', { kind: 'quota' })
    expect(await h.writer.observe(KEY)).toEqual({ kind: 'quota', recordKnown: true })
    const writer = createDraftWriter({ store: h.fake.store, now: () => NOW, recovery: { reconcile: async () => ({ mirror: { kind: 'failed', error: { name: 'ReadError', message: 'test' } }, restored: undefined }) } })
    expect(await writer.observe(KEY)).toMatchObject({ kind: 'failed', error: { name: 'MirrorUnreadable' } })
  })

  it.each(['readDraft', 'observeDraft'] as const)('镜像已经发现记录，%s 被禁止不能把存在事实折成普通不可用', async (operation) => {
    const h = await setup({ register: false })
    const slot = await encodeSlot(h.record, 1)
    const bytes = new Uint8Array([...slot.header, ...slot.content])
    h.files.putFile(KEY, 0, bytes)
    h.files.putFile(KEY, 1, new Uint8Array(0))
    h.fake.failNext(operation, { kind: 'unavailable', reason: 'denied' })
    expect(await h.writer.observe(KEY)).toEqual({ kind: 'unavailable', reason: 'denied', recordKnown: true })
    expect(h.fake.rawDraft(KEY)).toEqual(structuredClone(h.record))
    expect(h.files.file(KEY, 0)).toEqual(bytes)
    expect(h.fake.calls).not.toContain('registerWriter')
    h.writer.dispose()
  })

  it('登记中途已见镜像后主库被拒绝，同样保留存在事实且不改变写入者', async () => {
    const h = await setup({ register: false })
    const slot = await encodeSlot(h.record, 1)
    h.files.putFile(KEY, 0, new Uint8Array([...slot.header, ...slot.content]))
    h.files.putFile(KEY, 1, new Uint8Array(0))
    const before = h.fake.rawWriter(KEY)
    h.fake.failNext('readDraft', { kind: 'unavailable', reason: 'denied' })
    expect(await h.writer.register(KEY, NEXT_WRITER, false)).toEqual({ kind: 'unavailable', reason: 'denied', recordKnown: true })
    expect(h.fake.rawWriter(KEY)).toEqual(before)
    h.writer.dispose()
  })

  it('空镜像之后主库不可用不虚构已见记录', async () => {
    const h = await setup({ register: false })
    h.files.putFile(KEY, 0, new Uint8Array(0))
    h.files.putFile(KEY, 1, new Uint8Array(0))
    h.fake.failNext('observeDraft', { kind: 'unavailable', reason: 'denied' })
    expect(await h.writer.observe(KEY)).toEqual({ kind: 'unavailable', reason: 'denied' })
    h.writer.dispose()
  })

  it('已见原件后登记被栅栏拒绝，裁决保留存在事实但不带可操作凭证', async () => {
    const h = await setup({ register: false })
    const slot = await encodeSlot(h.record, 1)
    const bytes = new Uint8Array([...slot.header, ...slot.content])
    h.files.putFile(KEY, 0, bytes)
    h.files.putFile(KEY, 1, new Uint8Array(0))
    const before = h.fake.rawWriter(KEY)
    const result = await h.writer.register(KEY, { writeEpoch: META.writeEpoch, writerId: 'other-writer' }, false)
    expect(result).toEqual({ kind: 'superseded', currentEpoch: META.writeEpoch, sameEpoch: true, recordKnown: true })
    expect(result).not.toHaveProperty('observation')
    expect(h.fake.rawDraft(KEY)).toEqual(structuredClone(h.record))
    expect(h.fake.rawWriter(KEY)).toEqual(before)
    expect(h.files.file(KEY, 0)).toEqual(bytes)
    expect(h.files.openHandles()).toBe(0)
    h.writer.dispose()
  })

  it.each([false, true])('没有镜像时主库登记被拒绝，存在事实只来自实际原件：%s', async (present) => {
    const h = await setup({ register: false, mirror: false })
    if (!present)
      h.fake.putRaw('drafts', KEY, undefined)
    const before = h.fake.rawDraft(KEY)
    const result = await h.writer.register(KEY, { writeEpoch: META.writeEpoch, writerId: 'other-writer' }, false)
    expect(result).toEqual({ kind: 'superseded', currentEpoch: META.writeEpoch, sameEpoch: true, ...(present ? { recordKnown: true } : {}) })
    expect(h.fake.rawDraft(KEY)).toEqual(before)
    h.writer.dispose()
  })

  it.each(['register', 'observe'] as const)('无镜像的 %s 不丢掉主库失败前已读到原件的事实', async (operation) => {
    const h = await setup({ register: false, mirror: false })
    const problem = { kind: 'failed', error: new DOMException('读完后事务中止', 'AbortError'), recordKnown: true } as const
    vi.spyOn(h.fake.store, 'registerWriter').mockResolvedValue(problem)
    vi.spyOn(h.fake.store, 'observeDraft').mockResolvedValue(problem)
    const result = operation === 'register' ? await h.writer.register(KEY, NEXT_WRITER, false) : await h.writer.observe(KEY)
    expect(result).toMatchObject({ kind: 'failed', recordKnown: true, error: { name: 'AbortError' } })
    expect(result).not.toHaveProperty('observation')
    h.writer.dispose()
  })

  it.each([false, true])('第二槽读取失败时只保留实际已读非空第一槽的事实：存在=%s', async (present) => {
    const h = await setup({ register: false })
    const slot = await encodeSlot(h.record, 1)
    const bytes = present ? new Uint8Array([...slot.header, ...slot.content]) : new Uint8Array(0)
    h.files.putFile(KEY, 0, bytes)
    h.files.putFile(KEY, 1, new Uint8Array(0))
    const open = h.files.directory.openSlots
    vi.spyOn(h.files.directory, 'openSlots').mockImplementation(async (...args) => {
      const opened = await open(...args)
      if (opened.kind === 'opened')
        vi.spyOn(opened.slots[1], 'read').mockImplementation(() => { throw new DOMException('第二槽读失败', 'UnknownError') })
      return opened
    })
    const result = await h.writer.observe(KEY)
    expect(result).toMatchObject({ kind: 'failed', error: { name: 'MirrorUnreadable' } })
    if (present)
      expect(result).toHaveProperty('recordKnown', true)
    else
      expect(result).not.toHaveProperty('recordKnown')
    expect(result).not.toHaveProperty('observation')
    expect(h.fake.calls).not.toContain('observeDraft')
    expect(h.files.file(KEY, 0)).toEqual(bytes)
    expect(h.files.openHandles()).toBe(0)
    h.writer.dispose()
  })

  it('比对清掉过时镜像后主库观察失败，仍保留比对期间读到的主库记录存在事实', async () => {
    const h = await setup({ register: false })
    const slot = await encodeSlot({ ...h.record, writerId: 'old-writer' }, 1)
    h.files.putFile(KEY, 0, new Uint8Array([...slot.header, ...slot.content]))
    h.files.putFile(KEY, 1, new Uint8Array(0))
    vi.spyOn(h.fake.store, 'restoreDraft').mockResolvedValue({ kind: 'kept', reason: 'seen' })
    h.fake.failNext('observeDraft', { kind: 'unavailable', reason: 'denied' })
    expect(await h.writer.observe(KEY)).toEqual({ kind: 'unavailable', reason: 'denied', recordKnown: true })
    expect(h.fake.rawDraft(KEY)).toEqual(structuredClone(h.record))
    expect(h.files.file(KEY, 0)).toHaveLength(0)
    h.writer.dispose()
  })

  it.each(['busy', 'newer-format'] as const)('镜像不能完整核对时不给凭证，也不改旧主库或镜像：%s', async (reason) => {
    const h = await setup({ register: false })
    const slot = await encodeSlot(h.record, 1)
    if (reason === 'newer-format')
      new DataView(slot.header.buffer).setUint16(8, 99, true)
    const bytes = new Uint8Array([...slot.header, ...slot.content])
    h.files.putFile(KEY, 0, bytes)
    h.files.putFile(KEY, 1, new Uint8Array(0))
    const release = reason === 'busy' ? h.files.holdElsewhere(KEY) : () => {}
    expect((await h.mirror.read(KEY)).kind).toBe(reason === 'busy' ? 'busy' : 'slots')
    expect(await h.writer.observe(KEY)).toMatchObject({ kind: 'failed', error: { name: reason === 'busy' ? 'MirrorBusy' : 'MirrorUnverified' } })
    expect(h.fake.calls).not.toContain('observeDraft')
    expect(h.fake.rawDraft(KEY)).toEqual(structuredClone(h.record))
    expect(h.files.file(KEY, 0)).toEqual(bytes)
    release()
    h.writer.dispose()
  })
})

describe('原子删除之后的镜像事实', () => {
  it('先提交删除/墓碑，再关本宿主句柄并删除镜像目录', async () => {
    const h = await setup()
    const observed = await h.writer.observe(KEY)
    if (observed.kind !== 'observed')
      throw new Error('缺少观察')
    expect(h.files.openHandles()).toBe(2)
    const original = h.files.directory.removeDocument
    vi.spyOn(h.files.directory, 'removeDocument').mockImplementation(async (key) => {
      expect(h.fake.rawDraft(KEY)).toBeUndefined()
      expect(h.fake.rawWriter(KEY)).toMatchObject({ writerId: RETIRED_WRITER_ID, lastDraftSeq: META.draftSeq })
      expect(h.files.openHandles()).toBe(0)
      return original(key)
    })
    expect(await h.writer.removeObserved(observed.observation)).toEqual({ kind: 'removed', mirror: { kind: 'removed' } })
    expect(await h.files.directory.listDocuments(KEY.userId)).toEqual({ kind: 'listed', documentIds: [] })
  })

  it.each(['busy', 'quota', 'unsupported', 'failed'] as const)('镜像清理失败不谎报原件仍在，墓碑阻止旧镜像复活：%s', async (kind) => {
    const h = await setup()
    const observed = await h.writer.observe(KEY)
    if (observed.kind !== 'observed')
      throw new Error('缺少观察')
    vi.spyOn(h.files.directory, 'removeDocument').mockResolvedValue(kind === 'failed' ? { kind, error: new Error('cannot remove') } : { kind })
    expect(await h.writer.removeObserved(observed.observation)).toMatchObject({ kind: 'removed', mirror: { kind } })
    expect(h.fake.rawDraft(KEY)).toBeUndefined()
    expect(h.fake.rawWriter(KEY)).toMatchObject({ writerId: RETIRED_WRITER_ID })
    expect(await h.fake.store.restoreDraft(h.record, { now: NOW })).toEqual({ kind: 'kept', reason: 'retired' })
  })

  it('进程内放置也清理旧镜像；观察无记录时不动镜像目录', async () => {
    const h = await setup({ register: false, mirror: false })
    const slot = await encodeSlot(h.record, 1)
    const bytes = new Uint8Array(slot.header.byteLength + slot.content.byteLength)
    bytes.set(slot.header)
    bytes.set(slot.content, slot.header.byteLength)
    h.files.putFile(KEY, 0, bytes)
    expect(h.files.file(KEY, 0)?.byteLength).toBeGreaterThan(0)
    const observed = await h.writer.observe(KEY)
    if (observed.kind !== 'observed')
      throw new Error('缺少观察')
    expect(await h.writer.removeObserved(observed.observation)).toEqual({ kind: 'removed', mirror: { kind: 'removed' } })
    const remove = vi.spyOn(h.files.directory, 'removeDocument')
    const absent = await h.writer.observe(KEY)
    if (absent.kind !== 'observed')
      throw new Error('缺少空观察')
    expect(await h.writer.removeObserved(absent.observation)).toEqual({ kind: 'absent' })
    expect(remove).not.toHaveBeenCalled()
  })
})
