import type { ClientFormat, EditLeaseLostDetails, EditTakeoverMode } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { Principal } from '../auth/index.ts'
import type { Transaction } from '../database/index.ts'
import type { DocumentOperation } from './document-access-policy.ts'
import type { RevisionSource } from './document-revisions.repository.ts'
import type { LeaseClaim, LeaseInterruption, LeaseLoss, LeaseOccupancy, LeaseReservation } from './edit-lease-rules.ts'
import type { ObservedEditLease } from './edit-leases.repository.ts'
import type { SlotRequest } from './edit-request-rules.ts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { AuditService } from '../audit/index.ts'
import { SessionService } from '../auth/index.ts'
import { AppLogger } from '../logging/index.ts'
import { ClientFormatGate, requireWritableDocument } from './client-format-gate.ts'
import { DocumentAccessPolicy, requireAccess, requireDocumentContent } from './document-access-policy.ts'
import { DocumentRevisionsRepository } from './document-revisions.repository.ts'
import { DocumentsRepository } from './documents.repository.ts'
import { holderFactsOf, partyFactsOf } from './edit-lease-facts.ts'
import { claimOf, occupancyOf, releasableBy, requestLeaseLoss, reservationOf } from './edit-lease-rules.ts'
import { editLeaseTokenDigest, generateEditLeaseToken } from './edit-lease-token.ts'
import { EditLeasesRepository } from './edit-leases.repository.ts'
import { pendingRequestOf } from './edit-request-rules.ts'
import { revisionSourceFor } from './revision-source.ts'

/** 编辑权的调用者（M3-P1 设计 §3.4）：账户与这次登录——租约绑定"这个标签页、这次登录"，判断别人的租约也要知道是不是自己 */
export interface EditingActor {
  readonly userId: string
  readonly sessionId: string
}

/** 当前登录的人作为编辑权的调用者：会话守卫认证过的账户与会话 */
export function editingActorOf(principal: Principal): EditingActor {
  return { userId: principal.user.id, sessionId: principal.sessionId }
}

/**
 * 持有者自己的请求（申请、心跳、保存）在事务里、锁下再核对一次这次登录仍然有效（M3-P1 审查 A1）：会话守卫在处理器之前判断过，
 * 之后到这一步还隔着上传正文、等锁的时间，这期间退出、签发重置（撤销这个人的全部登录，"强制结束编辑"）、换令牌都不经文档行与租约行，
 * 挡不住在途的请求。核对的口径在 auth（SessionService.requireActive，本机密钥的取用共用，M3-P6）：失效时 401 SESSION_EXPIRED，不动 Cookie
 */
export async function requireActiveLogin(sessions: SessionService, actor: EditingActor, transaction: Transaction): Promise<void> {
  await sessions.requireActive(actor.sessionId, transaction)
}

/**
 * 持有者自己的请求（心跳、保存；M3-P5 的交出、谢绝同样，EditRequestService）发现请求的那一代已经失效：409 EDIT_LEASE_LOST，details 就是失效的原因与详情
 * （requestLeaseLoss 给出的，被接管时另带 forced），结构是 contracts 的 editLeaseLostDetailsSchema。几处共用这一个写法，免得哪一处漏了 forced
 */
export function editLeaseLost(loss: LeaseLoss): AppError {
  const details: EditLeaseLostDetails = loss
  return new AppError('EDIT_LEASE_LOST', undefined, { details })
}

/**
 * 申请编辑权的请求（P1 设计 §3.4.2）：标签页，接管方式（M3-P5 设计 §3.7、§3.8：本人接管 self、强制接管 force，普通的申请没有），
 * 续上的页面带来的本页空闲秒数（M3-P5 设计 §3.5：新的一代的最后活动按它往前推，服务端的空闲兜底不因续上而重新计时；别的申请是 0；
 * 契约限它比回收阈值短，新的一代不会一出生就按空闲失效，审查 A4），与页面上报的构建与数据格式（M3-P3 设计 §3.5）
 */
export interface LeaseRequest {
  readonly clientInstanceId: string
  readonly takeover: EditTakeoverMode | undefined
  readonly idleSeconds: number
  readonly format: ClientFormat
}

/** 心跳续租的请求：本页多久没有操作（秒），与页面上报的构建与数据格式（M3-P3 设计 §3.5：服务端升级之后，正在编辑的页面一次心跳之内就知道） */
export interface RenewalRequest {
  readonly idleSeconds: number
  readonly format: ClientFormat
}

/**
 * 正在编辑的人（编辑状态的 editor、被占用时的详情、请求编辑的结果）：持有者、他的最后活动时间、他是不是调用者自己（sameUser），
 * 以及他的租约绑定的是不是调用者这次登录（sameSession，M3-P5 设计 §3.3：同一个浏览器的标签页共用登录，页面据此走同一个浏览器的交接）
 */
export interface LeaseEditor {
  readonly holderId: string
  readonly lastActiveAt: Date
  readonly sameUser: boolean
  readonly sameSession: boolean
}

/**
 * 有人在请求编辑（M3-P5 设计 §3.3，编辑状态与被占用的详情）：待回应的请求的请求方、发出的时刻，以及请求方是不是调用者自己（mine）。
 * 不带请求的标识：交出、谢绝只由持有者经心跳拿到它（PendingRequest）
 */
export interface LeaseRequestView {
  readonly requesterId: string
  readonly requestedAt: Date
  readonly mine: boolean
}

/** 交出之后的保留（M3-P5 设计 §3.3，编辑状态）：留给谁、留到何时，以及留给的是不是调用者自己（mine） */
export interface LeaseReservationView extends LeaseReservation {
  readonly mine: boolean
}

/** 心跳带给持有者的待回应的请求（M3-P5 设计 §3.3）：标识（交出、谢绝时带上）、请求方、发出的时刻 */
export interface PendingRequest {
  readonly id: string
  readonly requesterId: string
  readonly requestedAt: Date
}

/** 续租的结果：新的到期时间，与待回应的请求编辑（M3-P5 设计 §3.3，没有时为 undefined） */
export interface LeaseRenewal {
  readonly expiresAt: Date
  readonly request: PendingRequest | undefined
}

/**
 * 申请的结果（P1 设计 §3.4.2）：
 * - acquired：取得了新的一代（普通的申请、页面自己的重试、本人接管或强制接管，M3-P5 设计 §3.7、§3.8）——令牌（只在这里出现一次）、
 *   这一代的代次、文档当前的修订号与它的来源（新建、复制出来的为 null）、到期时间，上一个租约异常结束的提醒（接管时没有：占着的那一代
 *   是有效的；带上那一代是不是申请的这个页面自己的，samePage），与文档的"公式待更新"（M3-P3 设计 §3.8：P4 据此在进入编辑时先全量重算）；
 * - held：有效的租约在别人手里（同一个人在别的标签页或设备上也算），或者代次过时、其余都还活着的租约在别人手里（M3-P5 设计 §3.5
 *   的 R2：只让持有者本人续上），申请又没有能起作用的接管方式（见 claimOf），什么也没写；正在编辑的人、调用者能不能强制接管
 *   （M3-P5，锁下判断权限时算出的那一位）与有没有人在请求编辑（M3-P5 设计 §3.3，待回应的）。workspace 补上人名，回 EDIT_LEASE_HELD；
 * - reserved：没人占着，而交出之后的保留留给了别人、还在保留期内（M3-P5 设计 §3.6：本人接管、强制接管同样挡），什么也没写。
 *   workspace 补上人名，回 EDIT_LEASE_RESERVED
 */
export type LeaseAcquisition
  = | {
    readonly kind: 'acquired'
    readonly token: string
    readonly writeEpoch: number
    readonly revision: number
    readonly source: RevisionSource | null
    readonly expiresAt: Date
    readonly interruption: LeaseInterruption | undefined
    readonly formulasPending: boolean
  }
  | ({ readonly kind: 'held', readonly canTakeOver: boolean, readonly request: LeaseRequestView | undefined } & LeaseEditor)
  | ({ readonly kind: 'reserved' } & LeaseReservation)

/**
 * 编辑状态（P1 设计 §3.4.3）：文档当前的修订号，谁在编辑（从调用者看占着这份文档的人，没有时为 undefined），
 * 调用者现在能不能编辑、能不能强制接管这份文档（M3-P2 设计 §3.2：阅读页据此显示或隐藏"编辑"；M3-P5 设计 §3.8），
 * 文档的"公式待更新"（M3-P3 设计 §3.8），有人在请求编辑（待回应的，没有时为 undefined）与交出之后的保留（算数的，没有时为 undefined；
 * M3-P5 设计 §3.3、§3.6），以及没人在编辑时上一个租约异常结束的提醒（M3-P5 设计 §3.5：阅读页不必等点"编辑"；
 * 有人在编辑、没有异常结束或已经超过 30 分钟时为 undefined；看编辑状态的没有页面，samePage 恒为假，接口里也不给）
 */
export interface LeaseStatus {
  readonly revision: number
  readonly editor: LeaseEditor | undefined
  readonly canEdit: boolean
  readonly canTakeOver: boolean
  readonly formulasPending: boolean
  readonly request: LeaseRequestView | undefined
  readonly reservation: LeaseReservationView | undefined
  readonly interruption: LeaseInterruption | undefined
}

/** 占着这份文档的租约在谁手里，从调用者看（LeaseEditor）：是不是本人按账户比，是不是这次登录按租约绑定的登录比 */
export function editorOf(lease: ObservedEditLease, actor: EditingActor): LeaseEditor {
  return { holderId: lease.holderId, lastActiveAt: lease.lastActiveAt, sameUser: lease.holderId === actor.userId, sameSession: lease.sessionId === actor.sessionId }
}

/** 待回应的请求从调用者看（编辑状态、被占用的详情）：请求方是不是他自己按账户比；没有待回应的请求时为 undefined */
function requestViewOf(request: SlotRequest | undefined, actor: EditingActor): LeaseRequestView | undefined {
  return request === undefined ? undefined : { requesterId: request.requesterId, requestedAt: request.requestedAt, mine: request.requesterId === actor.userId }
}

/**
 * 取得新的一代时日志里上一代的情形（不记令牌）：没人占着时是它失效的原因（none、到期、空闲……），页面自己的重试记 retry，
 * 接管记 taken_over 与方式（self、forced）
 */
function previousOf(claim: LeaseClaim, occupancy: LeaseOccupancy): Readonly<Record<string, string>> {
  if (claim.kind === 'takeOver')
    return { previous: 'taken_over', takeover: claim.takeover }
  return { previous: occupancy.kind === 'vacant' ? occupancy.loss : 'retry' }
}

/**
 * 编辑租约（M3-P1 设计 §3.4.2、§3.4.3）：申请、心跳续租、释放与编辑状态的规则与数据。事务由调用方（workspace 的
 * DocumentEditingService）开：写的三个在一个业务事务里，编辑状态在只读快照里；人名由 workspace 经 users 补上（documents 不依赖 users）。
 * 请求编辑与交出（M3-P5 设计 §3.6）的接口在 EditRequestService；这里的申请判断交出之后的保留，心跳、编辑状态与被占用的详情带上待回应的请求。
 * 有效条件在 edit-lease-rules.ts，这里按步骤取事实、加锁：
 * - 失去访问与失去编辑权先于租约判断（§3.2）：读不到 404，能读不能编辑 403，之后才看租约；看不到的请求不取任何锁，
 *   与不存在的文档执行同样的语句（permissions/hidden-missing-parity 核对）；
 * - 锁的顺序是文档行（FOR UPDATE）→ 租约行（§3.4.6，ADR-014 的锁顺序表在文档行之后加上租约行）：申请先锁文档行再锁租约行；
 *   心跳与释放只锁租约行，与申请、收回写入权按租约行串行，不成环；
 * - 时间一律取数据库的 now()：租约行与同一条语句里的 now() 一起读出来（ObservedEditLease）；
 * - 页面的构建与数据格式（M3-P3 设计 §3.5）：申请与心跳先核对它（与文档无关，在任何查询之前：看不到与不存在的文档得到同样的回答），
 *   过旧时 CLIENT_OUTDATED；文档由比服务端新的版本写过（回滚之后）时 DOCUMENT_TOO_NEW，在判断访问与编辑权之后。
 * 申请、续租、释放都不写审计（太频繁，结束的原因留在租约行上，设计 §3.5）；只有强制接管写（M3-P5 设计 §3.8、§3.13：结束的是别人的编辑权），
 * 与租约行在同一个事务里、排在它之后（锁的顺序：文档行 → 租约行 → 审计）。令牌不进日志
 */
@Injectable()
export class EditLeaseService {
  readonly #logger: AppLogger

  constructor(
    private readonly documents: DocumentsRepository,
    private readonly revisions: DocumentRevisionsRepository,
    private readonly leases: EditLeasesRepository,
    private readonly policy: DocumentAccessPolicy,
    private readonly sessions: SessionService,
    private readonly clients: ClientFormatGate,
    private readonly audit: AuditService,
    logger: AppLogger,
  ) {
    this.#logger = logger.with({ module: 'documents' })
  }

  /**
   * 申请（P1 设计 §3.4.2）：页面的构建与数据格式（CLIENT_OUTDATED，M3-P3）→ 不加锁判断能编辑（404 / 403；强制接管另要能强制接管，
   * M3-P5 设计 §3.8）→ 锁文档行、锁下再判断同样几项 → 锁租约行 → 这次登录仍然有效（否则 401，requireActiveLogin：撤销登录之后才到这一步的
   * 在途申请不写下绑定失效登录的租约）→ 文档的格式（比服务端新：DOCUMENT_TOO_NEW，M3-P3，锁下读到的文档行）→ 从申请的人看谁占着
   * 这份文档（occupancyOf）→ 申请怎样对待占着的那一代（claimOf）：
   * - 没人占着：普通的申请（带了接管方式也一样，不写接管标记、不写审计）；
   * - 占着的是这个页面自己的那一代（同一个登录、同一个标签页，例如上次申请的回包丢了）：重试，照样发新的一代，接管标记由仓储沿用；
   * - 本人接管（M3-P5 设计 §3.7：占着的是自己在别的标签页、设备上的有效租约）、强制接管（§3.8：占着的是别人，有效的或 R2 的）：
   *   发新的一代并记下接管标记（被接管那一代的令牌摘要与方式），旧令牌之后得到 taken_over；强制接管另写一条审计 documents.edit_taken_over
   *   （操作者、文档、被接管的人、来源），在租约行之后；
   * - 其余是被占用（别人的有效租约或 R2；自己在别处的有效租约而没带接管方式；本人接管遇到别人），什么也不写，详情另带待回应的请求。
   * 没人占着时先看交出之后的保留（M3-P5 设计 §3.6）：保留算数、留给的不是申请的人，回答 reserved、什么也不写——保留只在交出（明确结束）
   * 之后有，那时没人占着、claimOf 一律是普通的申请，所以本人接管、强制接管同样被挡，不必另判断；留给的就是申请的人时照常取得
   * （用哪个标签页、哪次登录都行），新的一代清掉保留。
   * 发新的一代：文档的代次加一、生成令牌、改写租约行（最后活动按续上的页面带来的空闲往前推）→ 上一个租约按事实异常结束、
   * 而且在 30 分钟以内时给出提醒，带上那一代是不是申请的这个页面自己的（samePage：同一个人、同一个标签页，页面据此不说）。修订号取锁下的文档行：页面拿它与自己载入的比较。连同这一版的来源（这一条修订记录的标签页与本地序号，
   * 与修订号冲突的详情同一个取法，只给保存这一版的人本人，见 revisionSourceFor）：续上时页面据此认出期间的那一版是不是本页自己
   * 一次结果未知的保存（00 号计划书 §7.5）
   */
  async acquire(actor: EditingActor, documentId: string, request: LeaseRequest, origin: AuditOrigin, transaction: Transaction): Promise<LeaseAcquisition> {
    const { clientInstanceId, takeover, idleSeconds } = request
    this.clients.require(request.format)
    const operations: readonly DocumentOperation[] = takeover === 'force' ? ['edit', 'takeOver'] : ['edit']
    await requireDocumentContent(this.policy, actor.userId, await this.documents.findById(documentId, transaction), operations, transaction)
    const { document, permissions } = await requireDocumentContent(this.policy, actor.userId, await this.documents.lockById(documentId, transaction), operations, transaction)
    const current = await this.leases.lockByDocument(documentId, transaction)
    // 两把锁都在手里之后才查：之后到提交只剩判断与几条写，窗口最短
    await requireActiveLogin(this.sessions, actor, transaction)
    requireWritableDocument(document)
    const occupancy = await occupancyOf(current, document.writeEpoch, actor.userId, holderFactsOf(this.sessions, this.policy, current, document, transaction), clientInstanceId)
    const claim = claimOf(occupancy, { ...actor, clientInstanceId }, takeover)
    const parties = partyFactsOf(this.sessions, this.policy, document, transaction)
    if (claim.kind === 'held') {
      const editor = editorOf(claim.lease, actor)
      this.#logger.debug('申请编辑权：有效的租约在别人手里', { documentId, sameUser: editor.sameUser, sameSession: editor.sameSession, stale: occupancy.kind === 'occupied' && occupancy.stale })
      return { kind: 'held', ...editor, canTakeOver: permissions.canTakeOver, request: requestViewOf(await pendingRequestOf(claim.lease, parties), actor) }
    }
    if (claim.kind === 'fresh') {
      const reservation = await reservationOf(current, parties.canEdit)
      if (reservation !== undefined && reservation.reservedFor !== actor.userId) {
        this.#logger.debug('申请编辑权：编辑权留给了别人', { documentId, takeover })
        return { kind: 'reserved', ...reservation }
      }
    }
    const writeEpoch = await this.documents.advanceWriteEpoch(documentId, transaction)
    const token = generateEditLeaseToken()
    const lease = await this.leases.replace({
      documentId,
      holderId: actor.userId,
      sessionId: actor.sessionId,
      clientInstanceId,
      tokenDigest: editLeaseTokenDigest(token),
      writeEpoch,
      idleSeconds,
      takenOver: claim.kind === 'takeOver' ? { tokenDigest: claim.lease.tokenDigest, takeover: claim.takeover } : undefined,
    }, transaction)
    if (claim.kind === 'takeOver' && claim.takeover === 'forced') {
      await this.audit.record({
        action: 'documents.edit_taken_over',
        actor: { type: 'user', id: actor.userId },
        target: { type: 'document', id: documentId },
        origin,
        details: { holderId: claim.lease.holderId },
      }, { transaction })
    }
    // 文档行在锁下：这一版不会再变
    const revision = await this.revisions.findByRevision(documentId, document.revision, transaction)
    // 上一个租约的情形只记原因（none、到期、空闲……，同一个页面的重试记 retry，接管记 taken_over 与方式），不记令牌
    this.#logger.debug('申请编辑权：取得新的一代', { documentId, writeEpoch, ...previousOf(claim, occupancy) })
    return {
      kind: 'acquired',
      token,
      writeEpoch,
      revision: document.revision,
      source: revisionSourceFor(revision, actor.userId),
      expiresAt: lease.expiresAt,
      interruption: occupancy.kind === 'vacant' ? occupancy.interruption : undefined,
      // 文档行在锁下：这个标记直到本页保存之前不会再变（改它的只有持有者的保存）
      formulasPending: document.formulasPending,
    }
  }

  /**
   * 心跳续租（P1 设计 §3.4.3）：页面的构建与数据格式（CLIENT_OUTDATED，M3-P3：服务端升级、运维开关调高之后，正在编辑的页面一次心跳之内就停下）→
   * 不加锁判断能编辑（404 / 403）→ 锁租约行 → 这次登录仍然有效（否则 401，requireActiveLogin）→
   * 再读文档当前的代次 → 文档的格式（DOCUMENT_TOO_NEW，M3-P3）→ 按有效条件判断（持有者自己的请求）→ 有效就续租，否则先再判断一次能编辑（见下）、再回 EDIT_LEASE_LOST
   * （details 带原因；被接管时是 taken_over 与 forced，M3-P5 设计 §3.7、§3.8，页面据此不续上）。代次在锁住租约行之后才读：收回写入权与新的申请
   * （含接管）都先锁文档行、再锁租约行，改代次在前；锁住租约行之后再读，它们要么已经提交（读到新的代次与改写过的租约），要么还在等这把锁。
   * 失效时先再判断一次能编辑（M3-P1 审查 A2）：等租约行的锁期间权限可能刚被收回——撤权先锁文档行、再锁租约行、结束租约之后提交，这时读到的是
   * 结束了的租约（revoked），而失去访问与失去编辑权要先于租约回答（§3.2：404 / 403），页面据此区分"还读得到就给副本"与"读不到就丢弃"。
   * 别的原因同样先判断：权限的变化与哪种失效都可能同时发生；只在失败的路上多两条语句。
   * 不锁文档行：读不到了（锁住租约行之前被删、被永久删除）按读不到回答（NOT_FOUND）。
   * 续租之后带上待回应的请求编辑（M3-P5 设计 §3.3、§3.6：持有者最多约一个心跳周期之后得知；已谢绝、已失效的不给），
   * 请求在租约行上、锁下读到的就是最终的；有请求时多问请求方的登录与编辑权两条
   */
  async renew(actor: EditingActor, documentId: string, request: RenewalRequest, token: string | undefined, transaction: Transaction): Promise<LeaseRenewal> {
    this.clients.require(request.format)
    await requireDocumentContent(this.policy, actor.userId, await this.documents.findById(documentId, transaction), ['edit'], transaction)
    const lease = await this.leases.lockByDocument(documentId, transaction)
    await requireActiveLogin(this.sessions, actor, transaction)
    const document = await this.documents.findById(documentId, transaction)
    if (document === undefined)
      throw new AppError('NOT_FOUND')
    requireWritableDocument(document)
    const loss = requestLeaseLoss(lease, document.writeEpoch, { token, sessionId: actor.sessionId })
    if (loss !== undefined) {
      await requireDocumentContent(this.policy, actor.userId, document, ['edit'], transaction)
      throw this.lost(documentId, loss)
    }
    const renewed = await this.leases.renew(documentId, request.idleSeconds, transaction)
    const pending = await pendingRequestOf(renewed, partyFactsOf(this.sessions, this.policy, document, transaction))
    return { expiresAt: renewed.expiresAt, request: pending === undefined ? undefined : { id: pending.id, requesterId: pending.requesterId, requestedAt: pending.requestedAt } }
  }

  /**
   * 释放（P1 设计 §3.4.3）：能访问就行（读不到 404，看不到与不存在一致）→ 锁租约行 → 令牌是当前这一行的、没有明确结束、
   * 释放的人就是持有者（M3-P1 审查 A4，见 releasableBy），就记 released；其余情况（没带令牌、令牌不对、已经结束、不是持有者）什么也不做。
   * 调用方一律回 204：页面关闭时的 keepalive 请求不看结果
   */
  async release(actor: EditingActor, documentId: string, token: string | undefined, transaction: Transaction): Promise<void> {
    await requireAccess(this.policy, actor.userId, await this.documents.findById(documentId, transaction), transaction)
    const lease = await this.leases.lockByDocument(documentId, transaction)
    if (releasableBy(lease, token, actor.userId))
      await this.leases.end(documentId, 'released', transaction)
  }

  /**
   * 编辑状态（P1 设计 §3.4.3）：在调用方开的只读快照里（ADR-017），能读就能看（读不到 404）→ 读租约行 → 从调用者看谁占着这份文档
   * （occupancyOf：第 6、7 条查持有者的登录与编辑权，同一个快照；与申请同一个判断，阅读页显示有人在编辑时点"编辑"得到的就是被占用）→
   * 修订号，有人在编辑时是他（持有者、最后活动时间、是不是调用者自己、是不是调用者这次登录），没人在编辑时是上一个租约异常结束的提醒
   * （M3-P5 设计 §3.5，与申请同一个算法）。调用者能不能编辑（M3-P2 设计 §3.2）、能不能强制接管（M3-P5 设计 §3.8）：就是判断能读时
   * 算出的权限位（requireDocumentContent，与详情的 permissions、保存与申请看的同一套），不另查询。
   * M3-P5 设计 §3.3、§3.6：槽里待回应的请求（所有能读的人都看得到，mine 按调用者算；与心跳同一个判断——不论这时有没有人占着：
   * 持有者的页面不在了、释放了而请求方还在等，请求照样算数，持有者续上之后沿用），与算数的保留（只在交出之后、没人占着时有，
   * mine 按调用者算）。有请求时多问请求方的登录与编辑权，有保留时多问被保留的人的编辑权，都在同一个快照里
   */
  async status(actor: EditingActor, documentId: string, transaction: Transaction): Promise<LeaseStatus> {
    const { document, permissions } = await requireDocumentContent(this.policy, actor.userId, await this.documents.findById(documentId, transaction), [], transaction)
    const lease = await this.leases.findByDocument(documentId, transaction)
    const occupancy = await occupancyOf(lease, document.writeEpoch, actor.userId, holderFactsOf(this.sessions, this.policy, lease, document, transaction))
    const parties = partyFactsOf(this.sessions, this.policy, document, transaction)
    const request = requestViewOf(await pendingRequestOf(lease, parties), actor)
    const reservation = await reservationOf(lease, parties.canEdit)
    return {
      revision: document.revision,
      editor: occupancy.kind === 'occupied' ? editorOf(occupancy.lease, actor) : undefined,
      canEdit: permissions.canEdit,
      canTakeOver: permissions.canTakeOver,
      formulasPending: document.formulasPending,
      request,
      reservation: reservation === undefined ? undefined : { ...reservation, mine: reservation.reservedFor === actor.userId },
      interruption: occupancy.kind === 'vacant' ? occupancy.interruption : undefined,
    }
  }

  /** 编辑权已失效：记一条日志（文档、原因与被接管的方式，不记令牌），details 带原因与被接管的方式（editLeaseLost） */
  private lost(documentId: string, loss: LeaseLoss): AppError {
    this.#logger.debug('续租失败：编辑权已失效', { documentId, reason: loss.reason, forced: loss.forced })
    return editLeaseLost(loss)
  }
}
