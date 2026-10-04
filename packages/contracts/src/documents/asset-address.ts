// 平台的图片地址（00 号计划书 §8.5、§11.2、§11.3）：同源的相对地址 /api/assets/<uuid>，或者本站的绝对写法。
// 页面与公式 Worker 里 IMAGE() 的限制（web 的 editor/image-function）与服务端快照检查的图片规则（任何深度上名为 source 的字段，
// M3-P3 设计 §3.3）共用这一个判定。带查询参数、片段、多余的路径段、大写或其他写法的一律不算；M5 之前没有图片服务，实际上没有这样的地址
const PLATFORM_ASSET_PATH = /^\/api\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * value 是不是平台的图片地址。`origin` 是本站的源，例如 `https://docs.example.com`：页面与 Worker 传自己的源（Worker 以同源脚本加载，
 * 两处的判断相同），本站的绝对写法随之算数；传空串或不透明源（'null'）时只认相对地址
 */
export function isPlatformAssetAddress(value: string, origin: string): boolean {
  if (PLATFORM_ASSET_PATH.test(value))
    return true
  if (origin === '' || origin === 'null' || !value.startsWith(`${origin}/`))
    return false
  return PLATFORM_ASSET_PATH.test(value.slice(origin.length))
}
