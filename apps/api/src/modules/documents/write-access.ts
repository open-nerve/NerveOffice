import type { Transaction } from '../database/index.ts'

/**
 * 收回写入权的范围（M2-P2 设计 §3.7）：
 * - user：某人（停用账户）：这个人什么也做不了了，M3 起他持有的租约一律结束（lease-write-access.ts）。只用于停用；
 * - membership：某人在某个空间（移出空间、调整空间角色）；
 * - space：整个空间（归档）；
 * - documents：这些文档上的所有人（跨空间移动：权限随之改变，00 号计划书 §5.4；M2-P4 的删除同样用它）。
 *   一次给一批而不是逐份调用：文件夹连同子树跨空间移动时一次就是整棵子树里的文档，
 *   租约的实现各用一条语句结束它们的租约、给它们加代次，调用方不必循环（M2-P4 S2b）；
 * - userDocuments：某人在这些文档上（取消或降低单独授权，M2-P5 设计 §3.4(3)）。只涉及这一个人：
 *   不能用 documents——那是"这些文档上的所有人"，正在编辑这份文档的别人也会被拉进来重新判断、锁住他的租约行
 *   （他的心跳要等这次撤权提交，tests/integration 的 documents/lease-revocation-locks.test.ts）。
 * 每种范围涉及谁、哪些文档，见下面的 coversWriter（各种范围的含义只写在那一处）。
 */
export type WriteAccessScope
  = | { readonly kind: 'user', readonly userId: string }
    | { readonly kind: 'membership', readonly userId: string, readonly spaceId: string }
    | { readonly kind: 'space', readonly spaceId: string }
    | { readonly kind: 'documents', readonly documentIds: readonly string[] }
    | { readonly kind: 'userDocuments', readonly userId: string, readonly documentIds: readonly string[] }

/** 某人在某份文档上的写入（M3 起是他持有的编辑租约）：documentId 所在的空间是 spaceId */
export interface DocumentWriter {
  readonly userId: string
  readonly documentId: string
  readonly spaceId: string
}

/**
 * 这次收回涉及这一处写入吗：范围的含义（上面的清单）在这里写成规则，单元测试逐种核对，
 * 尤其是 userDocuments 只涉及那一个人、documents 涉及那些文档上的所有人（M2-P5 设计 §3.4(3)）。
 * 涉及只是"要重新判断"：租约的实现（lease-write-access.ts）按它找出涉及的租约，再按变化之后的权限判断谁失去了写入权
 * （调用方不自己判断）。租约的仓储按同样的含义写成 SQL 的条件（edit-leases.repository.ts 的 writersIn，M3-P1）：改这里时同时改那里，
 * 两边逐种同义由 edit-lease-statements.test.ts 核对
 */
export function coversWriter(scope: WriteAccessScope, writer: DocumentWriter): boolean {
  switch (scope.kind) {
    case 'user':
      return writer.userId === scope.userId
    case 'membership':
      return writer.userId === scope.userId && writer.spaceId === scope.spaceId
    case 'space':
      return writer.spaceId === scope.spaceId
    case 'documents':
      return scope.documentIds.includes(writer.documentId)
    case 'userDocuments':
      return writer.userId === scope.userId && scope.documentIds.includes(writer.documentId)
  }
}

/**
 * 收回写入权的入口（M2 总设计 §2.1 第 8 条，00 号计划书 §6.4）：撤权、移出空间、停用账户、归档、删除、跨空间移动与转移都经这里，
 * 调用方在改动权限的同一个事务里、改动之后调用。调用方不自己判断谁失去了写入权：由入口按变化之后的权限判断。
 * 实现是 lease-write-access.ts 的 LeaseWriteAccessRevocation（M3-P1）：结束失去写入权的人持有的编辑租约，并给那些文档的代次加一
 */
export abstract class WriteAccessRevocation {
  abstract revoke(scope: WriteAccessScope, transaction: Transaction): Promise<void>
}
