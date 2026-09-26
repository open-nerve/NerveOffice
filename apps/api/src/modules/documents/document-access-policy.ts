import type { Transaction } from '../database/index.ts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
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
  /**
   * 没有任何权限时返回 undefined：调用方按"不存在"处理，不暴露文档是否存在。
   * 在事务里判断时传入事务：查询走事务的连接，不再从连接池另取一个
   */
  abstract accessOf(userId: string, document: AccessTarget, transaction?: Transaction): Promise<DocumentAccess | undefined>
}

/** M1 只有一条规则：文档所在的空间是这个人的个人空间。 */
@Injectable()
export class PersonalSpaceAccessPolicy extends DocumentAccessPolicy {
  constructor(private readonly spaces: SpacesService) {
    super()
  }

  async accessOf(userId: string, document: AccessTarget, transaction?: Transaction): Promise<DocumentAccess | undefined> {
    return (await this.spaces.isOwner(userId, document.spaceId, { transaction })) ? 'owner' : undefined
  }
}

/** 不存在的文档也照样判断一次权限，用一个不存在的空间：两条路径做同样的查询，响应时间不暴露文档是否存在（P3 审查 A4）。 */
const MISSING_DOCUMENT: AccessTarget = { spaceId: '00000000-0000-0000-0000-000000000000' }

/** 能访问的文档与调用者的权限。 */
export interface Accessible<T extends AccessTarget> {
  readonly document: T
  readonly access: DocumentAccess
}

/**
 * 读取或编辑一份文档之前的权限判断：没有任何权限与不存在都是同一个 NOT_FOUND（规范 §4，US-M1-08）。
 * 文档不存在时也判断一次权限（见 MISSING_DOCUMENT）。
 */
export async function requireAccess<T extends AccessTarget>(
  policy: DocumentAccessPolicy,
  userId: string,
  document: T | undefined,
  transaction?: Transaction,
): Promise<Accessible<T>> {
  const access = await policy.accessOf(userId, document ?? MISSING_DOCUMENT, transaction)
  if (document === undefined || access === undefined)
    throw new AppError('NOT_FOUND')
  return { document, access }
}

/** 能不能改动文档的内容与元数据。 */
export function canEdit(access: DocumentAccess): boolean {
  return access !== 'viewer'
}
