// 运维命令（M2-P1 设计 §3.9）：本机模式直接执行后端的构建产物；外部模式（容器 E2E）按部署说明，
// 经 docker compose exec 在运行中的应用容器里执行（输出直接回到这里，不经容器的日志驱动，deploy/README.md）。
import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { compose } from './compose.ts'
import { e2eDatabaseUrl, e2eOrigin } from './environment.ts'

const RESET_LINK = fileURLToPath(new URL('../../../apps/api/dist/cli/reset-link.js', import.meta.url))

/** 为这个登录名签发重置链接；返回命令的标准输出（只有链接，日志在标准错误） */
export function issueResetLinkThroughCommand(username: string): string {
  if (process.env.E2E_BASE_URL !== undefined)
    return compose(['exec', '-T', 'app', 'node', 'dist/cli/reset-link.js', '--username', username])
  const result = spawnSync(process.execPath, [RESET_LINK, '--username', username], {
    env: { PATH: process.env.PATH, NERVE_DATABASE_URL: e2eDatabaseUrl(), NERVE_PUBLIC_ORIGIN: e2eOrigin() },
    encoding: 'utf8',
  })
  if (result.status !== 0)
    throw new Error(`reset-link --username ${username} 失败（退出码 ${String(result.status)}）：${result.stderr}`)
  return result.stdout
}
