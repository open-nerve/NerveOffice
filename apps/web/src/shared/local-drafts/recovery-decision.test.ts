import type { ContentFormat, DraftMeta } from '../outbox/draft-record.ts'
import type { RecoveryDecision, RecoveryFacts, RecoveryRecord } from './recovery-decision.ts'
import { describe, expect, it } from 'vitest'
import { DOCUMENT_ID, NOW, sampleMeta, USER_ID } from '../outbox/draft-record.test-support.ts'
import { LOCAL_DRAFT_RETENTION_MS } from '../outbox/writer-fence.ts'
import { decideDraftRecovery, draftReplayRequest } from './recovery-decision.ts'

const FORMAT: ContentFormat = { clientBuild: '0.1.0+current', univerVersion: '1.0.0', profile: 'sheet@1', formatVersion: 1 }
const KEY = { userId: USER_ID, documentId: DOCUMENT_ID }
const meta = (overrides: Partial<DraftMeta> = {}): DraftMeta => sampleMeta({ format: FORMAT, inFlight: null, ...overrides })
const pending = sampleMeta({ format: FORMAT })

function facts(overrides: Partial<RecoveryFacts> = {}): RecoveryFacts {
  return {
    key: KEY,
    record: { kind: 'draft', meta: meta() },
    access: 'editable',
    online: true,
    current: { revision: 12, source: null, occupied: false },
    pageFormat: FORMAT,
    replay: { kind: 'unchecked' },
    now: NOW,
    ...overrides,
  }
}

const restore: RecoveryDecision = { kind: 'restore', baseRevision: 12, formulasPending: false, reason: 'fast-forward' }

describe('恢复的前提与不可读记录（M4 总设计 §6.4）', () => {
  it.each(['unknown', 'unreadable', 'read-only', 'editable'] as const)('会话资格失效先于 %s 权限事实，不授予删除或读取资格', (access) => {
    expect(decideDraftRecovery(facts({ access, record: { kind: 'session-invalid' } }))).toEqual({ kind: 'preserve', reason: 'session' })
  })

  it.each<{ name: string, input: Partial<RecoveryFacts>, expected: RecoveryDecision }>([
    { name: '没有记录', input: { record: { kind: 'absent' } }, expected: { kind: 'none' } },
    { name: '会话未确认，不能处理原用户记录', input: { access: 'unknown' }, expected: { kind: 'preserve', reason: 'session' } },
    { name: '离线', input: { online: false }, expected: { kind: 'preserve', reason: 'offline' } },
    { name: '已确认读不到，不能给副本', input: { access: 'unreadable' }, expected: { kind: 'remove', reason: 'unreadable' } },
    { name: '只能阅读', input: { access: 'read-only' }, expected: { kind: 'copy', reason: 'read-only' } },
    { name: '服务端事实未取得', input: { current: undefined }, expected: { kind: 'preserve', reason: 'server' } },
    { name: '手里没有钥匙', input: { record: { kind: 'no-key', meta: meta() } }, expected: { kind: 'preserve', reason: 'key' } },
    { name: '本页旧钥，绝不删除', input: { record: { kind: 'unreadable', meta: meta(), reason: 'stale-key' } }, expected: { kind: 'refresh-key' } },
    { name: '密钥已吊销', input: { record: { kind: 'unreadable', meta: meta(), reason: 'revoked' } }, expected: { kind: 'remove', reason: 'revoked' } },
    { name: '同版本钥匙认证失败', input: { record: { kind: 'unreadable', meta: meta(), reason: 'corrupted' } }, expected: { kind: 'remove', reason: 'corrupted' } },
    { name: '记录形状损坏', input: { record: { kind: 'malformed' } }, expected: { kind: 'remove', reason: 'malformed' } },
    { name: '较新记录结构', input: { record: { kind: 'newer-format', recordVersion: 2 } }, expected: { kind: 'preserve', reason: 'newer-format' } },
  ])('$name', ({ input, expected }) => {
    expect(decideDraftRecovery(facts(input))).toEqual(expected)
  })

  it.each<RecoveryRecord>([
    { kind: 'failed', error: { name: 'StorageError', message: '读不出' } },
    { kind: 'quota' },
    { kind: 'unavailable', reason: 'blocked' },
  ])('存储问题 $kind 不是没有记录或撤权，不自动清理', (record) => {
    expect(decideDraftRecovery(facts({ record, access: 'unreadable' }))).toEqual({ kind: 'preserve', reason: 'storage' })
  })

  it.each(['userId', 'documentId'] as const)('外来的 %s 在撤权/过期分支之前拦下', (field) => {
    const record = { kind: 'draft' as const, meta: meta({ [field]: 'another', updatedAt: NOW - LOCAL_DRAFT_RETENTION_MS - 1 }) }
    expect(decideDraftRecovery(facts({ record, access: 'unreadable' }))).toEqual({ kind: 'preserve', reason: 'identity' })
  })

  it.each(['revoked', 'corrupted', 'stale-key'] as const)('未确认会话不能按 %s 删除/换钥', (reason) => {
    expect(decideDraftRecovery(facts({ access: 'unknown', record: { kind: 'unreadable', meta: meta(), reason } }))).toEqual({ kind: 'preserve', reason: 'session' })
  })

  it('旧钥不能借过期分支删掉另一页的新钥记录', () => {
    expect(decideDraftRecovery(facts({ record: { kind: 'unreadable', meta: meta({ updatedAt: NOW - LOCAL_DRAFT_RETENTION_MS - 1 }), reason: 'stale-key' } }))).toEqual({ kind: 'refresh-key' })
  })
})

describe('可读格式、保留期与无副作用', () => {
  it.each<Partial<ContentFormat>>([
    { univerVersion: '2.0.0' },
    { univerVersion: 'unknown' },
    { profile: 'sheet@2' },
    { formatVersion: 2 },
  ])('不认识的数据格式保留，不借过期删除：%j', (format) => {
    const record = { kind: 'draft' as const, meta: meta({ format: { ...FORMAT, ...format }, updatedAt: NOW - LOCAL_DRAFT_RETENTION_MS - 1 }) }
    expect(decideDraftRecovery(facts({ record }))).toEqual({ kind: 'preserve', reason: 'newer-format' })
  })

  it.each<Partial<ContentFormat>>([{ clientBuild: '99.0.0+newer' }, { univerVersion: '0.9.0' }])('可读的数据格式不因构建号较新或 SDK 较旧而阻止恢复：%j', (format) => {
    expect(decideDraftRecovery(facts({ record: { kind: 'draft', meta: meta({ format: { ...FORMAT, ...format } }) } }))).toEqual(restore)
  })

  it.each([
    { age: LOCAL_DRAFT_RETENTION_MS, expected: restore },
    { age: LOCAL_DRAFT_RETENTION_MS + 1, expected: { kind: 'remove', reason: 'expired' } },
    { age: -1, expected: restore },
  ])('记录年龄 $age 毫秒', ({ age, expected }) => {
    expect(decideDraftRecovery(facts({ record: { kind: 'draft', meta: meta({ updatedAt: NOW - age }) } }))).toEqual(expected)
  })

  it('冻结输入，决策不改写原元数据或原请求', () => {
    const value = facts({ record: { kind: 'draft', meta: pending } })
    const before = structuredClone(value)
    Object.freeze(pending.format)
    Object.freeze(pending.inFlight)
    Object.freeze(pending)
    Object.freeze(value.record)
    Object.freeze(value)
    expect(decideDraftRecovery(value).kind).toBe('replay')
    expect(value).toEqual(before)
  })
})

describe('旧请求的精确重放与迟到结果', () => {
  it('只从原元数据构造请求，不换标识/序号/格式/公式标记/代次', () => {
    const original = { ...pending, formulasPending: true }
    expect(draftReplayRequest(original, NOW)).toEqual({
      request: { requestId: pending.inFlight?.requestId, clientInstanceId: pending.inFlight?.clientInstanceId, localSeq: 7, baseRevision: 12, format: FORMAT, formulasPending: true },
      writeEpoch: 3,
    })
  })

  it.each([
    meta(),
    { ...pending, draftSeq: 8 },
    { ...pending, inFlight: { ...pending.inFlight!, sentAt: NOW - LOCAL_DRAFT_RETENTION_MS } },
    { ...pending, inFlight: { ...pending.inFlight!, sentAt: NOW - LOCAL_DRAFT_RETENTION_MS - 1 } },
  ])('没有原正文或原请求已经满 14 天不重放', (record) => {
    expect(draftReplayRequest(record, NOW)).toBeUndefined()
  })

  it('距 14 天还差一毫秒可以按原样重放', () => {
    expect(draftReplayRequest({ ...pending, inFlight: { ...pending.inFlight!, sentAt: NOW - LOCAL_DRAFT_RETENTION_MS + 1 } }, NOW)).toBeDefined()
  })

  it.each(['editable', 'read-only'] as const)('精确旧请求先于同基准和 %s 的新操作核对', (access) => {
    expect(decideDraftRecovery(facts({ access, record: { kind: 'draft', meta: pending } }))).toEqual({ kind: 'replay', replay: draftReplayRequest(pending, NOW) })
  })

  it('结果未知保留原件，不因修订相同而进入编辑', () => {
    expect(decideDraftRecovery(facts({ record: { kind: 'draft', meta: pending }, replay: { kind: 'unknown', requestId: pending.inFlight!.requestId } }))).toEqual({ kind: 'preserve', reason: 'replay' })
  })

  it('拿到旧回执只给确认结果，不能用旧内容覆盖较新服务端修订', () => {
    expect(decideDraftRecovery(facts({ record: { kind: 'draft', meta: pending }, current: { revision: 19, source: null, occupied: true }, replay: { kind: 'confirmed', requestId: pending.inFlight!.requestId, revision: 13 } }))).toEqual({ kind: 'confirmed', revision: 13 })
  })

  it('明确的无租约拒绝后，内容可直接快进', () => {
    expect(decideDraftRecovery(facts({ record: { kind: 'draft', meta: pending }, replay: { kind: 'unconfirmed', requestId: pending.inFlight!.requestId } }))).toEqual(restore)
  })

  it.each(['unknown', 'unconfirmed', 'confirmed'] as const)('其他请求的 %s 结论不属于当前草稿', (kind) => {
    const result = decideDraftRecovery(facts({ record: { kind: 'draft', meta: pending }, replay: { kind, requestId: 'another', revision: 13 } }))
    expect(result).toEqual({ kind: 'replay', replay: draftReplayRequest(pending, NOW) })
  })

  it('较新草稿不能借旧内容的成功回执清除；按来源接续', () => {
    const record = { ...pending, draftSeq: 8 }
    expect(decideDraftRecovery(facts({ record: { kind: 'draft', meta: record }, current: { revision: 13, source: { clientInstanceId: pending.inFlight!.clientInstanceId, localSeq: 7 }, occupied: false }, replay: { kind: 'confirmed', requestId: pending.inFlight!.requestId, revision: 13 } }))).toEqual({ kind: 'restore', baseRevision: 13, formulasPending: false, reason: 'own-revision' })
  })
})

describe('基准、来源与占用判定', () => {
  it('相同基准恢复，公式待更新标记照原记录交给后续重算', () => {
    expect(decideDraftRecovery(facts({ record: { kind: 'draft', meta: meta({ formulasPending: true }) } }))).toEqual({ ...restore, formulasPending: true })
  })

  it('别人还没保存，等待/请求编辑；不凭同基准直接进入编辑', () => {
    expect(decideDraftRecovery(facts({ current: { revision: 12, source: null, occupied: true } }))).toEqual({ kind: 'held' })
  })

  it.each([
    { revision: 11, source: null },
    { revision: 14, source: { clientInstanceId: pending.inFlight!.clientInstanceId, localSeq: 7 } },
    { revision: 13, source: null },
    { revision: 13, source: { clientInstanceId: 'another', localSeq: 7 } },
    { revision: 13, source: { clientInstanceId: pending.inFlight!.clientInstanceId, localSeq: 8 } },
  ])('不能严格证明自己追自己，给副本：%j', (current) => {
    expect(decideDraftRecovery(facts({ record: { kind: 'draft', meta: { ...pending, draftSeq: 8 } }, current: { ...current, occupied: false } }))).toEqual({ kind: 'copy', reason: 'conflict' })
  })

  it.each([false, true])('缺少来源且只多一版，需要完整事实或等待占用者（occupied=%s）', (occupied) => {
    expect(decideDraftRecovery(facts({ record: { kind: 'draft', meta: { ...pending, draftSeq: 8 } }, current: { revision: 13, source: undefined, occupied } }))).toEqual(occupied ? { kind: 'held' } : { kind: 'preserve', reason: 'server' })
  })

  it('来源确实是旧在途请求，但现在别人持有编辑权，仍等待', () => {
    expect(decideDraftRecovery(facts({ record: { kind: 'draft', meta: { ...pending, draftSeq: 8 } }, current: { revision: 13, source: { clientInstanceId: pending.inFlight!.clientInstanceId, localSeq: 7 }, occupied: true } }))).toEqual({ kind: 'held' })
  })

  it('没有在途请求，来源字段不能凭空构造自己的快进', () => {
    expect(decideDraftRecovery(facts({ current: { revision: 13, source: { clientInstanceId: pending.writtenBy, localSeq: 7 }, occupied: false } }))).toEqual({ kind: 'copy', reason: 'conflict' })
  })
})
