// E2E 与集成测试共用的测试库命名（test-databases.ts）：名字带主机的标识与进程号，清理中断的运行留下的库与角色时只认本主机建的、按本主机的进程号判断。
// M4-P1 S7 的事故：Docker 容器里的运行连共用的开发库，只按进程号判断时把宿主机上别人正在用的库当成遗留删掉了（容器看不到宿主机的进程号），反过来也一样
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { abandonedNames, hostScopedName, hostTag, isProcessAlive } from './test-databases.ts'

const TAG = 'a1b2c3d4'
const OTHER = 'ffffffff'
const alive = new Set([100, 200])
const isAlive = (pid: number): boolean => alive.has(pid)

describe('主机的标识（hostTag）', () => {
  it('主机名的短哈希：8 个小写十六进制字符，同一个主机名总是同一个，不同的主机名不同（容器的主机名是容器的 id）', () => {
    expect(hostTag('xiaoruandeMacBook-Pro.local')).toMatch(/^[0-9a-f]{8}$/)
    expect(hostTag('xiaoruandeMacBook-Pro.local')).toBe(hostTag('xiaoruandeMacBook-Pro.local'))
    expect(hostTag('2e500bc3241c')).not.toBe(hostTag('xiaoruandeMacBook-Pro.local'))
  })

  it('不给主机名时用这台机器的', () => {
    expect(hostTag()).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe('带主机标识与进程号的名字（hostScopedName）', () => {
  it('<前缀><主机标识>_<进程号>：只有小写字母、数字与下划线（拼进 DDL 之前按这个校验），远小于 PostgreSQL 的 63 字节', () => {
    expect(hostScopedName('nerve_e2e_', 4_194_304, TAG)).toBe('nerve_e2e_a1b2c3d4_4194304')
    expect(hostScopedName('nerve_it_', 7, TAG)).toBe('nerve_it_a1b2c3d4_7')
    expect(`${hostScopedName('nerve_it_', 4_194_304, TAG)}_0123abcd_owner`.length).toBeLessThanOrEqual(63)
  })

  it('不给进程号与标识时用这个进程与这台机器的', () => {
    expect(hostScopedName('nerve_e2e_')).toBe(`nerve_e2e_${hostTag()}_${process.pid}`)
  })

  it('前缀只能是小写字母、数字与下划线（它要拼进正则与 DDL）', () => {
    expect(() => hostScopedName('nerve.e2e_', 1, TAG)).toThrow('前缀')
    expect(() => abandonedNames([], { prefix: 'nerve-e2e_', tag: TAG, isAlive })).toThrow('前缀')
  })
})

describe('中断的运行留下的（abandonedNames）', () => {
  const e2e = { prefix: 'nerve_e2e_', tag: TAG, isAlive }

  it('本主机建的、进程已经不在的算；本主机进程还在的不算', () => {
    expect(abandonedNames(['nerve_e2e_a1b2c3d4_100', 'nerve_e2e_a1b2c3d4_300'], e2e)).toEqual(['nerve_e2e_a1b2c3d4_300'])
  })

  it('别的主机标识的一律不算：它们的进程号在本主机上看不到（容器、别的机器连同一个库服务器）', () => {
    expect(abandonedNames([`nerve_e2e_${OTHER}_300`, `nerve_e2e_${OTHER}_100`], e2e)).toEqual([])
  })

  it('认不出主机的不动：改名之前的旧写法（<前缀><进程号>）、别的前缀、形状不对的', () => {
    expect(abandonedNames(['nerve_e2e_300', 'nerve_it_a1b2c3d4_300_ab12cd34', 'nerve_e2e_a1b2c3d4_', 'nerve_e2e_a1b2c3d4_12x', 'nerve_e2e_A1B2C3D4_300', 'nerve_e2e_a1b2c3d4_300_extra'], e2e)).toEqual([])
  })

  it('判断进程在不在只问本主机的进程号', () => {
    const asked: number[] = []
    abandonedNames(['nerve_e2e_a1b2c3d4_300', `nerve_e2e_${OTHER}_400`], {
      prefix: 'nerve_e2e_',
      tag: TAG,
      isAlive: (pid) => {
        asked.push(pid)
        return false
      },
    })
    expect(asked).toEqual([300])
  })

  it('集成测试：进程号之后还有随机的后缀；角色再加 _owner、_app；模板库（nerve_it_tpl_…）不算', () => {
    const databases = ['nerve_it_a1b2c3d4_300_0123abcd', 'nerve_it_a1b2c3d4_100_0123abcd', `nerve_it_${OTHER}_300_0123abcd`, 'nerve_it_tpl_0123456789ab', 'nerve_it_300_0123abcd']
    expect(abandonedNames(databases, { prefix: 'nerve_it_', suffix: '_[0-9a-f]+', tag: TAG, isAlive })).toEqual(['nerve_it_a1b2c3d4_300_0123abcd'])
    const roles = ['nerve_it_a1b2c3d4_300_0123abcd_owner', 'nerve_it_a1b2c3d4_300_0123abcd_app', 'nerve_it_a1b2c3d4_100_0123abcd_app', `nerve_it_${OTHER}_300_0123abcd_owner`, 'nerve_it_a1b2c3d4_300_0123abcd_root']
    expect(abandonedNames(roles, { prefix: 'nerve_it_', suffix: '_[0-9a-f]+_(?:owner|app)', tag: TAG, isAlive })).toEqual(['nerve_it_a1b2c3d4_300_0123abcd_owner', 'nerve_it_a1b2c3d4_300_0123abcd_app'])
  })

  it('不给标识与判断时用这台机器的标识与这台机器的进程', () => {
    expect(abandonedNames([hostScopedName('nerve_e2e_'), hostScopedName('nerve_e2e_', 99_999_999)], { prefix: 'nerve_e2e_' })).toEqual([hostScopedName('nerve_e2e_', 99_999_999)])
  })
})

describe('本主机上的进程还在不在（isProcessAlive）', () => {
  it('自己在；不存在的进程号不在', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
    expect(isProcessAlive(99_999_999)).toBe(false)
  })

  it('别的用户的进程（1 号进程）也算在：没有权限（EPERM）不等于不在，库是它的就不能删', () => {
    expect(isProcessAlive(1)).toBe(true)
  })
})
