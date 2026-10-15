import type { ObserveResult } from '../outbox/draft-writer.ts'
import type { RecoveryFacts } from './recovery-decision.ts'
import { describe, expect, it, vi } from 'vitest'
import { ApiError, NetworkError } from '../api/index.ts'
import { gzipBytes } from '../outbox/draft-codec.ts'
import { NOW, sampleMeta } from '../outbox/draft-record.test-support.ts'
import { decodeRecovery, resolveRecovery } from './resolve-recovery.ts'

const META = sampleMeta({ draftSeq: 41, baseRevision: 7, inFlight: { requestId: 'original-request', clientInstanceId: 'original-page', localSeq: 41, sentAt: NOW - 1_000 } })
const KEY = { userId: META.userId, documentId: META.documentId }
const OBSERVATION = { key: KEY, id: 'original-observation' }
const GZIP = new Uint8Array([31, 139, 8, 7])
const OBSERVED: Extract<ObserveResult, { kind: 'observed' }> = { kind: 'observed', observation: OBSERVATION, record: { kind: 'draft', meta: META, gzip: GZIP }, writer: undefined }
const FACTS: Omit<RecoveryFacts, 'record' | 'replay'> = { key: KEY, access: 'editable', online: true, current: { revision: 7, source: null, occupied: false }, pageFormat: META.format, now: NOW }
const RECEIPT = { revision: 8, savedAt: new Date(NOW).toISOString(), unchanged: false }

describe('一次原观察的恢复核对', () => {
  it('固定原请求和原 gzip 核对，确认不安装旧快照，也不修改原观察', async () => {
    const replay = vi.fn(async () => RECEIPT)
    const result = await resolveRecovery({ observed: OBSERVED, facts: FACTS, replay })
    expect(result).toMatchObject({ decision: { kind: 'confirmed', revision: 8 }, observed: OBSERVED })
    expect(replay).toHaveBeenCalledOnce()
    expect(replay).toHaveBeenCalledWith({ request: { requestId: 'original-request', clientInstanceId: 'original-page', localSeq: 41, baseRevision: 7, format: META.format, formulasPending: META.formulasPending }, writeEpoch: META.writeEpoch }, GZIP)
    expect(result.observed).toBe(OBSERVED)
    expect(GZIP).toEqual(new Uint8Array([31, 139, 8, 7]))
  })

  it('明确 EDIT_LEASE_LOST 表示核对没认出回执，按最新服务端事实继续判定', async () => {
    const replay = vi.fn(async () => {
      throw new ApiError(409, 'EDIT_LEASE_LOST', '无租约')
    })
    expect(await resolveRecovery({ observed: OBSERVED, facts: FACTS, replay })).toMatchObject({ decision: { kind: 'restore', baseRevision: 7 } })
    expect(await resolveRecovery({ observed: OBSERVED, facts: { ...FACTS, current: { revision: 9, source: null, occupied: false } }, replay })).toMatchObject({ decision: { kind: 'copy', reason: 'conflict' } })
  })

  it.each([
    new NetworkError('断网'),
    new Error('超时'),
    new ApiError(401, 'UNAUTHENTICATED', '登录失效'),
    new ApiError(403, 'PERMISSION_DENIED', '权限需要重新确认'),
    new ApiError(404, 'NOT_FOUND', '读不到'),
    new ApiError(409, 'REQUEST_ID_CONFLICT', '标识被占用'),
    new ApiError(409, 'CLIENT_OUTDATED', '页面过旧'),
    new ApiError(500, 'INTERNAL_ERROR', '失败'),
  ])('非明确租约拒绝保留原件与未知结果：%s', async (error) => {
    const replay = vi.fn(async () => {
      throw error
    })
    const result = await resolveRecovery({ observed: OBSERVED, facts: FACTS, replay })
    expect(result).toMatchObject({ decision: { kind: 'preserve', reason: 'replay' }, problem: error })
    expect(replay).toHaveBeenCalledOnce()
  })

  it.each([
    { access: 'unknown' as const },
    { online: false },
    { access: 'unreadable' as const },
  ])('身份/连接/读取资格先判定，不能先重放：%j', async (change) => {
    const replay = vi.fn(async () => RECEIPT)
    await resolveRecovery({ observed: OBSERVED, facts: { ...FACTS, ...change }, replay })
    expect(replay).not.toHaveBeenCalled()
  })

  it('本机有更新捕获时不套用旧 requestId，严格来源匹配后接续', async () => {
    const replay = vi.fn(async () => RECEIPT)
    const observed: ObserveResult = { ...OBSERVED, record: { kind: 'draft', meta: { ...META, draftSeq: 42 }, gzip: GZIP } }
    const result = await resolveRecovery({ observed, facts: { ...FACTS, current: { revision: 8, source: { clientInstanceId: 'original-page', localSeq: 41 }, occupied: false } }, replay })
    expect(result.decision).toEqual({ kind: 'restore', baseRevision: 8, formulasPending: META.formulasPending, reason: 'own-revision' })
    expect(replay).not.toHaveBeenCalled()
  })

  it('存储失败和新格式留给判定，不产生正文操作', async () => {
    const replay = vi.fn(async () => RECEIPT)
    expect(await resolveRecovery({ observed: { kind: 'quota' }, facts: FACTS, replay })).toMatchObject({ decision: { kind: 'preserve', reason: 'storage' } })
    expect(await resolveRecovery({ observed: { ...OBSERVED, record: { kind: 'newer-format', recordVersion: 99 } }, facts: FACTS, replay })).toMatchObject({ decision: { kind: 'preserve', reason: 'newer-format' } })
    expect(replay).not.toHaveBeenCalled()
  })
})

describe('恢复正文的完整解码', () => {
  it('中文与多字节文本完整解码，不解析/改写原快照', async () => {
    const snapshot = '{"name":"恢复🙂","sheets":{}}'
    const bytes = new TextEncoder().encode(snapshot)
    const gzip = await gzipBytes(bytes)
    expect(await decodeRecovery({ kind: 'draft', meta: { ...META, rawBytes: bytes.length }, gzip })).toEqual({ kind: 'decoded', snapshot })
  })

  it.each(['gzip', 'utf8', 'size', 'limit'] as const)('解压/UTF-8/原长度/上限不符按损坏处理：%s', async (change) => {
    const raw = change === 'utf8' ? new Uint8Array([0xC0, 0xAF]) : new TextEncoder().encode('完整快照')
    const gzip = change === 'gzip' ? new Uint8Array([1, 2]) : await gzipBytes(raw)
    const rawBytes = change === 'size' ? 1 : change === 'limit' ? Number.MAX_SAFE_INTEGER : raw.length
    expect(await decodeRecovery({ kind: 'draft', meta: { ...META, rawBytes }, gzip })).toEqual({ kind: 'corrupted' })
  })
})
