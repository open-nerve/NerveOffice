// 进程入口（P2 设计 §3.2）：读配置 → 建应用 → 监听 → 接管信号。组装都在本目录的其他文件里，这里只对接进程。
import process from 'node:process'
import { createRootLogger } from '../modules/logging/index.ts'
import { ConfigError, createApplication, loadServerConfigFromEnvironment } from './index.ts'
import { handleFatalErrors, handleShutdownSignals } from './process-handlers.ts'

// 配置读出来之前还没有应用的日志，启动失败的原因写到这里（同步写标准输出，退出前不会丢）
const bootstrapLogger = createRootLogger({ level: 'info' })
const exit = (code: number): void => process.exit(code)
handleFatalErrors({ process, exit, logger: bootstrapLogger })

async function main(): Promise<void> {
  // 应用进程的读法：另要求本机密钥的主密钥，缺失或写法不对时 ConfigError（下面记 fatal、退出码 1，说明里不带取值，M3-P6 设计 §3.4）
  const config = loadServerConfigFromEnvironment()
  const runtime = await createApplication(config)
  const { address, port } = await runtime.listen()
  runtime.logger.info({ address, port }, 'HTTP 服务已启动')
  handleShutdownSignals(async reason => runtime.shutdown(reason), { process, exit, logger: runtime.logger })
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError)
    bootstrapLogger.fatal({ code: error.code, issues: error.issues }, '配置不合法，无法启动')
  else
    bootstrapLogger.fatal({ err: error }, '启动失败')
  process.exit(1)
})
