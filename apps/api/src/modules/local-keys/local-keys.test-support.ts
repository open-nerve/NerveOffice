// local-keys 的单元测试共用：内存里的假仓储，按真实仓储的语义——当前的那一把（revoked_at 为空）至多一把、第一次插入撞上已有的
// 第 1 版或当前的一把时什么也不写（ON CONFLICT DO NOTHING）、吊销擦掉密钥材料、下一版撞上时报错。库里的语句、约束与并发由集成测试覆盖
import type { Buffer } from 'node:buffer'
import type { Transaction } from '../database/index.ts'
import type { LocalKeyRecord, LocalKeysRepository, MasterKeyUsage, RevokedLocalKeyRecord, StoredLocalKey } from './local-keys.repository.ts'
import type { WrappedLocalKey } from './master-keyring.ts'
import { randomBytes } from 'node:crypto'
import { vi } from 'vitest'
import { Secret } from '../../shared/secret.ts'
import { MasterKeyring } from './master-keyring.ts'

/** 服务交给仓储的事务：只核对原样传下去 */
export const TRANSACTION = { transaction: true } as unknown as Transaction

/** 一个新的主密钥环（随机的主密钥） */
export function keyring(): MasterKeyring {
  return MasterKeyring.fromMasterKey(new Secret(randomBytes(32).toString('base64')))
}

export interface FakeLocalKeyRow {
  readonly userId: string
  readonly version: number
  material: WrappedLocalKey | null
  readonly createdAt: Date
  revokedAt: Date | null
}

/**
 * 假仓储：rows 是"库里"的行；calls 按先后记下每次调用（核对顺序）；now 是"数据库的时间"（插入的行的生成时刻）；
 * revokedAt 是吊销时记下的时刻，写法与真实仓储交回的相同（带微秒的 UTC 文本：转成 Date 会丢掉微秒，原样传给 insertNext 才相等）
 */
export class FakeLocalKeysRepository {
  readonly rows: FakeLocalKeyRow[] = []
  readonly calls: string[] = []
  now = new Date('2026-10-08T03:00:00.000Z')
  revokedAt = '2026-10-08T03:05:00.123456Z'

  readonly findCurrent = vi.fn(async (userId: string, _transaction: Transaction): Promise<StoredLocalKey | undefined> => {
    this.calls.push('findCurrent')
    const row = this.currentRow(userId)
    return row === undefined || row.material === null ? undefined : { version: row.version, material: row.material }
  })

  readonly insertFirst = vi.fn(async (userId: string, material: WrappedLocalKey, _transaction: Transaction): Promise<boolean> => {
    this.calls.push('insertFirst')
    if (this.rows.some(row => row.userId === userId && (row.version === 1 || row.revokedAt === null)))
      return false
    this.rows.push({ userId, version: 1, material, createdAt: this.now, revokedAt: null })
    return true
  })

  readonly revokeCurrent = vi.fn(async (userId: string, _transaction: Transaction): Promise<RevokedLocalKeyRecord | undefined> => {
    this.calls.push('revokeCurrent')
    const row = this.currentRow(userId)
    if (row === undefined)
      return undefined
    row.revokedAt = new Date(this.revokedAt)
    row.material = null
    return { version: row.version, revokedAt: this.revokedAt }
  })

  readonly insertNext = vi.fn(async (userId: string, version: number, material: WrappedLocalKey, createdAt: string, _transaction: Transaction): Promise<void> => {
    this.calls.push('insertNext')
    if (this.rows.some(row => row.userId === userId && (row.version === version || row.revokedAt === null)))
      throw new Error('违反主键或"每人至多一把当前的"')
    this.rows.push({ userId, version, material, createdAt: new Date(createdAt), revokedAt: null })
  })

  readonly currentVersionOf = vi.fn(async (userId: string, _transaction: Transaction): Promise<number | undefined> => {
    this.calls.push('currentVersionOf')
    return this.currentRow(userId)?.version
  })

  readonly currentOf = vi.fn(async (userIds: readonly string[], _transaction: Transaction): Promise<LocalKeyRecord[]> => {
    this.calls.push('currentOf')
    return this.rows.filter(row => row.revokedAt === null && userIds.includes(row.userId)).map(row => ({ userId: row.userId, version: row.version, createdAt: row.createdAt }))
  })

  readonly currentUsageByMasterKey = vi.fn(async (): Promise<MasterKeyUsage[]> => {
    this.calls.push('currentUsageByMasterKey')
    const usage = new Map<string, { masterKeyId: Buffer, keys: number }>()
    for (const row of this.rows) {
      if (row.revokedAt !== null || row.material === null)
        continue
      const id = row.material.masterKeyId.toString('hex')
      const entry = usage.get(id) ?? { masterKeyId: row.material.masterKeyId, keys: 0 }
      entry.keys += 1
      usage.set(id, entry)
    }
    return [...usage.values()]
  })

  /** 当成 LocalKeysRepository 交给服务 */
  asRepository(): LocalKeysRepository {
    return this as unknown as LocalKeysRepository
  }

  /** 直接放进"库里"一行当前的（第 version 版，用这个环包装 rawKey） */
  seedCurrent(ring: MasterKeyring, userId: string, version: number, rawKey: Buffer): void {
    this.rows.push({ userId, version, material: ring.wrap(rawKey, { userId, version }), createdAt: this.now, revokedAt: null })
  }

  private currentRow(userId: string): FakeLocalKeyRow | undefined {
    return this.rows.find(row => row.userId === userId && row.revokedAt === null)
  }
}
