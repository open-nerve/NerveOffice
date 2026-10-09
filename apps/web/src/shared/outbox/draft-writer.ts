// 写入管道（M4-P1 设计 §3.1、§3.2、§3.4.3–§3.4.7）：与放置无关——同一份管道在发件箱 Worker 里跑（features/sheet-editor/outbox/），
// 真实 Safari 的复核如果要求 WebKit 改在主线程放置（DEF-011），就在主线程跑；编辑器页（P2）只依赖 DraftWriter 这个接口，
// Worker 的客户端实现同一个接口。
// - 写入：去重（内容的 SHA-256 连同"公式待更新"与上次写入的相同、并且允许去重 → unchanged）→ gzip → 加密 → 交给存储。
//   先封好再交给存储：压缩与加密都在存储的事务之外（事务里 await 别的异步会让它自动提交，draft-store.ts）。
// - 同一份文档的操作排成一队、按调用的先后一个接一个（写入、重封、确认、读回、放弃）；不同文档互不等待。
// - 重封（标记在途、换密钥、确认之后改基准）：明文元数据变了就要换 AAD，按新的 AAD 与新的 IV 重新加密，再比较并交换（存储核对库里
//   仍是那一份、写入者仍是它）。管道记着本页写下的每份文档最新的一份（元数据与 gzip），手里没有时先解开库里的。
// - 跨边界不抛异常：结果一律是带 kind 的值，未知的错误折成名字与消息（跨 Worker 时原样传递）。
// - 交出去的字节归调用方：写成时交回的 gzip 是一份拷贝，管道自己留的那一份不交出去（Worker 的宿主把交回的转移给主线程）。
// - OPFS 的镜像（§3.8，只在发件箱 Worker 里给）：IndexedDB 写成（写入、重封、改基准）之后同一份记录写进镜像，删掉草稿（确认、放弃）之后
//   截断镜像，失去写入者身份时放开它的句柄；登记拿到句柄之后，库里那一份不是镜像里最新写的就补写。读与登记之前先比对镜像与库——
//   比对的策略（谁胜出、写回、截断、lost 的提示、读时交回哪一份）在 draft-recovery.ts，经 options.recovery 注入（审查 A19）。
//   镜像没写成不影响库那一份，写入、登记的结果里带上。
// Worker 也引用这个文件：不引用 zod 与带 zod 的契约，不依赖 DOM
import type { OutboxUnavailable } from './database.ts'
import type { LocalKeyHandle, UnsealFailure } from './draft-codec.ts'
import type { DraftMirror, MirrorStatus } from './draft-mirror.ts'
import type { ContentFormat, DraftKey, DraftMeta, InFlightSave, StoredDraft } from './draft-record.ts'
import type { DraftRecovery, Reconciled } from './draft-recovery.ts'
import type { DraftStore, FenceReason, StoreProblem, StoreReadOutcome } from './draft-store.ts'
import type { FailureDescription } from './failure.ts'
import type { RecoveryNotice } from './recovery-notice.ts'
import type { WriterIdentity } from './writer-fence.ts'
import { gzipBytes, openDraft, sealDraft, sha256Hex, unsealFailureOf } from './draft-codec.ts'
import { DRAFT_RECORD_VERSION, draftMetaOf } from './draft-record.ts'
import { versionsToOpen } from './draft-recovery.ts'
import { describeFailure } from './failure.ts'
import { isSameWriter } from './writer-fence.ts'

/** 存储与管道这一侧的问题：写满（整个事务回滚，原记录不变）、库用不了（调用方退化为内存实现）、未知的错误 */
export type WriterProblem
  = | { readonly kind: 'quota' }
    | OutboxUnavailable
    | { readonly kind: 'failed', readonly error: FailureDescription }

/** 手里没有本机密钥（还没取到、取不到、已丢掉）：加密与解开都做不了 */
export interface NoKey {
  readonly kind: 'no-key'
}

/** 会话内去重的键：内容字节的 SHA-256 连同"公式待更新"——内容相同、标记不同不算同一个（与 M3 保存协调的去重同一个口径） */
export interface DedupeKey {
  readonly digest: string
  readonly formulasPending: boolean
}

/** 一次捕获（主线程：save()、序列化、编码一次） */
export interface CaptureToWrite {
  readonly key: DraftKey
  readonly writer: WriterIdentity
  /** 主线程在 save() 的同步段里从高水位往上分配 */
  readonly draftSeq: number
  readonly baseRevision: number
  /** 本页这次加载的客户端实例 */
  readonly writtenBy: string
  readonly format: ContentFormat
  readonly formulasPending: boolean
  /**
   * 在途的保存（上传已经发出、还没确认）：这期间写下的新一份接着带上它，崩溃之后恢复时才认得出"自己追自己"（M4 总设计 §2.2）；
   * 没有在途的为 null。它的序号不能比这一份大（那是更新的内容，恢复时会把这一份的旧内容接到服务端更新的那一版上）
   */
  readonly inFlight: InFlightSave | null
  /** UTF-8 的快照：交给 write 之后归管道（Worker 的宿主把缓冲转移过去），调用方不能再用 */
  readonly bytes: Uint8Array<ArrayBuffer>
  /** 允许去重：显式保存为 false */
  readonly dedupe: boolean
  /** 接手别的写入者留下的那一份（调用方确实看过它，P3 的恢复用） */
  readonly adoptSeq?: number
}

/**
 * 写入的结果。gzip 是这次内容压缩之后的字节（上传用，P2），压缩之后的每种结果都带上：写满、没有密钥、库用不了、被栅栏拒绝时
 * 照样可以上传；压缩之前就出错的 failed 没有（null）。写成时 mirror 是 OPFS 的镜像写成了没有（§3.8：没写成不影响库那一份，
 * 由页面如实说明，P2；这个宿主不做镜像时是 off）
 */
export type CaptureWritten
  = | { readonly kind: 'written', readonly gzip: Uint8Array<ArrayBuffer>, readonly digest: string, readonly mirror: MirrorStatus }
    | { readonly kind: 'unchanged', readonly digest: string }
    | { readonly kind: 'fenced', readonly reason: FenceReason, readonly gzip: Uint8Array<ArrayBuffer> }
    | { readonly kind: 'no-key', readonly gzip: Uint8Array<ArrayBuffer> }
    | { readonly kind: 'quota', readonly gzip: Uint8Array<ArrayBuffer> }
    | (OutboxUnavailable & { readonly gzip: Uint8Array<ArrayBuffer> })
    | { readonly kind: 'failed', readonly error: FailureDescription, readonly gzip: Uint8Array<ArrayBuffer> | null }

/**
 * 库里的一条草稿解开之后：内容、解不开（已吊销、本页的密钥过时——去取新的再试、已损坏，审查 A3）、手里没有密钥（只有元数据）、
 * 更新的页面写的、形状不对
 */
export type OpenedRecord
  = | { readonly kind: 'draft', readonly meta: DraftMeta, readonly gzip: Uint8Array<ArrayBuffer> }
    | { readonly kind: 'unreadable', readonly meta: DraftMeta, readonly reason: UnsealFailure }
    | { readonly kind: 'no-key', readonly meta: DraftMeta }
    | { readonly kind: 'newer-format', readonly recordVersion: number }
    | { readonly kind: 'malformed' }

export type DraftRead = OpenedRecord | { readonly kind: 'absent' } | WriterProblem

export type RegisterResult
  /**
   * 登记了：lastDraftSeq 是高水位；existing 是现有的草稿（库与镜像里最新、解得开的那一份，已解开或归类；有就由恢复决定，P3）；
   * mirror 是镜像的两个槽位建好、拿到句柄了没有，以及库里那一份比镜像新时补写成了没有
   */
  = | { readonly kind: 'registered', readonly lastDraftSeq: number, readonly existing: OpenedRecord | undefined, readonly mirror: MirrorStatus }
    | { readonly kind: 'superseded', readonly currentEpoch: number, readonly sameEpoch: boolean }
    | WriterProblem

/** 重封（标记在途）的结果 */
export type ResealResult
  = | { readonly kind: 'resealed' }
  /** 库里没有这一份或更新的内容（没写成、已确认删掉）：不标记 */
    | { readonly kind: 'absent' }
  /** 写入者不是它，或者库里已经不是本页写下的那一份 */
    | { readonly kind: 'fenced', readonly reason: 'not-writer' | 'changed' }
    | NoKey
    | WriterProblem

export type ConfirmResult
  = | { readonly kind: 'deleted' | 'rebased' | 'absent' }
    | { readonly kind: 'fenced', readonly reason: 'not-writer' | 'foreign-draft' }
  /** 要改基准、手里却没有密钥（重封做不了）：记录不动 */
    | NoKey
    | WriterProblem

export type RemoveResult = { readonly kind: 'removed' | 'changed' | 'absent' } | WriterProblem

/** 换密钥：本页写下的草稿里没能用新密钥重封的（写满、库用不了、出错）——调用方随后以新密钥重写它们的内容（不去重的捕获） */
export type KeyChange
  = | { readonly kind: 'key-set', readonly notResealed: readonly DraftKey[] }
    | { readonly kind: 'failed', readonly error: FailureDescription }

/** 比对一份文档（打开平台时一份一份地来，审查 A13：draft-recovery.ts 的 reconcileAll） */
export type ReconcileResult = { readonly kind: 'reconciled' } | WriterProblem

/** 这个用户在镜像里有哪些文档（打开平台时的比对先列出）；没有镜像时是空的 */
export type MirroredDocumentsResult = { readonly kind: 'listed', readonly documentIds: readonly string[] } | { readonly kind: 'failed', readonly error: FailureDescription }

/** 这个用户的提示（比对镜像与库留下的，存在库里：recovery-notice.ts） */
export type NoticesResult = { readonly kind: 'notices', readonly notices: readonly RecoveryNotice[] } | WriterProblem

/** 清除一条提示：清了；读出之后又留下了新的一条（时刻不同），没清；没有 */
export type ClearNoticeResult = { readonly kind: 'cleared' | 'changed' | 'absent' } | WriterProblem

export interface DraftWriter {
  readonly register: (key: DraftKey, writer: WriterIdentity, force: boolean) => Promise<RegisterResult>
  readonly write: (capture: CaptureToWrite) => Promise<CaptureWritten>
  readonly markInFlight: (key: DraftKey, writer: WriterIdentity, inFlight: InFlightSave) => Promise<ResealResult>
  readonly confirm: (key: DraftKey, writer: WriterIdentity, confirmedSeq: number, revision: number) => Promise<ConfirmResult>
  readonly read: (key: DraftKey) => Promise<DraftRead>
  readonly remove: (key: DraftKey, expectedSeq?: number) => Promise<RemoveResult>
  readonly setKey: (key: LocalKeyHandle | undefined) => Promise<KeyChange>
  readonly seedDigest: (key: DraftKey, seed: DedupeKey | undefined) => Promise<void>
  /** 这一页不再是这份文档的写入者（锁被抢、编辑权失效、离开编辑）：放开镜像的句柄，新的写入者才拿得到（§3.8） */
  readonly release: (key: DraftKey) => Promise<void>
  /** 这个用户在镜像里有哪些文档（打开平台时的比对先列出，再一份一份地 reconcile） */
  readonly mirroredDocuments: (userId: string) => Promise<MirroredDocumentsResult>
  /** 比对一份文档（§3.8，draft-recovery.ts）：镜像胜出时写回库（留下提示）、镜像过时时截断、本页拿着句柄而库里的胜出时补写镜像 */
  readonly reconcile: (key: DraftKey) => Promise<ReconcileResult>
  /** 这个用户的提示（P3 打开文档时说明"已从备份恢复""因浏览器存储损坏丢失"） */
  readonly notices: (userId: string) => Promise<NoticesResult>
  /** 说明过之后清除这份文档的提示：带 expectedAt（读出的那一条的时刻）时只清那一条 */
  readonly clearNotice: (key: DraftKey, expectedAt?: number) => Promise<ClearNoticeResult>
  readonly dispose: () => void
}

export interface DraftWriterOptions {
  readonly store: DraftStore
  /** 墙上时间（毫秒）：记录的更新时间、写入者的登记时刻 */
  readonly now: () => number
  /** OPFS 的镜像（§3.8）：只在发件箱 Worker 里给（同步访问句柄只在专用 Worker 里有）；不给时不做镜像，结果里是 off */
  readonly mirror?: DraftMirror
  /** 比对镜像与库的策略（draft-recovery.ts，配同一个镜像）：不给时不比对，只读库 */
  readonly recovery?: DraftRecovery
}

/** 确认时库里一直在变（存储一再交回 needs-rebase）：试这么多次之后放弃，不挂住（同一个写入者只有本页，正常一次就成） */
const CONFIRM_ATTEMPTS = 3

const CLOSED: FailureDescription = { name: 'InvalidStateError', message: '写入管道已关闭' }

const MIRROR_OFF: MirrorStatus = { kind: 'off' }

/** 存储的问题折成管道的：只带约定的字段（跨 Worker 时结构化克隆的就是这一份），错误折成名字与消息 */
function problemOf(problem: StoreProblem): WriterProblem {
  switch (problem.kind) {
    case 'quota':
      return { kind: 'quota' }
    case 'unavailable':
      return { kind: 'unavailable', reason: problem.reason }
    case 'failed':
      return { kind: 'failed', error: describeFailure(problem.error) }
  }
}

/** 本页写下的那一份用当前的密钥解不开（密钥换过而没重封成、本页的密钥过时、记录被改过）：重封做不了，不动它 */
function unreadableOwn(reason: UnsealFailure): WriterProblem {
  return { kind: 'failed', error: { name: 'DraftUnreadable', message: `本页写下的草稿用当前的密钥解不开（${reason}）` } }
}

/** 重封、改基准时去掉密钥版本：由这次的密钥给出 */
function sealable(meta: DraftMeta): Omit<DraftMeta, 'keyVersion'> {
  const { keyVersion: _keyVersion, ...rest } = meta
  return rest
}

/** 管道记着的本页写下的最新一份：元数据与 gzip（重封用）。只在管道里，不交出去 */
interface Latest {
  readonly meta: DraftMeta
  readonly gzip: Uint8Array<ArrayBuffer>
}

interface DocumentState {
  readonly key: DraftKey
  /** 队尾：这份文档的操作一个接一个 */
  tail: Promise<void>
  latest: Latest | undefined
  /** 上次写入的去重键；没写成的捕获、登记、放弃之后清空 */
  dedupe: DedupeKey | undefined
}

/** 解开本页写下的那一份的结果：拿到了（已记下）；手里没有密钥；解不开（failed）、存储的问题 */
type Remembered = { readonly kind: 'latest', readonly latest: Latest } | NoKey | WriterProblem

/** 找本页写下的那一份的结果：另有库里没有、库里不是本页写的 */
type OwnRecord = Remembered | { readonly kind: 'absent' } | { readonly kind: 'foreign' }

const NOT_RECONCILED: Reconciled = { mirror: undefined, restored: undefined }

export function createDraftWriter(options: DraftWriterOptions): DraftWriter {
  const { store, now, mirror, recovery } = options
  const documents = new Map<string, DocumentState>()
  let current: LocalKeyHandle | undefined
  let disposed = false

  function stateOf(key: DraftKey): DocumentState {
    const id = JSON.stringify([key.userId, key.documentId])
    let state = documents.get(id)
    if (state === undefined) {
      state = { key: { userId: key.userId, documentId: key.documentId }, tail: Promise.resolve(), latest: undefined, dedupe: undefined }
      documents.set(id, state)
    }
    return state
  }

  /**
   * 排进这份文档的队：前一个结束（不论结果）才开始，关掉之后不再开始。task 抛出（存储没按约定交回、编解码出了意外）时以 failed 交回——
   * 跨边界不抛异常；队列照样往下走
   */
  async function enqueue<T>(key: DraftKey, task: (state: DocumentState) => Promise<T>, failed: (error: FailureDescription) => T): Promise<T> {
    const state = stateOf(key)
    const run = state.tail.then(async () => disposed ? failed(CLOSED) : task(state)).catch((error: unknown) => failed(describeFailure(error)))
    state.tail = run.then(() => {})
    return run
  }

  /** 比对这份文档（没有比对的策略时不比对） */
  async function reconcileOf(key: DraftKey, stored?: StoreReadOutcome): Promise<Reconciled> {
    return recovery === undefined ? NOT_RECONCILED : recovery.reconcile(key, stored)
  }

  /**
   * 解开要交回的那一个版本（draft-recovery.ts 的 versionsToOpen：几份拷贝，库里的在前）：哪一份解得开就交回它；都解不开时按这个版本
   * 归类（审查 A3：不退回更旧的版本）；手里没有密钥只给元数据
   */
  async function openVersions(versions: readonly [StoredDraft, ...StoredDraft[]]): Promise<OpenedRecord> {
    const [primary] = versions
    const handle = current
    if (handle === undefined)
      return { kind: 'no-key', meta: draftMetaOf(primary) }
    for (const version of versions) {
      const result = await openDraft(handle, version)
      if (result.kind === 'opened')
        return { kind: 'draft', meta: draftMetaOf(version), gzip: result.gzip }
    }
    return { kind: 'unreadable', meta: draftMetaOf(primary), reason: unsealFailureOf(primary.keyVersion, handle.version) }
  }

  /** 库里读出的一条（与比对的结果）交回成什么：要交回的那个版本解开之后；没有时按库里的归类（更新的页面写的、形状不对），或者没有 */
  async function openedOf(stored: StoreReadOutcome, reconciled: Reconciled): Promise<OpenedRecord | undefined> {
    const versions = versionsToOpen(stored, reconciled)
    const [primary, ...copies] = versions
    if (primary !== undefined)
      return openVersions([primary, ...copies])
    if (stored.kind === 'newer-format')
      return { kind: 'newer-format', recordVersion: stored.recordVersion }
    return stored.kind === 'malformed' ? { kind: 'malformed' } : undefined
  }

  /** IndexedDB 写成之后写镜像；没有镜像时 off。镜像出了意外也只交回"没写成"，不影响库那一份 */
  async function mirrorWrite(record: StoredDraft): Promise<MirrorStatus> {
    if (mirror === undefined)
      return MIRROR_OFF
    try {
      return await mirror.write(record)
    }
    catch (error) {
      return { kind: 'not-mirrored', reason: 'failed', error: describeFailure(error) }
    }
  }

  /** 补写镜像（拿着句柄时，见 DraftMirror.backfill；不是写入者时 undefined）。出了意外也只交回"没写成" */
  async function mirrorBackfill(record: StoredDraft): Promise<MirrorStatus | undefined> {
    try {
      return await mirror?.backfill(record)
    }
    catch (error) {
      return { kind: 'not-mirrored', reason: 'failed', error: describeFailure(error) }
    }
  }

  /** 草稿删掉之后截断镜像（拿不到句柄就算了：比对时按高水位认出过时的镜像，不会复活） */
  async function mirrorClear(key: DraftKey): Promise<void> {
    try {
      await mirror?.clear(key)
    }
    catch {
      // 同上
    }
  }

  /** 重写同一份内容（重封、改基准）时的更新时间：只增不减——同一个序号的几份靠它分先后（镜像与库谁新，compareDrafts） */
  function rewrittenAt(meta: DraftMeta): number {
    return Math.max(now(), meta.updatedAt + 1)
  }

  /** 库里读出的、本页写下的那一份：解开并记下（重封要用它的内容） */
  async function remember(state: DocumentState, draft: StoredDraft): Promise<Remembered> {
    const handle = current
    if (handle === undefined)
      return { kind: 'no-key' }
    const result = await openDraft(handle, draft)
    if (result.kind === 'unreadable')
      return unreadableOwn(result.reason)
    state.latest = { meta: draftMetaOf(draft), gzip: result.gzip }
    return { kind: 'latest', latest: state.latest }
  }

  /**
   * 本页（writer）写下的、库里现在的那一份：先看管道记着的；没有就读库、解开，并记下。库里是别的写入者写的（或者认不出）为 foreign——
   * 本页不重封、不改它，由存储的判定与恢复处理
   */
  async function ownRecord(state: DocumentState, writer: WriterIdentity): Promise<OwnRecord> {
    if (state.latest !== undefined && isSameWriter(state.latest.meta, writer))
      return { kind: 'latest', latest: state.latest }
    const read = await store.readDraft(state.key)
    if (read.kind === 'absent')
      return { kind: 'absent' }
    if (read.kind === 'quota' || read.kind === 'unavailable' || read.kind === 'failed')
      return problemOf(read)
    if (read.kind !== 'draft' || !isSameWriter(read.draft, writer))
      return { kind: 'foreign' }
    return remember(state, read.draft)
  }

  /** 重封（标记在途、换密钥）：用当前的密钥、新的 IV 封好，再比较并交换；成了就记下新的那一份 */
  async function reseal(state: DocumentState, meta: DraftMeta, gzip: Uint8Array<ArrayBuffer>): Promise<ResealResult> {
    const handle = current
    if (handle === undefined)
      return { kind: 'no-key' }
    const sealed = await sealDraft(handle, sealable(meta), gzip)
    const outcome = await store.replaceDraft(sealed)
    switch (outcome.kind) {
      case 'written':
        state.latest = { meta: draftMetaOf(sealed), gzip }
        await mirrorWrite(sealed)
        return { kind: 'resealed' }
      case 'fenced':
        state.latest = undefined
        if (outcome.reason === 'not-writer')
          mirror?.detach(state.key)
        return { kind: 'fenced', reason: outcome.reason === 'not-writer' ? 'not-writer' : 'changed' }
      case 'quota':
      case 'unavailable':
      case 'failed':
        return problemOf(outcome)
    }
  }

  /** 写入的后半段（已经压缩、去重的起点已清空）：没有密钥就不写；封好交给存储 */
  async function storeCapture(state: DocumentState, capture: CaptureToWrite, gzip: Uint8Array<ArrayBuffer>, digest: string): Promise<CaptureWritten> {
    const handle = current
    if (handle === undefined)
      return { kind: 'no-key', gzip }
    const { key, writer } = capture
    const sealed = await sealDraft(handle, {
      userId: key.userId,
      documentId: key.documentId,
      recordVersion: DRAFT_RECORD_VERSION,
      draftSeq: capture.draftSeq,
      baseRevision: capture.baseRevision,
      writeEpoch: writer.writeEpoch,
      writerId: writer.writerId,
      writtenBy: capture.writtenBy,
      format: capture.format,
      formulasPending: capture.formulasPending,
      inFlight: capture.inFlight,
      rawBytes: capture.bytes.byteLength,
      updatedAt: now(),
    }, gzip)
    const outcome = await store.writeDraft(sealed, capture.adoptSeq === undefined ? undefined : { adoptSeq: capture.adoptSeq })
    switch (outcome.kind) {
      case 'written':
        state.latest = { meta: draftMetaOf(sealed), gzip }
        state.dedupe = { digest, formulasPending: capture.formulasPending }
        return { kind: 'written', gzip: gzip.slice(), digest, mirror: await mirrorWrite(sealed) }
      case 'fenced':
        state.latest = undefined
        if (outcome.reason === 'not-writer')
          mirror?.detach(key)
        return { kind: 'fenced', reason: outcome.reason, gzip }
      case 'quota':
        return { kind: 'quota', gzip }
      case 'unavailable':
        return { kind: 'unavailable', reason: outcome.reason, gzip }
      case 'failed':
        return { kind: 'failed', error: describeFailure(outcome.error), gzip }
    }
  }

  /** 确认之前准备的：比确认的新、要改基准时，是改了基准的重封那一份（库里没有本页更新的那一份时为 undefined，删不删由存储判定） */
  type Prepared = { readonly kind: 'prepared', readonly rebased: { readonly sealed: StoredDraft, readonly gzip: Uint8Array<ArrayBuffer> } | undefined } | NoKey | WriterProblem

  async function prepareConfirm(state: DocumentState, writer: WriterIdentity, confirmedSeq: number, revision: number): Promise<Prepared> {
    let latest = state.latest !== undefined && isSameWriter(state.latest.meta, writer) ? state.latest : undefined
    if (latest === undefined) {
      // 手里没有：先看库里的元数据，比确认的新才要解开（只是删不需要密钥）
      const read = await store.readDraft(state.key)
      if (read.kind === 'quota' || read.kind === 'unavailable' || read.kind === 'failed')
        return problemOf(read)
      if (read.kind !== 'draft' || !isSameWriter(read.draft, writer) || read.draft.draftSeq <= confirmedSeq)
        return { kind: 'prepared', rebased: undefined }
      const found = await remember(state, read.draft)
      if (found.kind !== 'latest')
        return found
      latest = found.latest
    }
    if (latest.meta.draftSeq <= confirmedSeq)
      return { kind: 'prepared', rebased: undefined }
    const handle = current
    if (handle === undefined)
      return { kind: 'no-key' }
    const sealed = await sealDraft(handle, sealable({ ...latest.meta, baseRevision: revision, inFlight: null, updatedAt: rewrittenAt(latest.meta) }), latest.gzip)
    return { kind: 'prepared', rebased: { sealed, gzip: latest.gzip } }
  }

  /** 换密钥之后重封这份文档手里的那一份；没重封成（写满、库用不了、出错）时交回 false，下一次捕获不去重，以新密钥重写 */
  async function rekey(state: DocumentState): Promise<boolean> {
    const latest = state.latest
    const handle = current
    if (latest === undefined || handle === undefined || latest.meta.keyVersion === handle.version)
      return true
    try {
      const result = await reseal(state, { ...latest.meta, updatedAt: rewrittenAt(latest.meta) }, latest.gzip)
      // 被栅栏拒绝：库里已经不是本页的了，不归本页重写
      if (result.kind === 'resealed' || result.kind === 'fenced')
        return true
    }
    catch {
      // 与写满同样处理：记录还是旧版本
    }
    state.dedupe = undefined
    return false
  }

  return {
    register: async (key, writer, force) => enqueue(key, async (state): Promise<RegisterResult> => {
      // 登记之前先比对镜像（删库之后连写入者一起写回：不补就挡不住旧的写入者）
      const reconciled = await reconcileOf(key)
      const outcome = await store.registerWriter(key, writer, { now: now(), force })
      if (outcome.kind === 'superseded') {
        mirror?.detach(key)
        return { kind: 'superseded', currentEpoch: outcome.currentEpoch, sameEpoch: outcome.sameEpoch }
      }
      if (outcome.kind !== 'registered')
        return problemOf(outcome)
      // 新的一次登记：手里记着的与去重的起点都作废（现有的草稿可能是别的写入者留下的；恢复之后由 seedDigest 设定起点）
      state.latest = undefined
      state.dedupe = undefined
      // 现有的草稿：库里的（比对写回的已经在库里），同一版本在镜像里的拷贝备着
      const existing = await openedOf(outcome.existing ?? { kind: 'absent' }, { mirror: reconciled.mirror, restored: undefined })
      const attached = mirror === undefined ? MIRROR_OFF : await mirror.attach(key)
      // 库里那一份不是镜像里最新写的（被结束在"库已提交、镜像还没写完"之间、以 force 登记之后）：拿到句柄之后补写，补写没写成时如实交回
      const filled = attached.kind === 'mirrored' && outcome.existing?.kind === 'draft' ? await mirrorBackfill(outcome.existing.draft) : undefined
      return { kind: 'registered', lastDraftSeq: outcome.lastDraftSeq, existing, mirror: filled ?? attached }
    }, error => ({ kind: 'failed', error })),

    write: async capture => enqueue(capture.key, async (state): Promise<CaptureWritten> => {
      const { inFlight } = capture
      if (inFlight !== null && inFlight.localSeq > capture.draftSeq)
        return { kind: 'failed', error: { name: 'InvalidCapture', message: `在途的保存（序号 ${inFlight.localSeq}）比这一份（序号 ${capture.draftSeq}）新` }, gzip: null }
      const digest = await sha256Hex(capture.bytes)
      const last = state.dedupe
      if (capture.dedupe && last !== undefined && last.digest === digest && last.formulasPending === capture.formulasPending)
        return { kind: 'unchanged', digest }
      // 这一次写不写得成之前，去重的起点作废：没写成的那一份照样会上传（P2），服务端随之可能已经不是上次写下的内容，
      // 再捕获到与上次写下的相同内容也要照常写（否则本机没有它，服务端也没有）
      state.dedupe = undefined
      const gzip = await gzipBytes(capture.bytes)
      try {
        return await storeCapture(state, capture, gzip, digest)
      }
      catch (error) {
        return { kind: 'failed', error: describeFailure(error), gzip }
      }
    }, error => ({ kind: 'failed', error, gzip: null })),

    markInFlight: async (key, writer, inFlight) => enqueue(key, async (state): Promise<ResealResult> => {
      const found = await ownRecord(state, writer)
      if (found.kind === 'foreign')
        return { kind: 'fenced', reason: 'changed' }
      if (found.kind !== 'latest')
        return found
      // 库里的比在途的旧（在途的那一份没写成）：标上去，恢复时会把旧内容当成"自己追自己"接到服务端更新的那一版上——不标
      if (found.latest.meta.draftSeq < inFlight.localSeq)
        return { kind: 'absent' }
      return reseal(state, { ...found.latest.meta, inFlight, updatedAt: rewrittenAt(found.latest.meta) }, found.latest.gzip)
    }, error => ({ kind: 'failed', error })),

    confirm: async (key, writer, confirmedSeq, revision) => enqueue(key, async (state): Promise<ConfirmResult> => {
      for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt += 1) {
        const prepared = await prepareConfirm(state, writer, confirmedSeq, revision)
        if (prepared.kind !== 'prepared')
          return prepared
        const outcome = await store.confirmDraft(key, writer, confirmedSeq, prepared.rebased?.sealed)
        switch (outcome.kind) {
          case 'deleted':
            // 去重的起点留着：服务端已经有这份内容。镜像随之截断
            state.latest = undefined
            await mirrorClear(key)
            return { kind: 'deleted' }
          case 'rebased':
            state.latest = prepared.rebased === undefined ? undefined : { meta: draftMetaOf(prepared.rebased.sealed), gzip: prepared.rebased.gzip }
            if (prepared.rebased !== undefined)
              await mirrorWrite(prepared.rebased.sealed)
            return { kind: 'rebased' }
          case 'absent':
            // 草稿已不在（被放弃、被清理）：说不准服务端有没有上次写下的内容，去重的起点作废
            state.latest = undefined
            state.dedupe = undefined
            return { kind: 'absent' }
          case 'needs-rebase':
            // 库里的比手里记着的新：丢掉记着的，按库里现在的那一份重新准备
            state.latest = undefined
            continue
          case 'fenced':
            state.latest = undefined
            if (outcome.reason === 'not-writer')
              mirror?.detach(key)
            return { kind: 'fenced', reason: outcome.reason }
          case 'quota':
          case 'unavailable':
          case 'failed':
            return problemOf(outcome)
        }
      }
      return { kind: 'failed', error: { name: 'ConfirmRace', message: `确认时库里的草稿一直在变（试了 ${CONFIRM_ATTEMPTS} 次）` } }
    }, error => ({ kind: 'failed', error })),

    read: async key => enqueue(key, async (): Promise<DraftRead> => {
      // 先读库（只读），再拿它比对镜像：写回了的就交回写回的那一份；库用不了时交回镜像里最新写的（读得出总比读不出好）
      const read = await store.readDraft(key)
      const reconciled = await reconcileOf(key, read)
      if (reconciled.problem !== undefined)
        return problemOf(reconciled.problem)
      const opened = await openedOf(read, reconciled)
      if (opened !== undefined)
        return opened
      return read.kind === 'quota' || read.kind === 'unavailable' || read.kind === 'failed' ? problemOf(read) : { kind: 'absent' }
    }, error => ({ kind: 'failed', error })),

    remove: async (key, expectedSeq) => enqueue(key, async (state): Promise<RemoveResult> => {
      const outcome = await store.removeDraft(key, expectedSeq)
      switch (outcome.kind) {
        case 'removed':
        case 'absent':
          state.latest = undefined
          state.dedupe = undefined
          await mirrorClear(key)
          return { kind: outcome.kind }
        case 'changed':
          return { kind: 'changed' }
        case 'quota':
        case 'unavailable':
        case 'failed':
          return problemOf(outcome)
      }
    }, error => ({ kind: 'failed', error })),

    setKey: async (handle) => {
      if (disposed)
        return { kind: 'failed', error: CLOSED }
      // 立即生效：之后开始封的都用它；已经封好、正在交给存储的那一次随后由下面排在它后面的重封换成新密钥
      current = handle
      if (handle === undefined)
        return { kind: 'key-set', notResealed: [] }
      const states = [...documents.values()]
      const resealed = await Promise.all(states.map(async state => enqueue(state.key, async () => rekey(state), () => false)))
      return { kind: 'key-set', notResealed: states.filter((_, index) => resealed[index] === false).map(state => state.key) }
    },

    seedDigest: async (key, seed) => {
      await enqueue(key, async (state) => {
        state.dedupe = seed === undefined ? undefined : { digest: seed.digest, formulasPending: seed.formulasPending }
      }, () => {})
    },

    release: async (key) => {
      await enqueue(key, async () => {
        mirror?.detach(key)
      }, () => {})
    },

    mirroredDocuments: async (userId) => {
      if (disposed)
        return { kind: 'failed', error: CLOSED }
      if (mirror === undefined)
        return { kind: 'listed', documentIds: [] }
      const listed = await mirror.documents(userId)
      return listed.kind === 'unsupported' ? { kind: 'listed', documentIds: [] } : listed
    },

    reconcile: async key => enqueue(key, async (): Promise<ReconcileResult> => {
      const reconciled = await reconcileOf(key)
      return reconciled.problem === undefined ? { kind: 'reconciled' } : problemOf(reconciled.problem)
    }, error => ({ kind: 'failed', error })),

    notices: async (userId) => {
      if (disposed)
        return { kind: 'failed', error: CLOSED }
      try {
        const outcome = await store.listNotices(userId)
        return outcome.kind === 'notices' ? { kind: 'notices', notices: outcome.notices } : problemOf(outcome)
      }
      catch (error) {
        return { kind: 'failed', error: describeFailure(error) }
      }
    },

    clearNotice: async (key, expectedAt) => enqueue(key, async (): Promise<ClearNoticeResult> => {
      const outcome = await store.clearNotice(key, expectedAt)
      switch (outcome.kind) {
        case 'cleared':
        case 'changed':
        case 'absent':
          return { kind: outcome.kind }
        case 'quota':
        case 'unavailable':
        case 'failed':
          return problemOf(outcome)
      }
    }, error => ({ kind: 'failed', error })),

    dispose: () => {
      if (disposed)
        return
      disposed = true
      current = undefined
      documents.clear()
      mirror?.close()
      store.close()
    },
  }
}
