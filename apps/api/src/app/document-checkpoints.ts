import type { DynamicModule } from '@nestjs/common'
import type { DestinationStream } from 'pino'
import type { AppConfig } from '../modules/config/index.ts'
import { Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { ConfigModule } from '../modules/config/index.ts'
import { DocumentsOperationsModule, DocumentUpgradeService } from '../modules/documents/index.ts'
import { AppLogger, createRootLogger, LoggingModule, NestPinoLogger, RequestContextStore } from '../modules/logging/index.ts'

@Module({})
class CheckpointCommandModule {
  static register(config: AppConfig, logger: AppLogger): DynamicModule {
    return { module: CheckpointCommandModule, imports: [ConfigModule.forRoot(config), LoggingModule.forRoot(logger), DocumentsOperationsModule] }
  }
}

export interface DocumentCheckpointApplication {
  readonly service: DocumentUpgradeService
  close: () => Promise<void>
}

/** 无 HTTP 的运维上下文；调用方在完成/中止当前短批后关闭连接池。 */
export async function openDocumentCheckpointApplication(config: AppConfig, options: { readonly logDestination?: DestinationStream } = {}): Promise<DocumentCheckpointApplication> {
  const rootLogger = createRootLogger({ level: config.log.level, destination: options.logDestination })
  const requestContext = new RequestContextStore()
  const logger = new AppLogger(rootLogger, requestContext)
  const context = await NestFactory.createApplicationContext(CheckpointCommandModule.register(config, logger), {
    abortOnError: false,
    logger: new NestPinoLogger(rootLogger, requestContext),
  })
  return { service: context.get(DocumentUpgradeService), close: async () => context.close() }
}
