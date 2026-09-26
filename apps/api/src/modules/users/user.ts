import type { UserStatus, UserSystemRole } from '@nerve-office/contracts'

/** 账户（不含密码哈希）：其他模块与接口只用它。 */
export interface User {
  readonly id: string
  /** 规范写法（小写） */
  readonly username: string
  readonly displayName: string
  readonly systemRole: UserSystemRole
  readonly status: UserStatus
}
