import { describe, expect, it } from 'vitest'
import { NOW, sampleStoredDraft } from '../../shared/outbox/draft-record.test-support.ts'
import { assertMeasuredDraft } from './selftest-local-save-draft.ts'

const draft = sampleStoredDraft()
const expected = { identity: { userId: draft.userId, documentId: draft.documentId, writerId: draft.writerId, writeEpoch: draft.writeEpoch, writtenBy: draft.writtenBy }, lastDraftSeq: 6, baseRevision: 12, wallStartedAt: NOW - 10, readAt: NOW + 10 }

describe('本轮计时结束后的真实草稿门槛', () => {
  it('接受同一写入者的新原件，随后仍须真实 Worker 与独立解密核对', () => {
    expect(() => assertMeasuredDraft(draft, expected)).not.toThrow()
  })
  it('云端 ACK 已先清掉本轮草稿时直接失败，不重用上轮记录', () => {
    expect(() => assertMeasuredDraft(undefined, expected)).toThrow('缺少本轮')
    expect(() => assertMeasuredDraft({ ...draft, draftSeq: 6 }, expected)).toThrow('缺少本轮')
  })
  it.each([
    { userId: 'other' },
    { documentId: 'other' },
    { writerId: 'other' },
    { writtenBy: 'other' },
    { writeEpoch: 4 },
    { baseRevision: 11 },
    { formulasPending: true },
    { updatedAt: NOW - 11 },
    { updatedAt: NOW + 11 },
  ])('错身份、旧/未来时刻或未完成公式不能通过 %j', (change) => {
    expect(() => assertMeasuredDraft({ ...draft, ...change }, expected)).toThrow('缺少本轮')
  })
})
