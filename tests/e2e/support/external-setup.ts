// 外部模式的全局准备（P5 设计 §3.6），在 Playwright 的主进程里执行：
// 1. 由容器 E2E 的编排脚本启动时（E2E_RUNNER_PID），编排脚本不在了就停下本次运行；
// 2. 被测环境里还没有 E2E 的管理员时，经 docker compose 用初始化命令创建，与本机模式的服务脚本是同一个账户（E2E_ADMIN）、
//    同一条路径（密码经标准输入）。已经有了就不再执行：初始化只能执行一次。
import process from 'node:process'
import { compose } from './compose.ts'
import { withDatabase } from './database.ts'
import { E2E_ADMIN } from './environment.ts'

/**
 * 编排脚本把 Playwright 放在单独的进程组里，自己被强制结束（SIGKILL）时通知不到它：每秒看一次编排脚本还在不在，
 * 不在了就给自己发 SIGINT，正常结束本次运行，不再对没人清理的环境跑下去（复验 SB2）
 */
function stopWithRunner(): void {
  const runner = Number(process.env.E2E_RUNNER_PID)
  if (!Number.isInteger(runner) || runner <= 0)
    return
  const timer = setInterval(() => {
    try {
      process.kill(runner, 0)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
        return
      clearInterval(timer)
      process.kill(process.pid, 'SIGINT')
    }
  }, 1_000)
  timer.unref()
}

export default async function globalSetup(): Promise<void> {
  stopWithRunner()
  const existing = await withDatabase(async client => (await client.query('SELECT 1 FROM users WHERE username = $1', [E2E_ADMIN.username])).rowCount)
  if (existing !== 0)
    return
  compose(
    ['run', '--rm', '--no-deps', '-T', 'app', 'node', 'dist/cli/init-admin.js', '--username', E2E_ADMIN.username, '--display-name', E2E_ADMIN.displayName, '--password-stdin'],
    E2E_ADMIN.password,
  )
}
