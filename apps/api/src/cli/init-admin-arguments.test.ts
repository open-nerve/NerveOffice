import { describe, expect, it } from 'vitest'
import { parseInitAdminArguments, UsageError } from './init-admin-arguments.ts'

describe('parseInitAdminArguments', () => {
  it('用户名必填；显示名与 --password-stdin 可选', () => {
    expect(parseInitAdminArguments(['--username', 'admin'])).toEqual({ username: 'admin', passwordStdin: false })
    expect(parseInitAdminArguments(['--username=admin', '--display-name', '管理员', '--password-stdin']))
      .toEqual({ username: 'admin', displayName: '管理员', passwordStdin: true })
  })

  it('缺少用户名、不认识的参数、多余的位置参数：用法错误', () => {
    for (const argv of [[], ['--username', ' '], ['--username', 'a', '--verbose'], ['--username', 'a', 'extra']])
      expect(() => parseInitAdminArguments(argv), argv.join(' ')).toThrow(UsageError)
  })

  it('用法错误的说明不回显参数的取值：密码误当作参数传进来时不能出现在终端里', () => {
    const cases: [string[], RegExp][] = [
      [['--username', 'admin', 'hunter2-secret'], /不接受位置参数/],
      [['--username', 'admin', '--pw=hunter2-secret'], /不认识的选项 --pw$/],
      [['--username', 'admin', '-p', 'hunter2-secret'], /不认识的选项 -p$/],
      [['--username', 'admin', '--hunter2-secret!'], /^有不认识的选项$/],
      [['--username', 'admin', '--password-stdin=hunter2-secret'], /--password-stdin 不带取值/],
      [['--username'], /需要取值/],
    ]
    for (const [argv, message] of cases) {
      const error = (() => {
        try {
          parseInitAdminArguments(argv)
        }
        catch (caught) {
          return caught
        }
        return undefined
      })()
      expect(error, argv.join(' ')).toBeInstanceOf(UsageError)
      expect((error as UsageError).message, argv.join(' ')).toMatch(message)
      expect((error as UsageError).message, argv.join(' ')).not.toContain('hunter2')
    }
  })

  it('不接受 --password：密码不能出现在命令行参数里', () => {
    for (const argv of [['--username', 'a', '--password', 'x'], ['--username', 'a', '--password=x']])
      expect(() => parseInitAdminArguments(argv)).toThrow(/密码不能出现在命令行参数里/)
  })
})
