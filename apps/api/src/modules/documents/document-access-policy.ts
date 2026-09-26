import { Injectable } from '@nestjs/common'
import { SpacesService } from '../spaces/index.ts'

/** 调用者对一份文档的权限（00 号计划书 §5.2）：所有者（个人空间的所有者或空间管理员）、编辑者、查看者。 */
export type DocumentAccess = 'owner' | 'editor' | 'viewer'

/** 判断权限要用到的文档属性。 */
export interface AccessTarget {
  readonly spaceId: string
}

/**
 * 文档的访问策略（P3 设计 §3.6）：服务只经这个接口判断权限。
 * M2 在同一个接口后面扩展为有效权限（空间角色与单独授权取较高者），控制器与服务不改。
 */
export abstract class DocumentAccessPolicy {
  /** 没有任何权限时返回 undefined：调用方按"不存在"处理，不暴露文档是否存在 */
  abstract accessOf(userId: string, document: AccessTarget): Promise<DocumentAccess | undefined>
}

/** M1 只有一条规则：文档所在的空间是这个人的个人空间。 */
@Injectable()
export class PersonalSpaceAccessPolicy extends DocumentAccessPolicy {
  constructor(private readonly spaces: SpacesService) {
    super()
  }

  async accessOf(userId: string, document: AccessTarget): Promise<DocumentAccess | undefined> {
    return (await this.spaces.isOwner(userId, document.spaceId)) ? 'owner' : undefined
  }
}
