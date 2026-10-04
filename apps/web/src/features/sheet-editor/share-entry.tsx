// 编辑器页页头里的"分享"（M2-P5 设计 §3.5）：只在能分享时（文档详情的 canShare）出现，归档的空间里没有。
//
// 编辑器页**静态**引用分享对话框（平台页面那边按需加载）：对话框用到平台页面首屏里的模块（请求缓存的钩子、写操作结果未知的共用做法、
// 焦点的辅助等），编辑器页要是也按需加载它，打包会为"平台页面首屏 + 分享对话框"另拆出一块，平台页面的首屏多一个文件
// （规范 §11 的文件数上限 2，门禁 budgets；M2-P6 第 5 片吃过同样的亏）。编辑器页静态引用之后，这些模块落进两个入口共用的那一块，
// 平台页面的首屏仍是两个文件；以后对话框多用了平台首屏里的什么，也不会再拆出新的块。代价是编辑器页的首屏多约 9 KiB
// （对话框本身：实测按需加载时 2011.3 KiB、静态引用 2020.4 KiB，约 0.5%）。组件级的按需加载与它失败时的说明只在平台页面
// 文档的行操作里（features/documents/share-entry.tsx）。
//
// 编辑器页没有平台页面的请求缓存：分享对话框用页头在最外层提供的那个（editor-query-client.ts）。
import type { EditorPage, EditorPageReady } from './editor-page.ts'
import { useRef, useState } from 'react'
import { messages } from '../../shared/i18n/index.ts'
import { Button } from '../../shared/ui/index.ts'
import { ShareDialog } from '../sharing/index.ts'

interface EditorShareEntryProps {
  readonly page: EditorPage
  readonly ready: EditorPageReady
  /** 关闭对话框之后入口已经不在了（随新的权限消失）时焦点交给谁：页头的返回链接 */
  readonly fallbackFocus: () => void
}

/**
 * 页头里的"分享"与对话框：能分享时才有按钮；对话框打开着的时候不随它关掉（里面正说明被拒绝的原因）。
 * 对话框里的写操作结果未知或被拒绝之后，页头重新取文档详情（能不能分享、标题、所在的空间）。请求缓存由 EditorChrome 提供
 */
export function EditorShareEntry({ page, ready, fallbackFocus }: EditorShareEntryProps) {
  const [open, setOpen] = useState(false)
  const entryRef = useRef<HTMLButtonElement>(null)
  return (
    <>
      {ready.canShare && <Button ref={entryRef} type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>{messages.organize.share}</Button>}
      <ShareDialog
        documentId={ready.documentId}
        documentTitle={ready.title}
        currentUserId={ready.userId}
        open={open}
        onOpenChange={setOpen}
        refreshDocument={() => void page.refreshDetail()}
        entry={entryRef}
        fallbackFocus={fallbackFocus}
      />
    </>
  )
}
