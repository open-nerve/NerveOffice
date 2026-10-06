import type { AcquiredEditLease, DocumentEditor, EditInterruption, EditLeaseHeldDetails, EditStatus, RenewedEditLease } from '@nerve-office/contracts'
import type { Transaction } from '../database/index.ts'
import type { EditingActor, LeaseEditor, LeaseInterruption, LeaseRequest, RenewalRequest } from '../documents/index.ts'
import type { User } from '../users/index.ts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { TransactionRunner } from '../database/index.ts'
import { EditLeaseService } from '../documents/index.ts'
import { UsersService } from '../users/index.ts'
import { accountIn, toUserSummary } from './workspace-views.ts'

/** 正在编辑的人补上人名（编辑状态的 editor、EDIT_LEASE_HELD 的详情同一个结构） */
function documentEditorOf(editor: LeaseEditor, accounts: ReadonlyMap<string, User>): DocumentEditor {
  return { holder: toUserSummary(accountIn(accounts, editor.holderId)), lastActiveAt: editor.lastActiveAt.toISOString(), sameUser: editor.sameUser, sameSession: editor.sameSession }
}

/**
 * 编辑权的接口编排（M3-P1 设计 §3.1、§3.2）：申请、心跳续租、释放与编辑状态。租约的规则与数据在 documents 的 EditLeaseService；
 * 这里开事务、经 users 补持有者的人名（documents 不依赖 users，与分享同一个做法）、拼好响应。
 * 写的三个各是一个业务事务，补人名也在同一个事务里，提交之后不再访问数据库；编辑状态在一个只读快照里（ADR-017）。
 * "被占用"在这里转成 EDIT_LEASE_HELD：事务随之回滚，而申请在判断出被占用之前什么也没写。
 * M3-P5 的请求编辑与交出之后的保留还没有接上（S4）：编辑状态的 request、reservation，被占用时的 request 与心跳的 request 一律给 null
 */
@Injectable()
export class DocumentEditingService {
  constructor(
    private readonly leases: EditLeaseService,
    private readonly users: UsersService,
    private readonly transactions: TransactionRunner,
  ) {}

  /**
   * 编辑状态：能读就能看；正在编辑的人连同人名、最后活动时间、是不是调用者自己与是不是调用者这次登录，没人在编辑时为 null；
   * 调用者现在能不能编辑、能不能强制接管（M3-P2 设计 §3.2，阅读页每 30 秒读一次，据此显示或隐藏"编辑"；M3-P5 设计 §3.8）；
   * 文档的"公式待更新"（M3-P3 设计 §3.8）；没人在编辑时上一个租约异常结束的提醒，补上上一位持有者的人名（M3-P5 设计 §3.5，
   * 没有时为 null）。正在编辑的人与提醒至多有一个，人名至多查一次
   */
  async status(actor: EditingActor, documentId: string): Promise<EditStatus> {
    return this.transactions.readSnapshot(async (transaction) => {
      const { revision, editor, canEdit, canTakeOver, formulasPending, interruption } = await this.leases.status(actor, documentId, transaction)
      const common = { revision, canEdit, canTakeOver, formulasPending, request: null, reservation: null }
      if (editor !== undefined) {
        const accounts = await this.users.findByIds([editor.holderId], transaction)
        return { ...common, editor: documentEditorOf(editor, accounts), interruption: null }
      }
      return { ...common, editor: null, interruption: interruption === undefined ? null : await this.withHolder(interruption, transaction) }
    })
  }

  /**
   * 申请（201）：取得新的一代时给出令牌、代次、修订号与它的来源、到期时间、上一个租约异常结束的提醒（补上一位持有者的人名）
   * 与文档的"公式待更新"；有效的租约在别人手里时 409 EDIT_LEASE_HELD，details 带正在编辑的人（人名、最后活动时间、是不是自己、
   * 是不是这次登录）与调用者能不能强制接管。页面过旧时 409 CLIENT_OUTDATED、文档比服务端新时 409 DOCUMENT_TOO_NEW（documents 抛出，M3-P3 设计 §3.5）
   */
  async acquire(actor: EditingActor, documentId: string, request: LeaseRequest): Promise<AcquiredEditLease> {
    return this.transactions.run(async (transaction) => {
      const outcome = await this.leases.acquire(actor, documentId, request, transaction)
      if (outcome.kind === 'held') {
        const accounts = await this.users.findByIds([outcome.holderId], transaction)
        const details: EditLeaseHeldDetails = { ...documentEditorOf(outcome, accounts), canTakeOver: outcome.canTakeOver, request: null }
        throw new AppError('EDIT_LEASE_HELD', undefined, { details })
      }
      return {
        token: outcome.token,
        writeEpoch: outcome.writeEpoch,
        revision: outcome.revision,
        source: outcome.source,
        expiresAt: outcome.expiresAt.toISOString(),
        interruption: outcome.interruption === undefined ? null : await this.withHolder(outcome.interruption, transaction),
        formulasPending: outcome.formulasPending,
      }
    })
  }

  /** 异常结束的提醒补上上一位持有者的人名（同一个事务里） */
  private async withHolder(interruption: LeaseInterruption, transaction: Transaction): Promise<EditInterruption> {
    const accounts = await this.users.findByIds([interruption.holderId], transaction)
    return { holder: toUserSummary(accountIn(accounts, interruption.holderId)), endedAt: interruption.endedAt.toISOString(), sameUser: interruption.sameUser }
  }

  /**
   * 心跳续租（200）：新的到期时间与待回应的请求编辑（还没有接上，一律 null）；租约不再有效时 409 EDIT_LEASE_LOST（documents 抛出，
   * details 带原因）；页面过旧时 409 CLIENT_OUTDATED（M3-P3 设计 §3.5）
   */
  async renew(actor: EditingActor, documentId: string, request: RenewalRequest, token: string | undefined): Promise<RenewedEditLease> {
    return this.transactions.run(async (transaction) => {
      const { expiresAt } = await this.leases.renew(actor, documentId, request, token, transaction)
      return { expiresAt: expiresAt.toISOString(), request: null }
    })
  }

  /** 释放（204）：令牌是当前这一行的、没有明确结束、调用者是持有者本人（不要求同一个登录）才记 released，其余什么也不做 */
  async release(actor: EditingActor, documentId: string, token: string | undefined): Promise<void> {
    await this.transactions.run(async transaction => this.leases.release(actor, documentId, token, transaction))
  }
}
