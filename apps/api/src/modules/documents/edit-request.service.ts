import type { ClientFormat } from '@nerve-office/contracts'
import type { Transaction } from '../database/index.ts'
import type { DocumentRow } from './documents.repository.ts'
import type { LeaseLoss, LeaseReservation } from './edit-lease-rules.ts'
import type { EditingActor, LeaseEditor } from './edit-lease.service.ts'
import type { ObservedEditLease } from './edit-leases.repository.ts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { SessionService } from '../auth/index.ts'
import { AppLogger } from '../logging/index.ts'
import { ClientFormatGate } from './client-format-gate.ts'
import { DocumentAccessPolicy, requireAccess, requireDocumentContent } from './document-access-policy.ts'
import { DocumentsRepository } from './documents.repository.ts'
import { holderFactsOf, partyFactsOf } from './edit-lease-facts.ts'
import { occupancyOf, requestLeaseLoss } from './edit-lease-rules.ts'
import { editLeaseLost, editorOf, requireActiveLogin } from './edit-lease.service.ts'
import { EditLeasesRepository } from './edit-leases.repository.ts'
import { decideRequestRenewal, decideRequestSend, requestStandingOf, slotRequestOf } from './edit-request-rules.ts'

/**
 * 请求编辑的结果（contracts 的 EditRequestOutcome，人名由 workspace 补上）：发出与续期的响应，按 kind 区分，见 decideRequestSend、
 * decideRequestRenewal——
 * - pending：在等待：请求的标识、发出的时刻、有效期（续期往后推的那一个）与正在编辑的人；
 * - declined：持有者谢绝了（请求的标识与谢绝的人）；reserved：交出之后留给了调用者；free：没人在编辑；
 * - self：正在编辑的是调用者自己；occupied：别人先请求了（请求方、发出的时刻）；reservedForOther：编辑权刚交给了别人；
 * - gone：只出现在续期，调用者的请求已不在（现在正在编辑的人，没有时为 undefined）
 */
export type RequestOutcome
  = | { readonly kind: 'pending', readonly id: string, readonly requestedAt: Date, readonly expiresAt: Date, readonly holder: LeaseEditor }
    | { readonly kind: 'declined', readonly id: string, readonly holder: LeaseEditor }
    | { readonly kind: 'reserved', readonly reservedUntil: Date }
    | { readonly kind: 'free' }
    | { readonly kind: 'self', readonly holder: LeaseEditor }
    | { readonly kind: 'occupied', readonly requesterId: string, readonly requestedAt: Date }
    | ({ readonly kind: 'reservedForOther' } & LeaseReservation)
    | { readonly kind: 'gone', readonly holder: LeaseEditor | undefined }

/** 锁住租约行之后的这份文档与它的租约行（请求编辑的几个写路径共用的开头） */
interface LockedLease {
  readonly lease: ObservedEditLease | undefined
  readonly document: DocumentRow
}

/**
 * 请求编辑与交出（M3-P5 设计 §3.4、§3.6，US-M3-06）：请求方的发出、续期与取消，持有者的谢绝与交出。事务由调用方（workspace 的
 * DocumentEditingService）开，人名由 workspace 补上。请求记在租约行上（单槽、先到先得），规则在 edit-request-rules.ts 与 edit-lease-rules.ts，
 * 这里按步骤取事实、加锁、写：
 * - 失去访问与失去编辑权先于租约判断（404 在 403 之前）：发出、续期、谢绝、交出要能编辑，取消能读就行；看不到的请求不读租约行、
 *   不取任何锁，与不存在的文档执行同样的语句（permissions/hidden-missing-parity 核对）；
 * - 都只锁租约行（设计 §3.12，与心跳、释放同一类），锁住之后再读文档的代次：申请（含接管）与收回写入权都先锁文档行、再锁租约行、
 *   改代次在前，锁住租约行之后再读，它们要么已经提交，要么还在等这把锁。这几条写路径只改请求、保留与"结束"几列，不改持有者、令牌、
 *   代次（为什么保存不加锁读租约行仍然安全见 EditLeasesRepository 的类注释）；
 * - 写下与请求方登录绑定的东西、或者凭令牌改动租约之前，在锁下按主键再核对这次登录（requireActiveLogin，M3-P1 审查 A1）：
 *   发出、续期、谢绝、交出；取消只清掉调用者自己的请求与留给他的保留，与释放一样不核对（页面关闭时 keepalive 发的，不看结果）；
 * - 发出是用户的操作，按页面上报的格式先拦旧页面（CLIENT_OUTDATED，在任何查询之前：看不到与不存在的文档得到同样的回答），
 *   免得编辑权交给一个之后申请不了的页面；续期是页面自己每 5 秒发的后台请求，不带格式。
 * 各操作按"同一个人的同一件事"天然幂等，不需要 requestId 的账本：请求已有就续期；谢绝、取消对不上就什么也不做；交出的重试得到
 * 失效的原因 handed_over（这一代已经明确结束）。都不写审计（总设计只要求强制接管记审计），交出是明确结束，不给异常中断的提醒
 */
@Injectable()
export class EditRequestService {
  readonly #logger: AppLogger

  constructor(
    private readonly documents: DocumentsRepository,
    private readonly leases: EditLeasesRepository,
    private readonly policy: DocumentAccessPolicy,
    private readonly sessions: SessionService,
    private readonly clients: ClientFormatGate,
    logger: AppLogger,
  ) {
    this.#logger = logger.with({ module: 'documents' })
  }

  /**
   * 发出请求编辑（POST，设计 §3.6）：页面的构建与数据格式（CLIENT_OUTDATED）→ 能编辑（404 / 403）→ 锁租约行 → 这次登录仍然有效 →
   * 再读文档 → 从调用者看谁占着这份文档（occupancyOf）→ 怎样回答（decideRequestSend）：占着的是别人、槽里没有别人待回应的请求时写下
   * 调用者的请求（槽里本来就是他待回应的请求时只续期，标识不变；已谢绝、已失效的被换成新的）；其余（self、occupied、reserved、
   * reservedForOther、free）什么也不写
   */
  async send(actor: EditingActor, documentId: string, format: ClientFormat, transaction: Transaction): Promise<RequestOutcome> {
    this.clients.require(format)
    const { lease, document } = await this.lockForEditor(actor, documentId, transaction)
    const occupancy = await occupancyOf(lease, document.writeEpoch, actor.userId, holderFactsOf(this.sessions, this.policy, lease, document, transaction))
    const decision = await decideRequestSend(occupancy, actor.userId, partyFactsOf(this.sessions, this.policy, document, transaction))
    this.#logger.debug('请求编辑：发出', { documentId, outcome: decision.kind, write: decision.kind === 'pending' ? decision.write : undefined })
    switch (decision.kind) {
      case 'self':
        return { kind: 'self', holder: editorOf(decision.holder, actor) }
      case 'occupied':
        return { kind: 'occupied', requesterId: decision.request.requesterId, requestedAt: decision.request.requestedAt }
      case 'pending': {
        const written = decision.write === 'new' ? await this.leases.putRequest(documentId, actor, transaction) : await this.leases.extendRequest(documentId, transaction)
        return { kind: 'pending', ...written, holder: editorOf(decision.holder, actor) }
      }
      case 'reserved':
        return { kind: 'reserved', reservedUntil: decision.reservation.reservedUntil }
      case 'reservedForOther':
        return { kind: 'reservedForOther', ...decision.reservation }
      case 'free':
        return { kind: 'free' }
    }
  }

  /**
   * 请求方续期（PUT，后台请求，设计 §3.6）：能编辑（404 / 403）→ 锁租约行 → 这次登录仍然有效 → 再读文档 → 从调用者看谁占着 →
   * 怎样回答（decideRequestRenewal）：槽里是调用者待回应的请求时把有效期推到 now() 加 10 分钟（pending、free、reservedForOther），
   * 否则什么也不写（reserved、declined、gone）。请求方停止续期满 10 分钟，请求就失效
   */
  async renew(actor: EditingActor, documentId: string, transaction: Transaction): Promise<RequestOutcome> {
    const { lease, document } = await this.lockForEditor(actor, documentId, transaction)
    const occupancy = await occupancyOf(lease, document.writeEpoch, actor.userId, holderFactsOf(this.sessions, this.policy, lease, document, transaction))
    const decision = await decideRequestRenewal(occupancy, actor.userId, partyFactsOf(this.sessions, this.policy, document, transaction))
    this.#logger.debug('请求编辑：续期', { documentId, outcome: decision.kind })
    if (!decision.extend) {
      switch (decision.kind) {
        case 'reserved':
          return { kind: 'reserved', reservedUntil: decision.reservation.reservedUntil }
        case 'declined':
          return { kind: 'declined', id: decision.request.id, holder: editorOf(decision.holder, actor) }
        case 'gone':
          return { kind: 'gone', holder: decision.holder === undefined ? undefined : editorOf(decision.holder, actor) }
      }
    }
    const extended = await this.leases.extendRequest(documentId, transaction)
    switch (decision.kind) {
      case 'pending':
        return { kind: 'pending', ...extended, holder: editorOf(decision.holder, actor) }
      case 'free':
        return { kind: 'free' }
      case 'reservedForOther':
        return { kind: 'reservedForOther', ...decision.reservation }
    }
  }

  /**
   * 请求方取消（DELETE，设计 §3.6）：能读就行（读不到 404；没了编辑权的人照样能撤回自己已经无效的请求）→ 锁租约行 →
   * 槽里是调用者的请求（待回应的、已谢绝的、已失效的都算）就清掉；交出之后留给了调用者就清掉保留（这一代仍记着交出，别人随即能申请）。
   * 都不是时什么也不做。请求按人：同一个人在别的标签页、别的登录上发的也一并取消
   */
  async cancel(actor: EditingActor, documentId: string, transaction: Transaction): Promise<void> {
    await requireAccess(this.policy, actor.userId, await this.documents.findById(documentId, transaction), transaction)
    const lease = await this.leases.lockByDocument(documentId, transaction)
    const request = slotRequestOf(lease)?.requesterId === actor.userId
    const reservation = lease?.reservedFor === actor.userId
    if (request)
      await this.leases.clearRequest(documentId, transaction)
    if (reservation)
      await this.leases.clearReservation(documentId, transaction)
    this.#logger.debug('请求编辑：取消', { documentId, request, reservation })
  }

  /**
   * 持有者谢绝（POST …/request/decline，设计 §3.6）：持有者自己带令牌的请求（lockHeldLease：能编辑、锁租约行、这次登录、租约有效）→
   * 槽里的请求标识对得上、还没谢绝，就记下谢绝的时刻：请求方下一次续期得到 declined，心跳不再带它。对不上（已取消、已换成新的请求）
   * 或已经谢绝过时什么也不做——重试与回包丢失都安全
   */
  async decline(actor: EditingActor, documentId: string, requestId: string, token: string | undefined, transaction: Transaction): Promise<void> {
    const { lease } = await this.lockHeldLease(actor, documentId, token, transaction)
    const request = slotRequestOf(lease)
    const declined = request?.id === requestId && request.declinedAt === null
    if (declined)
      await this.leases.declineRequest(documentId, transaction)
    this.#logger.debug('请求编辑：谢绝', { documentId, declined })
  }

  /**
   * 交出（POST …/handover，设计 §3.6）：持有者自己带令牌的请求（lockHeldLease）→ 槽里的请求标识对得上、而且仍是待回应的
   * （没谢绝、没过期、请求方的登录仍然有效、他仍能编辑）——否则 EDIT_REQUEST_GONE，租约不动，持有者留在编辑——→ 一条语句里
   * 记下明确结束（handed_over）、把请求转成保留（留给请求方 2 分钟）、清掉请求。普通的释放不会变成交出。
   * 回包丢了再交出：这一代已经明确结束，lockHeldLease 给出 EDIT_LEASE_LOST（handed_over），页面据此认出已经交出
   */
  async handOver(actor: EditingActor, documentId: string, requestId: string, token: string | undefined, transaction: Transaction): Promise<LeaseReservation> {
    const { lease, document } = await this.lockHeldLease(actor, documentId, token, transaction)
    // 标识对不上就不必再问请求方的事实
    if (slotRequestOf(lease)?.id !== requestId || await requestStandingOf(lease, partyFactsOf(this.sessions, this.policy, document, transaction)) !== 'pending') {
      this.#logger.debug('交出：请求已不在', { documentId })
      throw new AppError('EDIT_REQUEST_GONE')
    }
    const reservation = await this.leases.handOver(documentId, transaction)
    this.#logger.debug('交出：编辑权留给了请求方', { documentId })
    return reservation
  }

  /**
   * 发出、续期、谢绝、交出共同的开头：不加锁判断能编辑（404 / 403）→ 锁租约行 → 这次登录仍然有效（否则 401，requireActiveLogin）→
   * 再读文档（代次、权限判断的对象；锁住租约行之前被删、被永久删除的按读不到回答，NOT_FOUND）
   */
  private async lockForEditor(actor: EditingActor, documentId: string, transaction: Transaction): Promise<LockedLease> {
    await requireDocumentContent(this.policy, actor.userId, await this.documents.findById(documentId, transaction), ['edit'], transaction)
    const lease = await this.leases.lockByDocument(documentId, transaction)
    await requireActiveLogin(this.sessions, actor, transaction)
    const document = await this.documents.findById(documentId, transaction)
    if (document === undefined)
      throw new AppError('NOT_FOUND')
    return { lease, document }
  }

  /**
   * 持有者自己带令牌的请求（谢绝、交出）：lockForEditor 之后按有效条件判断请求带的租约（requestLeaseLoss，与心跳同一个判断）。
   * 失效时先再判断一次能编辑（M3-P1 审查 A2：等租约行的锁期间权限可能刚被收回，失去访问与失去编辑权要先于租约回答），
   * 再回 EDIT_LEASE_LOST（editLeaseLost：被接管时是 taken_over 与 forced，已经交出时是 handed_over）
   */
  private async lockHeldLease(actor: EditingActor, documentId: string, token: string | undefined, transaction: Transaction): Promise<LockedLease> {
    const locked = await this.lockForEditor(actor, documentId, transaction)
    const loss = requestLeaseLoss(locked.lease, locked.document.writeEpoch, { token, sessionId: actor.sessionId })
    if (loss !== undefined) {
      await requireDocumentContent(this.policy, actor.userId, locked.document, ['edit'], transaction)
      throw this.lost(documentId, loss)
    }
    return locked
  }

  /** 持有者的那一代已失效：记一条日志（文档、原因与被接管的方式，不记令牌），details 带原因与被接管的方式（editLeaseLost） */
  private lost(documentId: string, loss: LeaseLoss): AppError {
    this.#logger.debug('谢绝或交出失败：编辑权已失效', { documentId, reason: loss.reason, forced: loss.forced })
    return editLeaseLost(loss)
  }
}
