import { describe, expect, it } from 'vitest'
import { USER_ID } from './draft-record.test-support.ts'
import { OUTBOX_PROTOCOL_VERSION, readOutboxRequest, readOutboxResult } from './outbox-protocol.ts'

const PERMIT = { userId: USER_ID, generation: '0199b0c4-7d3e-7a3b-9c4e-000000000001' }

describe('会话绑定的 Worker 边界', () => {
  it('旧版握手不能被需要绑定的新协议接纳', () => {
    expect(readOutboxRequest({ v: 1, id: 1, type: 'hello', keepAlive: true })).toEqual({ kind: 'invalid', id: 1 })
  })

  it('绑定只接收严格的用户与代次，克隆之后仍逐字段检查', () => {
    const request = { v: OUTBOX_PROTOCOL_VERSION, id: 2, type: 'bind-session', permit: PERMIT }
    expect(readOutboxRequest(structuredClone({ ...request, extra: 'ignored' }))).toEqual({ kind: 'request', request })
    for (const permit of [undefined, null, {}, { ...PERMIT, userId: 'user' }, { ...PERMIT, generation: 'old' }, { ...PERMIT, sourceHash: 'not-accepted' }])
      expect(readOutboxRequest({ ...request, permit })).toEqual({ kind: 'invalid', id: 2 })
  })

  it('绑定失败跨 Worker 如实交回，不能当作成功或普通存储空结果', () => {
    for (const result of [{ kind: 'bound' }, { kind: 'session-invalid' }, { kind: 'quota' }, { kind: 'unavailable', reason: 'blocked' }, { kind: 'failed', error: { name: 'UnknownError', message: '断连' } }])
      expect(readOutboxResult('bind-session', structuredClone(result))).toEqual(result)
  })

  it.each(['write', 'adopt'] as const)('%s 在压缩前已失效可以没有 gzip，由原捕获的内存退路负责上传', (operation) => {
    for (const result of [{ kind: 'session-invalid', gzip: null }, { kind: 'quota', gzip: null }, { kind: 'unavailable', reason: 'blocked', gzip: null }])
      expect(readOutboxResult(operation, structuredClone(result))).toEqual(result)
  })
})
