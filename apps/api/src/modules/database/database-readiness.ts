import type { OnApplicationBootstrap } from '@nestjs/common'
import { Inject, Injectable } from '@nestjs/common'
import pg from 'pg'
import { AppLogger } from '../logging/index.ts'
import { PG_POOL } from './database.ts'
import { compareMigrations, readAppliedMigrations, readExpectedMigrations } from './migrations.ts'

export type DatabaseReadinessResult
  = | { readonly ready: true }
    | { readonly ready: false, readonly reason: string }

/** 就绪检查的时限：探针不能被慢连接挂住（P2 设计 §3.9）。 */
export const READINESS_TIMEOUT_MS = 2_000

/**
 * 数据库是否就绪：连得上，并且库结构版本与这次带来的迁移一致（P2 设计 §3.7、§3.9）。
 * 应用启动时只检查、只记日志，不自动迁移（M1 总设计 §6.2）。
 */
@Injectable()
export class DatabaseReadiness implements OnApplicationBootstrap {
  readonly #expected = readExpectedMigrations()
  readonly #logger: AppLogger

  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool, logger: AppLogger) {
    this.#logger = logger.with({ module: 'database' })
  }

  async check(): Promise<DatabaseReadinessResult> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<DatabaseReadinessResult>((resolve) => {
      timer = setTimeout(resolve, READINESS_TIMEOUT_MS, { ready: false, reason: `数据库检查超过 ${READINESS_TIMEOUT_MS} 毫秒` })
    })
    try {
      return await Promise.race([this.#check(), timeout])
    }
    finally {
      clearTimeout(timer)
    }
  }

  async onApplicationBootstrap(): Promise<void> {
    const result = await this.check()
    if (result.ready)
      this.#logger.info('数据库已就绪，库结构版本一致')
    else
      this.#logger.warn('数据库未就绪，就绪探针会失败', { reason: result.reason })
  }

  async #check(): Promise<DatabaseReadinessResult> {
    let client: pg.PoolClient
    try {
      client = await this.pool.connect()
    }
    catch {
      return { ready: false, reason: '数据库不可达' }
    }
    try {
      const status = compareMigrations(this.#expected, await readAppliedMigrations(client))
      if (status.status === 'pending')
        return { ready: false, reason: `库结构版本落后：待执行 ${status.pending} 个迁移` }
      if (status.status === 'diverged')
        return { ready: false, reason: `库结构不一致：${status.reason}` }
      return { ready: true }
    }
    catch {
      return { ready: false, reason: '数据库查询失败' }
    }
    finally {
      client.release()
    }
  }
}
