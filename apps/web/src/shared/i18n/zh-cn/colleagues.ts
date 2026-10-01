// 按关键词选一项（按名字选同事、选团队空间）的文案：只由 features/colleagues 引用，它只给按需加载的管理界面与成员页用（lint 的模块边界限定）
import type { Phrase } from './messages.ts'

export const colleaguesMessages = {
  search: '按名字或登录名搜索同事',
  searching: '正在查找…',
  none: '没有找到这个人',
  failed: (reason: string) => `查找失败：${reason}`,
  candidates: '找到的同事',
  selected: <T>(name: T): Phrase<T> => ['已选择：', name],
  change: '重新选择',
  /** "重新选择"的可读名称带上选的是什么，例如"重新选择 首个空间管理员"（审查 B10） */
  changeOf: (label: string) => `重新选择 ${label}`,
} as const
