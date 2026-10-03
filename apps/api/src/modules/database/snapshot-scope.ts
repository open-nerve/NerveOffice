import { AsyncLocalStorage } from 'node:async_hooks'
import { Injectable } from '@nestjs/common'

/** 一个只读快照的标记：快照结束时改为 false，快照里排下、结束之后才执行的操作就不再算在快照里 */
export interface SnapshotMark {
  open: boolean
}

/**
 * "正在只读快照里"（M2 Codex 评审 CX1；复验的必须修 1 把它从 TransactionRunner 的私有字段挪到 database 模块共用的这一处）。
 * TransactionRunner.readSnapshot 在快照里设上，两处据此拒绝：
 * - TransactionRunner：快照里再开快照或写事务（NESTED_IN_SNAPSHOT_MESSAGE：另借连接，连接池满时与外层互相等待）；
 * - 连接池（pool.ts）：快照里在连接池上查询、借连接（POOL_IN_SNAPSHOT_MESSAGE：读到的是快照之外的数据）。
 * 标记跟着快照里发起的异步操作一直走（AsyncLocalStorage），只在快照还没结束时生效。
 * 每个应用实例一份（Nest 的依赖注入在每个应用里各建一个，连接池与事务运行器拿到的是同一份；与 CommitLedger 相同），
 * 不用全局单例：同一个进程里可能有多个应用（例如集成测试）
 */
@Injectable()
export class SnapshotScope {
  readonly #storage = new AsyncLocalStorage<SnapshotMark>()

  /** 在快照的标记里执行 work：work 与它发起的异步操作里 active() 为真，直到调用方把 mark.open 改为 false（快照结束） */
  run<T>(mark: SnapshotMark, work: () => T): T {
    return this.#storage.run(mark, work)
  }

  /** 正在一个还没结束的只读快照里 */
  active(): boolean {
    return this.#storage.getStore()?.open === true
  }
}
