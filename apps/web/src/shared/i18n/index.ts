// 平台页面首屏用到的文案（zh-cn/messages.ts）。只给按需加载的页面与编辑器页用的文案按功能各放一个文件（zh-cn/<功能>.ts），
// 由对应的功能按路径直接引用，不经这里转出：经这里转出就会把它们带回首屏（lint 的模块边界限定谁能引用，M2-P6 复核第二批）
export { messages, phraseText } from './zh-cn/messages.ts'
export type { Phrase } from './zh-cn/messages.ts'
