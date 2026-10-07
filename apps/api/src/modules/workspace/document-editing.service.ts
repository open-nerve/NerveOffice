import type { AcquiredEditLease, ClientFormat, DocumentEditor, EditInterruption, EditLeaseHeldDetails, EditLeaseReservedDetails, EditRequestOutcome, EditRequestView, EditReservation, EditStatus, HandedOverEditLease, RenewedEditLease } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { Transaction } from '../database/index.ts'
import type { EditingActor, LeaseEditor, LeaseInterruption, LeaseRequest, LeaseRequestView, LeaseReservation, LeaseReservationView, RenewalRequest, RequestOutcome } from '../documents/index.ts'
import type { User } from '../users/index.ts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { TransactionRunner } from '../database/index.ts'
import { EditLeaseService, EditRequestService } from '../documents/index.ts'
import { UsersService } from '../users/index.ts'
import { accountIn, toUserSummary } from './workspace-views.ts'

/** 按 id 取来的账户（补人名用） */
type Accounts = ReadonlyMap<string, User>

/** 正在编辑的人补上人名（编辑状态的 editor、EDIT_LEASE_HELD 的详情、请求编辑的结果同一个结构） */
function documentEditorOf(editor: LeaseEditor, accounts: Accounts): DocumentEditor {
  return { holder: toUserSummary(accountIn(accounts, editor.holderId)), lastActiveAt: editor.lastActiveAt.toISOString(), sameUser: editor.sameUser, sameSession: editor.sameSession }
}

/** 有人在请求编辑补上请求方的人名（编辑状态、EDIT_LEASE_HELD 的详情） */
function requestViewOf(request: LeaseRequestView, accounts: Accounts): EditRequestView {
  return { requester: toUserSummary(accountIn(accounts, request.requesterId)), requestedAt: request.requestedAt.toISOString(), mine: request.mine }
}

/** 交出之后的保留补上留给的人的人名（交出的响应、EDIT_LEASE_RESERVED 的详情、请求编辑的结果） */
function reservedOf(reservation: LeaseReservation, accounts: Accounts): HandedOverEditLease {
  return { reservedFor: toUserSummary(accountIn(accounts, reservation.reservedFor)), reservedUntil: reservation.reservedUntil.toISOString() }
}

/** 编辑状态里的保留：另带留给的是不是调用者自己 */
function reservationViewOf(reservation: LeaseReservationView, accounts: Accounts): EditReservation {
  return { ...reservedOf(reservation, accounts), mine: reservation.mine }
}

/** 异常中断的提醒补上上一位持有者的人名 */
function interruptionOf(interruption: LeaseInterruption, accounts: Accounts): EditInterruption {
  return { holder: toUserSummary(accountIn(accounts, interruption.holderId)), endedAt: interruption.endedAt.toISOString(), sameUser: interruption.sameUser }
}

/** 请求编辑的结果里要补人名的人：正在编辑的人、先请求的人或留给的人（free、reserved 没有） */
function peopleIn(outcome: RequestOutcome): (string | undefined)[] {
  switch (outcome.kind) {
    case 'pending':
    case 'declined':
    case 'self':
      return [outcome.holder.holderId]
    case 'gone':
      return [outcome.holder?.holderId]
    case 'occupied':
      return [outcome.requesterId]
    case 'reservedForOther':
      return [outcome.reservedFor]
    case 'reserved':
    case 'free':
      return []
  }
}

/** 请求编辑的结果补上人名（contracts 的 EditRequestOutcome） */
function requestOutcomeOf(outcome: RequestOutcome, accounts: Accounts): EditRequestOutcome {
  switch (outcome.kind) {
    case 'pending':
      return { kind: 'pending', id: outcome.id, requestedAt: outcome.requestedAt.toISOString(), expiresAt: outcome.expiresAt.toISOString(), holder: documentEditorOf(outcome.holder, accounts) }
    case 'declined':
      return { kind: 'declined', id: outcome.id, holder: documentEditorOf(outcome.holder, accounts) }
    case 'reserved':
      return { kind: 'reserved', reservedUntil: outcome.reservedUntil.toISOString() }
    case 'free':
      return { kind: 'free' }
    case 'self':
      return { kind: 'self', holder: documentEditorOf(outcome.holder, accounts) }
    case 'occupied':
      return { kind: 'occupied', requester: toUserSummary(accountIn(accounts, outcome.requesterId)), requestedAt: outcome.requestedAt.toISOString() }
    case 'reservedForOther':
      return { kind: 'reservedForOther', ...reservedOf(outcome, accounts) }
    case 'gone':
      return { kind: 'gone', holder: outcome.holder === undefined ? null : documentEditorOf(outcome.holder, accounts) }
  }
}

/**
 * 编辑权的接口编排（M3-P1 设计 §3.1、§3.2）：申请、心跳续租、释放与编辑状态；M3-P5（设计 §3.4、§3.6）的请求编辑（发出、续期、取消）、
 * 谢绝与交出。租约的规则与数据在 documents 的 EditLeaseService 与 EditRequestService；这里开事务、经 users 补人名（documents 不依赖 users，
 * 与分享同一个做法）、拼好响应。
 * 写的几个各是一个业务事务，补人名也在同一个事务里，提交之后不再访问数据库；编辑状态在一个只读快照里（ADR-017）。一个响应里要的人名
 * （正在编辑的人、请求方、留给的人、上一位持有者）一次查齐，一个也不要时不查。
 * "被占用"在这里转成 EDIT_LEASE_HELD，交出之后的保留挡住的申请转成 EDIT_LEASE_RESERVED：事务随之回滚，而申请在判断出它们之前什么也没写
 */
@Injectable()
export class DocumentEditingService {
  constructor(
    private readonly leases: EditLeaseService,
    private readonly requests: EditRequestService,
    private readonly users: UsersService,
    private readonly transactions: TransactionRunner,
  ) {}

  /**
   * 编辑状态：能读就能看；正在编辑的人连同人名、最后活动时间、是不是调用者自己与是不是调用者这次登录，没人在编辑时为 null；
   * 调用者现在能不能编辑、能不能强制接管（M3-P2 设计 §3.2，阅读页每 30 秒读一次，据此显示或隐藏"编辑"；M3-P5 设计 §3.8）；
   * 文档的"公式待更新"（M3-P3 设计 §3.8）；有人在请求编辑（待回应的，请求方的人名、发出的时刻、是不是调用者自己）与交出之后的保留
   * （留给的人的人名、留到何时、是不是调用者自己，M3-P5 设计 §3.3），没有时为 null；没人在编辑时上一个租约异常结束的提醒，
   * 补上上一位持有者的人名（M3-P5 设计 §3.5，没有时为 null）。正在编辑的人与提醒至多有一个；人名一次查齐
   */
  async status(actor: EditingActor, documentId: string): Promise<EditStatus> {
    return this.transactions.readSnapshot(async (transaction) => {
      const { revision, editor, canEdit, canTakeOver, formulasPending, request, reservation, interruption } = await this.leases.status(actor, documentId, transaction)
      const notice = editor === undefined ? interruption : undefined
      const accounts = await this.accountsOf([editor?.holderId, request?.requesterId, reservation?.reservedFor, notice?.holderId], transaction)
      return {
        revision,
        editor: editor === undefined ? null : documentEditorOf(editor, accounts),
        canEdit,
        canTakeOver,
        formulasPending,
        request: request === undefined ? null : requestViewOf(request, accounts),
        reservation: reservation === undefined ? null : reservationViewOf(reservation, accounts),
        interruption: notice === undefined ? null : interruptionOf(notice, accounts),
      }
    })
  }

  /**
   * 申请（201）：取得新的一代时给出令牌、代次、修订号与它的来源、到期时间、上一个租约异常结束的提醒（补上一位持有者的人名）
   * 与文档的"公式待更新"；有效的租约在别人手里时 409 EDIT_LEASE_HELD，details 带正在编辑的人（人名、最后活动时间、是不是自己、
   * 是不是这次登录）、调用者能不能强制接管与有没有人在请求编辑（M3-P5）；编辑权刚交给了别人、还在保留期内时 409 EDIT_LEASE_RESERVED，
   * details 带留给的人与留到何时（M3-P5 设计 §3.6）。页面过旧时 409 CLIENT_OUTDATED、文档比服务端新时 409 DOCUMENT_TOO_NEW
   * （documents 抛出，M3-P3 设计 §3.5）。本人接管、强制接管（M3-P5 设计 §3.7、§3.8）同样经这里：强制接管的审计由 documents
   * 在同一个事务里写，来源（请求标识与客户端地址）由控制器取得
   */
  async acquire(actor: EditingActor, documentId: string, request: LeaseRequest, origin: AuditOrigin): Promise<AcquiredEditLease> {
    return this.transactions.run(async (transaction) => {
      const outcome = await this.leases.acquire(actor, documentId, request, origin, transaction)
      if (outcome.kind === 'held') {
        const accounts = await this.accountsOf([outcome.holderId, outcome.request?.requesterId], transaction)
        const details: EditLeaseHeldDetails = { ...documentEditorOf(outcome, accounts), canTakeOver: outcome.canTakeOver, request: outcome.request === undefined ? null : requestViewOf(outcome.request, accounts) }
        throw new AppError('EDIT_LEASE_HELD', undefined, { details })
      }
      if (outcome.kind === 'reserved') {
        const details: EditLeaseReservedDetails = reservedOf(outcome, await this.accountsOf([outcome.reservedFor], transaction))
        throw new AppError('EDIT_LEASE_RESERVED', undefined, { details })
      }
      return {
        token: outcome.token,
        writeEpoch: outcome.writeEpoch,
        revision: outcome.revision,
        source: outcome.source,
        expiresAt: outcome.expiresAt.toISOString(),
        interruption: outcome.interruption === undefined ? null : interruptionOf(outcome.interruption, await this.accountsOf([outcome.interruption.holderId], transaction)),
        formulasPending: outcome.formulasPending,
      }
    })
  }

  /**
   * 心跳续租（200）：新的到期时间与待回应的请求编辑（M3-P5 设计 §3.3：标识、请求方的人名、发出的时刻；没有时为 null）；
   * 租约不再有效时 409 EDIT_LEASE_LOST（documents 抛出，details 带原因）；页面过旧时 409 CLIENT_OUTDATED（M3-P3 设计 §3.5）
   */
  async renew(actor: EditingActor, documentId: string, request: RenewalRequest, token: string | undefined): Promise<RenewedEditLease> {
    return this.transactions.run(async (transaction) => {
      const renewed = await this.leases.renew(actor, documentId, request, token, transaction)
      const pending = renewed.request
      if (pending === undefined)
        return { expiresAt: renewed.expiresAt.toISOString(), request: null }
      const accounts = await this.accountsOf([pending.requesterId], transaction)
      return { expiresAt: renewed.expiresAt.toISOString(), request: { id: pending.id, requester: toUserSummary(accountIn(accounts, pending.requesterId)), requestedAt: pending.requestedAt.toISOString() } }
    })
  }

  /** 释放（204）：令牌是当前这一行的、没有明确结束、调用者是持有者本人（不要求同一个登录）才记 released，其余什么也不做 */
  async release(actor: EditingActor, documentId: string, token: string | undefined): Promise<void> {
    await this.transactions.run(async transaction => this.leases.release(actor, documentId, token, transaction))
  }

  /**
   * 发出请求编辑（200，M3-P5 设计 §3.6）：请求编辑的结果（除 gone），补上人名；页面过旧时 409 CLIENT_OUTDATED（documents 在任何查询之前抛出）
   */
  async sendRequest(actor: EditingActor, documentId: string, format: ClientFormat): Promise<EditRequestOutcome> {
    return this.transactions.run(async transaction => this.withNames(await this.requests.send(actor, documentId, format, transaction), transaction))
  }

  /** 请求方续期（200，后台请求）：请求编辑的结果，补上人名；调用者的请求已不在时是 gone */
  async renewRequest(actor: EditingActor, documentId: string): Promise<EditRequestOutcome> {
    return this.transactions.run(async transaction => this.withNames(await this.requests.renew(actor, documentId, transaction), transaction))
  }

  /** 请求方取消（204）：清掉调用者的请求与留给他的保留，都没有时什么也不做 */
  async cancelRequest(actor: EditingActor, documentId: string): Promise<void> {
    await this.transactions.run(async transaction => this.requests.cancel(actor, documentId, transaction))
  }

  /** 持有者谢绝（204）：请求的标识对不上时什么也不做；持有者的那一代已失效时 409 EDIT_LEASE_LOST（documents 抛出） */
  async declineRequest(actor: EditingActor, documentId: string, requestId: string, token: string | undefined): Promise<void> {
    await this.transactions.run(async transaction => this.requests.decline(actor, documentId, requestId, token, transaction))
  }

  /**
   * 交出（200）：编辑权留给了谁（人名）、留到何时；请求已不在时 409 EDIT_REQUEST_GONE、持有者的那一代已失效时 409 EDIT_LEASE_LOST
   * （documents 抛出，租约都没动）
   */
  async handOver(actor: EditingActor, documentId: string, requestId: string, token: string | undefined): Promise<HandedOverEditLease> {
    return this.transactions.run(async (transaction) => {
      const reservation = await this.requests.handOver(actor, documentId, requestId, token, transaction)
      return reservedOf(reservation, await this.accountsOf([reservation.reservedFor], transaction))
    })
  }

  /** 请求编辑的结果补上人名（同一个事务里） */
  private async withNames(outcome: RequestOutcome, transaction: Transaction): Promise<EditRequestOutcome> {
    return requestOutcomeOf(outcome, await this.accountsOf(peopleIn(outcome), transaction))
  }

  /** 一次查齐这些人的账户（同一个事务里，重复的只查一次）；一个也没有时不查 */
  private async accountsOf(userIds: readonly (string | undefined)[], transaction: Transaction): Promise<Accounts> {
    const ids = userIds.filter(id => id !== undefined)
    return ids.length === 0 ? new Map() : this.users.findByIds(ids, transaction)
  }
}
