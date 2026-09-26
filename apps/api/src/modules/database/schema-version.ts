import type { SchemaStatus } from './migrations.ts'
import { Inject, Injectable } from '@nestjs/common'
import pg from 'pg'
import { PG_POOL } from './database.ts'
import { compareMigrations, readAppliedMigrations, readExpectedMigrations } from './migrations.ts'

/** 库结构版本检查（P2 设计 §3.7）：应用启动时只检查、不迁移；版本不一致时就绪探针失败。 */
@Injectable()
export class SchemaVersion {
  readonly #expected = readExpectedMigrations()

  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async check(): Promise<SchemaStatus> {
    return compareMigrations(this.#expected, await readAppliedMigrations(this.pool))
  }
}
