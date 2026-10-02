// 文档整理的两张矩阵共用的预期（M2-P5 S4 把原来的一张拆成两个文件并行：document-matrix.test.ts 是空间内的改名、移动、删除，
// document-cross-space-matrix.test.ts 是跨空间的移动与复制）：每一类行怎么逐格推、被拒时怎么说。
// 预期逐格手写，不调用生产代码的规则；只凭授权的人那两列的推法见 matrix-world.ts 的 ACCESS_VIA。
import type { ActorName, Row, TargetName } from './matrix-world.ts'
import { accessViaOf, isArchived } from './matrix-world.ts'

/** 归档且全员可见的空间：所有人看得到（查看者），谁都不能改 */
export const NOBODY_CHANGES: Row = [403, 403, 403, 403, 403, 403, 403, 403]

/**
 * 内容的操作（改名）：内容权限是编辑者及以上能做——空间角色与授权取较高者。查看者（含全员可见的、只有查看授权的）看得到却不能做（403）；
 * 只有编辑授权的人在个人空间、团队空间、全员可见的空间里能做；归档的空间里所有人至多是查看者，也 403；
 * 个人空间只有所有者与被授权的人看得到，别人一概 404。
 */
export function contentEditor(success: 200): Readonly<Record<TargetName, Row>> {
  return {
    personal: [success, 404, 404, 404, 404, 404, 403, success],
    team: [404, success, success, 403, 404, 404, 403, success],
    visible: [403, success, success, 403, 403, 403, 403, success],
    archived: [404, 403, 403, 403, 404, 404, 403, 403],
    archivedVisible: NOBODY_CHANGES,
    missing: [404, 404, 404, 404, 404, 404, 404, 404],
  }
}

/**
 * 结构性的操作（空间内移动、删除本人创建的）：**空间角色**是编辑者及以上能做。与 contentEditor 只差最后一列：
 * 只有编辑授权的人没有空间角色（全员可见的空间里只是查看者），一律 403——他看得到这份文档，所以不是 404。
 */
export function structureEditor(success: 200 | 204): Readonly<Record<TargetName, Row>> {
  return {
    personal: [success, 404, 404, 404, 404, 404, 403, 403],
    team: [404, success, success, 403, 404, 404, 403, 403],
    visible: [403, success, success, 403, 403, 403, 403, 403],
    archived: [404, 403, 403, 403, 404, 404, 403, 403],
    archivedVisible: NOBODY_CHANGES,
    missing: [404, 404, 404, 404, 404, 404, 404, 404],
  }
}

/** 只有空间管理员（个人空间的所有者）能做；其他看得到的人 403（归档的空间里空间管理员也降为查看者；只凭授权的人没有空间角色）。 */
export function spaceAdminOnly(success: 200 | 204): Readonly<Record<TargetName, Row>> {
  return {
    personal: [success, 404, 404, 404, 404, 404, 403, 403],
    team: [404, success, 403, 403, 404, 404, 403, 403],
    visible: [403, success, 403, 403, 403, 403, 403, 403],
    archived: [404, 403, 403, 403, 404, 404, 403, 403],
    archivedVisible: NOBODY_CHANGES,
    missing: [404, 404, 404, 404, 404, 404, 404, 404],
  }
}

/**
 * 跨空间的目标空间那一维（M2-P4 设计 §3.2）：要看得到（否则 404，不暴露空间是否存在）、
 * 没有归档（409 SPACE_ARCHIVED，排在没有权限之前）、有新建的权限（否则 403）。
 * 与"在归档的空间里新建"刻意不同：那是 403"空间已归档，只能查看"，这里是 409。
 * 只凭授权的人：授权只到文档一级，目标空间对他与外人一样（看不到的 404，全员可见的只是查看者 403，归档且全员可见的 409）
 */
export function intoSpace(success: 200 | 201): Readonly<Record<TargetName, Row>> {
  return {
    personal: [success, 404, 404, 404, 404, 404, 404, 404],
    team: [404, success, success, 403, 404, 404, 404, 404],
    visible: [403, success, success, 403, 403, 403, 403, 403],
    archived: [404, 409, 409, 409, 404, 404, 404, 404],
    // 归档且全员可见：谁都看得到，所以谁都是 409（不是 404）
    archivedVisible: [409, 409, 409, 409, 409, 409, 409, 409],
    missing: [404, 404, 404, 404, 404, 404, 404, 404],
  }
}

/** 一行被拒时的说法：通常的一句；结构性的操作另有只凭授权的人的那一句（M2-P5 S1 定的两句） */
export interface DeniedMessages {
  readonly usual: string
  readonly grantOnly?: string
  /** 目标空间那一维的行：归档的目标是 409、到不了 403，被拒的说明不按归档改写 */
  readonly aboutTarget?: boolean
}

export const ARCHIVED = '空间已归档，只能查看'
export const SHARED_ONLY_MOVE = '这份文档是单独分享给你的，不能移动'
export const SHARED_ONLY_DELETE = '这份文档是单独分享给你的，不能删除'

/**
 * 一格 403 的说明，逐格按规则推出（S4 起逐格钉住）：
 * - 只凭授权的人（ACCESS_VIA 是 grant）做结构性的操作：他自己的那一句，与空间归不归档无关（恢复之后他照样不能做）；
 * - 否则在归档的空间里：空间已归档（M2-P6 复核 A 的 G3），目标空间那一维的行除外；
 * - 否则是这一行通常的说法（在全员可见的空间里只凭授权的人有空间角色"查看者"，所以也是这一句）。
 */
export function deniedMessageOf(messages: DeniedMessages, actor: ActorName, target: TargetName): string {
  if (messages.grantOnly !== undefined && accessViaOf(actor, target) === 'grant')
    return messages.grantOnly
  return messages.aboutTarget !== true && isArchived(target) ? ARCHIVED : messages.usual
}
