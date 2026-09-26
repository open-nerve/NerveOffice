// 进程入口（P2 设计 §3.2）：读配置 → 建应用 → 监听 → 接管信号。组装都在本目录的其他文件里，这里只对接进程。
import process from 'node:process'
import { ConsoleLogger } from '@nestjs/common'
import { ConfigError, createApplication, loadConfigFromEnvironment } from './index.ts'

const logger = new ConsoleLogger('main', { json: true })

async function main(): Promise<void> {
  const config = loadConfigFromEnvironment()
  const runtime = await createApplication(config, { logger })
  const address = await runtime.listen()
  logger.log(`HTTP 服务已启动：${address.address}:${address.port}`)

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      runtime.shutdown(signal).then(
        result => process.exit(result === 'graceful' ? 0 : 1),
        (error: unknown) => {
          logger.fatal(`退出失败：${error instanceof Error ? error.message : String(error)}`)
          process.exit(1)
        },
      )
    })
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError)
    logger.fatal(`${error.code} ${error.message}`)
  else
    logger.fatal(`启动失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exit(1)
})
