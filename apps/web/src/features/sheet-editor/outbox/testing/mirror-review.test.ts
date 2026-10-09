// 真实浏览器复核里 OPFS 镜像那一段的量法（mirror-review.ts，M4-P1 设计 §3.6 第 11 项）：生产的 createDraftMirror 配内存里的目录
// （shared/outbox/mirror-directory.test-support.ts），句柄的各个操作推进假的时钟，核对各段的毫秒记在哪一段、结果与比对
import type { DraftKey, StoredDraft } from '../../../../shared/outbox/draft-record.ts'
import type { MirrorDirectory, SlotHandle } from '../../../../shared/outbox/mirror-directory.ts'
import type { MirrorReadTimes, MirrorWriteTimes } from './mirror-review.ts'
import { describe, expect, it } from 'vitest'
import { DOCUMENT_ID, sampleStoredDraft, USER_ID } from '../../../../shared/outbox/draft-record.test-support.ts'
import { fakeMirrorDirectory } from '../../../../shared/outbox/mirror-directory.test-support.ts'
import { createMirrorReview, mirrorProblemOf, sameDraft } from './mirror-review.ts'

const KEY: DraftKey = { userId: USER_ID, documentId: DOCUMENT_ID }

function record(draftSeq: number, overrides: Partial<StoredDraft> = {}): StoredDraft {
  return sampleStoredDraft({ draftSeq, inFlight: null, updatedAt: 1_000 + draftSeq, ...overrides })
}

/** 每个操作推进时钟：拿句柄 5、读 3、写 2、截断 1、flush 7（取大小与关不推进） */
const STEP = { open: 5, read: 3, write: 2, truncate: 1, flush: 7 }

function clocked(directory: MirrorDirectory, clock: { now: number }): MirrorDirectory {
  const step = (ms: number): void => {
    clock.now += ms
  }
  const wrap = (handle: SlotHandle): SlotHandle => ({
    read: (buffer, options) => {
      step(STEP.read)
      return handle.read(buffer, options)
    },
    write: (buffer, options) => {
      step(STEP.write)
      return handle.write(buffer, options)
    },
    truncate: (size) => {
      step(STEP.truncate)
      handle.truncate(size)
    },
    getSize: () => handle.getSize(),
    flush: () => {
      step(STEP.flush)
      handle.flush()
    },
    close: () => handle.close(),
  })
  return {
    ...directory,
    openSlots: async (key, create) => {
      step(STEP.open)
      const opened = await directory.openSlots(key, create)
      return opened.kind === 'opened' ? { kind: 'opened', slots: [wrap(opened.slots[0]), wrap(opened.slots[1])] } : opened
    },
  }
}

function setup(directory?: MirrorDirectory) {
  const fake = fakeMirrorDirectory()
  const clock = { now: 1_000 }
  const review = createMirrorReview(clocked(directory ?? fake.directory, clock), () => clock.now)
  return { fake, review }
}

const UNSUPPORTED: MirrorDirectory = {
  openSlots: async () => ({ kind: 'unsupported' }),
  listDocuments: async () => ({ kind: 'unsupported' }),
  listUsers: async () => ({ kind: 'unsupported' }),
  slotFiles: async () => ({ kind: 'unsupported' }),
  readSlots: async () => ({ kind: 'unsupported' }),
  removeUser: async () => ({ kind: 'unsupported' }),
  removeDocument: async () => ({ kind: 'unsupported' }),
}

describe('镜像写一次：登记、生产的整个写入，截断与写、flush 各自计', () => {
  it('第一次：登记 = 拿句柄 + 读两个槽位（5 + 3 + 3）；写入 = 截断 + 写内容 + 写头 + flush（1 + 2 + 2 + 7），其中截断与写 5、flush 7', async () => {
    const { fake, review } = setup()
    expect(await review.write(record(1))).toEqual<MirrorWriteTimes>({ status: 'mirrored', attachMs: 11, writeMs: 12, ioMs: 5, flushMs: 7 })
    expect(fake.operations(KEY, 0)).toEqual(['truncate@0', 'write@256', 'write@0', 'flush'])
  })

  it('读过（放开了句柄）之后再写：重新登记（拿句柄、读两个槽位）；写在另一个槽位上', async () => {
    const { fake, review } = setup()
    await review.write(record(1))
    await review.read(record(1))
    expect(await review.write(record(2))).toEqual<MirrorWriteTimes>({ status: 'mirrored', attachMs: 11, writeMs: 12, ioMs: 5, flushMs: 7 })
    expect(fake.operations(KEY, 1)).toEqual(['truncate@0', 'write@256', 'write@0', 'flush'])
  })

  it('接连写两次（中间没读）：第二次的登记是空操作（手里有句柄），各段只算这一次的', async () => {
    const { review } = setup()
    await review.write(record(1))
    expect(await review.write(record(2))).toEqual<MirrorWriteTimes>({ status: 'mirrored', attachMs: 0, writeMs: 12, ioMs: 5, flushMs: 7 })
  })

  it('这个上下文没有 OPFS：not-mirrored:unsupported，各段为 null', async () => {
    const { review } = setup(UNSUPPORTED)
    expect(await review.write(record(1))).toEqual<MirrorWriteTimes>({ status: 'not-mirrored:unsupported', attachMs: null, writeMs: null, ioMs: null, flushMs: null })
  })

  it('别的标签页占着：not-mirrored:busy；拿句柄出错：带上错误的名字；写到一半写满：not-mirrored:quota（登记的那一段照样记下）', async () => {
    const busy = setup()
    busy.fake.holdElsewhere(KEY)
    expect((await busy.review.write(record(1))).status).toBe('not-mirrored:busy')
    const failed = setup()
    failed.fake.failNextOpen({ kind: 'failed', error: new DOMException('出了错', 'UnknownError') })
    expect((await failed.review.write(record(1))).status).toBe('not-mirrored:failed:UnknownError')
    const full = setup()
    full.fake.failWrite(0, 10, 'QuotaExceededError')
    expect(await full.review.write(record(1))).toEqual<MirrorWriteTimes>({ status: 'not-mirrored:quota', attachMs: 11, writeMs: null, ioMs: null, flushMs: null })
  })

  it('关掉之后句柄都放开；再写是 not-mirrored:failed:InvalidStateError（生产的镜像关了）', async () => {
    const { fake, review } = setup()
    await review.write(record(1))
    expect(fake.openHandles()).toBe(2)
    review.close()
    expect(fake.openHandles()).toBe(0)
    expect((await review.write(record(2))).status).toBe('not-mirrored:failed:InvalidStateError')
  })
})

describe('镜像读一次并与库里那一份比对', () => {
  it('放开句柄之后读：读 = 拿句柄 + 读两个槽位（5 + 3 + 3），其中拿句柄 5；比对不推进时钟；最新的就是库里那一份', async () => {
    const { fake, review } = setup()
    await review.write(record(1))
    expect(await review.read(record(1))).toEqual<MirrorReadTimes>({ read: 'slots', readMs: 11, openMs: 5, compareMs: 0, slots: 'valid+empty', newer: false, same: true })
    expect(fake.openHandles(), '读完放开（打开平台、登记之前比对时的样子）').toBe(0)
  })

  it('写了两次：两个槽位都合格，最新的是第二次那一份；库里还是第一次那一份时镜像更新（要写回）、不是同一份', async () => {
    const { review } = setup()
    await review.write(record(1))
    await review.read(record(1))
    await review.write(record(2))
    expect(await review.read(record(2))).toMatchObject({ readMs: 11, openMs: 5, slots: 'valid+valid', newer: false, same: true })
    expect(await review.read(record(1)), '接连读两次：各段只算这一次的').toMatchObject({ readMs: 11, openMs: 5, slots: 'valid+valid', newer: true, same: false })
  })

  it('槽位被改坏：invalid 的原因写出来，最新的那一份不在就不是同一份；文件不在：absent；没有 OPFS：unsupported', async () => {
    const { fake, review } = setup()
    await review.write(record(1))
    await review.read(record(1))
    fake.putFile(KEY, 0, new Uint8Array(300).fill(7))
    expect(await review.read(record(1))).toMatchObject({ read: 'slots', slots: 'invalid:torn+empty', newer: false, same: false })
    expect(await setup().review.read(record(1))).toEqual<MirrorReadTimes>({ read: 'absent', readMs: null, openMs: null, compareMs: null, slots: null, newer: false, same: false })
    expect((await setup(UNSUPPORTED).review.read(record(1))).read).toBe('unsupported')
  })
})

describe('同一份记录与走完没有', () => {
  it('同一份：文档、写入者、序号、更新时间、密钥版本、IV 与密文都相同；任何一样不同都不是', () => {
    const base = record(3)
    expect(sameDraft(base, record(3))).toBe(true)
    const changed: Partial<StoredDraft>[] = [
      { userId: 'other' },
      { documentId: 'other' },
      { writeEpoch: 4 },
      { writerId: 'other' },
      { draftSeq: 4 },
      { updatedAt: 99 },
      { keyVersion: 3 },
      { iv: new Uint8Array(12).fill(1) },
      { ciphertext: new Uint8Array(17).fill(1) },
      { ciphertext: new Uint8Array(16).fill(0x5C) },
    ]
    expect(changed.map(overrides => sameDraft(base, { ...base, ...overrides }))).toEqual(changed.map(() => false))
  })

  it('写成了、读出两个槽位、是同一份：走完；没有 OPFS 不算没走完；别的都说出原因', () => {
    const written: MirrorWriteTimes = { status: 'mirrored', attachMs: 1, writeMs: 2, ioMs: 1, flushMs: 1 }
    const read: MirrorReadTimes = { read: 'slots', readMs: 1, openMs: 1, compareMs: 0, slots: 'valid+empty', newer: false, same: true }
    expect(mirrorProblemOf(written, read)).toBeUndefined()
    expect(mirrorProblemOf({ ...written, status: 'not-mirrored:unsupported' }, undefined)).toBeUndefined()
    expect(mirrorProblemOf(written, undefined), '库里那一份没读出来：由库那一段报').toBeUndefined()
    expect(mirrorProblemOf({ ...written, status: 'not-mirrored:busy' }, read)).toBe('镜像没写成：not-mirrored:busy')
    expect(mirrorProblemOf(written, { ...read, read: 'failed:UnknownError' })).toBe('镜像读不出：failed:UnknownError')
    expect(mirrorProblemOf(written, { ...read, slots: 'invalid:torn+empty', same: false })).toBe('镜像里最新的那一份不是库里那一份（槽位 invalid:torn+empty）')
  })
})
