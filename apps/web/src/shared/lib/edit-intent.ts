// 编辑器页地址里"新建之后直接进入编辑"的标记（M3-P2 设计 §3.4，M3 总设计 §2.1 的细化）：刚由自己新建的表格不可能有别人在编辑，
// 不必先阅读。平台页面新建表格之后整页跳到带 ?edit=new 的地址（features/documents/new-sheet-button.tsx），编辑器页认出它、能编辑时
// 直接申请编辑权，进入编辑之后用 history.replaceState 去掉它（刷新不再自动进入）。其余打开（含副本）一律先阅读。
// 两个入口共用：放在共享层（编辑器页的功能只由编辑器页的入口引用，平台页面引用不到它）
import { documentPagePath } from '@nerve-office/contracts'

export const EDIT_INTENT_PARAM = 'edit'
export const EDIT_INTENT_NEW = 'new'

/** 新建之后打开它：直接进入编辑 */
export function newDocumentPagePath(documentId: string): string {
  return `${documentPagePath(documentId)}?${new URLSearchParams({ [EDIT_INTENT_PARAM]: EDIT_INTENT_NEW }).toString()}`
}

/** 地址的查询串里有"新建之后直接进入编辑"的标记 */
export function hasEditIntent(search: string): boolean {
  return new URLSearchParams(search).get(EDIT_INTENT_PARAM) === EDIT_INTENT_NEW
}

/** 去掉标记之后的地址（路径、其余的查询与片段不变） */
export function withoutEditIntent(href: string): string {
  const url = new URL(href)
  url.searchParams.delete(EDIT_INTENT_PARAM)
  return `${url.pathname}${url.search}${url.hash}`
}
