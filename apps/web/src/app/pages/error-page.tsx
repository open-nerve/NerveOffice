import { useRouteError } from 'react-router'
import { describeError } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { Button } from '../../shared/ui/index.ts'

/** 路由的错误边界：渲染出错时显示，可以重新加载；有请求标识时一并显示，便于排查。 */
export function ErrorPage() {
  const error = describeError(useRouteError())
  return (
    // role="alert" 放在内层：放在 main 上会把 main 地标的角色覆盖掉（审查 B15）
    <main className="mx-auto flex max-w-md flex-col items-start gap-3 p-6">
      <div role="alert" className="flex flex-col items-start gap-3">
        <h1 className="text-xl font-semibold">{messages.errorPage.title}</h1>
        <p className="text-muted-foreground">{messages.errorPage.description}</p>
        {error.requestId !== undefined && <p className="text-xs text-muted-foreground">{messages.common.requestId(error.requestId)}</p>}
      </div>
      <Button onClick={() => window.location.reload()}>{messages.errorPage.reload}</Button>
    </main>
  )
}
