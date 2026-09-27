// 外部模式的全局准备（P5 设计 §3.6）：被测环境里还没有 E2E 的管理员时，经 docker compose 用初始化命令创建，
// 与本机模式的服务脚本是同一个账户（E2E_ADMIN）、同一条路径（密码经标准输入）。已经有了就不再执行：初始化只能执行一次。
import { compose } from './compose.ts'
import { withDatabase } from './database.ts'
import { E2E_ADMIN } from './environment.ts'

export default async function globalSetup(): Promise<void> {
  const existing = await withDatabase(async client => (await client.query('SELECT 1 FROM users WHERE username = $1', [E2E_ADMIN.username])).rowCount)
  if (existing !== 0)
    return
  compose(
    ['run', '--rm', '--no-deps', '-T', 'app', 'node', 'dist/cli/init-admin.js', '--username', E2E_ADMIN.username, '--display-name', E2E_ADMIN.displayName, '--password-stdin'],
    E2E_ADMIN.password,
  )
}
