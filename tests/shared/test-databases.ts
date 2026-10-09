// E2E 与集成测试共用的测试库命名（M4-P1 S7 的事故之后）：库名（与集成测试的角色名）带主机的标识与创建它的进程号，清理中断的运行留下的库与角色时
// 只认本主机建的、按本主机的进程号判断。原来只按进程号判断，只在所有运行都在同一台主机上时才对：别的主机（Docker 容器、别的机器）连同一个库服务器时，
// 它们的进程号在本主机上看不到，正在用的库会被当成遗留删掉（容器里的运行与宿主机上的运行互相删了对方的库）。
// - E2E：nerve_e2e_<主机标识>_<进程号>（tests/e2e/support/environment.ts、serve.ts）；
// - 集成测试：nerve_it_<主机标识>_<进程号>_<随机>，bootstrap 脚本的测试另建 <库名>_owner、<库名>_app 两个角色（tests/integration/src/support/database.ts）。
// 两边的包都引用它（模块边界里的 tests-shared），它只依赖 Node，不引用两边的代码
import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import process from 'node:process'

/** 主机的标识：主机名的短哈希（8 个小写十六进制字符）。容器的主机名是容器的 id，每个容器各不相同 */
export function hostTag(name: string = hostname()): string {
  return createHash('sha256').update(name).digest('hex').slice(0, 8)
}

/** 前缀要拼进正则与 DDL：只能是小写字母、数字与下划线 */
function checkPrefix(prefix: string): string {
  if (!/^[a-z0-9_]+$/.test(prefix))
    throw new Error(`测试库名的前缀只能是小写字母、数字与下划线：${prefix}`)
  return prefix
}

/** 带主机标识与进程号的名字：<前缀><主机标识>_<进程号>，只有小写字母、数字与下划线 */
export function hostScopedName(prefix: string, pid: number = process.pid, tag: string = hostTag()): string {
  return `${checkPrefix(prefix)}${tag}_${pid}`
}

/** 本主机上这个进程还在不在：kill(pid, 0)；没有权限（EPERM）也算在 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface AbandonedNamesOptions {
  readonly prefix: string
  /** 进程号之后的部分（正则的源码）：E2E 没有；集成测试的库是 _<随机>，角色是 _<随机>_(owner|app) */
  readonly suffix?: string
  /** 本主机的标识；不给时用这台机器的 */
  readonly tag?: string
  /** 本主机上的进程还在不在；不给时问这台机器 */
  readonly isAlive?: (pid: number) => boolean
}

/**
 * 中断的运行留下的：本主机建的（主机标识相同）、创建它的进程已经不在的。别的主机建的、认不出主机的（改名之前的旧写法 <前缀><进程号>）、
 * 形状不对的一律不动；只问本主机的进程号
 */
export function abandonedNames(names: readonly string[], options: AbandonedNamesOptions): string[] {
  const { prefix, suffix = '', tag = hostTag(), isAlive = isProcessAlive } = options
  const shape = new RegExp(`^${checkPrefix(prefix)}([0-9a-f]{8})_(\\d+)${suffix}$`)
  return names.filter((name) => {
    const match = shape.exec(name)
    return match !== null && match[1] === tag && !isAlive(Number(match[2]))
  })
}
