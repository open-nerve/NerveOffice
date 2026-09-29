import type { Transaction } from '../database/index.ts'
import { Injectable } from '@nestjs/common'

/**
 * 收回写入权的范围（M2-P2 设计 §3.7）：
 * - user：某人（停用账户）；
 * - membership：某人在某个空间（移出空间、调整空间角色）；
 * - space：整个空间（归档）；
 * - documents：这些文档上的所有人（跨空间移动：权限随之改变，00 号计划书 §5.4；M2-P4 的删除同样用它）。
 *   一次给一批而不是逐份调用：文件夹连同子树跨空间移动时一次就是整棵子树里的文档，
 *   M3 接租约之后可以一条语句终止它们的租约，调用方不必循环（M2-P4 S2b）。
 * P5 加上某人在某份文档（取消或降低单独授权）。
 */
export type WriteAccessScope
  = | { readonly kind: 'user', readonly userId: string }
    | { readonly kind: 'membership', readonly userId: string, readonly spaceId: string }
    | { readonly kind: 'space', readonly spaceId: string }
    | { readonly kind: 'documents', readonly documentIds: readonly string[] }

/**
 * 收回写入权的入口（M2 总设计 §2.1 第 8 条，00 号计划书 §6.4）：撤权、移出空间、停用账户、归档都经这里，
 * 调用方在改动权限的同一个事务里调用。调用方不自己判断谁失去了写入权：由入口按变化之后的权限判断。
 */
export abstract class WriteAccessRevocation {
  abstract revoke(scope: WriteAccessScope, transaction: Transaction): Promise<void>
}

/**
 * M2 的实现：还没有编辑租约，入口里没有要终止的东西。权限的变化与这次调用在同一个事务里提交，
 * 下一次请求重新判断权限，即被拒绝（保存在锁下再判断一次，ADR-011）。
 * M3 换成接入租约的实现：终止失去写入权的人持有的租约，并递增那些文档的 write_epoch；调用方不改。
 */
@Injectable()
export class LeaselessWriteAccessRevocation extends WriteAccessRevocation {
  async revoke(): Promise<void> {
    // 没有租约：见类的说明
  }
}
