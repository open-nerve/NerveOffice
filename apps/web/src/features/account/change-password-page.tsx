import type { SyntheticEvent } from 'react'
import { NEW_PASSWORD_MIN_LENGTH } from '@nerve-office/contracts'
import { useMutation } from '@tanstack/react-query'
import { useId, useRef, useState } from 'react'
import { describeError } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { useFocusAfterRender } from '../../shared/lib/use-focus-after-render.ts'
import { Alert, AlertDescription, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from '../../shared/ui/index.ts'
import { changePassword } from './account-api.ts'
import { newPasswordProblem } from './new-password.ts'

/**
 * 修改密码（US-M2-02）：当前密码、新密码输入两次。成功后清空表单并提示其他设备上的登录已经退出；
 * 失败按错误码说明（当前密码不对、尝试次数过多、服务繁忙）。提交中不能重复提交。
 * 清空之后提交按钮变成 disabled，焦点不能留在它身上：移到成功的提示，读屏软件随即读出（审查 B9）。
 */
export function ChangePasswordPage() {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [problem, setProblem] = useState<string>()
  const currentId = useId()
  const newId = useId()
  const confirmId = useId()
  const ruleId = useId()
  const changedRef = useRef<HTMLDivElement>(null)
  const focusAfterRender = useFocusAfterRender()
  const mutation = useMutation({ mutationFn: changePassword })

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

  const error = problem ?? (mutation.isError ? describeError(mutation.error).message : undefined)
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
