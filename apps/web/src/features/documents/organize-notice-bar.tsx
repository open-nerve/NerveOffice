import type { OrganizeNotice } from './item-actions.tsx'
import { Notice } from '../../shared/ui/index.ts'
import { StillRefreshing } from '../../shared/ui/still-refreshing.tsx'

/**
 * 列表上方的说明条（空间页与"与我共享"共用，organize-panels.ts）：出现时接住焦点（shared/ui 的 Notice）。
 * 成功之后的刷新到了时限还在后台时，接着说列表还在刷新，刷新有了结果之后不再说（Codex 对抗评审 CX4）
 */
export function OrganizeNoticeBar({ notice, onClose }: { readonly notice: OrganizeNotice, readonly onClose: () => void }) {
  return (
    <Notice focusKey={notice} action={notice.action} onClose={onClose} variant={notice.problem === true ? 'destructive' : 'default'}>
      {notice.message}
      {/* 重放的说明（"上一次其实已经完成……"）已经是完整的句子：另起一句 */}
      <StillRefreshing refresh={notice.refreshing} sentence={notice.message.endsWith('。')} />
    </Notice>
  )
}
