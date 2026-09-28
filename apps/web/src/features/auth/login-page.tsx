import type { SyntheticEvent } from 'react'
import { documentIdFromPagePath } from '@nerve-office/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router'
import { describeError } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { redirectTarget } from '../../shared/lib/login-path.ts'
import { usePageLocation } from '../../shared/lib/page-location.ts'
import { Alert, AlertDescription, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from '../../shared/ui/index.ts'
import { SessionCheck } from './session-check.tsx'
import { login, SESSION_QUERY_KEY, sessionQueryOptions, STARTS_SESSION } from './session.ts'

/** 登录后要去的是编辑器页：它是另一个入口，要整页打开，不能在平台页面的路由里切换（P4 设计 §3.8）。 */
function opensEditorPage(target: string): boolean {
  return documentIdFromPagePath(new URL(target, window.location.origin).pathname) !== undefined
}

/** 整页打开另一个入口的页面，只打开一次（开发模式的 StrictMode 会把副作用执行两遍）；打开之前显示骨架屏。 */
function OpenPage({ url }: { url: string }) {
  const page = usePageLocation()
  const openedRef = useRef(false)
  useEffect(() => {
    if (!openedRef.current) {
      openedRef.current = true
      page.replace(url)
    }
  }, [page, url])
  return <SessionCheck />
}

/** 登录页（US-M1-02）：已登录时直接回去；错误分别提示；提交中不能重复提交。 */
export function LoginPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const session = useQuery(sessionQueryOptions())
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const usernameId = useId()
  const passwordId = useId()
  const target = redirectTarget(params.get('from'))
  const toEditor = opensEditorPage(target)
  const mutation = useMutation({
    mutationFn: login,
    // 登录成功由请求缓存的全局处理通知其他标签页（app/runtime.ts）
    meta: STARTS_SESSION,
    onSuccess: (data) => {
      queryClient.setQueryData(SESSION_QUERY_KEY, data)
      // 编辑器页由下面的 OpenPage 整页打开
      if (!toEditor)
        void navigate(target, { replace: true })
    },
  })

  // 只认没有失败的会话查询：重新请求得到未登录时，缓存里仍留着上一次的会话（TanStack Query 失败时保留旧数据），
  // 按它跳回去的话，需要登录的外层路由又按失败转回来，两边来回跳转（M2-P1 审查时发现，会话复核时容易触发）
  if (session.data !== undefined && !session.isError && !mutation.isPending)
    return toEditor ? <OpenPage url={target} /> : <Navigate to={target} replace />
  // 还在确认是否已经登录：先不显示表单，免得已登录的人看到它闪一下（审查 B14）
  if (session.isPending)
    return <SessionCheck />

  function submit(event: SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (!mutation.isPending)
      mutation.mutate({ username, password })
  }

  const error = mutation.isError ? describeError(mutation.error) : undefined
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <h1 className="text-lg">{messages.app.name}</h1>
          </CardTitle>
          <CardDescription>{messages.auth.loginDescription}</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={submit} noValidate aria-label={messages.auth.loginTitle}>
            {params.get('reason') === 'expired' && error === undefined && (
              <Alert>
                <AlertDescription>{messages.auth.sessionExpired}</AlertDescription>
              </Alert>
            )}
            {error !== undefined && (
              <Alert variant="destructive">
                <AlertDescription>{error.message}</AlertDescription>
              </Alert>
            )}
            <div className="flex flex-col gap-2">
              <Label htmlFor={usernameId}>{messages.auth.username}</Label>
              <Input id={usernameId} name="username" autoComplete="username" required value={username} onChange={event => setUsername(event.target.value)} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={passwordId}>{messages.auth.password}</Label>
              <Input id={passwordId} name="password" type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} />
            </div>
            {/* 提交中用 aria-disabled 而不是 disabled：按钮变成 disabled 时浏览器把焦点丢到 body，键盘用户失败后找不到位置（审查 B13）；重复提交由 submit 挡住 */}
            <Button type="submit" aria-disabled={mutation.isPending} disabled={username.trim() === '' || password === ''}>
              {mutation.isPending ? messages.auth.submitting : messages.auth.submit}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}
