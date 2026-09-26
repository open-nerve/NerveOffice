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

  it('不接受 --password：密码不能出现在命令行参数里', () => {
    for (const argv of [['--username', 'a', '--password', 'x'], ['--username', 'a', '--password=x']])
      expect(() => parseInitAdminArguments(argv)).toThrow(/密码不能出现在命令行参数里/)
  })
})
