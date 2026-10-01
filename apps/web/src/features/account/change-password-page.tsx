import type { SyntheticEvent } from 'react'
import { NEW_PASSWORD_MIN_LENGTH } from '@nerve-office/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useRef, useState } from 'react'
import { ApiError, describeError, isUnknownOutcome } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { useSessionRecheck } from '../../shared/lib/session-recheck.ts'
import { useDocumentTitle } from '../../shared/lib/use-document-title.ts'
import { useFocusAfterRender } from '../../shared/lib/use-focus-after-render.ts'
import { Alert, AlertDescription, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from '../../shared/ui/index.ts'
import { RENEWS_SESSION, RENEWS_SESSION_AFTER_UNKNOWN, SESSION_QUERY_KEY } from '../auth/index.ts'
import { changePassword } from './account-api.ts'
import { newPasswordProblem } from './new-password.ts'

/**
 * 提交失败时的说明（M2-P6 复核 G-1）：结果未知（网络中断、服务端出错）时说明新密码可能已经生效；
 * 结果未知之后再提交得到"当前密码不正确"，多半是上一次已经改好了，照实说；其余按错误码。
 */
function failureText(error: unknown, unsure: boolean): string {
  if (isUnknownOutcome(error))
    return messages.account.outcomeUnknown(describeError(error).message)
  if (unsure && error instanceof ApiError && error.code === 'CURRENT_PASSWORD_INCORRECT')
    return messages.account.maybeChangedAlready
  return describeError(error).message
}

/**
 * 修改密码（US-M2-02）：当前密码、新密码输入两次。成功后清空表单并提示其他设备上的登录已经退出；
 * 失败按错误码说明（当前密码不对、尝试次数过多、服务繁忙）。提交中不能重复提交。
 * 清空之后提交按钮变成 disabled，焦点不能留在它身上：移到成功的提示，读屏软件随即读出（审查 B9）。
 *
 * 成功时服务端撤销了本人的全部会话（包括当前这个），为当前页面新建了一个（M2-P6 复核 B1）：请求层已换上新的 CSRF 令牌，
 * 这里把新的会话放进请求缓存；其他标签页由请求缓存的全局处理通知（RENEWS_SESSION）。
 * 结果未知时记下来（unsure）：再提交得到"当前密码不正确"或"登录已过期"时，提示新密码可能已经生效（M2-P6 复核 G-1）。
 * 结果未知的那一刻就带着 password_changed 的原因确认一次会话（第五批 G2，与为自己生成重置链接的 R-1 一样）：已经改好的话，
 * 当前会话随之撤销（新会话的 Cookie 随丢掉的回包一起丢了），这时就回到登录页、说明新密码可能已经生效，不等再提交；
 * 原来要等到别处的请求得到"登录已过期"，一换页就只说"登录已过期"。会话还在就留在页面上，说明照旧。
 * 确认不在 onError 里等：修改密码这时还没结束，确认要先等它结束（运行时的 sessionChangesSettled），等就成了互相等到上限
 */
export function ChangePasswordPage() {
  useDocumentTitle(messages.account.changePassword)
  const queryClient = useQueryClient()
  const recheckSession = useSessionRecheck()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [problem, setProblem] = useState<string>()
  /** 上一次提交的结果未知：请求可能已经生效。成功之后清掉 */
  const [unsure, setUnsure] = useState(false)
  const currentId = useId()
  const newId = useId()
  const confirmId = useId()
  const ruleId = useId()
  const changedRef = useRef<HTMLDivElement>(null)
  const focusAfterRender = useFocusAfterRender()
  const mutation = useMutation({
    mutationFn: changePassword,
    // 元数据随 unsure 切换：useMutation 每次渲染之后更新选项，下一次提交按新的元数据处理。
    // 结果未知之后再提交得到"登录已过期"，全局处理带着 password_changed 回到登录页，登录页提示新密码可能已经生效
    meta: unsure ? RENEWS_SESSION_AFTER_UNKNOWN : RENEWS_SESSION,
    onSuccess: (session) => {
      queryClient.setQueryData(SESSION_QUERY_KEY, session)
      setUnsure(false)
    },
    onError: (error) => {
      if (!isUnknownOutcome(error))
        return
      setUnsure(true)
      void recheckSession('password_changed')
    },
  })

  function submit(event: SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (mutation.isPending)
      return
    const found = newPasswordProblem(newPassword, confirmation)
    setProblem(found)
    if (found === undefined) {
      // 调用时的 onSuccess 在变更的状态已经是"成功"之后执行：随后的这次渲染里已经有成功的提示，可以聚焦
      mutation.mutate({ currentPassword, newPassword }, {
        onSuccess: () => {
          setCurrentPassword('')
          setNewPassword('')
          setConfirmation('')
          focusAfterRender(changedRef)
        },
      })
    }
  }

  const error = problem ?? (mutation.isError ? failureText(mutation.error, unsure) : undefined)
  return (
    <Card className="mx-auto w-full max-w-md">
      <CardHeader>
        <CardTitle>
          <h1 className="text-lg">{messages.account.changePassword}</h1>
        </CardTitle>
        <CardDescription>{messages.account.changePasswordDescription}</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={submit} noValidate aria-label={messages.account.changePassword}>
          {error !== undefined && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {mutation.isSuccess && error === undefined && (
            // tabIndex -1：只能由程序聚焦（成功之后），Tab 键不经过它
            <Alert ref={changedRef} tabIndex={-1} className="outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
              <AlertDescription>{messages.account.changed}</AlertDescription>
            </Alert>
          )}
          <div className="flex flex-col gap-2">
            <Label htmlFor={currentId}>{messages.account.currentPassword}</Label>
            <Input id={currentId} name="current-password" type="password" autoComplete="current-password" required value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={newId}>{messages.account.newPassword}</Label>
            <Input id={newId} name="new-password" type="password" autoComplete="new-password" required aria-describedby={ruleId} value={newPassword} onChange={event => setNewPassword(event.target.value)} />
            <p id={ruleId} className="text-sm text-muted-foreground">{messages.account.passwordRule(NEW_PASSWORD_MIN_LENGTH)}</p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={confirmId}>{messages.account.confirmPassword}</Label>
            <Input id={confirmId} name="confirm-password" type="password" autoComplete="new-password" required value={confirmation} onChange={event => setConfirmation(event.target.value)} />
          </div>
          {/* 进行中用 aria-disabled：按钮变成 disabled 时浏览器把焦点丢到 body（M1 审查 B13）；重复提交由 submit 挡住 */}
          <Button type="submit" aria-disabled={mutation.isPending} disabled={currentPassword === '' || newPassword === '' || confirmation === ''}>
            {mutation.isPending ? messages.account.changing : messages.account.changePassword}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
