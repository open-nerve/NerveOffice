import type { LocalKey } from '@nerve-office/contracts'
import type { Buffer } from 'node:buffer'
import type { Principal } from '../auth/index.ts'
import type { Transaction } from '../database/index.ts'
import type { StoredLocalKey } from './local-keys.repository.ts'
import { Injectable } from '@nestjs/common'
import { SessionService } from '../auth/index.ts'
import { TransactionRunner } from '../database/index.ts'
import { LocalKeysRepository } from './local-keys.repository.ts'
import { generateLocalKey, MasterKeyring } from './master-keyring.ts'

/** 原始密钥交给响应：转成 base64 之后清零（尽力而为：响应要序列化成字符串，字符串清不掉） */
function reveal(version: number, rawKey: Buffer): LocalKey {
  try {
    return { version, key: rawKey.toString('base64') }
  }
  finally {
    rawKey.fill(0)
  }
}

/**
 * 本人取当前的本机密钥（M3-P6 设计 §3.5）：一个写事务——第一条语句核对这次登录（会话守卫之后、事务之前的撤销在这里挡住，401）→
 * 读当前的那一把 → 有就解包；没有就生成 32 字节随机数、包装成第 1 版插入（ON CONFLICT DO NOTHING）→ 插进去了就交出刚生成的；
 * 没插进去（并发的另一次取用赢了）就再读一次、解包。
 * 只按调用者自己的 id 取；不锁账户行（插入的外键检查只取 FOR KEY SHARE，不等停用、签发重置、吊销这些管理操作）。
 * 解不开（不认识的主密钥、包装结果对不上）时抛 LocalKeyUnwrapError：500，随请求日志记成 error（用户、版本、主密钥的标识，没有密钥材料），
 * 不自动重新生成。服务端不缓存解开的密钥：每次取用解包一次（几十微秒）
 */
@Injectable()
export class LocalKeyService {
  constructor(
    private readonly repository: LocalKeysRepository,
    private readonly keyring: MasterKeyring,
    private readonly sessions: SessionService,
    private readonly transactions: TransactionRunner,
  ) {}

  async fetch(principal: Principal): Promise<LocalKey> {
    // 会话守卫读出的账户：id 是数据库给出的小写写法（AAD 按它绑定）
    const userId = principal.user.id
    return this.transactions.run(async (transaction) => {
      await this.sessions.requireActive(principal.sessionId, transaction)
      const current = await this.repository.findCurrent(userId, transaction)
      if (current !== undefined)
        return this.#unwrap(userId, current)
      const rawKey = generateLocalKey()
      try {
        if (await this.repository.insertFirst(userId, this.keyring.wrap(rawKey, { userId, version: 1 }), transaction))
          return reveal(1, rawKey)
      }
      finally {
        rawKey.fill(0)
      }
      return this.#unwrap(userId, await this.#winnerOf(userId, transaction))
    })
  }

  /** 并发的另一次取用先插了第 1 版：这时它已经提交（插入等过它的结局），这条语句读得到 */
  async #winnerOf(userId: string, transaction: Transaction): Promise<StoredLocalKey> {
    const winner = await this.repository.findCurrent(userId, transaction)
    // 走不到：插入没插进去说明已经有第 1 版或者当前的一把，而有过任何一行的人恰好有一把当前的（不变量 I20）
    if (winner === undefined)
      throw new Error('第 1 版没插进去，却也读不到当前的本机密钥')
    return winner
  }

  #unwrap(userId: string, stored: StoredLocalKey): LocalKey {
    return reveal(stored.version, this.keyring.unwrap(stored.material, { userId, version: stored.version }))
  }
}
