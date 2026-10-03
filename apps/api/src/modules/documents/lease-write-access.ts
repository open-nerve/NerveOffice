import type { Transaction } from '../database/index.ts'
import type { RevocableEditLease } from './edit-leases.repository.ts'
import type { WriteAccessScope } from './write-access.ts'
import { Injectable } from '@nestjs/common'
import { canEditDocument, DocumentAccessPolicy } from './document-access-policy.ts'
import { DocumentsRepository } from './documents.repository.ts'
import { EditLeasesRepository } from './edit-leases.repository.ts'
import { WriteAccessRevocation } from './write-access.ts'

/**
 * 收回写入权接上编辑租约（M3-P1 设计 §3.4.6）：取代 M2 的空实现，调用方不改。在调用方改动权限的同一个事务里：
 * 1. 按范围找出没有明确结束的租约，先按文档 id 的顺序锁文档行、再锁租约行，锁下再核对一次范围（EditLeasesRepository.lockInScope）；
 * 2. 逐个按变化之后的权限判断持有者还能不能编辑（见 holderStillEdits）：访问策略在同一个事务里查，看得到调用方刚做的改动；
 * 3. 不能编辑了：租约记 revoked，文档的代次加一（各一条语句）。还能编辑的不动——跨空间移动、转移之后在新的空间里仍能编辑的持有者：
 *    调用方已经给代次加了一，他的租约按 stale 失效，P2 的页面自动续上。
 *
 * 收口"进行中的保存与撤权不互斥"（M2-P2 设计 §7、ADR-014）：保存在租约这一步之前锁住了文档行，撤权要给持有者的文档加代次，
 * 必须先拿到同一把锁。两者必有先后：保存先提交，撤权在它之后生效；撤权先提交，保存在锁下看到新的权限、结束了的租约与新的代次，被拒绝。
 * 申请在撤权提交之前判断了权限、在它之后才提交时，租约行不在第 1 步找得到的范围里（那时它还没提交），由有效条件的第 7 条在每次使用时
 * 让它失效（§3.4.1）。停用撤销了全部登录：申请锁住两行之后核对登录（requireActiveLogin，M3-P1 审查 A1），停用提交之后才核对的被拒绝，
 * 只剩"核对之后、提交之前"的几毫秒由第 6 条兜底。分享的写入、删除、移动与转移本身锁住文档行，与申请互斥，没有这个窗口。
 * 锁的顺序（ADR-014 的锁顺序表在文档行之后加上租约行）：调用方已经持有账户行、空间行、成员行或这些文档行，这里才锁文档行、租约行
 */
@Injectable()
export class LeaseWriteAccessRevocation extends WriteAccessRevocation {
  constructor(
    private readonly leases: EditLeasesRepository,
    private readonly documents: DocumentsRepository,
    private readonly policy: DocumentAccessPolicy,
  ) {
    super()
  }

  async revoke(scope: WriteAccessScope, transaction: Transaction): Promise<void> {
    const locked = await this.leases.lockInScope(scope, transaction)
    const lost: string[] = []
    // 逐个判断：持有者各不相同，权限按各自的空间角色与授权算（每次是访问策略的两条语句）
    for (const lease of locked) {
      if (!await this.holderStillEdits(scope, lease, transaction))
        lost.push(lease.documentId)
    }
    if (lost.length === 0)
      return
    await this.leases.endAll(lost, 'revoked', transaction)
    await this.documents.advanceWriteEpochs(lost, transaction)
  }

  /**
   * 变化之后，这条租约的持有者还能不能编辑这份文档：
   * - user（停用账户，write-access.ts 的定义）：这个人什么也做不了了。访问策略不看账户的状态（停用的人的每个请求都被会话守卫拦下），
   *   按策略他在各个空间里的角色还在，所以这一种不问策略，他持有的租约一律结束——明确记下 revoked、代次加一，与其余范围一致，
   *   不留一份只靠第 6 条（登录已撤销）才失效的租约（别人申请时也就不会因它得到"异常中断"的提醒）。停用之前就过了会话守卫、
   *   正在等锁的在途请求，由锁下对登录的再核对挡住（requireActiveLogin，M3-P1 审查 A1）；
   * - 文档进了回收站（删除的调用方先放进回收站再收回）：对普通接口不存在，谁也不能编辑；
   * - 其余按访问策略（canEditDocument）：空间角色与单独授权都已按调用方刚做的改动算。
   * 第 7 条（edit-lease.service.ts 的 holderFacts）与这里看同一个权限位
   */
  private async holderStillEdits(scope: WriteAccessScope, lease: RevocableEditLease, transaction: Transaction): Promise<boolean> {
    if (scope.kind === 'user')
      return false
    if (lease.documentStatus !== 'active')
      return false
    return canEditDocument(this.policy, lease.holderId, { id: lease.documentId, spaceId: lease.spaceId, createdBy: lease.createdBy }, transaction)
  }
}
