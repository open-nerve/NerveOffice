import type { CaptureToWrite } from '../../../shared/outbox/draft-writer.ts'
import type { OutboxCall, OutboxCallType, OutboxResults } from './outbox-protocol.ts'
import { describe, expect, it } from 'vitest'
import { CLIENT_INSTANCE_ID, DOCUMENT_ID, sampleMeta, USER_ID, WRITER_ID } from '../../../shared/outbox/draft-record.test-support.ts'
import { failedResult, OUTBOX_PROTOCOL_VERSION, RAW_KEY_BYTES, readOutboxMessage, readOutboxRequest, readOutboxResult } from './outbox-protocol.ts'

const DRAFT = { userId: USER_ID, documentId: DOCUMENT_ID }
const ME = { writeEpoch: 3, writerId: WRITER_ID }
const IN_FLIGHT = { requestId: '0199b0c4-7d3e-7a3b-9c4e-0000000e0001', clientInstanceId: CLIENT_INSTANCE_ID, localSeq: 7, sentAt: 1_000 }
const FAILURE = { name: 'UnknownError', message: '磁盘出错' }

function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text)
}

function capture(overrides: Partial<CaptureToWrite> = {}): CaptureToWrite {
  return {
    key: DRAFT,
    writer: ME,
    draftSeq: 8,
    baseRevision: 12,
    writtenBy: CLIENT_INSTANCE_ID,
    format: sampleMeta().format,
    formulasPending: false,
    inFlight: IN_FLIGHT,
    bytes: utf8('{"a":1}'),
    dedupe: true,
    ...overrides,
  }
}

async function aesKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new Uint8Array(RAW_KEY_BYTES), 'AES-GCM', false, ['encrypt', 'decrypt'])
}

/** 结构化克隆（与 postMessage 一样）之后的样子：字节属于另一个 realm，按值比较 */
function cloned<T>(value: T): T {
  return structuredClone(value)
}

/** 每种请求一个合法的样例（set-key 的两种交法另测） */
function sampleCalls(): readonly OutboxCall[] {
  return [
    { type: 'hello', keepAlive: true },
    { type: 'hello', keepAlive: false },
    { type: 'register', draft: DRAFT, writer: ME, force: false },
    { type: 'write', capture: capture() },
    { type: 'write', capture: capture({ inFlight: null, adoptSeq: 6, dedupe: false, formulasPending: true }) },
    { type: 'mark-in-flight', draft: DRAFT, writer: ME, inFlight: IN_FLIGHT },
    { type: 'confirm', draft: DRAFT, writer: ME, confirmedSeq: 7, revision: 13 },
    { type: 'read', draft: DRAFT },
    { type: 'remove', draft: DRAFT, expectedSeq: 7 },
    { type: 'remove', draft: DRAFT, expectedSeq: null },
    { type: 'set-key', key: null },
    { type: 'seed-digest', draft: DRAFT, seed: { digest: 'ab'.repeat(32), formulasPending: true } },
    { type: 'seed-digest', draft: DRAFT, seed: null },
    { type: 'release', draft: DRAFT },
    { type: 'mirrored-documents', userId: USER_ID },
    { type: 'reconcile', draft: DRAFT },
    { type: 'notices', userId: USER_ID },
    { type: 'clear-notice', draft: DRAFT, expectedAt: null },
    { type: 'clear-notice', draft: DRAFT, expectedAt: 0 },
    { type: 'clear-notice', draft: DRAFT, expectedAt: 1_700_000_000_000 },
  ]
}

/** 字节换成普通数组，便于按值比较（toEqual 对不同 realm 的 Uint8Array 不认作相等） */
function plain(value: unknown): unknown {
  if (Object.prototype.toString.call(value) === '[object Uint8Array]')
    return { bytes: Array.from(value as Uint8Array) }
  if (Array.isArray(value))
    return value.map(plain)
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(Object.entries(value).map(([name, field]) => [name, plain(field)]))
  return value
}

describe('请求（Worker 一侧认）：带协议版本与 id，参数逐项核对', () => {
  it('每种请求经结构化克隆之后照样认得出，交回只带已知字段的一份', () => {
    for (const call of sampleCalls()) {
      const read = readOutboxRequest(cloned({ ...call, v: OUTBOX_PROTOCOL_VERSION, id: 7, extra: 'ignored' }))
      expect(plain(read), call.type).toEqual(plain({ kind: 'request', request: { ...call, v: OUTBOX_PROTOCOL_VERSION, id: 7 } }))
    }
  })

  it('写入的字节原样交出（转移进来的那一份，不拷贝）', () => {
    const bytes = utf8('payload')
    const read = readOutboxRequest({ type: 'write', capture: capture({ bytes }), v: OUTBOX_PROTOCOL_VERSION, id: 1 })
    expect(read.kind === 'request' && read.request.type === 'write' && read.request.capture.bytes).toBe(bytes)
  })

  it('不是对象、协议版本不对、没有合法的 id：invalid；认得出 id 时带上（Worker 据此回 ok: false）', () => {
    for (const data of [null, undefined, 'hello', 7, [], [{ type: 'hello' }]])
      expect(readOutboxRequest(data), String(data)).toEqual({ kind: 'invalid', id: undefined })
    const hello = { type: 'hello', keepAlive: true }
    expect(readOutboxRequest({ ...hello, v: 2, id: 3 })).toEqual({ kind: 'invalid', id: 3 })
    expect(readOutboxRequest({ ...hello, id: 3 })).toEqual({ kind: 'invalid', id: 3 })
    for (const id of [undefined, -1, 1.5, '3', null])
      expect(readOutboxRequest({ ...hello, v: OUTBOX_PROTOCOL_VERSION, id }), String(id)).toEqual({ kind: 'invalid', id: undefined })
  })

  it('种类认不出、参数不对：invalid，带上 id', () => {
    const broken: readonly Record<string, unknown>[] = [
      { type: 'unknown' },
      { type: 'hello' },
      { type: 'hello', keepAlive: 'yes' },
      { type: 'register', draft: DRAFT, writer: ME },
      { type: 'register', draft: { userId: USER_ID }, writer: ME, force: false },
      { type: 'register', draft: DRAFT, writer: { writeEpoch: 0, writerId: WRITER_ID }, force: false },
      { type: 'register', draft: DRAFT, writer: { writeEpoch: 3, writerId: '' }, force: false },
      { type: 'write' },
      { type: 'mark-in-flight', draft: DRAFT, writer: ME, inFlight: null },
      { type: 'mark-in-flight', draft: DRAFT, writer: ME, inFlight: { ...IN_FLIGHT, localSeq: 0 } },
      { type: 'confirm', draft: DRAFT, writer: ME, confirmedSeq: 0, revision: 13 },
      { type: 'confirm', draft: DRAFT, writer: ME, confirmedSeq: 7, revision: 1.5 },
      { type: 'read', draft: null },
      { type: 'remove', draft: DRAFT },
      { type: 'remove', draft: DRAFT, expectedSeq: 0 },
      { type: 'set-key' },
      { type: 'set-key', key: { form: 'other', version: 1 } },
      { type: 'seed-digest', draft: DRAFT },
      { type: 'seed-digest', draft: DRAFT, seed: { digest: '', formulasPending: false } },
      { type: 'seed-digest', draft: DRAFT, seed: { digest: 'ab' } },
      { type: 'release' },
      { type: 'release', draft: { documentId: DOCUMENT_ID } },
      { type: 'mirrored-documents' },
      { type: 'mirrored-documents', userId: '' },
      { type: 'reconcile' },
      { type: 'reconcile', userId: USER_ID },
      { type: 'reconcile', draft: { userId: USER_ID } },
      { type: 'notices' },
      { type: 'notices', userId: 7 },
      { type: 'clear-notice', draft: DRAFT },
      { type: 'clear-notice', draft: DRAFT, expectedAt: -1 },
      { type: 'clear-notice', draft: DRAFT, expectedAt: 1.5 },
      { type: 'clear-notice', expectedAt: null },
      { type: 'take-events' },
    ]
    for (const call of broken)
      expect(readOutboxRequest({ ...call, v: OUTBOX_PROTOCOL_VERSION, id: 9 }), JSON.stringify(call)).toEqual({ kind: 'invalid', id: 9 })
  })

  it('写入的每一项都核对', () => {
    const notSafe = 2 ** 53
    const badFields: Readonly<Record<string, readonly unknown[]>> = {
      key: [null, { userId: USER_ID, documentId: '' }],
      writer: [null, { writeEpoch: 1.5, writerId: WRITER_ID }],
      draftSeq: [0, -1, 1.5, '8', notSafe],
      baseRevision: [0, '12', null],
      writtenBy: ['', 1],
      format: [null, { ...sampleMeta().format, formatVersion: 0 }],
      formulasPending: ['false', 0, undefined],
      inFlight: [undefined, {}, { ...IN_FLIGHT, sentAt: -1 }],
      bytes: [null, 'bytes', [1, 2], new ArrayBuffer(4), new Uint16Array(2), new Uint8Array(new SharedArrayBuffer(4))],
      dedupe: [undefined, 'true'],
      adoptSeq: [0, 1.5, null, '6'],
    }
    expect(Object.keys(badFields).sort()).toEqual([...Object.keys(capture()), 'adoptSeq'].sort())
    for (const [field, values] of Object.entries(badFields)) {
      for (const value of values) {
        const call = { type: 'write', capture: { ...capture(), [field]: value }, v: OUTBOX_PROTOCOL_VERSION, id: 4 }
        expect(readOutboxRequest(call), `${field}: ${String(value)}`).toEqual({ kind: 'invalid', id: 4 })
      }
    }
  })

  it('交密钥：AES-GCM 的 CryptoKey（经结构化克隆）；恰好 32 字节的原始字节；null 是丢掉密钥', async () => {
    const key = await aesKey()
    const viaKey = readOutboxRequest(cloned({ type: 'set-key', key: { form: 'crypto-key', version: 2, key }, v: OUTBOX_PROTOCOL_VERSION, id: 1 }))
    expect(viaKey.kind === 'request' && viaKey.request.type === 'set-key' && viaKey.request.key).toMatchObject({ form: 'crypto-key', version: 2 })
    expect(viaKey.kind === 'request' && viaKey.request.type === 'set-key' && viaKey.request.key?.form === 'crypto-key' && viaKey.request.key.key.algorithm.name).toBe('AES-GCM')
    const raw = new Uint8Array(RAW_KEY_BYTES).fill(7)
    const viaRaw = readOutboxRequest({ type: 'set-key', key: { form: 'raw', version: 3, bytes: raw }, v: OUTBOX_PROTOCOL_VERSION, id: 2 })
    expect(viaRaw).toEqual({ kind: 'request', request: { type: 'set-key', key: { form: 'raw', version: 3, bytes: raw }, v: OUTBOX_PROTOCOL_VERSION, id: 2 } })
    const hmac = await crypto.subtle.importKey('raw', new Uint8Array(32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const broken: readonly unknown[] = [
      { form: 'crypto-key', version: 2, key: hmac },
      { form: 'crypto-key', version: 2, key: { algorithm: { name: 'AES-GCM' } } },
      { form: 'crypto-key', version: 0, key },
      { form: 'raw', version: 3, bytes: new Uint8Array(RAW_KEY_BYTES - 1) },
      { form: 'raw', version: 3, bytes: Array.from({ length: RAW_KEY_BYTES }).fill(0) },
      { form: 'raw', version: 3, key },
    ]
    for (const transfer of broken)
      expect(readOutboxRequest({ type: 'set-key', key: transfer, v: OUTBOX_PROTOCOL_VERSION, id: 5 })).toEqual({ kind: 'invalid', id: 5 })
  })
})

describe('Worker 发来的消息（主线程一侧认）', () => {
  it('回复：ok 与结果（结果另按种类核对）、失败与名字和消息；通知：解不开的消息', () => {
    expect(readOutboxMessage({ v: OUTBOX_PROTOCOL_VERSION, id: 3, ok: true, result: { kind: 'ready' }, extra: 1 })).toEqual({ v: OUTBOX_PROTOCOL_VERSION, id: 3, ok: true, result: { kind: 'ready' } })
    expect(readOutboxMessage({ v: OUTBOX_PROTOCOL_VERSION, id: 0, ok: false, error: { ...FAILURE, stack: 'x' } })).toEqual({ v: OUTBOX_PROTOCOL_VERSION, id: 0, ok: false, error: FAILURE })
    expect(readOutboxMessage({ v: OUTBOX_PROTOCOL_VERSION, notice: 'unreadable-message' })).toEqual({ v: OUTBOX_PROTOCOL_VERSION, notice: 'unreadable-message' })
  })

  it('认不出：null', () => {
    const broken: readonly unknown[] = [
      null,
      'reply',
      { v: 2, id: 3, ok: true, result: {} },
      { id: 3, ok: true, result: {} },
      { v: OUTBOX_PROTOCOL_VERSION, ok: true, result: {} },
      { v: OUTBOX_PROTOCOL_VERSION, id: -1, ok: true, result: {} },
      { v: OUTBOX_PROTOCOL_VERSION, id: 3, ok: 'yes', result: {} },
      { v: OUTBOX_PROTOCOL_VERSION, id: 3, result: {} },
      { v: OUTBOX_PROTOCOL_VERSION, id: 3, ok: false },
      { v: OUTBOX_PROTOCOL_VERSION, id: 3, ok: false, error: { name: 1, message: 'x' } },
      { v: OUTBOX_PROTOCOL_VERSION, notice: 'other' },
    ]
    for (const data of broken)
      expect(readOutboxMessage(data), JSON.stringify(data)).toBeNull()
  })
})

describe('结果（主线程一侧）：按请求的种类核对，只交回约定的字段', () => {
  const meta = sampleMeta()
  const gzip = (): Uint8Array<ArrayBuffer> => utf8('gzip bytes')
  const problems = [{ kind: 'quota' }, { kind: 'unavailable', reason: 'blocked' }, { kind: 'failed', error: FAILURE }] as const
  const mirrors = [
    { kind: 'mirrored' },
    { kind: 'off' },
    { kind: 'not-mirrored', reason: 'busy' },
    { kind: 'not-mirrored', reason: 'quota' },
    { kind: 'not-mirrored', reason: 'unsupported' },
    { kind: 'not-mirrored', reason: 'failed', error: FAILURE },
  ] as const
  const opened = () => [
    { kind: 'draft', meta, gzip: gzip() },
    { kind: 'unreadable', meta, reason: 'revoked' },
    { kind: 'unreadable', meta, reason: 'stale-key' },
    { kind: 'unreadable', meta, reason: 'corrupted' },
    { kind: 'no-key', meta },
    { kind: 'newer-format', recordVersion: 2 },
    { kind: 'malformed' },
  ] as const
  const valid: { readonly [T in OutboxCallType]: readonly OutboxResults[T][] } = {
    'hello': [{ kind: 'ready' }, { kind: 'failed', error: FAILURE }],
    'register': [
      { kind: 'registered', lastDraftSeq: 0, existing: undefined, mirror: { kind: 'off' } },
      ...mirrors.map(mirror => ({ kind: 'registered', lastDraftSeq: 0, existing: undefined, mirror }) as const),
      ...opened().map(existing => ({ kind: 'registered', lastDraftSeq: 6, existing, mirror: { kind: 'mirrored' } }) as const),
      { kind: 'superseded', currentEpoch: 4, sameEpoch: false },
      ...problems,
    ],
    'write': [
      ...mirrors.map(mirror => ({ kind: 'written', gzip: gzip(), digest: 'ab', mirror }) as const),
      { kind: 'unchanged', digest: 'ab' },
      { kind: 'fenced', reason: 'foreign-draft', gzip: gzip() },
      { kind: 'no-key', gzip: gzip() },
      { kind: 'quota', gzip: gzip() },
      { kind: 'unavailable', reason: 'denied', gzip: gzip() },
      { kind: 'failed', error: FAILURE, gzip: gzip() },
      { kind: 'failed', error: FAILURE, gzip: null },
    ],
    'mark-in-flight': [{ kind: 'resealed' }, { kind: 'absent' }, { kind: 'fenced', reason: 'changed' }, { kind: 'fenced', reason: 'not-writer' }, { kind: 'no-key' }, ...problems],
    'confirm': [{ kind: 'deleted' }, { kind: 'rebased' }, { kind: 'absent' }, { kind: 'fenced', reason: 'foreign-draft' }, { kind: 'no-key' }, ...problems],
    'read': [...opened(), { kind: 'absent' }, ...problems],
    'remove': [{ kind: 'removed' }, { kind: 'changed' }, { kind: 'absent' }, ...problems],
    'set-key': [{ kind: 'key-set', notResealed: [] }, { kind: 'key-set', notResealed: [DRAFT] }, { kind: 'failed', error: FAILURE }],
    'seed-digest': [{ kind: 'seeded' }, { kind: 'failed', error: FAILURE }],
    'release': [{ kind: 'released' }, { kind: 'failed', error: FAILURE }],
    'mirrored-documents': [{ kind: 'listed', documentIds: [] }, { kind: 'listed', documentIds: [DOCUMENT_ID, 'another'] }, { kind: 'failed', error: FAILURE }],
    'reconcile': [{ kind: 'reconciled' }, { kind: 'quota' }, { kind: 'unavailable', reason: 'blocked' }, { kind: 'failed', error: FAILURE }],
    'notices': [
      { kind: 'notices', notices: [] },
      { kind: 'notices', notices: [{ ...DRAFT, kind: 'restored', at: 1 }, { ...DRAFT, kind: 'lost', at: 0 }] },
      { kind: 'quota' },
      { kind: 'unavailable', reason: 'blocked' },
      { kind: 'failed', error: FAILURE },
    ],
    'clear-notice': [{ kind: 'cleared' }, { kind: 'changed' }, { kind: 'absent' }, { kind: 'quota' }, { kind: 'unavailable', reason: 'denied' }, { kind: 'failed', error: FAILURE }],
  }

  it('每种结果的每种样子都认得出（经结构化克隆，多出的字段不带出去）', () => {
    for (const [type, results] of Object.entries(valid) as [OutboxCallType, readonly unknown[]][]) {
      for (const result of results) {
        const read = readOutboxResult(type, cloned({ ...(result as object), extra: 'ignored' }))
        expect(plain(read), `${type}: ${JSON.stringify(plain(result))}`).toEqual(plain(result))
      }
    }
  })

  it('认不出的：null', () => {
    const broken: { readonly [T in OutboxCallType]: readonly unknown[] } = {
      'hello': [null, {}, { kind: 'failed' }, { kind: 'failed', error: { name: 'x' } }],
      'register': [
        { kind: 'registered', lastDraftSeq: -1, existing: undefined, mirror: { kind: 'off' } },
        { kind: 'registered', lastDraftSeq: 1, existing: undefined },
        { kind: 'registered', lastDraftSeq: 1, existing: undefined, mirror: { kind: 'other' } },
        { kind: 'registered', lastDraftSeq: 1, existing: undefined, mirror: { kind: 'other', reason: 'busy' } },
        { kind: 'registered', lastDraftSeq: 1, existing: null, mirror: { kind: 'off' } },
        { kind: 'registered', lastDraftSeq: 1, existing: { kind: 'draft', meta, gzip: 'x' } },
        { kind: 'registered', lastDraftSeq: 1, existing: { kind: 'draft', meta: { ...meta, draftSeq: 0 }, gzip: gzip() } },
        { kind: 'registered', lastDraftSeq: 1, existing: { kind: 'unreadable', meta, reason: 'other' } },
        { kind: 'registered', lastDraftSeq: 1, existing: { kind: 'newer-format', recordVersion: 0 } },
        { kind: 'superseded', currentEpoch: 0, sameEpoch: false },
        { kind: 'superseded', currentEpoch: 4 },
        { kind: 'unavailable', reason: 'gone' },
        { kind: 'failed', error: null },
        { kind: 'other' },
      ],
      'write': [
        { kind: 'written', gzip: gzip(), mirror: { kind: 'mirrored' } },
        { kind: 'written', gzip: [1], digest: 'ab', mirror: { kind: 'mirrored' } },
        { kind: 'written', gzip: gzip(), digest: 'ab' },
        { kind: 'written', gzip: gzip(), digest: 'ab', mirror: { kind: 'not-mirrored', reason: 'other' } },
        { kind: 'written', gzip: gzip(), digest: 'ab', mirror: { kind: 'not-mirrored', reason: 'failed' } },
        { kind: 'written', gzip: gzip(), digest: 'ab', mirror: null },
        { kind: 'unchanged', digest: '' },
        { kind: 'fenced', reason: 'other', gzip: gzip() },
        { kind: 'no-key' },
        { kind: 'quota', gzip: new ArrayBuffer(2) },
        { kind: 'unavailable', reason: 'denied' },
        { kind: 'failed', error: FAILURE },
        { kind: 'failed', error: FAILURE, gzip: 'x' },
        { kind: 'deleted', gzip: gzip() },
      ],
      'mark-in-flight': [{ kind: 'fenced', reason: 'stale-seq' }, { kind: 'fenced' }, { kind: 'written' }],
      'confirm': [{ kind: 'fenced', reason: 'changed' }, { kind: 'needs-rebase' }, { kind: 'resealed' }],
      'read': [{ kind: 'draft', meta }, { kind: 'no-key' }, { kind: 'registered' }, { kind: 'unavailable' }],
      'remove': [{ kind: 'deleted' }, { kind: 'failed', error: 'x' }, { kind: 'unavailable', reason: 'x' }],
      'set-key': [{ kind: 'key-set' }, { kind: 'key-set', notResealed: [{ userId: USER_ID }] }, { kind: 'key-set', notResealed: 'x' }, { kind: 'failed' }],
      'seed-digest': [{ kind: 'ready' }, { kind: 'failed', error: { message: 'x' } }],
      'release': [{ kind: 'seeded' }, { kind: 'failed' }],
      'mirrored-documents': [{ kind: 'listed' }, { kind: 'listed', documentIds: 'x' }, { kind: 'listed', documentIds: [''] }, { kind: 'listed', documentIds: [7] }, { kind: 'failed', error: null }, { kind: 'reconciled' }],
      'reconcile': [{ kind: 'reconciled-ish' }, { kind: 'unavailable', reason: 'gone' }, { kind: 'failed', error: null }, { kind: 'listed', documentIds: [] }],
      'notices': [
        { kind: 'notices' },
        { kind: 'notices', notices: 'x' },
        { kind: 'notices', notices: [{ ...DRAFT, kind: 'restored' }] },
        { kind: 'notices', notices: [{ ...DRAFT, kind: 'gone', at: 1 }] },
        { kind: 'notices', notices: [{ kind: 'lost', at: 1 }] },
        { kind: 'events', events: [] },
        { kind: 'unavailable', reason: 'gone' },
      ],
      'clear-notice': [{ kind: 'removed' }, { kind: 'failed', error: null }, { kind: 'other' }],
    }
    for (const [type, results] of Object.entries(broken) as [OutboxCallType, readonly unknown[]][]) {
      expect(readOutboxResult(type, 'not an object'), type).toBeNull()
      for (const result of results)
        expect(readOutboxResult(type, result), `${type}: ${JSON.stringify(result)}`).toBeNull()
    }
  })

  it('每种请求失败时的样子：自己的核对也认得出（写入的失败没有 gzip）', () => {
    for (const type of Object.keys(valid) as OutboxCallType[]) {
      const failed = failedResult(type, FAILURE)
      expect(failed, type).toMatchObject({ kind: 'failed', error: FAILURE })
      expect(readOutboxResult(type, failed), type).toEqual(failed)
    }
    expect(failedResult('write', FAILURE)).toEqual({ kind: 'failed', error: FAILURE, gzip: null })
  })
})
