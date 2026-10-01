import type { RefObject } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useRouteError } from 'react-router'
import { describeError, NetworkError } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { usePageLocation } from '../../shared/lib/page-location.ts'
import { useDocumentTitle } from '../../shared/lib/use-document-title.ts'
import { Button, Skeleton } from '../../shared/ui/index.ts'
import { checkDeployment, ChunkLoadError, reloadOnceForDeployment } from '../chunk-load.ts'

/** 出错的页面出现时，焦点在 body（出错的内容连同有焦点的元素一起换掉了）：交给标题，不抢别处的焦点（M2-P6 复核 S6） */
function useFocusWhenLost(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (document.activeElement === null || document.activeElement === document.body)
      ref.current?.focus()
  }, [ref])
}

/**
 * 出错时的说明：断网另说（M2-P6 复核 S6）；有请求标识时一并显示，便于排查，没有时不提"把下面的请求标识告诉管理员"。
 * 页面的整体出错（ErrorPage）与内容区的出错（RouteErrorBoundary）共用
 */
function ErrorContent({ error }: { readonly error: unknown }) {
  const described = describeError(error)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const page = usePageLocation()
  useDocumentTitle(messages.errorPage.title)
  useFocusWhenLost(titleRef)
  let description: string = messages.errorPage.description
  if (error instanceof NetworkError)
    description = described.message
  else if (described.requestId !== undefined)
    description = messages.errorPage.descriptionWithRequestId
  return (
    <>
      {/* role="alert" 放在内层：放在 main 上会把 main 地标的角色覆盖掉（审查 B15） */}
      <div role="alert" className="flex flex-col items-start gap-3">
        <h1 ref={titleRef} tabIndex={-1} className="text-xl font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring/50">{messages.errorPage.title}</h1>
        <p className="text-muted-foreground">{description}</p>
        {described.requestId !== undefined && <p className="text-xs text-muted-foreground">{messages.common.requestId(described.requestId)}</p>}
      </div>
      <Button onClick={() => page.reload()}>{messages.errorPage.reload}</Button>
    </>
  )
}

/** 路由的错误边界：渲染出错时显示，可以重新加载；有请求标识时一并显示，便于排查。 */
export function ErrorPage() {
  const error = useRouteError()
  return (
    <main className="mx-auto flex max-w-md flex-col items-start gap-3 p-6">
      <ErrorContent error={error} />
    </main>
  )
}

/**
 * 按需加载的页面的代码没能下载下来（M2-P6 复核 S6）：先向服务端要一次入口页——部署了新版本（旧的分块已经不在了），
 * 整页重新加载一次换上新版本（同一个版本只重新加载一次，防止循环）；否则说明"请检查网络后重试"，"重试"整页重新加载
 * （浏览器记住了失败的模块，在这一页里再 import 同一个地址也还是失败）。确认期间显示等待的骨架屏
 */
function ChunkLoadFailure() {
  const page = usePageLocation()
  const [checking, setChecking] = useState(true)
  const titleRef = useRef<HTMLHeadingElement>(null)
  useDocumentTitle(checking ? undefined : messages.routeLoadFailed.title)
  useEffect(() => {
    let cancelled = false
    void checkDeployment().then((check) => {
      if (cancelled || (check.kind === 'deployed' && reloadOnceForDeployment(check.version, page.reload)))
        return
      setChecking(false)
    })
    return () => {
      cancelled = true
    }
  }, [page])
  useEffect(() => {
    if (!checking && (document.activeElement === null || document.activeElement === document.body))
      titleRef.current?.focus()
  }, [checking])
  if (checking) {
    return (
      <div role="status" aria-label={messages.app.navigating}>
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }
  return (
    <section className="flex max-w-md flex-col items-start gap-3" aria-labelledby="route-load-failed-title">
      <div role="alert" className="flex flex-col items-start gap-3">
        <h1 ref={titleRef} id="route-load-failed-title" tabIndex={-1} className="text-xl font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring/50">{messages.routeLoadFailed.title}</h1>
        <p className="text-muted-foreground">{messages.routeLoadFailed.description}</p>
      </div>
      <Button onClick={() => page.reload()}>{messages.routeLoadFailed.retry}</Button>
    </section>
  )
}

/**
 * 登录后页框里的内容区的错误边界（M2-P6 复核 S6）：页头与导航留着，只换掉内容区。按需加载的页面的代码没能下载下来时
 * 单独处理（ChunkLoadFailure）；别的出错显示通用的说明。页框本身外面还有 ErrorPage
 */
export function RouteErrorBoundary() {
  const error = useRouteError()
  if (error instanceof ChunkLoadError)
    return <ChunkLoadFailure />
  return (
    <section className="flex max-w-md flex-col items-start gap-3">
      <ErrorContent error={error} />
    </section>
  )
}
