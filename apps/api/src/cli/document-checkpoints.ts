import type { DocumentUpgradeReceipt } from '../app/index.ts'
import process from 'node:process'
import { destination } from 'pino'
import { ConfigError, DocumentUpgradeError, loadConfigFromEnvironment, openDocumentCheckpointApplication } from '../app/index.ts'
import { createRootLogger } from '../modules/logging/index.ts'
import { DOCUMENT_CHECKPOINT_USAGE, parseDocumentCheckpointArguments } from './document-checkpoints-arguments.ts'
import { UsageError } from './init-admin-arguments.ts'

const logDestination = destination({ fd: 2, sync: true })
const logger = createRootLogger({ level: 'info', destination: logDestination })

async function main(): Promise<number> {
  const command = parseDocumentCheckpointArguments(process.argv.slice(2))
  const controller = new AbortController()
  const stop = (): void => {
    if (!controller.signal.aborted) {
      controller.abort()
      logger.info('收到退出信号，当前短批结束后停止；不会自动解除写入冻结')
    }
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try {
    const app = await openDocumentCheckpointApplication(loadConfigFromEnvironment(), { logDestination })
    try {
      let result: DocumentUpgradeReceipt
      const service = app.service
      switch (command.action) {
        case 'prepare':
          result = await service.prepare(command.target)
          break
        case 'resume':
          result = await service.resume(command.batch, command.batchSize, controller.signal)
          break
        case 'status':
          result = await service.status(command.batch)
          break
        case 'release':
          result = await service.release(command.batch)
          break
        case 'abort':
          result = await service.abort(command.batch)
          break
      }
      process.stdout.write(`${JSON.stringify({ ...result, ...(controller.signal.aborted ? { interrupted: true } : {}) })}\n`)
      return controller.signal.aborted ? 1 : 0
    }
    finally {
      await app.close()
    }
  }
  finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}

main().then(code => process.exit(code), (error: unknown) => {
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n${DOCUMENT_CHECKPOINT_USAGE}\n`)
    process.exit(2)
  }
  const code = error instanceof DocumentUpgradeError ? error.code : error instanceof ConfigError ? 'configuration_invalid' : 'database_failure'
  // 原始数据库错误可能带 SQL/参数；只报告有限代码，运维用 status 核对已提交事实。
  logger.error({ code }, error instanceof DocumentUpgradeError ? error.message : '命令未能确认完成；修正配置或连接后执行 status 核对，再决定接续或解除冻结')
  process.stdout.write(`${JSON.stringify({ error: code })}\n`)
  process.exit(1)
})
