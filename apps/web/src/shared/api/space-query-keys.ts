/** 首屏的空间查询与按需成员接口共用前缀，不互相引入请求实现。 */
export const SPACES_QUERY_KEY = ['spaces'] as const

/** 只供缓存定位；空间列表清理缓存时不必装入按需成员页的请求代码。 */
export function spaceMembersQueryKey(spaceId: string) {
  return [...SPACES_QUERY_KEY, 'members', spaceId] as const
}
