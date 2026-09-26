// 平台资源地址（计划书 §8.5、§11.3）：同源的相对地址 /api/assets/<uuid>，或者本站的绝对地址。
// 带查询参数、片段、多余的路径段、大写或其他写法的一律不算；本期没有资源服务，实际上没有这样的地址（M5）
const PLATFORM_ASSET_PATH = /^\/api\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * `origin` 是页面（或 Worker）自己的源，例如 `https://docs.example.com`。
 * Worker 与页面同源（Worker 以同源脚本加载），两处的判断相同
 */
export function isPlatformAssetAddress(value: string, origin: string): boolean {
  if (PLATFORM_ASSET_PATH.test(value))
    return true
  // 不透明源（'null'）没有本站的绝对地址
  if (origin === '' || origin === 'null' || !value.startsWith(`${origin}/`))
    return false
  return PLATFORM_ASSET_PATH.test(value.slice(origin.length))
}
