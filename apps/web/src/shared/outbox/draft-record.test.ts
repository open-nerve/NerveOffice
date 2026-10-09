import type { StoredDraft, WriterRecord } from './draft-record.ts'
import { describe, expect, it } from 'vitest'
import { sampleMeta, sampleStoredDraft, sampleWriter } from './draft-record.test-support.ts'
import { DRAFT_IV_BYTES, DRAFT_RECORD_VERSION, DRAFT_TAG_BYTES, draftMetaOf, readableUpdatedAt, readStoredDraft, readWriterRecord } from './draft-record.ts'

/** 把样例的某一项换成别的值（可以是任何东西，模拟库里读出来的） */
function withField(record: object, field: string, value: unknown): Record<string, unknown> {
  return { ...record, [field]: value }
}

function withoutField(record: object, field: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...record }
  delete copy[field]
  return copy
}

/** jsdom 环境里 TextEncoder 交回的字节属于 Node 的 realm：instanceof Uint8Array 为假（与 Worker、IndexedDB 交回的同一类情形） */
function foreignRealmBytes(length: number, fill: number): Uint8Array<ArrayBuffer> {
  const bytes = new TextEncoder().encode(String.fromCharCode(fill).repeat(length))
  expect(bytes instanceof Uint8Array).toBe(false)
  return bytes
}

describe('草稿的形状核对（M4-P1 设计 §3.2、§3.4.6）：读出来的一律先过这里', () => {
  it('合法的记录：交回只带已知字段的一份，字节原样', () => {
    const stored = sampleStoredDraft()
    const read = readStoredDraft({ ...stored, extra: 'ignored' })
    expect(read).toEqual({ kind: 'draft', draft: stored })
    if (read.kind !== 'draft')
      throw new Error('应当认得出')
    expect(Object.keys(read.draft).sort()).toEqual(Object.keys(stored).sort())
    expect(read.draft.iv).toBe(stored.iv)
    expect(read.draft.ciphertext).toBe(stored.ciphertext)
  })

  it('不在途、公式待更新、解压后 0 字节都是合法的值', () => {
    const stored = sampleStoredDraft({ inFlight: null, formulasPending: true, rawBytes: 0 })
    expect(readStoredDraft(stored)).toEqual({ kind: 'draft', draft: stored })
  })

  it('字节不按 instanceof 认：另一个 realm 的 Uint8Array 照样认得出（Worker、IndexedDB、jsdom 的情形）', () => {
    const stored = sampleStoredDraft({ iv: foreignRealmBytes(DRAFT_IV_BYTES, 1), ciphertext: foreignRealmBytes(40, 2) })
    expect(readStoredDraft(stored)).toEqual({ kind: 'draft', draft: stored })
  })

  it('记录的格式版本比本页认识的新：交回 newer-format 与它的版本，别的字段不看（更新的页面写的，不动它）', () => {
    expect(readStoredDraft({ recordVersion: DRAFT_RECORD_VERSION + 1 })).toEqual({ kind: 'newer-format', recordVersion: DRAFT_RECORD_VERSION + 1 })
    expect(readStoredDraft({ ...sampleStoredDraft(), recordVersion: 7, draftSeq: 'x' })).toEqual({ kind: 'newer-format', recordVersion: 7 })
  })

  it('不是对象：malformed', () => {
    for (const value of [null, undefined, 'draft', 7, true, [], [sampleStoredDraft()]])
      expect(readStoredDraft(value), String(value)).toEqual({ kind: 'malformed' })
  })

  it('少了任何一项：malformed', () => {
    const stored = sampleStoredDraft()
    for (const field of Object.keys(stored))
      expect(readStoredDraft(withoutField(stored, field)), field).toEqual({ kind: 'malformed' })
    for (const field of Object.keys(stored.format))
      expect(readStoredDraft(withField(stored, 'format', withoutField(stored.format, field))), `format.${field}`).toEqual({ kind: 'malformed' })
    for (const field of Object.keys(sampleMeta().inFlight ?? {}))
      expect(readStoredDraft(withField(stored, 'inFlight', withoutField(stored.inFlight ?? {}, field))), `inFlight.${field}`).toEqual({ kind: 'malformed' })
  })

  it('任何一项的取值不对：malformed', () => {
    const stored = sampleStoredDraft()
    const format = stored.format
    const inFlight = stored.inFlight ?? undefined
    const notSafe = 2 ** 53
    const badValues: Readonly<Record<string, readonly unknown[]>> = {
      userId: ['', 1, null],
      documentId: ['', undefined, ['x']],
      recordVersion: [0, -1, 1.5, '1', null, Number.NaN],
      draftSeq: [0, -1, 1.5, '7', Number.NaN, Number.POSITIVE_INFINITY, notSafe],
      baseRevision: [0, -1, 1.5, '12', null],
      writeEpoch: [0, -3, 2.5, '3'],
      writerId: ['', 3, null],
      writtenBy: ['', null, 1],
      format: [null, 'sheet', [], { ...format, clientBuild: '' }, { ...format, univerVersion: 1 }, { ...format, profile: '' }, { ...format, formatVersion: 0 }, { ...format, formatVersion: '1' }],
      formulasPending: ['false', 0, null, undefined],
      keyVersion: [0, 1.5, '2', -1],
      inFlight: [undefined, 'x', {}, [], { ...inFlight, requestId: '' }, { ...inFlight, clientInstanceId: 1 }, { ...inFlight, localSeq: 0 }, { ...inFlight, localSeq: 1.5 }, { ...inFlight, sentAt: -1 }, { ...inFlight, sentAt: 1.5 }],
      rawBytes: [-1, 1.5, '4096', notSafe],
      updatedAt: [-1, 1.5, Number.NaN, '2026-10-09'],
      iv: [new Uint8Array(DRAFT_IV_BYTES - 1), new Uint8Array(DRAFT_IV_BYTES + 1), new Uint16Array(DRAFT_IV_BYTES / 2), new ArrayBuffer(DRAFT_IV_BYTES), Array.from({ length: DRAFT_IV_BYTES }).fill(0), new Int8Array(DRAFT_IV_BYTES), new Uint8ClampedArray(DRAFT_IV_BYTES), new DataView(new ArrayBuffer(DRAFT_IV_BYTES)), null],
      ciphertext: [new Uint8Array(DRAFT_TAG_BYTES - 1), Array.from({ length: 32 }).fill(0), new ArrayBuffer(32), 'ciphertext', null],
    }
    expect(Object.keys(badValues).sort()).toEqual(Object.keys(stored).sort())
    for (const [field, values] of Object.entries(badValues)) {
      for (const value of values)
        expect(readStoredDraft(withField(stored, field, value)), `${field}: ${String(value)}`).toEqual({ kind: 'malformed' })
    }
  })

  it('字节要紧凑：视图只占底层缓冲的一段（结构化克隆会把整个缓冲存进库）、共享的缓冲都不认', () => {
    const offset = new Uint8Array(new ArrayBuffer(DRAFT_IV_BYTES + 4), 4, DRAFT_IV_BYTES)
    const prefix = new Uint8Array(new ArrayBuffer(DRAFT_IV_BYTES + 4)).subarray(0, DRAFT_IV_BYTES)
    const shared = new Uint8Array(new SharedArrayBuffer(DRAFT_IV_BYTES))
    for (const iv of [offset, prefix, shared])
      expect(readStoredDraft(withField(sampleStoredDraft(), 'iv', iv)), `byteOffset ${iv.byteOffset}`).toEqual({ kind: 'malformed' })
    const ciphertext = new Uint8Array(new ArrayBuffer(64)).subarray(8, 40)
    expect(readStoredDraft(sampleStoredDraft({ ciphertext }))).toEqual({ kind: 'malformed' })
  })

  it('元数据：去掉 IV 与密文（本机草稿页的列表不交出密文）', () => {
    const stored: StoredDraft = sampleStoredDraft()
    const meta = draftMetaOf(stored)
    expect(meta).toEqual(sampleMeta())
    expect(Object.keys(meta)).not.toContain('iv')
    expect(Object.keys(meta)).not.toContain('ciphertext')
  })
})

describe('读得出的更新时间（保留期清理用，不论格式）', () => {
  it('认得出的、更新的格式、形状不对的记录：updatedAt 是个有限的数就交回它', () => {
    const stored = sampleStoredDraft()
    expect(readableUpdatedAt(stored)).toBe(stored.updatedAt)
    expect(readableUpdatedAt({ recordVersion: DRAFT_RECORD_VERSION + 1, updatedAt: 12_345 })).toBe(12_345)
    expect(readableUpdatedAt(withField(stored, 'iv', 'broken')), '形状不对，更新时间照样读得出').toBe(stored.updatedAt)
    expect(readableUpdatedAt({ updatedAt: 1.5 })).toBe(1.5)
    expect(readableUpdatedAt({ updatedAt: -1 })).toBe(-1)
  })

  it('读不出：没有 updatedAt、不是数、不是有限的数、整条不是对象', () => {
    for (const value of [withoutField(sampleStoredDraft(), 'updatedAt'), { updatedAt: '2026-10-09' }, { updatedAt: Number.NaN }, { updatedAt: Number.POSITIVE_INFINITY }, { updatedAt: null }, null, 'draft', 7, []])
      expect(readableUpdatedAt(value), JSON.stringify(value)).toBeUndefined()
  })
})

describe('写入者的形状核对', () => {
  it('合法的记录：交回只带已知字段的一份；高水位可以是 0（还没写过）', () => {
    const writer = sampleWriter()
    expect(readWriterRecord({ ...writer, token: 'never-stored' })).toEqual(writer)
    expect(Object.keys(readWriterRecord({ ...writer, extra: 1 }) ?? {}).sort()).toEqual(Object.keys(writer).sort())
    expect(readWriterRecord(sampleWriter({ lastDraftSeq: 0 }))).toEqual(sampleWriter({ lastDraftSeq: 0 }))
  })

  it('形状不对时当作没有写入者（undefined）：判定随之按"没有写入者"走，别人留下的草稿另由 foreign-draft 护住', () => {
    const writer: WriterRecord = sampleWriter()
    const badValues: Readonly<Record<string, readonly unknown[]>> = {
      userId: ['', 1],
      documentId: ['', null],
      writeEpoch: [0, 1.5, '3'],
      writerId: ['', 7],
      lastDraftSeq: [-1, 1.5, '7', Number.NaN],
      registeredAt: [-1, 1.5, null],
    }
    expect(Object.keys(badValues).sort()).toEqual(Object.keys(writer).sort())
    for (const [field, values] of Object.entries(badValues)) {
      expect(readWriterRecord(withoutField(writer, field)), `少了 ${field}`).toBeUndefined()
      for (const value of values)
        expect(readWriterRecord(withField(writer, field, value)), `${field}: ${String(value)}`).toBeUndefined()
    }
    for (const value of [null, undefined, 'writer', 3, []])
      expect(readWriterRecord(value), String(value)).toBeUndefined()
  })
})
