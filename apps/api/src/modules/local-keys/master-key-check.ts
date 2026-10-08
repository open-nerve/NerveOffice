import type { OnApplicationBootstrap } from '@nestjs/common'
import type { StartupCheckOutcome } from '../../shared/startup-check.ts'
import type { MasterKeyUsage } from './local-keys.repository.ts'
import { Injectable } from '@nestjs/common'
import { runStartupCheck, STARTUP_CHECK_WAIT_MS } from '../../shared/startup-check.ts'
import { AppLogger } from '../logging/index.ts'
import { LocalKeysRepository } from './local-keys.repository.ts'
import { MasterKeyring } from './master-keyring.ts'

/**
 * 库里有当前的本机密钥是别的主密钥包装的：这些人取密钥会失败（500），处置写在说明里。日志只有把数、不列出是谁（不往日志里写一串账户），
 * 怎样查出这些人在部署说明里（按这条日志里的 masterKeyId 查库，审查 B4）
 */
export const FOREIGN_MASTER_KEY_ERROR = '库里有当前的本机密钥不是现在配置的主密钥包装的：这些人取本机密钥会失败。'
  + '找回原来的主密钥并配置回去；确实丢了，就按部署说明（"本机密钥的主密钥"一节）用这条日志里的 masterKeyId 在数据库里查出这些人，'
  + '在管理界面的账户页逐个吊销他们的本机密钥（吊销不需要旧的主密钥，下一版用现在的主密钥包装）。已保存的文档不受影响'

/**
 * 启动时核对主密钥（M3-P6 设计 §3.4）：记下现在配置的主密钥的标识（十六进制，不是机密，运维据此核对部署的是哪一把），
 * 库里有当前的本机密钥是别的主密钥包装的就记 error，带上把数与处置。只记日志、照常启动（设计 §3.1：主密钥丢了也不让整个服务停摆，
 * 手误贴错了也不自动作废任何人的密钥，处置走显式的吊销）；查询失败（例如数据库不可达、还没有迁移）时跳过，就绪探针另有报告。
 * 启动最多等 2 秒（启动自检共同的做法）
 */
@Injectable()
export class MasterKeyCheck implements OnApplicationBootstrap {
  readonly #logger: AppLogger

  constructor(
    private readonly repository: LocalKeysRepository,
    private readonly keyring: MasterKeyring,
    logger: AppLogger,
  ) {
    this.#logger = logger.with({ module: 'local-keys' })
  }

  async onApplicationBootstrap(): Promise<void> {
    await runStartupCheck({
      run: async () => this.repository.currentUsageByMasterKey(),
      report: outcome => this.#report(outcome),
      slow: () => this.#logger.warn(`核对库里的本机密钥是哪把主密钥包装的超过 ${STARTUP_CHECK_WAIT_MS} 毫秒，先照常启动，有了结果再记`, { masterKeyId: this.keyring.currentMasterKeyId }),
    })
  }

  #report(outcome: StartupCheckOutcome<readonly MasterKeyUsage[]>): void {
    const masterKeyId = this.keyring.currentMasterKeyId
    if ('error' in outcome) {
      this.#logger.warn('没能核对库里的本机密钥是哪把主密钥包装的，跳过', { masterKeyId, err: outcome.error })
      return
    }
    const usage = outcome.value.map(entry => ({ masterKeyId: entry.masterKeyId.toString('hex'), keys: entry.keys }))
    const currentKeys = usage.find(entry => entry.masterKeyId === masterKeyId)?.keys ?? 0
    const foreign = usage.filter(entry => entry.masterKeyId !== masterKeyId).toSorted((a, b) => a.masterKeyId.localeCompare(b.masterKeyId))
    if (foreign.length === 0) {
      this.#logger.info('本机密钥的主密钥已就绪', { masterKeyId, currentKeys })
      return
    }
    const foreignKeys = foreign.reduce((total, entry) => total + entry.keys, 0)
    this.#logger.error(FOREIGN_MASTER_KEY_ERROR, { masterKeyId, currentKeys, foreignKeys, foreignMasterKeys: foreign })
  }
}
