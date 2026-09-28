// 运维命令：为指定账户签发重置密码的一次性链接（M2-P1 设计 §3.9）。唯一的系统管理员忘记密码时用它恢复。
//   node dist/cli/reset-link.js --username <登录名>
// 开发环境用 pnpm admin:reset-link --username <登录名>。退出码：0 成功；1 账户不存在、已停用或其他错误；2 用法错误。
// 链接只写到标准输出（给执行命令的运维人员），日志里只有账户与到期时间。
import process from 'node:process'
import { AppError, ConfigError, issueResetLink, loadConfigFromEnvironment } from '../app/index.ts'
import { createRootLogger } from '../modules/logging/index.ts'
import { UsageError } from './init-admin-arguments.ts'
import { parseResetLinkArguments, RESET_LINK_USAGE } from './reset-link-arguments.ts'

const logger = createRootLogger({ level: 'info' })

async function main(): Promise<void> {
  const { username } = parseResetLinkArguments(process.argv.slice(2))
  const config = loadConfigFromEnvironment()
  const issued = await issueResetLink(config, username)
  logger.info({ userId: issued.userId, expiresAt: issued.expiresAt }, '已签发重置链接')
  process.stdout.write(`${issued.url}\n`)
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n${RESET_LINK_USAGE}\n`)
      process.exit(2)
    }
    if (error instanceof ConfigError)
      logger.fatal({ code: error.code, issues: error.issues }, '配置不合法，无法签发重置链接')
    else if (error instanceof AppError)
      logger.fatal({ code: error.code }, error.code === 'NOT_FOUND' ? '没有这个账户' : error.message)
    else
      logger.fatal({ err: error }, '签发重置链接失败')
    process.exit(1)
  },
)
