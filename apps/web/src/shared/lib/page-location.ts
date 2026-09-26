/**
 * 整页跳转（不是单页应用内的路由切换）：旧页面的内存（请求缓存、CSRF 令牌、组件状态）随页面一起丢弃。
 * 会话结束（退出、登录已过期）与换了人时用它，保证上一个会话的数据不留在内存里，也不会有还挂着的组件再发请求（审查 B7）。
 * 测试里换成记录调用的假实现（jsdom 不支持整页跳转）。
 */
export interface PageLocation {
  /** 整页打开 url，替换当前的历史记录（后退不会回到当前页） */
  replace: (url: string) => void
  /** 整页重新加载当前地址 */
  reload: () => void
}

export const browserPageLocation: PageLocation = {
  replace: url => window.location.replace(url),
  reload: () => window.location.reload(),
}
