import { inspect } from 'node:util'

/** 日志与转储里代替机密的文字。 */
export const REDACTED = '[已脱敏]'

/**
 * 机密（例如数据库连接串，里面有密码）：只在真正需要时用 reveal() 取出明文；
 * 转 JSON、转字符串、打印时都是脱敏值，整个配置对象被记进日志也不会泄露（审查 A10）。
 */
export class Secret {
  readonly #value: string

  constructor(value: string) {
    this.#value = value
  }

  reveal(): string {
    return this.#value
  }

  toJSON(): string {
    return REDACTED
  }

  toString(): string {
    return REDACTED
  }

  [inspect.custom](): string {
    return REDACTED
  }
}
