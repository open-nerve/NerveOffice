/**
 * 空间的页面地址（M2-P2 设计 §3.10，M2-P4 设计 §3.7）。放在 shared：导航、空间页、按需加载的成员页与回收站页、
 * 管理界面与编辑器页都要用它。
 * 本人的个人空间就是首页（"我的空间"）；任何空间（包括本人的个人空间）也都能用 /spaces/{id} 打开。
 */
export const HOME_PATH = '/'

/** 路由表里的空间页、成员页与回收站页（相对于外框） */
export const SPACE_ROUTE = 'spaces/:spaceId'
export const SPACE_MEMBERS_ROUTE = 'spaces/:spaceId/members'
export const SPACE_TRASH_ROUTE = 'spaces/:spaceId/trash'

/**
 * 空间里某个文件夹的页面：地址里带的是从空间根目录到它的整条 id 路径（M2-P4 设计 §3.7）。
 *
 * 为什么带整条路径，而不是只带当前文件夹的 id：服务端只有"列出一层"（GET /api/folders?parentId=…），
 * 没有"按 id 取一个文件夹"，所以光有当前文件夹的 id 拼不出面包屑，也回不了上一级。
 * 路径里有全部祖先之后，每一层的名称都能从"它父亲这一层的列表"里读出来，这些列表本来就是导航要用的（还能一起并发取、共用缓存），
 * 直接打开一个深层地址与一层层点进去看到的完全一样。
 */
export const SPACE_FOLDER_ROUTE = 'spaces/:spaceId/folders/*'

/** 搜索结果页（按需加载）：关键词在查询参数里，地址可以分享、可以刷新 */
export const SEARCH_PATH = '/search'
export const SEARCH_QUERY_PARAM = 'q'

export function spacePath(spaceId: string): string {
  return `/spaces/${spaceId}`
}

export function spaceMembersPath(spaceId: string): string {
  return `/spaces/${spaceId}/members`
}

export function spaceTrashPath(spaceId: string): string {
  return `/spaces/${spaceId}/trash`
}

/** 空间里某个位置的地址：folderIds 是从空间根目录到它的 id 路径，空数组就是空间的根目录 */
export function spaceFolderPath(spaceId: string, folderIds: readonly string[]): string {
  return folderIds.length === 0 ? spacePath(spaceId) : `/spaces/${spaceId}/folders/${folderIds.join('/')}`
}

/** 地址里的 id 路径（路由的 * 部分）拆成一个个 id；多余的斜杠忽略 */
export function folderIdsFromPath(splat: string | undefined): string[] {
  return (splat ?? '').split('/').filter(segment => segment !== '')
}

export function searchPath(keyword: string): string {
  return `${SEARCH_PATH}?${new URLSearchParams({ [SEARCH_QUERY_PARAM]: keyword }).toString()}`
}
