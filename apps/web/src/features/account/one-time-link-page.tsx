import type { LinkInvalidReason, OneTimeLinkPurpose, SessionResponse } from '@nerve-office/contracts'
import type { RefObject, SyntheticEvent } from 'react'
import { displayNameSchema, linkInvalidDetailsSchema, linkTokenFromHash, NEW_PASSWORD_MIN_LENGTH } from '@nerve-office/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { ApiError, describeError } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { LOGIN_PATH } from '../../shared/lib/login-path.ts'
import { useDocumentTitle } from '../../shared/lib/use-document-title.ts'
import { useFirstLoadRetry } from '../../shared/lib/use-first-load-retry.ts'
import { Alert, AlertDescription, Button, buttonVariants, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, RetryButton, Skeleton } from '../../shared/ui/index.ts'
import { SESSION_QUERY_KEY, STARTS_SESSION } from '../auth/index.ts'
import { acceptInvitation, completePasswordReset, inspectLink } from './links-api.ts'
import { newPasswordProblem } from './new-password.ts'

/** 错误是"链接不能用"时给出原因（服务端的 details），否则 undefined */
function linkInvalidReason(error: unknown): LinkInvalidReason | undefined {
  if (!(error instanceof ApiError) || error.code !== 'LINK_INVALID')
    return undefined
  const details = linkInvalidDetailsSchema.safeParse(error.details)
  return details.success ? details.data.reason : 'invalid'
}

/** 链接不能用（已用过、过期、作废、无效）：按原因说下一步，重试也不会好 */
function notRetryable(error: unknown): boolean {
  return linkInvalidReason(error) === undefined
}

/**
 * 链接不能用：按原因说下一步（审查 B10）。只有已接受的邀请、已用过的重置才给出登录的入口：
 * 邀请过期或作废时受邀人还没有账户，重置链接不能用时也不知道密码，"去登录"都是死路
 */
function LinkUnavailable({ purpose, reason }: { purpose: OneTimeLinkPurpose, reason: LinkInvalidReason }) {
  return (
    <div className="flex flex-col gap-4">
      <Alert variant="destructive">
        <AlertDescription>{messages.account.link.invalid(purpose, reason)}</AlertDescription>
      </Alert>
      {reason === 'used' && <Link to={LOGIN_PATH} className={buttonVariants({ variant: 'outline' })}>{messages.account.goToLogin}</Link>}
    </div>
  )
}

/**
 * 链接里的令牌（# 之后）：读出之后立即从地址栏与当前的历史记录里去掉，页面自己记住它；地址里本来就没有时为 undefined。
 * 同一个标签页里只改 # 部分（例如粘贴管理员重新发来的链接）是片段导航，页面不重建：地址里又出现 # 时换上新的令牌（审查 B3）
 */
function useLinkToken(): string | undefined {
  const location = useLocation()
  const navigate = useNavigate()
  const fromAddress = location.hash === '' ? undefined : linkTokenFromHash(location.hash)
  const [token, setToken] = useState(fromAddress)
  if (fromAddress !== undefined && fromAddress !== token)
    setToken(fromAddress)
  useEffect(() => {
    if (location.hash !== '')
      void navigate({ pathname: location.pathname }, { replace: true })
  }, [location.hash, location.pathname, navigate])
  return token
}

/**
 * 一个令牌的查看与设置密码：换了令牌时整个重建（key），上一个令牌的查看结果、错误与填了一半的表单都不留下。
 * 先查看链接（只显示登录名与显示名），再设置密码；成功后已登录，与登录一样通知其他标签页，进入个人空间。
 * 查看失败（网络、服务不可用、尝试次数过多）之后按"重试"：重试期间说明与按钮留着（不可用、说正在重试）；有了结果之后（表单，或者链接不能用的说明）
 * 说明连同"重试"一起消失，焦点交给一直在的页面标题（titleRef），不落到 body（规范 §2.4，shared/lib/use-first-load-retry.ts）
 */
function LinkForm({ purpose, token, titleRef }: { purpose: OneTimeLinkPurpose, token: string, titleRef: RefObject<HTMLHeadingElement | null> }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const inspection = useQuery({
    queryKey: ['links', purpose, token],
    queryFn: async ({ signal }) => inspectLink(purpose, token, signal),
    staleTime: Infinity,
  })
  const firstLoad = useFirstLoadRetry(inspection, titleRef, { retryable: notRetryable })
  const [displayName, setDisplayName] = useState<string>()
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [problem, setProblem] = useState<string>()
  const displayNameId = useId()
  const passwordId = useId()
  const confirmId = useId()
  const ruleId = useId()
  const mutation = useMutation({
    mutationFn: async (): Promise<SessionResponse> => purpose === 'invitation'
      ? acceptInvitation({ token, displayName: displayName ?? inspection.data?.displayName ?? '', password })
      : completePasswordReset({ token, password }),
    // 已登录：由请求缓存的全局处理通知其他标签页（app/runtime.ts）
    meta: STARTS_SESSION,
    onSuccess: (session) => {
      queryClient.setQueryData(SESSION_QUERY_KEY, session)
      void navigate('/', { replace: true })
    },
  })
  const text = messages.account.link[purpose]

  const unavailable = linkInvalidReason(inspection.error) ?? linkInvalidReason(mutation.error)
  if (unavailable !== undefined)
    return <LinkUnavailable purpose={purpose} reason={unavailable} />
  if (firstLoad.failed) {
    // 重试期间上一次的原因不再给（请求缓存已经清掉了它）
    return (
      <div className="flex flex-col gap-3" onFocus={firstLoad.focus.onFocus} onBlur={firstLoad.focus.onBlur}>
        <Alert variant="destructive">
          <AlertDescription>
            <p>{text.checkFailed}</p>
            {!firstLoad.retrying && <p>{describeError(inspection.error).message}</p>}
          </AlertDescription>
        </Alert>
        <RetryButton size="default" retrying={firstLoad.retrying} onRetry={() => void inspection.refetch()} />
      </div>
    )
  }
  if (inspection.data === undefined) {
    return (
      <div className="flex flex-col gap-3" role="status" aria-label={text.checking}>
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    )
  }

  const shownName = displayName ?? inspection.data.displayName
  function submit(event: SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (mutation.isPending)
      return
    // 显示名与服务端同一套规则（去掉首尾空白之后 1–64 个字符）：清空时说清楚，而不是落到"请求的内容不合法"（审查 B10）
    const name = purpose === 'invitation' ? displayNameSchema.safeParse(shownName) : undefined
    const found = name?.success === false ? name.error.issues[0]?.message : newPasswordProblem(password, confirmation)
    setProblem(found)
    if (found === undefined)
      mutation.mutate()
  }

  const error = problem ?? (mutation.isError ? describeError(mutation.error).message : undefined)
  return (
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate aria-label={text.title}>
      {error !== undefined && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-col gap-1">
        <span className="text-sm text-muted-foreground">{messages.account.username}</span>
        <span className="font-medium">{inspection.data.username}</span>
      </div>
      {purpose === 'invitation' && (
        <div className="flex flex-col gap-2">
          <Label htmlFor={displayNameId}>{messages.account.displayName}</Label>
          <Input id={displayNameId} name="display-name" autoComplete="name" required value={shownName} onChange={event => setDisplayName(event.target.value)} />
        </div>
      )}
      {/* 密码管理器按登录名记住新密码 */}
      <input type="hidden" name="username" autoComplete="username" value={inspection.data.username} />
      <div className="flex flex-col gap-2">
        <Label htmlFor={passwordId}>{text.password}</Label>
        <Input id={passwordId} name="new-password" type="password" autoComplete="new-password" required aria-describedby={ruleId} value={password} onChange={event => setPassword(event.target.value)} />
        <p id={ruleId} className="text-sm text-muted-foreground">{messages.account.passwordRule(NEW_PASSWORD_MIN_LENGTH)}</p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={confirmId}>{messages.account.confirmPassword}</Label>
        <Input id={confirmId} name="confirm-password" type="password" autoComplete="new-password" required value={confirmation} onChange={event => setConfirmation(event.target.value)} />
      </div>
      {/* 进行中用 aria-disabled：按钮变成 disabled 时浏览器把焦点丢到 body（M1 审查 B13）；重复提交由 submit 挡住 */}
      <Button type="submit" aria-disabled={mutation.isPending || mutation.isSuccess} disabled={password === '' || confirmation === ''}>
        {mutation.isPending || mutation.isSuccess ? messages.account.link.submitting : text.submit}
      </Button>
    </form>
  )
}

/**
 * 邀请注册与重置密码的公开页面（M2-P1 设计 §3.8，US-M2-01、03）。
 * 令牌在链接的 # 之后：读出之后立即从地址栏与当前的历史记录里去掉，再放进请求体。地址里没有令牌（例如去掉之后刷新了页面）时，
 * 说明要重新打开发来的链接（审查 B10）。
 */
export function OneTimeLinkPage({ purpose }: { purpose: OneTimeLinkPurpose }) {
  const token = useLinkToken()
  const text = messages.account.link[purpose]
  /** 页面标题（tabIndex -1，只能由程序聚焦）：查看链接失败、按"重试"有了结果之后焦点交给它 */
  const titleRef = useRef<HTMLHeadingElement>(null)
  useDocumentTitle(text.title)
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <h1 ref={titleRef} tabIndex={-1} className="text-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50">{text.title}</h1>
          </CardTitle>
          <CardDescription>{text.description}</CardDescription>
        </CardHeader>
        <CardContent>
          {token === undefined || token === ''
            ? (
                <Alert variant="destructive">
                  <AlertDescription>{messages.account.link.missing(purpose)}</AlertDescription>
                </Alert>
              )
            : <LinkForm key={token} purpose={purpose} token={token} titleRef={titleRef} />}
        </CardContent>
      </Card>
    </main>
  )
}

export function InvitationPage() {
  return <OneTimeLinkPage purpose="invitation" />
}

export function PasswordResetPage() {
  return <OneTimeLinkPage purpose="password_reset" />
}
