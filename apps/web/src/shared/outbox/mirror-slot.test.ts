import type { StoredDraft } from './draft-record.ts'
import type { SlotHeaderFields } from './mirror-slot.ts'
import { describe, expect, it } from 'vitest'
import { sha256Hex } from './draft-codec.ts'
import { sampleStoredDraft, WRITER_ID } from './draft-record.test-support.ts'
import { DRAFT_IV_BYTES } from './draft-record.ts'
import {
  decodeRecord,
  encodeRecord,
  encodeSlot,
  encodeSlotHeader,
  newestSlot,
  parseSlot,
  parseSlotHeader,
  SLOT_FORMAT_VERSION,
  SLOT_HEADER_BYTES,
  SLOT_MAGIC,
  SLOT_WRITER_ID_MAX_BYTES,
} from './mirror-slot.ts'

/** 一份记录：密文长一些（几百字节），字节有变化 */
function record(overrides: Partial<StoredDraft> = {}): StoredDraft {
  const ciphertext = new Uint8Array(300)
  for (let index = 0; index < ciphertext.length; index += 1)
    ciphertext[index] = (index * 7 + 3) % 256
  return sampleStoredDraft({ ciphertext, ...overrides })
}

/** 按写入的顺序拼出整个槽位文件：头在前（偏移 0），内容在头之后 */
function fileOf(slot: { readonly header: Uint8Array, readonly content: Uint8Array }): Uint8Array<ArrayBuffer> {
  const file = new Uint8Array(SLOT_HEADER_BYTES + slot.content.byteLength)
  file.set(slot.header, 0)
  file.set(slot.content, SLOT_HEADER_BYTES)
  return file
}

/** 字节按值比较（toEqual 对不同 realm 的 Uint8Array 不认作相等） */
function plainRecord(draft: StoredDraft): unknown {
  return { ...draft, iv: Array.from(draft.iv), ciphertext: Array.from(draft.ciphertext) }
}

function withByte(bytes: Uint8Array, index: number, value: number): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes)
  copy[index] = value
  return copy
}

describe('槽位的内容：存进 IndexedDB 的那一份记录的序列化（明文元数据、IV、密文）', () => {
  it('往返得到同一份记录（元数据与字节）', () => {
    const draft = record()
    const decoded = decodeRecord(encodeRecord(draft))
    expect(decoded === undefined ? undefined : plainRecord(decoded)).toEqual(plainRecord(draft))
  })

  it('不在途、公式待更新、空的密文之外的边界值也往返得了', () => {
    const draft = record({ inFlight: null, formulasPending: true, ciphertext: new Uint8Array(16) })
    const decoded = decodeRecord(encodeRecord(draft))
    expect(decoded === undefined ? undefined : plainRecord(decoded)).toEqual(plainRecord(draft))
  })

  it('认不出的内容：太短、元数据的长度越界、元数据不是 JSON、记录的形状不对（例如在途的序号比草稿的大）', () => {
    const good = encodeRecord(record())
    const metaLength = new DataView(good.buffer).getUint32(0, true)
    const badLength = new Uint8Array(good)
    new DataView(badLength.buffer).setUint32(0, good.byteLength, true)
    const notJson = new Uint8Array(good)
    notJson[4] = 0x7B + 1
    const cases: readonly [string, Uint8Array][] = [
      ['空', new Uint8Array(0)],
      ['只有长度', good.slice(0, 4)],
      ['元数据截断', good.slice(0, 4 + metaLength - 1)],
      ['少了 IV', good.slice(0, 4 + metaLength + DRAFT_IV_BYTES - 1)],
      ['长度越界', badLength],
      ['不是 JSON', notJson],
      ['形状不对', encodeRecord(record({ inFlight: { requestId: 'r', clientInstanceId: 'c', localSeq: 99, sentAt: 1 } }))],
    ]
    for (const [label, bytes] of cases)
      expect(decodeRecord(bytes), label).toBeUndefined()
  })
})

describe('槽位的头：固定 256 字节，魔数与版本、写入者、序号、代号、内容的长度与 SHA-256、头自己的 SHA-256', () => {
  it('布局钉住：各项在固定的偏移上，保留的字节为 0，最后 32 字节是前 224 字节的 SHA-256', async () => {
    const draft = record()
    const { header, content } = await encodeSlot(draft, 41)
    expect(header.byteLength).toBe(SLOT_HEADER_BYTES)
    const view = new DataView(header.buffer)
    expect(Array.from(header.subarray(0, 8))).toEqual([...SLOT_MAGIC])
    expect(new TextDecoder().decode(header.subarray(0, 8))).toBe('NRVOMIRR')
    expect(view.getUint16(8, true)).toBe(SLOT_FORMAT_VERSION)
    expect(view.getUint16(10, true)).toBe(new TextEncoder().encode(WRITER_ID).byteLength)
    expect(view.getBigUint64(12, true)).toBe(BigInt(draft.writeEpoch))
    expect(view.getBigUint64(20, true)).toBe(BigInt(draft.draftSeq))
    expect(view.getBigUint64(28, true)).toBe(41n)
    expect(view.getBigUint64(36, true)).toBe(BigInt(content.byteLength))
    expect(Array.from(header.subarray(44, 76), byte => byte.toString(16).padStart(2, '0')).join('')).toBe(await sha256Hex(content))
    expect(new TextDecoder().decode(header.subarray(76, 76 + WRITER_ID.length))).toBe(WRITER_ID)
    expect(header.subarray(76 + WRITER_ID.length, 224).every(byte => byte === 0)).toBe(true)
    expect(Array.from(header.subarray(224), byte => byte.toString(16).padStart(2, '0')).join('')).toBe(await sha256Hex(header.slice(0, 224)))
  })

  it('读头：交回各项；内容的 SHA-256 写成十六进制', async () => {
    const draft = record()
    const { header, content } = await encodeSlot(draft, 7)
    expect(await parseSlotHeader(header)).toEqual({
      formatVersion: SLOT_FORMAT_VERSION,
      writeEpoch: draft.writeEpoch,
      writerId: draft.writerId,
      draftSeq: draft.draftSeq,
      generation: 7,
      contentLength: content.byteLength,
      contentSha256: await sha256Hex(content),
    })
  })

  it('头里任何一个字节不对（写了一半、被改过）：校验不过；魔数不对、版本不认识的单独认出', async () => {
    const { header } = await encodeSlot(record(), 7)
    // 版本（第 8、9 字节）先于校验看：比本页认识的大就是更新的格式，不往下看（下面另测）
    for (let index = 10; index < SLOT_HEADER_BYTES; index += 1)
      expect(await parseSlotHeader(withByte(header, index, (header[index] ?? 0) ^ 0x01)), `第 ${index} 字节`).toBeUndefined()
    expect(await parseSlotHeader(withByte(header, 8, (header[8] ?? 0) ^ 0x01)), '版本变成 0').toBeUndefined()
    expect(await parseSlotHeader(withByte(header, 0, 0x00)), '魔数').toBeUndefined()
    expect(await parseSlotHeader(new Uint8Array(SLOT_HEADER_BYTES)), '全是 0（头还没写）').toBeUndefined()
    expect(await parseSlotHeader(header.slice(0, SLOT_HEADER_BYTES - 1)), '不够 256 字节').toBeUndefined()
    const newer = new Uint8Array(header)
    new DataView(newer.buffer).setUint16(8, SLOT_FORMAT_VERSION + 1, true)
    expect(await parseSlotHeader(newer), '更新的格式：不往下看').toBe('newer-format')
    const zeroVersion = new Uint8Array(header)
    new DataView(zeroVersion.buffer).setUint16(8, 0, true)
    expect(await parseSlotHeader(zeroVersion)).toBeUndefined()
  })

  it('校验得过但取值不对（不是本页写的样子）：writerId 的长度为 0、超过 64、不是 UTF-8，序号为 0，数超出安全整数', async () => {
    const draft = record()
    const content = encodeRecord(draft)
    const fields: SlotHeaderFields = { writeEpoch: draft.writeEpoch, writerId: draft.writerId, draftSeq: draft.draftSeq, generation: 1 }
    const valid = await encodeSlotHeader(fields, content)
    async function resealed(change: (view: DataView, bytes: Uint8Array) => void): Promise<Uint8Array<ArrayBuffer>> {
      const bytes = new Uint8Array(valid)
      change(new DataView(bytes.buffer), bytes)
      bytes.set(await digest(bytes.subarray(0, 224)), 224)
      return bytes
    }
    expect(await parseSlotHeader(valid)).toBeDefined()
    expect(await parseSlotHeader(await resealed(view => view.setUint16(10, 0, true))), 'writerId 长度 0').toBeUndefined()
    expect(await parseSlotHeader(await resealed(view => view.setUint16(10, SLOT_WRITER_ID_MAX_BYTES + 1, true))), 'writerId 太长').toBeUndefined()
    expect(await parseSlotHeader(await resealed((_, bytes) => bytes.set([0xFF, 0xFE], 76))), 'writerId 不是 UTF-8').toBeUndefined()
    expect(await parseSlotHeader(await resealed(view => view.setBigUint64(20, 0n, true))), '序号 0').toBeUndefined()
    expect(await parseSlotHeader(await resealed(view => view.setBigUint64(12, 2n ** 53n, true))), '代次超出安全整数').toBeUndefined()
    expect(await parseSlotHeader(await resealed(view => view.setBigUint64(28, 0n, true))), '代号 0').toBeUndefined()
  })

  it('写不下的：writerId 的 UTF-8 超过 64 字节、代号不是正的安全整数', async () => {
    await expect(encodeSlot(record({ writerId: 'w'.repeat(SLOT_WRITER_ID_MAX_BYTES + 1) }), 1)).rejects.toThrow(TypeError)
    await expect(encodeSlot(record({ writerId: 'w'.repeat(SLOT_WRITER_ID_MAX_BYTES) }), 1)).resolves.toBeDefined()
    for (const generation of [0, -1, 1.5, 2 ** 53])
      await expect(encodeSlot(record(), generation), String(generation)).rejects.toThrow(TypeError)
  })
})

async function digest(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))
}

describe('读整个槽位（M4-P1 设计 §3.8）：校验都过才算数；写一半的落选', () => {
  it('写完的槽位：valid，交回头与记录', async () => {
    const draft = record()
    const read = await parseSlot(fileOf(await encodeSlot(draft, 3)))
    expect(read.kind).toBe('valid')
    expect(read.kind === 'valid' && [read.header.generation, plainRecord(read.record)]).toEqual([3, plainRecord(draft)])
  })

  it('空的槽位（截断为 0：草稿删了、还没写过）：empty', async () => {
    expect(await parseSlot(new Uint8Array(0))).toEqual({ kind: 'empty' })
  })

  it('写一半的每一个阶段都落选：截断之后只写了一部分内容、内容写完而头没写、头写了一部分', async () => {
    const slot = await encodeSlot(record(), 3)
    const file = fileOf(slot)
    // 截断 → 写内容（头的位置是 0）→ 写头：中途被结束时文件的样子
    const contentOnly = new Uint8Array(file)
    contentOnly.fill(0, 0, SLOT_HEADER_BYTES)
    const cases: readonly [string, Uint8Array][] = [
      ['只有头之前的空洞', new Uint8Array(SLOT_HEADER_BYTES)],
      ['内容写了一半、头没写', contentOnly.slice(0, SLOT_HEADER_BYTES + 100)],
      ['内容写完、头没写', contentOnly],
      ['头写了一半', (() => {
        const partial = new Uint8Array(contentOnly)
        partial.set(slot.header.subarray(0, 100), 0)
        return partial
      })()],
      ['不够头的长度', file.slice(0, SLOT_HEADER_BYTES - 1)],
      ['内容少了最后一个字节', file.slice(0, file.byteLength - 1)],
    ]
    for (const [label, bytes] of cases)
      expect(await parseSlot(bytes), label).toEqual({ kind: 'invalid', reason: 'torn' })
  })

  it('内容的任何一个字节不对：内容的 SHA-256 对不上（torn）；内容多出字节同样', async () => {
    const file = fileOf(await encodeSlot(record(), 3))
    for (const index of [SLOT_HEADER_BYTES, SLOT_HEADER_BYTES + 50, file.byteLength - 1])
      expect(await parseSlot(withByte(file, index, (file[index] ?? 0) ^ 0x80)), `第 ${index} 字节`).toEqual({ kind: 'invalid', reason: 'torn' })
    const longer = new Uint8Array(file.byteLength + 1)
    longer.set(file)
    expect(await parseSlot(longer)).toEqual({ kind: 'invalid', reason: 'torn' })
  })

  it('校验都过、内容却不是头说的那一份（写入者、序号对不上）或者读不出记录：mismatch', async () => {
    const draft = record()
    const content = encodeRecord(draft)
    for (const fields of [
      { writeEpoch: draft.writeEpoch + 1, writerId: draft.writerId, draftSeq: draft.draftSeq, generation: 1 },
      { writeEpoch: draft.writeEpoch, writerId: `${draft.writerId}x`, draftSeq: draft.draftSeq, generation: 1 },
      { writeEpoch: draft.writeEpoch, writerId: draft.writerId, draftSeq: draft.draftSeq + 1, generation: 1 },
    ]) {
      const file = fileOf({ header: await encodeSlotHeader(fields, content), content })
      expect(await parseSlot(file), JSON.stringify(fields)).toEqual({ kind: 'invalid', reason: 'mismatch' })
    }
    const garbage = new TextEncoder().encode('not a record at all')
    const fields = { writeEpoch: 1, writerId: 'w', draftSeq: 1, generation: 1 }
    expect(await parseSlot(fileOf({ header: await encodeSlotHeader(fields, garbage), content: garbage }))).toEqual({ kind: 'invalid', reason: 'mismatch' })
  })

  it('更新的格式写的：newer-format（不往下看）', async () => {
    const file = fileOf(await encodeSlot(record(), 3))
    new DataView(file.buffer).setUint16(8, SLOT_FORMAT_VERSION + 1, true)
    expect(await parseSlot(file)).toEqual({ kind: 'invalid', reason: 'newer-format' })
  })
})

describe('两个槽位里谁是最新写的', () => {
  it('两个槽位：代号大的是最新写的；不合格的不算；都不合格时没有', () => {
    const header = (generation: number) => ({ formatVersion: 1, writeEpoch: 1, writerId: 'w', draftSeq: 1, generation, contentLength: 1, contentSha256: 'ab' })
    expect(newestSlot([header(4), header(5)])).toBe(1)
    expect(newestSlot([header(6), header(5)])).toBe(0)
    expect(newestSlot([undefined, header(5)])).toBe(1)
    expect(newestSlot([header(2), undefined])).toBe(0)
    expect(newestSlot([undefined, undefined])).toBeUndefined()
  })
})
