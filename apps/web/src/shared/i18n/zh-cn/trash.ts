// 回收站页的文案（M2-P4）：只由按需加载的回收站页（features/trash）引用，不进平台页面的首屏（lint 的模块边界限定）
import type { TrashEntryKind } from '@nerve-office/contracts'
import { messages } from './messages.ts'

/** 回收站里一个删除单元的种类（M2-P4）：一份文档，或者一个文件夹连同它的整棵子树 */
const TRASH_ENTRY_KIND_NAMES: Record<TrashEntryKind, string> = { document: '文档', folder: '文件夹' }

export const trashMessages = {
  title: '回收站',
  heading: (space: string) => `${space} 的回收站`,
  backToSpace: '返回空间',
  retention: (days: number) => `删除的内容在回收站里保留 ${days} 天，到期后自动永久删除。`,
  /** 恢复的规则（access-rules.ts 的 trashPermissionsOf）：空间管理员，或者仍有编辑者及以上角色的删除者（审查建议 4） */
  readOnly: '能恢复的是空间管理员，以及删除它的人（要仍有编辑者及以上的角色）；永久删除只有空间管理员能做。',
  listLabel: '回收站列表',
  loading: '正在加载回收站…',
  loadFailed: '回收站加载失败',
  empty: '回收站里没有内容',
  columns: { name: '名称', deletedBy: '删除者与时间', origin: '原位置', expiresAt: '到期', actions: '操作' },
  kindName: (kind: TrashEntryKind) => TRASH_ENTRY_KIND_NAMES[kind],
  documentCount: (count: number) => `${count} 份文档`,
  unknownUser: '（账户已注销）',
  originRoot: '空间的根目录',
  originGone: '原位置已不存在',
  originIn: (folder: string) => `文件夹「${folder}」`,
  restore: '恢复',
  restoring: '正在恢复…',
  restored: (name: string) => `已恢复「${name}」`,
  restoredToRoot: (name: string) => `「${name}」原来的位置已经不在了，已恢复到空间的根目录`,
  purge: '永久删除',
  confirmPurge: (name: string) => `永久删除「${name}」？`,
  purgeDescription: '永久删除之后内容就找不回来了，里面的文档与它们的历史一并清除。',
  purged: (name: string) => `已永久删除「${name}」`,
  /** 别人已经动过它（恢复或永久删除）：列表刷新之后在上方说明，刷新好了没有按刷新的结果说（M2-P6 复核第五批 G3） */
  gone: (refreshed: boolean) => `这一条已经不在回收站里了（可能已被别人恢复或永久删除），${messages.common.listRefreshed(refreshed)}`,
  // 恢复的结果未知（M2-P6 复核 S1）：列表随即刷新，没能刷新时另说（第四批）
  restoreOutcomeUnknown: (name: string, reason: string, refreshed: boolean) => `没能确认「${name}」是否已经恢复（${reason}）。${messages.common.listRefreshed(refreshed)}：它已经不在回收站里，就是恢复好了。`,
  // 恢复被拒绝（403，例如空间刚被归档）：列表与页头按新的权限重新请求，原因写在说明里（M2-P6 复核 S2、S5）
  denied: (name: string, reason: string) => `没能恢复「${name}」：${reason}`,
} as const
