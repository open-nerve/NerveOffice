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

/** 管理界面用的账户：另带创建时间（M2-P1 设计 §3.6） */
export interface AccountRecord extends User {
  readonly createdAt: Date
}

/** 状态或系统角色的变更结果：没有变化（例如停用已停用的账户）时 changed 为假，调用方不记审计 */
export interface AccountChange {
  readonly account: AccountRecord
  readonly changed: boolean
}
