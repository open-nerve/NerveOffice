import type { EditLeaseLostReason } from '@nerve-office/contracts'
import type { Principal } from '../auth/index.ts'
import type { Transaction } from '../database/index.ts'
import type { AccessTarget } from './document-access-policy.ts'
import type { HolderFacts, LeaseInterruption } from './edit-lease-rules.ts'
import type { ObservedEditLease } from './edit-leases.repository.ts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { SessionService } from '../auth/index.ts'
import { AppLogger } from '../logging/index.ts'
import { canEditDocument, DocumentAccessPolicy, requireAccess, requireDocumentContent } from './document-access-policy.ts'
import { DocumentsRepository } from './documents.repository.ts'
import { currentLeaseLoss, interruptionOf, isSamePage, releasableBy, requestLeaseLoss } from './edit-lease-rules.ts'
import { editLeaseTokenDigest, generateEditLeaseToken } from './edit-lease-token.ts'
import { EditLeasesRepository } from './edit-leases.repository.ts'

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
 * 申请的结果（P1 设计 §3.4.2）：
 * - acquired：取得了新的一代——令牌（只在这里出现一次）、这一代的代次、文档当前的修订号、到期时间，以及上一个租约异常结束的提醒；
 * - held：有效的租约在别人手里（同一个人在别的标签页或设备上也算），什么也没写；workspace 补上人名，回 EDIT_LEASE_HELD
 */
export type LeaseAcquisition
  = | {
    readonly kind: 'acquired'
    readonly token: string
    readonly writeEpoch: number
    readonly revision: number
    readonly expiresAt: Date
    readonly interruption: LeaseInterruption | undefined
  }
  | { readonly kind: 'held', readonly holderId: string, readonly lastActiveAt: Date, readonly sameUser: boolean }

/** 编辑状态（P1 设计 §3.4.3）：文档当前的修订号，有效的租约在谁手里（没有时为 undefined） */
export interface LeaseStatus {
  readonly revision: number
  readonly editor: { readonly holderId: string, readonly lastActiveAt: Date, readonly sameUser: boolean } | undefined
}

/**
 * 编辑租约（M3-P1 设计 §3.4.2、§3.4.3）：申请、心跳续租、释放与编辑状态的规则与数据。事务由调用方（workspace 的
 * DocumentEditingService）开：写的三个在一个业务事务里，编辑状态在只读快照里；人名由 workspace 经 users 补上（documents 不依赖 users）。
 * 有效条件在 edit-lease-rules.ts，这里按步骤取事实、加锁：
 * - 失去访问与失去编辑权先于租约判断（§3.2）：读不到 404，能读不能编辑 403，之后才看租约；看不到的请求不取任何锁，
 *   与不存在的文档执行同样的语句（permissions/hidden-missing-parity 核对）；
 * - 锁的顺序是文档行（FOR UPDATE）→ 租约行（§3.4.6，ADR-014 的锁顺序表在文档行之后加上租约行）：申请先锁文档行再锁租约行；
 *   心跳与释放只锁租约行，与申请、收回写入权按租约行串行，不成环；
 * - 时间一律取数据库的 now()：租约行与同一条语句里的 now() 一起读出来（ObservedEditLease）。
 * 申请、续租、释放都不写审计（太频繁，结束的原因留在租约行上，设计 §3.5）；令牌不进日志
 */
@Injectable()
export class EditLeaseService {
  readonly #logger: AppLogger

  constructor(
    private readonly documents: DocumentsRepository,
    private readonly leases: EditLeasesRepository,
    private readonly policy: DocumentAccessPolicy,
    private readonly sessions: SessionService,
    logger: AppLogger,
  ) {
    this.#logger = logger.with({ module: 'documents' })
  }

  /**
   * 申请（P1 设计 §3.4.2）：不加锁判断能编辑（404 / 403）→ 锁文档行、锁下再判断 → 锁租约行，按有效条件判断当前的租约 →
   * 有效时：同一个登录、同一个标签页的是这个页面的重试（例如上次申请的回包丢了），照样发新的一代；别人的（含自己在别处的）就是被占用，
   * 什么也不写 → 文档的代次加一、生成令牌、改写租约行 → 上一个租约异常结束、而且在 30 分钟以内时给出提醒。
   * 修订号取锁下的文档行：页面拿它与自己载入的比较
   */
  async acquire(actor: EditingActor, documentId: string, clientInstanceId: string, transaction: Transaction): Promise<LeaseAcquisition> {
    await requireDocumentContent(this.policy, actor.userId, await this.documents.findById(documentId, transaction), ['edit'], transaction)
    const { document } = await requireDocumentContent(this.policy, actor.userId, await this.documents.lockById(documentId, transaction), ['edit'], transaction)
    const current = await this.leases.lockByDocument(documentId, transaction)
    const loss = await currentLeaseLoss(current, document.writeEpoch, this.holderFacts(current, document, transaction))
    if (loss === undefined && current !== undefined && !isSamePage(current, actor.sessionId, clientInstanceId)) {
      const sameUser = current.holderId === actor.userId
      this.#logger.debug('申请编辑权：有效的租约在别人手里', { documentId, sameUser })
      return { kind: 'held', holderId: current.holderId, lastActiveAt: current.lastActiveAt, sameUser }
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
    }, transaction)
    // 上一个租约的情形只记原因（none、到期、空闲……，同一个页面的重试记 retry），不记令牌
    this.#logger.debug('申请编辑权：取得新的一代', { documentId, writeEpoch, previous: loss ?? 'retry' })
    return {
      kind: 'acquired',
      token,
      writeEpoch,
      revision: document.revision,
      expiresAt: lease.expiresAt,
      interruption: interruptionOf(current, loss),
    }
  }

  /**
   * 心跳续租（P1 设计 §3.4.3）：不加锁判断能编辑（404 / 403）→ 锁租约行 → 再读文档当前的代次 → 按有效条件判断（持有者自己的请求）→
   * 有效就续租，否则 EDIT_LEASE_LOST（details 带原因）。代次在锁住租约行之后才读：收回写入权与新的申请都先锁文档行、再锁租约行，
   * 改代次在前；锁住租约行之后再读，它们要么已经提交（读到新的代次与改写过的租约），要么还在等这把锁。
   * 不锁文档行：读不到了（锁住租约行之前被删、被永久删除）按读不到回答（NOT_FOUND）
   */
  async renew(actor: EditingActor, documentId: string, idleSeconds: number, token: string | undefined, transaction: Transaction): Promise<{ readonly expiresAt: Date }> {
    await requireDocumentContent(this.policy, actor.userId, await this.documents.findById(documentId, transaction), ['edit'], transaction)
    const lease = await this.leases.lockByDocument(documentId, transaction)
    const document = await this.documents.findById(documentId, transaction)
    if (document === undefined)
      throw new AppError('NOT_FOUND')
    const loss = requestLeaseLoss(lease, document.writeEpoch, { token, sessionId: actor.sessionId })
    if (loss !== undefined)
      throw this.lost(documentId, loss)
    return { expiresAt: (await this.leases.renew(documentId, idleSeconds, transaction)).expiresAt }
  }

  /**
   * 释放（P1 设计 §3.4.3）：能访问就行（读不到 404，看不到与不存在一致）→ 锁租约行 → 令牌是当前这一行的、而且没有明确结束，
   * 就记 released；其余情况（没带令牌、令牌不对、已经结束）什么也不做。调用方一律回 204：页面关闭时的 keepalive 请求不看结果
   */
  async release(actor: EditingActor, documentId: string, token: string | undefined, transaction: Transaction): Promise<void> {
    await requireAccess(this.policy, actor.userId, await this.documents.findById(documentId, transaction), transaction)
    const lease = await this.leases.lockByDocument(documentId, transaction)
    if (releasableBy(lease, token))
      await this.leases.end(documentId, 'released', transaction)
  }

  /**
   * 编辑状态（P1 设计 §3.4.3）：在调用方开的只读快照里（ADR-017），能读就能看（读不到 404）→ 读租约行 → 按有效条件判断
   * （第 6、7 条查持有者的登录与编辑权，同一个快照）→ 修订号，以及有效时的持有者、最后活动时间、是不是调用者自己
   */
  async status(actor: EditingActor, documentId: string, transaction: Transaction): Promise<LeaseStatus> {
    const { document } = await requireAccess(this.policy, actor.userId, await this.documents.findById(documentId, transaction), transaction)
    const lease = await this.leases.findByDocument(documentId, transaction)
    const loss = await currentLeaseLoss(lease, document.writeEpoch, this.holderFacts(lease, document, transaction))
    return {
      revision: document.revision,
      editor: lease === undefined || loss !== undefined ? undefined : { holderId: lease.holderId, lastActiveAt: lease.lastActiveAt, sameUser: lease.holderId === actor.userId },
    }
  }

  /**
   * 第 6、7 条的事实（规则只在前五条都满足时才问）：持有者绑定的登录仍然有效（auth）；持有者对这份文档仍有编辑权
   * （访问策略在同一个事务里查，看得到同一个事务里刚做的改动）。没有租约时规则不会问
   */
  private holderFacts(lease: ObservedEditLease | undefined, document: AccessTarget, transaction: Transaction): HolderFacts {
    return {
      sessionActive: async () => lease !== undefined && this.sessions.isActive(lease.sessionId, transaction),
      holderCanEdit: async () => lease !== undefined && canEditDocument(this.policy, lease.holderId, document, transaction),
    }
  }

  /** 编辑权已失效：记一条日志（文档与原因，不记令牌），details 带原因（contracts 的 editLeaseLostDetailsSchema） */
  private lost(documentId: string, reason: EditLeaseLostReason): AppError {
    this.#logger.debug('续租失败：编辑权已失效', { documentId, reason })
    return new AppError('EDIT_LEASE_LOST', undefined, { details: { reason } })
  }
}
