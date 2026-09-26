// 初始化管理员时读取密码（P3 设计 §3.4）：终端里输入两次、不回显；非交互环境用 --password-stdin 从标准输入读取。
import type { Buffer } from 'node:buffer'
import type { TerminalInput } from './password-input.ts'
import { AppError } from '../app/index.ts'
import { UsageError } from './init-admin-arguments.ts'
import { promptHidden, readPasswordFromStream } from './password-input.ts'

export interface PasswordStreams {
  readonly stdin: TerminalInput & AsyncIterable<string | Buffer> & { readonly isTTY?: boolean }
  /** 提示写到标准错误：标准输出只有日志 */
  readonly stderr: { write: (text: string) => unknown }
}

export async function readAdminPassword(passwordStdin: boolean, { stdin, stderr }: PasswordStreams): Promise<string> {
  if (passwordStdin) {
    // 标准输入是终端时，敲进去的密码会显示在屏幕上（P3 审查 A11）
    if (stdin.isTTY === true)
      throw new UsageError('--password-stdin 用于管道或重定向；在终端里请去掉它，按提示输入密码（不回显）')
    return readPasswordFromStream(stdin)
  }
  if (stdin.isTTY !== true)
    throw new UsageError('标准输入不是终端：请用 --password-stdin 从标准输入传入密码')
  const first = await promptHidden(stdin, stderr, '密码：')
  const second = await promptHidden(stdin, stderr, '再输入一次：')
  if (first !== second)
    throw new AppError('REQUEST_INVALID', '两次输入的密码不一致')
  return first
}
