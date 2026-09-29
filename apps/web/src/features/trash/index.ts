// 回收站页（M2-P4 设计 §3.7）：按需加载，不进平台页面的首屏包（它带着确认的弹窗）。
// app/routes.ts 只用动态 import 引用这里（lint 的模块边界拦下静态引用）。
export { TrashPage } from './trash-page.tsx'
