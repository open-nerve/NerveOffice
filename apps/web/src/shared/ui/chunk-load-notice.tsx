// 组件级的按需加载没能下载下来时，入口旁边的说明（M2-P5 S3，shared/lib/use-lazy-chunk.ts）：现在用在平台页面文档的行操作里（分享对话框）。
import type { ChunkProblem } from '../lib/chunk-load.ts'
import { messages } from '../i18n/index.ts'
import { usePageLocation } from '../lib/page-location.ts'
import { Alert, AlertDescription } from './alert.tsx'
import { Button } from './button.tsx'

interface ChunkLoadNoticeProps {
  /** 没能加载的是什么，例如"分享"：拼进说明里 */
  readonly feature: string
  readonly problem: ChunkProblem
  readonly className?: string
}

/**
 * 说明为什么没能加载：连不上服务器、服务器上已部署了新版本、分块本身下载不下来（版本没变）三种分开说（与路由级的同一套判断）。
 * "重试"整页重新加载：浏览器记住了失败的模块，在这一页里再下载同一个地址也还是失败（WebKit 在同一个页面里整页重新加载之后也不再请求它，
 * 新开的页面才取得到：E2E 的 documents/sharing.spec.ts 实测）。role="alert"：出现时读屏读得到；焦点留在入口上，不抢走
 */
export function ChunkLoadNotice({ feature, problem, className }: ChunkLoadNoticeProps) {
  const page = usePageLocation()
  return (
    <Alert variant="destructive" className={className}>
      <AlertDescription className="flex flex-wrap items-center gap-2">
        <span>{messages.lazyFeature[problem](feature)}</span>
        <Button type="button" variant="outline" size="sm" onClick={() => page.reload()}>{messages.lazyFeature.retry}</Button>
      </AlertDescription>
    </Alert>
  )
}
