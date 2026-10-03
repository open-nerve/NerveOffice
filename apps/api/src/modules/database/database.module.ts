import type { OnApplicationShutdown } from '@nestjs/common'
import type { AppConfig } from '../config/index.ts'
import { Inject, Injectable, Module } from '@nestjs/common'
import pg from 'pg'
import { APP_CONFIG } from '../config/index.ts'
import { AppLogger } from '../logging/index.ts'
import { CommitLedger } from './commit-ledger.ts'
import { DatabaseReadiness } from './database-readiness.ts'
import { DatabaseTime } from './database-time.ts'
import { createDatabase, DATABASE, PG_POOL } from './database.ts'
import { ExclusiveRunner } from './exclusive-runner.ts'
import { createPool } from './pool.ts'
import { SnapshotScope } from './snapshot-scope.ts'
import { TransactionRunner } from './transaction-runner.ts'

/**
 * 退出时关闭连接池。onApplicationShutdown 在 HTTP 服务关闭之后调用，
 * 而 ApplicationRuntime 在关闭应用之前已经排空了在途请求（ADR-004）。
 */
@Injectable()
class PoolLifecycle implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end()
  }
}

@Module({
  providers: [
    // "正在只读快照里"的标记：连接池在快照进行中拒绝查询，事务运行器拒绝在快照里再开事务，两处用同一份（M2 Codex 评审复验的必须修 1）
    SnapshotScope,
    {
      provide: PG_POOL,
      inject: [APP_CONFIG, AppLogger, SnapshotScope],
      useFactory: (config: AppConfig, logger: AppLogger, snapshots: SnapshotScope) => createPool(config.database, logger.with({ module: 'database' }), snapshots),
    },
    {
      provide: DATABASE,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool) => createDatabase(pool),
    },
    // 这个应用里每个请求有没有事务已经提交（M2-P6 第 3 片复验）：事务运行器记账，HTTP 管线的中间件与异常过滤器经 app 层取用
    CommitLedger,
    DatabaseReadiness,
    DatabaseTime,
    TransactionRunner,
    ExclusiveRunner,
    PoolLifecycle,
  ],
  exports: [DATABASE, CommitLedger, DatabaseReadiness, DatabaseTime, TransactionRunner, ExclusiveRunner],
})
export class DatabaseModule {}
