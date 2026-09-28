import type { LinkInvalidReason, OneTimeLinkPurpose, SessionResponse } from '@nerve-office/contracts'
import type { SyntheticEvent } from 'react'
import { linkInvalidDetailsSchema, linkTokenFromHash, NEW_PASSWORD_MIN_LENGTH } from '@nerve-office/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { ApiError, describeError } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { LOGIN_PATH } from '../../shared/lib/login-path.ts'
import { Alert, AlertDescription, Button, buttonVariants, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Skeleton } from '../../shared/ui/index.ts'
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

/** 链接不能用：按原因说下一步；已接受的邀请、已用过的重置给出登录的入口 */
function LinkUnavailable({ purpose, reason }: { purpose: OneTimeLinkPurpose, reason: LinkInvalidReason }) {
  return (
    <div className="flex flex-col gap-4">
      <Alert variant="destructive">
        <AlertDescription>{messages.account.link.invalid(purpose, reason)}</AlertDescription>
      </Alert>
      <Link to={LOGIN_PATH} className={buttonVariants({ variant: 'outline' })}>{messages.account.goToLogin}</Link>
    </div>
  )
}

/**
 * 邀请注册与重置密码的公开页面（M2-P1 设计 §3.8，US-M2-01、03）。
 * 令牌在链接的 # 之后：读出之后立即从地址栏与当前的历史记录里去掉，再放进请求体。先查看链接（只显示登录名与显示名），
 * 再设置密码；成功后已登录，与登录一样通知其他标签页，进入个人空间。链接不能用时按原因说下一步。
 */
export function OneTimeLinkPage({ purpose }: { purpose: OneTimeLinkPurpose }) {
  const location = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  // 只在第一次渲染时读：去掉 # 之后的地址不再带令牌
  const [token] = useState(() => linkTokenFromHash(location.hash))
  useEffect(() => {
    if (location.hash !== '')
      void navigate({ pathname: location.pathname }, { replace: true })
  }, [location.hash, location.pathname, navigate])

  const inspection = useQuery({
    queryKey: ['links', purpose, token],
    queryFn: async ({ signal }) => inspectLink(purpose, token, signal),
    enabled: token !== '',
    staleTime: Infinity,
  })
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

  function submit(event: SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (mutation.isPending)
      return
    const found = newPasswordProblem(password, confirmation)
    setProblem(found)
    if (found === undefined)
      mutation.mutate()
  }

  const unavailable = token === '' ? 'invalid' : linkInvalidReason(inspection.error) ?? linkInvalidReason(mutation.error)
  let body
  if (unavailable !== undefined) {
    body = <LinkUnavailable purpose={purpose} reason={unavailable} />
  }
  else if (inspection.isPending) {
    body = (
      <div className="flex flex-col gap-3" role="status" aria-label={text.checking}>
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    )
  }
  else if (inspection.isError) {
    body = (
      <div className="flex flex-col gap-3">
        <Alert variant="destructive">
          <AlertDescription>{describeError(inspection.error).message}</AlertDescription>
        </Alert>
        <Button variant="outline" onClick={() => void inspection.refetch()}>{messages.common.retry}</Button>
      </div>
    )
  }
  else {
    const error = problem ?? (mutation.isError ? describeError(mutation.error).message : undefined)
    body = (
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
            <Input id={displayNameId} name="display-name" autoComplete="name" required value={displayName ?? inspection.data.displayName} onChange={event => setDisplayName(event.target.value)} />
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

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <h1 className="text-lg">{text.title}</h1>
          </CardTitle>
          <CardDescription>{text.description}</CardDescription>
        </CardHeader>
        <CardContent>{body}</CardContent>
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
