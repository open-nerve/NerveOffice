// CI 测试进程的归属设施；只由 serve.ts 在本轮监督器启用时预加载，不进生产构建。
// 两处生产 fork 故意清空/白名单化环境。只追加随机非秘密 UUID，绝不把父环境或凭据带进去。
// 在创建时保留标记，避免快速父退后的孤儿进程落在 /proc 轮询之间。
import type { ChildProcess, ForkOptions } from 'node:child_process'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import process from 'node:process'

const variable = 'NERVE_TEST_CI_E2E_OWNER'
const owner = process.env[variable]
if (owner !== undefined) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(owner))
    throw new Error('CI 进程归属标记必须是随机 UUID')
  const originalFork = childProcess.fork
  const marked = (options: ForkOptions | undefined): ForkOptions | undefined => options?.env === undefined
    ? options
    : { ...options, env: { ...options.env, [variable]: owner } }
  childProcess.fork = (modulePath: string | URL, argsOrOptions?: readonly string[] | ForkOptions, options?: ForkOptions): ChildProcess => {
    if (Array.isArray(argsOrOptions))
      return originalFork(modulePath, argsOrOptions, marked(options))
    return originalFork(modulePath, [], marked(argsOrOptions as ForkOptions | undefined ?? options))
  }
  // 生产模块使用 ESM named import { fork }；同步内建模块的绑定，不替换任何产品模块。
  syncBuiltinESMExports()
}
