import type { ServerConfig } from '../config/index.ts'
import { Module } from '@nestjs/common'
import { LOCAL_KEYS_CONFIG } from '../config/index.ts'
import { DatabaseModule } from '../database/index.ts'
import { LocalKeyRevocation } from './local-key-revocation.ts'
import { LocalKeyVersions } from './local-key-versions.ts'
import { LocalKeysRepository } from './local-keys.repository.ts'
import { MasterKeyCheck } from './master-key-check.ts'
import { MasterKeyring } from './master-keyring.ts'

/**
 * 本机密钥（M3-P6 设计 §3.7）：表、主密钥环、吊销的入口与版本的读取。依赖 database、config（主密钥，只有应用进程的组装提供）与 logging；
 * admin（吊销、账户的摘要）与 workspace（心跳带版本）依赖它，auth、users、documents、spaces 不依赖它。命令行的模块组合不引入它：
 * 迁移、初始化管理员与签发重置链接都不需要主密钥。
 * 对外只有吊销的入口（只给 admin，lint）与版本的读取；解包、生成与主密钥环都在模块内部
 */
@Module({
  imports: [DatabaseModule],
  providers: [
    LocalKeysRepository,
    LocalKeyRevocation,
    LocalKeyVersions,
    MasterKeyCheck,
    {
      provide: MasterKeyring,
      inject: [LOCAL_KEYS_CONFIG],
      useFactory: (config: ServerConfig['localKeys']) => MasterKeyring.fromMasterKey(config.masterKey),
    },
  ],
  exports: [LocalKeyRevocation, LocalKeyVersions],
})
export class LocalKeysModule {}
