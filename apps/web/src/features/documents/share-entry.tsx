// 文档的行操作里的"分享"（M2-P5 设计 §3.5）：只在能分享时（文档详情的 canShare）出现，归档的空间里没有；
// 点了才下载分享对话框的代码（组件级的按需加载，shared/lib/use-lazy-chunk.ts）。没能下载下来时在这里说明（没能加载、已部署新版本、重试）。
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useRef, useState } from 'react'
import { messages } from '../../shared/i18n/index.ts'
import { refreshQueries } from '../../shared/lib/refresh-queries.ts'
import { connectionUnavailable, useConnectionState } from '../../shared/lib/use-connection-state.ts'
import { useLazyChunk } from '../../shared/lib/use-lazy-chunk.ts'
import { Button, ChunkLoadNotice } from '../../shared/ui/index.ts'
import { sessionQueryOptions } from '../auth/index.ts'
import { documentDetailsQueryKey } from './documents-api.ts'

/**
 * 分享对话框的代码：平台页面里只有这里引用它，而且只能动态 import()（lint 的模块边界；另一处引用是编辑器页的页头），
 * 静态引用会把 Radix Dialog、同事选择与确认的弹窗带进平台页面的首屏
 */
async function sharingFeature() {
  return import('../sharing/index.ts')
}

interface ShareEntryProps {
  readonly documentId: string
  readonly documentTitle: string
  /**
   * 能不能分享（服务端给的 canShare）：不能时不显示入口。对话框打开着的时候不随它关掉（里面正说明被拒绝的原因），
   * 关闭之后入口已经不在了，焦点交给 fallbackFocus
   */
  readonly canShare: boolean
  /**
   * 对话框里的写操作结果未知或被拒绝过：关闭对话框之后重新请求页头、导航与这个空间里的列表（与行操作被拒绝时同一个刷新：
   * 文档可能已经不在了、空间可能刚被归档）。对话框打开着的时候只刷新文档详情：列表一刷新，这一行（连同对话框）可能随之消失，
   * 对话框里正在说明的原因也就看不到了
   */
  readonly onDenied: () => void
  readonly fallbackFocus: () => void
}

export function ShareEntry({ documentId, documentTitle, canShare, onDenied, fallbackFocus }: ShareEntryProps) {
  const unavailable = connectionUnavailable(useConnectionState())
  const queryClient = useQueryClient()
  const session = useQuery(sessionQueryOptions())
  const entryRef = useRef<HTMLButtonElement>(null)
  const { chunk, load } = useLazyChunk(sharingFeature)
  const [open, setOpen] = useState(false)
  /** 对话框打开以来刷新过文档详情（写操作结果未知或被拒绝）：关闭之后整页的列表也要跟上 */
  const staleRef = useRef(false)
  // 对话框要的"刷新文档详情"：请求缓存里按 id 取的文档详情（这一行的权限，入口随之出现或消失），不计入、不等
  const refreshDocument = useCallback(() => {
    staleRef.current = true
    void refreshQueries(queryClient, [documentDetailsQueryKey()], { throwOnError: false })
  }, [queryClient])

  function changeOpen(next: boolean): void {
    setOpen(next)
    if (!next && staleRef.current) {
      staleRef.current = false
      onDenied()
    }
  }
  // 下载中，或者没能下载下来、还在判断原因：入口标为忙碌，状态写进一直在的容器（读屏读得到）
  const loading = chunk.state === 'loading' || (chunk.state === 'failed' && chunk.problem === undefined)
  const userId = session.data?.user.id

  async function openDialog(): Promise<void> {
    if (loading || connectionUnavailable() !== undefined)
      return
    if (await load() !== undefined && connectionUnavailable() === undefined)
      setOpen(true)
  }

  return (
    <>
      {canShare && (
        <>
          {/* 下载中用 aria-disabled：按钮变成 disabled 时焦点会丢（审查 B13）；重复点击由 openDialog 挡住 */}
          <Button ref={entryRef} type="button" variant="outline" size="sm" aria-disabled={loading || unavailable !== undefined} aria-busy={loading} onClick={() => void openDialog()}>
            {messages.organize.share}
          </Button>
          {unavailable !== undefined && <p className="text-sm text-muted-foreground">{unavailable}</p>}
          {/* 下载中的状态：随按钮一起出现、一直在的容器，下载时往里填文字，读屏读得到 */}
          <span role="status" className="sr-only">{loading ? messages.lazyFeature.loading(messages.organize.share) : ''}</span>
        </>
      )}
      {chunk.state === 'failed' && chunk.problem !== undefined && <ChunkLoadNotice feature={messages.organize.share} problem={chunk.problem} className="basis-full" />}
      {chunk.state === 'ready' && userId !== undefined && (
        <chunk.module.ShareDialog
          documentId={documentId}
          documentTitle={documentTitle}
          currentUserId={userId}
          open={open}
          onOpenChange={changeOpen}
          refreshDocument={refreshDocument}
          entry={entryRef}
          fallbackFocus={fallbackFocus}
        />
      )}
    </>
  )
}
