// 编辑时页头的保存状态（M3-P4 设计 §3.9）：保存的状态机的视图连同自动保存这一侧的状态（联网、会话、会不会自动重试），给出状态的全集。
// 纯函数；怎么说、失败的说明怎么留由页头决定（editor-chrome.tsx）。读屏只播有意义的变化：announcementKey 给出哪些状态的变化要播。
import type { AutosaveView } from './autosave.ts'
import type { SaveView } from './save-coordinator.ts'

/**
 * 编辑时的保存状态（设计 §3.9）：
 * - saved：已保存到云端——服务端确认到现在的修改序号、没有"公式待更新"、单元格里没有没提交的输入；
 * - unsaved：有未保存的修改（含单元格里没提交的输入）；
 * - saving：保存中（有上传在途或排着）；
 * - formulas-pending：修改都已存上，只差公式的结果（算完之后自动保存）；
 * - retrying：保存失败，稍后自动重试（原因在 SaveView.problem）；
 * - failed：保存失败，要等新的内容或用户的操作（快照不合格、超过上限、意外的错误连着出现、自动保存没接上时的任何失败）；
 * - offline：已离线——修改还在本页（没有存到本机），恢复网络之后自动保存；
 * - paused：暂停——登录回来之后自动保存；
 * - conflict、outdated、too-new：终态（版本冲突、需要刷新、不能保存），照旧
 */
export type SaveIndicator = 'saved' | 'unsaved' | 'saving' | 'formulas-pending' | 'retrying' | 'failed' | 'offline' | 'paused' | 'conflict' | 'outdated' | 'too-new'

/**
 * 先后：终态 > 保存中 > 再试也一样的失败（说原因，不能说"恢复之后自动保存"）> 离线 > 暂停（这两样只在有没存上的内容、或者失败了时说）>
 * 自动重试中 > 有未保存的修改 > 只差公式 > 已保存。autosave 为 undefined（自动保存没接上）时失败一律按 failed
 */
export function saveIndicator(save: SaveView, autosave: AutosaveView | undefined): SaveIndicator {
  switch (save.status) {
    case 'conflict':
    case 'outdated':
    case 'too-new':
      return save.status
    case 'saving':
      return 'saving'
    case 'failed':
    case 'dirty':
    case 'clean':
      break
  }
  const failed = save.status === 'failed'
  if (failed && autosave?.retrying !== true)
    return 'failed'
  if (save.unsaved || failed) {
    if (autosave?.offline === true)
      return 'offline'
    if (autosave?.paused === true)
      return 'paused'
  }
  if (failed)
    return 'retrying'
  if (save.unsavedEdits)
    return 'unsaved'
  return save.formulasPending ? 'formulas-pending' : 'saved'
}

/**
 * 读屏的播报（设计 §3.9）：这个保存状态要不要播。有意义的——失败（自动重试中、再试也一样）、离线、暂停、终态、"公式结果尚未保存"，
 * 以及"已保存到云端"（从它们恢复、公式的补存之后）——给出一个键，键变了才播；例行的"有未保存的修改""保存中…"给 undefined，不改播报区：
 * 往返"有未保存的修改 → 保存中… → 已保存到云端"回到的还是同一个键，不再播；失败之后自动重试（保存中）也不播，重试成功回到"已保存到云端"才播
 */
export function announcementKey(indicator: SaveIndicator): string | undefined {
  return indicator === 'unsaved' || indicator === 'saving' ? undefined : indicator
}

/** 播报区里的话留多久（毫秒）：之后清空，不留着过时的话（读屏的浏览模式读得到它），下一次同样的话照样播报 */
export const ANNOUNCEMENT_MS = 7_000
