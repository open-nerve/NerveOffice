import type { OnModuleInit } from '@nestjs/common'
import type { RequestHandler } from 'express'
import type { Transaction } from '../database/index.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { TransactionRunner } from '../database/index.ts'
import { UsersService } from '../users/index.ts'

/**
 * 会话守卫判断过的、这个请求的身份（M2 Codex 评审 CX1）：只读快照的开场核对据此在快照里再查一次。
 * systemAdmin 是守卫读到的系统角色是不是管理员：只给系统管理员的接口按它放行；其余接口的调用者带着同一个值
 * （documents 的 accessActorOf，没有加入的系统管理员看得到团队空间的成员、管理面的权限位按它给）
 */
export interface RequestIdentity {
  readonly userId: string
  readonly systemAdmin: boolean
}

/** 一个请求的记录：会话守卫认证通过之后填上 */
interface IdentitySlot {
  identity?: RequestIdentity
}

/**
 * 每个请求一份"守卫判断过的身份"（M2 Codex 评审 CX1），与 database 模块的 CommitLedger 同一个做法：AsyncLocalStorage 加中间件
 * （中间件由 HTTP 管线装上，configure-http.ts）。会话守卫认证通过之后记下，只读快照的开场核对（SnapshotIdentityCheck）取用。
 * 每个应用实例一份（Nest 的依赖注入在每个应用里各建一个），不用全局单例：同一个进程里可能有多个应用（例如集成测试）
 */
@Injectable()
export class RequestIdentities {
  readonly #storage = new AsyncLocalStorage<IdentitySlot>()

  /** 每个请求一份空的记录：在 HTTP 管线里排在请求上下文之后、Nest 的路由之前 */
  middleware(): RequestHandler {
    return (_request, _response, next) => {
      this.#storage.run({}, next)
    }
  }

  /**
   * 会话守卫认证通过之后记下。不在请求的记录里就是接线错了（HTTP 管线没装中间件）：直接报错，
   * 不让开场核对因为取不到身份而悄悄什么也不查
   */
  record(identity: RequestIdentity): void {
    const slot = this.#storage.getStore()
    if (slot === undefined)
      throw new Error('请求级的身份记录不在：HTTP 管线没有装上 RequestIdentities 的中间件（configure-http.ts）')
    slot.identity = identity
  }

  /** 这个请求经会话守卫认证的身份；不在请求里（命令行、定时任务）、公开的接口没有 */
  current(): RequestIdentity | undefined {
    return this.#storage.getStore()?.identity
  }
}

/**
 * 只读快照的开场核对（M2 Codex 评审 CX1）：会话守卫在处理器之前判断过账户有效、系统角色，那之后到快照开始之间账户被停用、
 * 系统角色被取消，处理器读到的就是"撤权之后的数据"。所以守卫判断过的事实在快照里作为第一条语句再查一次，同时确定快照的时刻：
 * - 账户仍然有效，否则 SESSION_EXPIRED（与守卫的说法一致；清除 Cookie、撤销会话由下一个请求经守卫做，快照是只读的）；
 * - 守卫读到是系统管理员的请求，仍是系统管理员，否则 PERMISSION_DENIED（与守卫拒绝只给系统管理员的接口的说法一致）。
 *   只给系统管理员的接口一定是这样的请求；其余接口里，调用者的系统角色同样决定看到什么（没有加入的系统管理员看得到团队空间的成员），
 *   所以不只看"这个接口是不是只给系统管理员"。快照之前刚被授予系统管理员的不拒绝：调用者仍按普通成员判断，看到的只会更少。
 * 会话行本身（撤销、过期）不在快照里重新核对：单纯的会话撤销（退出、换令牌、修改密码时撤销别的设备）不改变这个人对数据的权利，
 * 那之前开始的请求按撤销之前的那一刻回答没有越权；停用会让账户无效，在这里拒绝。
 * 不在请求里（命令行、定时任务）、公开的接口：守卫没有记下身份，什么也不做。
 * 由 auth 向 database 登记（控制反转：database 不依赖 auth、users）
 */
@Injectable()
export class SnapshotIdentityCheck implements OnModuleInit {
  constructor(
    private readonly identities: RequestIdentities,
    private readonly users: UsersService,
    private readonly transactions: TransactionRunner,
  ) {}

  onModuleInit(): void {
    this.transactions.registerSnapshotOpening(async transaction => this.recheck(transaction))
  }

  async recheck(transaction: Transaction): Promise<void> {
    const identity = this.identities.current()
    if (identity === undefined)
      return
    const user = await this.users.findById(identity.userId, transaction)
    if (user?.status !== 'active')
      throw new AppError('SESSION_EXPIRED')
    if (identity.systemAdmin && user.systemRole !== 'admin')
      throw new AppError('PERMISSION_DENIED')
  }
}
