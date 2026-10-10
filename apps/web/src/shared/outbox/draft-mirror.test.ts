import type { DraftMirror } from './draft-mirror.ts'
import type { DraftKey, StoredDraft } from './draft-record.ts'
import type { FakeMirrorDirectory } from './mirror-directory.test-support.ts'
import type { SlotRead } from './mirror-slot.ts'
import { describe, expect, it } from 'vitest'
import { createDraftMirror } from './draft-mirror.ts'
import { DOCUMENT_ID, sampleStoredDraft, USER_ID } from './draft-record.test-support.ts'
import { fakeMirrorDirectory } from './mirror-directory.test-support.ts'
import { encodeSlot, parseSlot, SLOT_HEADER_BYTES } from './mirror-slot.ts'

const KEY: DraftKey = { userId: USER_ID, documentId: DOCUMENT_ID }
const OTHER: DraftKey = { userId: USER_ID, documentId: '0199b0c4-7d3e-7a3b-9c4e-00000000d0c2' }
const RETRY = { initialMs: 500, maxMs: 4_000 }

/** 别的写入者（另一次登记）的 writerId */
const OTHER_WRITER = '6f1c2a3b-4d5e-4f60-8172-8394a5b6c7d9'

function record(draftSeq: number, overrides: Partial<StoredDraft> = {}): StoredDraft {
  return sampleStoredDraft({ draftSeq, inFlight: null, updatedAt: 1_000 + draftSeq, ...overrides })
}

interface Setup {
  readonly fake: FakeMirrorDirectory
  readonly mirror: DraftMirror
  readonly advance: (ms: number) => void
}

function setup(): Setup {
  const fake = fakeMirrorDirectory()
  let now = 10_000
  const mirror = createDraftMirror({ directory: fake.directory, clock: { now: () => now }, retry: RETRY })
  return { fake, mirror, advance: (ms) => {
    now += ms
  } }
}

/** 槽位文件读出来的样子：空的、不合格的原因，或者合格的那一份的序号与代号 */
async function slotOf(fake: FakeMirrorDirectory, slot: 0 | 1, key: DraftKey = KEY): Promise<string> {
  const bytes = fake.file(key, slot)
  if (bytes === undefined)
    return 'missing'
  const read = await parseSlot(bytes)
  return summary(read)
}

function summary(read: SlotRead): string {
  switch (read.kind) {
    case 'empty':
      return 'empty'
    case 'invalid':
      return `invalid:${read.reason}`
    case 'valid':
      return `seq${read.record.draftSeq}@${read.header.generation}`
  }
}

async function fileOf(draft: StoredDraft, generation: number): Promise<Uint8Array> {
  const { header, content } = await encodeSlot(draft, generation)
  const file = new Uint8Array(SLOT_HEADER_BYTES + content.byteLength)
  file.set(header)
  file.set(content, SLOT_HEADER_BYTES)
  return file
}

describe('登记时建好两个槽位、拿着句柄（M4-P1 设计 §3.8）', () => {
  it('第一次：建出 a、b 两个空文件，拿着两个句柄；再登记不重开', async () => {
    const { fake, mirror } = setup()
    expect(fake.file(KEY, 0)).toBeUndefined()
    expect(await mirror.attach(KEY)).toEqual({ kind: 'mirrored' })
    expect([await slotOf(fake, 0), await slotOf(fake, 1)]).toEqual(['empty', 'empty'])
    expect(fake.openHandles()).toBe(2)
    expect(await mirror.attach(KEY)).toEqual({ kind: 'mirrored' })
    expect(fake.opens()).toBe(1)
  })

  it('别的标签页占着：busy，之后在退避的时间里不再去拿（写入同样交回 busy），到点再拿；退避一次比一次长，有上限', async () => {
    const { fake, mirror, advance } = setup()
    const release = fake.holdElsewhere(KEY)
    expect(await mirror.attach(KEY)).toEqual({ kind: 'not-mirrored', reason: 'busy' })
    expect(await mirror.write(record(1))).toEqual({ kind: 'not-mirrored', reason: 'busy' })
    expect(fake.opens(), '退避期间不去拿').toBe(1)
    advance(RETRY.initialMs - 1)
    expect(await mirror.attach(KEY)).toEqual({ kind: 'not-mirrored', reason: 'busy' })
    expect(fake.opens()).toBe(1)
    advance(1)
    expect(await mirror.attach(KEY)).toEqual({ kind: 'not-mirrored', reason: 'busy' })
    expect(fake.opens(), '到点再拿一次').toBe(2)
    // 第二次退避是 1000 ms
    advance(RETRY.initialMs * 2 - 1)
    await mirror.attach(KEY)
    expect(fake.opens()).toBe(2)
    advance(1)
    await mirror.attach(KEY)
    expect(fake.opens()).toBe(3)
    // 之后 2000、4000、4000（上限）
    advance(2_000)
    await mirror.attach(KEY)
    advance(4_000)
    await mirror.attach(KEY)
    expect(fake.opens()).toBe(5)
    advance(4_000)
    release()
    expect(await mirror.attach(KEY)).toEqual({ kind: 'mirrored' })
    expect(fake.opens()).toBe(6)
  })

  it('另一份文档不受这一份的退避影响', async () => {
    const { fake, mirror } = setup()
    fake.holdElsewhere(KEY)
    expect(await mirror.attach(KEY)).toEqual({ kind: 'not-mirrored', reason: 'busy' })
    expect(await mirror.attach(OTHER)).toEqual({ kind: 'mirrored' })
  })

  it('没有 OPFS（主线程、浏览器不给）：unsupported，记住，之后不再去试', async () => {
    const { fake, mirror } = setup()
    fake.failNextOpen({ kind: 'unsupported' })
    expect(await mirror.attach(KEY)).toEqual({ kind: 'not-mirrored', reason: 'unsupported' })
    expect(await mirror.write(record(1, { documentId: OTHER.documentId }))).toEqual({ kind: 'not-mirrored', reason: 'unsupported' })
    expect(fake.opens()).toBe(1)
  })

  it('建文件时写满、出错：如实交回，退避之后再试', async () => {
    const { fake, mirror, advance } = setup()
    fake.failNextOpen({ kind: 'quota' })
    expect(await mirror.attach(KEY)).toEqual({ kind: 'not-mirrored', reason: 'quota' })
    advance(RETRY.initialMs)
    fake.failNextOpen({ kind: 'failed', error: new DOMException('坏了', 'UnknownError') })
    expect(await mirror.attach(KEY)).toEqual({ kind: 'not-mirrored', reason: 'failed', error: { name: 'UnknownError', message: '坏了' } })
    advance(RETRY.initialMs * 2)
    expect(await mirror.attach(KEY)).toEqual({ kind: 'mirrored' })
  })
})

describe('写：两个槽位轮流原地改写（截断 → 内容 → 头 → flush），写在不是最新那一份的槽位上', () => {
  it('a、b、a……代号一次比一次大；每次截断 → 写内容（头之后）→ 写头 → flush', async () => {
    const { fake, mirror } = setup()
    expect(await mirror.write(record(1))).toEqual({ kind: 'mirrored' })
    expect([await slotOf(fake, 0), await slotOf(fake, 1)]).toEqual(['seq1@1', 'empty'])
    expect(fake.operations(KEY, 0), '头最后写：写一半时头不合格').toEqual(['truncate@0', `write@${SLOT_HEADER_BYTES}`, 'write@0', 'flush'])
    expect(fake.operations(KEY, 1)).toEqual([])
    expect(await mirror.write(record(2))).toEqual({ kind: 'mirrored' })
    expect([await slotOf(fake, 0), await slotOf(fake, 1)]).toEqual(['seq1@1', 'seq2@2'])
    expect(await mirror.write(record(3))).toEqual({ kind: 'mirrored' })
    expect([await slotOf(fake, 0), await slotOf(fake, 1)]).toEqual(['seq3@3', 'seq2@2'])
    expect(fake.flushes()).toBe(3)
  })

  it('接着上一次会话留下的写：先读两个槽位的头，写在旧的那一个上，代号接着往上', async () => {
    const { fake, mirror } = setup()
    fake.putFile(KEY, 0, await fileOf(record(5), 9))
    fake.putFile(KEY, 1, await fileOf(record(4), 8))
    expect(await mirror.write(record(6))).toEqual({ kind: 'mirrored' })
    expect([await slotOf(fake, 0), await slotOf(fake, 1)]).toEqual(['seq5@9', 'seq6@10'])
  })

  it('一个槽位是写一半的：写在它上面（另一个是最新的、合格的那一份）', async () => {
    const { fake, mirror } = setup()
    fake.putFile(KEY, 0, (await fileOf(record(5), 9)).slice(0, 300))
    fake.putFile(KEY, 1, await fileOf(record(4), 8))
    expect(await mirror.write(record(6))).toEqual({ kind: 'mirrored' })
    expect([await slotOf(fake, 0), await slotOf(fake, 1)]).toEqual(['seq6@9', 'seq4@8'])
  })

  it('写满：写到一半停下，交回 quota；正在写的那个槽位落选，另一个（最新的）还在；下一次照样写在这一个上', async () => {
    const { fake, mirror } = setup()
    await mirror.write(record(1))
    fake.failWrite(0, 10, 'QuotaExceededError')
    expect(await mirror.write(record(2))).toEqual({ kind: 'not-mirrored', reason: 'quota' })
    expect([await slotOf(fake, 0), await slotOf(fake, 1)]).toEqual(['seq1@1', 'invalid:torn'])
    expect(await mirror.write(record(3))).toEqual({ kind: 'mirrored' })
    expect([await slotOf(fake, 0), await slotOf(fake, 1)]).toEqual(['seq1@1', 'seq3@2'])
  })

  it('写头时出错（内容写完了、头只写了一部分）：同样落选，交回 failed（名字与消息）', async () => {
    const { fake, mirror } = setup()
    await mirror.write(record(1))
    await mirror.write(record(2))
    fake.failWrite(1, 100, 'UnknownError')
    expect(await mirror.write(record(3))).toEqual({ kind: 'not-mirrored', reason: 'failed', error: { name: 'UnknownError', message: '写到一半出了错' } })
    expect([await slotOf(fake, 0), await slotOf(fake, 1)]).toEqual(['invalid:torn', 'seq2@2'])
  })

  it('写的字节数比要写的少（write 不抛出、交回的数小）：同样落选，交回 failed，不接着写头', async () => {
    const { fake, mirror } = setup()
    await mirror.write(record(1))
    fake.shortWrite(0, 10)
    expect(await mirror.write(record(2))).toMatchObject({ kind: 'not-mirrored', reason: 'failed', error: { name: 'UnknownError' } })
    expect(fake.operations(KEY, 1)).toEqual(['truncate@0', `write@${SLOT_HEADER_BYTES}`])
    expect([await slotOf(fake, 0), await slotOf(fake, 1)]).toEqual(['seq1@1', 'invalid:torn'])
  })

  it('写不下的记录（writerId 超过 64 字节）：failed，不动文件', async () => {
    const { fake, mirror } = setup()
    expect(await mirror.write(record(1, { writerId: 'w'.repeat(65) }))).toMatchObject({ kind: 'not-mirrored', reason: 'failed', error: { name: 'TypeError' } })
    expect([await slotOf(fake, 0), await slotOf(fake, 1)]).toEqual(['empty', 'empty'])
  })
})

describe('截断、读、放开', () => {
  it('未登记时临时打开的槽位里有更新格式：拒绝截断，两个槽位逐字节保留', async () => {
    const { fake, mirror } = setup()
    const newer = await fileOf(record(2), 2)
    new DataView(newer.buffer).setUint16(8, 2, true)
    const older = await fileOf(record(1), 1)
    fake.putFile(KEY, 0, newer)
    fake.putFile(KEY, 1, older)

    expect(await mirror.clear(KEY)).toEqual({ kind: 'not-mirrored', reason: 'newer-format' })
    expect(fake.file(KEY, 0)).toEqual(newer)
    expect(fake.file(KEY, 1)).toEqual(older)
  })

  it('截断：拿着句柄时两个都截断为 0；之后从 a 开始写（截断之前最新的是哪一个都一样），代号照样往上', async () => {
    const { fake, mirror } = setup()
    await mirror.write(record(1))
    await mirror.write(record(2))
    await mirror.write(record(3))
    expect([await slotOf(fake, 0), await slotOf(fake, 1)]).toEqual(['seq3@3', 'seq2@2'])
    expect(await mirror.clear(KEY)).toEqual({ kind: 'mirrored' })
    expect([await slotOf(fake, 0), await slotOf(fake, 1)]).toEqual(['empty', 'empty'])
    await mirror.write(record(4))
    expect([await slotOf(fake, 0), await slotOf(fake, 1)]).toEqual(['seq4@4', 'empty'])
  })

  it('截断：手里没有句柄时临时拿一下、截断、放开；文件不在时什么也不做；别人占着时 busy', async () => {
    const { fake, mirror } = setup()
    fake.putFile(KEY, 0, await fileOf(record(5), 9))
    fake.putFile(KEY, 1, new Uint8Array(0))
    expect(await mirror.clear(KEY)).toEqual({ kind: 'mirrored' })
    expect(await slotOf(fake, 0)).toBe('empty')
    expect(fake.openHandles()).toBe(0)
    expect(await mirror.clear(OTHER)).toEqual({ kind: 'mirrored' })
    expect(fake.file(OTHER, 0), '不建文件').toBeUndefined()
    fake.putFile(KEY, 0, await fileOf(record(5), 9))
    const release = fake.holdElsewhere(KEY)
    expect(await mirror.clear(KEY)).toEqual({ kind: 'not-mirrored', reason: 'busy' })
    release()
  })

  it('读：拿着句柄时直接读；没有时临时拿一下、读完放开（不建文件）；文件不在、别人占着如实交回', async () => {
    const { fake, mirror } = setup()
    expect(await mirror.read(KEY)).toEqual({ kind: 'absent' })
    expect(fake.file(KEY, 0), '读不建文件').toBeUndefined()
    await mirror.write(record(1))
    const held = await mirror.read(KEY)
    expect(held.kind === 'slots' && held.slots.map(summary)).toEqual(['seq1@1', 'empty'])
    mirror.detach(KEY)
    expect(fake.openHandles()).toBe(0)
    const temporary = await mirror.read(KEY)
    expect(temporary.kind === 'slots' && temporary.slots.map(summary)).toEqual(['seq1@1', 'empty'])
    expect(fake.openHandles(), '读完放开').toBe(0)
    const release = fake.holdElsewhere(KEY)
    expect(await mirror.read(KEY)).toEqual({ kind: 'busy' })
    release()
  })

  it('放开（失去写入者）：关掉句柄，别的标签页拿得到；之后再写时重新拿、接着轮流', async () => {
    const { fake, mirror } = setup()
    await mirror.write(record(1))
    mirror.detach(KEY)
    expect(fake.openHandles()).toBe(0)
    expect(await mirror.write(record(2))).toEqual({ kind: 'mirrored' })
    expect([await slotOf(fake, 0), await slotOf(fake, 1)]).toEqual(['seq1@1', 'seq2@2'])
  })

  it('关掉：全部句柄放开；之后一律 failed', async () => {
    const { fake, mirror } = setup()
    await mirror.write(record(1))
    await mirror.write(record(1, { documentId: OTHER.documentId }))
    expect(fake.openHandles()).toBe(4)
    mirror.close()
    expect(fake.openHandles()).toBe(0)
    expect(await mirror.write(record(2))).toMatchObject({ kind: 'not-mirrored', reason: 'failed', error: { name: 'InvalidStateError' } })
    expect(await mirror.read(KEY)).toMatchObject({ kind: 'failed', error: { name: 'InvalidStateError' } })
  })

  it('这个用户在镜像里的文档', async () => {
    const { mirror } = setup()
    await mirror.write(record(1))
    await mirror.write(record(1, { documentId: OTHER.documentId }))
    expect(await mirror.documents(USER_ID)).toEqual({ kind: 'listed', documentIds: [DOCUMENT_ID, OTHER.documentId].sort() })
    expect(await mirror.documents('nobody')).toEqual({ kind: 'listed', documentIds: [] })
  })
})

describe('补写（§3.8）：拿着句柄、并且比两个槽位里合格的最新一份新时才写', () => {
  it('没拿着句柄（不是写入者）：什么也不做，交回 undefined；关掉之后同样', async () => {
    const { fake, mirror } = setup()
    fake.putFile(KEY, 0, await fileOf(record(1), 1))
    fake.putFile(KEY, 1, new Uint8Array(0))
    expect(await mirror.backfill(record(2))).toBeUndefined()
    expect(fake.opens(), '不去拿句柄').toBe(0)
    await mirror.attach(KEY)
    mirror.close()
    expect(await mirror.backfill(record(2))).toBeUndefined()
    expect(fake.operations(KEY, 1)).toEqual([])
  })

  it('拿着句柄：比合格的最新一份新才写，写在不是最新的那个槽位上；一样新、更旧的不写；同一序号更新时间晚的（重封）算新', async () => {
    const { fake, mirror } = setup()
    fake.putFile(KEY, 0, await fileOf(record(2), 5))
    fake.putFile(KEY, 1, await fileOf(record(1), 4))
    expect(await mirror.attach(KEY)).toEqual({ kind: 'mirrored' })
    expect(await mirror.backfill(record(2))).toEqual({ kind: 'mirrored' })
    expect(await mirror.backfill(record(1))).toEqual({ kind: 'mirrored' })
    expect([fake.operations(KEY, 0), fake.operations(KEY, 1)], '不用补：不写').toEqual([[], []])
    expect(await mirror.backfill(record(3))).toEqual({ kind: 'mirrored' })
    expect([await slotOf(fake, 0), await slotOf(fake, 1)]).toEqual(['seq2@5', 'seq3@6'])
    const written = fake.operations(KEY, 1).length
    expect(await mirror.backfill(record(3)), '刚补写的那一份记着：不再写').toEqual({ kind: 'mirrored' })
    expect(fake.operations(KEY, 1)).toHaveLength(written)
    expect(await mirror.backfill(record(3, { updatedAt: 9_999 }))).toEqual({ kind: 'mirrored' })
    expect(await slotOf(fake, 0)).toBe('seq3@7')
  })

  it('镜像里最新写的那一份是别的写入者的（以 force 登记、代次倒退之后旧一代的）：库里那一份胜出，照写（审查 A2：不按代次比）', async () => {
    const { fake, mirror } = setup()
    fake.putFile(KEY, 0, await fileOf(record(10, { writeEpoch: 5, writerId: OTHER_WRITER }), 1))
    fake.putFile(KEY, 1, new Uint8Array(0))
    expect(await mirror.attach(KEY)).toEqual({ kind: 'mirrored' })
    expect(await mirror.backfill(record(11, { writeEpoch: 3 }))).toEqual({ kind: 'mirrored' })
    expect([await slotOf(fake, 0), await slotOf(fake, 1)]).toEqual(['seq10@1', 'seq11@2'])
  })

  it('槽位里是别的文档的记录（挪进来的，审查 A4）：拿句柄时不算合格的，读出时是 mismatch，写的时候照常盖掉它', async () => {
    const { fake, mirror } = setup()
    fake.putFile(KEY, 0, await fileOf(record(5, { documentId: OTHER.documentId }), 7))
    fake.putFile(KEY, 1, new Uint8Array(0))
    expect(await mirror.read(KEY)).toEqual({ kind: 'slots', slots: [{ kind: 'invalid', reason: 'mismatch' }, { kind: 'empty' }] })
    expect(await mirror.write(record(1))).toEqual({ kind: 'mirrored' })
    expect([await slotOf(fake, 0), await slotOf(fake, 1)], '最新的一个也没有：写在 a 上，代号从头').toEqual(['seq1@1', 'empty'])
  })

  it('记着两个槽位各存着哪一份：写一半的那一个不算；截断之后都不算', async () => {
    const { fake, mirror } = setup()
    await mirror.write(record(1))
    await mirror.write(record(2))
    fake.failWrite(0, 10, 'QuotaExceededError')
    expect(await mirror.write(record(3))).toEqual({ kind: 'not-mirrored', reason: 'quota' })
    expect(await mirror.backfill(record(2)), '第 2 份还在另一个槽位上').toEqual({ kind: 'mirrored' })
    expect(await slotOf(fake, 0)).toBe('invalid:torn')
    expect(await mirror.backfill(record(3)), '第 3 份没写成：补写').toEqual({ kind: 'mirrored' })
    expect([await slotOf(fake, 0), await slotOf(fake, 1)]).toEqual(['seq3@3', 'seq2@2'])
    expect(await mirror.clear(KEY)).toEqual({ kind: 'mirrored' })
    expect(await mirror.backfill(record(1)), '截断之后什么也没有：补写').toEqual({ kind: 'mirrored' })
    expect([await slotOf(fake, 0), await slotOf(fake, 1)]).toEqual(['seq1@4', 'empty'])
  })

  it('补写没写成（写满）：如实交回，那个槽位落选', async () => {
    const { fake, mirror } = setup()
    await mirror.write(record(1))
    fake.failWrite(0, 10, 'QuotaExceededError')
    expect(await mirror.backfill(record(2))).toEqual({ kind: 'not-mirrored', reason: 'quota' })
    expect([await slotOf(fake, 0), await slotOf(fake, 1)]).toEqual(['seq1@1', 'invalid:torn'])
  })
})
