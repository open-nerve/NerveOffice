import { messages } from '../../shared/i18n/index.ts'
import { Skeleton } from '../../shared/ui/index.ts'

/** 还在向服务端确认登录状态时的骨架屏：需要登录的页面与登录页都先等它，免得先闪出不该看到的内容（审查 B14）。 */
export function SessionCheck() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-3 p-6" role="status" aria-label={messages.auth.checkingSession}>
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-24 w-full" />
    </div>
  )
}
