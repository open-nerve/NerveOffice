// 强制结束后端再启动（US-M1-10，P5 设计 §3.6），按运行方式区分：
// - 本机模式：向服务脚本发 SIGUSR2，它对后端发 SIGKILL 再按原来的参数启动（serve.ts）；
// - 外部模式（容器 E2E）：docker compose kill -s KILL app，等容器停下，再 start app。
// 两者之后都等后端重新可用：本机模式看就绪探针；外部模式的就绪探针不对外（Caddy 返回 404），看经 Caddy 的存活探针。
import type { APIRequestContext } from '@playwright/test'
import process from 'node:process'
import { compose } from './compose.ts'
import { expect } from './fixtures.ts'
import { readServerControl } from './server-control.ts'

/** 重启之后等后端重新可用的时限：容器要重新启动 Node 并完成启动自检 */
const RESTART_TIMEOUT_MS = 60_000

async function statusOf(request: APIRequestContext, path: string): Promise<number> {
  try {
    return (await request.get(path, { timeout: 5_000 })).status()
  }
  catch {
    // 后端还没起来：连接被拒绝或者被重置
    return 0
  }
}

export async function restartApi(request: APIRequestContext): Promise<void> {
  if (process.env.E2E_BASE_URL === undefined) {
    const before = readServerControl()
    process.kill(before.serverPid, 'SIGUSR2')
    await expect.poll(() => readServerControl().apiPid, { timeout: RESTART_TIMEOUT_MS }).not.toBe(before.apiPid)
    await expect.poll(async () => statusOf(request, '/api/health/ready'), { timeout: RESTART_TIMEOUT_MS }).toBe(200)
    return
  }
  compose(['kill', '-s', 'KILL', 'app'])
  // 等容器真的停下：还在运行时 start 什么都不做
  await expect.poll(() => compose(['ps', '--quiet', '--status', 'running', 'app']).trim(), { timeout: 10_000 }).toBe('')
  compose(['start', 'app'])
  await expect.poll(async () => statusOf(request, '/api/health/live'), { timeout: RESTART_TIMEOUT_MS }).toBe(200)
}
