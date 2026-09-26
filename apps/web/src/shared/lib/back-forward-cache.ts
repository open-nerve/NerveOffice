/**
 * 从往返缓存（bfcache）恢复的页面带着离开时的内存：请求缓存里的数据、会话与 CSRF 令牌、组件的状态。
 * 恢复时整页重新加载，由服务端重新确认会话（US-M1-02：退出后按后退键看不到内容）。每个入口在挂载之前调用。
 *
 * E2E 走不到这条路径：Playwright 启动 Chromium 时关掉了往返缓存，三个浏览器在测试里后退时都是重新加载（persisted 为 false），
 * 所以由单元测试覆盖（审查 B16）。
 */
export function reloadWhenRestoredFromCache(page: Pick<Window, 'addEventListener'>, reload: () => void): void {
  page.addEventListener('pageshow', (event) => {
    if (event.persisted)
      reload()
  })
}
