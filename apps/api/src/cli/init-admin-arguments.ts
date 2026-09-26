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

const KNOWN_OPTIONS: ReadonlySet<string> = new Set(['--username', '--display-name', '--password-stdin'])
/** 报告不认识的选项时，只在它看起来像个选项名时才说出名字 */
const OPTION_NAME = /^--?[a-z][a-z-]*$/i

/**
 * parseArgs 的报错会原样带上出错的参数：密码误当作参数传进来时，它就出现在终端与日志里。
 * 按错误类别给出自己的说明，不回显参数的取值（P3 审查 A11）。
 */
function usageProblemOf(error: unknown, argv: readonly string[]): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  if (code === 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL')
    return '不接受位置参数（密码不能出现在命令行参数里）'
  if (code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE')
    return '选项的取值不对：--username 与 --display-name 需要取值，--password-stdin 不带取值'
  if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
    const unknown = argv.map(argument => argument.split('=')[0] ?? '').find(name => name.startsWith('-') && !KNOWN_OPTIONS.has(name))
    return unknown !== undefined && OPTION_NAME.test(unknown) ? `不认识的选项 ${unknown}` : '有不认识的选项'
  }
  return '参数不合法'
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
    throw new UsageError(usageProblemOf(error, argv))
  }
  if (values.username === undefined || values.username.trim() === '')
    throw new UsageError('缺少 --username')
  return {
    username: values.username,
    ...(values['display-name'] === undefined ? {} : { displayName: values['display-name'] }),
    passwordStdin: values['password-stdin'] ?? false,
  }
}
