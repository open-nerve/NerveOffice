import type { DraftKey } from './draft-record.ts'
import { describe, expect, it } from 'vitest'
import { createDraftObservations, sameObservedValue } from './draft-observation.ts'
import { NOW, sampleMeta } from './draft-record.test-support.ts'

const KEY: DraftKey = { userId: 'user', documentId: 'document' }
const WRITER = { ...KEY, writeEpoch: 3, writerId: 'writer', lastDraftSeq: 9, registeredAt: NOW }
const RECORD = { ...sampleMeta(), iv: new Uint8Array(12), ciphertext: new Uint8Array(32) }
const NOTICE = { ...KEY, kind: 'restored', at: NOW }
const SPARSE: unknown[] = []
SPARSE.length = 1

describe('原始观察值的完整比较', () => {
  it.each([
    undefined,
    null,
    true,
    false,
    '',
    '内容',
    0,
    -0,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1n,
    {},
    [],
    { missing: undefined },
    [undefined, null],
    new Uint8Array([0, 7]),
    new Uint16Array([256]),
    new ArrayBuffer(4),
    RECORD,
  ].map(value => ({ value })))('结构化克隆的同一值相等：$#', ({ value }) => {
    expect(sameObservedValue(value, structuredClone(value))).toBe(true)
  })

  it.each([
    [undefined, null],
    [0, -0],
    [Number.NaN, null],
    [1n, 1],
    ['1', 1],
    [{}, { missing: undefined }],
    [[undefined], Array.from({ length: 0 })],
    [SPARSE, [undefined]],
    [[], {}],
    [new Uint8Array([1]), new Uint8Array([2])],
    [new Uint8Array([1, 0]), new Uint16Array([1])],
    [{ bad: 1 }, { bad: 2 }],
    [{ recordVersion: 2 }, { recordVersion: 3 }],
  ])('不能把不同值当成同一条：%#', (before, after) => {
    expect(sameObservedValue(before, after)).toBe(false)
  })

  it('比较非紧凑视图的整个缓冲，不能漏掉视图外已变化的字节', () => {
    const before = new Uint8Array([1, 2, 3]).subarray(1, 2)
    const after = new Uint8Array([9, 2, 3]).subarray(1, 2)
    expect(sameObservedValue(before, after)).toBe(false)
    expect(sameObservedValue(before, structuredClone(before))).toBe(true)
  })

  it('相同循环与共享引用可核对，不同引用图不能混为一谈', () => {
    const child = { value: 1 }
    const before: Record<string, unknown> = { a: child, b: child }
    before.self = before
    expect(sameObservedValue(before, structuredClone(before))).toBe(true)
    const after: Record<string, unknown> = { a: { value: 1 }, b: { value: 1 } }
    after.self = after
    expect(sameObservedValue(before, after)).toBe(false)
    expect(sameObservedValue(after, before)).toBe(false)
  })

  it.each([new Date(0), new Map([['a', 1]]), new Set([1]), new Blob(['secret']), /x/])('未知外部类型保留，不能只凭表面属性猜相同', (value) => {
    expect(sameObservedValue(value, structuredClone(value))).toBe(false)
    expect(sameObservedValue(value, value)).toBe(false)
  })

  it('遍历过深或过宽时保留，不能堆栈溢出或阻塞无界比较', () => {
    let deep: unknown = 1
    for (let depth = 0; depth < 300; depth += 1)
      deep = { next: deep }
    expect(sameObservedValue(deep, structuredClone(deep))).toBe(false)
    const wide = Array.from({ length: 20_000 }, () => ({}))
    expect(sameObservedValue(wide, structuredClone(wide))).toBe(false)
  })
})

describe('每个宿主内的观察凭证', () => {
  it('绑定完整原始草稿与写入者，不把记录或返回的键共享给观察副本', () => {
    const observations = createDraftObservations()
    const key = { ...KEY }
    const draft = structuredClone(RECORD)
    const writer = { ...WRITER }
    const observation = observations.remember(key, { draft, writer, notice: NOTICE })
    key.documentId = 'elsewhere'
    draft.ciphertext[0] = 8
    writer.lastDraftSeq = 10
    expect(Object.isFrozen(observation)).toBe(true)
    expect(Object.isFrozen(observation.key)).toBe(true)
    expect(observations.matches(observation, RECORD, WRITER)).toBe(true)
    expect(observations.matches(observation, draft, WRITER)).toBe(false)
    expect(observations.matches(observation, RECORD, writer)).toBe(false)
  })

  it.each(['writeEpoch', 'writerId', 'lastDraftSeq', 'registeredAt', 'userId', 'documentId'] as const)('写入者的 %s 变化即失效，即使草稿序号未变', (field) => {
    const observations = createDraftObservations()
    const observation = observations.remember(KEY, { draft: RECORD, writer: WRITER, notice: undefined })
    const changed = { ...WRITER, [field]: typeof WRITER[field] === 'number' ? Number(WRITER[field]) + 1 : 'changed' }
    expect(observations.matches(observation, RECORD, changed)).toBe(false)
  })

  it.each([
    { ...RECORD, updatedAt: NOW + 1 },
    { ...RECORD, baseRevision: RECORD.baseRevision + 1 },
    { ...RECORD, iv: new Uint8Array(12).fill(1) },
    { ...RECORD, ciphertext: new Uint8Array(32).fill(1) },
    { ...RECORD, inFlight: null },
    { bad: true },
    undefined,
  ])('重封、删除或形状变化不能冒认原观察', (changed) => {
    const observations = createDraftObservations()
    const observation = observations.remember(KEY, { draft: RECORD, writer: WRITER, notice: undefined })
    expect(observations.matches(observation, changed, WRITER)).toBe(false)
  })

  it('新观察只使同文档旧凭证失效；旧凭证消费不能删掉最新观察', () => {
    const observations = createDraftObservations()
    const snapshot = { draft: RECORD, writer: WRITER, notice: NOTICE }
    const old = observations.remember(KEY, snapshot)
    const other = observations.remember({ ...KEY, documentId: 'other' }, snapshot)
    const latest = observations.remember(KEY, snapshot)
    observations.forget(old)
    expect(observations.matches(old, RECORD, WRITER)).toBe(false)
    expect(observations.matches(latest, RECORD, WRITER)).toBe(true)
    expect(observations.matches(other, RECORD, WRITER)).toBe(true)
    expect(observations.matches({ ...latest, key: other.key }, RECORD, WRITER)).toBe(false)
    expect(createDraftObservations().matches(latest, RECORD, WRITER)).toBe(false)
    observations.forget(latest)
    expect(observations.matches(latest, RECORD, WRITER)).toBe(false)
    observations.clear()
    expect(observations.matches(other, RECORD, WRITER)).toBe(false)
  })

  it('新提示不使正文观察失效，但不允许旧清理顺带删除新提示', () => {
    const observations = createDraftObservations()
    const observation = observations.remember(KEY, { draft: RECORD, writer: WRITER, notice: NOTICE })
    expect(observations.matches(observation, RECORD, WRITER)).toBe(true)
    expect(observations.sameNotice(observation, structuredClone(NOTICE))).toBe(true)
    expect(observations.sameNotice(observation, { ...NOTICE, kind: 'lost' })).toBe(false)
    expect(observations.sameNotice(observation, { ...NOTICE, at: NOW + 1 })).toBe(false)
  })
})
