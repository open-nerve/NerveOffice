import type { DraftMeta, WriterRecord } from './draft-record.ts'
import type { ExistingDraft, WriterIdentity } from './writer-fence.ts'
import { LOCAL_DRAFT_RETENTION_DAYS } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { NOW, OTHER_WRITER_ID, sampleMeta, sampleWriter, WRITER_ID } from './draft-record.test-support.ts'
import {
  canReplayAsSent,
  decideConfirm,
  decideRegistration,
  decideRemove,
  decideReplace,
  decideWrite,
  isExpired,
  isSameWriter,
  isWriterExpired,
  LOCAL_DRAFT_RETENTION_MS,
  shouldPurgeDraft,
  shouldPurgeWriter,
} from './writer-fence.ts'

/** 本页：第 3 代、这次登记的 W */
const ME: WriterIdentity = { writeEpoch: 3, writerId: WRITER_ID }

/** 库里的写入者：默认就是本页，高水位 7 */
function writer(overrides: Partial<WriterRecord> = {}): WriterRecord {
  return sampleWriter({ writeEpoch: 3, writerId: WRITER_ID, lastDraftSeq: 7, ...overrides })
}

/** 库里的草稿：默认是本页写下的第 7 份 */
function draft(overrides: Partial<DraftMeta> = {}): ExistingDraft {
  return { kind: 'draft', draft: sampleMeta({ writeEpoch: 3, writerId: WRITER_ID, draftSeq: 7, ...overrides }) }
}

/** 别的写入者留下的草稿（上一代 X 写的第 6 份） */
function foreignDraft(overrides: Partial<DraftMeta> = {}): ExistingDraft {
  return draft({ writeEpoch: 2, writerId: OTHER_WRITER_ID, draftSeq: 6, ...overrides })
}

const NEWER: ExistingDraft = { kind: 'newer-format' }
const MALFORMED: ExistingDraft = { kind: 'malformed' }

describe('同一个写入者：代次与 writerId 都相同', () => {
  it('两项都相同才算', () => {
    expect(isSameWriter(ME, { writeEpoch: 3, writerId: WRITER_ID })).toBe(true)
    expect(isSameWriter(ME, { writeEpoch: 4, writerId: WRITER_ID })).toBe(false)
    expect(isSameWriter(ME, { writeEpoch: 3, writerId: OTHER_WRITER_ID })).toBe(false)
  })
})

describe('登记写入者（M4-P1 设计 §3.4.2）：只有代次更大的能登记；高水位 = max(旧写入者的高水位, 现有草稿的序号)', () => {
  const cases: readonly { readonly name: string, readonly writer: WriterRecord | undefined, readonly existing: ExistingDraft | undefined, readonly incoming?: WriterIdentity, readonly force?: boolean, readonly expected: ReturnType<typeof decideRegistration> }[] = [
    { name: '没有写入者、没有草稿：登记，高水位 0', writer: undefined, existing: undefined, expected: { kind: 'register', lastDraftSeq: 0 } },
    { name: '没有写入者、有别人留下的草稿：登记，高水位接着草稿的序号', writer: undefined, existing: foreignDraft({ draftSeq: 9 }), expected: { kind: 'register', lastDraftSeq: 9 } },
    { name: '同一个写入者再登记一次（幂等）：高水位不变', writer: writer(), existing: draft(), expected: { kind: 'register', lastDraftSeq: 7 } },
    { name: '高水位取两者里大的：草稿的序号更大', writer: writer({ lastDraftSeq: 4 }), existing: draft({ draftSeq: 9 }), expected: { kind: 'register', lastDraftSeq: 9 } },
    { name: '高水位取两者里大的：写入者的更大（草稿删了，高水位还在）', writer: writer({ lastDraftSeq: 12 }), existing: undefined, expected: { kind: 'register', lastDraftSeq: 12 } },
    { name: '现有的写入者代次更小：取代它', writer: writer({ writeEpoch: 2, writerId: OTHER_WRITER_ID }), existing: foreignDraft(), expected: { kind: 'register', lastDraftSeq: 7 } },
    { name: '现有的写入者代次更大：superseded，交回它的代次', writer: writer({ writeEpoch: 4, writerId: OTHER_WRITER_ID }), existing: undefined, expected: { kind: 'superseded', currentEpoch: 4, sameEpoch: false } },
    { name: '代次相同、writerId 不同（同一个页面重建了 Worker、重新登记）：superseded，sameEpoch', writer: writer({ writerId: OTHER_WRITER_ID }), existing: undefined, expected: { kind: 'superseded', currentEpoch: 3, sameEpoch: true } },
    { name: '经服务端核对之后 force：代次更大的写入者也被取代（例如服务端从备份恢复、代次倒退）', writer: writer({ writeEpoch: 9, writerId: OTHER_WRITER_ID, lastDraftSeq: 20 }), existing: undefined, force: true, expected: { kind: 'register', lastDraftSeq: 20 } },
    { name: '经服务端核对之后 force：同一代的另一次登记被取代', writer: writer({ writerId: OTHER_WRITER_ID }), existing: foreignDraft({ writeEpoch: 3, draftSeq: 7 }), force: true, expected: { kind: 'register', lastDraftSeq: 7 } },
    { name: '现有的草稿认不出（更新的页面写的）：序号不知道，高水位按写入者的', writer: writer({ writeEpoch: 2, writerId: OTHER_WRITER_ID, lastDraftSeq: 5 }), existing: NEWER, expected: { kind: 'register', lastDraftSeq: 5 } },
    { name: '现有的草稿形状不对：同上', writer: undefined, existing: MALFORMED, expected: { kind: 'register', lastDraftSeq: 0 } },
  ]
  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(decideRegistration(testCase.writer, testCase.existing, testCase.incoming ?? ME, testCase.force ?? false)).toEqual(testCase.expected)
    })
  }
})

describe('写入（§3.4.3）：核对写入者、序号单调、不覆盖别的写入者留下还没接手的草稿；同一写入者同一序号的重试按已写入', () => {
  type Incoming = WriterIdentity & { readonly draftSeq: number, readonly adoptSeq?: number }
  const cases: readonly { readonly name: string, readonly writer: WriterRecord | undefined, readonly existing: ExistingDraft | undefined, readonly incoming: Incoming, readonly expected: ReturnType<typeof decideWrite> }[] = [
    { name: '没有写入者（被清理删掉了）：not-writer', writer: undefined, existing: undefined, incoming: { ...ME, draftSeq: 8 }, expected: 'not-writer' },
    { name: '写入者是更大的一代：not-writer', writer: writer({ writeEpoch: 4, writerId: OTHER_WRITER_ID }), existing: undefined, incoming: { ...ME, draftSeq: 8 }, expected: 'not-writer' },
    { name: '同一代、另一次登记：not-writer', writer: writer({ writerId: OTHER_WRITER_ID }), existing: undefined, incoming: { ...ME, draftSeq: 8 }, expected: 'not-writer' },
    { name: '写入者是更小的一代（本页没登记就写）：not-writer', writer: writer({ writeEpoch: 2 }), existing: undefined, incoming: { ...ME, draftSeq: 8 }, expected: 'not-writer' },
    { name: '是写入者、序号比高水位大、没有草稿：ok', writer: writer(), existing: undefined, incoming: { ...ME, draftSeq: 8 }, expected: 'ok' },
    { name: '覆盖自己的上一份：ok', writer: writer(), existing: draft(), incoming: { ...ME, draftSeq: 8 }, expected: 'ok' },
    { name: '序号跳过几个（去重留下的空号）：ok', writer: writer(), existing: draft(), incoming: { ...ME, draftSeq: 11 }, expected: 'ok' },
    { name: '同一写入者、同一序号，库里就是它（提交了而回应丢了的重试）：duplicate', writer: writer(), existing: draft(), incoming: { ...ME, draftSeq: 7 }, expected: 'duplicate' },
    { name: '序号等于高水位、草稿已删（确认之后）：stale-seq', writer: writer(), existing: undefined, incoming: { ...ME, draftSeq: 7 }, expected: 'stale-seq' },
    { name: '序号比高水位小：stale-seq', writer: writer(), existing: draft(), incoming: { ...ME, draftSeq: 5 }, expected: 'stale-seq' },
    { name: '序号等于高水位、库里是自己更早的一份：stale-seq（不是 duplicate）', writer: writer(), existing: draft({ draftSeq: 6 }), incoming: { ...ME, draftSeq: 7 }, expected: 'stale-seq' },
    { name: '库里那一份序号相同但不是这个写入者写的：stale-seq（不是 duplicate）', writer: writer({ lastDraftSeq: 6 }), existing: foreignDraft(), incoming: { ...ME, draftSeq: 6 }, expected: 'stale-seq' },
    { name: '别的写入者留下的草稿、没有接手：foreign-draft', writer: writer(), existing: foreignDraft(), incoming: { ...ME, draftSeq: 8 }, expected: 'foreign-draft' },
    { name: '同一代另一次登记留下的草稿（页面重建了 Worker）、没有接手：foreign-draft', writer: writer(), existing: foreignDraft({ writeEpoch: 3 }), incoming: { ...ME, draftSeq: 8 }, expected: 'foreign-draft' },
    { name: '带着接手的序号、正是库里那一份：ok', writer: writer(), existing: foreignDraft(), incoming: { ...ME, draftSeq: 8, adoptSeq: 6 }, expected: 'ok' },
    { name: '带着接手的序号、库里已经换成别的一份：foreign-draft', writer: writer(), existing: foreignDraft({ draftSeq: 7 }), incoming: { ...ME, draftSeq: 8, adoptSeq: 6 }, expected: 'foreign-draft' },
    { name: '带着接手的序号、草稿已经不在：ok（没有要护住的）', writer: writer(), existing: undefined, incoming: { ...ME, draftSeq: 8, adoptSeq: 6 }, expected: 'ok' },
    { name: '带着接手的序号、库里是自己的：ok', writer: writer(), existing: draft(), incoming: { ...ME, draftSeq: 8, adoptSeq: 3 }, expected: 'ok' },
    { name: '库里是更新的页面写的：foreign-draft，带了接手的序号也一样（不动它）', writer: writer(), existing: NEWER, incoming: { ...ME, draftSeq: 8, adoptSeq: 7 }, expected: 'foreign-draft' },
    { name: '库里那一条形状不对：foreign-draft（要先显式删掉）', writer: writer(), existing: MALFORMED, incoming: { ...ME, draftSeq: 8 }, expected: 'foreign-draft' },
  ]
  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(decideWrite(testCase.writer, testCase.existing, testCase.incoming)).toBe(testCase.expected)
    })
  }
})

describe('重封（§3.4.4）：仍是 expectedSeq 那一份、仍是本页写下的、写入者仍是它', () => {
  type Incoming = WriterIdentity & { readonly expectedSeq: number }
  const cases: readonly { readonly name: string, readonly writer: WriterRecord | undefined, readonly existing: ExistingDraft | undefined, readonly incoming: Incoming, readonly expected: ReturnType<typeof decideReplace> }[] = [
    { name: '没有写入者：not-writer', writer: undefined, existing: draft(), incoming: { ...ME, expectedSeq: 7 }, expected: 'not-writer' },
    { name: '写入者换了：not-writer', writer: writer({ writeEpoch: 4, writerId: OTHER_WRITER_ID }), existing: draft(), incoming: { ...ME, expectedSeq: 7 }, expected: 'not-writer' },
    { name: '仍是那一份：ok', writer: writer(), existing: draft(), incoming: { ...ME, expectedSeq: 7 }, expected: 'ok' },
    { name: '期间又写了新的一份：changed', writer: writer({ lastDraftSeq: 8 }), existing: draft({ draftSeq: 8 }), incoming: { ...ME, expectedSeq: 7 }, expected: 'changed' },
    { name: '草稿已经不在：changed', writer: writer(), existing: undefined, incoming: { ...ME, expectedSeq: 7 }, expected: 'changed' },
    { name: '序号对得上、却是别的写入者写的：changed', writer: writer(), existing: foreignDraft({ draftSeq: 7 }), incoming: { ...ME, expectedSeq: 7 }, expected: 'changed' },
    { name: '库里那一条认不出：changed', writer: writer(), existing: NEWER, incoming: { ...ME, expectedSeq: 7 }, expected: 'changed' },
    { name: '库里那一条形状不对：changed', writer: writer(), existing: MALFORMED, incoming: { ...ME, expectedSeq: 7 }, expected: 'changed' },
  ]
  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(decideReplace(testCase.writer, testCase.existing, testCase.incoming)).toBe(testCase.expected)
    })
  }
})

describe('确认（§3.4.5）：只删到已确认的序号；更新的改基准；别的写入者留下的不动', () => {
  type Incoming = WriterIdentity & { readonly confirmedSeq: number }
  const cases: readonly { readonly name: string, readonly writer: WriterRecord | undefined, readonly existing: ExistingDraft | undefined, readonly incoming: Incoming, readonly expected: ReturnType<typeof decideConfirm> }[] = [
    { name: '没有写入者：not-writer', writer: undefined, existing: draft(), incoming: { ...ME, confirmedSeq: 7 }, expected: 'not-writer' },
    { name: '写入者换了：not-writer（新一代的记录不删）', writer: writer({ writeEpoch: 4, writerId: OTHER_WRITER_ID }), existing: draft({ writeEpoch: 4, writerId: OTHER_WRITER_ID, draftSeq: 9 }), incoming: { ...ME, confirmedSeq: 9 }, expected: 'not-writer' },
    { name: '已经没有草稿：absent', writer: writer(), existing: undefined, incoming: { ...ME, confirmedSeq: 7 }, expected: 'absent' },
    { name: '草稿就是确认的那一份：delete', writer: writer(), existing: draft(), incoming: { ...ME, confirmedSeq: 7 }, expected: 'delete' },
    { name: '草稿比确认的旧（确认来得晚）：delete', writer: writer(), existing: draft({ draftSeq: 5 }), incoming: { ...ME, confirmedSeq: 7 }, expected: 'delete' },
    { name: '确认期间又写了新的（保存中继续输入，A08）：rebase，不删', writer: writer({ lastDraftSeq: 8 }), existing: draft({ draftSeq: 8 }), incoming: { ...ME, confirmedSeq: 7 }, expected: 'rebase' },
    { name: '别的写入者留下的、序号不大于确认的：foreign-draft（本页的上传不包含它的内容）', writer: writer(), existing: foreignDraft(), incoming: { ...ME, confirmedSeq: 9 }, expected: 'foreign-draft' },
    { name: '库里那一条认不出：foreign-draft', writer: writer(), existing: NEWER, incoming: { ...ME, confirmedSeq: 9 }, expected: 'foreign-draft' },
    { name: '库里那一条形状不对：foreign-draft', writer: writer(), existing: MALFORMED, incoming: { ...ME, confirmedSeq: 9 }, expected: 'foreign-draft' },
  ]
  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(decideConfirm(testCase.writer, testCase.existing, testCase.incoming)).toBe(testCase.expected)
    })
  }
})

describe('放弃（§3.4.7）：用户的决定，不核对写入者；带 expectedSeq 时只删那一份', () => {
  const cases: readonly { readonly name: string, readonly existing: ExistingDraft | undefined, readonly expectedSeq?: number, readonly expected: ReturnType<typeof decideRemove> }[] = [
    { name: '没有草稿：absent', existing: undefined, expected: 'absent' },
    { name: '没有草稿、带 expectedSeq：absent', existing: undefined, expectedSeq: 7, expected: 'absent' },
    { name: '有草稿、不带 expectedSeq：remove（不论谁写的）', existing: foreignDraft(), expected: 'remove' },
    { name: '带 expectedSeq、正是那一份：remove', existing: draft(), expectedSeq: 7, expected: 'remove' },
    { name: '带 expectedSeq、别的标签页刚写了新的：changed', existing: draft({ draftSeq: 8 }), expectedSeq: 7, expected: 'changed' },
    { name: '认不出的记录、不带 expectedSeq：remove（本机草稿页放弃它）', existing: NEWER, expected: 'remove' },
    { name: '形状不对的记录、不带 expectedSeq：remove', existing: MALFORMED, expected: 'remove' },
    { name: '认不出的记录、带 expectedSeq：changed（对不上序号）', existing: MALFORMED, expectedSeq: 7, expected: 'changed' },
  ]
  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(decideRemove(testCase.existing, testCase.expectedSeq)).toBe(testCase.expected)
    })
  }
})

describe('保留期（§3.4.6、§3.4.7）：14 天，与契约同源', () => {
  const DAY_MS = 24 * 60 * 60 * 1000

  it('保留期的毫秒数来自契约的天数', () => {
    expect(LOCAL_DRAFT_RETENTION_MS).toBe(LOCAL_DRAFT_RETENTION_DAYS * DAY_MS)
    expect(LOCAL_DRAFT_RETENTION_MS).toBe(1_209_600_000)
  })

  it('草稿超过 14 天才过期：恰好 14 天不算，多 1 毫秒算；时钟往回拨（更新时间在将来）不算', () => {
    expect(isExpired({ updatedAt: NOW - LOCAL_DRAFT_RETENTION_MS }, NOW)).toBe(false)
    expect(isExpired({ updatedAt: NOW - LOCAL_DRAFT_RETENTION_MS - 1 }, NOW)).toBe(true)
    expect(isExpired({ updatedAt: NOW }, NOW)).toBe(false)
    expect(isExpired({ updatedAt: NOW + DAY_MS }, NOW)).toBe(false)
  })

  it('写入者按登记的时刻，同样的边界', () => {
    expect(isWriterExpired({ registeredAt: NOW - LOCAL_DRAFT_RETENTION_MS }, NOW)).toBe(false)
    expect(isWriterExpired({ registeredAt: NOW - LOCAL_DRAFT_RETENTION_MS - 1 }, NOW)).toBe(true)
  })

  it('原样重放：在途的就是这一份，并且发出不满 14 天（服务端修订记录与回执至少留 15 天）', () => {
    const inFlight = { requestId: 'r', clientInstanceId: 'c', localSeq: 7, sentAt: NOW - LOCAL_DRAFT_RETENTION_MS + 1 }
    expect(canReplayAsSent({ draftSeq: 7, inFlight }, NOW)).toBe(true)
    expect(canReplayAsSent({ draftSeq: 7, inFlight: { ...inFlight, sentAt: NOW - LOCAL_DRAFT_RETENTION_MS } }, NOW)).toBe(false)
    expect(canReplayAsSent({ draftSeq: 7, inFlight: { ...inFlight, sentAt: NOW + DAY_MS } }, NOW)).toBe(true)
    expect(canReplayAsSent({ draftSeq: 8, inFlight }, NOW), '在途之后又写了新的一份').toBe(false)
    expect(canReplayAsSent({ draftSeq: 7, inFlight: null }, NOW), '不在途').toBe(false)
  })

  it('清理草稿：按记录里读得出的更新时间（不论格式、不论属于谁），超过 14 天才删；读不出更新时间的留着（P3、P4 发现之后说明并删）', () => {
    expect(shouldPurgeDraft(NOW - LOCAL_DRAFT_RETENTION_MS - 1, NOW)).toBe(true)
    expect(shouldPurgeDraft(NOW - LOCAL_DRAFT_RETENTION_MS, NOW), '恰好 14 天不算').toBe(false)
    expect(shouldPurgeDraft(NOW + DAY_MS, NOW), '更新时间在将来（时钟往回拨过）').toBe(false)
    expect(shouldPurgeDraft(undefined, NOW), '读不出更新时间').toBe(false)
  })

  it('清理写入者：没有草稿、并且登记超过 14 天才删；形状不对的（undefined）没有草稿时也删', () => {
    const expired = { registeredAt: NOW - LOCAL_DRAFT_RETENTION_MS - 1 }
    const fresh = { registeredAt: NOW - LOCAL_DRAFT_RETENTION_MS }
    expect(shouldPurgeWriter(expired, false, NOW)).toBe(true)
    expect(shouldPurgeWriter(expired, true, NOW), '还有草稿：高水位要留着').toBe(false)
    expect(shouldPurgeWriter(fresh, false, NOW)).toBe(false)
    expect(shouldPurgeWriter(undefined, false, NOW)).toBe(true)
    expect(shouldPurgeWriter(undefined, true, NOW)).toBe(false)
  })
})
