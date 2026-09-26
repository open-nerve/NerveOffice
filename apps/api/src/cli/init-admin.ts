// 初始化首个系统管理员（P3 设计 §3.4，US-M1-01）：部署后执行一次。
//   node dist/cli/init-admin.js --username <用户名> [--display-name <显示名>] [--password-stdin]
// 开发环境用 pnpm admin:init --username <用户名>。退出码：0 成功；1 已初始化、输入不合法或其他错误；2 用法错误。
import process from 'node:process'
import { AppError, ConfigError, initializeAdmin, loadConfigFromEnvironment } from '../app/index.ts'
import { createRootLogger } from '../modules/logging/index.ts'
import { readAdminPassword } from './admin-password.ts'
import { INIT_ADMIN_USAGE, parseInitAdminArguments, UsageError } from './init-admin-arguments.ts'
import { InputCancelled } from './password-input.ts'

const logger = createRootLogger({ level: 'info' })

async function main(): Promise<void> {
  const args = parseInitAdminArguments(process.argv.slice(2))
  const config = loadConfigFromEnvironment()
  const password = await readAdminPassword(args.passwordStdin, { stdin: process.stdin, stderr: process.stderr })
  const admin = await initializeAdmin(config, { username: args.username, displayName: args.displayName, password })
  logger.info({ userId: admin.userId, username: admin.username, personalSpaceId: admin.personalSpaceId }, '已初始化系统管理员')
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n${INIT_ADMIN_USAGE}\n`)
      process.exit(2)
    }
    if (error instanceof ConfigError)
      logger.fatal({ code: error.code, issues: error.issues }, '配置不合法，无法初始化管理员')
    else if (error instanceof AppError)
      logger.fatal({ code: error.code }, error.message)
    else if (error instanceof InputCancelled)
      logger.fatal('已取消，没有做任何改动')
    else
      logger.fatal({ err: error }, '初始化管理员失败')
    process.exit(1)
  },
)
