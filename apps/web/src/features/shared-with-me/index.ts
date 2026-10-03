// "与我共享"页（M2-P5 设计 §3.5）：按需加载，不进平台页面的首屏（左侧导航里只有入口）。
// app/routes.ts 只用动态 import 引用这里（lint 的模块边界拦下静态引用）。
export { SharedWithMePage } from './shared-page.tsx'
