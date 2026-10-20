import { messages } from '../../shared/i18n/index.ts'
import { Skeleton } from '../../shared/ui/index.ts'

/** 公开页面的代码尚未下载时，不把等待说成正在检查登录。 */
export function LoadingPage() {
  return (
    <main className="mx-auto flex max-w-md flex-col gap-3 p-6">
      <div role="status" aria-label={messages.app.navigating}>
        <Skeleton className="h-24 w-full" />
      </div>
    </main>
  )
}
