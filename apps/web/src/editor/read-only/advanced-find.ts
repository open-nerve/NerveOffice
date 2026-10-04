// 只读时查找面板上没有"替换 / 高级查找"的链接（DEF-028，M3-P2 S3）。
// 问题：find-replace 的查找面板（FindDialog）在查找框下面总放着这个链接，点了执行打开替换的操作（OpenReplaceDialogOperation）；
// 只读时这个操作被只读守卫取消（read-only-guard.ts 的 READ_ONLY_GUARDED_COMMANDS），链接点了没有反应，看起来像是坏了。
// 面板的组件没有开关能藏起它（views/dialog/FindReplaceDialog.tsx），所以按 SDK 的 DOM 标记写一条样式藏起它（internal-api 的
// FIND_ADVANCED_LINK_SELECTOR，已登记，由 E2E 回归：只读时看不到，能编辑时照常）。
// 面板经 SDK 的弹出层渲染在 body 下面（不在编辑器的容器里），所以样式写在文档的 head 里，与只读守卫同生共死：装上时加上，
// 销毁时去掉——模式切换一律重建（M3-P2 设计 §3.1），换成能编辑的编辑器时只读守卫随旧的编辑器销毁，链接随之回来。
// 页面的 CSP 允许内联样式（style-src 带 'unsafe-inline'，Univer 自己要用）
import { FIND_ADVANCED_LINK_SELECTOR } from '../internal-api/index.ts'

/** 这条样式在 head 里的标记：只读守卫加的，便于排查 */
export const ADVANCED_FIND_STYLE_MARKER = 'data-nerve-read-only'

/** 藏起查找面板里的"替换 / 高级查找"；返回去掉样式的函数，可以重复调用 */
export function hideAdvancedFind(target: Document = document): () => void {
  const style = target.createElement('style')
  style.setAttribute(ADVANCED_FIND_STYLE_MARKER, 'advanced-find')
  style.textContent = `${FIND_ADVANCED_LINK_SELECTOR} { display: none !important; }`
  target.head.append(style)
  return () => style.remove()
}
