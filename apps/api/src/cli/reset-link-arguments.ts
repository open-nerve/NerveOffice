// reset-link 的命令行参数（M2-P1 设计 §3.9）。
import { parseArgs } from 'node:util'
import { UsageError } from './init-admin-arguments.ts'

export const RESET_LINK_USAGE = [
  '用法：reset-link --username <登录名>',
  '  为这个账户签发重置密码的一次性链接（24 小时内有效），同时让这个人的全部登录失效。',
  '  链接打印到标准输出，只显示这一次：经受控的渠道交给本人，不要贴进工单或聊天记录。',
].join('\n')

export function parseResetLinkArguments(argv: readonly string[]): { readonly username: string } {
  let values: { username?: string }
  try {
    values = parseArgs({ args: [...argv], options: { username: { type: 'string' } }, strict: true, allowPositionals: false }).values
  }
  catch {
    // 不回显任何参数：与 init-admin 相同的做法
    throw new UsageError('参数不合法：只接受 --username <登录名>')
  }
  if (values.username === undefined || values.username.trim() === '')
    throw new UsageError('缺少 --username')
  return { username: values.username }
}
