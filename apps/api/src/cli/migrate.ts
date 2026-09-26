// 迁移命令（P2 设计 §3.7，ADR-005）：生产环境在启动应用之前作为一次性任务运行（node dist/cli/migrate.js），
// 开发环境用 pnpm db:migrate。应用启动时不迁移，只检查库结构的版本。
import process from 'node:process'
import { ConfigError, loadConfigFromEnvironment } from '../modules/config/index.ts'
import { MigrationError, runMigrations } from '../modules/database/index.ts'
import { createRootLogger } from '../modules/logging/index.ts'

const logger = createRootLogger({ level: 'info' })

async function main(): Promise<void> {
  const config = loadConfigFromEnvironment()
  const outcome = await runMigrations({ connectionString: config.database.url, lockTimeoutMs: config.database.migrationLockTimeoutMs })
  if (outcome.status === 'current')
    logger.info({ outcome }, '库结构已是最新，不需要迁移')
  else
    logger.info({ outcome }, `已执行 ${outcome.applied} 个迁移`)
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    if (error instanceof ConfigError)
      logger.fatal({ code: error.code, issues: error.issues }, '配置不合法，无法迁移')
    else if (error instanceof MigrationError)
      logger.fatal({ reason: error.reason }, error.message)
    else
      logger.fatal({ err: error }, '迁移失败')
    process.exit(1)
  },
)
