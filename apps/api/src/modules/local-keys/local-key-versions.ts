import type { Transaction } from '../database/index.ts'
import { Injectable } from '@nestjs/common'
import { LocalKeysRepository } from './local-keys.repository.ts'

/** 一个人当前的本机密钥的摘要：版本与生成的时刻，不带密钥材料 */
export interface LocalKeyState {
  readonly version: number
  readonly createdAt: Date
}

/**
 * 读当前的本机密钥的版本与摘要（M3-P6 设计 §3.5、§3.6）：不加锁、不解包、不带任何密钥材料，在调用方的事务或只读快照里读。
 * workspace 的心跳带上调用者自己的版本（正在编辑的页面据此得知密钥已被吊销）；admin 的账户视图带上每个人的摘要
 */
@Injectable()
export class LocalKeyVersions {
  constructor(private readonly repository: LocalKeysRepository) {}

  /** 这个人当前的那一把的版本；从没取过时为 null */
  async currentVersionOf(userId: string, transaction: Transaction): Promise<number | null> {
    return (await this.repository.currentVersionOf(userId, transaction)) ?? null
  }

  /** 这些人各自当前的那一把的摘要（一条语句）；没有的人不在结果里 */
  async statesOf(userIds: readonly string[], transaction: Transaction): Promise<ReadonlyMap<string, LocalKeyState>> {
    const rows = await this.repository.currentOf(userIds, transaction)
    return new Map(rows.map(row => [row.userId, { version: row.version, createdAt: row.createdAt }]))
  }
}
