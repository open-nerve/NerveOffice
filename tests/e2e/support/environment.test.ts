// E2E 的测试库的名字与"遗留库"的判断（environment.ts）：名字带主机的标识，服务脚本启动时只清理本主机建的、按本主机的进程号判断。
// M4-P1 S7 的事故：容器里的运行连共用的开发库，按进程号判断时把宿主机上别人正在用的库当成遗留删掉了（容器看不到宿主机的进程号），反过来也一样
import { describe, expect, it } from 'vitest'
import { abandonedDatabases, E2E_DATABASE_PREFIX, e2eDatabaseName, hostTag } from './environment.ts'

describe('主机的标识（hostTag）', () => {
  it('主机名的短哈希：8 个小写十六进制字符，同一个主机名总是同一个，不同的主机名不同', () => {
    expect(hostTag('xiaoruandeMacBook-Pro.local')).toMatch(/^[0-9a-f]{8}$/)
    expect(hostTag('xiaoruandeMacBook-Pro.local')).toBe(hostTag('xiaoruandeMacBook-Pro.local'))
    expect(hostTag('2e500bc3241c')).not.toBe(hostTag('xiaoruandeMacBook-Pro.local'))
  })

  it('不给主机名时用这台机器的', () => {
    expect(hostTag()).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe('本次运行的测试库名（e2eDatabaseName）', () => {
  it('前缀 + 主机的标识 + 进程号；只有小写字母、数字与下划线（服务脚本拼进 DDL 之前按这个校验），不超过 PostgreSQL 的 63 字节', () => {
    const name = e2eDatabaseName(4_194_304, 'a1b2c3d4')
    expect(name).toBe(`${E2E_DATABASE_PREFIX}a1b2c3d4_4194304`)
    expect(name).toMatch(/^[a-z0-9_]+$/)
    expect(name.length).toBeLessThanOrEqual(63)
    expect(e2eDatabaseName(42)).toBe(`${E2E_DATABASE_PREFIX}${hostTag()}_42`)
  })
})

describe('遗留的测试库（abandonedDatabases）', () => {
  const tag = 'a1b2c3d4'
  const alive = new Set([100, 200])
  const isAlive = (pid: number): boolean => alive.has(pid)

  it('本主机建的、进程已经不在的删；本主机进程还在的不删', () => {
    expect(abandonedDatabases([e2eDatabaseName(100, tag), e2eDatabaseName(300, tag)], tag, isAlive)).toEqual([e2eDatabaseName(300, tag)])
  })

  it('别的主机标识的库一律不删：它们的进程号在本主机上看不到（容器、别的机器连同一个库服务器）', () => {
    expect(abandonedDatabases([e2eDatabaseName(300, 'ffffffff'), e2eDatabaseName(100, 'ffffffff')], tag, isAlive)).toEqual([])
  })

  it('认不出主机的名字不动：改名之前的旧写法（nerve_e2e_<进程号>）、别的前缀、形状不对的', () => {
    expect(abandonedDatabases(['nerve_e2e_300', 'nerve_it_300_ab12cd34', `${E2E_DATABASE_PREFIX}a1b2c3d4_`, `${E2E_DATABASE_PREFIX}a1b2c3d4_12x`, `${E2E_DATABASE_PREFIX}A1B2C3D4_300`, `${E2E_DATABASE_PREFIX}a1b2c3d4_300_extra`], tag, isAlive)).toEqual([])
  })

  it('判断进程在不在只问本主机的进程号', () => {
    const asked: number[] = []
    abandonedDatabases([e2eDatabaseName(300, tag), e2eDatabaseName(400, 'ffffffff')], tag, (pid) => {
      asked.push(pid)
      return false
    })
    expect(asked).toEqual([300])
  })
})
