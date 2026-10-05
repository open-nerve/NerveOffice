// 保存的状态机（P4 设计 §3.7.2）：输入是要上传的捕获、编辑器的修改与接口的结果，不依赖 Univer 与界面，用假的编辑器与假的接口做单元测试。
// M3-P3（设计 §3.7、§3.8、§3.10）：请求带"公式待更新"（原样重发的判断连它一起比）；服务端回答内容相同（unchanged）照"已保存"处理；
// 本页与服务端不兼容（CLIENT_OUTDATED、DOCUMENT_TOO_NEW）是终态——停住保存，页面说明需要刷新（或只能阅读）；转入时还有一次结果未知的
// 保存就先原样重发它一次，核对完再定"修改存上了没有"的说法（审查 B5，重放先于拦截；续租得知时在途的那一次先等它的结果，复验 C1）；
// 视图带最近一次捕获的大小（与服务端解压后的字节同一个口径），页面据此在达到容量的 80% 时提示。
// M3-P4（设计 §3.1、§3.4、§3.7–§3.9）：两级的上传这一级——上传一份给定的捕获，不自己捕获：
// - 捕获由来源给出（CaptureSource）：自动保存给的是"最近一次捕获"（autosave.ts），立即上传与显式保存给的是先提交单元格、等公式再捕获的那个
//   （snapshot-capture.ts）。来源在轮到这一次时才取，所以每次上传的都是那一刻最新的捕获，先后不会颠倒；
// - 保存一个接一个（同时至多一个在途）；不去重的（显式保存）在途时按下排一次，再按并进排着的那一次（设计 §3.4、§3.9）；
// - 会话内去重（设计 §3.7）：键是快照字节的摘要连同"公式待更新"，与最近一次确认过的相同就不上传、按这次捕获的序号确认；
//   还有结果未知的请求时不去重（服务端上可能是那一次的内容）；同样的内容被拒、再试也一样的（要等新内容）不再发。显式保存一律上传；
// - "公式待更新"的初值由调用方给出（进入编辑时申请编辑权的响应里的标记，设计 §3.5）；
// - 每次保存交回结果与失败的归类（SaveOutcome、classifySaveError），调度据此决定自动重试、等新内容、等会话还是停下（设计 §3.8）；
// - 失败的说明在下一次保存的结果出来之前保留（设计 §3.9：自动重试期间不清掉再出现）；保存中仍可以再按（排一次）。
import type { RevisionConflictDetails, RevisionSource, SaveContentResponse } from '@nerve-office/contracts'
import type { Incompatibility } from './client-format.ts'
import { revisionConflictDetailsSchema, SNAPSHOT_MAX_RAW_BYTES } from '@nerve-office/contracts'
import { ApiError, isAuthenticationError, isCsrfTokenError, isDefiniteRejection, isNotFoundError } from '../../shared/api/index.ts'
import { incompatibilityOf } from './client-format.ts'

/** 保存用到的编辑器能力（SheetEditor 的子集）：只用来说"有没有服务端还没确认的内容"，捕获由来源给出 */
export interface SaveEditor {
  readonly changeSeq: () => number
  readonly onChange: (listener: () => void) => () => void
  readonly isCellEditing: () => boolean
  /** 单元格编辑器里有还没提交的输入：也算有未保存的修改（Codex 评审 CX6） */
  readonly hasPendingCellInput: () => boolean
  readonly onCellEditingChange: (listener: () => void) => () => void
}

/** 一次捕获：保存上传的就是它（snapshot-capture.ts 的 takeSnapshot 给出） */
export interface SnapshotCapture {
  /** 捕获时本页的修改序号（与快照在同一个同步段里读出） */
  readonly seq: number
  /** 快照的 JSON 文本 */
  readonly snapshot: string
  /** 快照的 UTF-8 字节数（与服务端解压后的字节同一个口径） */
  readonly bytes: number
  /** "公式待更新"：捕获时公式还没收齐 */
  readonly formulasPending: boolean
  /** 快照 UTF-8 字节的 SHA-256（会话内去重的键，连同 formulasPending）：没算或算不出时为 undefined，这一次不去重、确认之后也不留键 */
  readonly digest: string | undefined
}

/** 准备好的捕获；提交不了正在编辑的单元格时为 'cell-editing'（保存中止，只是提示） */
export type PreparedCapture = SnapshotCapture | 'cell-editing'

/** 捕获的来源：轮到这一次保存时才调用（同步或异步）；抛出的错误按意外的错误处理 */
export type CaptureSource = () => PreparedCapture | Promise<PreparedCapture>

export interface SaveOptions {
  /**
   * 会话内去重（设计 §3.7）：自动保存、切到后台、退出编辑与交出时为真；显式保存（保存按钮、Cmd/Ctrl+S）为假——一律上传，兜住变更检测
   * 看不见的改动，在途时排一次
   */
  readonly dedupe: boolean
}

export interface SaveRequest {
  readonly baseRevision: number
  readonly requestId: string
  readonly clientInstanceId: string
  /** 捕获时本页的修改序号 */
  readonly localSeq: number
  /** 捕获的快照 JSON 文本 */
  readonly snapshot: string
  /** "公式待更新"（M3-P3 设计 §3.8）：捕获时公式还没收齐，服务端记在文档上 */
  readonly formulasPending: boolean
}

/** 压缩快照（gzip）：本地的一步，出错是意外的错误（复验 RB8） */
export type CompressSnapshot = (snapshot: string) => Promise<Uint8Array<ArrayBuffer>>

/** 上传压缩后的快照；失败时抛出请求层的错误（ApiError、NetworkError、ResponseFormatError），结果按"确定被拒"或"未知"归类。 */
export type SendSave = (request: SaveRequest, body: Uint8Array<ArrayBuffer>) => Promise<SaveContentResponse>

/**
 * 已保存到云端、有未保存的修改、保存中、版本冲突、保存失败；本页与服务端不兼容（M3-P3）：本页的版本过旧，需要刷新（outdated）；
 * 文档由更新的版本写过，不能再保存（too-new）。版本冲突与后两个都是终态。
 * 设计 §3.9 的全集（公式结果尚未保存、自动重试中、已离线、暂停）连同自动保存的状态由 save-indicator.ts 给出
 */
export type SaveStatus = 'clean' | 'dirty' | 'saving' | 'conflict' | 'failed' | 'outdated' | 'too-new'

/** 不兼容的两种对应的状态 */
const BLOCKED_STATUS: Readonly<Record<Incompatibility, SaveStatus>> = { 'client-outdated': 'outdated', 'document-too-new': 'too-new' }

/** 最近一次保存没有完成的原因。 */
export type SaveProblem
  /** 单元格的编辑提交不了：保存中止，只是提示，状态照旧 */
  = | { readonly kind: 'cell-editing' }
  /** 序列化之后超过上限：没有上传 */
    | { readonly kind: 'too-large' }
  /** 请求失败（冲突除外） */
    | { readonly kind: 'request', readonly error: unknown }
  /** 提交编辑、等公式收齐、捕获或压缩时出了意外的错误（SDK 的缺陷等）：没有上传 */
    | { readonly kind: 'unexpected', readonly error: unknown }

/**
 * 保存失败之后怎么办（设计 §3.8，调度据此决定）：
 * - retry：会自动重试——结果未知（网络、5xx、回包读不出来）、服务繁忙（503、429，retryAfterMs 是服务端给的 Retry-After）、
 *   编辑权在续上（EDIT_LEASE_LOST、403、404 由编辑租约处理：失效了页面会停住保存）、requestId 被占用（下次换新的）；
 * - content：要等新内容——同样的内容再试也一样（快照不合格、超过上限、请求不合法）；
 * - session：要等会话——未登录、令牌失效，页面在确认会话；
 * - terminal：终态——版本冲突、本页过旧、文档太新；
 * - cell-editing：单元格的编辑提交不了（只在先提交单元格的那几种保存）；
 * - unexpected：捕获、压缩时的意外错误（已上报）
 */
export type SaveFailure
  = | { readonly kind: 'retry', readonly retryAfterMs: number | undefined }
    | { readonly kind: 'content' }
    | { readonly kind: 'session' }
    | { readonly kind: 'terminal' }
    | { readonly kind: 'cell-editing' }
    | { readonly kind: 'unexpected' }

/** 一次保存的结果 */
export type SaveOutcome
  /** 服务端确认了（含内容相同的回执；自己追自己之后的重发；续上时认出在途的那一次，复验 C3）。requestId 是最后发出的那一个 */
  = | { readonly kind: 'saved', readonly requestId: string }
  /** 与最近一次确认过的内容与标记相同（会话内去重）：没有发请求，按这次捕获的序号确认 */
    | { readonly kind: 'deduped' }
  /** 没有成功；发过请求时 requestId 是最后发出的那一个 */
    | { readonly kind: 'failed', readonly failure: SaveFailure, readonly requestId: string | undefined }
  /** 没有做：停住了（stop），或者在终态 */
    | { readonly kind: 'skipped', readonly reason: 'stopped' | 'ended' }

export interface SaveView {
  readonly status: SaveStatus
  /** 服务端确认过的内容里公式结果还没收齐（进入编辑时是服务端给的标记）：收齐之后自动补存 */
  readonly formulasPending: boolean
  /** 最近一次保存没有完成的原因：下一次保存的结果出来之前一直保留（设计 §3.9） */
  readonly problem: SaveProblem | undefined
  /** 版本冲突的详情（服务端没给出能认出的详情时为 null） */
  readonly conflict: RevisionConflictDetails | null | undefined
  /** 能不能保存：冲突之后、与服务端不兼容之后、被页面停用时不能。保存中可以（再按排一次，设计 §3.9） */
  readonly canSave: boolean
  /**
   * 最近一次捕获的快照的大小（UTF-8 字节，与服务端解压后的字节同一个口径）；还没捕获过时是进入编辑时载入的内容的大小
   * （initialSnapshotBytes），都没有时为 undefined。页面据此在达到容量的 80%（SNAPSHOT_WARN_RAW_BYTES）时给一条提示（US-M3-14）
   */
  readonly snapshotBytes: number | undefined
  /**
   * 本页有没有服务端还没确认的内容（只看内容，不看保存的状态，M3-P1 审查 B3）：确认过的修改序号之后又有修改、
   * 公式结果尚未保存、单元格里还有没提交的输入，或者冲突之后本页的内容。按了保存却失败、而内容本来都已保存的，不算
   */
  readonly unsaved: boolean
  /**
   * 同上，不算"公式结果尚未保存"那一项：unsaved 为真而它为假时，本页的修改都已保存、只有公式的结果没有存上
   * （与服务端不兼容时页面据此单说一句，M3-P3 审查 B5）
   */
  readonly unsavedEdits: boolean
  /**
   * 转入与服务端不兼容的终态时还有一次结果未知的保存：正在原样重发它、核对它其实提交了没有（M3-P3 审查 B5）；续租得知时正有一次保存在途的，
   * 先等它的结果，以结果未知结束的同样原样重发（复验 C1）。核对完之前说不准本页的修改存上了没有，页面先说正在核对
   */
  readonly checking: boolean
}

export interface SaveCoordinatorOptions {
  readonly editor: SaveEditor
  readonly compress: CompressSnapshot
  readonly send: SendSave
  /** 打开时内容的修订号（ETag） */
  readonly baseRevision: number
  /** 本页这次加载的标识 */
  readonly clientInstanceId: string
  readonly newRequestId: () => string
  /** 保存得到未登录或登录已过期：页面向服务端确认会话（不整页跳转，本页的修改留着） */
  readonly onUnauthenticated: (error: ApiError) => void
  /** CSRF 令牌不对：页面向服务端确认会话 */
  readonly onSessionStale: () => void
  /** 意外的错误（保存流程本身出错）：上报，页面照常显示保存失败 */
  readonly reportError: (error: unknown) => void
  /** 快照的上限（解压后，字节） */
  readonly maxSnapshotBytes?: number
  /** 进入编辑时载入的内容的大小（UTF-8 字节）：第一次保存之前，80% 的提示按它算 */
  readonly initialSnapshotBytes?: number
  /**
   * "公式待更新"的初值（设计 §3.5）：进入编辑时申请编辑权的响应里的标记——带标记的文档以强制全量重算创建，收齐之后由自动保存补存、
   * 服务端随之清掉标记；在那之前页头说公式结果尚未保存，离开会提示
   */
  readonly initialFormulasPending?: boolean
}

export interface SaveCoordinator {
  readonly view: () => SaveView
  readonly subscribe: (listener: () => void) => () => void
  /** 保存的基准：服务端确认过的最新修订号（打开时是内容的修订号）。编辑权续上时拿它与申请得到的修订号比较（M3-P1） */
  readonly baseRevision: () => number
  /**
   * 编辑权续上时，文档当前的修订比本页的基准新：它的来源（source）是本页一次结果未知的保存——与冲突时认出"自己追自己"同一条规则——
   * 那次保存其实已经提交，按那次捕获确认、基准前进到 revision，返回 true；否则（别处保存的、没有来源、版本冲突之后）返回 false，
   * 页面按别处保存过处理（M3-P1 审查 B1，00 号计划书 §7.5）
   */
  readonly adoptOwnRevision: (revision: number, source: RevisionSource | null) => boolean
  /**
   * 上传 source 给出的捕获（见文件头）。一个接一个：前面还有保存时排在它后面，轮到时才向 source 要捕获；dedupe 为假（显式保存）时
   * 已经有一次排着还没开始的，就并进那一次、交回它的结果。停住、终态时不做（skipped）。从不失败（失败归在结果里）
   */
  readonly save: (source: CaptureSource, options: SaveOptions) => Promise<SaveOutcome>
  /** 自动保存在保存之外捕获了一次（定时的捕获，autosave.ts）：视图里的大小随之更新，80% 的提示不等上传（US-M3-14） */
  readonly noteCapture: (capture: SnapshotCapture) => void
  /**
   * 捕获在保存之外出了意外的错误（自动保存的定时捕获，autosave.ts）：上报，显示保存失败（意外的错误）；下一次保存成功时清掉
   */
  readonly captureFailed: (error: unknown) => void
  /**
   * 进行中与排着的保存都结束之后兑现（没有时立即兑现；转入不兼容的终态之后正在核对结果未知的那次保存时，也等它核对完），从不失败：
   * 失去编辑权、退出编辑时先等它，再看本页还有没有没保存的内容
   */
  readonly settled: () => Promise<void>
  /** 有一次结果未知的保存（网络错误、5xx、回包读不出来）还没有答案：它可能其实已经提交 */
  readonly hasUnknownOutcome: () => boolean
  /**
   * 原样重发最近一次结果未知的保存（M3-P2 设计 §3.4：失去编辑权、给副本之前）。服务端的重放先于登录的再核对与租约（P1）：
   * 它其实已经提交时拿到原来的结果——按那次捕获确认（committed），本页可能就没有没保存的内容了；确定被拒绝说明它没有提交
   * （not-committed）；读不到（404）、未登录、令牌失效与结果仍然未知时说不准（unknown，记录留着）。没有这样的保存时为 none。
   * 停住保存时照样发：这是核对那一次，不是新的保存
   */
  readonly replayUnknownOutcome: () => Promise<'none' | 'committed' | 'not-committed' | 'unknown'>
  /** 离开页面会丢掉内容：有未保存的修改、正在编辑的单元格、保存中、冲突之后本页的内容 */
  readonly hasUnsavedWork: () => boolean
  /**
   * 本页与服务端不兼容（续租得知，M3-P3）：转入终态（outdated、too-new），之后不再保存。保存自己得知时（请求得到 CLIENT_OUTDATED、
   * DOCUMENT_TOO_NEW）同样转入。已经在终态（冲突、不兼容）时不变。转入时还有一次结果未知的保存：先原样重发它一次再定说法（审查 B5，
   * 见 SaveView.checking）；正有保存在途时先等它，以结果未知结束的同样原样重发（复验 C1）
   */
  readonly block: (kind: Incompatibility) => void
  /** 停止保存（例如别的标签页换了人）：之后的保存都不做（排着的也不做），直到 resume */
  readonly stop: () => void
  /** 恢复保存（原来的人又登录回来了） */
  readonly resume: () => void
  /** 会话已经确认有效：清掉登录已过期、令牌失效这类失败的说明，它们已不再成立（复验 RB2） */
  readonly dismissSessionProblem: () => void
  readonly dispose: () => void
}

/** 会话内去重的键（设计 §3.7）：快照字节的摘要连同"公式待更新"——内容相同、标记不同不算同一个 */
interface SnapshotKey {
  readonly digest: string
  readonly formulasPending: boolean
}

/** 一次捕获里确认时要记下的：修改序号、"公式待更新"与去重的键（没有摘要时为 undefined） */
interface CaptureRecord {
  readonly seq: number
  readonly formulasPending: boolean
  readonly key: SnapshotKey | undefined
}

/**
 * 结果未知的保存（网络错误、5xx、回包读不出来）：服务端可能已经提交了。认出"自己追自己"只要序号与捕获的记录，
 * 不留快照本身，断网期间多次保存时内存不随之增长（审查 B9）：
 * - localSeq：请求里的修改序号，冲突的来源按它认。同一个 requestId 的请求不变，一直是第一次发出时的序号；
 * - capture：内容与这个请求相同的最近一次捕获，认出它已经提交时，按它确认（Codex 评审 CX2）；
 * - adopted：编辑权续上时认出的就是它（adoptOwnRevision）——服务端说期间的那一版正是它，基准已按它确认。
 *   在途时被认出的，它自己的回包随后以结果未知失败，就是提交了、回包丢了（复验 C3）
 */
interface UnconfirmedSave {
  readonly localSeq: number
  readonly capture: CaptureRecord
  readonly adopted: boolean
}

/**
 * 确定被拒、却会自动重试的错误码（SaveFailure 的 retry）：requestId 被占用（下次换新的）；编辑权失效、不能编辑、读不到——编辑租约先处理
 * （续上了就已经重发过一次；失效了页面停住保存），走到这里多半是暂时说不准（人不在、续上时断网），之后再试
 */
const RETRIED_REJECTIONS: ReadonlySet<string> = new Set(['REQUEST_ID_CONFLICT', 'EDIT_LEASE_LOST', 'PERMISSION_DENIED', 'NOT_FOUND'])

const SKIPPED_STOPPED: SaveOutcome = { kind: 'skipped', reason: 'stopped' }
const SKIPPED_ENDED: SaveOutcome = { kind: 'skipped', reason: 'ended' }
const DEDUPED: SaveOutcome = { kind: 'deduped' }

function conflictDetails(error: unknown): RevisionConflictDetails | null | undefined {
  if (!(error instanceof ApiError) || error.code !== 'DOCUMENT_REVISION_CONFLICT')
    return undefined
  const parsed = revisionConflictDetailsSchema.safeParse(error.details)
  return parsed.success ? parsed.data : null
}

/** 保存的请求失败之后怎么办（见 SaveFailure）。自己追自己的冲突由状态机先认出、重发，不经这里 */
export function classifySaveError(error: unknown): SaveFailure {
  if (conflictDetails(error) !== undefined || incompatibilityOf(error) !== undefined)
    return { kind: 'terminal' }
  if (isAuthenticationError(error) || isCsrfTokenError(error))
    return { kind: 'session' }
  // 服务繁忙（检查池满、每个账户 2 份、数据库繁忙）与请求太频繁：按服务端给的 Retry-After 等
  if (error instanceof ApiError && (error.status === 503 || error.status === 429))
    return { kind: 'retry', retryAfterMs: error.retryAfterSeconds === undefined ? undefined : error.retryAfterSeconds * 1000 }
  if (isDefiniteRejection(error) && !RETRIED_REJECTIONS.has(error.code))
    return { kind: 'content' }
  return { kind: 'retry', retryAfterMs: undefined }
}

function sameKey(a: SnapshotKey | undefined, b: SnapshotKey | undefined): boolean {
  return a !== undefined && b !== undefined && a.digest === b.digest && a.formulasPending === b.formulasPending
}

function recordOf(capture: SnapshotCapture): CaptureRecord {
  return { seq: capture.seq, formulasPending: capture.formulasPending, key: capture.digest === undefined ? undefined : { digest: capture.digest, formulasPending: capture.formulasPending } }
}

export function createSaveCoordinator(options: SaveCoordinatorOptions): SaveCoordinator {
  const { editor, send, clientInstanceId, newRequestId } = options
  const maxSnapshotBytes = options.maxSnapshotBytes ?? SNAPSHOT_MAX_RAW_BYTES
  const listeners = new Set<() => void>()

  let baseRevision = options.baseRevision
  /** 服务端确认过的最大修改序号：打开时是 0（打开不算修改） */
  let savedSeq = 0
  let formulasPending = options.initialFormulasPending ?? false
  /** 排着与进行中的保存的个数：大于 0 时是"保存中" */
  let pendingSaves = 0
  /** 保存一个接一个：最后排上的那一次结束时兑现（从不失败） */
  let tail: Promise<void> = Promise.resolve()
  /** 排着还没开始的那一次不去重的保存（显式保存）：在途时再按，并进它 */
  let queuedExplicit: Promise<SaveOutcome> | undefined
  let stopped = false
  let problem: SaveProblem | undefined
  let conflict: RevisionConflictDetails | null | undefined
  /** 与服务端不兼容（终态） */
  let blocked: Incompatibility | undefined
  /** 最近一次捕获的大小：还没捕获过时是载入的内容的 */
  let snapshotBytes = options.initialSnapshotBytes
  /** 最近一次确认过的内容的键（会话内去重）：打开时不知道（不哈希载入的文本，save() 的写法与存下的字节不同，设计 §3.7） */
  let confirmedKey: SnapshotKey | undefined
  /** 最近一次被拒、再试也一样的内容的键（要等新内容）：去重的保存不再发它；任何一次成功之后清掉 */
  let rejectedKey: SnapshotKey | undefined
  /** 结果未知的保存，按 requestId：冲突的来源是其中之一时，说明它其实已经提交（自己追自己） */
  const unconfirmed = new Map<string, UnconfirmedSave>()
  /** 最近一次结果未知的请求：内容与基准都没变时，重试原样再发它（requestId 与请求的各项都不变） */
  let retryable: SaveRequest | undefined
  /** 转入不兼容的终态之后，正在核对结果没有着落的那次保存（等在途的、原样重发结果未知的，审查 B5、复验 C1，SaveView.checking）：settled 也等它 */
  let verifying: Promise<void> | undefined
  let current = computeView()

  function computeView(): SaveView {
    let status: SaveStatus
    if (conflict !== undefined)
      status = 'conflict'
    else if (blocked !== undefined)
      status = BLOCKED_STATUS[blocked]
    else if (pendingSaves > 0)
      status = 'saving'
    else if (problem !== undefined && problem.kind !== 'cell-editing')
      status = 'failed'
    else
      status = contentUnsaved() ? 'dirty' : 'clean'
    return {
      status,
      formulasPending,
      problem,
      conflict,
      canSave: !stopped && conflict === undefined && blocked === undefined,
      unsaved: conflict !== undefined || contentUnsaved(),
      unsavedEdits: conflict !== undefined || editsUnsaved(),
      checking: verifying !== undefined,
      snapshotBytes,
    }
  }

  /** 终态：版本冲突之后、与服务端不兼容之后都不再保存 */
  function ended(): boolean {
    return conflict !== undefined || blocked !== undefined
  }

  /** 修改有服务端还没确认的部分（不算"公式结果尚未保存"）：确认过的修改序号之后又有修改、单元格里还有没提交的输入 */
  function editsUnsaved(): boolean {
    return editor.changeSeq() > savedSeq || editor.hasPendingCellInput()
  }

  /** 内容有服务端还没确认的部分：修改没确认完，或者公式结果尚未保存 */
  function contentUnsaved(): boolean {
    return editsUnsaved() || formulasPending
  }

  function update(): void {
    const next = computeView()
    const changed = (Object.keys(next) as (keyof SaveView)[]).some(key => next[key] !== current[key])
    if (!changed)
      return
    current = next
    for (const listener of [...listeners])
      listener()
  }

  const unsubscribeEditor = editor.onChange(update)
  const unsubscribeCellEditing = editor.onCellEditingChange(update)

  /** 服务端确认了这次捕获的内容，修订号是 revision */
  function confirm(capture: CaptureRecord, revision: number): void {
    baseRevision = revision
    savedSeq = Math.max(savedSeq, capture.seq)
    formulasPending = capture.formulasPending
    confirmedKey = capture.key
    unconfirmed.clear()
    retryable = undefined
  }

  /**
   * 这次的请求。内容、基准与"公式待更新"都没变：原样再发结果未知的那个请求（服务端按幂等返回原来的结果，或者照常处理）。
   * 同一个 requestId 的请求不变，序号也不换成这次捕获的：服务端记下的来源是第一次的序号，换了就认不出自己追自己（Codex 评审 CX2）。
   * 标记不同就是另一个请求（服务端把它算进负载摘要，M3-P3 设计 §3.8）：换新的 requestId，否则同一个 requestId 会被当成冲突
   */
  function prepare(capture: SnapshotCapture): SaveRequest {
    if (retryable !== undefined && retryable.snapshot === capture.snapshot && retryable.baseRevision === baseRevision && retryable.formulasPending === capture.formulasPending)
      return retryable
    return { baseRevision, requestId: newRequestId(), clientInstanceId, localSeq: capture.seq, snapshot: capture.snapshot, formulasPending: capture.formulasPending }
  }

  /**
   * 来源是本页一次结果未知的保存（冲突的详情、续上时申请得到的当前修订）：那次保存其实已经提交，只是没收到回包。
   * 给出它的 requestId 与记录
   */
  function ownUnconfirmedSave(source: RevisionSource | null | undefined): readonly [string, UnconfirmedSave] | undefined {
    if (source === undefined || source === null || source.clientInstanceId !== clientInstanceId)
      return undefined
    return [...unconfirmed.entries()].find(([, save]) => save.localSeq === source.localSeq)
  }

  /**
   * 这一次发送失败。4xx（冲突也是）说明这一次确定没有提交，其余情况（网络、5xx、回包读不出来）结果未知。
   * earlierUnknown：同一个请求更早的一次发送结果未知，那一次仍可能已经提交，这一次被拒绝（例如 401）也不能说明它没有，
   * 记录与请求都留着，重试照旧原样再发（Codex 评审 CX2）。requestId 被别的请求占用时例外：原样再发也一样，下次换新的
   */
  function fail(error: unknown, request: SaveRequest, earlierUnknown: boolean): void {
    if (!isDefiniteRejection(error)) {
      retryable = request
    }
    else if (!earlierUnknown || (error instanceof ApiError && error.code === 'REQUEST_ID_CONFLICT')) {
      unconfirmed.delete(request.requestId)
      if (retryable?.requestId === request.requestId)
        retryable = undefined
    }
    const details = conflictDetails(error)
    if (details !== undefined) {
      conflict = details
      return
    }
    // 本页与服务端不兼容（M3-P3）：终态，不再保存；说明由状态给出（需要刷新、只能阅读），不另记失败。在途的就是这一次，结果确定
    const incompatible = incompatibilityOf(error)
    if (incompatible !== undefined) {
      enterBlocked(incompatible, false)
      return
    }
    problem = { kind: 'request', error }
    if (isAuthenticationError(error))
      options.onUnauthenticated(error)
    else if (isCsrfTokenError(error))
      options.onSessionStale()
  }

  /**
   * 原样重发最近一次结果未知的保存（见 SaveCoordinator.replayUnknownOutcome）：先等进行中与排着的保存，交回核对的结果，从不失败
   */
  async function replay(): Promise<'none' | 'committed' | 'not-committed' | 'unknown'> {
    await tail
    const request = retryable
    if (request === undefined)
      return 'none'
    const record = unconfirmed.get(request.requestId)
    let body: Uint8Array<ArrayBuffer>
    try {
      body = await options.compress(request.snapshot)
    }
    catch (error) {
      options.reportError(error)
      return 'unknown'
    }
    try {
      const result = await send(request, body)
      // 那一次其实已经提交（重放给出原来的结果）：按它的捕获确认，之前"保存失败"的说明随之不再成立
      if (record !== undefined)
        confirm(record.capture, result.revision)
      if (problem?.kind === 'request' && !isDefiniteRejection(problem.error))
        problem = undefined
      update()
      return 'committed'
    }
    catch (error) {
      // 读不到了（重放也要求能访问）、登录或令牌的问题（到不了重放那一步）：说不准它有没有提交
      if (!isDefiniteRejection(error) || isNotFoundError(error) || isAuthenticationError(error) || isCsrfTokenError(error))
        return 'unknown'
      // 别的确定拒绝（编辑权已失效、不能编辑、修订号冲突、本页过旧等）说明它没有提交：提交过的话重放先于这些检查，会给出原来的结果
      unconfirmed.delete(request.requestId)
      retryable = undefined
      update()
      return 'not-committed'
    }
  }

  /**
   * 转入与服务端不兼容的终态（M3-P3），之后不再保存；已经在终态（冲突、不兼容）时不变。还有一次保存的结果没有着落时先核对它再定说法
   * （审查 B5）：结果未知的那次原样重发一次——重放先于拦截旧客户端与文档的数据格式（设计 §3.1），它其实已经提交时拿到原来的结果、
   * 按它确认（本页的修改可能就都已保存了），没有提交时得到同样的拒绝。saveInFlight：续租得知时正有保存在途（或排着），它们的结果还没有着落，
   * 也要核对（复验 C1）——先等它们（replay 先等进行中与排着的保存；排着的轮到时看到终态就不做）：成功了就是答案，不重发；
   * 以结果未知结束的照样原样重发一次。保存自己得知时（fail）在途的就是得到拒绝的这一次，结果是确定的，不算。核对期间页面先说正在核对
   * （SaveView.checking）。不核对的话，提交了的那次也按"没有保存"说，让人去复制其实已经存上的内容
   */
  function enterBlocked(kind: Incompatibility, saveInFlight: boolean): void {
    if (ended())
      return
    blocked = kind
    if ((retryable !== undefined || saveInFlight) && verifying === undefined) {
      verifying = replay().then(
        () => undefined,
        (error: unknown) => options.reportError(error),
      ).finally(() => {
        verifying = undefined
        update()
      })
    }
    update()
  }

  /** 意外的错误（捕获、压缩）：上报，显示保存失败；没有上传 */
  function unexpected(error: unknown): SaveOutcome {
    problem = { kind: 'unexpected', error }
    options.reportError(error)
    return { kind: 'failed', failure: { kind: 'unexpected' }, requestId: undefined }
  }

  /** 有一次请求的结果还没有着落：服务端上的可能是那一次的内容，不能按确认过的键去重（设计 §3.7） */
  function outcomePending(): boolean {
    return retryable !== undefined || unconfirmed.size > 0
  }

  /** 发出这一次捕获（自己追自己时换上当前修订号重发一次，P4 设计 §3.5.2） */
  async function upload(capture: SnapshotCapture, record: CaptureRecord, body: Uint8Array<ArrayBuffer>): Promise<SaveOutcome> {
    let request = prepare(capture)
    let rebased = false
    for (;;) {
      const earlierUnknown = unconfirmed.has(request.requestId)
      unconfirmed.set(request.requestId, { localSeq: request.localSeq, capture: record, adopted: false })
      try {
        const result = await send(request, body)
        // 原样再发的请求，内容与这次捕获的相同：确认到这次捕获的序号
        confirm(record, result.revision)
        problem = undefined
        rejectedKey = undefined
        return { kind: 'saved', requestId: request.requestId }
      }
      catch (error) {
        // 在途时编辑权续上、认出的正是这一次（基准已按它确认）：它自己的回包随后以结果未知失败，就是提交了、回包丢了——
        // 按成功收尾：不说保存失败，也不留着原样再发（复验 C3）。明确的拒绝照常按失败处理：它说的是这一次没有生效的原因
        // （会话、权限等），要照常交给页面
        if (!isDefiniteRejection(error) && unconfirmed.get(request.requestId)?.adopted === true) {
          problem = undefined
          rejectedKey = undefined
          return { kind: 'saved', requestId: request.requestId }
        }
        const details = conflictDetails(error)
        const own = rebased ? undefined : ownUnconfirmedSave(details?.source)
        if (own === undefined || details === undefined || details === null) {
          fail(error, request, earlierUnknown)
          const failure = classifySaveError(error)
          if (failure.kind === 'content')
            rejectedKey = record.key
          return { kind: 'failed', failure, requestId: request.requestId }
        }
        // 那次保存已经提交：它就是当前修订。换上当前修订号作基准，用新的 requestId 重发这一次的内容
        confirm(own[1].capture, details.currentRevision)
        request = prepare(capture)
        rebased = true
      }
    }
  }

  /** 轮到的这一次保存：向来源要捕获，检查体积、去重，压缩，发出 */
  async function attempt(source: CaptureSource, saveOptions: SaveOptions): Promise<SaveOutcome> {
    if (stopped)
      return SKIPPED_STOPPED
    if (ended())
      return SKIPPED_ENDED
    let prepared: PreparedCapture
    try {
      prepared = await source()
    }
    catch (error) {
      // 提交编辑、等公式收齐、捕获时出了意外：显示保存失败，而不是悄悄回到"有未保存的修改"（审查 B5）
      return unexpected(error)
    }
    if (prepared === 'cell-editing') {
      problem = { kind: 'cell-editing' }
      return { kind: 'failed', failure: { kind: 'cell-editing' }, requestId: undefined }
    }
    // 准备期间（提交单元格、等公式）停住了或者到了终态：不发
    if (stopped)
      return SKIPPED_STOPPED
    if (ended())
      return SKIPPED_ENDED
    const capture = prepared
    snapshotBytes = capture.bytes
    if (capture.bytes > maxSnapshotBytes) {
      problem = { kind: 'too-large' }
      return { kind: 'failed', failure: { kind: 'content' }, requestId: undefined }
    }
    const record = recordOf(capture)
    if (saveOptions.dedupe) {
      // 服务端已经有一模一样的内容（与标记）：不上传，按这次捕获的序号确认（基准不变）
      if (sameKey(record.key, confirmedKey) && !outcomePending()) {
        confirm(record, baseRevision)
        problem = undefined
        return DEDUPED
      }
      // 同样的内容刚被拒过、再试也一样：不再发，说明照旧
      if (sameKey(record.key, rejectedKey))
        return { kind: 'failed', failure: { kind: 'content' }, requestId: undefined }
    }
    let body: Uint8Array<ArrayBuffer>
    try {
      // 压缩是本地的一步：出错按意外的错误处理，不当作结果未知的请求（复验 RB8）
      body = await options.compress(capture.snapshot)
    }
    catch (error) {
      return unexpected(error)
    }
    return upload(capture, record, body)
  }

  return {
    view: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    baseRevision: () => baseRevision,
    adoptOwnRevision: (revision, source) => {
      if (ended())
        return false
      const own = ownUnconfirmedSave(source)
      if (own === undefined)
        return false
      const [requestId, save] = own
      confirm(save.capture, revision)
      // 记录留着，记下是认出的：保存先得知编辑权中断时，在途的那一次是按旧的基准发出的，续上之后重发会得到冲突，来源正是它，
      // 照常按自己追自己换上新的基准；认出的正是在途的那一次时，它自己的回包随后以结果未知失败就按成功收尾（复验 C3）。
      // 下一次确认时清掉
      unconfirmed.set(requestId, { ...save, adopted: true })
      // 那次结果未知的失败已经有了答案（其实已经提交），不再说"保存失败"；之后又有的修改照常是"有未保存的修改"
      if (problem?.kind === 'request' && !isDefiniteRejection(problem.error))
        problem = undefined
      update()
      return true
    },
    // 排队（pendingSaves、tail、queuedExplicit）在第一个 await 之前同步完成：调用之后视图立即是"保存中"，先后按调用的顺序
    save: async (source, saveOptions) => {
      if (stopped)
        return SKIPPED_STOPPED
      if (ended())
        return SKIPPED_ENDED
      // 显式保存在途时按下排一次，再按并进排着的那一次（它轮到时才捕获，捕获的是那一刻的内容）
      if (!saveOptions.dedupe && queuedExplicit !== undefined)
        return queuedExplicit
      pendingSaves += 1
      update()
      const run = async (): Promise<SaveOutcome> => {
        if (!saveOptions.dedupe)
          queuedExplicit = undefined
        try {
          return await attempt(source, saveOptions)
        }
        catch (error) {
          // 保存流程本身出了意外（请求本身的失败在 attempt 里已经归类）：显示保存失败，save 不会被拒绝，链也不断
          return unexpected(error)
        }
        finally {
          pendingSaves -= 1
          update()
        }
      }
      const outcome = tail.then(run)
      tail = outcome.then(() => undefined)
      if (!saveOptions.dedupe)
        queuedExplicit = outcome
      return outcome
    },
    noteCapture: (capture) => {
      snapshotBytes = capture.bytes
      update()
    },
    captureFailed: (error) => {
      options.reportError(error)
      if (ended())
        return
      problem = { kind: 'unexpected', error }
      update()
    },
    settled: async () => {
      await tail
      await verifying
    },
    hasUnknownOutcome: () => retryable !== undefined,
    replayUnknownOutcome: replay,
    hasUnsavedWork: () => conflict !== undefined || pendingSaves > 0 || editor.isCellEditing() || editor.changeSeq() > savedSeq || formulasPending,
    block: kind => enterBlocked(kind, pendingSaves > 0),
    stop: () => {
      stopped = true
      update()
    },
    resume: () => {
      stopped = false
      update()
    },
    dismissSessionProblem: () => {
      if (problem?.kind === 'request' && (isAuthenticationError(problem.error) || isCsrfTokenError(problem.error))) {
        problem = undefined
        update()
      }
    },
    dispose: () => {
      unsubscribeEditor()
      unsubscribeCellEditing()
      listeners.clear()
    },
  }
}
