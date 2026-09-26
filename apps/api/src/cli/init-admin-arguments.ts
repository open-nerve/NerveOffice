// init-admin 的命令行参数（P3 设计 §3.4）。
import { parseArgs } from 'node:util'

export const INIT_ADMIN_USAGE = [
  '用法：init-admin --username <用户名> [--display-name <显示名>] [--password-stdin]',
  '  密码在终端里输入两次，不回显；非交互环境（脚本、容器的一次性任务）用 --password-stdin 从标准输入读取。',
].join('\n')

/** 参数不合法：退出码 2，并打印用法。 */
export class UsageError extends Error {
  override readonly name = 'UsageError'
}

export interface InitAdminArguments {
  readonly username: string
  readonly displayName?: string
  readonly passwordStdin: boolean
}

export function parseInitAdminArguments(argv: readonly string[]): InitAdminArguments {
  if (argv.some(argument => argument === '--password' || argument.startsWith('--password=')))
    throw new UsageError('不接受 --password：密码不能出现在命令行参数里，请在终端里输入，或者用 --password-stdin')
  let values: { 'username'?: string, 'display-name'?: string, 'password-stdin'?: boolean }
  try {
    values = parseArgs({
      args: [...argv],
      options: {
        'username': { type: 'string' },
        'display-name': { type: 'string' },
        'password-stdin': { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }).values
  }
  catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
  if (values.username === undefined || values.username.trim() === '')
    throw new UsageError('缺少 --username')
  return {
    username: values.username,
    ...(values['display-name'] === undefined ? {} : { displayName: values['display-name'] }),
    passwordStdin: values['password-stdin'] ?? false,
  }
}
