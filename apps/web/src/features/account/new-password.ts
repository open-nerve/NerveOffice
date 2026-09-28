// 设置新密码时的前端检查（修改密码、接受邀请、重置密码共用）：规则与服务端相同（contracts 的 newPasswordSchema），
// 两次输入一致。服务端仍会再查一遍，这里只是让用户早点知道。
import { newPasswordSchema } from '@nerve-office/contracts'
import { messages } from '../../shared/i18n/index.ts'

/** 新密码有问题时返回说明，没有问题返回 undefined */
export function newPasswordProblem(password: string, confirmation: string): string | undefined {
  const result = newPasswordSchema.safeParse(password)
  if (!result.success)
    return result.error.issues[0]?.message
  if (password !== confirmation)
    return messages.account.passwordMismatch
  return undefined
}
