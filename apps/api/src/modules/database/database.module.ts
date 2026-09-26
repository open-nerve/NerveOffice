import type { OnApplicationShutdown } from '@nestjs/common'
import type { AppConfig } from '../config/index.ts'
import { Inject, Injectable, Module } from '@nestjs/common'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { APP_CONFIG } from '../config/index.ts'
import { AppLogger } from '../logging/index.ts'
import { DatabaseReadiness } from './database-readiness.ts'
import { DATABASE, PG_POOL } from './database.ts'
import { createPool } from './pool.ts'

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
    {
      provide: PG_POOL,
      inject: [APP_CONFIG, AppLogger],
      useFactory: (config: AppConfig, logger: AppLogger) => createPool(config.database, logger.with({ module: 'database' })),
    },
    {
      provide: DATABASE,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool) => drizzle({ client: pool }),
    },
    DatabaseReadiness,
    PoolLifecycle,
  ],
  exports: [DATABASE, DatabaseReadiness],
})
export class DatabaseModule {}
