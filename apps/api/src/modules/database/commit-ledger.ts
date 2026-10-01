import type { RequestHandler } from 'express'
import { AsyncLocalStorage } from 'node:async_hooks'
import { Injectable } from '@nestjs/common'

/** 一个请求的记录：有没有事务已经提交 */
interface RequestCommits {
  committed: boolean
}

/**
 * 这个请求里有没有事务已经提交（M2-P6 第 3 片复验）。数据库繁忙回 503 的前提是"这个请求的写入确定没有生效"（ADR-006）：
 * 出错的语句连同它所在的事务整体回滚。同一个请求里先前已经有事务提交过时，这个前提就不成立了——写入已经生效，
 * 异常过滤器据此改按意外错误回 500（结果未知），不让客户端把已经生效的写入当作"没有生效"去重试。
 *
 * 只记 TransactionRunner 的提交。请求路径上不经它、在连接池上自动提交的写（限流的占名额与退回、事务之外写的失败审计、
 * 会话的顺延、登录之后的顺带清理与重新哈希）不记：它们是认证与限流的附带记账，不是请求要做的那件事，重试时照样会发生。
 *
 * 每个应用实例一份（Nest 的依赖注入在每个应用里各建一个），不用全局单例：同一个进程里可能有多个应用（例如集成测试）。
 * 不在请求里（命令行、定时任务）时没有记录，记账与查询都是空操作
 */
@Injectable()
export class CommitLedger {
  readonly #storage = new AsyncLocalStorage<RequestCommits>()

  /** 每个请求一份记录：在 HTTP 管线里排在请求上下文之后（configure-http.ts） */
  middleware(): RequestHandler {
    return (_request, _response, next) => {
      this.#storage.run({ committed: false }, next)
    }
  }

  /** 事务已经提交（TransactionRunner 在 COMMIT 成功之后调用）；不在请求里时什么也不做 */
  recordCommit(): void {
    const commits = this.#storage.getStore()
    if (commits !== undefined)
      commits.committed = true
  }

  /** 当前请求里有没有事务已经提交；不在请求里时为假 */
  hasCommitted(): boolean {
    return this.#storage.getStore()?.committed === true
  }
}
