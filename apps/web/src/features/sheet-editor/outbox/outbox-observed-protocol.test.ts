import { describe, expect, it } from 'vitest'
import { sampleMeta, sampleWriter } from '../../../shared/outbox/draft-record.test-support.ts'
import { failedResult, OUTBOX_PROTOCOL_VERSION, readOutboxRequest, readOutboxResult } from './outbox-protocol.ts'

const META = sampleMeta()
const KEY = { userId: META.userId, documentId: META.documentId }
const OBSERVATION = { key: KEY, id: 'host-observation' }
const CAPTURE = { key: KEY, writer: { writeEpoch: META.writeEpoch, writerId: META.writerId }, draftSeq: 8, baseRevision: 12, writtenBy: META.writtenBy, format: META.format, formulasPending: false, bytes: new Uint8Array([1, 2]) }
const OBSERVED = { kind: 'observed', observation: OBSERVATION, record: { kind: 'draft', meta: META, gzip: new Uint8Array([1]) }, writer: sampleWriter() }
const envelope = (call: object) => ({ v: OUTBOX_PROTOCOL_VERSION, id: 1, ...call })

describe('恢复凭证的 Worker 协议', () => {
  it.each([
    { type: 'observe', draft: KEY },
    { type: 'adopt', observation: OBSERVATION, capture: CAPTURE },
    { type: 'remove-observed', observation: OBSERVATION },
  ])('完整恢复请求可往返：$type', (call) => {
    expect(readOutboxRequest(envelope(call))).toEqual({ kind: 'request', request: envelope(call) })
  })

  it.each([
    undefined,
    null,
    {},
    { key: KEY },
    { key: KEY, id: '' },
    { key: { userId: '' }, id: 'id' },
  ])('不完整凭证不能触发接手或清理：%#', (observation) => {
    expect(readOutboxRequest(envelope({ type: 'adopt', observation, capture: CAPTURE }))).toEqual({ kind: 'invalid', id: 1 })
    expect(readOutboxRequest(envelope({ type: 'remove-observed', observation }))).toEqual({ kind: 'invalid', id: 1 })
  })

  it.each([{ inFlight: META.inFlight }, { inFlight: null }, { dedupe: false }, { adoptSeq: 7 }, { bytes: null }, { draftSeq: 0 }])('不能夹带旧请求或坏捕获：%#', (extra) => {
    expect(readOutboxRequest(envelope({ type: 'adopt', observation: OBSERVATION, capture: { ...CAPTURE, ...extra } }))).toEqual({ kind: 'invalid', id: 1 })
  })

  it('观察响应保留原元数据/字节与完整写入者；空记录与读不出也属于观察事实', () => {
    expect(readOutboxResult('observe', OBSERVED)).toEqual(OBSERVED)
    for (const record of [{ kind: 'absent' }, { kind: 'malformed' }, { kind: 'newer-format', recordVersion: 2 }, { kind: 'no-key', meta: META }, { kind: 'unreadable', meta: META, reason: 'stale-key' }])
      expect(readOutboxResult('observe', { ...OBSERVED, record, writer: undefined })).toEqual({ ...OBSERVED, record, writer: undefined })
  })

  it.each([
    { observation: null },
    { record: null },
    { record: { kind: 'failed', error: { name: 'x', message: 'x' } } },
    { writer: {} },
    { writer: { ...sampleWriter(), lastDraftSeq: -1 } },
    { writer: { ...sampleWriter(), documentId: 'other' } },
    { record: { ...OBSERVED.record, meta: { ...META, userId: 'other' } } },
  ])('坏响应或外来身份不授予可操作凭证：%#', (extra) => {
    expect(readOutboxResult('observe', { ...OBSERVED, ...extra })).toBeNull()
  })

  it.each([{ kind: 'removed' }, { kind: 'busy' }, { kind: 'quota' }, { kind: 'unsupported' }, { kind: 'failed', error: { name: 'Error', message: 'test' } }])('已删除结果必须同时交回镜像事实：$kind', (mirror) => {
    expect(readOutboxResult('remove-observed', { kind: 'removed', mirror })).toEqual({ kind: 'removed', mirror })
  })

  it('缺镜像事实的已删除结果无效，changed/absent 和真实存储失败仍可辨识', () => {
    expect(readOutboxResult('remove-observed', { kind: 'removed' })).toBeNull()
    expect(readOutboxResult('remove-observed', { kind: 'removed', mirror: { kind: 'mirrored' } })).toBeNull()
    for (const kind of ['changed', 'absent', 'quota'])
      expect(readOutboxResult('remove-observed', { kind })).toEqual({ kind })
    const error = { name: 'Closed', message: 'test' }
    expect(failedResult('observe', error)).toEqual({ kind: 'failed', error })
    expect(failedResult('adopt', error)).toEqual({ kind: 'failed', error, gzip: null })
    expect(failedResult('remove-observed', error)).toEqual({ kind: 'failed', error })
  })
})
