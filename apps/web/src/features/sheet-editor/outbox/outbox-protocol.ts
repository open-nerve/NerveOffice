// 发件箱 Worker 的消息（M4-P1 设计 §3.2、§3.4.8）：主线程的客户端（outbox-worker-client.ts）与 Worker 里的处理（outbox-worker-handler.ts）共用。
// - 每个请求带协议版本与 id，回复按 id 对应；DraftWriter 的每个方法一种请求，另有 hello（握手；keepAlive 只有测试构建能关，DEF-011 的对照）。
// - 两边都把收到的当作 unknown，经这里的手写守卫逐项核对、交回只带已知字段的一份再用。不引用 zod：Worker 也引用这个文件，
//   门禁按全部产物数 zod 的 JIT 探测，Worker 里再打进一份就超限。字节、密钥按内部的类型标签认，不用 instanceof（别的 realm）。
// - 本机密钥两种交法（KeyTransfer）：不可导出的 CryptoKey 经结构化克隆交过去（设计 §3.4.8，真实 Safari 上由 S1 复核）；不行就改为
//   原始字节转移给 Worker、在 Worker 里导入、用完清零。Worker 两种都认，改交法只动客户端的 keyTransferOf 一处
import type { OutboxUnavailableReason } from '../../../shared/outbox/database.ts'
import type { MirrorStatus } from '../../../shared/outbox/draft-mirror.ts'
import type { DraftKey, Fields, InFlightSave } from '../../../shared/outbox/draft-record.ts'
import type { FenceReason } from '../../../shared/outbox/draft-store.ts'
import type { CaptureToWrite, CaptureWritten, ClearNoticeResult, ConfirmResult, DedupeKey, DraftRead, KeyChange, MirroredDocumentsResult, NoticesResult, OpenedRecord, ReconcileResult, RegisterResult, RemoveResult, ResealResult, WriterProblem } from '../../../shared/outbox/draft-writer.ts'
import type { FailureDescription } from '../../../shared/outbox/failure.ts'
import type { WriterIdentity } from '../../../shared/outbox/writer-fence.ts'
import { isFields, isText, isWhole, readContentFormat, readDraftMeta, readInFlight } from '../../../shared/outbox/draft-record.ts'
import { readRecoveryNotice } from '../../../shared/outbox/recovery-notice.ts'

export const OUTBOX_PROTOCOL_VERSION = 1

/** AES-256 的密钥字节数（契约的 LOCAL_KEY_BYTES 在带 zod 的模块里，Worker 不引用它） */
export const RAW_KEY_BYTES = 32

/** 交给 Worker 的本机密钥：不可导出的 CryptoKey（结构化克隆），或者原始字节（转移；Worker 里导入、用完清零） */
export type KeyTransfer
  = | { readonly form: 'crypto-key', readonly version: number, readonly key: CryptoKey }
    | { readonly form: 'raw', readonly version: number, readonly bytes: Uint8Array<ArrayBuffer> }

/** 主线程 → Worker：DraftWriter 的每个方法一种请求，另有握手 */
export type OutboxCall
  = | { readonly type: 'hello', readonly keepAlive: boolean }
    | { readonly type: 'register', readonly draft: DraftKey, readonly writer: WriterIdentity, readonly force: boolean }
    | { readonly type: 'write', readonly capture: CaptureToWrite }
    | { readonly type: 'mark-in-flight', readonly draft: DraftKey, readonly writer: WriterIdentity, readonly inFlight: InFlightSave }
    | { readonly type: 'confirm', readonly draft: DraftKey, readonly writer: WriterIdentity, readonly confirmedSeq: number, readonly revision: number }
    | { readonly type: 'read', readonly draft: DraftKey }
    | { readonly type: 'remove', readonly draft: DraftKey, readonly expectedSeq: number | null }
    | { readonly type: 'set-key', readonly key: KeyTransfer | null }
    | { readonly type: 'seed-digest', readonly draft: DraftKey, readonly seed: DedupeKey | null }
    | { readonly type: 'release', readonly draft: DraftKey }
    | { readonly type: 'mirrored-documents', readonly userId: string }
    | { readonly type: 'reconcile', readonly draft: DraftKey }
    | { readonly type: 'notices', readonly userId: string }
    | { readonly type: 'clear-notice', readonly draft: DraftKey, readonly expectedAt: number | null }

export type OutboxCallType = OutboxCall['type']

export type OutboxRequest = OutboxCall & { readonly v: typeof OUTBOX_PROTOCOL_VERSION, readonly id: number }

/** 握手的结果 */
export type HelloResult = { readonly kind: 'ready' } | { readonly kind: 'failed', readonly error: FailureDescription }

/** 设定去重起点的结果 */
export type SeedResult = { readonly kind: 'seeded' } | { readonly kind: 'failed', readonly error: FailureDescription }

/** 放开镜像的句柄的结果 */
export type ReleaseResult = { readonly kind: 'released' } | { readonly kind: 'failed', readonly error: FailureDescription }

/** 每种请求的结果（与 DraftWriter 各方法交回的相同） */
export interface OutboxResults {
  readonly 'hello': HelloResult
  readonly 'register': RegisterResult
  readonly 'write': CaptureWritten
  readonly 'mark-in-flight': ResealResult
  readonly 'confirm': ConfirmResult
  readonly 'read': DraftRead
  readonly 'remove': RemoveResult
  readonly 'set-key': KeyChange
  readonly 'seed-digest': SeedResult
  readonly 'release': ReleaseResult
  readonly 'mirrored-documents': MirroredDocumentsResult
  readonly 'reconcile': ReconcileResult
  readonly 'notices': NoticesResult
  readonly 'clear-notice': ClearNoticeResult
}

/** Worker → 主线程：按 id 的回复。ok: false 是这个请求没能处理（认不出、管道之外出的错）；操作本身的失败在 result 里 */
export type OutboxReply
  = | { readonly v: typeof OUTBOX_PROTOCOL_VERSION, readonly id: number, readonly ok: true, readonly result: unknown }
    | { readonly v: typeof OUTBOX_PROTOCOL_VERSION, readonly id: number, readonly ok: false, readonly error: FailureDescription }

/** Worker 收到了解不开、认不出 id 的消息（messageerror）：没有 id 可回，告诉客户端——它把 Worker 当作坏了，不等看门狗 */
export interface OutboxNotice {
  readonly v: typeof OUTBOX_PROTOCOL_VERSION
  readonly notice: 'unreadable-message'
}

export type OutboxMessage = OutboxReply | OutboxNotice

/** 枚举的全部取值：类型上要求列全（少了一个，赋值就过不了） */
const UNAVAILABLE_REASONS: Readonly<Record<OutboxUnavailableReason, true>> = { 'unsupported': true, 'denied': true, 'newer-version': true, 'blocked': true }
const FENCE_REASONS: Readonly<Record<FenceReason, true>> = { 'not-writer': true, 'stale-seq': true, 'foreign-draft': true, 'changed': true }
const MIRROR_SKIPS: Readonly<Record<'busy' | 'quota' | 'unsupported', true>> = { busy: true, quota: true, unsupported: true }

function isOneOf<T extends string>(table: Readonly<Record<T, true>>, value: unknown): value is T {
  return typeof value === 'string' && Object.hasOwn(table, value)
}

/** Uint8Array（任何一段视图），缓冲是普通的 ArrayBuffer（共享的不认）；按内部的类型标签认 */
function isBytes(value: unknown): value is Uint8Array<ArrayBuffer> {
  return Object.prototype.toString.call(value) === '[object Uint8Array]' && Object.prototype.toString.call((value as Uint8Array).buffer) === '[object ArrayBuffer]'
}

/** AES-GCM 的 CryptoKey */
function isAesKey(value: unknown): value is CryptoKey {
  return Object.prototype.toString.call(value) === '[object CryptoKey]' && (value as CryptoKey).algorithm.name === 'AES-GCM'
}

function readDraftKey(value: unknown): DraftKey | undefined {
  if (!isFields(value) || !isText(value.userId) || !isText(value.documentId))
    return undefined
  return { userId: value.userId, documentId: value.documentId }
}

function readWriter(value: unknown): WriterIdentity | undefined {
  if (!isFields(value) || !isWhole(value.writeEpoch, 1) || !isText(value.writerId))
    return undefined
  return { writeEpoch: value.writeEpoch, writerId: value.writerId }
}

function readFailure(value: unknown): FailureDescription | undefined {
  if (!isFields(value) || typeof value.name !== 'string' || typeof value.message !== 'string')
    return undefined
  return { name: value.name, message: value.message }
}

function readCapture(value: unknown): CaptureToWrite | undefined {
  if (!isFields(value))
    return undefined
  const { draftSeq, baseRevision, writtenBy, formulasPending, bytes, dedupe, adoptSeq } = value
  const key = readDraftKey(value.key)
  const writer = readWriter(value.writer)
  const format = readContentFormat(value.format)
  const inFlight = readInFlight(value.inFlight)
  if (key === undefined || writer === undefined || !isWhole(draftSeq, 1) || !isWhole(baseRevision, 1) || !isText(writtenBy) || format === undefined)
    return undefined
  if (typeof formulasPending !== 'boolean' || inFlight === undefined || !isBytes(bytes) || typeof dedupe !== 'boolean' || (adoptSeq !== undefined && !isWhole(adoptSeq, 1)))
    return undefined
  return { key, writer, draftSeq, baseRevision, writtenBy, format, formulasPending, inFlight, bytes, dedupe, ...(adoptSeq === undefined ? {} : { adoptSeq }) }
}

/** 去重的起点：null（清空）照样交回 null；形状不对时为 undefined */
function readSeed(value: unknown): DedupeKey | null | undefined {
  if (value === null)
    return null
  if (!isFields(value) || !isText(value.digest) || typeof value.formulasPending !== 'boolean')
    return undefined
  return { digest: value.digest, formulasPending: value.formulasPending }
}

/** 交来的密钥：null（丢掉密钥）照样交回 null；形状不对时为 undefined */
function readKeyTransfer(value: unknown): KeyTransfer | null | undefined {
  if (value === null)
    return null
  if (!isFields(value) || !isWhole(value.version, 1))
    return undefined
  const { form, version, key, bytes } = value
  if (form === 'crypto-key' && isAesKey(key))
    return { form, version, key }
  if (form === 'raw' && isBytes(bytes) && bytes.byteLength === RAW_KEY_BYTES)
    return { form, version, bytes }
  return undefined
}

/** 请求的种类与它的参数（不含 v 与 id）；认不出时为 undefined */
function readCall(data: Fields): OutboxCall | undefined {
  const draft = readDraftKey(data.draft)
  const writer = readWriter(data.writer)
  switch (data.type) {
    case 'hello':
      return typeof data.keepAlive === 'boolean' ? { type: 'hello', keepAlive: data.keepAlive } : undefined
    case 'register':
      return draft !== undefined && writer !== undefined && typeof data.force === 'boolean' ? { type: 'register', draft, writer, force: data.force } : undefined
    case 'write': {
      const capture = readCapture(data.capture)
      return capture === undefined ? undefined : { type: 'write', capture }
    }
    case 'mark-in-flight': {
      const inFlight = readInFlight(data.inFlight)
      return draft !== undefined && writer !== undefined && inFlight !== undefined && inFlight !== null ? { type: 'mark-in-flight', draft, writer, inFlight } : undefined
    }
    case 'confirm':
      return draft !== undefined && writer !== undefined && isWhole(data.confirmedSeq, 1) && isWhole(data.revision, 1)
        ? { type: 'confirm', draft, writer, confirmedSeq: data.confirmedSeq, revision: data.revision }
        : undefined
    case 'read':
      return draft === undefined ? undefined : { type: 'read', draft }
    case 'remove': {
      const { expectedSeq } = data
      return draft !== undefined && (expectedSeq === null || isWhole(expectedSeq, 1)) ? { type: 'remove', draft, expectedSeq } : undefined
    }
    case 'set-key': {
      const key = readKeyTransfer(data.key)
      return key === undefined ? undefined : { type: 'set-key', key }
    }
    case 'seed-digest': {
      const seed = readSeed(data.seed)
      return draft !== undefined && seed !== undefined ? { type: 'seed-digest', draft, seed } : undefined
    }
    case 'release':
      return draft === undefined ? undefined : { type: 'release', draft }
    case 'mirrored-documents':
      return isText(data.userId) ? { type: 'mirrored-documents', userId: data.userId } : undefined
    case 'reconcile':
      return draft === undefined ? undefined : { type: 'reconcile', draft }
    case 'notices':
      return isText(data.userId) ? { type: 'notices', userId: data.userId } : undefined
    case 'clear-notice': {
      const { expectedAt } = data
      return draft !== undefined && (expectedAt === null || isWhole(expectedAt, 0)) ? { type: 'clear-notice', draft, expectedAt } : undefined
    }
    default:
      return undefined
  }
}

export type ReadRequest
  = | { readonly kind: 'request', readonly request: OutboxRequest }
  /** 认不出：认得出 id 时带上（Worker 据此回一个 ok: false，那个请求随之结束） */
    | { readonly kind: 'invalid', readonly id: number | undefined }

/** Worker 一侧：认主线程发来的请求 */
export function readOutboxRequest(data: unknown): ReadRequest {
  if (!isFields(data))
    return { kind: 'invalid', id: undefined }
  const id = isWhole(data.id, 0) ? data.id : undefined
  if (data.v !== OUTBOX_PROTOCOL_VERSION || id === undefined)
    return { kind: 'invalid', id }
  const call = readCall(data)
  return call === undefined ? { kind: 'invalid', id } : { kind: 'request', request: { ...call, v: OUTBOX_PROTOCOL_VERSION, id } }
}

/** 主线程一侧：认 Worker 发来的消息（结果按请求的种类另由 readOutboxResult 核对）；认不出时为 null */
export function readOutboxMessage(data: unknown): OutboxMessage | null {
  if (!isFields(data) || data.v !== OUTBOX_PROTOCOL_VERSION)
    return null
  if ('notice' in data)
    return data.notice === 'unreadable-message' ? { v: OUTBOX_PROTOCOL_VERSION, notice: 'unreadable-message' } : null
  if (!isWhole(data.id, 0))
    return null
  if (data.ok === true)
    return { v: OUTBOX_PROTOCOL_VERSION, id: data.id, ok: true, result: data.result }
  const error = readFailure(data.error)
  return data.ok === false && error !== undefined ? { v: OUTBOX_PROTOCOL_VERSION, id: data.id, ok: false, error } : null
}

// ---- 结果的核对（主线程一侧）：每种只交回约定的字段 ----

/** OPFS 的镜像写成了没有（§3.8） */
function readMirrorStatus(value: unknown): MirrorStatus | null {
  if (!isFields(value))
    return null
  if (value.kind === 'mirrored' || value.kind === 'off')
    return { kind: value.kind }
  if (value.kind !== 'not-mirrored')
    return null
  if (isOneOf(MIRROR_SKIPS, value.reason))
    return { kind: 'not-mirrored', reason: value.reason }
  const error = value.reason === 'failed' ? readFailure(value.error) : undefined
  return error === undefined ? null : { kind: 'not-mirrored', reason: 'failed', error }
}

function readProblem(value: Fields): WriterProblem | null {
  switch (value.kind) {
    case 'quota':
      return { kind: 'quota' }
    case 'unavailable':
      return isOneOf(UNAVAILABLE_REASONS, value.reason) ? { kind: 'unavailable', reason: value.reason } : null
    case 'failed': {
      const error = readFailure(value.error)
      return error === undefined ? null : { kind: 'failed', error }
    }
    default:
      return null
  }
}

function readOpenedRecord(value: Fields): OpenedRecord | null {
  if (value.kind === 'newer-format')
    return isWhole(value.recordVersion, 1) ? { kind: 'newer-format', recordVersion: value.recordVersion } : null
  if (value.kind === 'malformed')
    return { kind: 'malformed' }
  const meta = readDraftMeta(value.meta)
  if (meta === undefined)
    return null
  switch (value.kind) {
    case 'draft':
      return isBytes(value.gzip) ? { kind: 'draft', meta, gzip: value.gzip } : null
    case 'unreadable':
      return value.reason === 'revoked' || value.reason === 'stale-key' || value.reason === 'corrupted' ? { kind: 'unreadable', meta, reason: value.reason } : null
    case 'no-key':
      return { kind: 'no-key', meta }
    default:
      return null
  }
}

function readHelloResult(value: Fields): HelloResult | null {
  if (value.kind === 'ready')
    return { kind: 'ready' }
  const error = value.kind === 'failed' ? readFailure(value.error) : undefined
  return error === undefined ? null : { kind: 'failed', error }
}

function readRegisterResult(value: Fields): RegisterResult | null {
  switch (value.kind) {
    case 'registered': {
      const mirror = readMirrorStatus(value.mirror)
      if (!isWhole(value.lastDraftSeq, 0) || mirror === null)
        return null
      if (value.existing === undefined)
        return { kind: 'registered', lastDraftSeq: value.lastDraftSeq, existing: undefined, mirror }
      const existing = isFields(value.existing) ? readOpenedRecord(value.existing) : null
      return existing === null ? null : { kind: 'registered', lastDraftSeq: value.lastDraftSeq, existing, mirror }
    }
    case 'superseded':
      return isWhole(value.currentEpoch, 1) && typeof value.sameEpoch === 'boolean' ? { kind: 'superseded', currentEpoch: value.currentEpoch, sameEpoch: value.sameEpoch } : null
    default:
      return readProblem(value)
  }
}

function readCaptureWritten(value: Fields): CaptureWritten | null {
  const { kind, gzip } = value
  if (kind === 'unchanged')
    return isText(value.digest) ? { kind, digest: value.digest } : null
  if (kind === 'failed') {
    const error = readFailure(value.error)
    return error !== undefined && (gzip === null || isBytes(gzip)) ? { kind, error, gzip } : null
  }
  if (!isBytes(gzip))
    return null
  switch (kind) {
    case 'written': {
      const mirror = readMirrorStatus(value.mirror)
      return isText(value.digest) && mirror !== null ? { kind, gzip, digest: value.digest, mirror } : null
    }
    case 'fenced':
      return isOneOf(FENCE_REASONS, value.reason) ? { kind, reason: value.reason, gzip } : null
    case 'no-key':
    case 'quota':
      return { kind, gzip }
    case 'unavailable':
      return isOneOf(UNAVAILABLE_REASONS, value.reason) ? { kind, reason: value.reason, gzip } : null
    default:
      return null
  }
}

function readResealResult(value: Fields): ResealResult | null {
  switch (value.kind) {
    case 'resealed':
    case 'absent':
    case 'no-key':
      return { kind: value.kind }
    case 'fenced':
      return value.reason === 'not-writer' || value.reason === 'changed' ? { kind: 'fenced', reason: value.reason } : null
    default:
      return readProblem(value)
  }
}

function readConfirmResult(value: Fields): ConfirmResult | null {
  switch (value.kind) {
    case 'deleted':
    case 'rebased':
    case 'absent':
    case 'no-key':
      return { kind: value.kind }
    case 'fenced':
      return value.reason === 'not-writer' || value.reason === 'foreign-draft' ? { kind: 'fenced', reason: value.reason } : null
    default:
      return readProblem(value)
  }
}

function readDraftRead(value: Fields): DraftRead | null {
  if (value.kind === 'absent')
    return { kind: 'absent' }
  return readOpenedRecord(value) ?? readProblem(value)
}

function readRemoveResult(value: Fields): RemoveResult | null {
  switch (value.kind) {
    case 'removed':
    case 'changed':
    case 'absent':
      return { kind: value.kind }
    default:
      return readProblem(value)
  }
}

function readKeyChange(value: Fields): KeyChange | null {
  if (value.kind === 'key-set') {
    const listed = Array.isArray(value.notResealed) ? (value.notResealed as readonly unknown[]).map(readDraftKey) : undefined
    return listed === undefined || listed.includes(undefined) ? null : { kind: 'key-set', notResealed: listed.filter(key => key !== undefined) }
  }
  const error = value.kind === 'failed' ? readFailure(value.error) : undefined
  return error === undefined ? null : { kind: 'failed', error }
}

function readSeedResult(value: Fields): SeedResult | null {
  if (value.kind === 'seeded')
    return { kind: 'seeded' }
  const error = value.kind === 'failed' ? readFailure(value.error) : undefined
  return error === undefined ? null : { kind: 'failed', error }
}

function readFailed(value: Fields): { readonly kind: 'failed', readonly error: FailureDescription } | null {
  const error = value.kind === 'failed' ? readFailure(value.error) : undefined
  return error === undefined ? null : { kind: 'failed', error }
}

function readReleaseResult(value: Fields): ReleaseResult | null {
  return value.kind === 'released' ? { kind: 'released' } : readFailed(value)
}

function readMirroredDocumentsResult(value: Fields): MirroredDocumentsResult | null {
  if (value.kind !== 'listed')
    return readFailed(value)
  const ids = Array.isArray(value.documentIds) ? value.documentIds as readonly unknown[] : undefined
  return ids === undefined || !ids.every(isText) ? null : { kind: 'listed', documentIds: ids.filter(isText) }
}

function readReconcileResult(value: Fields): ReconcileResult | null {
  return value.kind === 'reconciled' ? { kind: 'reconciled' } : readProblem(value)
}

function readNoticesResult(value: Fields): NoticesResult | null {
  if (value.kind !== 'notices')
    return readProblem(value)
  const notices = Array.isArray(value.notices) ? (value.notices as readonly unknown[]).map(readRecoveryNotice) : undefined
  return notices === undefined || notices.includes(undefined) ? null : { kind: 'notices', notices: notices.filter(notice => notice !== undefined) }
}

function readClearNoticeResult(value: Fields): ClearNoticeResult | null {
  switch (value.kind) {
    case 'cleared':
    case 'changed':
    case 'absent':
      return { kind: value.kind }
    default:
      return readProblem(value)
  }
}

const RESULT_READERS: { readonly [T in OutboxCallType]: (value: Fields) => OutboxResults[T] | null } = {
  'hello': readHelloResult,
  'register': readRegisterResult,
  'write': readCaptureWritten,
  'mark-in-flight': readResealResult,
  'confirm': readConfirmResult,
  'read': readDraftRead,
  'remove': readRemoveResult,
  'set-key': readKeyChange,
  'seed-digest': readSeedResult,
  'release': readReleaseResult,
  'mirrored-documents': readMirroredDocumentsResult,
  'reconcile': readReconcileResult,
  'notices': readNoticesResult,
  'clear-notice': readClearNoticeResult,
}

/** 主线程一侧：按请求的种类核对 Worker 交回的结果；认不出时为 null */
export function readOutboxResult<T extends OutboxCallType>(type: T, value: unknown): OutboxResults[T] | null {
  return isFields(value) ? RESULT_READERS[type](value) : null
}

const FAILED_RESULTS: { readonly [T in OutboxCallType]: (error: FailureDescription) => OutboxResults[T] } = {
  'hello': error => ({ kind: 'failed', error }),
  'register': error => ({ kind: 'failed', error }),
  'write': error => ({ kind: 'failed', error, gzip: null }),
  'mark-in-flight': error => ({ kind: 'failed', error }),
  'confirm': error => ({ kind: 'failed', error }),
  'read': error => ({ kind: 'failed', error }),
  'remove': error => ({ kind: 'failed', error }),
  'set-key': error => ({ kind: 'failed', error }),
  'seed-digest': error => ({ kind: 'failed', error }),
  'release': error => ({ kind: 'failed', error }),
  'mirrored-documents': error => ({ kind: 'failed', error }),
  'reconcile': error => ({ kind: 'failed', error }),
  'notices': error => ({ kind: 'failed', error }),
  'clear-notice': error => ({ kind: 'failed', error }),
}

/** 这种请求没能完成时的结果（Worker 坏了、回复是 ok: false、结果认不出） */
export function failedResult<T extends OutboxCallType>(type: T, error: FailureDescription): OutboxResults[T] {
  return FAILED_RESULTS[type](error)
}
