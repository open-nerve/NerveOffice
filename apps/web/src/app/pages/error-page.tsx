import { useRouteError } from 'react-router'
import { describeError } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { Button } from '../../shared/ui/index.ts'

/** 路由的错误边界：渲染出错时显示，可以重新加载；有请求标识时一并显示，便于排查。 */
export function ErrorPage() {
  const error = describeError(useRouteError())
  return (
    <main className="mx-auto flex max-w-md flex-col items-start gap-3 p-6" role="alert">
      <h1 className="text-xl font-semibold">{messages.errorPage.title}</h1>
      <p className="text-muted-foreground">{messages.errorPage.description}</p>
      {error.requestId !== undefined && <p className="text-xs text-muted-foreground">{messages.common.requestId(error.requestId)}</p>}
      <Button onClick={() => window.location.reload()}>{messages.errorPage.reload}</Button>
    </main>
  )
}
