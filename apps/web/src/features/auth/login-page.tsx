import type { SyntheticEvent } from 'react'
import { documentIdFromPagePath } from '@nerve-office/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router'
import { describeError } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { redirectTarget } from '../../shared/lib/login-path.ts'
import { usePageLocation } from '../../shared/lib/page-location.ts'
import { useDocumentTitle } from '../../shared/lib/use-document-title.ts'
import { focusIsLost } from '../../shared/lib/use-focus-hand-off.ts'
import { Alert, AlertDescription, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from '../../shared/ui/index.ts'
import { SessionCheck } from './session-check.tsx'
import { login, SESSION_QUERY_KEY, sessionQueryOptions, STARTS_SESSION } from './session.ts'

/** 为什么来到登录页时的说明（shared/lib/login-path.ts 的 LoginReason；required 不说明） */
const LOGIN_NOTICES: ReadonlyMap<string, string> = new Map([
  ['expired', messages.auth.sessionExpired],
  ['password_changed', messages.auth.passwordMaybeChanged],
  ['password_reset', messages.auth.passwordMaybeReset],
  ['account_disabled', messages.auth.accountMaybeDisabled],
])

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

/**
 * 登录页（US-M1-02）：已登录时直接回去；错误分别提示；提交中不能重复提交。
 *
 * 表单出现时的初始焦点（DEF-047）：直接打开登录页，或者会话确认之后转到这里（按过的"重试"随之卸载）时，焦点不留在 body。
 * 带着为什么来到这里的说明（登录已过期、新密码可能已经生效、账户可能已经被停用……）时先给说明：它与表单一起出现，
 * 状态区不播报一出现就有的内容（规范 §2.4），读屏要等焦点到了才读得到，而它说的正是这一次该怎么登录（用旧密码试几次就会被限流）；
 * 按一次 Tab 就到用户名。没有说明时直接给用户名：这一页只有登录这一件事。焦点已经在别处时不抢（与 SpaceNotFound 同一个做法）。
 *
 * 登录失败时说明留着，错误的说明另起一条、排在它下面（DEF-048）：说明讲的正是这一次该怎么登录（新密码可能已经生效、要找另一位系统管理员……），
 * 失败之后最用得着。错误的说明是 role="alert"，出现时读屏立即播报（与没有说明时相同）；焦点不动，留在原来的地方——键盘提交时在输入框或
 * 登录按钮上（审查 B13），还在说明上时就在说明上（按一次 Tab 到用户名）
 */
export function LoginPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const session = useQuery(sessionQueryOptions())
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const usernameId = useId()
  const passwordId = useId()
  const noticeRef = useRef<HTMLDivElement>(null)
  const usernameRef = useRef<HTMLInputElement>(null)
  const target = redirectTarget(params.get('from'))
  const toEditor = opensEditorPage(target)
  useDocumentTitle(messages.auth.loginTitle)
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
  const signedIn = session.data !== undefined && !session.isError && !mutation.isPending
  // 还在确认是否已经登录：先不显示表单，免得已登录的人看到它闪一下（审查 B14）
  const formShown = !signedIn && !session.isPending
  const error = mutation.isError ? describeError(mutation.error) : undefined
  // 为什么来到登录页（shared/lib/login-path.ts）：登录已过期；或者修改密码的结果未知、随后登录失效了（M2-P6 复核 G-1）；
  // 或者为自己生成重置链接的结果未知、随后登录失效了（M2-P6 复核 S1）；或者停用自己的结果未知、随后登录失效了（第五批 G1）
  const notice = LOGIN_NOTICES.get(params.get('reason') ?? '')
  // 表单出现时（会话确认之后、换回表单时）给初始焦点：有说明给说明，没有给用户名（见上）
  useEffect(() => {
    if (formShown && focusIsLost())
      (noticeRef.current ?? usernameRef.current)?.focus()
  }, [formShown])

  if (signedIn)
    return toEditor ? <OpenPage url={target} /> : <Navigate to={target} replace />
  if (session.isPending)
    return <SessionCheck />

  function submit(event: SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (!mutation.isPending)
      mutation.mutate({ username, password })
  }

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
            {notice !== undefined && (
              // tabIndex -1：只能由程序聚焦（表单出现时），Tab 键不经过它
              <Alert ref={noticeRef} tabIndex={-1} className="outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                <AlertDescription>{notice}</AlertDescription>
              </Alert>
            )}
            {/* 排在说明下面：说明先出现、焦点可能就在它上面，失败时不把它挤开 */}
            {error !== undefined && (
              <Alert variant="destructive">
                <AlertDescription>{error.message}</AlertDescription>
              </Alert>
            )}
            <div className="flex flex-col gap-2">
              <Label htmlFor={usernameId}>{messages.auth.username}</Label>
              <Input ref={usernameRef} id={usernameId} name="username" autoComplete="username" required value={username} onChange={event => setUsername(event.target.value)} />
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
